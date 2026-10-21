/**
 * Online medical-test information lookup.
 *
 * Queries the US National Library of Medicine's public LOINC search service
 * and then MedlinePlus Connect. Only the test label is sent; patient identity,
 * report images, measured value, and reference ranges are never sent.
 */
export type MedicalTestOnlineInfo = {
  title: string;
  summary: string;
  sourceName: "MedlinePlus";
  sourceUrl: string;
  fetchedAt: string;
  loincCode: string;
};

type LoincCandidate = { code: string; label: string; score: number };

export const MEDICAL_INFO_CACHE_KEY = "ortho_lab_medical_info_cache_v1";
export const LAB_TEST_DEFINITIONS_KEY = "ortho_lab_test_definitions_v1";
const CACHE_FRESH_MS = 24 * 60 * 60 * 1000;
const GENERIC_TERMS = new Set([
  "test", "level", "blood", "serum", "plasma", "whole", "in", "of", "the",
  "and", "for", "by", "with", "from", "mass", "volume", "number", "count",
  "measurement", "qualitative", "quantitative", "total", "direct", "indirect",
  "calculated", "fraction", "presence", "amount", "concentration", "activity",
]);

const COMMON_LABELS: Record<string, string[]> = {
  hb: ["hemoglobin", "haemoglobin"],
  hgb: ["hemoglobin", "haemoglobin"],
  haemoglobin: ["hemoglobin"],
  hemoglobin: ["haemoglobin"],
  wbc: ["white blood cell count", "leukocyte count", "leucocyte count"],
  tlc: ["total leukocyte count", "white blood cell count", "leukocyte count"],
  leukocytes: ["leukocyte count", "white blood cell count"],
  leukocytescount: ["white blood cell count"],
  rbc: ["red blood cell count", "erythrocyte count"],
  plt: ["platelet count", "platelets"],
  platelets: ["platelet count"],
  sgpt: ["alanine aminotransferase", "ALT"],
  alt: ["alanine aminotransferase", "SGPT"],
  sgot: ["aspartate aminotransferase", "AST"],
  ast: ["aspartate aminotransferase", "SGOT"],
  alp: ["alkaline phosphatase"],
  tsh: ["thyroid stimulating hormone"],
  ft4: ["free thyroxine", "free T4"],
  t4: ["thyroxine"],
  t3: ["triiodothyronine"],
  esr: ["erythrocyte sedimentation rate"],
  crp: ["C reactive protein"],
  hba1c: ["hemoglobin A1c", "glycated hemoglobin"],
  bun: ["blood urea nitrogen"],
  urea: ["urea nitrogen"],
  creatinine: ["serum creatinine"],
  glucose: ["blood glucose", "blood sugar"],
  sodium: ["sodium measurement"],
  potassium: ["potassium measurement"],
  bilirubin: ["bilirubin total"],
  ggt: ["gamma glutamyl transferase"],
  ggtp: ["gamma glutamyl transferase"],
  amylase: ["amylase activity"],
  lipase: ["lipase activity"],
  pt: ["prothrombin time"],
  inr: ["international normalized ratio"],
  aptt: ["activated partial thromboplastin time"],
  hbsag: ["hepatitis B surface antigen"],
  hcv: ["hepatitis C antibody"],
  hiv: ["HIV antigen antibody test"],
};

export function medicalInfoCacheKey(testName: string): string {
  return String(testName || "").toLocaleLowerCase().trim().replace(/[^a-z0-9]+/g, " ").trim();
}

export function isMedicalTestInfoFresh(info?: MedicalTestOnlineInfo | null): boolean {
  if (!info?.summary || !info.fetchedAt) return false;
  const fetched = new Date(info.fetchedAt).getTime();
  return Number.isFinite(fetched) && Date.now() - fetched >= 0 && Date.now() - fetched < CACHE_FRESH_MS;
}

function cleanText(value: string): string {
  return decodeEntities(String(value || ""))
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(value: string): string {
  let text = value;
  for (let pass = 0; pass < 2; pass++) {
    text = text
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
  }
  return text;
}

function normalizeTokens(value: string): string[] {
  return String(value || "")
    .toLocaleLowerCase()
    .replace(/\b(?:hb|hgb)\b/g, " hemoglobin ")
    .replace(/\b(?:sgpt)\b/g, " alt ")
    .replace(/\b(?:sgot)\b/g, " ast ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(token => token.length > 1 && !GENERIC_TERMS.has(token));
}

function relevanceScore(testLabels: string[], candidateLabel: string): number {
  const candidateTokens = new Set(normalizeTokens(candidateLabel));
  if (!candidateTokens.size) return 0;
  let best = 0;
  for (const label of testLabels) {
    const targetTokens = new Set(normalizeTokens(label));
    if (!targetTokens.size) continue;
    let matched = 0;
    targetTokens.forEach(token => { if (candidateTokens.has(token)) matched++; });
    const precision = matched / targetTokens.size;
    const overlap = (2 * matched) / (targetTokens.size + candidateTokens.size);
    best = Math.max(best, precision * 0.75 + overlap * 0.25);
  }
  return best;
}

function lookupLabels(testName: string, aliases: string): string[] {
  const inputs = [testName, ...String(aliases || "").split(/[,;\n]+/)]
    .map(value => value.trim())
    .filter(value => value.length >= 2 && value.length <= 80);
  const all = [...inputs];
  for (const label of inputs) {
    const key = label.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
    all.push(...(COMMON_LABELS[key] || []));
  }
  const seen = new Set<string>();
  return all.filter(label => {
    const key = label.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}

async function fetchLoincCandidates(label: string): Promise<LoincCandidate[]> {
  const url = "https://clinicaltables.nlm.nih.gov/api/loinc_items/v3/search?type=question&terms=" +
    encodeURIComponent(label) + "&df=text&maxList=12";
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) return [];
  const data: any = await response.json();
  if (!Array.isArray(data) || !Array.isArray(data[1])) return [];
  const codes: string[] = data[1].map((code: unknown) => String(code || "")).filter(Boolean);
  const displayRows: any[] = Array.isArray(data[3]) ? data[3] : [];
  return codes.map((code, index) => {
    const row = displayRows[index];
    const display = Array.isArray(row) ? row.join(" ") : String(row || "");
    const candidateLabel = cleanText(display) || label;
    return { code, label: candidateLabel, score: relevanceScore([label], candidateLabel) };
  });
}

function firstTag(body: string, name: string): string {
  const escaped = name.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
  const match = new RegExp("<(?:[\\w.-]+:)?" + escaped + "\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?" + escaped + "\\s*>", "i").exec(body);
  return match ? cleanText(match[1]) : "";
}

function parseMedlinePlusEntry(xml: string): Omit<MedicalTestOnlineInfo, "fetchedAt" | "loincCode"> | null {
  const entries = xml.match(/<entry\b[^>]*>[\s\S]*?<\/entry>/gi) || [];
  for (const entry of entries) {
    const title = firstTag(entry, "title");
    const summary = firstTag(entry, "summary");
    const links = [...entry.matchAll(/<link\b([^>]+)>/gi)];
    let sourceUrl = "";
    for (const match of links) {
      const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(match[1])?.[1] || "";
      const decoded = decodeEntities(href);
      if (/^https:\/\/medlineplus\.gov\//i.test(decoded)) {
        sourceUrl = decoded;
        break;
      }
    }
    if (!title || !summary || !sourceUrl) continue;
    const compactSummary = summary.replace(/\s+/g, " ").trim().slice(0, 1100);
    if (compactSummary.length < 40) continue;
    return { title, summary: compactSummary, sourceName: "MedlinePlus", sourceUrl };
  }
  return null;
}

async function fetchMedlinePlusByLoinc(code: string, label: string): Promise<Omit<MedicalTestOnlineInfo, "fetchedAt" | "loincCode"> | null> {
  const url = "https://connect.medlineplus.gov/service?mainSearchCriteria.v.cs=2.16.840.1.113883.6.1" +
    "&mainSearchCriteria.v.c=" + encodeURIComponent(code) +
    "&mainSearchCriteria.v.dn=" + encodeURIComponent(label) +
    "&informationRecipient.languageCode.c=en";
  const response = await fetch(url, { headers: { Accept: "application/atom+xml, application/xml, text/xml" } });
  if (!response.ok) return null;
  const xml = await response.text();
  return parseMedlinePlusEntry(xml);
}

/**
 * Searches official US National Library of Medicine LOINC terminology, then
 * asks MedlinePlus Connect for content matched to the returned test code.
 * It never fabricates explanations when the source has no matching entry.
 */
export async function fetchTrustedMedicalTestInfo(testName: string, aliases = ""): Promise<MedicalTestOnlineInfo | null> {
  const labels = lookupLabels(testName, aliases);
  if (!labels.length) return null;

  const candidateMap = new Map<string, LoincCandidate>();
  // A few name variants improve recall for common local laboratory abbreviations
  // without uploading any patient data.
  const searchLabels = labels.slice(0, 4);
  const searchResults = await Promise.all(searchLabels.map(async label => {
    try { return await fetchLoincCandidates(label); } catch { return []; }
  }));
  searchResults.flat().forEach(candidate => {
    const score = Math.max(candidate.score, relevanceScore(labels, candidate.label));
    const prior = candidateMap.get(candidate.code);
    if (!prior || score > prior.score) candidateMap.set(candidate.code, { ...candidate, score });
  });

  const candidates = [...candidateMap.values()]
    .filter(candidate => candidate.score >= 0.25)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  for (const candidate of candidates) {
    try {
      const article = await fetchMedlinePlusByLoinc(candidate.code, candidate.label);
      if (!article) continue;
      // Reject a broad or mismatched result rather than attach an unrelated page.
      const titleScore = relevanceScore([...labels, candidate.label], article.title);
      if (titleScore < 0.2) continue;
      return {
        ...article,
        fetchedAt: new Date().toISOString(),
        loincCode: candidate.code,
      };
    } catch {
      // Try the next relevant code if one official lookup fails.
    }
  }
  return null;
}
