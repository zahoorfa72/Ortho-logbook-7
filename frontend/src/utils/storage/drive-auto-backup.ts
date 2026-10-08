import * as SQLite from "expo-sqlite";
import {
  backupToGoogleDrive,
  getConnectedGoogleAccount,
  getStoredAutoBackupPassword,
} from "@/src/utils/storage/google-drive";

const DEBOUNCE_MS = 3000;
let timer: ReturnType<typeof setTimeout> | null = null;
let uploading = false;
let pending = false;

async function runBackup() {
  if (uploading) {
    pending = true;
    return;
  }

  const password = await getStoredAutoBackupPassword();
  // Automatic backup is opt-in: the user must have connected Drive and
  // completed at least one manual backup so the encryption password exists.
  if (!password || !getConnectedGoogleAccount()) return;

  uploading = true;
  pending = false;
  try {
    await backupToGoogleDrive(password, { type: "all" });
  } catch (error) {
    // Never block or crash the app because Drive is offline/unavailable.
    console.warn("[drive-auto-backup] sync failed:", error);
  } finally {
    uploading = false;
    if (pending) scheduleBackup();
  }
}

function scheduleBackup() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void runBackup();
  }, DEBOUNCE_MS);
}

export function startAutomaticDriveBackup() {
  const subscription = SQLite.addDatabaseChangeListener(() => {
    scheduleBackup();
  });

  return () => {
    subscription.remove();
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
