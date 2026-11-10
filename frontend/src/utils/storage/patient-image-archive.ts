import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import * as FileSystem from "expo-file-system/legacy";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { db, initializeDatabase } from "@/src/db/database";

const ARCHIVE_KEY = "ortho_patient_image_archives_v1";
const ARCHIVE_DIR = (FileSystem.documentDirectory || "") + "patient-image-archives/";

export type PatientImageArchive = {
  patientId: string;
  patientName: string;
  mrNo: string;
  fileName: string;
  localUri: string;
  sourceStamp: string;
  archivedAt: string;
  imageCount: number;
  driveFileId?: string;
  driveSourceStamp?: string;
  patientUpdatedAt?: string;
};

async function readArchives(): Promise<Record<string, PatientImageArchive>> {
  try {
    const raw = await AsyncStorage.getItem(ARCHIVE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}
async function writeArchives(value: Record<string, PatientImageArchive>): Promise<void> {
  await AsyncStorage.setItem(ARCHIVE_KEY, JSON.stringify(value));
}
function safePart(value: string): string {
  return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9 -]/g, "").trim().replace(/\s+/g, " ").replace(/ /g, "-").slice(0, 64) || "Patient";
}
function fileNameFor(name: string, mrNo: string, id: string): string {
  const parts = [safePart(name), mrNo ? "MR-" + safePart(mrNo) : "", safePart(id).slice(-10)].filter(Boolean);
  return parts.join(" - ") + ".pdf";
}
function getPhotoSources(row: any): string[] {
  const result: string[] = [];
  if (typeof row?.photo_uri === "string" && row.photo_uri.trim()) result.push(row.photo_uri.trim());
  try {
    const parsed = typeof row?.photos_json === "string" ? JSON.parse(row.photos_json) : row?.photos_json;
    if (Array.isArray(parsed)) for (const item of parsed) if (typeof item === "string" && item.trim()) result.push(item.trim());
  } catch {}
  return Array.from(new Set(result)).filter(x => !x.startsWith("__ORTHO_PHOTO_REF__:"));
}

// SQLite's Android CursorWindow cannot return a single multi-megabyte text cell.
// Read patient image columns in small substr() pieces so automatic Drive sync
// can archive older photos without failing before JavaScript receives the row.
function readTextColumnInChunks(column: "photo_uri" | "photos_json", id: string): string {
  const lengthRow = db.getFirstSync<any>(
    `SELECT length(${column}) AS value_length FROM patients WHERE id=?`, [id],
  );
  const length = Math.max(0, Number(lengthRow?.value_length || 0));
  if (!length) return "";
  const chunkSize = 48 * 1024;
  let value = "";
  for (let start = 1; start <= length; start += chunkSize) {
    const part = db.getFirstSync<any>(
      `SELECT substr(${column}, ?, ?) AS value_chunk FROM patients WHERE id=?`,
      [start, chunkSize, id],
    );
    value += String(part?.value_chunk || "");
  }
  return value;
}

export function readPatientPhotoRow(patientId: string): { photo_uri: string; photos_json: string } {
  initializeDatabase();
  const id = String(patientId || "").trim();
  if (!id) return { photo_uri: "", photos_json: "" };
  return {
    photo_uri: readTextColumnInChunks("photo_uri", id),
    photos_json: readTextColumnInChunks("photos_json", id),
  };
}
async function imageContentKey(source: string): Promise<string> {
  // Avoid loading an entire scanned image into a JavaScript base64 string merely
  // to compute a cache stamp. The old code read each image once for hashing and
  // again for PDF creation, increasing latency and memory pressure.
  if (/^data:image\//i.test(source)) {
    const comma = source.indexOf(",");
    const payload = comma >= 0 ? source.slice(comma + 1) : source;
    return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, payload);
  }
  if (/^(file|content):\/\//i.test(source)) {
    try {
      const info = await FileSystem.getInfoAsync(source, { md5: true } as any);
      if (info.exists && (info as any).md5) return "md5:" + String((info as any).md5);
      if (info.exists) {
        return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256,
          [source, String((info as any).size || ""), String((info as any).modificationTime || "")].join("|"));
      }
    } catch {}
  }
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, source);
}
async function deduplicatePhotoSources(sources: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const source of sources) {
    const key = await imageContentKey(source);
    if (!seen.has(key)) { seen.add(key); result.push(source); }
  }
  return result;
}
async function toEmbeddableImage(source: string): Promise<string> {
  if (/^data:image\//i.test(source)) return source;
  if (/^https?:\/\//i.test(source)) return source;
  if (/^(file|content):\/\//i.test(source)) {
    const base64 = await FileSystem.readAsStringAsync(source, { encoding: FileSystem.EncodingType.Base64 });
    const ext = /\.png(?:$|[?#])/i.test(source) ? "png" : /\.webp(?:$|[?#])/i.test(source) ? "webp" : /\.gif(?:$|[?#])/i.test(source) ? "gif" : "jpeg";
    return "data:image/" + ext + ";base64," + base64;
  }
  throw new Error("A patient image is not available as a readable local image.");
}
async function stampFor(id: string, name: string, mrNo: string, createdAt: string, sources: string[]): Promise<string> {
  const signatures: string[] = [];
  for (const source of sources) signatures.push(await imageContentKey(source));
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256,
    JSON.stringify(["patient-image-pdf-layout-v2", id, name, mrNo, createdAt, signatures]));
}
function makeHtml(name: string, mrNo: string, images: string[]): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return "<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><style>" +
    "@page{size:A4;margin:0}*{box-sizing:border-box}html,body{width:210mm;min-height:297mm;margin:0;padding:0}" +
    "body{font-family:Arial,sans-serif;color:#18251D;background:#EEF2EE}" +
    ".photo{width:210mm;height:297mm;padding:7mm;display:flex;align-items:stretch;justify-content:stretch;page-break-after:always;break-after:page;overflow:hidden;background:#EEF2EE}" +
    ".photo:last-child{page-break-after:auto;break-after:auto}" +
    ".photoContent{width:100%;height:100%;min-height:0;display:flex;flex-direction:column;padding:6mm;background:#F7F9F7;border:1px solid #D8E2D9;border-radius:4mm;overflow:hidden}" +
    ".head{font-size:16px;font-weight:700;line-height:1.25;margin:0 0 2mm;color:#244C37}" +
    ".meta{font-size:10px;color:#647268;margin:0 0 4mm}" +
    ".imageFrame{flex:1;min-height:0;width:100%;display:flex;align-items:center;justify-content:center;overflow:hidden;padding:2mm;background:#FFFFFF;border:1px solid #E1E7E1;border-radius:3mm}" +
    "img{display:block;width:100%;height:100%;max-width:100%;max-height:100%;object-fit:contain;image-orientation:from-image}" +
    "</style></head><body>" + images.map((src, index) =>
      "<section class='photo'><div class='photoContent'>" +
      "<div class='head'>" + esc(name || "Patient") + "</div><div class='meta'>MR No: " + esc(mrNo || "—") +
      " · Image " + (index + 1) + " of " + images.length + "</div>" +
      "<div class='imageFrame'><img src='" + src.replace(/'/g, "%27") + "' /></div></div></section>"
    ).join("") + (images.length ? "" :
      "<section class='photo'><div class='photoContent'><div class='head'>" + esc(name || "Patient") +
      "</div><div class='meta'>MR No: " + esc(mrNo || "—") +
      "</div><div class='imageFrame'><p>No images are currently attached to this patient.</p></div></div></section>") + "</body></html>";
}

export async function getLocalPatientImageArchives(): Promise<PatientImageArchive[]> {
  const all = await readArchives();
  return Object.values(all).filter((item: any) => item && typeof item.patientId === "string" &&
    typeof item.fileName === "string" && typeof item.localUri === "string");
}
export async function getPatientImageArchive(patientId: string): Promise<PatientImageArchive | null> {
  const all = await readArchives();
  const item = all[String(patientId || "")];
  if (!item) return null;
  const info = await FileSystem.getInfoAsync(item.localUri);
  return info.exists ? item : null;
}
export async function setPatientImageArchiveDriveState(fileName: string, sourceStamp: string, driveFileId: string): Promise<void> {
  const all = await readArchives();
  for (const [id, item] of Object.entries(all)) {
    if (item.fileName === fileName && item.sourceStamp === sourceStamp) {
      all[id] = { ...item, driveFileId, driveSourceStamp: sourceStamp };
    }
  }
  await writeArchives(all);
}
async function readPdfHeader(uri: string): Promise<string> {
  if (!uri.startsWith("file://")) {
    // External document-provider URIs are checked after they are copied to the
    // app's private temporary path.
    const temp = ARCHIVE_DIR + "pdf-header-check-" + Date.now() + ".pdf";
    await FileSystem.copyAsync({ from: uri, to: temp });
    try { return await readPdfHeader(temp); }
    finally { await FileSystem.deleteAsync(temp, { idempotent: true }).catch(() => {}); }
  }
  const path = decodeURIComponent(uri.replace(/^file:\/\//, ""));
  const FileModule = await import("expo-file-system");
  const file = new FileModule.File(path);
  const handle = await file.open();
  try {
    const bytes = await handle.readBytes(5);
    return String.fromCharCode(...bytes);
  } finally { await handle.close(); }
}

export async function installPatientImageArchivePdf(
  metadata: Omit<PatientImageArchive, "localUri"> & { localUri?: string },
  sourceUri: string,
): Promise<void> {
  if (!FileSystem.documentDirectory) throw new Error("Private phone storage is unavailable for patient image PDFs.");
  await FileSystem.makeDirectoryAsync(ARCHIVE_DIR, { intermediates: true });
  const sourceInfo = await FileSystem.getInfoAsync(sourceUri);
  if (!sourceInfo.exists || Number(sourceInfo.size || 0) < 8) throw new Error("The patient image PDF is missing or empty.");
  // Validate the PDF signature before replacing the patient's current archive.
  // A PDF starts with "%PDF-" at byte zero. Read only a small prefix so
  // validating large patient PDFs never allocates a second full base64 copy.
  // FileSystem readAsStringAsync returns the entire document, so avoid it for
  // PDF signature validation. Use a bounded read through the PDF's local file.
  const header = await readPdfHeader(sourceUri);
  if (header !== "%PDF-") throw new Error("The selected patient archive is not a valid PDF.");
  const all = await readArchives();
  const id = String(metadata.patientId || "").trim();
  if (!id) throw new Error("Patient ID is missing from the PDF archive manifest.");
  const existing = all[id];
  // Stable per-patient target: updates replace the same file rather than
  // accumulating duplicate PDFs. Copy to a temporary file and verify first.
  const target = ARCHIVE_DIR + metadata.fileName;
  const temp = target + ".incoming";
  const staleTemp = await FileSystem.getInfoAsync(temp);
  if (staleTemp.exists) await FileSystem.deleteAsync(temp, { idempotent: true });
  await FileSystem.copyAsync({ from: sourceUri, to: temp });
  const tempInfo = await FileSystem.getInfoAsync(temp);
  if (!tempInfo.exists || Number(tempInfo.size || 0) !== Number(sourceInfo.size || 0)) {
    await FileSystem.deleteAsync(temp, { idempotent: true }).catch(() => {});
    throw new Error("The patient image PDF could not be verified after saving to this phone.");
  }
  if (existing?.localUri && existing.localUri !== target) {
    try { await FileSystem.deleteAsync(existing.localUri, { idempotent: true }); } catch {}
  }
  const current = await FileSystem.getInfoAsync(target);
  if (current.exists) await FileSystem.deleteAsync(target, { idempotent: true });
  await FileSystem.moveAsync({ from: temp, to: target });
  all[id] = { ...existing, ...metadata, patientId: id, localUri: target };
  await writeArchives(all);
}
export async function archivePatientImagesForPatient(patientId: string, onProgress?: (stage: string) => void, allowEmptyReplacement = false): Promise<PatientImageArchive> {
  initializeDatabase();
  const id = String(patientId || "").trim();
  if (!id) throw new Error("Save this patient before creating an image PDF.");
  if (!FileSystem.documentDirectory) throw new Error("Private phone storage is unavailable for patient image archives.");
  const patient = db.getFirstSync<any>("SELECT id,name,mr_no,date,created_at,updated_at FROM patients WHERE id=?", [id]);
  if (!patient) throw new Error("This patient is not available in the phone database. Refresh the patient list and try again.");
  const row = readPatientPhotoRow(id);
  const sources = await deduplicatePhotoSources(getPhotoSources(row));
  const name = String(patient.name || "Patient");
  const mrNo = String(patient.mr_no || "");
  const all = await readArchives();
  const existing = all[id];

  // Empty replacement is allowed only for the explicit admin-approved
  // "update Drive PDF" action. Routine backup/restore must never interpret
  // missing local photos as permission to erase an existing Drive archive.
  if (!sources.length && allowEmptyReplacement) {
    const stamp = await stampFor(id, name, mrNo, String(patient.created_at || patient.date || ""), []);
    if (existing?.sourceStamp === stamp && existing.imageCount === 0) {
      const info = await FileSystem.getInfoAsync(existing.localUri);
      if (info.exists && Number(info.size || 0) > 8) return existing;
    }
    onProgress?.("Creating an approved empty patient PDF…");
    await FileSystem.makeDirectoryAsync(ARCHIVE_DIR, { intermediates: true });
    const generated = await Print.printToFileAsync({ html: makeHtml(name, mrNo, []), base64: false });
    try {
      const info = await FileSystem.getInfoAsync(generated.uri);
      if (!info.exists || Number(info.size || 0) < 8) throw new Error("The replacement patient PDF is empty or unreadable.");
      await installPatientImageArchivePdf({
        patientId: id, patientName: name, mrNo,
        fileName: existing?.fileName || fileNameFor(name, mrNo, id),
        sourceStamp: stamp, archivedAt: new Date().toISOString(), imageCount: 0,
        patientUpdatedAt: String(patient.updated_at || ""),
        driveFileId: existing?.driveFileId, driveSourceStamp: existing?.driveSourceStamp,
      }, generated.uri);
    } finally {
      try { await FileSystem.deleteAsync(generated.uri, { idempotent: true }); } catch {}
    }
    const savedEmpty = await getPatientImageArchive(id);
    if (!savedEmpty) throw new Error("The approved empty PDF could not be verified in phone storage.");
    return savedEmpty;
  }

  // A data-only backup may intentionally contain no photo bytes. Never turn
  // that absence into an empty PDF and never overwrite a good Drive archive.
  // Reuse a verified local archive if available; otherwise require the admin
  // to download the original PDF or explicitly approve an empty replacement.
  if (!sources.length) {
    if (existing?.localUri) {
      const info = await FileSystem.getInfoAsync(existing.localUri);
      if (info.exists && Number(info.size || 0) > 8) return existing;
    }
    if (existing?.driveFileId || existing?.driveSourceStamp) {
      throw new Error("No patient images are available on this phone. The existing Google Drive PDF was left unchanged. Download that patient's PDF into the patient record before updating it.");
    }
    throw new Error("This patient has no locally available images. No empty PDF was created or uploaded.");
  }

  const stamp = await stampFor(id, name, mrNo, String(patient.created_at || patient.date || ""), sources);
  if (existing?.sourceStamp === stamp) {
    const info = await FileSystem.getInfoAsync(existing.localUri);
    if (info.exists && Number(info.size || 0) > 8) return existing;
  }
  onProgress?.("Creating this patient's image PDF…");
  await FileSystem.makeDirectoryAsync(ARCHIVE_DIR, { intermediates: true });
  const embedded: string[] = [];
  for (const source of sources) {
    embedded.push(await toEmbeddableImage(source));
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  const generated = await Print.printToFileAsync({ html: makeHtml(name, mrNo, embedded), base64: false });
  const fileName = fileNameFor(name, mrNo, id);
  try {
    const info = await FileSystem.getInfoAsync(generated.uri);
    if (!info.exists || Number(info.size || 0) < 8) throw new Error("The generated patient image PDF is empty.");
    await installPatientImageArchivePdf({
      patientId: id, patientName: name, mrNo, fileName, sourceStamp: stamp,
      archivedAt: new Date().toISOString(), imageCount: embedded.length,
      patientUpdatedAt: String(patient.updated_at || ""),
      // Preserve this patient's remote file ID so the uploader updates the same Drive file.
      driveFileId: existing?.driveFileId,
      driveSourceStamp: existing?.driveSourceStamp,
    }, generated.uri);
  } finally {
    try { await FileSystem.deleteAsync(generated.uri, { idempotent: true }); } catch {}
  }
  const saved = await getPatientImageArchive(id);
  if (!saved) throw new Error("The patient PDF was generated but could not be verified in phone storage.");
  return saved;
}

/**
 * Manual admin action: build/update one stable PDF per patient that actually has
 * locally available photos. Existing unchanged PDFs are reused; changed image
 * sets rebuild the same patient PDF. Empty-photo patients are skipped.
 */
export async function buildAllPatientImageArchivesManually(
  onProgress?: (stage: string) => void,
): Promise<{ created: number; updated: number; unchanged: number; skippedEmpty: number; total: number }> {
  initializeDatabase();
  const patients = db.getAllSync<any>(
    "SELECT id,name,mr_no FROM patients ORDER BY created_at ASC",
  );
  const result = { created: 0, updated: 0, unchanged: 0, skippedEmpty: 0, total: patients.length };
  for (let index = 0; index < patients.length; index++) {
    const patient = patients[index];
    const id = String(patient.id || "").trim();
    if (!id) continue;
    let row: { photo_uri: string; photos_json: string };
    try {
      row = readPatientPhotoRow(id);
    } catch (error: any) {
      const message = String(error?.message || error);
      if (/CursorWindow|row too big|too big to fit/i.test(message)) {
        throw new Error("Cannot safely read images for " + String(patient.name || id) + ". " + message);
      }
      throw error;
    }
    const sources = await deduplicatePhotoSources(getPhotoSources(row));
    if (!sources.length) {
      result.skippedEmpty++;
      onProgress?.("Skipped " + String(patient.name || "patient") + ": no images");
      continue;
    }
    const existing = await getPatientImageArchive(id);
    const beforeStamp = existing?.sourceStamp || "";
    onProgress?.("Creating patient PDF " + (index + 1) + "/" + patients.length + ": " + String(patient.name || "Patient"));
    const saved = await archivePatientImagesForPatient(id, onProgress, false);
    if (!beforeStamp) result.created++;
    else if (beforeStamp === saved.sourceStamp) result.unchanged++;
    else result.updated++;
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  return result;
}

export async function archiveEligiblePatientImages(onProgress?: (stage: string) => void, patientIds?: string[]): Promise<boolean> {
  initializeDatabase();
  if (!FileSystem.documentDirectory) throw new Error("Private phone storage is unavailable for patient image archives.");
  await FileSystem.makeDirectoryAsync(ARCHIVE_DIR, { intermediates: true });
  const allPatients = db.getAllSync<any>("SELECT id,name,mr_no,date,created_at,updated_at FROM patients ORDER BY created_at ASC");
  const requestedIds = patientIds === undefined ? null : new Set(patientIds.map(String));
  const patients = requestedIds ? allPatients.filter((patient: any) => requestedIds.has(String(patient.id))) : allPatients;
  const archives = await readArchives();
  let changed = false;
  for (let i = 0; i < patients.length; i++) {
    const patient = patients[i];
    const id = String(patient.id || "");
    if (!id) continue;
    const name = String(patient.name || "Patient");
    const mrNo = String(patient.mr_no || "");
    const existing = archives[id];
    // Never rewrite an already registered patient PDF automatically. A patient
    // image can be removed/changed in the record, but the Drive PDF is changed
    // only after an administrator explicitly approves it inside that patient.
    // This also prevents unrelated patient edits from triggering PDF rebuilds.
    if (existing) {
      const cached = await FileSystem.getInfoAsync(existing.localUri);
      if (cached.exists && Number(cached.size || 0) > 8) continue;
    }
    // A single legacy patient can have a multi-megabyte base64 photo row.
    // Android CursorWindow cannot always return that row to JavaScript. Never let
    // this optional background PDF archive block the independent data backup.
    let row: any;
    try {
      row = readPatientPhotoRow(id);
    } catch (error: any) {
      const message = String(error?.message || error);
      if (/CursorWindow|row too big|too big to fit/i.test(message)) {
        onProgress?.("Patient image PDF deferred for " + name + " because its saved image row exceeds Android's database read limit. Other backup data can still sync.");
        continue;
      }
      throw error;
    }
    const sources = await deduplicatePhotoSources(getPhotoSources(row));
    // Data-only restores intentionally omit photos. An empty photo field is
    // not an instruction to replace or delete the patient's existing PDF.
    // Only an explicit admin delete action may remove the Drive archive.
    if (!sources.length) {
      onProgress?.("Skipped patient PDF for " + name + ": no local images are available; any existing Drive PDF was preserved.");
      continue;
    }
    const stamp = await stampFor(id, name, mrNo, String(patient.created_at || patient.date || ""), sources);
    if (existing?.sourceStamp === stamp) {
      const info = await FileSystem.getInfoAsync(existing.localUri);
      if (info.exists && Number(info.size || 0) > 8) {
        if (existing.patientUpdatedAt !== String(patient.updated_at || "")) {
          archives[id] = { ...existing, patientName: name, mrNo, patientUpdatedAt: String(patient.updated_at || "") };
          await writeArchives(archives);
        }
        continue;
      }
    }
    onProgress?.("Preparing patient image PDF " + (i + 1) + "/" + patients.length + ": " + name);
    const embedded: string[] = [];
    for (const source of sources) embedded.push(await toEmbeddableImage(source));
    const html = makeHtml(name, mrNo, embedded);
    const generated = await Print.printToFileAsync({ html, base64: false });
    const fileName = fileNameFor(name, mrNo, id);
    const target = ARCHIVE_DIR + fileName;
    const oldTarget = await FileSystem.getInfoAsync(target);
    if (oldTarget.exists) await FileSystem.deleteAsync(target, { idempotent: true });
    await FileSystem.copyAsync({ from: generated.uri, to: target });
    const info = await FileSystem.getInfoAsync(target);
    if (!info.exists || Number(info.size || 0) < 8) throw new Error("Could not verify patient image PDF for " + name + ". The master backup was not advanced.");
    archives[id] = {
      patientId: id, patientName: name, mrNo, fileName, localUri: target,
      sourceStamp: stamp, archivedAt: new Date().toISOString(), imageCount: embedded.length,
      patientUpdatedAt: String(patient.updated_at || ""),
      // Preserve this patient's remote file ID so the uploader updates the same Drive file.
      driveFileId: existing?.driveFileId,
      driveSourceStamp: existing?.driveSourceStamp,
    };
    await writeArchives(archives);
    changed = true;
    try { await FileSystem.deleteAsync(generated.uri, { idempotent: true }); } catch {}
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  return changed;
}

export async function createPatientImagePdfFile(patient: { id?: string; name?: string; mrNo?: string }, sources: string[]): Promise<string> {
  const uniqueSources = Array.from(new Set((sources || []).filter((value): value is string => typeof value === "string" && value.trim().length > 0)));
  if (!uniqueSources.length) throw new Error("This patient has no images to put in a PDF.");
  if (!FileSystem.documentDirectory) throw new Error("Private phone storage is unavailable for patient PDFs.");
  await FileSystem.makeDirectoryAsync(ARCHIVE_DIR, { intermediates: true });
  const name = String(patient.name || "Patient");
  const mrNo = String(patient.mrNo || "");
  const embedded: string[] = [];
  for (let i = 0; i < uniqueSources.length; i++) {
    embedded.push(await toEmbeddableImage(uniqueSources[i]));
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  const generated = await Print.printToFileAsync({ html: makeHtml(name, mrNo, embedded), base64: false });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const patientPart = safePart(String(patient.id || "manual")).slice(-10);
  const fileName = safePart(name) + (mrNo ? " - MR-" + safePart(mrNo) : "") + " - Images-" + patientPart + "-" + stamp + ".pdf";
  const target = ARCHIVE_DIR + fileName;
  try {
    const sourceInfo = await FileSystem.getInfoAsync(generated.uri);
    if (!sourceInfo.exists || Number(sourceInfo.size || 0) < 8) throw new Error("The PDF generator returned an empty patient PDF.");
    await FileSystem.copyAsync({ from: generated.uri, to: target });
    const targetInfo = await FileSystem.getInfoAsync(target);
    if (!targetInfo.exists || Number(targetInfo.size || 0) !== Number(sourceInfo.size || 0)) {
      await FileSystem.deleteAsync(target, { idempotent: true }).catch(() => {});
      throw new Error("The patient PDF could not be verified after saving.");
    }
    return target;
  } finally {
    try { await FileSystem.deleteAsync(generated.uri, { idempotent: true }); } catch {}
  }
}

export async function removePatientImageArchive(patientId: string): Promise<void> {
  const id = String(patientId || "").trim();
  if (!id) return;
  const all = await readArchives();
  const item = all[id];
  delete all[id];
  await writeArchives(all);
  if (item?.localUri) {
    try { await FileSystem.deleteAsync(item.localUri, { idempotent: true }); } catch {}
  }
}

export async function openPatientImageArchivePdf(patientId: string): Promise<void> {
  const archive = await getPatientImageArchive(patientId);
  if (!archive) throw new Error("No archived image PDF is available for this patient yet. Connect backup and let the automatic archive finish.");
  if (!(await Sharing.isAvailableAsync())) throw new Error("PDF sharing is not available on this device.");
  const shareUri = archive.localUri.startsWith("file://") || archive.localUri.startsWith("content://")
    ? archive.localUri
    : `file://${archive.localUri}`;
  try {
    await Sharing.shareAsync(shareUri, { mimeType: "application/pdf", UTI: "com.adobe.pdf", dialogTitle: archive.fileName });
  } catch (err: any) {
    const msg = String(err?.message || err || "");
    if (!/cancel|dismiss|abort|User did not share/i.test(msg)) {
      throw new Error(msg.includes("rejected") ? "Could not open the share sheet. Try again." : msg);
    }
  }
}
