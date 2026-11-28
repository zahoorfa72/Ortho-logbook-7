import * as SQLite from "expo-sqlite";
import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";
import {
  backupIncrementalToGoogleDrive,
  getLastDriveBackupStatus,
  getConnectedGoogleAccount,
  restoreGoogleAccountSilently,
  getSharedWorkspaceStatus,
  submitSharedChangeRequest,
} from "@/src/utils/storage/google-drive";
import { setDriveSyncState, setDriveSyncRefreshHandler } from "@/src/utils/storage/drive-sync-status";
import { storage } from "@/src/utils/storage";

// Batch rapid edits into one sync; this avoids repeated uploads while typing/saving related fields.
const DEBOUNCE_MS = 7000;
// The full table list is reserved for first sync and explicit manual refresh.
// Normal app launches resume only previously queued changes; SQLite change events
// identify actual writes, and the exporter still compares them with the last snapshot.
const ALL_SYNC_TABLES = [
  "patients", "procedures", "inventoryCategories", "inventory", "patientImplants",
  "patientCustomFields", "implantRecords", "expenses", "users", "patientHistory",
  "inventoryMovements", "inventoryPurchaseReceipts", "stockReceipts", "yearlyRequirements", "trash",
  "intelligenceRecords", "intelligenceRevisions", "knowledgeArticles", "intelligenceSettings", "branding", "appSettings",
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
// OS-managed periodic sync is a reconciliation safety net. A native foreground
// service continues an already-started large Drive upload while the UI is closed.
const BACKGROUND_SYNC_TASK = "ortho-logbook-drive-backup";
const inFlightTables = new Set<string>();
let backgroundTaskRegistered = false;

TaskManager.defineTask(BACKGROUND_SYNC_TASK, async ({ error }) => {
  if (error) {
    console.warn("[drive-auto-backup] background task error:", error.message);
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
  try {
    await loadPendingTables();
    // Run only when real changes are pending. Re-scanning every table and
    // forcing a full audit of all patient PDFs every 15 minutes made ordinary
    // navigation feel frozen and repeatedly showed "Checking patient image PDF".
    // SQLite change events and the durable queue already record changed tables.
    if (!pendingTables.size) return BackgroundTask.BackgroundTaskResult.Success;
    const completed = await runBackup();
    return completed
      ? BackgroundTask.BackgroundTaskResult.Success
      : BackgroundTask.BackgroundTaskResult.Failed;
  } catch (taskError) {
    console.warn("[drive-auto-backup] scheduled background sync failed:", taskError);
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

async function registerBackgroundSyncTask() {
  if (backgroundTaskRegistered) return;
  backgroundTaskRegistered = true;
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status !== BackgroundTask.BackgroundTaskStatus.Available) return;
    const registered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK);
    if (!registered) {
      await BackgroundTask.registerTaskAsync(BACKGROUND_SYNC_TASK, { minimumInterval: 15 });
    }
  } catch (error) {
    backgroundTaskRegistered = false;
    console.warn("[drive-auto-backup] could not register scheduled background sync:", error);
  }
}

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
  inventory_yearly_requirements: "yearlyRequirements",
  deleted_records: "trash",
  ortho_intelligence_records: "intelligenceRecords",
  ortho_intelligence_revisions: "intelligenceRevisions",
  ortho_knowledge_articles: "knowledgeArticles",
  ortho_intelligence_settings: "intelligenceSettings",
};

function persistPendingTables(): Promise<void> {
  // Persist queued and in-flight work together. The upload is not acknowledged
  // until the Drive master and the delta cache have both been confirmed.
  const snapshot = JSON.stringify(Array.from(new Set([...pendingTables, ...inFlightTables])));
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

async function runBackup(options: { verifyPatientPdfs?: boolean } = {}): Promise<boolean> {
  if (disposed || uploading || backupPaused) return false;
  await loadPendingTables();
  if (!pendingTables.size) return true;
  if (!getConnectedGoogleAccount()) await restoreGoogleAccountSilently();
  if (!getConnectedGoogleAccount()) {
    setDriveSyncState({
      phase: "idle",
      updates: pendingTables.size,
      message: "Backup pending: changes are safe on this phone · connect Google to upload",
    });
    return false;
  }

  uploading = true;
  // Keep the batch persisted until Drive confirms the update. Writes arriving
  // during the upload re-enter pendingTables and are sent in the next pass.
  const batch = Array.from(pendingTables);
  batch.forEach((name) => {
    pendingTables.delete(name);
    inFlightTables.add(name);
  });
  await persistPendingTables();
  setDriveSyncState({
    phase: "uploading",
    updates: batch.length,
    message: "Checking saved records for changes…",
  });

  try {
    // A very large first-sync batch can exceed the JavaScript engine's maximum
    // string length before the native file uploader gets control. If that exact
    // failure occurs, retry the same work in smaller table groups. Each group
    // uses the normal verified journal/cache path, so changes remain recoverable
    // and a retry after partial success is safe (already-synced groups diff to no-op).
    // When this phone has joined a shared workspace, staff edits must become
    // approval requests. They must never write directly into the shared master.
    // If Drive is temporarily unavailable, keep the queue and retry later.
    const sharedStatus = await getSharedWorkspaceStatus();
    if (sharedStatus) {
      if (!sharedStatus.connected) {
        throw new Error(sharedStatus.error || "Shared workspace is offline. Changes remain queued on this phone.");
      }
      if (!sharedStatus.isOwner) {
        const sharedTables = batch.filter((name) => name !== "users");
        if (sharedTables.length) {
          const requestResult = await submitSharedChangeRequest(sharedTables, (message) => {
            setDriveSyncState({ phase: "uploading", updates: batch.length, message });
          });
          if (requestResult?.requestId) {
            setDriveSyncState({
              phase: "waiting",
              updates: 0,
              message: "Change request " + requestResult.requestId + " sent · waiting for workspace owner approval",
            });
          } else {
            setDriveSyncState({
              phase: "success",
              updates: 0,
              message: "No shared record changes found · account-only data was kept on this phone",
            });
          }
        } else {
          setDriveSyncState({
            phase: "success",
            updates: 0,
            message: "Account and login settings stay on this phone · no shared data was uploaded",
          });
        }
        batch.forEach((name) => inFlightTables.delete(name));
        await persistPendingTables();
        return true;
      }
    }

    const syncBatch = async (tables: string[]): Promise<any> => {
      try {
        return await backupIncrementalToGoogleDrive(tables, (message) => {
          setDriveSyncState({ phase: "uploading", updates: batch.length, message });
        }, { verifyPatientPdfs: options.verifyPatientPdfs === true });
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error || "");
        if (!/String length exceeds limit/i.test(details) || tables.length <= 1) {
          if (/String length exceeds limit/i.test(details) && tables.length === 1) {
            throw new Error(
              "One backup data group is larger than this Android build can serialize. Local data remains on this phone. Install the latest APK with large-backup streaming, then retry. Original patient images have not been reduced."
            );
          }
          throw error;
        }
        const midpoint = Math.ceil(tables.length / 2);
        setDriveSyncState({
          phase: "uploading",
          updates: batch.length,
          message: "Large backup detected · safely splitting the sync into smaller groups…",
        });
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
    // Only acknowledge this batch after Drive and the comparison baseline are
    // confirmed. Any newer edits remain queued separately.
    batch.forEach((name) => inFlightTables.delete(name));
    await persistPendingTables();
    const completedAt = result.completedAt
      ? new Date(result.completedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "";
    const successMessage = ((result as any).migrationPending
      ? "Monthly backup uploaded · older backup merge needs retry"
      : result.baselineCreated
        ? "Monthly full backup uploaded and confirmed"
        : result.skipped
          ? "Drive checked · no changed records"
          : "Changed data uploaded to Google Drive") +
      (completedAt ? " · " + completedAt : "") +
      (Array.isArray((result as any).cleanupFailures) && (result as any).cleanupFailures.length
        ? " · Old backup cleanup needs retry: " + (result as any).cleanupFailures.join("; ")
        : "") +
      (Array.isArray((result as any).snapshotFailures) && (result as any).snapshotFailures.length
        ? " · Range snapshot pending: " + (result as any).snapshotFailures.join("; ")
        : " · monthly backup checked");
    // Always show the confirmed upload result, even if new edits arrived
    // during the transfer. Those newer edits remain queued and are synced next.
    const queuedMessage = pendingTables.size
      ? " · " + pendingTables.size + " newer change group(s) queued"
      : "";
    setDriveSyncState({ phase: "success", updates: 0, message: successMessage + queuedMessage });
    return true;
  } catch (error) {
    // Keep unconfirmed work queued for the next launch/background retry.
    batch.forEach((name) => {
      inFlightTables.delete(name);
      pendingTables.add(name);
    });
    // Retain failed table names. Use backoff rather than rebuilding a large
    // photo backup every seven seconds while the network is unavailable.
    retryAttempt = Math.min(retryAttempt + 1, 6);
    await persistPendingTables();
    const details = error instanceof Error ? error.message : String(error || "Unknown error");
    console.warn("[drive-auto-backup] sync failed:", details);
    setDriveSyncState({
      phase: "error",
      updates: pendingTables.size,
      message: "Drive sync failed: " + details + " · local data remains on this phone",
    });
    return false;
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
    if (!pendingTables.size) {
      setDriveSyncState({
        phase: "success",
        updates: 0,
        message: "Backup is up to date · no unsynced changes",
      });
      return;
    }
    retryAttempt = 0;
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
        message: "Retry requested · will resume after the current upload",
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
  void registerBackgroundSyncTask();
  void loadPendingTables().then(async () => {
    // Only do a complete initial scan if Drive has never confirmed a backup.
    // Re-queuing all tables at every app launch re-read all report/history images
    // and could compete with a user-started upload at 99.5%.
    const lastSuccessfulBackup = await getLastDriveBackupStatus();
    if (!pendingTables.size) {
      if (!lastSuccessfulBackup) {
        ALL_SYNC_TABLES.forEach((name) => pendingTables.add(name));
      }
      // A successful backup plus an empty pending queue means there is nothing
      // to sync. Do not enqueue appSettings just because the app opened; startup
      // and navigation are not data changes.
    }
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
      if (state === "active" && pendingTables.size) {
        // Resume any changes retained while Android suspended the JS runtime.
        scheduleBackup();
        return;
      }
      if (state === "background" || state === "inactive") {
        // Keep pending work durable when the JS runtime is suspended.
        // A started Android transfer continues in its native foreground service.
        void persistPendingTables();
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
