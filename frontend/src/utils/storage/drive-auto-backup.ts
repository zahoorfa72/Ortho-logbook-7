import * as SQLite from "expo-sqlite";
import {
  backupToGoogleDrive,
  getConnectedGoogleAccount,
} from "@/src/utils/storage/google-drive";
import { setDriveSyncState } from "@/src/utils/storage/drive-sync-status";

const DEBOUNCE_MS = 5000;
const RETRY_AFTER_UPLOAD_MS = 1500;
let timer: ReturnType<typeof setTimeout> | null = null;
let uploading = false;
let pendingUpdates = 0;
let disposed = false;

function scheduleBackup(updateCount = 1) {
  if (disposed) return;
  pendingUpdates += updateCount;
  if (!getConnectedGoogleAccount()) return;

  if (uploading) {
    setDriveSyncState({
      phase: "uploading",
      updates: pendingUpdates,
      message: pendingUpdates > 0
        ? `Uploading backup · ${pendingUpdates} change(s) queued`
        : "Uploading backup…",
    });
    return;
  }

  if (timer) clearTimeout(timer);
  setDriveSyncState({
    phase: "waiting",
    updates: pendingUpdates,
    message: pendingUpdates > 0
      ? `Sync pending · ${pendingUpdates} update(s)`
      : "Checking Drive backup…",
  });
  timer = setTimeout(() => {
    timer = null;
    void runBackup();
  }, DEBOUNCE_MS);
}

async function runBackup() {
  if (disposed || uploading) return;
  if (!getConnectedGoogleAccount()) {
    setDriveSyncState({ phase: "idle", updates: 0, message: "" });
    return;
  }

  uploading = true;
  const updatesForThisUpload = pendingUpdates;
  pendingUpdates = 0;
  setDriveSyncState({
    phase: "uploading",
    updates: updatesForThisUpload,
    message: updatesForThisUpload > 0
      ? `Uploading backup · ${updatesForThisUpload} update(s)`
      : "Checking and syncing backup…",
  });

  try {
    const result = await backupToGoogleDrive(undefined, { type: "all" }, { skipIfUnchanged: true });
    const completedAt = result.completedAt
      ? new Date(result.completedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "";
    setDriveSyncState({
      phase: "success",
      updates: 0,
      message: result.skipped
        ? `Drive up to date${completedAt ? ` · ${completedAt}` : ""}`
        : `Backup uploaded${completedAt ? ` · ${completedAt}` : ""}`,
    });
  } catch (error) {
    console.warn("[drive-auto-backup] sync failed:", error);
    setDriveSyncState({
      phase: "error",
      updates: pendingUpdates,
      message: "Drive sync failed · changes remain on this phone",
    });
  } finally {
    uploading = false;
    if (pendingUpdates > 0 && !disposed) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void runBackup();
      }, RETRY_AFTER_UPLOAD_MS);
    }
  }
}

export function triggerAutomaticDriveBackup() {
  scheduleBackup(0);
}

export function startAutomaticDriveBackup() {
  disposed = false;
  const subscription = SQLite.addDatabaseChangeListener(() => {
    scheduleBackup(1);
  });

  // Check once at startup; subsequent uploads only happen after real DB changes.
  scheduleBackup(0);

  return () => {
    disposed = true;
    subscription.remove();
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
