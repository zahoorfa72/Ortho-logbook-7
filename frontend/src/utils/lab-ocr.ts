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
  severity: "WARNING" | "ALERT";
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
      if (index >= 0 && index <= 8) { const name = cleaned.slice(index, index + alias.length).trim(); return { name, end: index + alias.length, configured: configuredTestForName(name, configuredTests) }; }
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
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value || /\b(?:male|female|men|women|reference|normal|range|interval)\b/i.test(value)) return null;

  // F/M (including OCR forms iF/iM) may be a sex marker, not a unit.
  // Remove a trailing standalone marker while preserving the numeric result;
  // the patient's gender is used separately to select the reference range.
  const withoutSexMarker = value.replace(/(?:^|\\s)(?:i?[fm])\\s*$/i, "").trim();

  // A result cell should contain one measured scalar, optionally followed by
  // a unit or H/L flag. Never take the first number from a cell that also
  // contains a reference interval or multiple unrelated numbers: that was
  // causing the lower/upper reference limit to be reported as the result.
  if (INTERVAL_PATTERN.test(withoutSexMarker)) return null;
  const scalar = new RegExp("^\\s*([<>≤≥]?\\s*" + NUMBER_PATTERN + ")").exec(withoutSexMarker);
  if (!scalar) return null;
  const raw = scalar[1].replace(/[<>≤≥\s]/g, "");
  const remainder = withoutSexMarker.slice(scalar[0].length).trim();

  // Scientific lab units such as 5.2 x10^9/L contain a second number as part
  // of the unit. Remove that notation before checking for a second result.
  const remainderWithoutScientificUnit = remainder
    .replace(/[x×]\s*10\s*\^?\s*[-+]?\d+/gi, "")
    .replace(/\b(?:10\^?\d+)\b/gi, "")
    .trim();
  if (new RegExp(NUMBER_PATTERN).test(remainderWithoutScientificUnit)) return null;
  if (/^[.\-–—/]/.test(remainderWithoutScientificUnit)) return null;
  return raw;
}

function classifyDeviation(resultRaw: string, reference: ReferenceInterval, warningPercent = 10): ParsedLabRow["severity"] | null {
  const result = numericValue(resultRaw);
  if (!Number.isFinite(result)) return null;
  if (result >= reference.low && result <= reference.high) return null;
  const boundary = result < reference.low ? reference.low : reference.high;
  const excursionPercent = boundary === 0
    ? (result === boundary ? 0 : Number.POSITIVE_INFINITY)
    : Math.abs(result - boundary) / Math.abs(boundary) * 100;
  return excursionPercent <= Math.max(1, Math.min(100, warningPercent)) ? "WARNING" : "ALERT";
}

export function parseLabReportRows(text: string, configuredTests: LabTestDefinition[] = [], gender = "", warningPercent = 10): ParsedLabRow[] {
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

      const severity = classifyDeviation(resultRaw, reference, warningPercent);
      if (!severity) continue;
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
      ? payload.ParsedResults.map((item: any) => String(item?.ParsedText || "")).filter(Boolean).join("\\n").trim()
      : "";
  } catch {
    // Network, service, or API-key errors fall back to offline OCR silently.
    return "";
  }
}

export async function recognizeLabText(uri: string, onlineApiKey = ""): Promise<{ text: string; structuredText: string; mode: "online" | "offline" }> {
  // Run on-device OCR on the original and, for small/blurry-looking captures,
  // an enlarged high-quality copy. Upscaling cannot restore lost detail, but
  // often helps OCR read small printed digits without sending data online.
  let best: any = null;
  let bestSize: { width: number; height: number } | null = null;
  try {
    const originalSize = await imageSize(uri);
    bestSize = originalSize;
    best = await recognizeText(uri);
    const maxDimension = Math.max(originalSize.width, originalSize.height);
    if (maxDimension < 2200) {
      const scale = Math.min(2, 2200 / Math.max(1, maxDimension));
      const enhanced = await ImageManipulator.manipulateAsync(
        uri,
        [{ resize: originalSize.width >= originalSize.height ? { width: Math.round(originalSize.width * scale) } : { height: Math.round(originalSize.height * scale) } }],
        { compress: 1, format: ImageManipulator.SaveFormat.PNG },
      );
      try {
        const second = await recognizeText(enhanced.uri);
        const score = (value: any) => {
          const text = String(value?.text || "");
          return text.length + (text.match(/\\d+(?:[.,]\\d+)?/g) || []).length * 8 +
            (text.match(/\\b(?:result|reference|range|hemoglobin|platelets|glucose|creatinine)\\b/gi) || []).length * 12;
        };
        if (score(second) > score(best)) {
          best = second;
          bestSize = { width: Math.round(originalSize.width * scale), height: Math.round(originalSize.height * scale) };
        }
      } catch {}
      try { await FileSystem.deleteAsync(enhanced.uri, { idempotent: true }); } catch {}
    }
  } catch {
    best = await recognizeText(uri);
  }
  let text = String(best?.text || "");
  let mode: "online" | "offline" = "offline";
  // Optional cloud OCR is attempted only when the admin explicitly saves a key.
  // If it is unavailable or returns less readable text, retain the offline result.
  const onlineText = await recognizeOnlineLabText(uri, onlineApiKey);
  const qualityScore = (value: string) => value.length +
    (value.match(/\\d+(?:[.,]\\d+)?/g) || []).length * 8 +
    (value.match(/\\b(?:result|reference|range|hemoglobin|platelets|glucose|creatinine)\\b/gi) || []).length * 12;
  if (onlineText && qualityScore(onlineText) > qualityScore(text)) {
    text = onlineText;
    mode = "online";
  }
  let structuredText = "";
  try {
    const size = bestSize || await imageSize(uri);
    structuredText = structureLabColumns(best?.blocks || [], size.width, size.height);
  } catch {
    // Raw on-device OCR text remains available if image geometry is unavailable.
  }
  return { text, structuredText: mode === "online" ? "" : structuredText, mode };
}
