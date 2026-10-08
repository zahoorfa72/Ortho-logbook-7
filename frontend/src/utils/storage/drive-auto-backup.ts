import * as SQLite from "expo-sqlite";
import {
  backupToGoogleDrive,
  getConnectedGoogleAccount,
} from "@/src/utils/storage/google-drive";

const DEBOUNCE_MS = 5000;
let timer: ReturnType<typeof setTimeout> | null = null;
let uploading = false;

async function runBackup() {
  if (uploading) return;
  // Drive is optional. If no account is connected or the phone is offline,
  // leave all local data untouched and try again after the next change/startup.
  if (!getConnectedGoogleAccount()) return;

  uploading = true;
  try {
    await backupToGoogleDrive(undefined, { type: "all" });
  } catch (error) {
    console.warn("[drive-auto-backup] sync failed:", error);
  } finally {
    uploading = false;
  }
}

function scheduleBackup() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void runBackup();
  }, DEBOUNCE_MS);
}

export function triggerAutomaticDriveBackup() {
  scheduleBackup();
}

export function startAutomaticDriveBackup() {
  const subscription = SQLite.addDatabaseChangeListener(() => {
    scheduleBackup();
  });
  // Also sync on app startup, so edits made while offline are not stranded
  // waiting for another database change once Drive is available.
  scheduleBackup();

  return () => {
    subscription.remove();
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
