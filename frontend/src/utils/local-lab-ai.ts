import type { MedicalTestOnlineInfo } from "@/src/utils/medical-test-info";

export const LOCAL_LAB_AI_READY_KEY = "ortho_local_lab_ai_model_ready_v1";
export const LOCAL_LAB_AI_MODEL_NAME = "Gemma 4 E2B (8-bit dynamic quantization, CPU optimized)";
export const LOCAL_LAB_AI_MODEL_SIZE = "approximately 2.5–2.7 GB";

// Web builds deliberately avoid importing the native C++ runtime.
export async function getLocalLabModelDownloaded(): Promise<boolean> {
  return false;
}

export async function downloadLocalLabModel(
  _onProgress?: (percent: number) => void,
  _signal?: AbortSignal,
): Promise<void> {
  throw new Error("Download the local AI model from the native Android/iOS app build.");
}

export async function generateLocalLabMedicalInfo(
  _testName: string,
  _aliases: string,
  _abnormalDirection: string,
  _sourceInfo: MedicalTestOnlineInfo,
): Promise<MedicalTestOnlineInfo | null> {
  return null;
}
