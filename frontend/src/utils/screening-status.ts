export type ScreeningStatus = "positive" | "negative" | "conflict" | "unknown";
export type ScreeningStatusResults = {
  hcvPlus: ScreeningStatus;
  hbaSg: ScreeningStatus;
  hiv: ScreeningStatus;
  mp: ScreeningStatus;
  dengue: ScreeningStatus;
};

type ScreeningKey = keyof ScreeningStatusResults;
type DetectedLabel = { key: ScreeningKey; remainder: string };

const SCREENING_LABELS: Array<{ key: ScreeningKey; pattern: RegExp }> = [
  {
    key: "hbaSg",
    pattern: /^(?:h\s*b\s*s\s*a\s*g|hbs\s*ag|hbsag|hepatitis\s*b\s*(?:surface\s*)?antigen)\b/i,
  },
  {
    key: "hcvPlus",
    pattern: /^(?:anti\s*[- ]?\s*h\s*c\s*v|h\s*c\s*v(?:\s*(?:antibody|ab|antigen))?|hepatitis\s*c(?:\s*(?:antibody|ab))?)\b/i,
  },
  {
    key: "hiv",
    pattern: /^h\s*i\s*v(?:\s*[- ]?\s*1\s*\/?\s*2)?(?:\s*(?:antibody|ab|screen|ag))?\b/i,
  },
  {
    key: "mp",
    // M.P / MP means malaria parasite here; MPV is deliberately not matched.
    pattern: /^(?:malaria\s+parasite(?:s)?|malarial\s+parasite(?:s)?|m\.?\s*p\.?)(?=$|[^a-z0-9])/i,
  },
  {
    key: "dengue",
    pattern: /^dengue(?:\s*(?:ns1|igm|igg|antibod(?:y|ies)|antigen|serology|rapid|test|combo))?\b/i,
  },
];

// Match explicit results only. Negative phrases are evaluated before substrings
// such as "reactive" in "non-reactive" and "detected" in "not detected".
const NEGATIVE_STATUS = /\b(?:non[\s-]?reactive|non[\s-]?detected|not[\s-]?detected|not[\s-]?reactive|negative|undetected|absent|not[\s-]?positive|non[\s-]?positive)\b/i;
const POSITIVE_STATUS = /\b(?:presumptive[\s-]+positive|positive|reactive|detected|present|pos\.?|react\.?)\b/i;
const REFERENCE_START = /\b(?:reference|ref\.?|normal|biological)\s*(?:range|interval|reference)?\b/i;

function screeningLabel(line: string): DetectedLabel | null {
  const cleaned = String(line || "")
    .replace(/\u00a0/g, " ")
    .trim()
    .replace(/^[|:;•*\s-]+/, "")
    .replace(/^\d+\s*[.)]\s*/, "");
  for (const item of SCREENING_LABELS) {
    const match = item.pattern.exec(cleaned);
    if (match) return { key: item.key, remainder: cleaned.slice(match[0].length) };
  }
  return null;
}

function statusInText(value: string): Exclude<ScreeningStatus, "conflict" | "unknown"> | null {
  const text = String(value || "").replace(/\u00a0/g, " ").trim();
  if (!text) return null;
  const negative = NEGATIVE_STATUS.exec(text);
  const positive = POSITIVE_STATUS.exec(text);
  if (negative && (!positive || negative.index <= positive.index)) return "negative";
  if (positive) return "positive";
  // Some rapid-test reports use a plus sign alone in the result cell.
  if (/^\s*\+\s*$/.test(text)) return "positive";
  return null;
}

function isStandaloneStatusLine(value: string): boolean {
  return /^(?:result|status|finding)?\s*[:=|\-]?\s*(?:presumptive[\s-]+positive|non[\s-]?reactive|non[\s-]?detected|not[\s-]?detected|not[\s-]?reactive|negative|positive|non[\s-]?positive|reactive|detected|undetected|absent|present|pos\.?|react\.?|\+)\s*[.!]*$/i.test(String(value || "").trim());
}

function beforeReference(value: string): string {
  const text = String(value || "");
  const match = REFERENCE_START.exec(text);
  return match ? text.slice(0, match.index) : text;
}

function resolveStatuses(values: Array<"positive" | "negative">): ScreeningStatus {
  const unique = [...new Set(values)];
  if (!unique.length) return "unknown";
  if (unique.length > 1) return "conflict";
  return unique[0];
}

/**
 * Reads HIV, HCV and HBsAg result labels without using a reference-range cell.
 * Structured "test | result | unit | reference" rows take priority over raw OCR
 * text. A clear negative result can therefore clear an old tick; unclear or
 * contradictory evidence never changes a checkbox automatically.
 */
export function detectScreeningStatuses(text: string): ScreeningStatusResults {
  const table: Record<ScreeningKey, Array<"positive" | "negative">> = {
    hcvPlus: [],
    hbaSg: [],
    hiv: [],
    mp: [],
    dengue: [],
  };
  const raw: Record<ScreeningKey, Array<"positive" | "negative">> = {
    hcvPlus: [],
    hbaSg: [],
    hiv: [],
    mp: [],
    dengue: [],
  };
  const lines = String(text || "")
    .replace(/\u00a0/g, " ")
    .split(/\r?\n/)
    .map(line => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  // Reconstructed table rows use a stable layout. Only the result cell (column
  // 2) is considered, never the unit or reference-range cells.
  for (const line of lines) {
    if (!line.includes("|")) continue;
    const cells = line.split("|").map(cell => cell.trim());
    if (cells.length < 2) continue;
    const label = screeningLabel(cells[0]);
    if (!label) continue;
    const status = statusInText(cells[1]);
    if (status) table[label.key].push(status);
  }

  // Raw OCR fallback handles reports that have no reconstructed table. Do not
  // read statuses from reference ranges, headings, or adjacent unrelated rows.
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.includes("|")) continue;
    const label = screeningLabel(line);
    if (!label) continue;

    let area = beforeReference(label.remainder)
      .replace(/^\s*(?:result|status|finding)?\s*[:=|,;\-]?\s*/i, "")
      .trim();
    let status = statusInText(area);
    if (!status) {
      for (let offset = 1; offset <= 2 && index + offset < lines.length; offset++) {
        const next = lines[index + offset];
        if (screeningLabel(next)) break;
        if (!isStandaloneStatusLine(next)) continue;
        status = statusInText(next);
        if (status) break;
      }
    }
    if (status) raw[label.key].push(status);
  }

  const resolve = (key: ScreeningKey) =>
    resolveStatuses(table[key].length ? table[key] : raw[key]);

  return {
    hcvPlus: resolve("hcvPlus"),
    hbaSg: resolve("hbaSg"),
    hiv: resolve("hiv"),
    mp: resolve("mp"),
    dengue: resolve("dengue"),
  };
}


/**
 * Detect an admin-configured screening checkbox from explicit results for that
 * exact test label. Structured rows only inspect the result column, never ranges.
 */
export function detectCustomScreeningStatus(text: string, configuredLabel: string): ScreeningStatus {
  const target = String(configuredLabel || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!target) return "unknown";
  const values: Array<"positive" | "negative"> = [];
  const lines = String(text || "").replace(/\u00a0/g, " ").split(/\r?\n/).map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const normalize = (value: string) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  for (const line of lines) {
    if (!line.includes("|")) continue;
    const cells = line.split("|").map(cell => cell.trim());
    if (cells.length < 2 || normalize(cells[0]) !== target) continue;
    const status = statusInText(cells[1]);
    if (status) values.push(status);
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.includes("|")) continue;
    const delimited = line.match(/^\s*(.*?)\s*(?::|=|—|-)\s*(.*?)\s*$/);
    if (delimited && normalize(delimited[1]) === target) {
      const status = statusInText(beforeReference(delimited[2]));
      if (status) values.push(status);
      continue;
    }
    const normalizedLine = normalize(line);
    if (normalizedLine.startsWith(target) && normalizedLine.length > target.length) {
      const status = statusInText(beforeReference(line.slice(Math.min(line.length, configuredLabel.length))));
      if (status) { values.push(status); continue; }
    }
    if (normalizedLine === target) {
      for (let offset = 1; offset <= 2 && index + offset < lines.length; offset++) {
        const next = lines[index + offset];
        if (next.includes("|") || normalize(next) === target) break;
        if (!isStandaloneStatusLine(next)) continue;
        const status = statusInText(next);
        if (status) { values.push(status); break; }
      }
    }
  }
  return resolveStatuses(values);
}
