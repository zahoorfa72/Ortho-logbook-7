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

const BACKUP_FILE_NAME = "ortho-logbook-backup.orbackup";

export async function createBackupFile(password: string, filter: BackupFilter = { type: "all" }) {
  const encryptedBackup = await exportBackup(password, filter);
  const file = new File(Paths.cache, BACKUP_FILE_NAME);
  if (file.exists) file.delete();
  file.create();
  file.write(encryptedBackup);
  return file.uri;
}

export async function saveBackupToPhone(password: string, filter: BackupFilter = { type: "all" }) {
  const encryptedBackup = await exportBackup(password, filter);

  // Android's Storage Access Framework lets the user choose a real folder
  // such as Downloads, Documents, or another folder in the phone's File Manager.
  const permissions = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
  if (!permissions.granted) {
    throw new Error("Save cancelled. Please choose a folder in the phone's File Manager.");
  }

  const fileUri = await FileSystem.StorageAccessFramework.createFileAsync(
    permissions.directoryUri,
    BACKUP_FILE_NAME,
    "application/octet-stream",
  );
  await FileSystem.writeAsStringAsync(fileUri, encryptedBackup);
  await markBackupTaken();
  return fileUri;
}

export async function shareBackupFile(password: string, filter: BackupFilter = { type: "all" }) {
  const fileUri = await createBackupFile(password, filter);
  const available = await Sharing.isAvailableAsync();

  if (!available) {
    throw new Error("File sharing is not available on this device.");
  }

  await Sharing.shareAsync(fileUri, {
    mimeType: "application/octet-stream",
    dialogTitle: "Save Ortho Logbook Backup",
    UTI: "public.data",
  });

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
  // A whole-file JSON/encrypted backup is currently decoded in memory. Avoid
  // triggering Android's hard heap limit and never retry the same huge read
  // through multiple APIs after an allocation failure.
  const MAX_SAFE_IN_MEMORY_BACKUP_BYTES = 48 * 1024 * 1024;
  if (typeof knownSize === "number" && knownSize > MAX_SAFE_IN_MEMORY_BACKUP_BYTES) {
    throw new Error(
      "This backup is too large for the current phone restore reader (" +
        Math.round(knownSize / (1024 * 1024)) +
        " MB). Keep this file unchanged. Restore it from a smaller backup for now; large all-time backups need the new split-backup restore format.",
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
        ? `Android could not read this selected file (${detail.message}). Try selecting the original .orbackup file again.`
        : "Android could not read the selected file. Try selecting the original .orbackup file again.",
    );
  }
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
      "Could not read the selected backup (" + detail + "). Re-select the original .orbackup file from Downloads or Files and try again.",
    );
  }

  // Some Android document providers prepend a UTF-8 BOM. JSON.parse rejects
  // that invisible character, even when the backup itself is otherwise valid.
  backupText = backupText.replace(/^\uFEFF/, "").trimStart();

  // Quick pre-check so we can give a much clearer error than "invalid JSON".
  const trimmed = backupText.trim();
  if (!trimmed.startsWith("{")) {
    throw new Error(
      "That file is not an Ortho Logbook backup. Please pick a .orbackup file created from this app.",
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
