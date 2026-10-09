import * as SQLite from "expo-sqlite";
import {
  backupToGoogleDrive,
  getConnectedGoogleAccount,
  restoreGoogleAccountSilently,
} from "@/src/utils/storage/google-drive";
import { setDriveSyncState } from "@/src/utils/storage/drive-sync-status";

const DEBOUNCE_MS = 5000;
let timer: ReturnType<typeof setTimeout> | null = null;
let uploading = false;
let pendingUpdates = 0;
let disposed = false;

function scheduleBackup(updateCount = 1) {
  if (disposed) return;
  pendingUpdates += updateCount;
  // Keep changes queued even if Google is not connected right now.

  // Do not emit a new UI state for every SQLite write while uploading.
  // Just count changes; a single follow-up backup will run after the debounce.
  if (uploading) return;

  if (timer) clearTimeout(timer);
  setDriveSyncState({
    phase: "waiting",
    updates: pendingUpdates,
    message: pendingUpdates > 0
      ? "Changes waiting to sync"
      : "Checking Drive backup…",
  });
  timer = setTimeout(() => {
    timer = null;
    void runBackup();
  }, DEBOUNCE_MS);
}

async function runBackup() {
  if (disposed || uploading) return;
  // Android can retain the Google authorization while the JS current-user
  // cache is empty after a restart. Recover it without prompting the user.
  if (!getConnectedGoogleAccount()) await restoreGoogleAccountSilently();
  if (!getConnectedGoogleAccount()) {
    setDriveSyncState({
      phase: "idle",
      updates: pendingUpdates,
      message: pendingUpdates > 0 ? "Changes saved on this phone · connect Google to upload" : "",
    });
    return;
  }

  uploading = true;
  const updatesForThisUpload = pendingUpdates;
  pendingUpdates = 0;
  setDriveSyncState({
    phase: "uploading",
    updates: updatesForThisUpload,
    message: updatesForThisUpload > 0
      ? "Preparing backup…"
      : "Checking Drive backup…",
  });

  try {
    const result = await backupToGoogleDrive(undefined, { type: "all" }, {
      skipIfUnchanged: true,
      onProgress: (message) => setDriveSyncState({
        phase: "uploading",
        updates: updatesForThisUpload,
        message,
      }),
    });
    const completedAt = result.completedAt
      ? new Date(result.completedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "";
    // Do not report the backup as fully synced if database changes arrived
    // while the snapshot was uploading. A follow-up upload is queued below.
    if (pendingUpdates > 0) {
      setDriveSyncState({
        phase: "waiting",
        updates: pendingUpdates,
        message: "New changes detected · syncing again…",
      });
    } else {
      setDriveSyncState({
        phase: "success",
        updates: 0,
        message: result.skipped
          ? `Google Drive backup up to date${completedAt ? ` · ${completedAt}` : ""}`
          : `Uploaded to Google Drive${completedAt ? ` · ${completedAt}` : ""}`,
      });
    }
  } catch (error) {
    console.warn("[drive-auto-backup] sync failed:", error);
    const details = error instanceof Error ? error.message : String(error || "Unknown error");
    setDriveSyncState({
      phase: "error",
      updates: pendingUpdates,
      message: "Drive sync failed: " + details + " · local data remains on this phone",
    });
  } finally {
    uploading = false;
    if (pendingUpdates > 0 && !disposed) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void runBackup();
      }, DEBOUNCE_MS);
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

  // Check at startup and when the app returns to the foreground so queued
  // edits are retried after a restart or temporary interruption.
  scheduleBackup(0);
  let appStateSubscription: { remove: () => void } | null = null;
  try {
    const { AppState } = require("react-native");
    appStateSubscription = AppState.addEventListener("change", (state: string) => {
      if (state === "active") scheduleBackup(0);
    });
  } catch {}

  return () => {
    appStateSubscription?.remove();
    disposed = true;
    subscription.remove();
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
