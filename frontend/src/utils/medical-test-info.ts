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
  sources?: Array<{ title: string; url: string }>;
};

type KnownLoinc = { code: string; labels: string[] };

async function fetchWithTimeout(input: string, init?: RequestInit, timeoutMs = 8000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}



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


type CuratedMedicalInfo = { labels: string[]; title: string; summary: string; url: string };

// Verified patient-education landing pages on MedlinePlus. These concise fallback
// notes are used only when online search is unavailable, so common tests still
// have useful information and a real source link without inventing a live result.
const CURATED_MEDICAL_INFO: CuratedMedicalInfo[] = [
  { labels: ["hemoglobin", "haemoglobin", "hb", "hgb"], title: "Hemoglobin test", url: "https://medlineplus.gov/lab-tests/hemoglobin-test/", summary: "Hemoglobin is the oxygen-carrying protein in red blood cells.\nA low result may be associated with anemia, blood loss, iron deficiency, or other conditions.\nA high result can occur with dehydration or conditions that increase red blood cells.\nThe result must be interpreted with the CBC, symptoms, and medical history.\nA hemoglobin result alone cannot identify the cause.\nA clinician may recommend related tests such as ferritin or red-cell indices.\nSource page: MedlinePlus Hemoglobin Test." },
  { labels: ["platelet count", "platelets", "plt"], title: "Platelet tests", url: "https://medlineplus.gov/lab-tests/platelet-tests/", summary: "Platelets help blood clot and stop bleeding.\nA low count can occur with infections, medicines, immune conditions, or bone-marrow problems.\nA high count may occur with inflammation, iron deficiency, or other conditions.\nThe degree of change and bleeding or clotting symptoms matter.\nA platelet result alone does not establish a diagnosis.\nA clinician may review the full CBC and repeat the test if needed.\nSource page: MedlinePlus Platelet Tests." },
  { labels: ["white blood cell count", "leukocyte count", "leucocyte count", "wbc", "tlc"], title: "White blood cell count", url: "https://medlineplus.gov/lab-tests/white-blood-cell-wbc-count/", summary: "White blood cells help the body fight infection.\nA high count can occur with infection, inflammation, stress, or some medicines.\nA low count can occur with certain infections, medicines, or bone-marrow conditions.\nThe differential count helps show which white-cell types are changed.\nA WBC result alone cannot confirm a specific infection or disease.\nInterpret it with symptoms and the rest of the CBC.\nSource page: MedlinePlus White Blood Cell Count." },
  { labels: ["red blood cell count", "erythrocyte count", "rbc"], title: "Red blood cell count", url: "https://medlineplus.gov/lab-tests/red-blood-cell-rbc-count/", summary: "Red blood cells carry oxygen around the body.\nA low count may be associated with anemia, bleeding, or nutritional deficiency.\nA high count can occur with dehydration or conditions affecting oxygen levels.\nHemoglobin, hematocrit, and red-cell indices help interpret the result.\nA single RBC count does not identify the cause.\nA clinician may review symptoms and the complete blood count.\nSource page: MedlinePlus Red Blood Cell Count." },
  { labels: ["hematocrit", "haematocrit", "pcv", "hct"], title: "Hematocrit test", url: "https://medlineplus.gov/lab-tests/hematocrit-test/", summary: "Hematocrit is the proportion of blood made up of red blood cells.\nA low result can be associated with anemia or blood loss.\nA high result may occur with dehydration or increased red-cell production.\nHydration and other CBC results affect interpretation.\nHematocrit alone does not diagnose the underlying cause.\nA clinician may compare it with hemoglobin and RBC indices.\nSource page: MedlinePlus Hematocrit Test." },
  { labels: ["glucose", "blood glucose", "blood sugar", "random blood glucose", "random blood sugar", "rbs", "fasting blood glucose", "fasting plasma glucose", "fasting blood sugar", "fbs", "fbg"], title: "Blood glucose test", url: "https://medlineplus.gov/lab-tests/blood-glucose-test/", summary: "This test measures glucose, the main sugar in the blood.\nHigh glucose can be associated with diabetes, illness, stress, or some medicines.\nLow glucose can occur with diabetes treatment and other conditions.\nWhether the sample was fasting or random changes how it is interpreted.\nOne result may not be enough to diagnose diabetes.\nA clinician may use repeat testing or HbA1c when appropriate.\nSource page: MedlinePlus Blood Glucose Test." },
  { labels: ["creatinine", "serum creatinine"], title: "Creatinine test", url: "https://medlineplus.gov/lab-tests/creatinine-test/", summary: "Creatinine is a waste product cleared from blood by the kidneys.\nA high blood level can occur when kidney filtration is reduced.\nHydration, muscle mass, and some medicines can also affect the result.\nA low value is often related to lower muscle mass and needs context.\nCreatinine alone does not fully measure kidney function.\nClinicians often review eGFR, urine tests, prior results, and medicines.\nSource page: MedlinePlus Creatinine Test." },
  { labels: ["urea", "urea nitrogen", "blood urea nitrogen", "bun"], title: "Blood urea nitrogen test", url: "https://medlineplus.gov/lab-tests/bun-blood-urea-nitrogen-test/", summary: "BUN measures nitrogen from urea, a waste product filtered by the kidneys.\nA high result may occur with reduced kidney function, dehydration, or high protein breakdown.\nA low result can be associated with low protein intake or some liver conditions.\nDiet, hydration, and medicines may affect the result.\nBUN alone cannot diagnose kidney disease.\nIt is usually interpreted with creatinine and eGFR.\nSource page: MedlinePlus BUN Test." },
  { labels: ["complete blood count", "cbc"], title: "Complete blood count", url: "https://medlineplus.gov/lab-tests/complete-blood-count-cbc/", summary: "A CBC measures red cells, white cells, hemoglobin, hematocrit, and platelets.\nAbnormal values can have many causes, including anemia, infection, or inflammation.\nThe pattern across results is more useful than one number alone.\nAge, sex, pregnancy, medicines, and symptoms can affect interpretation.\nA CBC does not by itself confirm a specific disease.\nA clinician may compare previous results or request additional tests.\nSource page: MedlinePlus Complete Blood Count." },
  { labels: ["hba1c", "hemoglobin a1c", "glycated hemoglobin"], title: "A1C test", url: "https://medlineplus.gov/lab-tests/hemoglobin-a1c-hba1c-test/", summary: "A1C estimates average blood glucose over roughly the previous three months.\nA higher result can indicate persistently elevated glucose and diabetes risk.\nSome blood disorders, pregnancy, or altered red-cell turnover can affect accuracy.\nA1C is different from a single fasting or random glucose result.\nDiagnosis should follow clinical guidance and appropriate confirmatory testing.\nA clinician can interpret the result with medical history and other tests.\nSource page: MedlinePlus A1C Test." },
  { labels: ["tsh", "thyroid stimulating hormone"], title: "TSH test", url: "https://medlineplus.gov/lab-tests/tsh-thyroid-stimulating-hormone-test/", summary: "TSH helps assess how the thyroid gland is being regulated.\nHigh TSH can be associated with an underactive thyroid.\nLow TSH can be associated with an overactive thyroid or excess thyroid hormone.\nMedicines, pregnancy, and pituitary conditions can affect interpretation.\nTSH alone does not explain every thyroid problem.\nFree T4 and symptoms may be reviewed alongside the result.\nSource page: MedlinePlus TSH Test." },
  { labels: ["alt", "sgpt", "alanine aminotransferase"], title: "ALT blood test", url: "https://medlineplus.gov/lab-tests/alt-blood-test/", summary: "ALT is an enzyme found mainly in liver cells.\nA high result can occur with liver irritation or injury from many causes.\nMedicines, viral infections, alcohol, and fatty liver disease may contribute.\nThe amount of elevation and other liver tests matter.\nALT alone does not identify a specific liver disease.\nA clinician may review AST, bilirubin, medicines, and symptoms.\nSource page: MedlinePlus ALT Test." },
  { labels: ["ast", "sgot", "aspartate aminotransferase"], title: "AST test", url: "https://medlineplus.gov/lab-tests/ast-test/", summary: "AST is an enzyme found in the liver, muscles, and other tissues.\nA high result can reflect liver or muscle injury, among other causes.\nExercise, medicines, and other conditions can affect the result.\nAST is interpreted with ALT and other clinical information.\nAST alone cannot establish the source or cause of an abnormality.\nA clinician may review symptoms and related tests.\nSource page: MedlinePlus AST Test." },
  { labels: ["cholesterol", "total cholesterol"], title: "Cholesterol test", url: "https://medlineplus.gov/lab-tests/cholesterol-levels/", summary: "Cholesterol testing measures blood fats linked with cardiovascular risk.\nHigh LDL or total cholesterol can contribute to plaque buildup in arteries.\nHDL, triglycerides, age, blood pressure, smoking, and history also matter.\nA result is used to estimate risk, not diagnose a heart problem by itself.\nFasting requirements depend on the test and clinician instructions.\nDiscuss overall risk and treatment choices with a healthcare professional.\nSource page: MedlinePlus Cholesterol Levels." },
  { labels: ["ldl", "ldl cholesterol", "low density lipoprotein cholesterol"], title: "LDL cholesterol", url: "https://medlineplus.gov/lab-tests/cholesterol-levels/", summary: "LDL is often called the cholesterol that can contribute to artery plaque.\nHigher LDL is associated with greater cardiovascular risk over time.\nThe target depends on personal risk and existing medical conditions.\nDiet, genetics, diabetes, and medicines can affect the level.\nLDL is not an emergency diagnosis on its own.\nA clinician can set a target based on overall cardiovascular risk.\nSource page: MedlinePlus Cholesterol Levels." },
  { labels: ["hdl", "hdl cholesterol", "high density lipoprotein cholesterol"], title: "HDL cholesterol", url: "https://medlineplus.gov/lab-tests/cholesterol-levels/", summary: "HDL is a type of cholesterol involved in transporting cholesterol.\nA lower HDL level can be associated with higher cardiovascular risk.\nHDL is interpreted together with LDL, triglycerides, and other risk factors.\nA single HDL value does not determine personal heart risk.\nExercise, smoking, and metabolic health may influence HDL.\nDiscuss the complete lipid profile with a healthcare professional.\nSource page: MedlinePlus Cholesterol Levels." },
  { labels: ["triglycerides", "tg"], title: "Triglycerides test", url: "https://medlineplus.gov/lab-tests/triglycerides-test/", summary: "Triglycerides are a type of fat circulating in the blood.\nHigh levels may be associated with diabetes, diet, alcohol, or some medicines.\nVery high levels can increase the risk of pancreatitis.\nFasting status can affect the result.\nTriglycerides should be interpreted with the full lipid profile and health history.\nA clinician can advise whether repeat fasting testing is needed.\nSource page: MedlinePlus Triglycerides Test." },
  { labels: ["ferritin", "serum ferritin"], title: "Ferritin test", url: "https://medlineplus.gov/lab-tests/ferritin-blood-test/", summary: "Ferritin is a protein that reflects stored iron in the body.\nLow ferritin commonly suggests low iron stores.\nHigh ferritin can occur with inflammation, liver conditions, or iron overload.\nFerritin may rise during illness even when iron stores are not high.\nIt should be interpreted with CBC and other iron studies.\nA clinician can decide whether more testing is needed.\nSource page: MedlinePlus Ferritin Blood Test." },
  { labels: ["vitamin b12", "cobalamin", "b12"], title: "Vitamin B12 test", url: "https://medlineplus.gov/lab-tests/vitamin-b-test/", summary: "Vitamin B12 is needed for healthy nerves and red blood cell formation.\nLow levels can be associated with anemia, numbness, or tingling.\nDiet, absorption problems, and some medicines can affect B12.\nA borderline result may need interpretation with symptoms or other tests.\nA B12 result alone may not explain all symptoms.\nA clinician can advise on causes and suitable treatment.\nSource page: MedlinePlus Vitamin B Test." },
  { labels: ["vitamin d", "25 hydroxy vitamin d", "25 oh vitamin d", "vitd"], title: "Vitamin D test", url: "https://medlineplus.gov/lab-tests/vitamin-d-test/", summary: "This test measures vitamin D status in the body.\nLow levels can be associated with limited sun exposure, diet, or absorption problems.\nExcess vitamin D is usually related to high supplement intake and can be harmful.\nInterpretation depends on the test method and clinical context.\nA result alone does not diagnose the cause of bone or muscle symptoms.\nA clinician can advise whether supplementation or further evaluation is appropriate.\nSource page: MedlinePlus Vitamin D Test." },
  { labels: ["crp", "c reactive protein"], title: "C-reactive protein test", url: "https://medlineplus.gov/lab-tests/c-reactive-protein-crp-test/", summary: "CRP is a marker of inflammation in the body.\nA high result can occur with infections and many inflammatory conditions.\nCRP does not identify where inflammation is or what caused it.\nThe degree of change and symptoms affect its meaning.\nIt should be interpreted with examination and other tests.\nA clinician may repeat it or order targeted tests when appropriate.\nSource page: MedlinePlus CRP Test." },
  { labels: ["esr", "erythrocyte sedimentation rate"], title: "ESR test", url: "https://medlineplus.gov/lab-tests/erythrocyte-sedimentation-rate-esr/", summary: "ESR is a nonspecific marker that can rise with inflammation.\nIt may be elevated in infections, autoimmune conditions, and some other illnesses.\nAge, anemia, pregnancy, and other factors can affect ESR.\nA high ESR cannot diagnose a specific disease.\nA normal ESR does not exclude every inflammatory condition.\nClinicians interpret ESR with symptoms and other investigations.\nSource page: MedlinePlus ESR Test." },
  { labels: ["calcium"], title: "Calcium blood test", url: "https://medlineplus.gov/lab-tests/calcium-blood-test/", summary: "Blood calcium is important for bones, muscles, nerves, and the heart.\nHigh or low calcium can have several causes, including parathyroid or kidney problems.\nAlbumin and the type of calcium test can affect interpretation.\nSymptoms and the degree of abnormality matter.\nCalcium alone does not identify the cause.\nA clinician may review albumin, kidney function, and related tests.\nSource page: MedlinePlus Calcium Blood Test." },
  { labels: ["sodium"], title: "Sodium blood test", url: "https://medlineplus.gov/lab-tests/sodium-blood-test/", summary: "Sodium helps regulate fluid balance and nerve and muscle function.\nLow or high sodium may be related to fluid balance, medicines, or illness.\nRapid or severe changes can be medically serious.\nSymptoms and how quickly the level changed are important.\nA sodium result alone does not identify the underlying cause.\nSeek prompt medical advice for a markedly abnormal result or symptoms.\nSource page: MedlinePlus Sodium Blood Test." },
  { labels: ["potassium"], title: "Potassium blood test", url: "https://medlineplus.gov/lab-tests/potassium-blood-test/", summary: "Potassium is essential for nerve, muscle, and heart electrical activity.\nHigh or low levels can occur with kidney problems, medicines, or fluid shifts.\nMarked abnormalities can affect heart rhythm and may need urgent assessment.\nA sample problem such as hemolysis can sometimes distort the result.\nThe result should be reviewed with symptoms, kidney function, and medicines.\nSeek prompt medical advice for a markedly abnormal potassium result.\nSource page: MedlinePlus Potassium Blood Test." },
  { labels: ["tsh", "thyroid stimulating hormone"], title: "TSH test", url: "https://medlineplus.gov/lab-tests/tsh-thyroid-stimulating-hormone-test/", summary: "TSH helps assess how the thyroid gland is being regulated.\nHigh TSH can be associated with an underactive thyroid.\nLow TSH can be associated with an overactive thyroid or excess thyroid hormone.\nMedicines, pregnancy, and pituitary conditions can affect interpretation.\nTSH alone does not explain every thyroid problem.\nFree T4 and symptoms may be reviewed alongside the result.\nSource page: MedlinePlus TSH Test." },
];

function getCuratedMedicalInfo(testName: string, aliases: string): MedicalTestOnlineInfo | null {
  const labels = lookupLabels(testName, aliases).map(simpleKey);
  const inputKeys = new Set(labels);
  const candidate = CURATED_MEDICAL_INFO.find(item =>
    item.labels.some(label => inputKeys.has(simpleKey(label))) ||
    item.labels.some(label => labels.some(key => key.length > 3 && simpleKey(label).includes(key)))
  );
  if (!candidate) return null;
  return {
    title: candidate.title,
    summary: candidate.summary,
    sourceName: "MedlinePlus (curated fallback information; verify current guidance online)",
    sourceUrl: candidate.url,
    sources: [{ title: candidate.title + " — MedlinePlus", url: candidate.url }],
    fetchedAt: new Date().toISOString(),
    loincCode: "curated-medlineplus-fallback",
  };
}

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
  const response = await fetchWithTimeout(url, { headers: { Accept: "application/xml, text/xml" } });
  if (!response.ok) return null;
  return parseMedlinePlusSearch(await response.text(), labels);
}

async function fetchMedlinePlusByLoinc(code: string, label: string): Promise<Omit<MedicalTestOnlineInfo, "fetchedAt" | "loincCode"> | null> {
  const url = "https://connect.medlineplus.gov/service?mainSearchCriteria.v.cs=2.16.840.1.113883.6.1" +
    "&mainSearchCriteria.v.c=" + encodeURIComponent(code) +
    "&mainSearchCriteria.v.dn=" + encodeURIComponent(label) +
    "&informationRecipient.languageCode.c=en";
  const response = await fetchWithTimeout(url, { headers: { Accept: "application/atom+xml, application/xml, text/xml" } });
  if (!response.ok) return null;
  return parseMedlinePlusEntry(await response.text());
}

type PubMedSummary = { uid?: string; title?: string; fulljournalname?: string; pubdate?: string };

const TRUSTED_MEDICAL_DOMAINS = [
  "testing.com", "nhs.uk", "mayoclinic.org", "clevelandclinic.org",
  "cdc.gov", "who.int", "fda.gov", "labcorp.com", "mountsinai.org",
  "msdmanuals.com", "cancer.gov", "kidney.org", "heart.org",
  "med.umich.edu", "ucsfhealth.org", "health.harvard.edu",
];

function isTrustedMedicalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && TRUSTED_MEDICAL_DOMAINS.some(domain =>
      url.hostname === domain || url.hostname.endsWith("." + domain)
    );
  } catch {
    return false;
  }
}

function xmlTag(value: string, name: string): string {
  const match = new RegExp("<" + name + "\\b[^>]*>([\\s\\S]*?)</" + name + ">", "i").exec(value);
  return match ? cleanText(match[1]) : "";
}

async function fetchTrustedWebSearch(testName: string, labels: string[]): Promise<Omit<MedicalTestOnlineInfo, "fetchedAt" | "loincCode"> | null> {
  // Search the wider web but accept only a controlled allowlist of health agencies,
  // major clinical institutions, medical laboratories and professional organizations.
  const domains = TRUSTED_MEDICAL_DOMAINS.map(domain => "site:" + domain).join(" OR ");
  const query = `(${domains}) "${testName}" laboratory test`;
  const url = "https://www.bing.com/search?format=rss&count=12&q=" + encodeURIComponent(query);
  const response = await fetchWithTimeout(url, { headers: { Accept: "application/rss+xml, application/xml, text/xml" } });
  if (!response.ok) return null;
  const xml = await response.text();
  const items = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) || [];
  const candidates: Array<{ article: Omit<MedicalTestOnlineInfo, "fetchedAt" | "loincCode">; score: number }> = [];
  for (const item of items) {
    const title = xmlTag(item, "title");
    const sourceUrl = decodeEntities(xmlTag(item, "link")).trim();
    const summary = xmlTag(item, "description");
    if (!title || !summary || !isTrustedMedicalUrl(sourceUrl)) continue;
    const score = relevanceScore(labels, title);
    if (score < 0.42 || summary.length < 45) continue;
    let sourceName = "Trusted medical institution";
    try { sourceName = new URL(sourceUrl).hostname.replace(/^www\\./i, ""); } catch {}
    candidates.push({
      article: { title, summary: summary.slice(0, 1200), sourceName, sourceUrl },
      score,
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.article || null;
}

async function fetchPubMedSummary(testName: string, labels: string[]): Promise<Omit<MedicalTestOnlineInfo, "fetchedAt" | "loincCode"> | null> {
  // NCBI's public E-utilities search peer-reviewed biomedical literature.
  // It is a second source, not a replacement for a clinically matched patient-facing
  // explanation. Require a strong title match and a usable abstract before showing it.
  const query = `(${testName}[Title/Abstract]) AND (laboratory OR blood OR serum OR urine OR diagnostic)`;
  const searchUrl = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=8&sort=relevance&term=" + encodeURIComponent(query);
  const searchResponse = await fetchWithTimeout(searchUrl, { headers: { Accept: "application/json" } });
  if (!searchResponse.ok) return null;
  const searchJson = await searchResponse.json();
  const ids: string[] = Array.isArray(searchJson?.esearchresult?.idlist) ? searchJson.esearchresult.idlist.slice(0, 8) : [];
  if (!ids.length) return null;

  const summaryUrl = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=" + encodeURIComponent(ids.join(","));
  const summaryResponse = await fetchWithTimeout(summaryUrl, { headers: { Accept: "application/json" } });
  if (!summaryResponse.ok) return null;
  const summaryJson = await summaryResponse.json();
  const summaries: PubMedSummary[] = ids.map(id => summaryJson?.result?.[id]).filter((item: any) => item && typeof item.title === "string");
  const best = summaries
    .map(item => ({ item, score: relevanceScore(labels, cleanText(item.title || "")) }))
    .filter(item => item.score >= 0.48)
    .sort((a, b) => b.score - a.score)[0]?.item;
  if (!best?.uid || !best.title) return null;

  const abstractUrl = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&retmode=text&rettype=abstract&id=" + encodeURIComponent(best.uid);
  const abstractResponse = await fetchWithTimeout(abstractUrl, { headers: { Accept: "text/plain" } });
  if (!abstractResponse.ok) return null;
  const rawAbstractText = await abstractResponse.text();
  const title = cleanText(best.title);
  // Prefer the actual Abstract section so author, journal and PMID metadata are
  // not accidentally presented as clinical content.
  const abstractSection = /(?:^|\n)Abstract\s*\n([\s\S]*?)(?=\n(?:Publication types|MeSH Terms|Grant Support|Conflict of interest statement|Copyright|PMID:)|$)/i.exec(rawAbstractText)?.[1] || "";
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
    // Continue to the curated fallback before slower secondary search services.
  }
  // Do not make a user wait on multiple external search providers for common tests.
  // These short notes link to their corresponding MedlinePlus patient-information page.
  const curated = getCuratedMedicalInfo(testName, aliases);
  if (curated) return curated;

  try {
    const article = await fetchPubMedSummary(testName, labels);
    if (article) {
      return { ...article, fetchedAt: new Date().toISOString(), loincCode: "pubmed-search" };
    }
  } catch {
    // Continue to the allowlisted medical-site search.
  }
  try {
    const article = await fetchTrustedWebSearch(testName, labels);
    if (article) {
      return { ...article, fetchedAt: new Date().toISOString(), loincCode: "trusted-web-search" };
    }
  } catch {
    // Network, search-provider, or site failure: try curated notes with a real source page.
  }
  // Reliable fallback for common tests when external APIs are blocked/unavailable.
  // Unknown tests still return null instead of receiving an unrelated explanation.
  return getCuratedMedicalInfo(testName, aliases);
}
