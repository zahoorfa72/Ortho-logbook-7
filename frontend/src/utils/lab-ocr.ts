import { recognizeText } from "expo-ocr-kit";
import { Image } from "react-native";

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
      if (!nextChar || /[\s:|]/.test(nextChar)) return { name: cleaned.slice(0, name.length).trim(), end: name.length, configured };
    }
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
    if (new RegExp(NUM).test(rest) || /\b(?:positive|negative|reactive|nonreactive)\b/i.test(rest)) validRows++;
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
      if (!male && !/^(f|female)$/i.test(gender.trim())) continue;
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
function structureLabColumns(blocks: any[], imageWidth: number, imageHeight: number): string {
  const positioned: OcrPositionedLine[] = [];
  for (const block of blocks || []) {
    const box = block?.boundingBox;
    const blockText = String(block?.text || "").trim();
    if (!box || !blockText) continue;
    const pieces = blockText.split(/\r?\n/).map((s: string) => s.trim()).filter(Boolean);
    const blockHeight = Number(box.height) || 1;
    const lineHeight = blockHeight / Math.max(1, pieces.length);
    pieces.forEach((text: string, index: number) => positioned.push({
      text,
      x: Number(box.x) || 0,
      y: (Number(box.y) || 0) + index * lineHeight,
      width: Number(box.width) || 0,
      height: lineHeight,
    }));
  }
  if (!positioned.length || !imageWidth || !imageHeight) return "";

  // Use printed column headings when the OCR provides separate heading blocks.
  const headerX = (pattern: RegExp) => {
    const hit = positioned.find(item => pattern.test(item.text));
    return hit ? (hit.x + hit.width / 2) / imageWidth : undefined;
  };
  const testHeader = headerX(/^(?:test(?:\s*name)?|investigation|parameter|analyte)\b/i);
  const resultHeader = headerX(/^result\b/i);
  const unitHeader = headerX(/^units?\b/i);
  const refHeader = headerX(/^(?:reference|normal|biological)\b/i);
  // Boundaries sit between column centres, not on the header text itself.
  const testCenter = testHeader ?? 0.20;
  const resultCenter = resultHeader ?? 0.50;
  const unitCenter = unitHeader ?? 0.66;
  const refCenter = refHeader ?? 0.84;
  const testBoundary = (testCenter + resultCenter) / 2;
  const resultBoundary = (resultCenter + unitCenter) / 2;
  const unitBoundary = (unitCenter + refCenter) / 2;

  const sorted = positioned.sort((a, b) => (a.y + a.height / 2) - (b.y + b.height / 2));
  const typicalHeight = sorted.map(item => item.height).sort((a, b) => a - b)[Math.floor(sorted.length / 2)] || imageHeight * 0.02;
  const rowTolerance = Math.max(typicalHeight * 0.65, imageHeight * 0.006);
  const groups: OcrPositionedLine[][] = [];
  for (const item of sorted) {
    const center = item.y + item.height / 2;
    let target = groups.find(group => {
      const centers = group.map(line => line.y + line.height / 2);
      const avg = centers.reduce((sum, value) => sum + value, 0) / centers.length;
      return Math.abs(center - avg) <= Math.max(rowTolerance, Math.min(item.height, group[0].height) * 0.45);
    });
    if (!target) { target = []; groups.push(target); }
    target.push(item);
  }

  const output: string[] = [];
  for (const group of groups) {
    const cells = ["", "", "", ""];
    for (const item of group.sort((a, b) => a.x - b.x)) {
      const xCenter = (item.x + item.width / 2) / imageWidth;
      const column = xCenter < testBoundary ? 0 : xCenter < resultBoundary ? 1 : xCenter < unitBoundary ? 2 : 3;
      cells[column] = (cells[column] + " " + item.text).trim();
    }
    // If geometry doesn't reveal separate cells, retain the row for manual
    // review rather than inventing column assignments.
    if (!cells[0] || !cells[1]) {
      const fallback = group.map(item => item.text).join(" | ").trim();
      if (fallback) output.push(fallback);
      continue;
    }
    const row = [cells[0], cells[1], cells[2], cells[3]].filter(Boolean).join(" | ");
    if (row && !/^(?:test(?:\s*name)?|investigation|parameter|result|units?|reference(?:\s*range)?|normal\s*range)\b/i.test(row)) {
      output.push(row);
    }
  }
  return output.join("\n");
}

export async function recognizeLabText(uri: string): Promise<{ text: string; structuredText: string }> {
  const result = await recognizeText(uri);
  const text = String(result?.text || "");
  let structuredText = "";
  try {
    const size = await imageSize(uri);
    structuredText = structureLabColumns((result as any)?.blocks || [], size.width, size.height);
  } catch {
    // Raw on-device OCR text remains available if image geometry is unavailable.
  }
  return { text, structuredText };
}
