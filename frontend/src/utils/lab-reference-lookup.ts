/**
 * Privacy-safe online assistance for OCR-uncertain laboratory rows.
 * Only a short, non-identifying test label is sent to the US National Library
 * of Medicine's public Clinical Tables laboratory catalogue. Images, OCR
 * lines, numeric results, units, patient identifiers and report text are never sent.
 * The catalogue identifies test names; it does NOT provide a patient's reference
 * interval and must never be used to decide whether a result is abnormal.
 */
export async function lookupLabTestName(testName: string): Promise<string[]> {
  const safeName = testName
    .replace(/[^a-zA-Z0-9 +()./-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  if (safeName.length < 3) return [];
  try {
    const response = await fetch(
      "https://clinicaltables.nlm.nih.gov/api/labs/v3/search?terms=" +
        encodeURIComponent(safeName) + "&maxList=3",
      { headers: { Accept: "application/json" } },
    );
    if (!response.ok) return [];
    const data: unknown = await response.json();
    if (!Array.isArray(data) || !Array.isArray(data[1])) return [];
    return (data[1] as unknown[])
      .map(value => String(value ?? "").trim())
      .filter(Boolean)
      .slice(0, 3);
  } catch {
    // Offline, blocked or unavailable: local printed-range checking still works.
    return [];
  }
}
