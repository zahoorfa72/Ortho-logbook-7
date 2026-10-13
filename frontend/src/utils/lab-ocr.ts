import { recognizeText } from "expo-ocr-kit";

export type ParsedLabRow = {
  test: string; result: string; unit: string; reference: string;
  severity: "WARNING" | "ALERT"; sourceLine: string;
};

const TEST_NAME = /\b(?:haemoglobin|hemoglobin|hgb|hb|wbc|rbc|platelets?|cbc|complete blood count|glucose|fasting blood sugar|fbs|rbs|creatinine|urea|bilirubin|alt|ast|sgpt|sgot|alkaline phosphatase|alp|tsh|t3|t4|electrolytes?|sodium|potassium|chloride|calcium|uric acid|esr|crp|hba1c|cholesterol|triglycerides|urinalysis|urine routine|blood urea nitrogen|bun|hematocrit|haematocrit|mcv|mchc?|mpv|rdw|neutrophils?|lymphocytes?|eosinophils?|monocytes?|basophils?|hbsag|hcv antibody|hiv|uc)\b/i;

export function isLikelyLabReportText(text: string): boolean {
  const value = String(text || "").toLowerCase();
  const hits = [...value.matchAll(new RegExp(TEST_NAME.source, "gi"))].length;
  const structure = /\b(?:result|value|unit|units|reference|normal|range|high|low|positive|negative|test name)\b|[↑↓]/i.test(value);
  const numericCount = [...value.matchAll(/[-+]?\d+(?:[.,]\d+)?/g)].length;
  return hits >= 2 || (hits >= 1 && structure && numericCount >= 2);
}

const numericValue = (raw: string) => Number(raw.replace(",", "."));

export function parseLabReportRows(text: string): ParsedLabRow[] {
  const rows: ParsedLabRow[] = [];
  const seen = new Set<string>();
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line || line.length < 4 || !TEST_NAME.test(line)) continue;
    const intervals = [...line.matchAll(/([-+]?\d+(?:[.,]\d+)?)\s*(?:-|–|—|\bto\b)\s*([-+]?\d+(?:[.,]\d+)?)/gi)];
    if (!intervals.length) continue;
    const interval = intervals[intervals.length - 1];
    const intervalStart = interval.index ?? -1;
    if (intervalStart <= 0) continue;
    const values = [...line.slice(0, intervalStart).matchAll(/[-+]?\d+(?:[.,]\d+)?/g)];
    if (!values.length) continue;
    const resultMatch = values[0];
    const resultIndex = resultMatch.index ?? 0;
    const test = line.slice(0, resultIndex).replace(/^[\s:|•*-]+|[\s:|•*-]+$/g, "").trim();
    if (!test || !TEST_NAME.test(test)) continue;
    const result = numericValue(resultMatch[0]);
    const a = numericValue(interval[1]), b = numericValue(interval[2]);
    if (![result, a, b].every(Number.isFinite) || a === b) continue;
    const low = Math.min(a, b), high = Math.max(a, b);
    const allIntervals = intervals.map(match => ({
      low: Math.min(numericValue(match[1]), numericValue(match[2])),
      high: Math.max(numericValue(match[1]), numericValue(match[2])),
    }));
    if (allIntervals.some(range => result >= range.low && result <= range.high)) continue;
    if (result >= low && result <= high) continue;
    const width = Math.max(high - low, Math.abs((high + low) / 2) * 0.01, 0.000001);
    const distance = result < low ? low - result : result - high;
    const severity: ParsedLabRow["severity"] = distance / width >= 0.1 ? "ALERT" : "WARNING";
    const unit = line.slice(resultIndex + resultMatch[0].length, intervalStart)
      .replace(/[-+]?\d+(?:[.,]\d+)?/g, " ").replace(/[|:;]/g, " ").replace(/\s+/g, " ").trim();
    const reference = interval[1] + "–" + interval[2];
    const key = (test + "|" + resultMatch[0] + "|" + reference).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ test, result: resultMatch[0], unit: unit.slice(0, 18), reference, severity, sourceLine: line });
  }
  return rows;
}

export async function recognizeLabText(uri: string): Promise<{ text: string }> {
  const result = await recognizeText(uri);
  return { text: String(result?.text || "") };
}
