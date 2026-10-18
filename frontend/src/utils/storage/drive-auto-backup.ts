import * as SQLite from "expo-sqlite";
import {
  backupIncrementalToGoogleDrive,
  getLastDriveBackupStatus,
  getConnectedGoogleAccount,
  restoreGoogleAccountSilently,
} from "@/src/utils/storage/google-drive";
import { setDriveSyncState, setDriveSyncRefreshHandler } from "@/src/utils/storage/drive-sync-status";
import { storage } from "@/src/utils/storage";

// Batch rapid edits into one sync; this avoids repeated uploads while typing/saving related fields.
const DEBOUNCE_MS = 7000;
// Re-scan every syncable table on app launch/foreground. SQLite change events can be
// missed while Android suspends/recreates the app; the incremental exporter compares
// local rows with its last confirmed snapshot, so unchanged data is not re-uploaded.
const ALL_SYNC_TABLES = [
  "patients", "procedures", "inventoryCategories", "inventory", "patientImplants",
  "patientCustomFields", "implantRecords", "expenses", "users", "patientHistory",
  "inventoryMovements", "inventoryPurchaseReceipts", "stockReceipts", "trash", "branding", "appSettings",
] as const;
const DIRTY_TABLES_KEY = "ortho_drive_pending_tables_v1";
let timer: ReturnType<typeof setTimeout> | null = null;
let uploading = false;
let refreshRequested = false;
let backupPaused = false;
let disposed = false;
let initialized = false;
const pendingTables = new Set<string>();
let pendingWriteQueue: Promise<void> = Promise.resolve();
let retryAttempt = 0;
const tableMap: Record<string, string> = {
  patients: "patients",
  procedures: "procedures",
  inventory_categories: "inventoryCategories",
  inventory: "inventory",
  patient_implants: "patientImplants",
  patient_custom_fields: "patientCustomFields",
  implant_records: "implantRecords",
  expenses: "expenses",
  users: "users",
  patient_history: "patientHistory",
  inventory_movements: "inventoryMovements",
  inventory_purchase_receipts: "inventoryPurchaseReceipts",
  stock_receipts: "stockReceipts",
  deleted_records: "trash",
};

function persistPendingTables(): Promise<void> {
  // Serialize writes so a slower older AsyncStorage write cannot overwrite a
  // newer pending-table snapshot and silently lose a queued table.
  const snapshot = JSON.stringify(Array.from(pendingTables));
  pendingWriteQueue = pendingWriteQueue.then(async () => {
    try {
      await storage.setItem(DIRTY_TABLES_KEY, snapshot);
    } catch (error) {
      console.warn("[drive-auto-backup] could not persist pending table list", error);
    }
  });
  return pendingWriteQueue;
}

async function loadPendingTables() {
  if (initialized) return;
  initialized = true;
  try {
    const raw = await storage.getItem<string>(DIRTY_TABLES_KEY, "");
    const parsed = typeof raw === "string" ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) parsed.forEach((name) => {
      if (typeof name === "string" && (Object.values(tableMap).includes(name) || name === "branding" || name === "appSettings" || name === "trash")) {
        pendingTables.add(name);
      }
    });
  } catch {}
}

function scheduleBackup(tableName?: string) {
  if (disposed) return;
  if (tableName) {
    pendingTables.add(tableName);
    retryAttempt = 0;
  }
  void persistPendingTables();
  if (!pendingTables.size || uploading || backupPaused) return;
  if (timer) clearTimeout(timer);
  setDriveSyncState({
    phase: "waiting",
    updates: pendingTables.size,
    message: "Checking whether saved data changed…",
  });
  timer = setTimeout(() => {
    timer = null;
    void runBackup();
  }, DEBOUNCE_MS);
}

async function runBackup() {
  if (disposed || uploading || backupPaused) return;
  await loadPendingTables();
  if (!pendingTables.size) return;
  if (!getConnectedGoogleAccount()) await restoreGoogleAccountSilently();
  if (!getConnectedGoogleAccount()) {
    setDriveSyncState({
      phase: "idle",
      updates: pendingTables.size,
      message: "Backup pending: changes are safe on this phone · connect Google to upload",
    });
    return;
  }

  uploading = true;
  // Remove only this batch. Changes arriving during upload remain queued.
  const batch = Array.from(pendingTables);
  batch.forEach((name) => pendingTables.delete(name));
  await persistPendingTables();
  setDriveSyncState({
    phase: "uploading",
    updates: batch.length,
    message: "Checking saved records for changes…",
  });

  try {
    const result = await backupIncrementalToGoogleDrive(batch, (message) => {
      setDriveSyncState({ phase: "uploading", updates: batch.length, message });
    });
    retryAttempt = 0;
    const completedAt = result.completedAt
      ? new Date(result.completedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "";
    const successMessage = ((result as any).migrationPending
      ? "Master backup uploaded · older backup merge needs retry"
      : result.baselineCreated
        ? "Master backup uploaded and confirmed"
        : result.skipped
          ? "Drive checked · no changed records"
          : "Changed data uploaded to Google Drive") +
      (completedAt ? " · " + completedAt : "") +
      (Array.isArray((result as any).cleanupFailures) && (result as any).cleanupFailures.length
        ? " · Old backup cleanup needs retry: " + (result as any).cleanupFailures.join("; ")
        : "") +
      (Array.isArray((result as any).snapshotFailures) && (result as any).snapshotFailures.length
        ? " · Range snapshot pending: " + (result as any).snapshotFailures.join("; ")
        : " · single master backup checked");
    if (pendingTables.size) {
      setDriveSyncState({ phase: "waiting", updates: pendingTables.size, message: "New changes detected · syncing again…" });
    } else {
      setDriveSyncState({ phase: "success", updates: 0, message: successMessage });
    }
  } catch (error) {
    // Retain failed table names. Use backoff rather than rebuilding a large
    // photo backup every seven seconds while the network is unavailable.
    retryAttempt = Math.min(retryAttempt + 1, 6);
    batch.forEach((name) => pendingTables.add(name));
    await persistPendingTables();
    const details = error instanceof Error ? error.message : String(error || "Unknown error");
    console.warn("[drive-auto-backup] sync failed:", details);
    setDriveSyncState({
      phase: "error",
      updates: pendingTables.size,
      message: "Drive sync failed: " + details + " · local data remains on this phone",
    });
  } finally {
    uploading = false;
    if (pendingTables.size && !disposed && !backupPaused) {
      if (timer) clearTimeout(timer);
      const delay = refreshRequested ? 0 : retryAttempt > 0 ? Math.min(300000, 30000 * (2 ** (retryAttempt - 1))) : DEBOUNCE_MS;
      refreshRequested = false;
      timer = setTimeout(() => {
        timer = null;
        void runBackup();
      }, delay);
    }
  }
}

export function triggerAutomaticDriveBackup(tableName: typeof ALL_SYNC_TABLES[number] | "branding" | "appSettings" = "branding") {
  // Explicit callers can enqueue known SQLite tables after critical mutations, or non-SQLite metadata such as branding and OAuth client configuration.
  scheduleBackup(tableName);
}

// Called when the user taps the floating sync indicator. It re-checks every
// syncable table, but the exporter uploads only real differences from the last
// confirmed snapshot. If an upload is stalled, queue an immediate retry as soon
// as the current request's timeout/recovery path releases the upload lock.
export function setAutomaticDriveBackupPaused(paused: boolean) {
  backupPaused = paused;
  if (paused) {
    if (timer) clearTimeout(timer);
    timer = null;
    return;
  }
  if (pendingTables.size && !disposed) scheduleBackup();
}

export function refreshAutomaticDriveBackup() {
  void loadPendingTables().then(async () => {
    retryAttempt = 0;
    ALL_SYNC_TABLES.forEach((name) => pendingTables.add(name));
    await persistPendingTables();
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (uploading) {
      refreshRequested = true;
      setDriveSyncState({
        phase: "waiting",
        updates: pendingTables.size,
        message: "Refresh requested · retry will start after the current upload releases",
      });
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      void runBackup();
    }, 0);
  });
}

export function startAutomaticDriveBackup() {
  disposed = false;
  setDriveSyncRefreshHandler(refreshAutomaticDriveBackup);
  const unregisterRefresh = () => setDriveSyncRefreshHandler(null);
  void loadPendingTables().then(async () => {
    // Reconcile every syncable table once at app startup. The incremental
    // exporter compares metadata and image signatures with the last confirmed
    // snapshot, so this detects writes missed while Android suspended the app
    // without re-uploading unchanged photos or creating a new backup file.
    ALL_SYNC_TABLES.forEach((name) => pendingTables.add(name));
    await persistPendingTables();
    scheduleBackup();
  });
  const subscription = SQLite.addDatabaseChangeListener((event: any) => {
    const changedTable = tableMap[String(event?.tableName || "")];
    // Only actual writes to syncable tables enqueue a comparison. The diff is
    // checked before any upload, so no-op SQLite events cannot upload backups.
    if (changedTable) scheduleBackup(changedTable);
  });

  // On foreground, retry only edits that were already pending/failed. Never
  // mark every table dirty merely because the user returned to the app.
  let appStateSubscription: { remove: () => void } | null = null;
  try {
    const { AppState } = require("react-native");
    appStateSubscription = AppState.addEventListener("change", (state: string) => {
      if (state === "active" && pendingTables.size) scheduleBackup();
    });
  } catch {}

  return () => {
    appStateSubscription?.remove();
    unregisterRefresh();
    disposed = true;
    subscription.remove();
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
