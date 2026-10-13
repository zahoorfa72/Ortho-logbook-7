export async function recognizeLabText(_uri: string): Promise<{ text: string }> {
  throw new Error("Offline lab OCR is available in the Android/iOS app build, not in the Windows/web version.");
}
