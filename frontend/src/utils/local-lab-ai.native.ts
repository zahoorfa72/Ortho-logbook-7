import * as SecureStore from "expo-secure-store";
import { createLLMChatSession, download, models, setTelemetryEnabled } from "react-native-executorch";
import type { MedicalTestOnlineInfo } from "@/src/utils/medical-test-info";

export const LOCAL_LAB_AI_READY_KEY = "ortho_local_lab_ai_model_ready_v1";
export const LOCAL_LAB_AI_MODEL_NAME = "Gemma 4 E2B (CPU-optimized)";
export const LOCAL_LAB_AI_MODEL_SIZE = "approximately 2.5–2.7 GB";

const MODEL_CONFIG = models.llm.GEMMA4_E2B.XNNPACK_8DA4W;
let resolvedModelConfig: any = null;
let pendingDownload: Promise<any> | null = null;

export async function getLocalLabModelDownloaded(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(LOCAL_LAB_AI_READY_KEY)) === "true";
  } catch {
    return false;
  }
}

/**
 * Downloads model weights to the native runtime's persistent cache.
 * Uses the device's current network route (Wi-Fi or mobile data). No OpenAI key
 * or remote inference is used. SecureStore keeps the readiness flag out of backup.
 */
export async function downloadLocalLabModel(
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new Error("Model download cancelled.");
  if (pendingDownload) {
    resolvedModelConfig = await pendingDownload;
    return;
  }

  setTelemetryEnabled(false);
  pendingDownload = (async () => {
    try {
      const config = await download(MODEL_CONFIG, {
        signal,
        onProgress: (update: any) => {
          const raw = typeof update === "number"
            ? update
            : Number(update?.progress ?? update?.percent ?? update?.fraction ?? 0);
          const percent = raw <= 1 ? raw * 100 : raw;
          if (Number.isFinite(percent)) onProgress?.(Math.max(0, Math.min(100, Math.round(percent))));
        },
      } as any);
      if (signal?.aborted) throw new Error("Model download cancelled.");
      resolvedModelConfig = config;
      await SecureStore.setItemAsync(LOCAL_LAB_AI_READY_KEY, "true");
      onProgress?.(100);
      return config;
    } finally {
      pendingDownload = null;
    }
  })();

  resolvedModelConfig = await pendingDownload;
}

function validTwoPartSummary(value: string): boolean {
  const text = value
    .replace(/^```(?:markdown|text)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  const testHeading = /WHAT THIS TEST IS/i.exec(text);
  const abnormalHeading = /WHAT THE ABNORMAL RESULT MAY MEAN/i.exec(text);
  return !!testHeading && !!abnormalHeading &&
    testHeading.index < abnormalHeading.index &&
    text.slice(testHeading.index + testHeading[0].length, abnormalHeading.index).trim().length >= 20 &&
    text.slice(abnormalHeading.index + abnormalHeading[0].length).trim().length >= 20;
}

/**
 * Uses source text as a bounded reference. Only the test name, aliases and
 * HIGH/LOW direction are sent into the model; numeric measurements and PHI are
 * intentionally not accepted by this API.
 */
export async function generateLocalLabMedicalInfo(
  testName: string,
  aliases: string,
  abnormalDirection: string,
  sourceInfo: MedicalTestOnlineInfo,
): Promise<MedicalTestOnlineInfo | null> {
  if (!(await getLocalLabModelDownloaded())) return null;
  if (!String(sourceInfo?.summary || "").trim() || !String(sourceInfo?.sourceName || "").trim()) return null;
  try {
    if (!resolvedModelConfig) {
      // The downloader returns local-cache paths when assets are already present.
      // If the cache is missing, this fails gracefully and the caller shows source text.
      resolvedModelConfig = await download(MODEL_CONFIG);
    }
    const session = await createLLMChatSession(resolvedModelConfig, {
      initialMessages: [{
        role: "system",
        content: [
          "You are Ortho Logbook's offline laboratory-test information formatter.",
          "Only answer about clinical laboratory tests. Never answer unrelated topics.",
          "Use ONLY the provided source title and source summary. Do not add unsourced causes, diagnosis, thresholds, treatments, statistics or advice.",
          "Do not infer a high/low direction from a numeric value; none is provided.",
          "Return exactly these two headings in this order:",
          "WHAT THIS TEST IS",
          "WHAT THE ABNORMAL RESULT MAY MEAN",
          "Explain only the supplied direction if it is HIGH or LOW. If direction is unknown, describe high/low only where the source itself supports them. If the source lacks a direction-specific explanation, clearly say that the source does not establish one.",
          "Use short plain-language paragraphs. Make no claim that one abnormal test alone proves a disease. No patient-specific diagnosis.",
        ].join("\n"),
      }],
      generationConfig: { temperature: 0.1, maxNewTokens: 280 },
    });

    try {
      const prompt = [
        "Laboratory test name: " + String(testName || "").slice(0, 100),
        "Recognized aliases: " + String(aliases || "none").slice(0, 160),
        "Reference-based direction: " + (["HIGH", "LOW"].includes(abnormalDirection) ? abnormalDirection : "direction unknown"),
        "Source title: " + String(sourceInfo.title || testName).slice(0, 200),
        "Source name: " + String(sourceInfo.sourceName || "").slice(0, 120),
        "Source text (use only these facts):",
        String(sourceInfo.summary || "").slice(0, 1800),
        "Produce only the required two sections. Do not include the measured result value or invent any information.",
      ].join("\n\n");
      const result = await session.sendMessage(prompt);
      const messages = Array.isArray(result?.messages) ? result.messages : [];
      const answer = [...messages].reverse().find((message: any) => message?.role === "assistant");
      const summary = String(answer?.content || "").trim();
      if (!validTwoPartSummary(summary)) return null;
      return {
        ...sourceInfo,
        summary: summary
          .replace(/^```(?:markdown|text)?\s*/i, "")
          .replace(/\s*```\s*$/i, "")
          .trim()
          .slice(0, 1800),
        sourceFetchedAt: sourceInfo.sourceFetchedAt || sourceInfo.fetchedAt,
        fetchedAt: new Date().toISOString(),
        modelProvider: "local-gemma4-e2b",
      };
    } finally {
      session.dispose();
    }
  } catch {
    return null;
  }
}
