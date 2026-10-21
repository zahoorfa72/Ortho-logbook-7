import * as SecureStore from "expo-secure-store";
import type { MedicalTestOnlineInfo } from "@/src/utils/medical-test-info";
import { LAB_VISION_OPENAI_API_KEY_KEY } from "@/src/utils/lab-vision";

/**
 * Short, source-grounded medical education for abnormal lab results.
 * Reuses the same securely stored OpenAI key as direct AI lab scanning.
 * Only a generic test name, aliases and low/high direction are sent; never
 * patient identity, actual result values, reference ranges, photos or report text.
 */
const TRUSTED_MEDICAL_DOMAINS = [
  "medlineplus.gov", "nhs.uk", "mayoclinic.org", "clevelandclinic.org",
  "cdc.gov", "who.int", "nih.gov", "niddk.nih.gov", "cancer.gov",
  "msdmanuals.com", "testing.com", "labcorp.com", "kidney.org",
  "heart.org", "med.umich.edu", "ucsfhealth.org", "health.harvard.edu",
];

async function fetchWithTimeout(input: string, init?: RequestInit, timeoutMs = 25000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function trustedUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && TRUSTED_MEDICAL_DOMAINS.some(domain =>
      url.hostname === domain || url.hostname.endsWith("." + domain)
    );
  } catch {
    return false;
  }
}

function responseText(payload: any): { text: string; citations: Array<{ title: string; url: string }> } {
  const chunks: string[] = [];
  const citations: Array<{ title: string; url: string }> = [];
  const addCitation = (urlValue: unknown, titleValue?: unknown) => {
    if (!trustedUrl(urlValue) || citations.some(source => source.url === urlValue)) return;
    citations.push({
      title: String(titleValue || urlValue).slice(0, 160),
      url: urlValue,
    });
  };
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    // Responses API web search also returns sources on the search-call action,
    // not only URL annotations on the final text. Read both response shapes.
    const actionSources = item?.action?.sources;
    if (Array.isArray(actionSources)) {
      for (const source of actionSources) addCitation(source?.url, source?.title);
    }
    if (Array.isArray(item?.results)) {
      for (const source of item.results) addCitation(source?.url, source?.title);
    }
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if ((part?.type === "output_text" || part?.type === "text") && typeof part.text === "string") chunks.push(part.text);
      for (const annotation of Array.isArray(part?.annotations) ? part.annotations : []) {
        const nested = annotation?.url_citation;
        addCitation(annotation?.url || nested?.url, annotation?.title || nested?.title);
      }
    }
  }
  const text = String(payload?.output_text || chunks.join("\n")).trim();
  // Some compatible Responses API payloads return cited URLs inline in the text
  // but omit annotation objects. Accept only URLs from the strict medical allowlist.
  for (const match of text.matchAll(/https:\/\/[^\s)\]}>]+/gi)) {
    addCitation(match[0].replace(/[.,;]+$/, ""));
  }
  return { text, citations: citations.slice(0, 3) };
}

function compactSummary(value: string): string {
  const cleaned = String(value || "").replace(/^\s*\d+[.)]\s*/gm, "").trim();
  let lines = cleaned.split(/\n+/)
    .map(line => line.replace(/^[-•*]\s*/, "").trim())
    .filter(Boolean);
  // Some responses arrive as one paragraph; split that into short sentences.
  if (lines.length <= 1 && cleaned.length > 180) {
    lines = (cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [cleaned])
      .map(line => line.trim()).filter(Boolean);
  }
  return lines
    .slice(0, 7)
    .map(line => line.length > 180 ? line.slice(0, 177).trimEnd() + "…" : line)
    .join("\n")
    .slice(0, 1050);
}

async function fetchDirectOpenAiMedicalInfo(
  apiKey: string,
  testName: string,
  aliases: string,
  abnormalDirection: string,
): Promise<MedicalTestOnlineInfo | null> {
  const response = await fetchWithTimeout("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      tools: [{ type: "web_search", search_context_size: "high" }],
      tool_choice: "auto",
      max_output_tokens: 650,
      instructions: [
        "You provide cautious patient-facing medical education about laboratory tests.",
        "Use web search and rely only on trusted medical authorities such as MedlinePlus, NHS, NIH, CDC, WHO, Mayo Clinic, Cleveland Clinic, or major accredited medical laboratories.",
        "Give exactly 6 or 7 short lines, no long paragraphs. Explain what the test measures, what an out-of-range result in the stated direction may mean, common possible causes, why one result cannot diagnose a disease, and a sensible next step.",
        "Do not invent facts, normal ranges, diagnoses, treatments, urgency, or sources. Do not state that an abnormal result definitely means a disease. If trustworthy evidence cannot be found, say so briefly.",
        "Do not give a reference range or interpret a patient-specific value. The app has not sent any patient result, identity, image, or reference range.",
        "Return plain text only, one concise sentence per line. Use citations from the web search in the response.",
      ].join(" "),
      input: "Lab test: " + testName.slice(0, 120) +
        "\nOther labels: " + aliases.slice(0, 250) +
        "\nAbnormal direction to explain: " + abnormalDirection.slice(0, 24) +
        "\nProvide a concise, medically reliable explanation of this test and what this direction may indicate.",
    }),
  });
  if (!response.ok) {
    let statusMessage = "OpenAI request failed (" + response.status + ").";
    if (response.status === 401 || response.status === 403) {
      statusMessage = "OpenAI rejected the saved API key or project access (" + response.status + "). Check the key and API project permissions.";
    } else if (response.status === 429) {
      statusMessage = "OpenAI API quota or rate limit reached (429). Check API billing and usage limits.";
    } else if (response.status >= 500) {
      statusMessage = "OpenAI service is temporarily unavailable (" + response.status + ").";
    }
    throw new Error(statusMessage);
  }
  const payload = await response.json();
  const parsed = responseText(payload);
  const summary = compactSummary(parsed.text);
  // Do not present an AI answer as trustworthy without a matching source citation.
  if (summary.split("\n").filter(Boolean).length < 4 || !parsed.citations.length) return null;
  return {
    title: testName + " — abnormal result information",
    summary,
    sourceName: "OpenAI summary based on cited medical sources",
    sourceUrl: parsed.citations[0].url,
    sources: parsed.citations,
    fetchedAt: new Date().toISOString(),
    loincCode: "openai-web-search",
  };
}

/**
 * Uses the shared direct OpenAI key when configured. The older secure backend
 * proxy remains a fallback for existing deployments; trusted website lookup is
 * still handled by the caller when this function returns null.
 */
export async function fetchAiMedicalTestInfo(
  testName: string,
  aliases = "",
  abnormalDirection = "outside the reference range",
): Promise<MedicalTestOnlineInfo | null> {
  const safeName = String(testName || "").trim().slice(0, 120);
  if (safeName.length < 2) return null;

  let directError: Error | null = null;
  try {
    const key = String(await SecureStore.getItemAsync(LAB_VISION_OPENAI_API_KEY_KEY) || "").trim();
    if (key) {
      const direct = await fetchDirectOpenAiMedicalInfo(key, safeName, String(aliases || ""), abnormalDirection);
      if (direct) return direct;
      directError = new Error("OpenAI returned no usable, source-cited explanation for this test.");
    }
  } catch (error: any) {
    directError = error instanceof Error ? error : new Error("OpenAI medical lookup failed.");
  }

  const baseUrl = String(process.env.EXPO_PUBLIC_MEDICAL_INFO_API_URL || "").trim().replace(/\/+$/, "");
  const clientToken = String(process.env.EXPO_PUBLIC_MEDICAL_INFO_CLIENT_TOKEN || "").trim();
  if (!baseUrl || !clientToken || !/^https:\/\//i.test(baseUrl)) {
    if (directError) throw directError;
    return null;
  }
  try {
    const response = await fetchWithTimeout(baseUrl + "/api/medical-test-info", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: "Bearer " + clientToken,
      },
      body: JSON.stringify({
        test_name: safeName,
        aliases: String(aliases || "").slice(0, 300),
        abnormal_direction: abnormalDirection.slice(0, 24),
      }),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const sources = Array.isArray(payload?.sources)
      ? payload.sources.filter((item: any) => item && typeof item.title === "string" && trustedUrl(item.url)).slice(0, 3)
      : [];
    const summary = compactSummary(String(payload?.summary || ""));
    if (summary.split("\n").filter(Boolean).length < 4 || !sources.length) return null;
    return {
      title: String(payload.title || safeName + " — abnormal result information"),
      summary,
      sourceName: String(payload.sourceName || "AI-assisted summary based on trusted medical sources"),
      sourceUrl: sources[0].url,
      sources,
      fetchedAt: String(payload.fetchedAt || new Date().toISOString()),
      loincCode: String(payload.loincCode || "trusted-ai-proxy"),
    };
  } catch {
    if (directError) throw directError;
    return null;
  }
}
