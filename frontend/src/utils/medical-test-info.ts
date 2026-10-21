/**
 * Trusted online medical-test information lookup.
 *
 * MedlinePlus Connect accepts a LOINC code for lab-test queries and returns an
 * attributed title, source URL and snippet. The app matches common local test
 * names to standard codes internally; no test setup or website entry is required.
 * Only the test name/aliases are used for matching. Patient identity, lab values,
 * reference ranges, report text and photos are never sent to online services.
 */
export type MedicalTestOnlineInfo = {
  title: string;
  summary: string;
  sourceName: string;
  sourceUrl: string;
  fetchedAt: string;
  loincCode: string;
};

type KnownLoinc = { code: string; labels: string[] };

export const MEDICAL_INFO_CACHE_KEY = "ortho_lab_medical_info_cache_v1";
export const LAB_TEST_DEFINITIONS_KEY = "ortho_lab_test_definitions_v1";
const CACHE_FRESH_MS = 24 * 60 * 60 * 1000;

const GENERIC_TERMS = new Set([
  "test", "level", "blood", "serum", "plasma", "whole", "in", "of", "the",
  "and", "for", "by", "with", "from", "mass", "volume", "number", "count",
  "measurement", "qualitative", "quantitative", "total", "direct", "indirect",
  "calculated", "fraction", "presence", "amount", "concentration", "activity",
]);

// Common hospital-report labels and abbreviations used to find standard test codes.
const COMMON_LABELS: Record<string, string[]> = {
  hb: ["hemoglobin", "haemoglobin"],
  hgb: ["hemoglobin", "haemoglobin"],
  haemoglobin: ["hemoglobin"],
  hemoglobin: ["haemoglobin"],
  wbc: ["white blood cell count", "leukocyte count", "leucocyte count"],
  tlc: ["total leukocyte count", "white blood cell count", "leukocyte count"],
  leukocytes: ["leukocyte count", "white blood cell count"],
  rbc: ["red blood cell count", "erythrocyte count"],
  plt: ["platelet count", "platelets"],
  platelets: ["platelet count"],
  pcv: ["hematocrit", "haematocrit"],
  hct: ["hematocrit", "haematocrit"],
  mcv: ["mean corpuscular volume"],
  mch: ["mean corpuscular hemoglobin"],
  mchc: ["mean corpuscular hemoglobin concentration"],
  rdw: ["red cell distribution width"],
  fbs: ["fasting blood glucose", "fasting plasma glucose", "fasting blood sugar"],
  fbg: ["fasting blood glucose", "fasting plasma glucose"],
  fastingbloodsugar: ["fasting blood glucose", "fasting plasma glucose"],
  rbs: ["random blood glucose", "random blood sugar"],
  randombloodsugar: ["random blood glucose"],
  ppbs: ["postprandial blood glucose", "postprandial blood sugar"],
  hba1c: ["hemoglobin A1c", "glycated hemoglobin"],
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
  bun: ["blood urea nitrogen"],
  urea: ["urea nitrogen"],
  creatinine: ["serum creatinine"],
  glucose: ["blood glucose", "blood sugar"],
  sodium: ["sodium measurement"],
  potassium: ["potassium measurement"],
  bilirubin: ["total bilirubin"],
  ggt: ["gamma glutamyl transferase"],
  ggtp: ["gamma glutamyl transferase"],
  cholesterol: ["total cholesterol"],
  ldl: ["LDL cholesterol", "low density lipoprotein cholesterol"],
  hdl: ["HDL cholesterol", "high density lipoprotein cholesterol"],
  tg: ["triglycerides"],
  chol: ["total cholesterol"],
  pt: ["prothrombin time"],
  inr: ["international normalized ratio"],
  aptt: ["activated partial thromboplastin time"],
  ptt: ["partial thromboplastin time"],
  hbsag: ["hepatitis B surface antigen"],
  hcv: ["hepatitis C antibody"],
  hiv: ["HIV antigen antibody test"],
  vitd: ["25 hydroxy vitamin D", "vitamin D"],
  vitaminb12: ["vitamin B12", "cobalamin"],
  b12: ["vitamin B12", "cobalamin"],
  ferritin: ["serum ferritin"],
  uricacid: ["uric acid"],
  cal: ["calcium"],
  ca: ["calcium"],
  mg: ["magnesium"],
  phosphate: ["phosphorus"],
  alb: ["albumin"],
  tp: ["total protein"],
  tropi: ["troponin I"],
};

// Standard LOINC codes commonly supported by MedlinePlus Connect for lab-test lookups.
// These codes are used only to query MedlinePlus; the returned explanation is always
// required to come from a matching MedlinePlus response.
const KNOWN_LAB_CODES: KnownLoinc[] = [
  { code: "718-7", labels: ["hemoglobin", "haemoglobin", "hb", "hgb"] },
  { code: "4544-3", labels: ["hematocrit", "haematocrit", "pcv", "hct"] },
  { code: "6690-2", labels: ["white blood cell count", "leukocyte count", "leucocyte count", "wbc", "tlc"] },
  { code: "789-8", labels: ["red blood cell count", "erythrocyte count", "rbc"] },
  { code: "777-3", labels: ["platelet count", "platelets", "plt"] },
  { code: "787-2", labels: ["mcv", "mean corpuscular volume"] },
  { code: "785-6", labels: ["mch", "mean corpuscular hemoglobin"] },
  { code: "786-4", labels: ["mchc", "mean corpuscular hemoglobin concentration"] },
  { code: "788-0", labels: ["rdw", "red cell distribution width"] },
  { code: "2345-7", labels: ["glucose", "blood glucose", "blood sugar", "random blood glucose", "random blood sugar", "rbs"] },
  { code: "1558-6", labels: ["fasting blood glucose", "fasting plasma glucose", "fasting blood sugar", "fbs", "fbg"] },
  { code: "2160-0", labels: ["creatinine", "serum creatinine"] },
  { code: "3094-0", labels: ["urea nitrogen", "blood urea nitrogen", "bun", "urea"] },
  { code: "2951-2", labels: ["sodium"] },
  { code: "2823-3", labels: ["potassium"] },
  { code: "2075-0", labels: ["chloride"] },
  { code: "2028-9", labels: ["bicarbonate", "carbon dioxide", "co2"] },
  { code: "1742-6", labels: ["alt", "sgpt", "alanine aminotransferase"] },
  { code: "1920-8", labels: ["ast", "sgot", "aspartate aminotransferase"] },
  { code: "6768-6", labels: ["alkaline phosphatase", "alp"] },
  { code: "1975-2", labels: ["total bilirubin", "bilirubin"] },
  { code: "1968-7", labels: ["direct bilirubin"] },
  { code: "1751-7", labels: ["albumin", "alb"] },
  { code: "2885-2", labels: ["total protein", "tp"] },
  { code: "17861-6", labels: ["calcium"] },
  { code: "2601-3", labels: ["magnesium", "mg"] },
  { code: "1988-5", labels: ["c reactive protein", "crp"] },
  { code: "4537-7", labels: ["erythrocyte sedimentation rate", "esr"] },
  { code: "3016-3", labels: ["tsh", "thyroid stimulating hormone"] },
  { code: "3024-7", labels: ["free thyroxine", "free t4", "ft4"] },
  { code: "4548-4", labels: ["hba1c", "hemoglobin a1c", "glycated hemoglobin"] },
  { code: "2093-3", labels: ["total cholesterol", "cholesterol", "chol"] },
  { code: "2085-9", labels: ["hdl cholesterol", "high density lipoprotein cholesterol", "hdl"] },
  { code: "18262-6", labels: ["ldl cholesterol", "low density lipoprotein cholesterol", "ldl"] },
  { code: "2571-8", labels: ["triglycerides", "tg"] },
  { code: "5902-2", labels: ["prothrombin time", "pt"] },
  { code: "6301-6", labels: ["international normalized ratio", "inr"] },
  { code: "14979-9", labels: ["activated partial thromboplastin time", "aptt"] },
  { code: "2498-4", labels: ["iron", "serum iron"] },
  { code: "2276-4", labels: ["ferritin", "serum ferritin"] },
  { code: "2132-9", labels: ["vitamin b12", "cobalamin", "b12"] },
  { code: "2284-8", labels: ["folate", "folic acid"] },
  { code: "1989-3", labels: ["vitamin d", "25 hydroxy vitamin d", "25 oh vitamin d"] },
  { code: "3084-1", labels: ["uric acid"] },
  { code: "1798-8", labels: ["amylase"] },
  { code: "3040-3", labels: ["lipase"] },
  { code: "10839-9", labels: ["troponin i", "tropi"] },
];

export function medicalInfoCacheKey(testName: string): string {
  return String(testName || "").toLocaleLowerCase().trim().replace(/[^a-z0-9]+/g, " ").trim();
}

export function isMedicalTestInfoFresh(info?: MedicalTestOnlineInfo | null): boolean {
  if (!info?.summary || !info.fetchedAt) return false;
  const fetched = new Date(info.fetchedAt).getTime();
  const age = Date.now() - fetched;
  return Number.isFinite(fetched) && age >= 0 && age < CACHE_FRESH_MS;
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

function cleanText(value: string): string {
  return decodeEntities(String(value || ""))
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function simpleKey(value: string): string {
  return String(value || "").toLocaleLowerCase().replace(/[^a-z0-9]+/g, "");
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
  const all: string[] = [];
  for (const label of inputs) {
    all.push(label);
    const synonyms = COMMON_LABELS[simpleKey(label)] || [];
    all.push(...synonyms);
  }
  const seen = new Set<string>();
  return all.filter(label => {
    const key = simpleKey(label);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 24);
}

function findKnownLoincCandidates(labels: string[]): KnownLoinc[] {
  const scored = KNOWN_LAB_CODES.map(item => ({
    item,
    score: Math.max(...item.labels.map(alias => relevanceScore(labels, alias))),
  }));
  // Require a strong match to an abbreviation/name, so a generic shared word
  // such as "blood" can never select the wrong laboratory test.
  return scored.filter(item => item.score >= 0.94)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(item => item.item);
}

function firstTag(body: string, name: string): string {
  const match = new RegExp("<(?:[\\w.-]+:)?" + name + "\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?" + name + "\\s*>", "i").exec(body);
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


function contentTag(document: string, contentName: string): string {
  const expression = new RegExp("<content\\b(?=[^>]*\\bname\\s*=\\s*[\"']" + contentName + "[\"'])[^>]*>([\\s\\S]*?)<\\/content>", "i");
  const match = expression.exec(document);
  return match ? cleanText(match[1]) : "";
}

function parseMedlinePlusSearch(xml: string, requestedLabels: string[]): Omit<MedicalTestOnlineInfo, "fetchedAt" | "loincCode"> | null {
  const documents = xml.match(/<document\b[^>]*>[\s\S]*?<\/document>/gi) || [];
  const candidates: Array<{ article: Omit<MedicalTestOnlineInfo, "fetchedAt" | "loincCode">; score: number }> = [];
  for (const document of documents) {
    const urlMatch = /\burl\s*=\s*["']([^"']+)["']/i.exec(document);
    const sourceUrl = urlMatch ? decodeEntities(urlMatch[1]).split(/[?#]/)[0] : "";
    // Only use a real MedlinePlus lab-test page; reject general pages that merely
    // happen to mention a similar word, to avoid attaching unrelated information.
    if (!/^https:\/\/medlineplus\.gov\/lab-tests\/[a-z0-9-]+\/?$/i.test(sourceUrl)) continue;
    const title = contentTag(document, "title");
    const summary = contentTag(document, "snippet") || contentTag(document, "full-summary") || contentTag(document, "description");
    if (!title || summary.length < 35) continue;
    const score = relevanceScore(requestedLabels, title);
    if (score < 0.42) continue;
    candidates.push({
      article: { title, summary: summary.slice(0, 1100), sourceName: "MedlinePlus", sourceUrl },
      score,
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.article || null;
}

async function fetchMedlinePlusSearch(testName: string, labels: string[]): Promise<Omit<MedicalTestOnlineInfo, "fetchedAt" | "loincCode"> | null> {
  const query = [testName, "lab test"].filter(Boolean).join(" ");
  const url = "https://wsearch.nlm.nih.gov/ws/query?db=healthTopics&term=" +
    encodeURIComponent(query) + "&rettype=brief&retmax=8";
  const response = await fetch(url, { headers: { Accept: "application/xml, text/xml" } });
  if (!response.ok) return null;
  return parseMedlinePlusSearch(await response.text(), labels);
}

async function fetchMedlinePlusByLoinc(code: string, label: string): Promise<Omit<MedicalTestOnlineInfo, "fetchedAt" | "loincCode"> | null> {
  const url = "https://connect.medlineplus.gov/service?mainSearchCriteria.v.cs=2.16.840.1.113883.6.1" +
    "&mainSearchCriteria.v.c=" + encodeURIComponent(code) +
    "&mainSearchCriteria.v.dn=" + encodeURIComponent(label) +
    "&informationRecipient.languageCode.c=en";
  const response = await fetch(url, { headers: { Accept: "application/atom+xml, application/xml, text/xml" } });
  if (!response.ok) return null;
  return parseMedlinePlusEntry(await response.text());
}

type PubMedSummary = { uid?: string; title?: string; fulljournalname?: string; pubdate?: string };

async function fetchPubMedSummary(testName: string, labels: string[]): Promise<Omit<MedicalTestOnlineInfo, "fetchedAt" | "loincCode"> | null> {
  // NCBI's public E-utilities search peer-reviewed biomedical literature.
  // It is a second source, not a replacement for a clinically matched patient-facing
  // explanation. Require a strong title match and a usable abstract before showing it.
  const query = `(${testName}[Title/Abstract]) AND (laboratory OR blood OR serum OR urine OR diagnostic)`;
  const searchUrl = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=8&sort=relevance&term=" + encodeURIComponent(query);
  const searchResponse = await fetch(searchUrl, { headers: { Accept: "application/json" } });
  if (!searchResponse.ok) return null;
  const searchJson = await searchResponse.json();
  const ids: string[] = Array.isArray(searchJson?.esearchresult?.idlist) ? searchJson.esearchresult.idlist.slice(0, 8) : [];
  if (!ids.length) return null;

  const summaryUrl = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=" + encodeURIComponent(ids.join(","));
  const summaryResponse = await fetch(summaryUrl, { headers: { Accept: "application/json" } });
  if (!summaryResponse.ok) return null;
  const summaryJson = await summaryResponse.json();
  const summaries: PubMedSummary[] = ids.map(id => summaryJson?.result?.[id]).filter((item: any) => item && typeof item.title === "string");
  const best = summaries
    .map(item => ({ item, score: relevanceScore(labels, cleanText(item.title || "")) }))
    .filter(item => item.score >= 0.48)
    .sort((a, b) => b.score - a.score)[0]?.item;
  if (!best?.uid || !best.title) return null;

  const abstractUrl = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&retmode=text&rettype=abstract&id=" + encodeURIComponent(best.uid);
  const abstractResponse = await fetch(abstractUrl, { headers: { Accept: "text/plain" } });
  if (!abstractResponse.ok) return null;
  const rawAbstractText = await abstractResponse.text();
  const title = cleanText(best.title);
  // Prefer the actual Abstract section so author, journal and PMID metadata are
  // not accidentally presented as clinical content.
  const abstractSection = /(?:^|\\n)Abstract\\s*\\n([\\s\\S]*?)(?=\\n(?:Publication types|MeSH Terms|Grant Support|Conflict of interest statement|Copyright|PMID:)|$)/i.exec(rawAbstractText)?.[1] || "";
  let abstract = cleanText(abstractSection);
  if (!abstract) {
    const plain = cleanText(rawAbstractText);
    const titleIndex = plain.toLowerCase().indexOf(title.toLowerCase());
    abstract = titleIndex >= 0 ? plain.slice(titleIndex + title.length).replace(/^(?:authors?|abstract|pmid|doi)\\s*:?\\s*/i, "").trim() : plain;
  }
  // Reject a citation without a meaningful abstract rather than presenting it
  // as if it explained the test.
  if (abstract.length < 100) return null;
  return {
    title,
    summary: abstract.slice(0, 1500),
    sourceName: "PubMed / U.S. National Library of Medicine (peer-reviewed literature)",
    sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/" + best.uid + "/",
  };
}

/**
 * Finds a high-confidence standard code from built-in common lab aliases, then
 * retrieves the matched explanation from MedlinePlus Connect. When no exact
 * supported match exists it returns null rather than inventing medical details.
 */
export async function fetchTrustedMedicalTestInfo(testName: string, aliases = ""): Promise<MedicalTestOnlineInfo | null> {
  const labels = lookupLabels(testName, aliases);
  if (!labels.length) return null;
  const candidates = findKnownLoincCandidates(labels);
  for (const candidate of candidates) {
    try {
      const article = await fetchMedlinePlusByLoinc(candidate.code, candidate.labels[0] || testName);
      if (!article) continue;
      const titleScore = relevanceScore([...labels, ...candidate.labels], article.title);
      if (titleScore < 0.2) continue;
      return {
        ...article,
        fetchedAt: new Date().toISOString(),
        loincCode: candidate.code,
      };
    } catch {
      // A transient failure or missing official match falls through to search.
    }
  }
  // LOINC coverage is not complete for every hospital label. Search multiple
  // trusted sources: first MedlinePlus patient-facing lab-test pages, then NCBI
  // PubMed peer-reviewed literature. Each candidate must match the test label;
  // never send patient identity, result values, photos or reference ranges.
  try {
    const article = await fetchMedlinePlusSearch(testName, labels);
    if (article) {
      return { ...article, fetchedAt: new Date().toISOString(), loincCode: "medlineplus-search" };
    }
  } catch {
    // Continue to the second trusted source.
  }
  try {
    const article = await fetchPubMedSummary(testName, labels);
    if (article) {
      return { ...article, fetchedAt: new Date().toISOString(), loincCode: "pubmed-search" };
    }
  } catch {
    // Network or service failure: do not fabricate a summary.
  }
  return null;
}
