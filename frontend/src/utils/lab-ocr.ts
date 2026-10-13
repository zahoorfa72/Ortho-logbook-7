import { recognizeText } from "expo-ocr-kit";

export async function recognizeLabText(uri: string): Promise<{ text: string }> {
  const result = await recognizeText(uri);
  return { text: String(result?.text || "") };
}
