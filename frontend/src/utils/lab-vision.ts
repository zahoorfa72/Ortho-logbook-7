import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

export type LabVisionTemplate = { id: string; name: string; markers: string[]; columnHints?: string[] };
export type LabVisionCandidate = { test: string; result: string; unit: string; confidence: number; reason?: string; source?: string; photoUri?: string };

export const LAB_VISION_ENDPOINT_KEY = "ortho_lab_vision_endpoint_v1";
export const LAB_VISION_CONSENT_KEY = "ortho_lab_vision_consent_v1";
export const LAB_VISION_CLIENT_TOKEN_KEY = "ortho_lab_vision_client_token_v1";
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

export async function loadLabVisionSettings(): Promise<{ endpoint: string; consent: boolean; clientToken: string; templates: LabVisionTemplate[] }> {
  const [endpoint, consent, rawTemplates, clientToken] = await Promise.all([
    AsyncStorage.getItem(LAB_VISION_ENDPOINT_KEY),
    AsyncStorage.getItem(LAB_VISION_CONSENT_KEY),
    AsyncStorage.getItem(LAB_VISION_TEMPLATES_KEY),
    SecureStore.getItemAsync(LAB_VISION_CLIENT_TOKEN_KEY),
  ]);
  let templates: LabVisionTemplate[] = [];
  try {
    const parsed = rawTemplates ? JSON.parse(rawTemplates) : [];
    if (Array.isArray(parsed)) templates = parsed.filter(item => item && typeof item.id === "string" && typeof item.name === "string" && Array.isArray(item.markers));
  } catch {}
  return { endpoint: clean(endpoint), consent: consent === "true", clientToken: clean(clientToken), templates };
}

export async function requestLabVisionCandidates(args: {
  uri: string; endpoint: string; clientToken: string;
  configuredTests: Array<{ name?: string; aliases?: string; unit?: string; category?: string }>;
  templates: LabVisionTemplate[]; offlineText: string;
}): Promise<{ candidates: LabVisionCandidate[]; template: LabVisionTemplate | null; error?: string }> {
  const endpoint = validateLabVisionEndpoint(args.endpoint);
  if (!endpoint) return { candidates: [], template: null };
  const template = matchLabVisionTemplate(args.offlineText, args.templates);
  if (!clean(args.clientToken)) return { candidates: [], template, error: "AI-vision client token is missing; offline OCR remains available." };
  try {
    const body = new FormData();
    body.append("file", { uri: args.uri, name: "lab-report.jpg", type: "image/jpeg" } as any);
    const metadata = {
      schema: "ortho-logbook-lab-vision-v1",
      configuredTests: args.configuredTests.map(test => ({
        name: clean(test.name), aliases: clean(test.aliases).split(/[,;\n]+/).map(clean).filter(Boolean),
        unit: clean(test.unit), branch: clean(test.category),
      })).filter(test => test.name),
      matchedTemplate: template ? { name: template.name, markers: template.markers, columnHints: template.columnHints || [] } : null,
    };
    body.append("metadata", JSON.stringify(metadata));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 35000);
    let response: Response;
    try {
      response = await fetch(endpoint, { method: "POST", headers: { Accept: "application/json", Authorization: "Bearer " + args.clientToken }, body, signal: controller.signal });
    } finally { clearTimeout(timeout); }
    if (!response.ok) return { candidates: [], template, error: "AI-vision service returned HTTP " + response.status + "; offline OCR remains available." };
    const payload: any = await response.json();
    const rows = Array.isArray(payload?.rows) ? payload.rows : Array.isArray(payload?.candidates) ? payload.candidates : [];
    const candidates: LabVisionCandidate[] = rows.slice(0, 100).map((row: any) => ({
      test: clean(row?.test).slice(0, 120), result: clean(row?.result).slice(0, 40), unit: clean(row?.unit).slice(0, 30),
      confidence: Math.max(0, Math.min(1, Number(row?.confidence))), reason: clean(row?.reason).slice(0, 180),
      source: "AI vision", photoUri: args.uri,
    })).filter((row: LabVisionCandidate) => row.test && row.result && Number.isFinite(row.confidence) && row.confidence >= 0.35);
    return { candidates, template };
  } catch (error: any) {
    return { candidates: [], template, error: error?.name === "AbortError" ? "AI-vision request timed out; offline OCR remains available." : "AI-vision service was unavailable; offline OCR remains available." };
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
