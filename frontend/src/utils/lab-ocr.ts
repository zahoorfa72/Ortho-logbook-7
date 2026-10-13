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

const TEST_EQUIVALENCE_GROUPS: string[][] = [
  ["hemoglobin", "haemoglobin", "hgb", "hb"],
  ["hematocrit", "haematocrit", "hct", "pcv"],
  ["white blood cell count", "wbc", "total leukocyte count", "tlc"],
  ["red blood cell count", "rbc", "erythrocyte count"],
  ["platelet count", "platelets", "plt"],
  ["fasting blood sugar", "fbs", "fasting glucose"],
  ["random blood sugar", "rbs", "random glucose"],
  ["alanine aminotransferase", "sgpt", "alt"],
  ["aspartate aminotransferase", "sgot", "ast"],
  ["alkaline phosphatase", "alp"],
  ["glycated hemoglobin", "glycosylated hemoglobin", "hba1c"],
  ["blood urea nitrogen", "bun"],
  ["triglycerides", "triglyceride"],
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
    if (match) { const name = cleaned.slice(0, match[0].length).trim(); return { name, end: match[0].length, configured: configuredTestForName(name, configuredTests) }; }
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
  const intervals: ReferenceInterval[] = [];
  const labelled = /\b(male|female|men|women|m|f)\b[\s():=]*(?:reference\s*)?([-+]?\d+(?:[.,]\d+)?)\s*(?:-|–|—|\bto\b)\s*([-+]?\d+(?:[.,]\d+)?)/gi;
  for (const match of text.matchAll(labelled)) {
    const label = /^(?:male|men|m)$/i.test(match[1]) ? "male" : "female";
    const a = numericValue(match[2]);
    const b = numericValue(match[3]);
    if (Number.isFinite(a) && Number.isFinite(b) && a !== b) {
      intervals.push({ low: Math.min(a, b), high: Math.max(a, b), text: match[2] + "–" + match[3], start: match.index ?? 0 });
      (intervals[intervals.length - 1] as any).sex = label;
    }
  }
  if (intervals.length) {
    const selected = sex ? intervals.find(item => (item as any).sex === sex) : undefined;
    return selected || null; // Ambiguous sex-specific ranges must not be guessed.
  }

  const matches = [...text.matchAll(new RegExp(NUMBER_PATTERN + "\\s*(?:-|–|—|\\bto\\b)\\s*" + NUMBER_PATTERN, "gi"))];
  if (matches.length !== 1) return null;
  const match = matches[0];
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
  if (!text || /\b(?:male|female|men|women|reference|normal|range|interval)\b/i.test(text)) return null;
  const match = new RegExp(NUMBER_PATTERN).exec(text);
  return match?.[0] ?? null;
}

function classifyDeviation(resultRaw: string, reference: ReferenceInterval): ParsedLabRow["severity"] | null {
  const result = numericValue(resultRaw);
  if (!Number.isFinite(result)) return null;
  if (result >= reference.low && result <= reference.high) return null;
  const excursion = result < reference.low ? reference.low - result : result - reference.high;
  const width = reference.high - reference.low;
  return excursion / width <= 0.1 ? "WARNING" : "ALERT";
}

export function parseLabReportRows(text: string, configuredTests: LabTestDefinition[] = [], gender = ""): ParsedLabRow[] {
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
    const useStructured = !!structuredSection.trim();
    const source = useStructured ? structuredSection : page;

    for (const rawLine of source.split(/\r?\n/)) {
      const line = rawLine.replace(/\s+/g, " ").trim();
      if (isNonResultLine(line, configuredTests)) continue;

      const cells = line.includes("|") ? line.split("|").map(cell => cell.trim()) : [];
      const structured = cells.length >= 3 ? findTestPrefix(cells[0], configuredTests) : null;
      let testPrefix: { name: string; end: number; configured?: LabTestDefinition } | null = structured || findTestPrefix(line, configuredTests);
      if (!testPrefix) continue;

      let resultRaw: string | null = null;
      let unit = "";
      let reference: ReferenceInterval | null = null;

      if (structured) {
        // The measured result must come from the result column only. If OCR
        // placed "M (Male)" or a reference interval in that cell, reject it
        // instead of mistaking a range limit for the patient's result.
        resultRaw = resultNumber(cells[1]);
        unit = cells[2] || testPrefix.configured?.unit || "";
        reference = extractReferenceInterval(cells.slice(3).join(" | "), gender);
      } else {
        const rest = line.slice(testPrefix.end).replace(/^\s*[:|\-]+\s*/, "");
        const referenceStart = firstReferenceStart(rest);
        const resultArea = referenceStart >= 0 ? rest.slice(0, referenceStart) : rest;
        resultRaw = resultNumber(resultArea);
        reference = referenceStart >= 0 ? extractReferenceInterval(rest.slice(referenceStart), gender) : null;
        const resultEnd = resultRaw ? resultArea.indexOf(resultRaw) + resultRaw.length : 0;
        unit = resultRaw ? resultArea.slice(resultEnd) : "";
      }

      // A saved sex-specific range is a fallback only when the report does not
      // provide an unambiguous applicable range and the patient's sex is known.
      if (!reference) reference = configuredReference(testPrefix.configured, gender);
      if (!resultRaw || !reference) continue;

      const severity = classifyDeviation(resultRaw, reference);
      if (!severity) continue;
      const result = numericValue(resultRaw);
      const cleanedUnit = unit
        .replace(/\b(?:result|value|ref|reference|range|normal|male|female)\b/gi, " ")
        .replace(/[0-9.,+\-–—:|;]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const key = (normaliseName(testPrefix.name) + "|" + result + "|" + reference.text).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        test: testPrefix.name,
        result: resultRaw,
        unit: (cleanedUnit || testPrefix.configured?.unit || "").slice(0, 24),
        reference: reference.text,
        severity,
        sourceLine: line,
      });
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
