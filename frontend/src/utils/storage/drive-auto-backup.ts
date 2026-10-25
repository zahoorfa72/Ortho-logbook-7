import * as SQLite from "expo-sqlite";
import {
  backupIncrementalToGoogleDrive,
  getConnectedGoogleAccount,
  restoreGoogleAccountSilently,
} from "@/src/utils/storage/google-drive";
import { setDriveSyncState, setDriveSyncRefreshHandler } from "@/src/utils/storage/drive-sync-status";
import { storage } from "@/src/utils/storage";

const DEBOUNCE_MS = 7000;
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
  const batch = Array.from(pendingTables);
  batch.forEach((name) => pendingTables.delete(name));
  await persistPendingTables();
  setDriveSyncState({
    phase: "uploading",
    updates: batch.length,
    message: "Checking saved records for changes…",
  });

  try {
    const syncBatch = async (tables: string[]): Promise<any> => {
      try {
        return await backupIncrementalToGoogleDrive(tables, (message) => {
          setDriveSyncState({ phase: "uploading", updates: batch.length, message });
        });
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error || "");
        if (!/String length exceeds limit/i.test(details) || tables.length <= 1) {
          if (/String length exceeds limit/i.test(details) && tables.length === 1) {
            throw new Error(
              "One backup data group is larger than this Android build can serialize. Local data remains on this phone."
            );
          }
          throw error;
        }
        const midpoint = Math.ceil(tables.length / 2);
        const first = await syncBatch(tables.slice(0, midpoint));
        const second = await syncBatch(tables.slice(midpoint));
        return {
          ...second,
          baselineCreated: !!first?.baselineCreated || !!second?.baselineCreated,
          skipped: !!first?.skipped && !!second?.skipped,
        };
      }
    };
    const result = await syncBatch(batch);
    retryAttempt = 0;
    const completedAt = result.completedAt
      ? new Date(result.completedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "";
    const successMessage = (result.baselineCreated
      ? "Monthly full backup uploaded and confirmed"
      : result.skipped
        ? "Drive checked · no changed records"
        : "Changed data uploaded to Google Drive") +
      (completedAt ? " · " + completedAt : "");
    const queuedMessage = pendingTables.size
      ? " · " + pendingTables.size + " newer change group(s) queued"
      : "";
    setDriveSyncState({ phase: "success", updates: 0, message: successMessage + queuedMessage });
  } catch (error) {
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
  scheduleBackup(tableName);
}

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
    await persistPendingTables();
    scheduleBackup();
  });
  // Disabled: SQLite change listeners + sync writes can hard-kill the Android
  // process during patient save with expo-sqlite 57. Explicit trigger calls remain.
  const subscription = { remove() {} };

  let appStateSubscription: { remove: () => void } | null = null;
  try {
    const { AppState } = require("react-native");
    appStateSubscription = AppState.addEventListener("change", (state: string) => {
      if (state === "active" && pendingTables.size) {
        scheduleBackup();
        return;
      }
      if ((state === "background" || state === "inactive") && timer) {
        clearTimeout(timer);
        timer = null;
      }
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
