import type { MedicalTestOnlineInfo } from "@/src/utils/medical-test-info";

/**
 * Optional AI-assisted medical education via the secured backend proxy.
 * Only the generic test name and aliases are sent; never pass patient values,
 * identifiers, reference ranges, images, or report text.
 */
export async function fetchAiMedicalTestInfo(
  testName: string,
  aliases = "",
): Promise<MedicalTestOnlineInfo | null> {
  const baseUrl = String(process.env.EXPO_PUBLIC_MEDICAL_INFO_API_URL || "").trim().replace(/\/+$/, "");
  const clientToken = String(process.env.EXPO_PUBLIC_MEDICAL_INFO_CLIENT_TOKEN || "").trim();
  const safeName = String(testName || "").trim().slice(0, 120);
  if (!baseUrl || !clientToken || safeName.length < 2 || !/^https:\/\//i.test(baseUrl)) return null;
  const response = await fetch(baseUrl + "/api/medical-test-info", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: "Bearer " + clientToken,
    },
    body: JSON.stringify({ test_name: safeName, aliases: String(aliases || "").slice(0, 300) }),
  });
  if (!response.ok) return null;
  const payload = await response.json();
  if (!payload || typeof payload.summary !== "string" || payload.summary.trim().length < 80) return null;
  const sources = Array.isArray(payload.sources)
    ? payload.sources.filter((item: any) => item && typeof item.title === "string" && typeof item.url === "string" && /^https:\/\//i.test(item.url)).slice(0, 8)
    : [];
  if (!sources.length) return null;
  return {
    title: String(payload.title || safeName + " — medical overview"),
    summary: payload.summary.slice(0, 5000),
    sourceName: String(payload.sourceName || "AI-assisted medical summary"),
    sourceUrl: sources[0].url,
    sources,
    fetchedAt: String(payload.fetchedAt || new Date().toISOString()),
    loincCode: String(payload.loincCode || "openai-web-search"),
  };
}
