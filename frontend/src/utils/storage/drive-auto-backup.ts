import * as SQLite from "expo-sqlite";
import {
  backupIncrementalToGoogleDrive,
  getConnectedGoogleAccount,
  restoreGoogleAccountSilently,
} from "@/src/utils/storage/google-drive";
import { setDriveSyncState } from "@/src/utils/storage/drive-sync-status";
import { storage } from "@/src/utils/storage";

const DEBOUNCE_MS = 1000;
// Re-scan every syncable table on app launch/foreground. SQLite change events can be
// missed while Android suspends/recreates the app; the incremental exporter compares
// local rows with its last confirmed snapshot, so unchanged data is not re-uploaded.
const ALL_SYNC_TABLES = [
  "patients", "procedures", "inventoryCategories", "inventory", "patientImplants",
  "patientCustomFields", "implantRecords", "expenses", "users", "patientHistory",
  "inventoryMovements", "inventoryPurchaseReceipts", "stockReceipts", "branding", "appSettings",
] as const;
const DIRTY_TABLES_KEY = "ortho_drive_pending_tables_v1";
let timer: ReturnType<typeof setTimeout> | null = null;
let uploading = false;
let disposed = false;
let initialized = false;
const pendingTables = new Set<string>();
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
};

async function persistPendingTables() {
  try {
    await storage.setItem(DIRTY_TABLES_KEY, JSON.stringify(Array.from(pendingTables)));
  } catch (error) {
    console.warn("[drive-auto-backup] could not persist pending table list", error);
  }
}

async function loadPendingTables() {
  if (initialized) return;
  initialized = true;
  try {
    const raw = await storage.getItem<string>(DIRTY_TABLES_KEY, "");
    const parsed = typeof raw === "string" ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) parsed.forEach((name) => {
      if (typeof name === "string" && (Object.values(tableMap).includes(name) || name === "branding" || name === "appSettings")) {
        pendingTables.add(name);
      }
    });
  } catch {}
}

function scheduleBackup(tableName?: string) {
  if (disposed) return;
  if (tableName) pendingTables.add(tableName);
  void persistPendingTables();
  if (!pendingTables.size || uploading) return;
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
  if (disposed || uploading) return;
  await loadPendingTables();
  if (!pendingTables.size) return;
  if (!getConnectedGoogleAccount()) await restoreGoogleAccountSilently();
  if (!getConnectedGoogleAccount()) {
    setDriveSyncState({
      phase: "idle",
      updates: pendingTables.size,
      message: "Changes saved on this phone · connect Google to upload",
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
    // Retain failed table names so the next connection/foreground retry does
    // not lose edits. All actual records remain in local SQLite.
    batch.forEach((name) => pendingTables.add(name));
    await persistPendingTables();
    console.warn("[drive-auto-backup] sync failed:", error);
    const details = error instanceof Error ? error.message : String(error || "Unknown error");
    setDriveSyncState({
      phase: "error",
      updates: pendingTables.size,
      message: "Drive sync failed: " + details + " · local data remains on this phone",
    });
  } finally {
    uploading = false;
    if (pendingTables.size && !disposed) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void runBackup();
      }, DEBOUNCE_MS);
    }
  }
}

export function triggerAutomaticDriveBackup(tableName: "branding" | "appSettings" = "branding") {
  // Explicit callers use this for non-SQLite metadata such as branding and OAuth client configuration.
  scheduleBackup(tableName);
}

export function startAutomaticDriveBackup() {
  disposed = false;
  void loadPendingTables().then(() => {
    // A startup integrity pass compares local records with the last confirmed
    // cache. It may inspect every table, but Drive is updated only if the row
    // diff finds real changes. Foreground/scroll events do not force a new pass.
    ALL_SYNC_TABLES.forEach((name) => pendingTables.add(name));
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
    disposed = true;
    subscription.remove();
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
