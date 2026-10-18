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
  for (const source of sources) {
    signatures.push(source.length + ":" + source.slice(0, 96) + ":" + source.slice(-96));
  }
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256,
    JSON.stringify([id, name, mrNo, createdAt, signatures]));
}
function makeHtml(name: string, mrNo: string, images: string[]): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return "<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><style>" +
    "@page{size:A4;margin:12mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#111;margin:0}" +
    ".head{font-size:16px;font-weight:700;margin:0 0 5px}.meta{font-size:10px;color:#555;margin-bottom:12px}" +
    ".photo{height:255mm;display:flex;align-items:center;justify-content:center;page-break-after:always;break-after:page;overflow:hidden}" +
    ".photo:last-child{page-break-after:auto;break-after:auto}img{max-width:100%;max-height:100%;object-fit:contain;image-orientation:from-image}" +
    "</style></head><body>" + images.map((src, index) =>
      "<section class='photo'><div style='width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center'>" +
      "<div style='align-self:flex-start;width:100%'><div class='head'>" + esc(name || "Patient") + "</div><div class='meta'>MR No: " + esc(mrNo || "—") +
      " · Image " + (index + 1) + " of " + images.length + "</div></div><img src='" + src.replace(/'/g, "%27") + "' /></div></section>"
    ).join("") + "</body></html>";
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
export async function installPatientImageArchivePdf(
  metadata: Omit<PatientImageArchive, "localUri"> & { localUri?: string },
  sourceUri: string,
): Promise<void> {
  if (!FileSystem.documentDirectory) throw new Error("Private phone storage is unavailable for patient image PDFs.");
  await FileSystem.makeDirectoryAsync(ARCHIVE_DIR, { intermediates: true });
  const target = ARCHIVE_DIR + metadata.fileName;
  const targetBefore = await FileSystem.getInfoAsync(target);
  if (targetBefore.exists) await FileSystem.deleteAsync(target, { idempotent: true });
  const sourceInfo = await FileSystem.getInfoAsync(sourceUri);
  if (!sourceInfo.exists || Number(sourceInfo.size || 0) < 8) throw new Error("The patient image PDF is missing or empty.");
  await FileSystem.copyAsync({ from: sourceUri, to: target });
  const targetInfo = await FileSystem.getInfoAsync(target);
  if (!targetInfo.exists || Number(targetInfo.size || 0) !== Number(sourceInfo.size || 0)) {
    throw new Error("The patient image PDF could not be verified after saving to this phone.");
  }
  const all = await readArchives();
  all[String(metadata.patientId)] = { ...all[String(metadata.patientId)], ...metadata, localUri: target };
  await writeArchives(all);
}
export async function archivePatientImagesForPatient(patientId: string, onProgress?: (stage: string) => void): Promise<PatientImageArchive> {
  initializeDatabase();
  const id = String(patientId || "").trim();
  if (!id) throw new Error("Save this patient before creating an image PDF.");
  if (!FileSystem.documentDirectory) throw new Error("Private phone storage is unavailable for patient image archives.");
  const patient = db.getFirstSync<any>("SELECT id,name,mr_no,date,created_at FROM patients WHERE id=?", [id]);
  if (!patient) throw new Error("This patient is not available in the phone database. Refresh the patient list and try again.");
  const row = db.getFirstSync<any>("SELECT photo_uri,photos_json FROM patients WHERE id=?", [id]) || {};
  const sources = getPhotoSources(row);
  if (!sources.length) throw new Error("No readable patient images are saved for this patient on this phone.");
  const name = String(patient.name || "Patient");
  const mrNo = String(patient.mr_no || "");
  const stamp = await stampFor(id, name, mrNo, String(patient.created_at || patient.date || ""), sources);
  const all = await readArchives();
  const existing = all[id];
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
      driveFileId: existing?.sourceStamp === stamp ? existing.driveFileId : undefined,
      driveSourceStamp: existing?.sourceStamp === stamp ? existing.driveSourceStamp : undefined,
    }, generated.uri);
  } finally {
    try { await FileSystem.deleteAsync(generated.uri, { idempotent: true }); } catch {}
  }
  const saved = await getPatientImageArchive(id);
  if (!saved) throw new Error("The patient PDF was generated but could not be verified in phone storage.");
  return saved;
}

export async function archiveEligiblePatientImages(onProgress?: (stage: string) => void): Promise<boolean> {
  initializeDatabase();
  if (!FileSystem.documentDirectory) throw new Error("Private phone storage is unavailable for patient image archives.");
  await FileSystem.makeDirectoryAsync(ARCHIVE_DIR, { intermediates: true });
  const patients = db.getAllSync<any>("SELECT id,name,mr_no,date,created_at FROM patients ORDER BY created_at ASC");
  const archives = await readArchives();
  let changed = false;
  for (let i = 0; i < patients.length; i++) {
    const patient = patients[i];
    const id = String(patient.id || "");
    if (!id) continue;
    const row = db.getFirstSync<any>("SELECT photo_uri,photos_json FROM patients WHERE id=?", [id]) || {};
    const sources = getPhotoSources(row);
    if (!sources.length) continue;
    const name = String(patient.name || "Patient");
    const mrNo = String(patient.mr_no || "");
    const stamp = await stampFor(id, name, mrNo, String(patient.created_at || patient.date || ""), sources);
    const existing = archives[id];
    if (existing?.sourceStamp === stamp) {
      const info = await FileSystem.getInfoAsync(existing.localUri);
      if (info.exists && Number(info.size || 0) > 8) continue;
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
      driveFileId: existing?.driveFileId, driveSourceStamp: existing?.driveSourceStamp,
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
  await Sharing.shareAsync(archive.localUri, { mimeType: "application/pdf", UTI: "com.adobe.pdf", dialogTitle: archive.fileName });
}
