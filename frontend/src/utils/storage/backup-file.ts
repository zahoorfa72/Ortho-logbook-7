import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import * as DocumentPicker from "expo-document-picker";

import {
  exportBackup,
  getBackupInfo,
} from "@/src/utils/storage/backup";
import { markBackupTaken } from "@/src/utils/backup-reminder";

const BACKUP_FILE_NAME = "ortho-logbook-backup.orbackup";

export async function createBackupFile(password: string) {
  const encryptedBackup = await exportBackup(password);
  const file = new File(Paths.cache, BACKUP_FILE_NAME);
  if (file.exists) file.delete();
  file.create();
  file.write(encryptedBackup);
  return file.uri;
}

export async function shareBackupFile(password: string) {
  const fileUri = await createBackupFile(password);
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

// Read a picked file into text robustly. DocumentPicker with
// copyToCacheDirectory:true almost always gives us a file:// URI in the cache
// directory that File(uri).text() can read. On some Android file managers
// (older MIUI, some cloud providers) the URI is a content:// URI that
// File() can't open -- for those we fall back to fetch().
async function readPickedFile(uri: string): Promise<string> {
  try {
    const file = new File(uri);
    return await file.text();
  } catch (primaryErr) {
    try {
      const response = await fetch(uri);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch {
      throw primaryErr instanceof Error ? primaryErr : new Error("Unable to read the selected file.");
    }
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
