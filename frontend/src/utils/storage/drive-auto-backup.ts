import * as SQLite from "expo-sqlite";
import {
  backupIncrementalToGoogleDrive,
  getConnectedGoogleAccount,
  restoreGoogleAccountSilently,
} from "@/src/utils/storage/google-drive";
import { setDriveSyncState } from "@/src/utils/storage/drive-sync-status";
import { storage } from "@/src/utils/storage";

const DEBOUNCE_MS = 5000;
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
      if (typeof name === "string" && (Object.values(tableMap).includes(name) || name === "branding")) {
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
    message: "Changed data waiting to sync",
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
    message: "Preparing changed data…",
  });

  try {
    const result = await backupIncrementalToGoogleDrive(batch, (message) => {
      setDriveSyncState({ phase: "uploading", updates: batch.length, message });
    });
    const completedAt = result.completedAt
      ? new Date(result.completedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "";
    const successMessage = result.baselineCreated
      ? "Full backup baseline created" + (completedAt ? " · " + completedAt : "")
      : "Changed data synced to Google Drive" + (completedAt ? " · " + completedAt : "");
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

export function triggerAutomaticDriveBackup() {
  // Explicit callers use this for non-SQLite metadata such as branding.
  scheduleBackup("branding");
}

export function startAutomaticDriveBackup() {
  disposed = false;
  void loadPendingTables().then(() => {
    if (pendingTables.size) scheduleBackup();
  });
  const subscription = SQLite.addDatabaseChangeListener((event: any) => {
    const changedTable = tableMap[String(event?.tableName || "")];
    // Ignore navigation, SQLite metadata, and unrelated internal tables.
    if (changedTable) scheduleBackup(changedTable);
  });

  // Returning to the foreground retries only already-queued edits. It does
  // not manufacture a new backup request and never uploads on tab navigation.
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
