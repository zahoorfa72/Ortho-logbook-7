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
async function readPickedFile(uri: string): Promise<string> {
  const errors: unknown[] = [];

  try {
    return await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.UTF8,
    });
  } catch (error) {
    errors.push(error);
  }

  try {
    return await new File(uri).text();
  } catch (error) {
    errors.push(error);
  }

  try {
    const response = await fetch(uri);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (error) {
    errors.push(error);
  }

  const detail = errors.find((error) => error instanceof Error) as Error | undefined;
  throw new Error(
    detail?.message
      ? `Android could not read this selected file (${detail.message}). Try selecting the original .orbackup file again.`
      : "Android could not read the selected file. Try selecting the original .orbackup file again.",
  );
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
    backupText = await readPickedFile(file.uri);
  } catch {
    throw new Error(
      "Could not open the selected file. Please copy the .orbackup file to your phone's internal storage (e.g. the Downloads folder) and try again.",
    );
  }

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
