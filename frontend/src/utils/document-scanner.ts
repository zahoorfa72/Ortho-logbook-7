import DocumentScanner from "react-native-document-scanner-plugin";

export async function scanPatientDocuments(): Promise<string[]> {
  const result = await DocumentScanner.scanDocument({
    maxNumDocuments: 20,
    // Preserve fine print and small lab-result digits before OCR or manual review.
    croppedImageQuality: 100,
  });
  if (result.status !== "success" || !Array.isArray(result.scannedImages)) return [];
  return result.scannedImages
    .map(value => String(value || "").trim())
    .filter(Boolean)
    .map(value => value.startsWith("file://") || value.startsWith("content://") ? value : value.startsWith("/") ? "file://" + value : value);
}
