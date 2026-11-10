import { File, Paths } from "expo-file-system";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import * as DocumentPicker from "expo-document-picker";

import {
  exportBackup,
  getBackupInfo,
  type BackupFilter,
} from "@/src/utils/storage/backup";
import { markBackupTaken } from "@/src/utils/backup-reminder";
import { buildAllPatientImageArchivesManually, getLocalPatientImageArchives, getPatientImageArchive, installPatientImageArchivePdf, type PatientImageArchive } from "@/src/utils/storage/patient-image-archive";

const BACKUP_FILE_NAME = "ortho-logbook-backup.orbackup.json";

export async function createBackupFile(password: string, filter: BackupFilter = { type: "all" }) {
  const encryptedBackup = await exportBackup(password, filter);
  const file = new File(Paths.cache, BACKUP_FILE_NAME);
  if (file.exists) file.delete();
  file.create();
  file.write(encryptedBackup);
  return file.uri;
}

async function findSafChild(parentUri: string, name: string): Promise<string | null> {
  try {
    const children = await FileSystem.StorageAccessFramework.readDirectoryAsync(parentUri);
    for (const uri of children) {
      const info: any = await FileSystem.getInfoAsync(uri);
      if (String(info?.name || "") === name || uri.endsWith(encodeURIComponent(name))) return uri;
    }
  } catch {}
  return null;
}
async function getOrCreateSafFolder(parentUri: string, name: string): Promise<string> {
  const existing = await findSafChild(parentUri, name);
  if (existing) return existing;
  return await FileSystem.StorageAccessFramework.makeDirectoryAsync(parentUri, name);
}
export async function saveBackupToPhone(password: string, filter: BackupFilter = { type: "all" }) {
  const encryptedBackup = await exportBackup(password, filter);
  // Validate the generated envelope before opening the system file picker.
  const generatedInfo = getBackupInfo(encryptedBackup);
  if (!generatedInfo.encrypted) throw new Error("The phone backup was not encrypted; no file was saved.");

  const permissions = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
  if (!permissions.granted) throw new Error("Save cancelled. Please choose a folder in the phone's File Manager.");

  // Phone backup is data-only: patient photos and inventory bill images are not
  // embedded. Use a unique filename instead of rewriting an existing SAF file:
  // some Android document providers leave stale trailing bytes on overwrite,
  // making a freshly created backup fail JSON validation during restore.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = "ortho-logbook-backup-" + stamp + ".orbackup.json";
  const fileUri = await FileSystem.StorageAccessFramework.createFileAsync(
    permissions.directoryUri, fileName, "application/json");
  await FileSystem.writeAsStringAsync(fileUri, encryptedBackup);

  // Read the saved file back and validate the actual bytes, not just the
  // in-memory payload. Do not report success if Android saved a truncated or
  // malformed backup.
  const savedText = await FileSystem.readAsStringAsync(fileUri, { encoding: FileSystem.EncodingType.UTF8 });
  const savedInfo = getBackupInfo(savedText.replace(/^\uFEFF/, "").trimStart());
  if (!savedInfo.encrypted || savedInfo.version !== generatedInfo.version ||
      savedText.trim() !== encryptedBackup.trim()) {
    throw new Error("The phone backup file failed read-back validation. The file was kept for diagnosis; please save a new backup and do not delete your existing backups.");
  }
  await markBackupTaken();
  return fileUri;
}

/**
 * Build/update all eligible patient PDFs only after the admin presses the
 * manual export button, then save them into one selected folder. The manifest
 * binds each filename to its exact patient ID and image source stamp.
 */
export async function buildAndSaveAllPatientImagePdfsToPhone(
  onProgress?: (stage: string) => void,
): Promise<{ created: number; updated: number; unchanged: number; skippedEmpty: number; saved: number; folderUri: string; manifestName: string }> {
  const build = await buildAllPatientImageArchivesManually(onProgress);
  const archives = await getLocalPatientImageArchives();
  const permissions = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
  if (!permissions.granted) throw new Error("Save cancelled. Choose a folder in the phone's File Manager.");
  const folderUri = await getOrCreateSafFolder(permissions.directoryUri, "Patient Image PDFs");
  const manifestName = "patient-image-pdf-manifest.json";
  let saved = 0;
  const manifest: any = {
    format: "ortho-patient-image-pdf-bundle",
    version: 1,
    createdAt: new Date().toISOString(),
    patients: [],
  };
  for (let index = 0; index < archives.length; index++) {
    const archive = archives[index];
    const sourceInfo: any = await FileSystem.getInfoAsync(archive.localUri);
    if (!sourceInfo.exists || Number(sourceInfo.size || 0) < 8) {
      throw new Error("Patient PDF is missing or empty: " + archive.fileName);
    }
    const sourceBase64 = await FileSystem.readAsStringAsync(archive.localUri, { encoding: FileSystem.EncodingType.Base64 });
    if (!sourceBase64.startsWith("JVBERi0")) throw new Error("Invalid PDF signature for " + archive.fileName);
    const existing = await findSafChild(folderUri, archive.fileName);
    const target = existing || await FileSystem.StorageAccessFramework.createFileAsync(folderUri, archive.fileName, "application/pdf");
    await FileSystem.writeAsStringAsync(target, sourceBase64, { encoding: FileSystem.EncodingType.Base64 });
    const verified: any = await FileSystem.getInfoAsync(target);
    if (!verified.exists || (typeof verified.size === "number" && verified.size !== Number(sourceInfo.size || 0))) {
      throw new Error("Could not verify saved patient PDF: " + archive.fileName);
    }
    manifest.patients.push({
      patientId: archive.patientId,
      patientName: archive.patientName,
      mrNo: archive.mrNo,
      fileName: archive.fileName,
      sourceStamp: archive.sourceStamp,
      archivedAt: archive.archivedAt,
      imageCount: archive.imageCount,
      size: Number(sourceInfo.size || 0),
    });
    saved++;
    onProgress?.("Saved patient PDF " + (index + 1) + "/" + archives.length);
  }
  const manifestJson = JSON.stringify(manifest, null, 2);
  const manifestExisting = await findSafChild(folderUri, manifestName);
  const manifestUri = manifestExisting || await FileSystem.StorageAccessFramework.createFileAsync(folderUri, manifestName, "application/json");
  await FileSystem.writeAsStringAsync(manifestUri, manifestJson, { encoding: FileSystem.EncodingType.UTF8 });
  const check = await FileSystem.readAsStringAsync(manifestUri, { encoding: FileSystem.EncodingType.UTF8 });
  const parsed = JSON.parse(check);
  if (parsed?.format !== "ortho-patient-image-pdf-bundle" || parsed?.patients?.length !== saved) {
    throw new Error("Patient PDF manifest failed read-back validation.");
  }
  return { ...build, saved, folderUri, manifestName };
}

/**
 * Manual export entry point. No app lifecycle or background task calls this.
 * Each patient is archived by stable database ID, then exported with a manifest.
 */
export async function buildAndSaveAllPatientImagePdfsToPhone(
  onProgress?: (stage: string) => void,
): Promise<{ created: number; updated: number; unchanged: number; skippedEmpty: number; saved: number; folderUri: string; manifestName: string }> {
  const build = await buildAllPatientImageArchivesManually(onProgress);
  const archives = await getLocalPatientImageArchives();
  const permissions = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
  if (!permissions.granted) throw new Error("Save cancelled. Choose a folder in the phone's File Manager.");
  const folderUri = await getOrCreateSafFolder(permissions.directoryUri, "Patient Image PDFs");
  const manifestName = "patient-image-pdf-manifest.json";
  let saved = 0;
  const manifest: any = { format: "ortho-patient-image-pdf-bundle", version: 1, createdAt: new Date().toISOString(), patients: [] };
  for (let index = 0; index < archives.length; index++) {
    const archive = archives[index];
    const sourceInfo: any = await FileSystem.getInfoAsync(archive.localUri);
    if (!sourceInfo.exists || Number(sourceInfo.size || 0) < 8) throw new Error("Patient PDF is missing or empty: " + archive.fileName);
    const sourceBase64 = await FileSystem.readAsStringAsync(archive.localUri, { encoding: FileSystem.EncodingType.Base64 });
    if (!sourceBase64.startsWith("JVBERi0")) throw new Error("Invalid PDF signature for " + archive.fileName);
    const existing = await findSafChild(folderUri, archive.fileName);
    const target = existing || await FileSystem.StorageAccessFramework.createFileAsync(folderUri, archive.fileName, "application/pdf");
    await FileSystem.writeAsStringAsync(target, sourceBase64, { encoding: FileSystem.EncodingType.Base64 });
    const verified: any = await FileSystem.getInfoAsync(target);
    if (!verified.exists || (typeof verified.size === "number" && verified.size !== Number(sourceInfo.size || 0))) {
      throw new Error("Could not verify saved patient PDF: " + archive.fileName);
    }
    manifest.patients.push({
      patientId: archive.patientId, patientName: archive.patientName, mrNo: archive.mrNo,
      fileName: archive.fileName, sourceStamp: archive.sourceStamp, archivedAt: archive.archivedAt,
      imageCount: archive.imageCount, size: Number(sourceInfo.size || 0),
    });
    saved++;
    onProgress?.("Saved patient PDF " + (index + 1) + "/" + archives.length);
  }
  const manifestJson = JSON.stringify(manifest, null, 2);
  const existingManifest = await findSafChild(folderUri, manifestName);
  const manifestUri = existingManifest || await FileSystem.StorageAccessFramework.createFileAsync(folderUri, manifestName, "application/json");
  await FileSystem.writeAsStringAsync(manifestUri, manifestJson, { encoding: FileSystem.EncodingType.UTF8 });
  const verifiedManifest = JSON.parse(await FileSystem.readAsStringAsync(manifestUri, { encoding: FileSystem.EncodingType.UTF8 }));
  if (verifiedManifest?.format !== "ortho-patient-image-pdf-bundle" || verifiedManifest?.patients?.length !== saved) {
    throw new Error("Patient PDF manifest failed read-back validation.");
  }
  return { ...build, saved, folderUri, manifestName };
}

export async function shareBackupFile(password: string, filter: BackupFilter = { type: "all" }) {
  const fileUri = await createBackupFile(password, filter);
  const available = await Sharing.isAvailableAsync();

  if (!available) {
    throw new Error("File sharing is not available on this device.");
  }

  try {
    const shareUri = fileUri.startsWith("file://") || fileUri.startsWith("content://") ? fileUri : `file://${fileUri}`;
    await Sharing.shareAsync(shareUri, {
      mimeType: "application/json",
      dialogTitle: "Save Ortho Logbook Backup",
      UTI: "public.data",
    });
  } catch (err: any) {
    const msg = String(err?.message || err || "");
    if (/cancel|dismiss|abort|User did not share/i.test(msg)) {
      // User closed the share sheet — still treat as non-fatal.
      return fileUri;
    }
    throw new Error(msg.includes("rejected") ? "Could not open the share sheet for the backup. Try Save to phone instead." : msg || "Could not share backup file.");
  }

  // Assume the admin completed the share; record the timestamp so the
  // evening reminder stays quiet for the rest of the day.
  await markBackupTaken();

  return fileUri;
}

// Android document providers (Drive, Downloads, Files and OEM file managers)
// may return content:// URIs. Read those through Expo's legacy SAF-compatible
// API before trying the newer File API or fetch. Never require users to move
// a selected backup into app storage manually.
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? "");
}

function isOutOfMemoryError(error: unknown): boolean {
  return /OutOfMemoryError|Failed to allocate|out of memory|memory allocation/i.test(errorText(error));
}

async function readPickedFile(uri: string, knownSize?: number | null): Promise<string> {
  // Both .orbackup and .orbackup.json are accepted. The extension is only a filename suffix; both use the same JSON backup envelope. Legacy files are monolithic and must be decoded in memory.
  // Allow selecting large existing files (including ~712 MB files) so the
  // reader can make a best-effort attempt on high-memory devices. OOM remains
  // caught below; this does not make monolithic decryption streaming-safe.
  const MAX_SAFE_IN_MEMORY_BACKUP_BYTES = 768 * 1024 * 1024;
  if (typeof knownSize === "number" && knownSize > MAX_SAFE_IN_MEMORY_BACKUP_BYTES) {
    throw new Error(
      "This backup is too large for the current phone restore reader (" +
        Math.round(knownSize / (1024 * 1024)) +
        " MB). Keep this file unchanged. Restore it from a smaller backup for now; this device may not have enough memory for a monolithic backup.",
    );
  }

  try {
    return await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.UTF8,
    });
  } catch (error) {
    if (isOutOfMemoryError(error)) {
      throw new Error(
        "Android ran out of memory while opening this backup. Your local records have not been restored or intentionally deleted. Keep the backup unchanged; this large file needs a split-backup restore format.",
      );
    }

    // Only try another provider reader for ordinary URI/provider errors.
    // Repeating a huge read after an OOM can exhaust the app's remaining heap.
    const errors: unknown[] = [error];
    try {
      return await new File(uri).text();
    } catch (nextError) {
      if (isOutOfMemoryError(nextError)) {
        throw new Error(
          "Android ran out of memory while opening this backup. Your local records have not been restored or intentionally deleted. Keep the backup unchanged; this large file needs a split-backup restore format.",
        );
      }
      errors.push(nextError);
    }

    try {
      const response = await fetch(uri);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (nextError) {
      if (isOutOfMemoryError(nextError)) {
        throw new Error(
          "Android ran out of memory while opening this backup. Your local records have not been restored or intentionally deleted. Keep the backup unchanged; this large file needs a split-backup restore format.",
        );
      }
      errors.push(nextError);
    }

    const detail = errors.find((item) => item instanceof Error) as Error | undefined;
    throw new Error(
      detail?.message
        ? `Android could not read this selected file (${detail.message}). Try selecting the original .orbackup or .orbackup.json file again.`
        : "Android could not read the selected file. Try selecting the original .orbackup or .orbackup.json file again.",
    );
  }
}

export async function pickPatientImageArchivesForRestore(backup: any): Promise<string[]> {
  const refs = new Map<string, any>();
  for (const item of Array.isArray(backup?.patientImageArchives) ? backup.patientImageArchives : []) {
    if (item?.patientId && item?.fileName) refs.set(String(item.patientId), item);
  }
  for (const patient of Array.isArray(backup?.patients) ? backup.patients : []) {
    if (patient?.id && patient?.photo_archive_file_name) {
      const patientId = String(patient.id);
      if (!refs.has(patientId)) refs.set(patientId, {
        patientId, patientName: String(patient.name || "Patient"), mrNo: String(patient.mr_no || ""),
        fileName: String(patient.photo_archive_file_name),
        sourceStamp: String(patient.photo_archive_source_stamp || ""),
        archivedAt: String(patient.photo_archived_at || ""),
        imageCount: Number(patient.photo_archive_image_count || 0),
      });
    }
  }
  if (!refs.size) return [];
  const selected = await DocumentPicker.getDocumentAsync({
    type: "*/*", copyToCacheDirectory: true, multiple: true,
  });
  if (selected.canceled) return Array.from(refs.values()).map(ref => String(ref.fileName || ref.patientId));
  const assets = selected.assets || [];
  const manifestAsset = assets.find((asset: any) => String(asset?.name || "").toLowerCase() === "patient-image-pdf-manifest.json");
  if (!manifestAsset?.uri) {
    throw new Error("Select the Patient Image PDFs folder contents including patient-image-pdf-manifest.json. The manifest is required to prevent attaching a PDF to the wrong patient.");
  }
  const manifestText = await FileSystem.readAsStringAsync(manifestAsset.uri, { encoding: FileSystem.EncodingType.UTF8 });
  let manifest: any;
  try { manifest = JSON.parse(manifestText); } catch { throw new Error("Patient PDF manifest is not valid JSON."); }
  if (manifest?.format !== "ortho-patient-image-pdf-bundle" || manifest?.version !== 1 || !Array.isArray(manifest?.patients)) {
    throw new Error("Unsupported patient PDF bundle manifest.");
  }
  const byName = new Map<string, any>(assets.filter((item: any) => item?.name && item?.uri).map((item: any) => [String(item.name), item]));
  const manifestById = new Map<string, any>();
  for (const entry of manifest.patients) {
    const id = String(entry?.patientId || "");
    const fileName = String(entry?.fileName || "");
    if (!id || !fileName || manifestById.has(id)) throw new Error("Manifest has a missing or duplicate patient ID.");
    manifestById.set(id, entry);
  }
  const missing: string[] = [];
  const dbPatientIds = new Set((Array.isArray(backup?.patients) ? backup.patients : []).map((p: any) => String(p?.id || "")));
  for (const [patientId, ref] of refs.entries()) {
    const entry = manifestById.get(patientId);
    if (!entry) { missing.push(String(ref.fileName || patientId)); continue; }
    if (String(entry.fileName) !== String(ref.fileName || entry.fileName)) {
      throw new Error("Patient PDF filename does not match the backup manifest for patient " + patientId + ".");
    }
    if (ref.sourceStamp && entry.sourceStamp && String(ref.sourceStamp) !== String(entry.sourceStamp)) {
      throw new Error("Patient PDF image revision does not match the backup for patient " + patientId + ".");
    }
    const asset = byName.get(String(entry.fileName));
    if (!asset?.uri) { missing.push(String(entry.fileName)); continue; }
    // Never silently map an unknown patient ID or a mismatched MR number.
    if (dbPatientIds.size && !dbPatientIds.has(patientId)) {
      throw new Error("The PDF bundle contains a patient ID that is absent from the selected backup. Restore patient data first.");
    }
    try {
      await installPatientImageArchivePdf({
        patientId,
        patientName: String(ref.patientName || entry.patientName || "Patient"),
        mrNo: String(ref.mrNo || entry.mrNo || ""),
        fileName: String(entry.fileName),
        sourceStamp: String(entry.sourceStamp || ref.sourceStamp || ""),
        archivedAt: String(entry.archivedAt || ref.archivedAt || ""),
        imageCount: Number(entry.imageCount ?? ref.imageCount ?? 0),
      } as Omit<PatientImageArchive, "localUri">, String(asset.uri));
    } catch (error) {
      throw new Error("Could not restore PDF for patient " + patientId + ": " + (error instanceof Error ? error.message : String(error)));
    }
  }
  return missing;
}

export async function pickBackupFile() {
  // Accept any file type -- some Android file pickers refuse to show custom
  // extensions like .orbackup when a strict MIME type is set.
  const result = await DocumentPicker.getDocumentAsync({
    type: "*/*",
    copyToCacheDirectory: true,
    multiple: false,
  });

  if (result.canceled) return null;

  const file = result.assets[0];
  if (!file?.uri) {
    throw new Error("No backup file was selected.");
  }

  let backupText: string;
  try {
    backupText = await readPickedFile(file.uri, file.size);
  } catch (error) {
    // Keep the Android provider's actual failure reason. Hiding it behind a
    // generic message made Drive/Downloads import errors impossible to diagnose.
    const detail = error instanceof Error ? error.message : String(error || "unknown file-read error");
    throw new Error(
      "Could not read the selected backup (" + detail + "). Re-select the original .orbackup or .orbackup.json file from Downloads or Files and try again.",
    );
  }

  // Some Android document providers prepend a UTF-8 BOM. JSON.parse rejects
  // that invisible character, even when the backup itself is otherwise valid.
  backupText = backupText.replace(/^\uFEFF/, "").trimStart();

  // Quick pre-check so we can give a much clearer error than "invalid JSON".
  const trimmed = backupText.trim();
  if (!trimmed.startsWith("{")) {
    throw new Error(
      "That file is not an Ortho Logbook backup. Please pick a valid .orbackup or .orbackup.json file created from this app.",
    );
  }

  const info = getBackupInfo(backupText);

  return {
    uri: file.uri,
    name: file.name,
    backupText,
    info,
  };
}
