import { recognizeText } from "expo-ocr-kit";
import { Image } from "react-native";
import * as ImageManipulator from "expo-image-manipulator";
import * as FileSystem from "expo-file-system/legacy";

export type LabTestDefinition = { id: string; name: string; maleMin: string; maleMax: string; femaleMin: string; femaleMax: string; unit: string };

export type ParsedLabRow = {
  test: string;
  result: string;
  unit: string;
  reference: string;
  severity: "WARNING" | "ALERT" | "";
  sourceLine: string;
};

const TEST_ALIASES = [
  "complete blood count", "fasting blood sugar", "random blood sugar", "blood urea nitrogen",
  "alkaline phosphatase", "urine routine", "urinalysis", "haemoglobin", "hemoglobin",
  "hematocrit", "haematocrit", "platelet count", "platelets", "creatinine",
  "triglycerides", "total cholesterol", "cholesterol", "total bilirubin", "direct bilirubin",
  "indirect bilirubin", "bilirubin", "electrolytes", "uric acid", "neutrophils",
  "lymphocytes", "eosinophils", "monocytes", "basophils", "hba1c", "hbsag",
  "hcv antibody", "glucose", "urea", "calcium", "potassium", "sodium", "chloride",
  "mcv", "mch", "mchc", "mpv", "rdw-cv", "rdw-sd", "rdw", "esr", "crp", "tsh",
  "sgpt", "sgot", "alt", "ast", "fbs", "rbs", "hgb", "hct", "wbc", "rbc",
  "ggt", "gamma gt", "albumin", "total protein", "globulin", "ferritin", "iron",
  "vitamin d", "vitamin b12", "magnesium", "phosphate", "prothrombin time", "aptt",
  "inr", "d dimer", "troponin", "hiv", "t3", "t4", "hb", "alp", "bun", "uc",
].sort((a, b) => b.length - a.length);

const META_LINE = /\b(?:patient\s*(?:name|id|no|number)|mr\s*(?:no|number)|registration|accession|collection\s*date|reporting\s*date|reported\s*date|request\s*date|sample\s*date|specimen\s*date|date\s*of\s*(?:birth|collection|report)|dob|age|gender|sex|address|phone|mobile|doctor|consultant|laboratory|lab\s*name|test\s*date|printed\s*on|page\s*\d+)\b/i;
const HEADER_LINE = /\b(?:reference\s*(?:range|interval)|normal\s*range|biological\s*reference|test\s*name|investigation|parameter|units?\s*only|result\s*only)\b/i;
const DATE_ONLY = /\b\d{1,4}[\/-]\d{1,2}[\/-]\d{1,4}\b/;
const NUM = "[-+]?\\d+(?:[.,]\\d+)?";
const INTERVAL_RE = new RegExp("(" + NUM + ")\\s*(?:-|–|—|\\bto\\b)\\s*(" + NUM + ")", "i");

function normaliseName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

const TEST_EQUIVALENCE_GROUPS: string[][] = [
  ["hemoglobin", "haemoglobin", "hgb", "hb"],
  ["hematocrit", "haematocrit", "hct", "pcv"],
  ["white blood cell count", "wbc", "total leukocyte count", "tlc"],
  ["red blood cell count", "rbc", "erythrocyte count"],
  ["platelet count", "platelets", "platelet", "plt"],
  ["mean corpuscular volume", "mcv"],
  ["mean corpuscular hemoglobin", "mch"],
  ["mean corpuscular hemoglobin concentration", "mchc"],
  ["red cell distribution width", "rdw", "rdw-cv"],
  ["mean platelet volume", "mpv"],
  ["erythrocyte sedimentation rate", "esr"],
  ["c reactive protein", "crp"],
  ["gamma glutamyl transferase", "ggt", "gamma gt"],
  ["total bilirubin", "bilirubin total"],
  ["direct bilirubin", "bilirubin direct"],
  ["indirect bilirubin", "bilirubin indirect"],
  ["serum albumin", "albumin"],
  ["total protein", "serum total protein"],
  ["prothrombin time", "pt"],
  ["international normalized ratio", "inr"],
  ["activated partial thromboplastin time", "aptt"],
  ["vitamin d", "25 oh vitamin d", "25-hydroxy vitamin d"],
  ["vitamin b12", "cobalamin"],
  ["serum ferritin", "ferritin"],
  ["serum iron", "iron"],
  ["serum magnesium", "magnesium"],
  ["serum phosphate", "phosphate"],
  ["fasting blood sugar", "fbs", "fasting glucose"],
  ["random blood sugar", "rbs", "random glucose"],
  ["alanine aminotransferase", "sgpt", "alt"],
  ["aspartate aminotransferase", "sgot", "ast"],
  ["alkaline phosphatase", "alp"],
  ["glycated hemoglobin", "glycosylated hemoglobin", "hba1c"],
  ["blood urea nitrogen", "bun"],
  ["triglycerides", "triglyceride"],
  ["serum calcium", "calcium"],
  ["serum sodium", "sodium"],
  ["serum potassium", "potassium"],
  ["serum chloride", "chloride"],
  ["total cholesterol", "cholesterol"],
  ["thyroid stimulating hormone", "tsh"],
];

function canonicalTestName(value: string): string {
  const normal = normaliseName(value);
  const group = TEST_EQUIVALENCE_GROUPS.find(items => items.some(item => normaliseName(item) === normal));
  return group ? normaliseName(group[0]) : normal;
}

function configuredTestForName(name: string, configuredTests: LabTestDefinition[]): LabTestDefinition | undefined {
  const key = canonicalTestName(name);
  return configuredTests.find(item => {
    const configured = canonicalTestName(item.name || "");
    return configured === key || normaliseName(item.name || "").startsWith(normaliseName(name) + " ");
  });
}

export function hasKnownLabTestName(line: string, configuredTests: LabTestDefinition[] = []): boolean { return !!findTestPrefix(line, configuredTests); }

export function isLabMetadataLine(line: string, configuredTests: LabTestDefinition[] = []): boolean { return isNonResultLine(line, configuredTests); }

function findTestPrefix(line: string, configuredTests: LabTestDefinition[] = []): { name: string; end: number; configured?: LabTestDefinition } | null {
  const cleaned = line.replace(/^\s*[•*|:;\-]+\s*/, "");
  const lower = cleaned.toLowerCase();
  for (const configured of [...configuredTests].sort((a, b) => String(b.name || "").length - String(a.name || "").length)) {
    const name = String(configured.name || "").trim();
    if (name.length < 2) continue;
    const lowerName = name.toLowerCase();
    if (cleaned.toLowerCase().startsWith(lowerName)) {
      const nextChar = cleaned.charAt(name.length);
      if (!nextChar || /[\s:|]/.test(nextChar) || "([{/%".includes(nextChar)) return { name: cleaned.slice(0, name.length).trim(), end: name.length, configured };
    }
  }
  for (const alias of TEST_ALIASES) {
    const pattern = new RegExp("^" + alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?=$|\\s|:|\\||\\(|\\[|\\{|/|%)", "i");
    const match = pattern.exec(cleaned);
    if (match) { const name = cleaned.slice(0, match[0].length).trim(); return { name, end: match[0].length, configured: configuredTestForName(name, configuredTests) }; }
  }
  // A known test may be prefixed by a short lab code, but never infer arbitrary words.
  const normal = normaliseName(lower);
  for (const alias of TEST_ALIASES) {
    if (normal.startsWith(alias + " ")) {
      const index = lower.indexOf(alias);
      if (index >= 0 && index <= 8) { const name = cleaned.slice(index, index + alias.length).trim(); return { name, end: index + alias.length, configured: configuredTestForName(name, configuredTests) }; }
    }
  }
  return null;
}

function isNonResultLine(line: string, configuredTests: LabTestDefinition[] = []): boolean {
  if (!line || (line.length < 4 && !findTestPrefix(line, configuredTests)) || META_LINE.test(line) || HEADER_LINE.test(line)) return true;
  if (DATE_ONLY.test(line) && !findTestPrefix(line, configuredTests)) return true;
  if (/^\s*(?:m|male|f|female)\s*[:=]?\s*\d/i.test(line) && !findTestPrefix(line, configuredTests)) return true;
  if (/^\s*(?:ref(?:erence)?|normal)\s*(?:range|interval)?\s*[:=]/i.test(line)) return true;
  return false;
}

export function isLikelyLabReportText(text: string, configuredTests: LabTestDefinition[] = []): boolean {
  const lines = String(text || "").split(/\r?\n/).map(line => line.replace(/\s+/g, " ").trim());
  let validRows = 0;
  const hasMeasuredValue = (value: string) => {
    const referenceStart = firstReferenceStart(value);
    const measuredArea = referenceStart >= 0 ? value.slice(0, referenceStart) : value;
    return resultNumber(measuredArea) !== null ||
      /\b(?:positive|negative|reactive|nonreactive|non[\s-]?reactive|detected|not\s+detected)\b/i.test(measuredArea);
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (isNonResultLine(line, configuredTests)) continue;
    const test = findTestPrefix(line, configuredTests);
    if (!test) continue;
    const rest = line.slice(test.end).replace(/^\s*\((?!\s*[-+]?\d)[^)]{1,30}\)\s*/, " ");
    if (hasMeasuredValue(rest)) {
      validRows++;
      continue;
    }

    // OCR commonly splits labels and results over adjacent lines/blocks.
    // Pair nearby values, but stop when another known test name appears.
    for (let offset = 1; offset <= 3 && index + offset < lines.length; offset++) {
      const nearby = lines[index + offset];
      if (!nearby) continue;
      if (findTestPrefix(nearby, configuredTests)) break;
      if (isNonResultLine(nearby, configuredTests) && resultNumber(nearby) === null) continue;
      if (hasMeasuredValue(nearby)) {
        validRows++;
        break;
      }
    }
  }
  return validRows >= 1;
}

const numericValue = (raw: string) => Number(raw.replace(",", "."));
const NUMBER_PATTERN = "[-+]?\\d+(?:[.,]\\d+)?";
const INTERVAL_PATTERN = new RegExp("(" + NUMBER_PATTERN + ")\\s*(?:-|–|—|\\bto\\b)\\s*(" + NUMBER_PATTERN + ")", "i");

type ReferenceInterval = { low: number; high: number; text: string; start: number };

function genderKind(gender: string): "male" | "female" | "" {
  if (/^(?:m|male|man|men)$/i.test(gender.trim())) return "male";
  if (/^(?:f|female|woman|women)$/i.test(gender.trim())) return "female";
  return "";
}

function configuredReference(test: LabTestDefinition | undefined, gender: string): ReferenceInterval | null {
  const sex = genderKind(gender);
  if (!test || !sex) return null;
  const minRaw = sex === "male" ? test.maleMin : test.femaleMin;
  const maxRaw = sex === "male" ? test.maleMax : test.femaleMax;
  if (!String(minRaw ?? "").trim() || !String(maxRaw ?? "").trim()) return null;
  const min = numericValue(String(minRaw));
  const max = numericValue(String(maxRaw));
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) return null;
  return { low: min, high: max, text: String(minRaw) + "–" + String(maxRaw), start: -1 };
}

/**
 * Select the interval matching the patient's sex when a report prints both
 * male and female ranges. Never use the last numeric interval by default:
 * that can accidentally treat the male range's upper limit as the result.
 */
function extractReferenceInterval(text: string, gender: string): ReferenceInterval | null {
  const sex = genderKind(gender);
  const matches = [...text.matchAll(new RegExp(NUMBER_PATTERN + "\\s*(?:-|–|—|\\bto\\b)\\s*" + NUMBER_PATTERN, "gi"))];
  if (matches.length > 1) {
    const labelledIntervals: Array<ReferenceInterval & { sex: "male" | "female" }> = [];
    let previousEnd = 0;
    for (const match of matches) {
      const start = match.index ?? 0;
      const preceding = text.slice(previousEnd, start);
      const labels = [...preceding.matchAll(/\b(male|female|men|women|m|f)\b/gi)];
      const lastLabel = labels[labels.length - 1]?.[1] || "";
      const intervalSex = /^(?:male|men|m)$/i.test(lastLabel) ? "male" : /^(?:female|women|f)$/i.test(lastLabel) ? "female" : "";
      const pair = INTERVAL_PATTERN.exec(match[0]);
      if (intervalSex && pair) {
        const a = numericValue(pair[1]);
        const b = numericValue(pair[2]);
        if (Number.isFinite(a) && Number.isFinite(b) && a !== b) {
          labelledIntervals.push({ low: Math.min(a, b), high: Math.max(a, b), text: pair[1] + "–" + pair[2], start, sex: intervalSex });
        }
      }
      previousEnd = start + match[0].length;
    }
    if (labelledIntervals.length) return (sex ? labelledIntervals.find(item => item.sex === sex) : undefined) || null;
    return null; // Multiple unlabelled intervals are ambiguous.
  }
  if (matches.length !== 1) return null;

  // A single interval is usable only when it is not explicitly labelled for
  // the opposite sex. A report's lone male interval must not be applied to a female.
  const match = matches[0];
  const before = text.slice(0, match.index ?? 0);
  const labels = [...before.matchAll(/\b(male|female|men|women|m|f)\b/gi)];
  const label = labels[labels.length - 1]?.[1] || "";
  if (label) {
    const intervalSex = /^(?:male|men|m)$/i.test(label) ? "male" : "female";
    if (!sex || intervalSex !== sex) return null;
  }
  const pair = INTERVAL_PATTERN.exec(match[0]);
  if (!pair) return null;
  const a = numericValue(pair[1]);
  const b = numericValue(pair[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return null;
  return { low: Math.min(a, b), high: Math.max(a, b), text: pair[1] + "–" + pair[2], start: match.index ?? 0 };
}

function firstReferenceStart(text: string): number {
  const candidates = [
    text.search(/\b(?:male|female|men|women|m|f)\b/i),
    text.search(/\b(?:reference|ref|normal|biological)\s*(?:range|interval|reference)?\b/i),
    (() => { const match = new RegExp(NUMBER_PATTERN + "\\s*(?:-|–|—|\\bto\\b)\\s*" + NUMBER_PATTERN, "i").exec(text); return match?.index ?? -1; })(),
  ].filter(index => index >= 0);
  return candidates.length ? Math.min(...candidates) : -1;
}

function resultNumber(text: string): string | null {
  const value = String(text || "").replace(/\s+/g, " ").trim()
    .replace(/^[\s|:;]+/, "")
    .replace(/^(?:result|value|reading)\s*[:=|]?\s*/i, "")
    .replace(/^(?:high|low|h|l)\s*[:=|]?\s*(?=[<>≤≥]?\s*[-+]?\d)/i, "");
  if (!value || /\b(?:male|female|men|women|reference|normal|range|interval)\b/i.test(value)) return null;

  // F/M (including OCR forms iF/iM) may be a sex marker, not a result.
  const withoutSexMarker = value
    .replace(/^\s*(?:i?[fm])\s+(?=[<>≤≥]?\s*[-+]?\d)/i, "")
    .replace(/(?:^|\s)(?:i?[fm])\s*$/i, "")
    .trim();

  const qualitative = /^(?:non[\s-]?reactive|not\s+detected|negative|positive|reactive|detected|absent|present|normal|abnormal)\b/i.exec(withoutSexMarker);
  if (qualitative) return qualitative[0].replace(/\s+/g, " ").trim();

  // Never take a reference-range endpoint or a second unrelated number as a result.
  if (INTERVAL_PATTERN.test(withoutSexMarker)) return null;
  const scalar = new RegExp("^\\s*([<>≤≥]?\\s*" + NUMBER_PATTERN + ")").exec(withoutSexMarker);
  if (!scalar) return null;
  const raw = scalar[1].replace(/[<>≤≥\s]/g, "");
  const remainder = withoutSexMarker.slice(scalar[0].length).trim();
  const remainderWithoutScientificUnit = remainder
    .replace(/[x×]\s*10\s*\^?\s*[-+]?\d+/gi, "")
    .replace(/\b(?:10\^?\d+)\b/gi, "")
    .trim();
  if (new RegExp(NUMBER_PATTERN).test(remainderWithoutScientificUnit)) return null;
  if (/^[.\-–—/]/.test(remainderWithoutScientificUnit)) return null;
  return raw;
}

function defaultUnitForTest(name: string): string {
  const key = canonicalTestName(name);
  const units: Array<[string[], string]> = [
    [["hemoglobin", "haemoglobin", "hgb", "hb"], "g/dL"],
    [["hematocrit", "haematocrit", "hct", "pcv"], "%"],
    [["red blood cell count", "rbc", "erythrocyte count"], "x10^6 cells/uL"],
    [["white blood cell count", "wbc", "total leukocyte count", "tlc"], "x10^3 cells/uL"],
    [["platelet count", "platelets", "platelet", "plt"], "x10^3 cells/uL"],
    [["mcv"], "fL"], [["mch"], "pg"], [["mchc"], "g/dL"], [["mpv"], "fL"], [["rdw", "rdw-cv"], "%"],
    [["neutrophils", "lymphocytes", "eosinophils", "monocytes", "basophils"], "%"],
    [["fasting blood sugar", "random blood sugar", "glucose", "fbs", "rbs"], "mg/dL"],
    [["creatinine"], "mg/dL"], [["urea", "blood urea nitrogen", "bun"], "mg/dL"],
    [["total cholesterol", "cholesterol", "triglycerides"], "mg/dL"],
    [["sodium", "potassium", "chloride"], "mmol/L"],
  ];
  const match = units.find(([names]) => names.some(item => canonicalTestName(item) === key));
  return match?.[1] || "";
}

function normalizeLabUnit(testName: string, unit: string): string {
  const value = String(unit || "").trim().replace(/\s+/g, "");
  const test = canonicalTestName(testName);
  if (["hemoglobin", "haemoglobin", "hgb", "hb"].some(name => canonicalTestName(name) === test)) {
    const compact = value.toLowerCase().replace(/[^a-z0-9/]/g, "");
    // Preserve an explicitly clear alternative unit, but normalize common OCR
    // confusions (R/aL, R/al, R/dL, g/aL, etc.) to the conventional g/dL.
    if (!compact || /^(?:g|r|q|9)\/?(?:d|a)\/?d?\/?[li1]$/.test(compact) ||
        /^(?:g|r|q|9)\/(?:d|a)[li1]$/.test(compact) ||
        /^(?:g|r|q|9)(?:d|a)[li1]$/.test(compact) ||
        /^(?:r|q|9)\/(?:a|d)l$/.test(compact)) return "g/dL";
    if (/^g\/?d\/?l$/.test(compact)) return "g/dL";
    if (/^mmol\/?l$/.test(compact)) return "mmol/L";
  }
  return value;
}

function normalizeHemoglobinUnitText(text: string): string {
  // These OCR strings are not valid lab units. Normalize them even when the OCR
  // engine puts the unit on a separate line from the test name.
  const normalized = String(text || "")
    .replace(/\b(?:r|q|9)\s*\/\s*(?:a|d)\s*\/?\s*[lI1]\b/gi, "g/dL")
    .replace(/\b(?:r|q|9)\s*(?:a|d)\s*[lI1]\b/gi, "g/dL");
  return normalized.split(/\r?\n/).map(line => {
    if (!/\b(?:hemoglobin|haemoglobin|hgb|hb)\b/i.test(line)) return line;
    return line.replace(/\bg\s*\/\s*a\s*\/?\s*[lI1]\b/gi, "g/dL")
      .replace(/\bg\s*a\s*[lI1]\b/gi, "g/dL");
  }).join("\n");
}

function unitFromResultCell(value: string): string {
  const text = String(value || "").trim();
  // Capture common units that may be attached to the result when the OCR
  // misses the separate Units column.
  const match = text.match(/(?:g\s*\/\s*d?l|mg\s*\/\s*d?l|mmol\s*\/\s*l|mol\s*\/\s*l|iu\s*\/\s*l|u\s*\/\s*l|cells?\s*\/\s*(?:ul|µl|μl)|x\s*10\s*\^?\s*\d+\s*(?:cells?\s*\/\s*(?:ul|µl|μl))?|fl|pg|%|seconds?|sec)(?![a-z])/i);
  return match?.[0]?.replace(/\s+/g, "") || "";
}

function classifyDeviation(resultRaw: string, reference: ReferenceInterval, warningPercent = 10): ParsedLabRow["severity"] | null {
  const result = numericValue(resultRaw);
  if (!Number.isFinite(result)) return null;
  if (result >= reference.low && result <= reference.high) return null;
  const boundary = result < reference.low ? reference.low : reference.high;
  const excursionPercent = boundary === 0
    ? (result === boundary ? 0 : Number.POSITIVE_INFINITY)
    : Math.abs(result - boundary) / Math.abs(boundary) * 100;
  // Ignore tiny deviations (up to and including 1%) to avoid noisy false alerts.
  if (excursionPercent <= 1) return null;
  return excursionPercent <= Math.max(1, Math.min(100, warningPercent)) ? "WARNING" : "ALERT";
}


/**
 * Extract only an explicitly labelled laboratory report/sample/test date.
 * Never fall back to the patient's operation/file date or an unlabelled DOB.
 */
export function extractLabReportDate(text: string): string {
  const source = String(text || "").replace(/[\t\r]+/g, " ").split("\n").map(line => line.replace(/\s+/g, " ").trim()).join("\n").replace(/(\d{1,2})\s*[-/.]\s*([A-Za-z]{3,9})\s*[-/.]\s*(\d{4})/g, "$1-$2-$3").replace(/(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/g, "$1-$2-$3");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthIndex = (raw: string): number => {
    const token = String(raw || "").toLowerCase().trim().replace(/[|!]/g, "t").replace(/^0(?=ct(?:ober)?$)/, "o").replace(/\.$/, "");
    const cleaned = token.replace(/[^a-z]/g, "");
    return cleaned.length < 3 ? -1 : months.findIndex(name => name.toLowerCase() === cleaned.slice(0, 3));
  };
  const normalize = (raw: string): string => {
    let value = String(raw || "").trim().replace(/,/g, "").replace(/\s+/g, " ");
    value = value.replace(/(^|[-/. ])([0-9OoIl|!]+)(?=$|[-/. ])/g, (whole, separator, token) => {
      if (!/\d/.test(token)) return whole;
      return separator + token.replace(/[Oo]/g, "0").replace(/[Il|!]/g, "1");
    });
    let match = /^(\d{4})[-/. ](\d{1,2})[-/. ](\d{1,2})$/.exec(value);
    if (match) {
      const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
      if (year >= 1900 && year <= 2200 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        const check = new Date(year, month - 1, day);
        if (check.getFullYear() === year && check.getMonth() === month - 1 && check.getDate() === day) return String(day).padStart(2, "0") + "-" + months[month - 1] + "-" + year;
      }
      return "";
    }
    match = /^(\d{1,2})[-/. ]([A-Za-z0-9|!]{3,9})[-/. ](\d{2,4})$/.exec(value);
    if (match) {
      const month = monthIndex(match[2]);
      let year = Number(match[3]);
      if (match[3].length === 2) year += year >= 50 ? 1900 : 2000;
      const day = Number(match[1]);
      if (month >= 0 && day >= 1 && day <= 31 && year >= 1900 && year <= 2200) {
        const check = new Date(year, month, day);
        if (check.getFullYear() === year && check.getMonth() === month && check.getDate() === day) return String(day).padStart(2, "0") + "-" + months[month] + "-" + year;
      }
      return "";
    }
    match = /^(\d{1,2})[/. -](\d{1,2})[/. -](\d{4})$/.exec(value);
    if (match) {
      const day = Number(match[1]), month = Number(match[2]), year = Number(match[3]);
      if (day >= 1 && day <= 31 && month >= 1 && month <= 12 && year >= 1900 && year <= 2200) {
        const check = new Date(year, month - 1, day);
        if (check.getFullYear() === year && check.getMonth() === month - 1 && check.getDate() === day) return String(day).padStart(2, "0") + "-" + months[month - 1] + "-" + year;
      }
      return "";
    }
    match = /^([A-Za-z0-9|!]{3,9})[-/. ](\d{1,2})[-/. ](\d{4})$/.exec(value) || /^([A-Za-z0-9|!]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/.exec(value);
    if (match) {
      const month = monthIndex(match[1]), day = Number(match[2]), year = Number(match[3]);
      if (month >= 0 && day >= 1 && day <= 31 && year >= 1900 && year <= 2200) {
        const check = new Date(year, month, day);
        if (check.getFullYear() === year && check.getMonth() === month && check.getDate() === day) return String(day).padStart(2, "0") + "-" + months[month] + "-" + year;
      }
    }
    return "";
  };
  const monthToken = "(?:[A-Za-z0-9|!]{3,9})";
  const dateToken = "(?:\\d{4}[-/. ]\\d{1,2}[-/. ]\\d{1,2}|[0-9OoIl|!]{1,2}[-/. ]" + monthToken + "[-/. ][0-9OoIl|!]{2,4}|\\d{1,2}[-/. ]\\d{1,2}[-/. ]\\d{4}|" + monthToken + "\\s+[0-9OoIl|!]{1,2},?\\s+\\d{4})";
  const tokenPattern = new RegExp(dateToken, "gi");
  const candidates: Array<{ date: string; rank: number; index: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(source)) !== null) {
    const normalized = normalize(match[0]);
    if (!normalized) continue;
    const before = source.slice(Math.max(0, match.index - 140), match.index).toLowerCase();
    const after = source.slice(match.index + match[0].length, Math.min(source.length, match.index + match[0].length + 70)).toLowerCase();
    const context = before.slice(-120) + " " + after;
    if (/(?:date\s*of\s*birth|birth\s*date|\bd\.?\s*o\.?\s*b\.?\b|\bdob\b|operation\s*date|surgery\s*date|admission\s*date|discharge\s*date)\s*[:= -]?\s*$/.test(before) || /^\s*(?:of\s*birth|of\s*surgery|of\s*operation)\b/.test(after)) continue;
    let rank = 1;
    if (/(?:lab(?:oratory)?\s*)?(?:report|reporting|result)\s*date|date\s*of\s*(?:report|result)|report\s*generated|reported\s*on/.test(context)) rank = 6;
    else if (/(?:collection\s*date|date\s*of\s*collection|sample\s*date|specimen\s*date|collected\s*on|sample\s*collected|specimen\s*collected|received\s*on|verified\s*on|tested\s*on|test\s*date)/.test(context)) rank = 5;
    else if (/(?:^|[\s|,])date\s*[:= -]?\s*[^|\n;]{0,70}$/.test(before)) rank = 4;
    else if (/\b(?:dob|birth|operation|surgery|admission|discharge)\b/.test(context)) continue;
    candidates.push({ date: normalized, rank, index: match.index });
  }
  candidates.sort((a, b) => b.rank - a.rank || a.index - b.index);
  if (!candidates.length) return "";
  const bestRank = candidates[0].rank;
  const bestDates = [...new Set(candidates.filter(candidate => candidate.rank === bestRank).map(candidate => candidate.date))];
  // Multiple dates can share the same rank on one report. Keep the first strongest candidate instead of losing the date entirely.
  return candidates[0].date;
}


export function parseLabReportRows(text: string, configuredTests: LabTestDefinition[] = [], gender = "", warningPercent = 10, includeNormal = false): ParsedLabRow[] {
  const rows: ParsedLabRow[] = [];
  const seen = new Set<string>();

  // Each page includes reconstructed table rows followed by raw OCR for review.
  // When structured rows exist for a page, never parse the raw section as a
  // second source of numbers: it can contain both male and female ranges.
  const pages = String(text || "").split(/(?=LAB REPORT IMAGE\s+\d+)/i);
  for (const page of pages) {
    const structuredMarker = "RECONSTRUCTED TABLE ROWS (test | result | unit | reference range)";
    const rawMarker = "RAW OCR TEXT FOR REVIEW";
    const structuredAt = page.indexOf(structuredMarker);
    const rawAt = page.indexOf(rawMarker);
    const structuredSection = structuredAt >= 0 ? page.slice(structuredAt + structuredMarker.length, rawAt >= 0 ? rawAt : undefined) : "";
    const rawSection = rawAt >= 0 ? page.slice(rawAt + rawMarker.length) : page;
    const structuredSource = structuredSection.trim() ? structuredSection : "";
    // Process reconstructed rows first, then raw OCR lines as a fallback for
    // tests the column geometry missed. Duplicate test/result pairs are removed below.
    const sources = structuredSource ? [structuredSource] : [page];

    for (const source of sources) {
    const sourceLines = source.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < sourceLines.length; lineIndex++) {
      const rawLine = sourceLines[lineIndex];
      const line = rawLine.replace(/\s+/g, " ").trim();
      if (isNonResultLine(line, configuredTests)) continue;

      const cells = line.includes("|") ? line.split("|").map(cell => cell.trim()) : [];
      const structured = cells.length >= 2 ? findTestPrefix(cells[0], configuredTests) : null;
      let testPrefix: { name: string; end: number; configured?: LabTestDefinition } | null = structured || findTestPrefix(line, configuredTests);
      if (!testPrefix) continue;

      let resultRaw: string | null = null;
      let unit = "";
      let reference: ReferenceInterval | null = null;

      if (structured) {
        // OCR is trusted only for the test label and measured result. Units and
        // reference intervals are taken from the saved test definition because
        // OCR commonly mixes the male and female intervals or reads them as results.
        resultRaw = resultNumber(cells[1]);
      } else {
        const rest = line.slice(testPrefix.end).replace(/^\s*\((?!\s*[-+]?\d)[^)]{1,30}\)\s*/, " ").replace(/^\s*[:|\-]+\s*/, "");
        const referenceStart = firstReferenceStart(rest);
        const resultArea = referenceStart >= 0 ? rest.slice(0, referenceStart) : rest;
        resultRaw = resultNumber(resultArea);
      }
      let pairedLine = "";
      let pairedUnit = "";
      if (!resultRaw) {
        // Some OCR engines place the label and its measured value on neighboring lines.
        // Do not cross another known test label or mistake an interval for a result.
        for (let offset = 1; offset <= 2 && lineIndex + offset < sourceLines.length; offset++) {
          const nearby = sourceLines[lineIndex + offset].replace(/\s+/g, " ").trim();
          if (!nearby) continue;
          if (findTestPrefix(nearby, configuredTests)) break;
          if (isNonResultLine(nearby, configuredTests) && resultNumber(nearby) === null) continue;
          const referenceStart = firstReferenceStart(nearby);
          const measuredArea = referenceStart >= 0 ? nearby.slice(0, referenceStart) : nearby;
          const measured = resultNumber(measuredArea);
          if (!measured) continue;
          resultRaw = measured;
          pairedLine = nearby;
          pairedUnit = unitFromResultCell(measuredArea);
          break;
        }
      }
      unit = String(testPrefix.configured?.unit || pairedUnit || "").trim();
      // Never use a reference interval printed on the report for alerting.
      // Use only the saved range for this patient's sex (M/male or F/female).
      if (!resultRaw) continue;
      reference = configuredReference(testPrefix.configured, gender);
      if (!reference && !includeNormal) continue;

      // When includeNormal is true, missing sex-specific ranges are retained as
      // unclassified rows for the age-of-report check only; never label them normal.
      const severity = reference ? (classifyDeviation(resultRaw, reference, warningPercent) || "") : "";
      if (!severity && !includeNormal) continue;
      const result = numericValue(resultRaw);
      const cleanedUnit = unit
        // OCR frequently merges sex labels (F, M, iM) or stray glyphs into
        // the unit column. These are not measurement units and must not be
        // shown as part of the patient's result.
        .replace(/\b(?:result|value|ref|reference|range|normal|male|female|men|women|im)\b/gi, " ")
        .replace(/\b[fm]\b/gi, " ")
        .replace(/\by\b/gi, " ")
        .replace(/[0-9.,+\-–—:|;]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const resultKey = Number.isFinite(result) ? String(result) : normaliseName(resultRaw);
      const key = (normaliseName(testPrefix.name) + "|" + resultKey + "|" + (reference?.text || "no-reference")).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        test: testPrefix.name,
        result: resultRaw,
        unit: normalizeLabUnit(testPrefix.name, cleanedUnit || testPrefix.configured?.unit || defaultUnitForTest(testPrefix.name)).slice(0, 24),
        reference: reference?.text || "",
        severity,
        sourceLine: pairedLine ? line + " | " + pairedLine : line,
      });
    }
    }
  }
  return rows;
}

type OcrPositionedLine = { text: string; x: number; y: number; width: number; height: number };

function imageSize(uri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    Image.getSize(uri, (width, height) => resolve({ width, height }), reject);
  });
}

/**
 * Rebuild table rows from OCR bounding boxes instead of trusting the OCR
 * engine's flattened text order. All coordinates are in original image pixels.
 */
function structureLabColumns(blocks: any[], imageWidth: number, imageHeight: number, configuredTests: LabTestDefinition[] = []): string {
  const suppliedBlocks = Array.isArray(blocks) ? blocks : [];
  // Paragraph-level rectangles cover multiple lines and cannot safely be reused
  // as the geometry of each individual line or table cell.
  if (suppliedBlocks.some(block =>
    /\r|\n/.test(String(block?.text || "")) &&
    Number(block?.boundingBox?.height || 0) > 0
  )) return "";

  const positioned: OcrPositionedLine[] = [];
  for (const block of suppliedBlocks) {
    const box = block?.boundingBox;
    const text = String(block?.text || "").trim();
    if (!box || !text) continue;
    positioned.push({
      text,
      x: Number(box.x) || 0,
      y: Number(box.y) || 0,
      width: Number(box.width) || 0,
      height: Number(box.height) || 1,
    });
  }
  if (!positioned.length || !imageWidth || !imageHeight) return "";

  const xCenter = (item: OcrPositionedLine) => (item.x + item.width / 2) / imageWidth;
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const median = (values: number[]) => {
    if (!values.length) return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };

  // Word-level boxes are first aligned into visual rows using their y positions.
  const typicalHeight = median(positioned.map(item => item.height)) || imageHeight * 0.02;
  const rowTolerance = Math.max(typicalHeight * 0.58, imageHeight * 0.005);
  const rowGroups: OcrPositionedLine[][] = [];
  for (const item of positioned.sort((a, b) => (a.y + a.height / 2) - (b.y + b.height / 2))) {
    const y = item.y + item.height / 2;
    let target = rowGroups.find(group => {
      const avgY = mean(group.map(entry => entry.y + entry.height / 2));
      return Math.abs(y - avgY) <= Math.max(rowTolerance, Math.min(item.height, group[0].height) * 0.45);
    });
    if (!target) { target = []; rowGroups.push(target); }
    target.push(item);
  }

  // Preserve word-to-character positions to map a multi-word recognized test label
  // back to its visual x coordinates after combining the words for matching.
  const rowDetails = rowGroups.map(group => {
    const ordered = [...group].sort((a, b) => a.x - b.x);
    let cursor = 0;
    const spans = ordered.map((item, index) => {
      if (index) cursor += 1;
      const start = cursor;
      cursor += item.text.length;
      return { item, start, end: cursor };
    });
    const text = ordered.map(item => item.text).join(" ");
    const prefix = findTestPrefix(text, configuredTests);
    let labelLeft: number | null = null;
    let labelRight: number | null = null;
    if (prefix) {
      const labelStart = text.toLowerCase().indexOf(prefix.name.toLowerCase());
      const labelEnd = labelStart >= 0 ? labelStart + prefix.name.length : prefix.end;
      const labelSpans = spans.filter(span => span.end > Math.max(0, labelStart) && span.start < labelEnd);
      if (labelSpans.length) {
        labelLeft = Math.min(...labelSpans.map(span => span.item.x / imageWidth));
        labelRight = Math.max(...labelSpans.map(span => (span.item.x + span.item.width) / imageWidth));
      }
    }
    return { ordered, spans, text, prefix, labelLeft, labelRight };
  });

  const knownRows = rowDetails.filter(row => row.prefix && row.labelRight !== null);
  // Never manufacture a table if no known test label was recognized.
  if (!knownRows.length) return "";

  const testRight = Math.max(...knownRows.map(row => row.labelRight!));
  const candidateX: number[] = [];
  const qualitative = /^(?:positive|negative|reactive|nonreactive|non[\s-]?reactive|detected|absent|present|normal|abnormal)$/i;
  for (const row of knownRows) {
    const prefix = row.prefix!;
    for (const span of row.spans) {
      if (span.start < prefix.end) continue;
      const value = span.item.text.trim();
      // Collect measured scalars and qualitative results only after the recognized
      // test label. Reference-range numbers remain farther right and form their
      // own cluster(s), which keeps them out of the measured-result cell.
      if (resultNumber(value) !== null || qualitative.test(value)) {
        const center = xCenter(span.item);
        if (center > testRight + 0.025) candidateX.push(center);
      }
    }
  }

  candidateX.sort((a, b) => a - b);
  const clusters: number[][] = [];
  for (const value of candidateX) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(value - mean(last)) <= 0.055) last.push(value);
    else clusters.push([value]);
  }
  const resultCenters = clusters.map(mean);
  const headerCenter = (pattern: RegExp) => {
    const item = positioned.find(value => pattern.test(value.text.trim()));
    return item ? xCenter(item) : undefined;
  };
  const resultCenter = headerCenter(/^result\s*:?$/i) ??
    resultCenters.find(value => value > testRight + 0.035);
  if (resultCenter === undefined) return "";

  // Column positions arrange the row only. Clinical classification continues to use
  // the saved sex-specific ranges, never reference endpoints read from the image.
  const laterCenters = resultCenters.filter(value => value > resultCenter + 0.07);
  const unitCenter = headerCenter(/^units?\s*:?$/i) ?? Math.max(resultCenter + 0.15, 0.66);
  const referenceCenter = headerCenter(/^(?:reference|normal|biological|ref)\s*:?$/i) ??
    laterCenters[0] ?? Math.max(unitCenter + 0.18, 0.84);
  const testBoundary = Math.min((testRight + resultCenter) / 2, resultCenter - 0.025);
  const resultBoundary = (resultCenter + unitCenter) / 2;
  const unitBoundary = (unitCenter + referenceCenter) / 2;

  const output: string[] = [];
  for (const row of rowDetails) {
    const cells = ["", "", "", ""];
    for (const item of row.ordered) {
      const center = xCenter(item);
      const column = center < testBoundary ? 0 : center < resultBoundary ? 1 : center < unitBoundary ? 2 : 3;
      cells[column] = (cells[column] + " " + item.text).trim();
    }
    // Preserve rows whose geometry does not fit the inferred grid; raw-text parsing
    // can still extract from them without pretending they are aligned table cells.
    if (!cells[0] || !cells[1]) {
      output.push(row.text);
      continue;
    }
    const structured = cells.filter(Boolean).join(" | ");
    if (structured) output.push(structured);
  }
  return output.join("\n");
}
async function recognizeOnlineLabText(uri: string, apiKey: string): Promise<string> {
  const key = String(apiKey || "").trim();
  if (!key) return "";
  try {
    const body = new FormData();
    body.append("file", { uri, name: "lab-report.jpg", type: "image/jpeg" } as any);
    body.append("language", "eng");
    body.append("isOverlayRequired", "false");
    body.append("detectOrientation", "true");
    body.append("scale", "true");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let response: Response;
    try {
      response = await fetch("https://api.ocr.space/parse/image", {
        method: "POST",
        headers: { apikey: key },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) return "";
    const payload: any = await response.json();
    if (payload?.IsErroredOnProcessing) return "";
    return Array.isArray(payload?.ParsedResults)
      ? payload.ParsedResults.map((item: any) => String(item?.ParsedText || "")).filter(Boolean).join("\n").trim()
      : "";
  } catch {
    // Network, service, or API-key errors fall back to offline OCR silently.
    return "";
  }
}

export async function recognizeLabText(
  uri: string,
  onlineApiKey = "",
  configuredTests: LabTestDefinition[] = [],
  gender = "",
): Promise<{ text: string; structuredText: string; mode: "online" | "offline" }> {
  // Run on-device OCR on the original and, for small/blurry-looking captures,
  // an enlarged high-quality copy. Upscaling cannot restore lost detail, but
  // often helps OCR read small printed digits without sending data online.
  let best: any = null;
  let bestSize: { width: number; height: number } | null = null;
  let originalDimensions: { width: number; height: number } | null = null;
  try {
    const originalSize = await imageSize(uri);
    originalDimensions = originalSize;
    bestSize = originalSize;
    best = await recognizeText(uri);
    // Do not upscale and OCR every image by default. Patient files contain X-rays,
    // clinical photos and documents that are not lab reports; repeated OCR on all of
    // them causes severe lag. Retry with transformed copies only when the first pass
    // is weak or does not produce recognizable lab rows.
  } catch {
    best = await recognizeText(uri);
  }
  const initialText = String(best?.text || "").trim();
  const potentialLabMarker = /\b(?:hemoglobin|haemoglobin|hgb|platelets?|plt|hbs\s*ag|hbsag|hcv|hepatitis|hiv|wbc|rbc|mcv|mchc?|glucose|creatinine|bilirubin|urea|sodium|potassium|chloride|result|investigation|reference\s*range|lab(?:oratory)?\s*report)\b/i.test(initialText);
  const initialRows = parseLabReportRows(initialText, configuredTests, gender, 10, true);
  if (!potentialLabMarker && initialRows.length === 0) {
    return { text: normalizeHemoglobinUnitText(initialText), structuredText: "", mode: "offline" };
  }
  const localScore = (value: any) => {
    const text = String(value?.text || "");
    // Judge OCR passes by recognized test/result pairs and the saved sex-specific
    // ranges, not merely by how much text or how many reference-range numbers they contain.
    const parsedRows = parseLabReportRows(text, configuredTests, gender, 10, true);
    const matchedNames = configuredTests.filter(test => {
      const name = normaliseName(test.name);
      return name.length > 1 && normaliseName(text).includes(name);
    }).length;
    const flagged = parsedRows.filter(row => row.severity === "ALERT" || row.severity === "WARNING").length;
    return text.length * 0.2 +
      (text.match(/\d+(?:[.,]\d+)?/g) || []).length * 3 +
      (text.match(/\b(?:result|reference|range|hemoglobin|haemoglobin|platelets|glucose|creatinine)\b/gi) || []).length * 10 +
      parsedRows.length * 160 + matchedNames * 90 + flagged * 35 +
      (extractLabReportDate(text) ? 1000 : 0);
  };
  // If the first read is weak, retry sideways images at both orientations and
  // keep the OCR pass that reads the most text/numbers/lab terms.
  if (localScore(best) < 220 || parseLabReportRows(String(best?.text || ""), configuredTests, gender, 10, true).length === 0) {
    for (const degrees of [90, 270]) {
      let rotatedUri = "";
      try {
        const rotated = await ImageManipulator.manipulateAsync(uri, [{ rotate: degrees }], { compress: 1, format: ImageManipulator.SaveFormat.PNG });
        rotatedUri = rotated.uri;
        const candidate = await recognizeText(rotated.uri);
        if (localScore(candidate) > localScore(best)) {
          best = candidate;
          bestSize = originalDimensions ? { width: originalDimensions.height, height: originalDimensions.width } : bestSize;
        }
      } catch {}
      if (rotatedUri) { try { await FileSystem.deleteAsync(rotatedUri, { idempotent: true }); } catch {} }
    }
  }
  // Re-read the page in overlapping enlarged bands. This helps reports photographed
  // from farther away, where the full-page OCR often loses small test values.
  // Keep the original full-page OCR blocks for table geometry and append crop text
  // as a fallback source so labels/results split across crops are not silently lost.
  try {
    const size = originalDimensions || await imageSize(uri);
    const rowCount = parseLabReportRows(String(best?.text || ""), configuredTests, gender, 10, true).length;
    if ((rowCount < Math.min(3, Math.max(1, configuredTests.length)) && localScore(best) < 420) || localScore(best) < 220) {
      const bandHeight = Math.max(1, Math.round(size.height * 0.56));
      const starts = [0, Math.max(0, size.height - bandHeight)];
      const cropTexts: string[] = [];
      for (const originY of [...new Set(starts)]) {
        let cropUri = "";
        try {
          const crop = await ImageManipulator.manipulateAsync(uri, [
            { crop: { originX: 0, originY, width: size.width, height: Math.min(bandHeight, size.height - originY) } },
            { resize: size.width >= 2200 ? { height: Math.round(Math.min(bandHeight, size.height - originY) * 1.25) } : { width: 2600 } },
          ], { compress: 1, format: ImageManipulator.SaveFormat.PNG });
          cropUri = crop.uri;
          const read = await recognizeText(cropUri);
          const cropText = String(read?.text || "").trim();
          if (cropText && localScore(read) > 20) cropTexts.push(cropText);
        } catch {}
        if (cropUri) { try { await FileSystem.deleteAsync(cropUri, { idempotent: true }); } catch {} }
      }
      if (cropTexts.length) {
        const merged = [String(best?.text || "").trim(), ...cropTexts].filter(Boolean).join("\n");
        if (localScore({ text: merged }) >= localScore(best)) best = { ...best, text: merged };
      }
    }
  } catch {}

  // Always read the header separately, even if the full-page pass found a date:
  // a full-page read can mistake DOB/other dates for the report date or misread
  // a clear printed date such as 06-Oct-2026.
  if (!extractLabReportDate(String(best?.text || ""))) {
    let headerUri = "";
    try {
      const size = originalDimensions || await imageSize(uri);
      const headerHeight = Math.max(1, Math.round(size.height * 0.46));
      const cropped = await ImageManipulator.manipulateAsync(uri, [
        { crop: { originX: 0, originY: 0, width: size.width, height: headerHeight } },
        { resize: size.width >= 2200 ? { height: Math.round(headerHeight * 1.35) } : { width: 2800 } },
      ], { compress: 1, format: ImageManipulator.SaveFormat.PNG });
      headerUri = cropped.uri;
      const headerRead = await recognizeText(headerUri);
      const headerText = String(headerRead?.text || "").trim();
      const currentText = String(best?.text || "");
      if (headerText && (extractLabReportDate(headerText) || localScore(headerRead) > localScore(best))) {
        best = { ...best, text: headerText + "\n" + currentText };
      }
    } catch {}
    if (headerUri) { try { await FileSystem.deleteAsync(headerUri, { idempotent: true }); } catch {} }
  }
  let text = normalizeHemoglobinUnitText(String(best?.text || ""));
  let mode: "online" | "offline" = "offline";
  // Optional cloud OCR is attempted only when the admin explicitly saves a key.
  // If it is unavailable or returns less readable text, retain the offline result.
  const onlineText = await recognizeOnlineLabText(uri, onlineApiKey);
  const qualityScore = (value: string) =>
    (isLikelyLabReportText(value) ? 80 : 0) +
    (value.match(/\d+(?:[.,]\d+)?/g) || []).length * 8 +
    (value.match(/\b(?:result|reference|range|hemoglobin|platelets|glucose|creatinine)\b/gi) || []).length * 12 +
    parseLabReportRows(value, configuredTests, gender, 10, true).length * 160 +
    (extractLabReportDate(value) ? 1800 : 0);
  if (onlineText && (
    qualityScore(onlineText) > qualityScore(text) ||
    (isLikelyLabReportText(onlineText) && !isLikelyLabReportText(text))
  )) {
    text = normalizeHemoglobinUnitText(onlineText);
    mode = "online";
  }
  let structuredText = "";
  try {
    const size = bestSize || await imageSize(uri);
    structuredText = structureLabColumns(best?.blocks || [], size.width, size.height, configuredTests);
  } catch {
    // Raw on-device OCR text remains available if image geometry is unavailable.
  }
  return { text: normalizeHemoglobinUnitText(text), structuredText: mode === "online" ? "" : normalizeHemoglobinUnitText(structuredText), mode };
}
