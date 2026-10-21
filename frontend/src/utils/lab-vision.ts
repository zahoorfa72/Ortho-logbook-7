import AsyncStorage from "@react-native-async-storage/async-storage";
import { File } from "expo-file-system";
import * as SecureStore from "expo-secure-store";

export type LabVisionTemplate = { id: string; name: string; markers: string[]; columnHints?: string[] };
export type LabVisionCandidate = { test: string; result: string; unit: string; confidence: number; reason?: string; source?: string; photoUri?: string };

export const LAB_VISION_ENDPOINT_KEY = "ortho_lab_vision_endpoint_v1";
export const LAB_VISION_CONSENT_KEY = "ortho_lab_vision_consent_v1";
export const LAB_VISION_CLIENT_TOKEN_KEY = "ortho_lab_vision_client_token_v1";
export const LAB_VISION_OPENAI_API_KEY_KEY = "ortho_lab_vision_openai_api_key_v1";
export const LAB_VISION_TEMPLATES_KEY = "ortho_lab_report_templates_v1";

const clean = (value: unknown) => String(value ?? "").trim();
const normalise = (value: unknown) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function validateLabVisionEndpoint(value: string): string {
  const raw = clean(value);
  if (!raw) return "";
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error("Enter a complete HTTPS AI-vision endpoint URL."); }
  if (parsed.protocol !== "https:") throw new Error("For patient privacy, the AI-vision endpoint must use HTTPS.");
  if (!parsed.hostname || parsed.username || parsed.password) throw new Error("The endpoint URL is invalid. Do not put credentials in the URL.");
  if (["localhost", "127.0.0.1", "::1"].includes(parsed.hostname.toLowerCase())) throw new Error("Use a deployed HTTPS endpoint, not a local or insecure address.");
  return parsed.toString();
}

export function matchLabVisionTemplate(text: string, templates: LabVisionTemplate[]): LabVisionTemplate | null {
  const haystack = normalise(text);
  if (!haystack) return null;
  let best: LabVisionTemplate | null = null;
  let bestScore = 0;
  for (const template of templates) {
    const markers = (Array.isArray(template.markers) ? template.markers : []).map(normalise).filter(marker => marker.length >= 2);
    const matched = markers.filter(marker => haystack.includes(marker));
    const threshold = markers.length > 1 ? 2 : 1;
    if (matched.length >= threshold && matched.length > bestScore) { best = template; bestScore = matched.length; }
  }
  return best;
}

export async function loadLabVisionSettings(): Promise<{ endpoint: string; consent: boolean; clientToken: string; apiKey: string; templates: LabVisionTemplate[] }> {
  const [endpoint, consent, rawTemplates, clientToken, apiKey] = await Promise.all([
    AsyncStorage.getItem(LAB_VISION_ENDPOINT_KEY),
    AsyncStorage.getItem(LAB_VISION_CONSENT_KEY),
    AsyncStorage.getItem(LAB_VISION_TEMPLATES_KEY),
    SecureStore.getItemAsync(LAB_VISION_CLIENT_TOKEN_KEY),
    SecureStore.getItemAsync(LAB_VISION_OPENAI_API_KEY_KEY),
  ]);
  let templates: LabVisionTemplate[] = [];
  try {
    const parsed = rawTemplates ? JSON.parse(rawTemplates) : [];
    if (Array.isArray(parsed)) templates = parsed.filter(item => item && typeof item.id === "string" && typeof item.name === "string" && Array.isArray(item.markers));
  } catch {}
  return { endpoint: clean(endpoint), consent: consent === "true", clientToken: clean(clientToken), apiKey: clean(apiKey), templates };
}

export async function requestLabVisionCandidates(args: {
  uri: string; endpoint?: string; clientToken?: string; apiKey?: string;
  configuredTests: Array<{ name?: string; aliases?: string; unit?: string; category?: string }>;
  templates: LabVisionTemplate[]; offlineText: string;
}): Promise<{ candidates: LabVisionCandidate[]; template: LabVisionTemplate | null; error?: string }> {
  const apiKey = clean(args.apiKey);
  const template = matchLabVisionTemplate(args.offlineText, args.templates);
  let endpoint = "";
  if (!apiKey) {
    endpoint = validateLabVisionEndpoint(args.endpoint || "");
    if (!endpoint) return { candidates: [], template, error: "No direct OpenAI API key or hosted AI-vision endpoint is configured; offline OCR remains available." };
    if (!clean(args.clientToken)) return { candidates: [], template, error: "AI-vision client token is missing; offline OCR remains available." };
  }

  const metadata = {
    schema: "ortho-logbook-lab-vision-v1",
    configuredTests: args.configuredTests.map(test => ({
      name: clean(test.name), aliases: clean(test.aliases).split(/[,;\n]+/).map(clean).filter(Boolean),
      unit: clean(test.unit), branch: clean(test.category),
    })).filter(test => test.name).slice(0, 250),
    matchedTemplate: template ? { name: template.name, markers: template.markers, columnHints: template.columnHints || [] } : null,
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    let response: Response;
    try {
      if (apiKey) {
        // Direct phone-to-OpenAI path: the key is read from Expo SecureStore and never included in source or backups.
        const file = new File(args.uri);
        if (file.size > 12 * 1024 * 1024) {
          return { candidates: [], template, error: "This lab image is larger than 12 MB. Use a smaller cropped image or local OCR; offline OCR remains available." };
        }
        const extension = args.uri.split("?")[0].toLowerCase();
        const inferredType = extension.endsWith(".png") ? "image/png"
          : extension.endsWith(".webp") ? "image/webp"
          : extension.endsWith(".gif") ? "image/gif"
          : "image/jpeg";
        const contentType = clean(file.type).toLowerCase().startsWith("image/") ? clean(file.type).toLowerCase() : inferredType;
        if (!/^image\/(jpeg|png|webp|gif)$/.test(contentType)) {
          return { candidates: [], template, error: "This image format is not supported for direct AI scanning. Local OCR remains available." };
        }
        const base64 = await file.base64();
        const prompt = [
          "Transcribe visually readable laboratory test labels and measured result values from this image.",
          "Do not diagnose, interpret, or infer values. Never use a reference interval as a measured result.",
          "Never borrow a value from a neighboring row. Omit rows if label/result alignment is uncertain.",
          'Return JSON only with schema {"rows":[{"test":"string","result":"string","unit":"optional string","confidence":0.0,"reason":"optional string"}]}.',
          "Confidence is visual certainty from 0 to 1, not clinical certainty. Do not include patient identifiers, dates of birth, names, MR numbers, diagnoses, or other demographics in the output.",
          "Configured test names and aliases for normalization only: " + JSON.stringify(metadata.configuredTests),
          "Matched layout hints (not medical ranges): " + JSON.stringify(metadata.matchedTemplate),
        ].join("\n");
        response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            temperature: 0,
            max_tokens: 1800,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: "You are a conservative lab document transcription component. Abstain when uncertain. Never invent missing data. Output valid JSON only." },
              { role: "user", content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: "data:" + contentType + ";base64," + base64, detail: "high" } },
              ] },
            ],
          }),
          signal: controller.signal,
        });
      } else {
        const body = new FormData();
        body.append("file", { uri: args.uri, name: "lab-report.jpg", type: "image/jpeg" } as any);
        body.append("metadata", JSON.stringify(metadata));
        response = await fetch(endpoint, {
          method: "POST",
          headers: { Accept: "application/json", Authorization: "Bearer " + clean(args.clientToken) },
          body,
          signal: controller.signal,
        });
      }
    } finally { clearTimeout(timeout); }

    if (!response.ok) {
      if (apiKey && response.status === 401) return { candidates: [], template, error: "OpenAI rejected this API key (HTTP 401). Check the key in Lab Test Reference Ranges; offline OCR remains available." };
      if (apiKey && response.status === 429) return { candidates: [], template, error: "OpenAI rate limit or API billing quota reached (HTTP 429). Check your API project usage; offline OCR remains available." };
      if (apiKey && response.status === 403) return { candidates: [], template, error: "OpenAI denied this API request (HTTP 403). Check project access and model permissions; offline OCR remains available." };
      return { candidates: [], template, error: (apiKey ? "OpenAI vision request" : "AI-vision service") + " returned HTTP " + response.status + "; offline OCR remains available." };
    }

    const payload: any = await response.json();
    let decoded: any = payload;
    if (apiKey) {
      const content = payload?.choices?.[0]?.message?.content;
      try { decoded = typeof content === "string" ? JSON.parse(content) : content; } catch { decoded = null; }
    }
    const rows = Array.isArray(decoded?.rows) ? decoded.rows : Array.isArray(decoded?.candidates) ? decoded.candidates : [];
    const candidates: LabVisionCandidate[] = rows.slice(0, 100).map((row: any) => ({
      test: clean(row?.test).slice(0, 120), result: clean(row?.result).slice(0, 40), unit: clean(row?.unit).slice(0, 30),
      confidence: Math.max(0, Math.min(1, Number(row?.confidence))), reason: clean(row?.reason).slice(0, 180),
      source: "AI vision", photoUri: args.uri,
    })).filter((row: LabVisionCandidate) => row.test && row.result && Number.isFinite(row.confidence) && row.confidence >= 0.35);
    return { candidates, template };
  } catch (error: any) {
    return {
      candidates: [], template,
      error: error?.name === "AbortError"
        ? "AI-vision request timed out; offline OCR remains available."
        : apiKey ? "Direct OpenAI vision request failed. Check the internet, API key, and API project billing; offline OCR remains available."
          : "AI-vision service was unavailable; offline OCR remains available.",
    };
  }
}

export function matchCandidateToConfiguredTest(candidateName: string, configuredTests: Array<{ name?: string; aliases?: string; unit?: string; category?: string }>) {
  const wanted = normalise(candidateName);
  if (!wanted) return null;
  const exact = configuredTests.find(test => [clean(test.name), ...clean(test.aliases).split(/[,;\n]+/)].some(alias => normalise(alias) === wanted));
  if (exact) return exact;
  const compact = wanted.replace(/\s/g, "");
  if (compact.length < 5) return null;
  const matches = configuredTests.filter(test => [clean(test.name), ...clean(test.aliases).split(/[,;\n]+/)].some(alias => {
    const key = normalise(alias).replace(/\s/g, "");
    return key.length >= 5 && (compact === key || compact.startsWith(key + " ") || key.startsWith(compact + " "));
  }));
  return matches.length === 1 ? matches[0] : null;
}
