import { recognizeText } from "expo-ocr-kit";

export type LabTestDefinition = { id: string; name: string; maleMin: string; maleMax: string; femaleMin: string; femaleMax: string; unit: string };

export type ParsedLabRow = {
  test: string;
  result: string;
  unit: string;
  reference: string;
  severity: "WARNING" | "ALERT";
  sourceLine: string;
};

const TEST_ALIASES = [
  "complete blood count", "fasting blood sugar", "blood urea nitrogen",
  "alkaline phosphatase", "urine routine", "urinalysis", "haemoglobin",
  "hemoglobin", "hematocrit", "haematocrit", "platelets", "creatinine",
  "triglycerides", "cholesterol", "bilirubin", "electrolytes", "uric acid",
  "neutrophils", "lymphocytes", "eosinophils", "monocytes", "basophils",
  "hba1c", "hbsag", "hcv antibody", "glucose", "urea", "calcium",
  "potassium", "sodium", "chloride", "hematocrit", "haematocrit",
  "mcv", "mch", "mchc", "mpv", "rdw", "esr", "crp", "tsh", "sgpt",
  "sgot", "alt", "ast", "fbs", "rbs", "hgb", "hct", "wbc", "rbc",
  "hiv", "t3", "t4", "hb", "alp", "bun", "uc",
].sort((a, b) => b.length - a.length);

const META_LINE = /\b(?:patient\s*(?:name|id|no|number)|mr\s*(?:no|number)|registration|accession|collection\s*date|reporting\s*date|reported\s*date|request\s*date|sample\s*date|specimen\s*date|date\s*of\s*(?:birth|collection|report)|dob|age|gender|sex|address|phone|mobile|doctor|consultant|laboratory|lab\s*name|test\s*date|printed\s*on|page\s*\d+)\b/i;
const HEADER_LINE = /\b(?:reference\s*(?:range|interval)|normal\s*range|biological\s*reference|test\s*name|investigation|parameter|units?\s*only|result\s*only)\b/i;
const DATE_ONLY = /\b\d{1,4}[\/-]\d{1,2}[\/-]\d{1,4}\b/;
const NUM = "[-+]?\\d+(?:[.,]\\d+)?";
const INTERVAL_RE = new RegExp("(" + NUM + ")\\s*(?:-|–|—|\\bto\\b)\\s*(" + NUM + ")", "i");

function normaliseName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

export function hasKnownLabTestName(line: string, configuredTests: LabTestDefinition[] = []): boolean { return !!findTestPrefix(line, configuredTests); }

export function isLabMetadataLine(line: string, configuredTests: LabTestDefinition[] = []): boolean { return isNonResultLine(line, configuredTests); }

function findTestPrefix(line: string, configuredTests: LabTestDefinition[] = []): { name: string; end: number; configured?: LabTestDefinition } | null {
  const cleaned = line.replace(/^\s*[•*|:;\-]+\s*/, "");
  const lower = cleaned.toLowerCase();
  for (const configured of configuredTests) {
    const name = String(configured.name || "").trim();
    if (name.length < 2) continue;
    const lowerName = name.toLowerCase();
    if (cleaned.toLowerCase().startsWith(lowerName)) {
      const nextChar = cleaned.charAt(name.length);
      if (!nextChar || /[\\s:|]/.test(nextChar)) return { name: cleaned.slice(0, name.length).trim(), end: name.length, configured };
    }
  }
  for (const alias of TEST_ALIASES) {") + "(?=$|\\\\s|[:|])", "i");
    const match = pattern.exec(cleaned);
    if (match) return { name: match[0].trim(), end: match[0].length, configured };
  }
  for (const alias of TEST_ALIASES) {
    const pattern = new RegExp("^" + alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?=$|\\s|[:|])", "i");
    const match = pattern.exec(cleaned);
    if (match) return { name: cleaned.slice(0, match[0].length).trim(), end: match[0].length };
  }
  // A known test may be prefixed by a short lab code, but never infer arbitrary words.
  const normal = normaliseName(lower);
  for (const alias of TEST_ALIASES) {
    if (normal.startsWith(alias + " ")) {
      const index = lower.indexOf(alias);
      if (index >= 0 && index <= 8) return { name: cleaned.slice(index, index + alias.length).trim(), end: index + alias.length };
    }
  }
  return null;
}

function isNonResultLine(line: string, configuredTests: LabTestDefinition[] = []): boolean {
  if (!line || line.length < 4 || META_LINE.test(line) || HEADER_LINE.test(line)) return true;
  if (DATE_ONLY.test(line) && !findTestPrefix(line, configuredTests)) return true;
  if (/^\s*(?:m|male|f|female)\s*[:=]?\s*\d/i.test(line) && !findTestPrefix(line, configuredTests)) return true;
  if (/^\s*(?:ref(?:erence)?|normal)\s*(?:range|interval)?\s*[:=]/i.test(line)) return true;
  return false;
}

export function isLikelyLabReportText(text: string, configuredTests: LabTestDefinition[] = []): boolean {
  const lines = String(text || "").split(/\r?\n/).map(line => line.replace(/\s+/g, " ").trim());
  let validRows = 0;
  for (const line of lines) {
    if (isNonResultLine(line, configuredTests)) continue;
    const test = findTestPrefix(line, configuredTests);
    if (!test) continue;
    const rest = line.slice(test.end);
    if (new RegExp(NUM).test(rest) && (INTERVAL_RE.test(rest) || /\b(?:positive|negative|reactive|nonreactive)\b/i.test(rest))) validRows++;
  }
  return validRows >= 1;
}

const numericValue = (raw: string) => Number(raw.replace(",", "."));

export function parseLabReportRows(text: string, configuredTests: LabTestDefinition[] = [], gender = ""): ParsedLabRow[] {
  const rows: ParsedLabRow[] = [];
  const seen = new Set<string>();

  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (isNonResultLine(line, configuredTests)) continue;
    const testPrefix = findTestPrefix(line, configuredTests);
    if (!testPrefix) continue;

    const rest = line.slice(testPrefix.end).replace(/^\s*[:|\-]+\s*/, "");
    const intervalMatches = [...rest.matchAll(new RegExp(NUM + "\\s*(?:-|–|—|\\bto\\b)\\s*" + NUM, "gi"))];
    let resultMatch: RegExpMatchArray | undefined;
    let beforeInterval = "";
    let rangeText = "";
    let rangeMatch: RegExpMatchArray | null = null;
    if (intervalMatches.length) {
      const interval = intervalMatches[intervalMatches.length - 1];
      const intervalStart = interval.index ?? -1;
      if (intervalStart <= 0) continue;
      beforeInterval = rest.slice(0, intervalStart);
      const resultMatches = [...beforeInterval.matchAll(new RegExp(NUM, "g"))];
      if (!resultMatches.length) continue;
      resultMatch = resultMatches[resultMatches.length - 1];
      rangeText = interval[0];
      rangeMatch = INTERVAL_RE.exec(rangeText);
    } else if (testPrefix.configured) {
      const values = [...rest.matchAll(new RegExp(NUM, "g"))];
      if (!values.length) continue;
      resultMatch = values[0];
      beforeInterval = rest;
      const male = /^(m|male)$/i.test(gender.trim());
      const minRaw = male ? testPrefix.configured.maleMin : testPrefix.configured.femaleMin;
      const maxRaw = male ? testPrefix.configured.maleMax : testPrefix.configured.femaleMax;
      const min = Number(minRaw), max = Number(maxRaw);
      if (!String(minRaw).trim() || !String(maxRaw).trim() || !Number.isFinite(min) || !Number.isFinite(max) || min > max) continue;
      rangeText = String(minRaw) + "–" + String(maxRaw);
      rangeMatch = [rangeText, String(minRaw), String(maxRaw)] as unknown as RegExpMatchArray;
    } else continue;
    if (!resultMatch || !rangeMatch) continue;
    const result = numericValue(resultMatch[0]);
    const a = numericValue(rangeMatch[1]);
    const b = numericValue(rangeMatch[2]);
    if (![result, a, b].every(Number.isFinite) || a === b) continue;

    const low = Math.min(a, b);
    const high = Math.max(a, b);
    if (result >= low && result <= high) continue;

    const resultEnd = (resultMatch.index ?? 0) + resultMatch[0].length;
    const unit = (intervalMatches.length ? beforeInterval.slice(resultEnd) : (testPrefix.configured?.unit || ""))
      .replace(/\b(?:result|value|ref|reference|range|normal)\b/gi, " ")
      .replace(/[0-9.,+\-–—:|;]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const reference = rangeMatch[1] + "–" + rangeMatch[2];
    const key = (testPrefix.name + "|" + resultMatch[0] + "|" + reference).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // Do not invent a critical/severity threshold. Every out-of-range row is
    // a possible alert for human verification; criticality is not inferred.
    rows.push({
      test: testPrefix.name,
      result: resultMatch[0],
      unit: unit.slice(0, 24),
      reference,
      severity: "ALERT",
      sourceLine: line,
    });
  }
  return rows;
}

export async function recognizeLabText(uri: string): Promise<{ text: string }> {
  const result = await recognizeText(uri);
  return { text: String(result?.text || "") };
}
