import { File, Paths } from "expo-file-system";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import * as DocumentPicker from "expo-document-picker";
import { Platform } from "react-native";

import {
  exportBackup,
  getBackupInfo,
  type BackupFilter,
} from "@/src/utils/storage/backup";
import { markBackupTaken } from "@/src/utils/backup-reminder";
import { getLocalPatientImageArchives, getPatientImageArchive, installPatientImageArchivePdf } from "@/src/utils/storage/patient-image-archive";

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

// Export archived patient-image PDFs independently of the encrypted database backup.
// Files are copied byte-for-byte into a user-selected phone folder; source PDFs are not recompressed.
export async function savePatientImageArchivesToPhone(): Promise<{ saved: number; folderUri: string }> {
  const archives = await getLocalPatientImageArchives();
  if (!archives.length) throw new Error("There are no archived patient-image PDFs on this phone yet.");
  const permissions = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
  if (!permissions.granted) throw new Error("Download cancelled. Please choose a folder in the phone's File Manager.");
  const folderUri = await getOrCreateSafFolder(permissions.directoryUri, "Patient Image PDFs");
  let saved = 0;
  for (const archive of archives) {
    const sourceInfo: any = await FileSystem.getInfoAsync(archive.localUri);
    if (!sourceInfo.exists || Number(sourceInfo.size || 0) < 8) {
      throw new Error("Patient PDF is missing or empty: " + archive.fileName + ". " + saved + " PDF(s) were saved before this error.");
    }
    const existing = await findSafChild(folderUri, archive.fileName);
    const target = existing || await FileSystem.StorageAccessFramework.createFileAsync(folderUri, archive.fileName, "application/pdf");
    const base64 = await FileSystem.readAsStringAsync(archive.localUri, { encoding: FileSystem.EncodingType.Base64 });
    await FileSystem.writeAsStringAsync(target, base64, { encoding: FileSystem.EncodingType.Base64 });
    const verified: any = await FileSystem.getInfoAsync(target);
    if (!verified.exists || (typeof verified.size === "number" && verified.size !== Number(sourceInfo.size || 0))) {
      throw new Error("Could not verify downloaded patient PDF: " + archive.fileName + ". " + saved + " PDF(s) were saved.");
    }
    saved++;
  }
  return { saved, folderUri };
}

export async function shareBackupFile(password: string, filter: BackupFilter = { type: "all" }) {
  const fileUri = await createBackupFile(password, filter);
  const fileInfo: any = await FileSystem.getInfoAsync(fileUri);
  if (!fileInfo.exists || Number(fileInfo.size || 0) <= 0) throw new Error("The encrypted backup file could not be verified before sharing. Use Save Backup to Phone and retry.");
  const available = await Sharing.isAvailableAsync();
  if (!available) throw new Error("File sharing is not available on this device. Use Save Backup to Phone to save a verified copy.");
  try {
    await Sharing.shareAsync(fileUri, {
      mimeType: Platform.OS === "android" ? "application/octet-stream" : "application/json",
      dialogTitle: "Save Ortho Logbook Backup",
      ...(Platform.OS === "ios" ? { UTI: "public.data" } : {}),
    });
  } catch (error: any) {
    throw new Error("Android could not open the share sheet (" + String(error?.message || error) + "). The encrypted file was created but not shared; use Save Backup to Phone.");
  }
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
    if (item?.patientId && item?.fileName) refs.set(String(item.fileName), item);
  }
  for (const patient of Array.isArray(backup?.patients) ? backup.patients : []) {
    if (patient?.id && patient?.photo_archive_file_name) {
      const fileName = String(patient.photo_archive_file_name);
      if (!refs.has(fileName)) refs.set(fileName, {
        patientId: String(patient.id), patientName: String(patient.name || "Patient"), mrNo: String(patient.mr_no || ""),
        fileName, sourceStamp: String(patient.photo_archive_source_stamp || ""),
        archivedAt: String(patient.photo_archived_at || ""), imageCount: Number(patient.photo_archive_image_count || 0),
      });
    }
  }
  const missing: any[] = [];
  for (const ref of refs.values()) {
    const local = await getPatientImageArchive(String(ref.patientId));
    if (local && local.sourceStamp === String(ref.sourceStamp || "")) continue;
    missing.push(ref);
  }
  if (!missing.length) return [];
  const selected = await DocumentPicker.getDocumentAsync({
    type: ["application/pdf", "application/octet-stream"], copyToCacheDirectory: true, multiple: true,
  });
  // Patient PDFs are optional attachments, stored separately from encrypted phone
  // data. Cancelling must not block patient, inventory, account or settings restore.
  if (selected.canceled) return missing.map(ref => String(ref.fileName));
  const assets = selected.assets || [];
  const byName = new Map<string, any>(assets.filter((item:any) => item?.name && item?.uri).map((item:any) => [String(item.name), item]));
  const absent: string[] = [];
  for (const ref of missing) {
    const asset = byName.get(String(ref.fileName));
    if (!asset) {
      absent.push(String(ref.fileName));
      continue;
    }
    try {
      await installPatientImageArchivePdf({
        patientId: String(ref.patientId), patientName: String(ref.patientName || "Patient"),
        mrNo: String(ref.mrNo || ""), fileName: String(ref.fileName),
        sourceStamp: String(ref.sourceStamp || ""), archivedAt: String(ref.archivedAt || ""),
        imageCount: Number(ref.imageCount || 0),
      }, String(asset.uri));
    } catch {
      absent.push(String(ref.fileName));
    }
  }
  return absent;
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
