import { GoogleSignin, statusCodes } from "@react-native-google-signin/google-signin";
import { NativeModules, Platform } from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import { exportUnencryptedBackup, exportUnencryptedBackupData, exportIncrementalBackup, exportIncrementalBackupData, prepareIncrementalSnapshotCacheFromBackupData, commitIncrementalSnapshotCache, pruneBackupPhotoAssets, type BackupFilter } from "@/src/utils/storage/backup";
import { markBackupTaken } from "@/src/utils/backup-reminder";
import { storage } from "@/src/utils/storage";
import { archiveEligiblePatientImages, archivePatientImagesForPatient, getLocalPatientImageArchives, getPatientImageArchive, installPatientImageArchivePdf, removePatientImageArchive, setPatientImageArchiveDriveState, type PatientImageArchive } from "@/src/utils/storage/patient-image-archive";

const LAST_DRIVE_BACKUP_KEY = "ortho_drive_last_successful_backup";
const LAST_DRIVE_CONTENT_HASH_KEY = "ortho_drive_last_uploaded_content_hash";
const MASTER_MIGRATION_KEY = "ortho_drive_master_migration_v2";
const MASTER_LOCAL_SNAPSHOT_VERSION_KEY = "ortho_drive_master_local_snapshot_v1";
const MONTH_ARCHIVE_CURSOR_KEY = "ortho_drive_month_archive_cursor_v1";
const DRIVE_SCOPE_VERSION_KEY = "ortho_drive_scope_version";
const DRIVE_SCOPE_VERSION = "full-drive-gmail-v1";
export async function getLastDriveBackupStatus(): Promise<string | null> {
  return (await storage.secureGet(LAST_DRIVE_BACKUP_KEY, "")) || null;
}

// Full Drive access is needed to discover backups created by earlier app builds or under a different file authorization.
export const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const BACKUP_NAME = "Ortho Logbook Backup.orbackup";
const PATIENT_IMAGE_PDF_FOLDER = "Patient Image PDFs";
const PENDING_PATIENT_PDF_DELETE_KEY = "ortho_pending_patient_pdf_drive_deletes_v1";
const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

let configured = false;
let accessTokenInFlight: Promise<string> | null = null;

// Serialize manual backup, automatic sync and archive maintenance. A second
// operation used to restart progress near 100% and repeat huge uploads.
let driveOperationQueue: Promise<void> = Promise.resolve();
let queuedDriveOperationCount = 0;
function queueDriveOperation<T>(operation: () => Promise<T>, onProgress?: (stage: string) => void): Promise<T> {
  const alreadyQueued = queuedDriveOperationCount > 0;
  queuedDriveOperationCount += 1;
  if (alreadyQueued) onProgress?.("Waiting for the current Google Drive transfer to finish…");
  const result = driveOperationQueue.then(operation, operation);
  driveOperationQueue = result.then(() => undefined, () => undefined);
  return result.finally(() => {
    queuedDriveOperationCount = Math.max(0, queuedDriveOperationCount - 1);
  });
}

function configure() {
  if (configured) return;
  GoogleSignin.configure({ scopes: [GOOGLE_DRIVE_SCOPE, "https://www.googleapis.com/auth/gmail.send"] });
  configured = true;
}

export async function connectGoogleAccount() {
  configure();
  try {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    // Preserve the existing native Google session when reconnecting.
    const result = await GoogleSignin.signIn();
    if (!result || result.type === "cancelled") throw new Error("Google account selection was cancelled.");
    const current = GoogleSignin.getCurrentUser();
    if (!current?.user?.email) throw new Error("Google account was not returned.");
    await storage.secureSet("ortho_drive_account_email", current.user.email);
    await storage.secureSet(DRIVE_SCOPE_VERSION_KEY, DRIVE_SCOPE_VERSION);
    return current.user.email;
  } catch (error: any) {
    if (error?.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
      throw new Error("Google Play Services is unavailable or needs an update on this phone.");
    }
    if (error?.code === statusCodes.SIGN_IN_CANCELLED) {
      throw new Error("Google account selection was cancelled.");
    }
    throw new Error(error?.message || "Unable to connect the Google account.");
  }
}

export async function disconnectGoogleAccount() {
  configure();
  try { await GoogleSignin.signOut(); } catch {}
}

export function getConnectedGoogleAccount(): string | null {
  configure();
  return GoogleSignin.getCurrentUser()?.user?.email || null;
}

// Rehydrate a previously authorized account without showing an account chooser.
export async function restoreGoogleAccountSilently(): Promise<string | null> {
  configure();
  try {
    const currentEmail = GoogleSignin.getCurrentUser()?.user?.email;
    if (currentEmail) return currentEmail;
    if (!GoogleSignin.hasPreviousSignIn()) return null;
    await GoogleSignin.signInSilently();
    return GoogleSignin.getCurrentUser()?.user?.email || null;
  } catch {
    return null;
  }
}

export async function connectGoogleGmailAccount(): Promise<string> {
  // Uses the same Google account as Drive backup and requests Gmail send permission.
  const email = await connectGoogleAccount();
  const tokens = await GoogleSignin.getTokens();
  if (!tokens.accessToken) throw new Error("Google did not return an access token for Gmail.");
  return email;
}

export async function getGoogleGmailAccessToken(): Promise<string> {
  configure();
  let current = GoogleSignin.getCurrentUser();
  const scopeVersion = String((await storage.secureGet(DRIVE_SCOPE_VERSION_KEY, "")) || "");
  if (!current || scopeVersion !== DRIVE_SCOPE_VERSION) {
    await connectGoogleAccount();
    current = GoogleSignin.getCurrentUser();
  }
  if (!current) throw new Error("Connect your Google account before sending email.");
  const tokens = await GoogleSignin.getTokens();
  if (!tokens.accessToken) throw new Error("Google did not return an access token for Gmail.");
  return tokens.accessToken;
}

async function resolveAccessToken(): Promise<string> {
  configure();
  // Never launch the account chooser from a PDF/backup button tap.
  // Recover a previously authorized account silently. Account selection or
  // first-time consent remains an explicit action in Drive Settings.
  let current = GoogleSignin.getCurrentUser();
  if (!current && GoogleSignin.hasPreviousSignIn()) {
    try {
      await GoogleSignin.signInSilently();
      current = GoogleSignin.getCurrentUser();
    } catch {
      // Explain how to reconnect instead of showing a chooser on each button tap.
    }
  }
  if (!current) {
    throw new Error("Google Drive is not connected in this app. Open Settings → Google Drive and connect your account once, then retry.");
  }
  try {
    const tokens = await GoogleSignin.getTokens();
    if (!tokens.accessToken) throw new Error("Google did not return a Drive access token. Reconnect Google Drive from Settings.");
    return tokens.accessToken;
  } catch (error: any) {
    if (error?.code === statusCodes.SIGN_IN_REQUIRED || error?.code === "NO_SAVED_CREDENTIAL_FOUND") {
      throw new Error("Google Drive authorization expired. Reconnect it once from Settings → Google Drive, then retry.");
    }
    throw error;
  }
}

// react-native-google-signin cannot safely run concurrent getTokens calls.
// All Drive operations share the same in-flight token request.
async function accessToken(): Promise<string> {
  if (!accessTokenInFlight) {
    accessTokenInFlight = resolveAccessToken().finally(() => {
      accessTokenInFlight = null;
    });
  }
  return accessTokenInFlight;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 30000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error: any) {
    if (controller.signal.aborted) throw new Error("Google Drive request timed out after " + Math.round(timeoutMs / 1000) + " seconds. Check your connection and retry.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function driveRequest(url: string, init: RequestInit = {}) {
  const token = await accessToken();
  const extraHeaders = init.headers && typeof init.headers === "object" && !Array.isArray(init.headers)
    ? Object.entries(init.headers as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    : [];
  const requestInit: RequestInit = {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...Object.fromEntries(extraHeaders) },
  };
  // Retry transient network failures for read requests only. Retrying POST/PATCH/DELETE
  // blindly can duplicate folders or mutate Drive records twice if the first request succeeded.
  const canRetry = String(init.method || "GET").toUpperCase() === "GET";
  let response: Response | null = null;
  let lastNetworkError: any = null;
  for (let attempt = 0; attempt < (canRetry ? 3 : 1); attempt++) {
    try {
      response = await fetchWithTimeout(url, requestInit, 30000);
      lastNetworkError = null;
      break;
    } catch (error: any) {
      lastNetworkError = error;
      if (!canRetry || attempt >= 2) break;
      await new Promise(resolve => setTimeout(resolve, 600 * (attempt + 1)));
    }
  }
  if (!response) {
    throw new Error("Google Drive connection failed after retrying. Check internet access and Google account permission, then retry. " + String(lastNetworkError?.message || ""));
  }
  if (!response.ok) {
    let message = `Google Drive request failed (HTTP ${response.status}).`;
    try {
      const body = await response.json();
      message = body?.error?.message || message;
    } catch {}
    throw new Error(message);
  }
  return response;
}

async function findLatestBackupCandidates() {
  // Search Drive itself, including files in folders and backups created by older app builds.
  // Drive search can also return a folder whose name contains "Ortho Logbook Backup";
  // folders are not backup files and must never be selected for media download.
  const q = encodeURIComponent("name contains 'Ortho Logbook Backup' and mimeType != 'application/vnd.google-apps.folder' and trashed = false");
  const files: any[] = [];
  let pageToken = "";
  do {
    const tokenParam = pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : "";
    const response = await driveRequest(
      `${DRIVE_API}?q=${q}&spaces=drive&pageSize=100&orderBy=modifiedTime%20desc&includeItemsFromAllDrives=true&supportsAllDrives=true&fields=files(id,name,modifiedTime,size,mimeType),nextPageToken${tokenParam}`,
    );
    const data = await response.json();
    if (Array.isArray(data.files)) files.push(...data.files);
    pageToken = typeof data.nextPageToken === "string" ? data.nextPageToken : "";
  } while (pageToken);
  return files.filter((file: any) =>
    file?.id &&
    file.mimeType !== "application/vnd.google-apps.folder" &&
    String(file.name || "").toLowerCase().includes("ortho logbook backup")
  );
}

function driveBackupName(filter: BackupFilter): string {
  if (filter.type === "month") {
    const month = String(filter.value || "").trim();
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("Enter the month as YYYY-MM before backing up.");
    return `Ortho Logbook Backup - Month ${month}.orbackup`;
  }
  if (filter.type === "year") {
    const year = String(filter.value || "").trim();
    if (!/^\d{4}$/.test(year)) throw new Error("Enter the year as YYYY before backing up.");
    return `Ortho Logbook Backup - Year ${year}.orbackup`;
  }
  if (filter.type === "date") {
    const date = String(filter.value || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Enter the date as YYYY-MM-DD before backing up.");
    return `Ortho Logbook Backup - Date ${date}.orbackup`;
  }
  // A single rolling master is updated in place; period selection is a restore filter.
  return BACKUP_NAME;
}

async function findBackupByName(name: string) {
  const q = encodeURIComponent("name = '" + name.replace(/'/g, "\\\\'") + "' and trashed = false");
  const response = await driveRequest(`${DRIVE_API}?q=${q}&spaces=drive&pageSize=10&orderBy=modifiedTime%20desc&fields=files(id,name,modifiedTime,size,mimeType)`);
  const data = await response.json();
  return Array.isArray(data.files) ? data.files.find((item: any) => item?.id && item.mimeType !== "application/vnd.google-apps.folder") || null : null;
}

export async function listGoogleDriveBackups(): Promise<Array<{id:string;name:string;modifiedTime:string;size?:string}>> {
  const files = await findLatestBackupCandidates();
  // Offer only complete snapshots that restoreGoogleDriveBackupById understands.
  // Journals remain hidden implementation details; monthly snapshots must be
  // selectable individually so users can recover one month without replacing
  // unrelated months. Keep legacy full backups available for recovery.
  const backups = files.filter((file: any) => {
    if (!file?.id) return false;
    const name = String(file.name || "");
    return name === BACKUP_NAME ||
      name === "Ortho Logbook Backup - All Time.orbackup" ||
      /^Ortho Logbook Backup - Month \d{4}-\d{2}\.orbackup$/.test(name) ||
      /^Ortho Logbook Backup - Year \d{4}\.orbackup$/.test(name) ||
      /^Ortho Logbook Backup - Date \d{4}-\d{2}-\d{2}\.orbackup$/.test(name);
  }).map((file: any) => ({
    id: String(file.id),
    name: String(file.name || "Ortho Logbook Backup"),
    modifiedTime: String(file.modifiedTime || ""),
    size: file.size == null ? undefined : String(file.size),
  }));
  return backups.sort((a, b) => {
    // Prefer the rolling master, then show the newest dated snapshots first.
    const rank = (name: string) => name === BACKUP_NAME ? 0 :
      name === "Ortho Logbook Backup - All Time.orbackup" ? 1 :
      /^Ortho Logbook Backup - Month /.test(name) ? 2 :
      /^Ortho Logbook Backup - Year /.test(name) ? 3 : 4;
    return rank(a.name) - rank(b.name) ||
      Date.parse(b.modifiedTime || "") - Date.parse(a.modifiedTime || "");
  });
}

export async function restoreGoogleDriveBackupById(fileId: string, onProgress?: (message: string) => void) {
  if (!fileId) throw new Error("Select a Google Drive backup first.");
  const metadataResponse = await driveRequest(`${DRIVE_API}/${encodeURIComponent(fileId)}?fields=id,name,modifiedTime,size,mimeType,trashed`);
  const metadata = await metadataResponse.json();
  if (!metadata?.id || metadata.trashed || metadata.mimeType === "application/vnd.google-apps.folder") {
    throw new Error("The selected Google Drive item is not a backup file.");
  }
  onProgress?.("Downloading selected backup from Google Drive…");
  const parsed = await downloadDriveJsonValidated(fileId, onProgress);
  if (!parsed || parsed.app !== "Ortho Logbook" || !Array.isArray(parsed.patients) || !Array.isArray(parsed.inventory)) {
    throw new Error("The selected file is not a complete Ortho Logbook backup.");
  }
  // Monthly files contain full snapshots. Apply only the journal for the same
  // month and exact baseline file; never mix other months into this restore.
  const monthlyMatch = /^Ortho Logbook Backup - Month (\d{4}-\d{2})\.orbackup$/.exec(String(metadata.name || ""));
  const isRollingMaster = String(metadata.name || "") === BACKUP_NAME;
  if (monthlyMatch || isRollingMaster) {
    const warnings: string[] = [];
    let applied = 0;
    // The monthly snapshot's Drive modifiedTime does not change when its
    // separate monthly journal is updated. Report the journal time when it is
    // successfully applied so the restore picker does not label current data
    // with the old snapshot date.
    let effectiveModifiedTime = String(metadata.modifiedTime || "");
    const journalFile = await findBackupByName(isRollingMaster ? "Ortho Logbook Backup Changes.orbackup" : "Ortho Logbook Backup - Month " + monthlyMatch![1] + " Changes.orbackup");
    if (journalFile?.id) {
      try {
        const journal = await downloadDriveJsonValidated(String(journalFile.id), onProgress);
        if (journal?.incremental === true &&
            String(journal._baselineKey || "").startsWith(String(fileId) + ":") &&
            Array.isArray(journal.changedTables)) {
          applyIncrementalToMaster(parsed, journal, journal._rowDelta !== true);
          parsed.createdAt = journal.createdAt || parsed.createdAt;
          if (journalFile.modifiedTime) effectiveModifiedTime = String(journalFile.modifiedTime);
          applied = 1;
        }
      } catch (error: any) {
        warnings.push("The monthly changes journal could not be applied: " + String(error?.message || error));
      }
    }
    parsed.filter = { type: "all" };
    parsed.incremental = false;
    delete parsed.changedTables; delete parsed._rowDelta; delete parsed.deletedIds;
    delete parsed.fullTables; delete parsed._baselineKey; delete parsed._updateCount;
    try {
      await downloadPatientImageArchivesFromDrive(parsed, onProgress);
    } catch (error: any) {
      warnings.push("The master backup data was downloaded, but some separate patient image PDFs could not be downloaded: " + String(error?.message || error));
    }
    return { name: String(metadata.name), modifiedTime: effectiveModifiedTime,
      backupText: JSON.stringify(parsed), appliedIncrementals: applied, recoveryWarnings: warnings };
  }

  // The master is intentionally stable between compactions. Automatic edits,
  // including patient deletion tombstones and Trash records, live in the
  // incremental journal. A selected-master restore must compose that journal
  // too; downloading the master alone silently restores stale patient rows.
  const composed = parsed;
  const baseTime = Date.parse(String(metadata.modifiedTime || ""));
  const deltas = (await listIncrementalFiles())
    .filter((item: any) => item?.id)
    .sort((a: any, b: any) => Date.parse(String(a.modifiedTime || "")) - Date.parse(String(b.modifiedTime || "")));
  const recoveryWarnings: string[] = [];
  let appliedIncrementals = 0;

  // Download incremental journals in small parallel batches. The old loop
  // fetched every journal serially, adding one full network round-trip per file
  // to restore time. Apply results in their original order below so merge
  // semantics and deletion ordering remain unchanged, without loading every
  // journal into memory at once.
  const recoveredDeltas: Array<{ data?: any; warning?: string; error?: string } | null> = new Array(deltas.length).fill(null);
  for (let batchStart = 0; batchStart < deltas.length; batchStart += 3) {
    const batch = deltas.slice(batchStart, batchStart + 3);
    const results = await Promise.all(batch.map(async (item: any) => {
      try {
        const recovered = await downloadIncrementalWithRecovery(String(item.id), String(item.name || "An incremental backup"));
        return { data: recovered.data, warning: recovered.warning };
      } catch (error: any) {
        return { error: String(error?.message || (String(item.name || "An incremental backup") + " could not be recovered.")) };
      }
    }));
    results.forEach((result, index) => { recoveredDeltas[batchStart + index] = result; });
  }

  for (let deltaIndex = 0; deltaIndex < deltas.length; deltaIndex++) {
    const deltaFile = deltas[deltaIndex];
    let delta: any;
    try {
      const recovered = recoveredDeltas[deltaIndex];
      if (!recovered || recovered.error) throw new Error(recovered?.error || "Incremental backup could not be recovered.");
      delta = recovered.data;
      if (recovered.warning) recoveryWarnings.push(recovered.warning);
    } catch (error: any) {
      recoveryWarnings.push(String(error?.message || (String(deltaFile.name || "An incremental backup") + " could not be recovered.")));
      continue;
    }
    if (!delta || delta.app !== "Ortho Logbook" || delta.incremental !== true || !Array.isArray(delta.changedTables)) {
      recoveryWarnings.push(String(deltaFile.name || "An incremental backup") + " has an invalid format and was skipped.");
      continue;
    }

    const deltaBaseline = String(delta._baselineKey || "");
    const belongsToSelectedBaseline = deltaBaseline
      ? deltaBaseline.startsWith(String(metadata.id) + ":")
      : Number.isFinite(baseTime) && Date.parse(String(deltaFile.modifiedTime || "")) > baseTime;
    if (!belongsToSelectedBaseline) continue;

    let appliedAnyTable = false;
    for (const table of delta.changedTables) {
      if (table === "branding" || table === "appSettings") {
        if (Object.prototype.hasOwnProperty.call(delta, table)) {
          (composed as any)[table] = (delta as any)[table];
          appliedAnyTable = true;
        } else {
          recoveryWarnings.push(String(deltaFile.name || "An incremental backup") + " is missing its " + table + " data.");
        }
        continue;
      }

      const syncTables = ["patients","procedures","inventoryCategories","inventory","patientImplants","patientCustomFields","implantRecords","expenses","users","patientHistory","inventoryMovements","inventoryPurchaseReceipts","stockReceipts","trash"];
      if (!syncTables.includes(table)) continue;
      if (!Array.isArray(delta[table])) {
        recoveryWarnings.push(String(deltaFile.name || "An incremental backup") + " is missing table data for " + table + ".");
        continue;
      }

      if (delta._recoveredFromDamage === true) {
        // A salvaged/truncated journal cannot prove that absent rows were deleted.
        // Merge its readable rows conservatively instead of replacing a full table.
        const merged = new Map<string, any>();
        for (const row of Array.isArray(composed[table]) ? composed[table] : []) {
          const key = row && row.id != null ? "id:" + String(row.id) : "row:" + JSON.stringify(row);
          merged.set(key, row);
        }
        for (const row of delta[table]) {
          const key = row && row.id != null ? "id:" + String(row.id) : "row:" + JSON.stringify(row);
          const existing = merged.get(key);
          if (table === "patients" && existing &&
              !Object.prototype.hasOwnProperty.call(row, "photo_uri") &&
              !Object.prototype.hasOwnProperty.call(row, "photos_json")) {
            merged.set(key, { ...existing, ...row });
          } else {
            merged.set(key, row);
          }
        }
        // Apply only explicitly parsed deletion tombstones from a damaged journal;
        // missing rows in a truncated array alone are not proof of deletion.
        for (const deletedId of (Array.isArray(delta.deletedIds?.[table]) ? delta.deletedIds[table] : [])) {
          merged.delete("id:" + String(deletedId));
        }
        composed[table] = Array.from(merged.values());
      } else if (delta._rowDelta === true && !(Array.isArray(delta.fullTables) && delta.fullTables.includes(table))) {
        const merged = new Map<string, any>();
        for (const row of Array.isArray(composed[table]) ? composed[table] : []) {
          const key = row && row.id != null ? "id:" + String(row.id) : "row:" + JSON.stringify(row);
          merged.set(key, row);
        }
        for (const deletedId of Array.isArray(delta.deletedIds?.[table]) ? delta.deletedIds[table] : []) {
          merged.delete("id:" + String(deletedId));
        }
        for (const row of delta[table]) {
          const key = row && row.id != null ? "id:" + String(row.id) : "row:" + JSON.stringify(row);
          const existing = merged.get(key);
          if (table === "patients" && existing &&
              !Object.prototype.hasOwnProperty.call(row, "photo_uri") &&
              !Object.prototype.hasOwnProperty.call(row, "photos_json")) {
            merged.set(key, { ...existing, ...row });
          } else {
            merged.set(key, row);
          }
        }
        composed[table] = Array.from(merged.values());
      } else {
        // A full-table snapshot in the journal may predate rows now in the
        // master. Merge by record recency instead of replacing the master table,
        // then apply its explicit deletion tombstones.
        let mergedRows = mergeRowsByRecency(composed[table] || [], delta[table], table);
        const deletedIds = new Set<string>(Array.isArray(delta.deletedIds?.[table]) ? delta.deletedIds[table].map(String) : []);
        if (deletedIds.size) mergedRows = mergedRows.filter((row: any) => row?.id == null || !deletedIds.has(String(row.id)));
        composed[table] = mergedRows;
      }
      appliedAnyTable = true;
    }
    if (appliedAnyTable) {
      appliedIncrementals++;
      composed.createdAt = delta.createdAt || composed.createdAt;
    }
  }

  composed.incremental = false;
  delete composed.changedTables;
  delete composed._rowDelta;
  delete composed.deletedIds;
  delete composed.fullTables;
  delete composed._baselineKey;
  delete composed._updateCount;
  composed.filter = { type: "all" };
  try {
    await downloadPatientImageArchivesFromDrive(composed, onProgress);
  } catch (error: any) {
    recoveryWarnings.push("The master backup data was downloaded, but some separate patient image PDFs could not be downloaded: " + String(error?.message || error));
  }
  return {
    name: String(metadata.name || "Ortho Logbook Backup"),
    modifiedTime: String(metadata.modifiedTime || ""),
    backupText: JSON.stringify(composed),
    appliedIncrementals,
    recoveryWarnings,
  };
}

async function findLatestBackup() {
  const current = await findBackupByName(driveBackupName({ type: "all" }));
  if (current) return current;
  const legacy = await findBackupByName("Ortho Logbook Backup - All Time.orbackup") || await findBackupByName(BACKUP_NAME);
  if (legacy) return legacy;
  const candidates = await findLatestBackupCandidates();
  return candidates
    .filter((file: any) => /^Ortho Logbook Backup - Month \d{4}-\d{2}\.orbackup$/.test(String(file.name || "")))
    .sort((a: any, b: any) => Date.parse(String(b.modifiedTime || "")) - Date.parse(String(a.modifiedTime || "")))[0] || null;
}


// Use 512 KiB chunks (a multiple of Drive's 256 KiB requirement). Smaller
// chunks are more reliable on mobile networks and prevent one slow 4 MiB
// request from blocking a first-time, photo-heavy backup for minutes.
const DRIVE_CHUNK_SIZE = 512 * 1024;

function parseDriveResponse(text: string): any {
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}

function uploadChunk(sessionUrl: string, token: string, bytes: Uint8Array, start: number, end: number, total: number): Promise<{ done: boolean; result?: any; nextOffset?: number }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", sessionUrl);
    xhr.setRequestHeader("Authorization", "Bearer " + token);
    xhr.setRequestHeader("Content-Type", "application/json; charset=UTF-8");
    xhr.setRequestHeader("Content-Range", "bytes " + start + "-" + (end - 1) + "/" + total);
    xhr.onload = () => {
      const parsed = parseDriveResponse(xhr.responseText || "");
      if (xhr.status === 308) {
        const range = xhr.getResponseHeader("Range") || "";
        const match = /bytes=0-(\d+)/i.exec(range);
        resolve({ done: false, nextOffset: match ? Number(match[1]) + 1 : 0 });
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) { resolve({ done: true, result: parsed }); return; }
      reject(new Error(parsed?.error?.message || ("Google Drive rejected an upload chunk (HTTP " + xhr.status + ").")));
    };
    xhr.onerror = () => reject(new Error("Network error while sending a Google Drive upload chunk (readyState " + xhr.readyState + ", status " + (xhr.status || "none") + ")."));
    xhr.ontimeout = () => reject(new Error("Google Drive upload chunk timed out; checking the server's received offset before retrying."));
    // A slow mobile upload should time out per chunk, not kill the entire backup.
    xhr.timeout = 90000;
    const chunk = bytes.slice(start, end);
    xhr.send(chunk.buffer as ArrayBuffer);
  });
}

function queryUploadOffset(sessionUrl: string, token: string, total: number): Promise<{ done: boolean; nextOffset: number; result?: any }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", sessionUrl);
    xhr.setRequestHeader("Authorization", "Bearer " + token);
    xhr.setRequestHeader("Content-Range", "bytes */" + total);
    xhr.onload = () => {
      const parsed = parseDriveResponse(xhr.responseText || "");
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ done: true, nextOffset: total, result: parsed });
        return;
      }
      if (xhr.status === 308) {
        const range = xhr.getResponseHeader("Range") || "";
        const match = /bytes=0-(\d+)/i.exec(range);
        resolve({ done: false, nextOffset: match ? Number(match[1]) + 1 : 0 });
        return;
      }
      reject(new Error(parsed?.error?.message || ("Google Drive could not resume the upload (HTTP " + xhr.status + ").")));
    };
    xhr.onerror = () => reject(new Error("Could not check Google Drive upload progress because the network returned no HTTP response."));
    xhr.ontimeout = () => reject(new Error("Timed out checking Google Drive upload progress."));
    xhr.timeout = 30000;
    xhr.send();
  });
}

async function uploadResumable(sessionUrl: string, token: string, bytes: Uint8Array, onProgress?: (stage: string) => void) {
  let offset = 0;
  let result: any = null;
  let consecutiveFailures = 0;
  let stalledRounds = 0;
  while (offset < bytes.length) {
    const end = Math.min(offset + DRIVE_CHUNK_SIZE, bytes.length);
    let chunkResult: { done: boolean; result?: any; nextOffset?: number } | null = null;
    try {
      chunkResult = await uploadChunk(sessionUrl, token, bytes, offset, end, bytes.length);
      consecutiveFailures = 0;
    } catch (error: any) {
      // A timed-out request may still have reached Drive. Ask Drive for its
      // committed byte range instead of blindly restarting or resending data.
      let status: { done: boolean; nextOffset: number; result?: any };
      try {
        status = await queryUploadOffset(sessionUrl, token, bytes.length);
      } catch (statusError: any) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 5) {
          throw new Error("Google Drive upload could not recover after repeated network interruptions. Last chunk error: " +
            String(error?.message || "unknown error") + "; progress check: " +
            String(statusError?.message || "failed") + ". Your local data is unchanged; retry when the connection is stable.");
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(1500 * consecutiveFailures, 8000)));
        continue;
      }
      if (status.done) {
        result = status.result;
        offset = bytes.length;
        break;
      }
      if (status.nextOffset > bytes.length) {
        throw new Error("Google Drive returned an invalid upload offset.");
      }
      offset = status.nextOffset;
      consecutiveFailures += 1;
      if (consecutiveFailures >= 10) {
        throw new Error("Google Drive upload repeatedly lost its connection. The upload can be retried and local data is unchanged.");
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(800 * consecutiveFailures, 5000)));
      continue;
    }
    if (!chunkResult) continue;
    if (chunkResult.done) {
      result = chunkResult.result;
      offset = bytes.length;
      break;
    }
    const nextOffset = chunkResult.nextOffset ?? 0;
    if (nextOffset <= offset || nextOffset > end) {
      // Drive may accept only part of a chunk or fail to acknowledge it.
      // Reconcile against its own range so the loop can never spin forever.
      const status = await queryUploadOffset(sessionUrl, token, bytes.length);
      if (status.done) {
        result = status.result;
        offset = bytes.length;
        break;
      }
      if (status.nextOffset < 0 || status.nextOffset > bytes.length) {
        throw new Error("Google Drive returned an invalid upload offset.");
      }
      if (status.nextOffset <= offset) {
        stalledRounds += 1;
        if (stalledRounds >= 10) {
          throw new Error("Google Drive has not confirmed any uploaded bytes after repeated retries. Your local data is unchanged; retry on a stronger connection.");
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(800 * stalledRounds, 5000)));
        continue;
      }
      stalledRounds = 0;
      offset = status.nextOffset;
    } else {
      stalledRounds = 0;
      offset = nextOffset;
    }
    onProgress?.("Uploading backup to Google Drive… " + Math.min(100, Math.round((offset / bytes.length) * 100)) + "%");
  }
  return result || {};
}
async function uploadNativeBackground(
  sessionUrl: string,
  token: string,
  fileUri: string,
  totalBytes: number,
  onProgress?: (stage: string) => void,
  authRetry = 0,
  taskLabel = "backup",
): Promise<any> {
  const nativeUploader = NativeModules.DriveBackgroundUpload;
  if (!nativeUploader?.startUpload || !nativeUploader?.getStatus) {
    throw new Error("This Android build does not include the background upload service. Install the latest Ortho Logbook APK.");
  }
  const taskId: string = await nativeUploader.startUpload(sessionUrl, token, fileUri, totalBytes);
  let lastUploadedBytes = -1;
  let lastProgressAt = Date.now();
  const noProgressLimitMs = 8 * 60 * 1000;
  const formatBytes = (value: number) => {
    const bytes = Math.max(0, value);
    if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    return Math.round(bytes / 1024) + " KB";
  };
  while (true) {
    const status = await nativeUploader.getStatus(taskId);
    if (status?.status === "completed") {
      try { return status.result ? JSON.parse(status.result) : {}; } catch { return {}; }
    }
    if (status?.status === "error") {
      const detail = String(status.error || "Google Drive background upload failed.");
      if (authRetry < 1 && /HTTP 401|authorization expired|unauthorized/i.test(detail)) {
        onProgress?.("Refreshing Google authorization and resuming the existing upload…");
        const refreshedToken = await accessToken();
        return uploadNativeBackground(sessionUrl, refreshedToken, fileUri, totalBytes, onProgress, authRetry + 1, taskLabel);
      }
      throw new Error(detail + " Your local data is unchanged; retry when connected.");
    }
    const uploadedBytes = Math.max(0, Math.min(totalBytes, Number(status?.uploadedBytes ?? 0)));
    const progress = Number(status?.progress ?? Math.floor((uploadedBytes / Math.max(1, totalBytes)) * 100));
    // Integer percent can remain unchanged for many minutes on very large files.
    // Heartbeat from byte advancement instead, and show a decimal percentage so
    // a growing backup does not look frozen at e.g. 56%.
    if (uploadedBytes > lastUploadedBytes) {
      lastUploadedBytes = uploadedBytes;
      lastProgressAt = Date.now();
      const exactPercent = Math.min(100, (uploadedBytes / Math.max(1, totalBytes)) * 100);
      onProgress?.(
        "Uploading " + taskLabel + " to Google Drive in background… " + exactPercent.toFixed(1) +
        "% (" + formatBytes(uploadedBytes) + " / " + formatBytes(totalBytes) + ")"
      );
    } else if (Date.now() - lastProgressAt >= noProgressLimitMs) {
      throw new Error(
        "Google Drive background upload has received no additional bytes for 8 minutes (last confirmed " +
        formatBytes(uploadedBytes) + " of " + formatBytes(totalBytes) + "). The backup was not marked successful; local data remains on this phone. Retry on a stable connection."
      );
    }
    await new Promise<void>(resolve => setTimeout(resolve, 1000));
  }
}

async function verifyStreamedDriveFile(fileId: string, expectedName: string, expectedBytes?: number): Promise<any> {
  const response = await driveRequest(DRIVE_API + "/" + encodeURIComponent(fileId) + "?fields=id,name,size,modifiedTime,mimeType,trashed");
  const file = await response.json();
  if (!file?.id || file.trashed === true || file.name !== expectedName ||
      file.mimeType === "application/vnd.google-apps.folder" ||
      (expectedBytes !== undefined && Number(file.size) !== expectedBytes) || !Number(file.size)) {
    throw new Error("Google Drive could not confirm the complete streamed backup file. The sync is not marked successful; local data remains on this phone.");
  }
  return file;
}
async function verifyUploadedFile(
  result: any,
  expectedName: string,
  expectedBytes: number,
  existingId?: string,
): Promise<any> {
  // Never report success or advance the incremental snapshot cache just because
  // the transfer loop ended. Confirm Drive has a real file with the full byte size.
  let fileId = String(existingId || result?.id || "");
  if (!fileId) {
    const q = encodeURIComponent("name = '" + expectedName.replace(/'/g, "\\'") + "' and trashed = false");
    const response = await driveRequest(
      `${DRIVE_API}?q=${q}&spaces=drive&pageSize=10&orderBy=modifiedTime%20desc&fields=files(id,name,size,modifiedTime,mimeType,trashed)`,
    );
    const data = await response.json();
    const match = Array.isArray(data.files)
      ? data.files.find((item: any) => item?.name === expectedName && item?.id && item?.mimeType !== "application/vnd.google-apps.folder" && !item?.trashed && Number(item?.size) === expectedBytes)
      : null;
    if (!match) throw new Error("Google Drive did not confirm the complete backup file. The upload is not marked successful; local data is safe. Retry when connected.");
    return match;
  }

  const response = await driveRequest(`${DRIVE_API}/${encodeURIComponent(fileId)}?fields=id,name,size,modifiedTime,mimeType,trashed`);
  const file = await response.json();
  if (!file?.id || file.trashed === true || Number(file.size) !== expectedBytes || file.name !== expectedName) {
    throw new Error("Google Drive received an incomplete or mismatched backup file. The upload is not marked successful; local data is safe. Retry when connected.");
  }
  return file;
}

async function writeBackupTextInChunks(uri: string, content: string, chunkChars = 64 * 1024): Promise<void> {
  // Expo's writeAsStringAsync does not provide a portable append option. Use the
  // native module's real append writer so each chunk is added to the same file,
  // rather than overwriting the previous chunk and silently backing up only the tail.
  const writer = NativeModules.DriveBackgroundUpload;
  if (!writer?.writeTextChunk) {
    throw new Error("This Android build is missing the safe large-backup file writer. Install the latest APK before retrying Drive backup.");
  }
  chunkChars = Math.max(8 * 1024, Math.floor(chunkChars));
  let offset = 0;
  let first = true;
  while (offset < content.length) {
    let end = Math.min(offset + chunkChars, content.length);
    // Do not split a UTF-16 surrogate pair across native UTF-8 writes.
    if (end < content.length && end > offset) {
      const last = content.charCodeAt(end - 1);
      if (last >= 0xD800 && last <= 0xDBFF) end--;
    }
    await writer.writeTextChunk(uri, content.slice(offset, end), !first);
    first = false;
    offset = end;
  }
  if (first) await writer.writeTextChunk(uri, "", false);
}

async function writeBackupObjectToFile(uri: string, value: any, onProgress?: (stage: string) => void): Promise<void> {
  pruneBackupPhotoAssets(value);
  const writer = NativeModules.DriveBackgroundUpload;
  if (!writer?.writeTextChunk) throw new Error("This Android build is missing the safe large-backup file writer. Install the latest APK and retry.");
  let buffer = "";
  let first = true;
  let charactersWritten = 0;
  let lastReportedCharacters = 0;
  const flush = async () => {
    if (!buffer) return;
    await writer.writeTextChunk(uri, buffer, !first);
    first = false;
    buffer = "";
    if (charactersWritten - lastReportedCharacters >= 4 * 1024 * 1024) {
      lastReportedCharacters = charactersWritten;
      onProgress?.("Preparing backup file… " + (charactersWritten / (1024 * 1024)).toFixed(1) + " MB written");
    }
  };
  const append = async (part: string) => {
    charactersWritten += part.length;
    for (let offset = 0; offset < part.length; offset += 16 * 1024) {
      buffer += part.slice(offset, offset + 16 * 1024);
      // Larger but bounded bridge writes reduce overhead for 700+ MB backups.
      if (buffer.length >= 256 * 1024) await flush();
    }
  };
  const writeValue = async (item: any): Promise<void> => {
    if (typeof item === "string") {
      // Never JSON.stringify an entire image-heavy string (photos_json,
      // snapshot_json, or payload_json) at once. Escape bounded pieces and
      // stream them inside one valid JSON string literal.
      await append('"');
      const stringChunkChars = 8 * 1024;
      for (let offset = 0; offset < item.length; offset += stringChunkChars) {
        const encodedChunk = JSON.stringify(item.slice(offset, Math.min(item.length, offset + stringChunkChars)));
        await append(encodedChunk.slice(1, -1));
      }
      await append('"');
      return;
    }
    if (item === null || typeof item !== "object") {
      const encoded = JSON.stringify(item);
      await append(encoded === undefined ? "null" : encoded);
      return;
    }
    if (Array.isArray(item)) {
      await append("[");
      for (let i = 0; i < item.length; i++) {
        if (i) await append(",");
        await writeValue(item[i]);
      }
      await append("]");
      return;
    }
    await append("{");
    let firstKey = true;
    for (const key of Object.keys(item)) {
      const child = item[key];
      if (child === undefined || typeof child === "function" || typeof child === "symbol") continue;
      if (!firstKey) await append(",");
      firstKey = false;
      await append(JSON.stringify(key));
      await append(":");
      await writeValue(child);
    }
    await append("}");
  };
  await writeValue(value);
  await flush();
  if (first) await writer.writeTextChunk(uri, "", false);
  onProgress?.("Backup file preparation complete · " + (charactersWritten / (1024 * 1024)).toFixed(1) + " MB");
}

async function uploadStagedJsonFile(uri: string, totalBytes: number, existingId?: string, onProgress?: (stage: string) => void, fileName: string = BACKUP_NAME) {
  let lastError: any = null;
  // A failed native transfer must not leave sync permanently failed after a
  // transient mobile-network interruption. Start a fresh resumable session once;
  // first check whether Drive actually committed the previous attempt.
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await accessToken();
    try {
      const target = existingId
        ? DRIVE_UPLOAD + "/" + encodeURIComponent(existingId) + "?uploadType=resumable&fields=id,name,modifiedTime,size"
        : DRIVE_UPLOAD + "?uploadType=resumable&fields=id,name,modifiedTime,size";
      const response = await fetchWithTimeout(target, {
        method: existingId ? "PATCH" : "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": "application/json",
          "X-Upload-Content-Length": String(totalBytes),
        },
        body: JSON.stringify({ name: fileName, mimeType: "application/json" }),
      }, 30000);
      if (!response.ok) {
        let message = "Google Drive could not start upload (HTTP " + response.status + ").";
        try { const data = await response.json(); message = data?.error?.message || message; } catch {}
        throw new Error(message);
      }
      const sessionUrl = response.headers.get("Location");
      if (!sessionUrl) throw new Error("Google Drive did not provide an upload session. Reconnect your Google account and retry.");
      const uploaded = await uploadNativeBackground(sessionUrl, token, uri, totalBytes, onProgress, 0, fileName);
      return await verifyUploadedFile(uploaded, fileName, totalBytes, existingId);
    } catch (error: any) {
      lastError = error;
      const message = String(error?.message || error || "");
      if (attempt > 0 || /HTTP 40[013]|permission|invalid_grant|missing the safe large-backup file writer/i.test(message)) throw error;
      // A timed-out response can arrive after Drive commits the file. Reuse it
      // only after exact filename and byte-size verification.
      try {
        const confirmed = await verifyUploadedFile({}, fileName, totalBytes, existingId);
        if (confirmed?.id) return confirmed;
      } catch {}
      onProgress?.("Drive upload was interrupted; safely retrying the same backup…");
      await new Promise<void>(resolve => setTimeout(resolve, 1200));
    }
  }
  throw new Error("Google Drive upload failed after a safe retry: " + String(lastError?.message || lastError || "network error") + ". Your phone data remains unchanged.");
}


function escapeDriveQuery(value: string): string {
  return String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
async function findPatientImagePdfFolder(): Promise<any | null> {
  const q = encodeURIComponent("name = '" + escapeDriveQuery(PATIENT_IMAGE_PDF_FOLDER) + "' and mimeType = '" + DRIVE_FOLDER_MIME + "' and trashed = false");
  const response = await driveRequest(DRIVE_API + "?q=" + q + "&spaces=drive&pageSize=50&includeItemsFromAllDrives=true&supportsAllDrives=true&fields=files(id,name,mimeType)");
  const data = await response.json();
  return Array.isArray(data.files) ? data.files.find((x: any) => x?.id && x.mimeType === DRIVE_FOLDER_MIME) || null : null;
}
async function getOrCreatePatientImagePdfFolder(): Promise<any> {
  const existing = await findPatientImagePdfFolder();
  if (existing?.id) return existing;
  const response = await driveRequest(DRIVE_API + "?fields=id,name,mimeType", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: PATIENT_IMAGE_PDF_FOLDER, mimeType: DRIVE_FOLDER_MIME }),
  });
  const created = await response.json();
  if (!created?.id || created.mimeType !== DRIVE_FOLDER_MIME) throw new Error("Google Drive did not confirm the separate Patient Image PDFs folder.");
  return created;
}
async function findPatientPdfInFolder(fileName: string, folderId: string): Promise<any | null> {
  const q = encodeURIComponent("'" + escapeDriveQuery(folderId) + "' in parents and name = '" + escapeDriveQuery(fileName) + "' and trashed = false");
  const response = await driveRequest(DRIVE_API + "?q=" + q + "&spaces=drive&pageSize=50&orderBy=modifiedTime%20desc&includeItemsFromAllDrives=true&supportsAllDrives=true&fields=files(id,name,mimeType,size,modifiedTime,parents,appProperties)");
  const data = await response.json();
  return Array.isArray(data.files) ? data.files.find((x: any) => x?.id && x.mimeType !== DRIVE_FOLDER_MIME) || null : null;
}
async function verifyPatientPdf(fileId: string): Promise<any> {
  const response = await driveRequest(DRIVE_API + "/" + encodeURIComponent(fileId) + "?supportsAllDrives=true&fields=id,name,mimeType,size,modifiedTime,parents,appProperties,trashed");
  const item = await response.json();
  if (!item?.id || item.trashed || item.mimeType !== "application/pdf" || Number(item.size || 0) < 8) {
    throw new Error("Google Drive did not verify the patient image PDF.");
  }
  return item;
}
async function uploadPatientPdf(archive: PatientImageArchive, folderId: string, existing?: any): Promise<any> {
  const info = await FileSystem.getInfoAsync(archive.localUri);
  if (!info.exists) throw new Error("Patient PDF is missing: " + archive.fileName);
  const size = Number(info.size || 0);
  if (size < 8) throw new Error("Patient PDF is empty: " + archive.fileName);
  const token = await accessToken();
  const fields = "id,name,mimeType,size,modifiedTime,parents,appProperties";
  const target = existing?.id
    ? DRIVE_UPLOAD + "/" + encodeURIComponent(String(existing.id)) + "?uploadType=resumable&fields=" + fields
    : DRIVE_UPLOAD + "?uploadType=resumable&fields=" + fields;
  const metadata: any = {
    name: archive.fileName, mimeType: "application/pdf",
    appProperties: { orthoPatientId: archive.patientId.slice(0, 100), orthoSourceStamp: archive.sourceStamp.slice(0, 100), orthoImageCount: String(archive.imageCount) },
  };
  if (!existing?.id) metadata.parents = [folderId];
  let response: Response | null = null;
  let lastSessionError: any = null;
  // Session creation can fail transiently on mobile data. Retry network exceptions only;
  // HTTP responses are handled below and are never blindly replayed.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetchWithTimeout(target, {
        method: existing?.id ? "PATCH" : "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": "application/pdf", "X-Upload-Content-Length": String(size) },
        body: JSON.stringify(metadata),
      }, 30000);
      lastSessionError = null;
      break;
    } catch (error: any) {
      lastSessionError = error;
      if (attempt < 2) await new Promise<void>(resolve => setTimeout(resolve, 700 * (attempt + 1)));
    }
  }
  if (!response) {
    throw new Error("Google Drive could not start uploading patient PDF " + archive.fileName + " after 3 network attempts: " + String(lastSessionError?.message || lastSessionError || "network error") + ". Local PDF remains on this phone.");
  }
  if (!response.ok) {
    let message = "Google Drive could not start patient PDF upload (HTTP " + response.status + ").";
    try { const body = await response.json(); message = body?.error?.message || message; } catch {}
    throw new Error(message);
  }
  const sessionUrl = response.headers.get("Location");
  if (!sessionUrl) throw new Error("Google Drive did not provide a patient PDF upload session.");
  const transfer = await FileSystem.uploadAsync(sessionUrl, archive.localUri, {
    httpMethod: "PUT", uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/pdf",
      "Content-Length": String(size), "Content-Range": "bytes 0-" + String(size - 1) + "/" + String(size) },
  });
  if (Number(transfer.status) < 200 || Number(transfer.status) >= 300) {
    throw new Error("Google Drive rejected patient PDF " + archive.fileName + " (HTTP " + transfer.status + ").");
  }
  const uploaded = transfer.body ? (() => { try { return JSON.parse(transfer.body); } catch { return {}; } })() : {};
  const id = String(uploaded.id || existing?.id || "");
  if (!id) throw new Error("Google Drive did not return an ID for patient PDF " + archive.fileName + ".");
  const verified = await verifyPatientPdf(id);
  const parents = Array.isArray(verified.parents) ? verified.parents : [];
  if (verified.name !== archive.fileName || Number(verified.size || 0) !== size ||
      (!parents.includes(folderId) && !existing?.id) ||
      String(verified.appProperties?.orthoSourceStamp || "") !== archive.sourceStamp) {
    throw new Error("Google Drive patient PDF verification failed for " + archive.fileName + ".");
  }
  return verified;
}
export async function ensurePatientImagePdfOnDrive(patientId: string, onProgress?: (stage: string) => void): Promise<{ fileId: string; fileName: string; url: string }> {
  return queueDriveOperation(async () => {
    const archive = await archivePatientImagesForPatient(patientId, onProgress);
    onProgress?.("Checking the Patient Image PDFs folder in Google Drive…");
    const folder = await getOrCreatePatientImagePdfFolder();
    const folderId = String(folder.id);
    const local = await FileSystem.getInfoAsync(archive.localUri);
    if (!local.exists || Number(local.size || 0) < 8) throw new Error("The patient's local PDF is missing or empty.");
    let remote: any = null;
    if (archive.driveFileId) {
      try {
        const verified = await verifyPatientPdf(archive.driveFileId);
        if (String(verified.appProperties?.orthoPatientId || "") === archive.patientId &&
            (Array.isArray(verified.parents) ? verified.parents : []).includes(folderId)) remote = verified;
      } catch { remote = null; }
    }
    if (!remote) remote = await findPatientPdfInFolder(archive.fileName, folderId);
    if (remote && remote.mimeType === "application/pdf" &&
        Number(remote.size || 0) === Number(local.size || 0) &&
        String(remote.appProperties?.orthoPatientId || "") === archive.patientId &&
        String(remote.appProperties?.orthoSourceStamp || "") === archive.sourceStamp &&
        (Array.isArray(remote.parents) ? remote.parents : []).includes(folderId)) {
      await setPatientImageArchiveDriveState(archive.fileName, archive.sourceStamp, String(remote.id));
      return { fileId: String(remote.id), fileName: archive.fileName, url: "https://drive.google.com/file/d/" + encodeURIComponent(String(remote.id)) + "/view" };
    }
    onProgress?.("Uploading this patient's PDF to Google Drive…");
    const verified = await uploadPatientPdf(archive, folderId, remote);
    await setPatientImageArchiveDriveState(archive.fileName, archive.sourceStamp, String(verified.id));
    return { fileId: String(verified.id), fileName: archive.fileName, url: "https://drive.google.com/file/d/" + encodeURIComponent(String(verified.id)) + "/view" };
  }, onProgress);
}



async function readPendingPatientPdfDeletes(): Promise<string[]> {
  try {
    const raw = await storage.secureGet(PENDING_PATIENT_PDF_DELETE_KEY, "[]");
    const value = JSON.parse(String(raw || "[]"));
    return Array.isArray(value) ? Array.from(new Set(value.map(String).filter(Boolean))) : [];
  } catch { return []; }
}
async function writePendingPatientPdfDeletes(ids: string[]): Promise<void> {
  await storage.secureSet(PENDING_PATIENT_PDF_DELETE_KEY, JSON.stringify(Array.from(new Set(ids.filter(Boolean)))));
}
async function deletePatientPdfFilesFromDrive(patientId: string): Promise<void> {
  const id = String(patientId || "").trim().slice(0, 100);
  if (!id) return;
  const folder = await findPatientImagePdfFolder();
  if (!folder?.id) return;
  const q = encodeURIComponent("'" + escapeDriveQuery(String(folder.id)) + "' in parents and appProperties has { key='orthoPatientId' and value='" + escapeDriveQuery(id) + "' } and trashed = false");
  const response = await driveRequest(DRIVE_API + "?q=" + q + "&spaces=drive&pageSize=100&includeItemsFromAllDrives=true&supportsAllDrives=true&fields=files(id,name,mimeType,appProperties)");
  const data = await response.json();
  const files = Array.isArray(data.files) ? data.files : [];
  for (const file of files) {
    if (!file?.id || file.mimeType !== "application/pdf" ||
        String(file.appProperties?.orthoPatientId || "") !== id) continue;
    await driveRequest(DRIVE_API + "/" + encodeURIComponent(String(file.id)) + "?supportsAllDrives=true", { method: "DELETE" });
  }
}
async function processPendingPatientPdfDeletes(onProgress?: (stage: string) => void): Promise<void> {
  const pending = await readPendingPatientPdfDeletes();
  if (!pending.length) return;
  const remaining: string[] = [];
  for (let i = 0; i < pending.length; i++) {
    try {
      onProgress?.("Removing deleted patient's PDF from Google Drive (" + (i + 1) + "/" + pending.length + ")…");
      await deletePatientPdfFilesFromDrive(pending[i]);
    } catch { remaining.push(pending[i]); }
  }
  await writePendingPatientPdfDeletes(remaining);
}

export async function deletePatientImagePdfFromDrive(patientId: string): Promise<void> {
  const id = String(patientId || "").trim();
  if (!id) return;
  const pending = await readPendingPatientPdfDeletes();
  if (!pending.includes(id)) pending.push(id);
  await writePendingPatientPdfDeletes(pending);
  // Remove local metadata/file immediately so later backups cannot re-upload a deleted patient's PDF.
  await removePatientImageArchive(id);
  try {
    await queueDriveOperation(async () => {
      await deletePatientPdfFilesFromDrive(id);
      await writePendingPatientPdfDeletes((await readPendingPatientPdfDeletes()).filter(value => value !== id));
    });
  } catch {
    // Leave the ID queued for the next successful Drive backup.
  }
}

export async function uploadPatientImageArchivesToDrive(onProgress?: (stage: string) => void): Promise<void> {
  await processPendingPatientPdfDeletes(onProgress);
  // Provision the folder and upload a PDF for every current patient, including newly added records.
  onProgress?.("Checking the Patient Image PDFs folder in Google Drive…");
  const folder = await getOrCreatePatientImagePdfFolder();
  const archives = await getLocalPatientImageArchives();
  if (!archives.length) {
    onProgress?.("Patient Image PDFs folder is ready; no patient PDFs are registered yet.");
    return;
  }
  const folderId = String(folder.id);
  for (let i = 0; i < archives.length; i++) {
    const archive = archives[i];
    onProgress?.("Checking patient image PDF " + (i + 1) + "/" + archives.length + ": " + archive.patientName);
    const local = await FileSystem.getInfoAsync(archive.localUri);
    if (!local.exists || Number(local.size || 0) < 8) throw new Error("The local patient PDF is missing: " + archive.fileName);
    // Verify cached IDs and folder membership on every pass. Older versions
    // could remember a PDF outside the expected folder and then skip uploading it.
    let remote: any = null;
    if (archive.driveFileId) {
      try {
        const verified = await verifyPatientPdf(archive.driveFileId);
        if (String(verified.appProperties?.orthoPatientId || "") === archive.patientId &&
            (Array.isArray(verified.parents) ? verified.parents : []).includes(folderId)) remote = verified;
      } catch { remote = null; }
    }
    if (!remote) remote = await findPatientPdfInFolder(archive.fileName, folderId);
    if (remote && remote.mimeType === "application/pdf" &&
        Number(remote.size || 0) === Number(local.size || 0) &&
        String(remote.appProperties?.orthoSourceStamp || "") === archive.sourceStamp &&
        String(remote.appProperties?.orthoPatientId || "") === archive.patientId &&
        (Array.isArray(remote.parents) ? remote.parents : []).includes(folderId)) {
      await setPatientImageArchiveDriveState(archive.fileName, archive.sourceStamp, String(remote.id));
      continue;
    }
    onProgress?.("Uploading patient PDF " + (i + 1) + "/" + archives.length + ": " + archive.fileName);
    const verified = await uploadPatientPdf(archive, folderId, remote);
    await setPatientImageArchiveDriveState(archive.fileName, archive.sourceStamp, String(verified.id));
  }
}
async function downloadPatientImageArchivesFromDrive(backup: any, onProgress?: (stage: string) => void): Promise<void> {
  const refs = new Map<string, any>();
  for (const item of Array.isArray(backup?.patientImageArchives) ? backup.patientImageArchives : []) {
    if (item?.patientId && item?.fileName) refs.set(String(item.fileName), item);
  }
  for (const patient of Array.isArray(backup?.patients) ? backup.patients : []) {
    if (patient?.id && patient?.photo_archive_file_name) {
      const fileName = String(patient.photo_archive_file_name);
      if (!refs.has(fileName)) refs.set(fileName, {
        patientId: String(patient.id), patientName: String(patient.name || "Patient"), mrNo: String(patient.mr_no || ""),
        fileName, sourceStamp: String(patient.photo_archive_source_stamp || ""),
        archivedAt: String(patient.photo_archived_at || ""), imageCount: Number(patient.photo_archive_image_count || 0),
      });
    }
  }
  if (!refs.size) return;
  const folder = await findPatientImagePdfFolder();
  if (!folder?.id) throw new Error("The separate Patient Image PDFs folder is missing in Google Drive. No patient records were restored.");
  if (!FileSystem.cacheDirectory) throw new Error("Temporary phone storage is unavailable for patient PDF restore.");
  const token = await accessToken();
  const downloaded: Array<{ ref: any; uri: string; id: string }> = [];
  try {
    let i = 0;
    for (const [fileName, ref] of refs) {
      i++;
      if (!/^[^/\\]{1,180}\.pdf$/i.test(fileName)) throw new Error("Invalid patient PDF filename in backup; restore stopped safely.");
      onProgress?.("Finding patient PDF " + i + "/" + refs.size + ": " + fileName);
      const remote = await findPatientPdfInFolder(fileName, String(folder.id));
      if (!remote?.id || remote.mimeType !== "application/pdf" || Number(remote.size || 0) < 8) {
        throw new Error("Patient image PDF '" + fileName + "' is missing or invalid. Existing patient data was not changed.");
      }
      const target = FileSystem.cacheDirectory + "ortho-patient-pdf-restore-" + Date.now() + "-" + i + ".pdf";
      onProgress?.("Downloading patient PDF " + i + "/" + refs.size + ": " + fileName);
      const result = await FileSystem.downloadAsync(DRIVE_API + "/" + encodeURIComponent(String(remote.id)) + "?alt=media",
        target, { headers: { Authorization: "Bearer " + token } });
      const info = await FileSystem.getInfoAsync(result.uri);
      if (Number(result.status || 0) < 200 || Number(result.status || 0) >= 300 ||
          !info.exists || Number(info.size || 0) < 8 || Number(info.size || 0) !== Number(remote.size || 0)) {
        throw new Error("Patient PDF download was incomplete: " + fileName + ". Existing patient data was not changed.");
      }
      downloaded.push({ ref: { ...ref, driveFileId: String(remote.id) }, uri: result.uri, id: String(remote.id) });
    }
    for (const item of downloaded) {
      await installPatientImageArchivePdf({
        patientId: String(item.ref.patientId), patientName: String(item.ref.patientName || "Patient"),
        mrNo: String(item.ref.mrNo || ""), fileName: String(item.ref.fileName),
        sourceStamp: String(item.ref.sourceStamp || ""), archivedAt: String(item.ref.archivedAt || ""),
        imageCount: Number(item.ref.imageCount || 0), driveFileId: item.id,
      }, item.uri);
    }
  } finally {
    for (const item of downloaded) { try { await FileSystem.deleteAsync(item.uri, { idempotent: true }); } catch {} }
  }
}


export async function downloadPatientImageArchiveForPatient(
  patient: { id: string; name?: string; mrNo?: string },
  onProgress?: (stage: string) => void,
): Promise<{ localUri: string; sourceStamp: string; driveFileId: string; imageCount: number }> {
  const patientId = String(patient?.id || "").trim();
  if (!patientId) throw new Error("Save the patient record before downloading its archived images.");
  const folder = await findPatientImagePdfFolder();
  if (!folder?.id) throw new Error("The Patient Image PDFs folder was not found in the connected Google Drive.");
  const archives = await getLocalPatientImageArchives();
  const local = archives.find(item => item.patientId === patientId);
  const fileName = local?.fileName;
  const token = await accessToken();
  const q = encodeURIComponent("'" + escapeDriveQuery(String(folder.id)) + "' in parents and appProperties has { key='orthoPatientId' and value='" + escapeDriveQuery(patientId.slice(0,100)) + "' } and trashed = false");
  onProgress?.("Finding this patient's archived PDF…");
  const response = await driveRequest(DRIVE_API + "?q=" + q + "&spaces=drive&pageSize=100&orderBy=modifiedTime%20desc&includeItemsFromAllDrives=true&supportsAllDrives=true&fields=files(id,name,mimeType,size,modifiedTime,parents,appProperties)");
  const data = await response.json();
  const files = Array.isArray(data.files) ? data.files : [];
  let remote = files.find((item:any) => item?.id && item.mimeType === "application/pdf" &&
    String(item.appProperties?.orthoPatientId || "") === patientId.slice(0,100) &&
    (!fileName || String(item.name || "") === fileName));
  if (!remote && fileName) {
    const byName = await findPatientPdfInFolder(fileName, String(folder.id));
    if (byName?.id && byName.mimeType === "application/pdf" &&
        String(byName.appProperties?.orthoPatientId || "") === patientId.slice(0,100)) remote = byName;
  }
  if (!remote?.id || remote.mimeType !== "application/pdf" || Number(remote.size || 0) < 8 ||
      String(remote.appProperties?.orthoPatientId || "") !== patientId.slice(0,100) ||
      !(Array.isArray(remote.parents) ? remote.parents : []).includes(String(folder.id))) {
    throw new Error("No verified image PDF for this exact patient ID was found. No other patient's images were downloaded.");
  }
  if (!FileSystem.cacheDirectory) throw new Error("Temporary phone storage is unavailable.");
  onProgress?.("Downloading archived images for " + String(patient.name || "this patient") + "…");
  const target = FileSystem.cacheDirectory + "ortho-patient-pdf-" + Date.now() + ".pdf";
  try {
    const result = await FileSystem.downloadAsync(DRIVE_API + "/" + encodeURIComponent(String(remote.id)) + "?alt=media",
      target, { headers: { Authorization: "Bearer " + token } });
    const info = await FileSystem.getInfoAsync(result.uri);
    if (Number(result.status || 0) < 200 || Number(result.status || 0) >= 300 ||
        !info.exists || Number(info.size || 0) < 8 || Number(info.size || 0) !== Number(remote.size || 0)) {
      throw new Error("The patient's PDF download was incomplete. Try again when the connection is stable.");
    }
    await installPatientImageArchivePdf({
      patientId, patientName: String(patient.name || local?.patientName || "Patient"),
      mrNo: String(patient.mrNo || local?.mrNo || ""), fileName: String(remote.name),
      sourceStamp: String(remote.appProperties?.orthoSourceStamp || local?.sourceStamp || ""),
      archivedAt: String(remote.modifiedTime || local?.archivedAt || new Date().toISOString()),
      imageCount: Number(remote.appProperties?.orthoImageCount ?? (local ? local.imageCount : -1)), driveFileId: String(remote.id),
    }, result.uri);
    const installed = await getPatientImageArchive(patientId);
    if (!installed?.localUri) throw new Error("The patient PDF was downloaded, but the verified phone copy could not be found.");
    return {
      localUri: installed.localUri,
      sourceStamp: String(remote.appProperties?.orthoSourceStamp || installed.sourceStamp || ""),
      driveFileId: String(remote.id),
      imageCount: Number(installed.imageCount || 0),
    };
  } finally {
    await FileSystem.deleteAsync(target, { idempotent: true }).catch(() => {});
  }
}

async function uploadContent(backupText: string, existingId?: string, onProgress?: (stage: string) => void, fileName: string = BACKUP_NAME) {
  const token = await accessToken();
  // The native uploader receives a file URI, not the backup string. Use it for
  // every payload size so large photo backups avoid TextEncoder's extra full-size
  // allocation and can continue on a foreground service while Android is busy.
  let useNativeBackground = Platform.OS === "android" &&
    !!NativeModules.DriveBackgroundUpload?.startUpload &&
    !!NativeModules.DriveBackgroundUpload?.getStatus;
  let stagedFileUri: string | null = null;
  let totalBytes = 0;
  let bytes: Uint8Array | null = null;

  if (useNativeBackground) {
    if (!FileSystem.cacheDirectory) throw new Error("Device cache storage is unavailable for the Drive backup.");
    stagedFileUri = FileSystem.cacheDirectory + "ortho-drive-backup-" + Date.now() + ".json";
    try {
      await writeBackupTextInChunks(stagedFileUri, backupText);
      const info = await FileSystem.getInfoAsync(stagedFileUri);
      if (!info.exists || typeof info.size !== "number" || info.size <= 0) {
        throw new Error("Could not prepare the backup file for background upload.");
      }
      totalBytes = info.size;
    } catch (error: any) {
      const detail = String(error?.message || error || "");
      try { await FileSystem.deleteAsync(stagedFileUri, { idempotent: true }); } catch {}
      if (/string length exceeds limit|value too large|too large for.*string/i.test(detail)) {
        // A bridge can reject an individual staged string on some Android
        // versions. Retry with much smaller pieces; do not fall back to a giant
        // in-memory byte array for a photo-heavy backup.
        try {
          await writeBackupTextInChunks(stagedFileUri, backupText, 16 * 1024);
          const retryInfo = await FileSystem.getInfoAsync(stagedFileUri);
          if (!retryInfo.exists || typeof retryInfo.size !== "number" || retryInfo.size <= 0) {
            throw new Error("The smaller-chunk backup file is missing or empty.");
          }
          totalBytes = retryInfo.size;
        } catch (retryError: any) {
          try { await FileSystem.deleteAsync(stagedFileUri, { idempotent: true }); } catch {}
          if (backupText.length > 8 * 1024 * 1024) {
            throw new Error(
              "Could not stage this large backup safely (" + String(retryError?.message || retryError) +
              "). The app did not allocate a second full-size upload buffer. Your local records are unchanged; free some phone storage and retry."
            );
          }
          // Small backups may still use the proven JS fallback, where its memory
          // cost is bounded. Large backups must not take this path.
          stagedFileUri = null;
          useNativeBackground = false;
          bytes = new TextEncoder().encode(backupText);
          totalBytes = bytes.length;
          onProgress?.("Using resumable upload for this small backup…");
        }
      } else if (backupText.length > 8 * 1024 * 1024) {
        throw new Error(
          "Could not prepare the large Drive backup file: " + detail +
          ". The app avoided a memory-heavy fallback. Your local records are unchanged; free phone storage and retry."
        );
      } else {
        throw new Error("Could not prepare the backup for background upload: " + detail);
      }
    }
  } else {
    bytes = new TextEncoder().encode(backupText);
    totalBytes = bytes.length;
  }

  const target = existingId
    ? DRIVE_UPLOAD + "/" + encodeURIComponent(existingId) + "?uploadType=resumable&fields=id,name,modifiedTime,size"
    : DRIVE_UPLOAD + "?uploadType=resumable&fields=id,name,modifiedTime,size";
  try {
    let initResponse: Response;
    try {
      initResponse = await fetchWithTimeout(target, {
        method: existingId ? "PATCH" : "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": "application/json",
          "X-Upload-Content-Length": String(totalBytes),
        },
        body: JSON.stringify({ name: fileName, mimeType: "application/json" }),
      }, 30000);
    } catch (error: any) {
      throw new Error("Could not start Google Drive upload session. " + (error?.message || "Check network access and retry."));
    }
    if (!initResponse.ok) {
      let message = "Google Drive could not start upload (HTTP " + initResponse.status + ").";
      try { const result = await initResponse.json(); message = result?.error?.message || message; } catch {}
      throw new Error(message);
    }
    const sessionUrl = initResponse.headers.get("Location");
    if (!sessionUrl) throw new Error("Google Drive did not provide an upload session. Reconnect your Google account and retry.");

    if (useNativeBackground && stagedFileUri) {
      // The Android foreground service owns the file transfer. It continues
      // sending 512 KiB Drive chunks while the app is backgrounded or the
      // screen is locked, and reconciles progress with Drive after interruptions.
      const nativeResult = await uploadNativeBackground(sessionUrl, token, stagedFileUri, totalBytes, onProgress, 0, fileName);
      return await verifyUploadedFile(nativeResult, fileName, totalBytes, existingId);
    }

    try {
      const uploaded = await uploadResumable(sessionUrl, token, bytes as Uint8Array, onProgress);
      return await verifyUploadedFile(uploaded, fileName, totalBytes, existingId);
    } catch (error: any) {
      const originalMessage = String(error?.message || "Google Drive resumable upload failed.");
      if (originalMessage.includes("stopped after 5 minutes")) throw error;
      if ((bytes as Uint8Array).length > 8 * 1024 * 1024) {
        throw new Error(
          "Google Drive resumable upload failed: " + originalMessage +
          " The backup is too large for the safe fallback, so no second full-file copy was attempted. Your data is still on this phone. Check Drive permission/network and retry."
        );
      }
      const boundary = "ortho_logbook_drive_" + Date.now().toString(36);
      const metadata = JSON.stringify({ name: fileName, mimeType: "application/json" });
      const body = "--" + boundary + "\r\n" +
        "Content-Type: application/json; charset=UTF-8\r\n" +
        "\r\n" + metadata + "\r\n" +
        "--" + boundary + "\r\n" +
        "Content-Type: application/json; charset=UTF-8\r\n" +
        "\r\n" + backupText + "\r\n" +
        "--" + boundary + "--\r\n";
      const retryTarget = existingId
        ? DRIVE_UPLOAD + "/" + encodeURIComponent(existingId) + "?uploadType=multipart&fields=id,name,modifiedTime,size"
        : DRIVE_UPLOAD + "?uploadType=multipart&fields=id,name,modifiedTime,size";
      try {
        const retry = await fetchWithTimeout(retryTarget, {
          method: existingId ? "PATCH" : "POST",
          headers: { Authorization: "Bearer " + token, "Content-Type": "multipart/related; boundary=" + boundary },
          body,
        }, 45000);
        if (retry.ok) return await verifyUploadedFile(await retry.json(), fileName, totalBytes, existingId);
        let message = "Google Drive multipart fallback failed (HTTP " + retry.status + ").";
        try { const data = await retry.json(); message = data?.error?.message || message; } catch {}
        throw new Error(message);
      } catch (retryError: any) {
        const retryMessage = String(retryError?.message || "Network request failed");
        throw new Error("Resumable upload failed: " + originalMessage + " Alternate multipart upload failed: " + retryMessage + ". Local records are unchanged; retry when Google Drive connectivity is available.");
      }
    }
  } finally {
    if (stagedFileUri) {
      // The service has finished (successfully or with an error) before this
      // promise settles; remove only its temporary export, never the database.
      try { await FileSystem.deleteAsync(stagedFileUri, { idempotent: true }); } catch {}
    }
  }
}

async function backupContentHash(backupText: string, onProgress?: (stage: string) => void) {
  // Hash the existing string in place rather than creating a second 50+ MiB
  // string with replace(). Ignore only the generated createdAt value so a
  // backup with unchanged records can still be recognized on later runs.
  const timestampMatch = /("createdAt"\s*:\s*")[^"]*(")/.exec(backupText);
  const ignoreStart = timestampMatch ? timestampMatch.index + timestampMatch[1].length : -1;
  const ignoreEnd = timestampMatch ? timestampMatch.index + timestampMatch[0].length - timestampMatch[2].length : -1;
  const ignoredTimestamp = "IGNORED_TIMESTAMP";
  let hash = 2166136261;
  const yieldEvery = 256 * 1024;
  for (let i = 0; i < backupText.length; i++) {
    if (i === ignoreStart) {
      for (let j = 0; j < ignoredTimestamp.length; j++) {
        hash ^= ignoredTimestamp.charCodeAt(j);
        hash = Math.imul(hash, 16777619);
      }
      i = ignoreEnd - 1;
      continue;
    }
    hash ^= backupText.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
    if (i > 0 && i % yieldEvery === 0) {
      onProgress?.("Checking backup contents… " + Math.min(99, Math.round((i / backupText.length) * 100)) + "%");
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  }
  return `fnv1a-${(hash >>> 0).toString(16)}-${backupText.length}`;
}


function mergeRowsByRecency(currentRows: any[], incomingRows: any[], table: string): any[] {
  const rows = new Map<string, any>();
  const keyFor = (row: any) => table === "inventory"
    ? "item:" + [row?.name, row?.category, row?.size].map((v) => String(v || "").trim().toLowerCase()).join("|")
    : row?.id != null ? "id:" + String(row.id) : "row:" + JSON.stringify(row);
  for (const row of currentRows || []) rows.set(keyFor(row), row);
  for (const row of incomingRows || []) {
    const key = keyFor(row);
    const current = rows.get(key);
    if (!current) {
      rows.set(key, row);
      continue;
    }
    const currentTime = Date.parse(String(current.updated_at || current.created_at || current.deleted_at || current.date || ""));
    const incomingTime = Date.parse(String(row.updated_at || row.created_at || row.deleted_at || row.date || ""));
    if (Number.isFinite(incomingTime) && (!Number.isFinite(currentTime) || incomingTime > currentTime)) {
      rows.set(key, row);
    }
  }
  return Array.from(rows.values());
}

function applyIncrementalToMaster(local: any, incoming: any, preserveCurrent = false) {
  if (incoming?.photoAssets && typeof incoming.photoAssets === "object") {
    local.photoAssets = { ...(local.photoAssets || {}), ...(incoming.photoAssets || {}) };
  }
  if (Array.isArray(incoming?.patientImageArchives)) {
    const archives = new Map<string, any>((Array.isArray(local.patientImageArchives) ? local.patientImageArchives : [])
      .filter((x:any) => x?.patientId).map((x:any) => [String(x.patientId), x]));
    for (const item of incoming.patientImageArchives) if (item?.patientId) {
      archives.set(String(item.patientId), { ...archives.get(String(item.patientId)), ...item });
    }
    local.patientImageArchives = Array.from(archives.values());
  }
  const tables = [
    "patients", "procedures", "inventoryCategories", "inventory", "patientImplants",
    "patientCustomFields", "implantRecords", "expenses", "users", "patientHistory",
    "inventoryMovements", "inventoryPurchaseReceipts", "stockReceipts", "trash",
  ];
  const changed = new Set<string>(Array.isArray(incoming.changedTables) ? incoming.changedTables : []);
  const full = new Set<string>(Array.isArray(incoming.fullTables) ? incoming.fullTables : []);
  for (const table of tables) {
    if (!changed.has(table) || !Array.isArray(incoming[table])) continue;
    if (incoming._rowDelta !== true || full.has(table)) {
      // When a journal began with a full-table baseline, merge by recency to
      // protect newer records from other devices, then apply explicit tombstones
      // accumulated by later edits. Re-added rows have their tombstones removed
      // by mergeIncrementalPayloads, so this cannot erase a later recreation.
      let mergedRows = mergeRowsByRecency(local[table] || [], incoming[table], table);
      const deletedIds = new Set<string>(Array.isArray(incoming.deletedIds?.[table]) ? incoming.deletedIds[table].map(String) : []);
      if (deletedIds.size) mergedRows = mergedRows.filter((row: any) => row?.id == null || !deletedIds.has(String(row.id)));
      local[table] = mergedRows;
      continue;
    }
    const rows = new Map<string, any>();
    const keyForRow = (row: any) => table === "inventory"
      ? "item:" + [row?.name, row?.category, row?.size].map((v) => String(v || "").trim().toLowerCase()).join("|")
      : row?.id != null ? "id:" + String(row.id) : "row:" + JSON.stringify(row);
    for (const row of Array.isArray(local[table]) ? local[table] : []) rows.set(keyForRow(row), row);
    if (!preserveCurrent) {
      for (const id of Array.isArray(incoming.deletedIds?.[table]) ? incoming.deletedIds[table] : []) {
        if (table === "inventory") {
          for (const [key, row] of rows.entries()) if (String(row?.id ?? "") === String(id)) rows.delete(key);
        } else rows.delete("id:" + String(id));
      }
    }
    for (const row of incoming[table]) {
      const key = keyForRow(row);
      const old = rows.get(key);
      if (preserveCurrent && old) {
        const oldTime = Date.parse(String(old.updated_at || old.created_at || old.deleted_at || old.date || ""));
        const newTime = Date.parse(String(row.updated_at || row.created_at || row.deleted_at || row.date || ""));
        if (Number.isFinite(newTime) && (!Number.isFinite(oldTime) || newTime > oldTime)) {
          if (table === "patients" &&
              !Object.prototype.hasOwnProperty.call(row, "photo_uri") &&
              !Object.prototype.hasOwnProperty.call(row, "photos_json")) {
            rows.set(key, { ...old, ...row });
          } else {
            rows.set(key, row);
          }
        }
        continue;
      }
      if (table === "patients" && old &&
          !Object.prototype.hasOwnProperty.call(row, "photo_uri") &&
          !Object.prototype.hasOwnProperty.call(row, "photos_json")) {
        rows.set(key, { ...old, ...row });
      } else {
        rows.set(key, row);
      }
    }
    local[table] = Array.from(rows.values());
  }
  if (Object.prototype.hasOwnProperty.call(incoming, "branding")) local.branding = incoming.branding;
  if (Object.prototype.hasOwnProperty.call(incoming, "appSettings")) local.appSettings = incoming.appSettings;
}

async function cleanupLegacyNonMonthlyBackups(_keepFileId: string): Promise<string[]> {
  // Keep legacy backups and journals as recovery sources. The rolling master replaces
  // ongoing monthly duplication, but migration never deletes older patient records.
  return [];
}
type DriveBackupOptions = { skipIfUnchanged?: boolean; onProgress?: (stage: string) => void; preferDriveOnMigration?: boolean; backupTextOverride?: string; backupDataOverride?: any; localChanges?: any };

async function backupToGoogleDriveUnlocked(
  _password?: string,
  filter: BackupFilter = { type: "all" },
  options: DriveBackupOptions = {},
) {
  options.onProgress?.("Preparing backup data…");
  const isMasterBackup = filter.type === "all";
  if (isMasterBackup) {
    await archiveEligiblePatientImages(options.onProgress);
    await uploadPatientImageArchivesToDrive(options.onProgress);
  }
  const migrationMarker = String((await storage.secureGet(MASTER_MIGRATION_KEY, "")) || "");
  const canStream = isMasterBackup && Platform.OS === "android" &&
    !!NativeModules.DriveBackgroundUpload?.writeTextChunk &&
    !!NativeModules.DriveBackgroundUpload?.startUpload &&
    !!NativeModules.DriveBackgroundUpload?.getStatus &&
    !options.backupTextOverride;

  let backupText: string | null = null;
  let stagedFileUri: string | null = null;
  let stagedFileSize = 0;
  let migrationComplete = true;
  let cleanupSafe = true;
  let migrationAttempted = false;
  let seededCacheForLocalSnapshot = false;

  if (canStream) {
    options.onProgress?.("Preparing large backup in small pieces…");
    let backupData: any = options.backupDataOverride || await exportUnencryptedBackupData(filter, options.onProgress);
    if (!options.backupDataOverride) {
      // Cache only metadata/media signatures; do not stringify the full photo payload.
      await prepareIncrementalSnapshotCacheFromBackupData("", backupData);
      seededCacheForLocalSnapshot = true;
    }
    if (migrationMarker !== "1") {
      // First upload after the new backup system starts is a fresh snapshot of
      // this phone's complete app data. Never merge old Drive backups/journals.
      migrationAttempted = true;
      migrationComplete = true;
      cleanupSafe = true;
      options.onProgress?.("Creating a fresh full backup from this phone; old backups will not be merged…");
      backupData.version = Math.max(Number(backupData.version || 0), 7);
      backupData.createdAt = new Date().toISOString();
      backupData.filter = { type: "all" };
      delete backupData.incremental;
      delete backupData.changedTables;
      delete backupData._rowDelta;
      delete backupData.deletedIds;
      delete backupData.fullTables;
      pruneBackupPhotoAssets(backupData);
    }
    pruneBackupPhotoAssets(backupData);
    if (!FileSystem.cacheDirectory) throw new Error("Device cache storage is unavailable for the Drive backup.");
    stagedFileUri = FileSystem.cacheDirectory + "ortho-drive-stream-" + Date.now() + ".json";
    try {
      await writeBackupObjectToFile(stagedFileUri, backupData, options.onProgress);
      const info = await FileSystem.getInfoAsync(stagedFileUri);
      if (!info.exists || typeof info.size !== "number" || info.size <= 0) {
        throw new Error("The streamed backup file is missing or empty. Local data remains unchanged.");
      }
      stagedFileSize = info.size;
    } catch (error: any) {
      try { await FileSystem.deleteAsync(stagedFileUri, { idempotent: true }); } catch {}
      stagedFileUri = null;
      throw new Error("Could not prepare the large backup in safe chunks: " + String(error?.message || error) + ". Local data remains on this phone; retry after installing the latest APK.");
    }
  } else {
    backupText = options.backupTextOverride || (options.backupDataOverride
      ? JSON.stringify(options.backupDataOverride)
      : await exportUnencryptedBackup(filter, options.onProgress));
    if (isMasterBackup && migrationMarker !== "1") {
      // The first upload is always the complete local app snapshot. Do not read,
      // merge, or apply any legacy Drive backup or its old change journal.
      migrationAttempted = true;
      migrationComplete = true;
      cleanupSafe = true;
      const initialMaster = parseDownloadedBackup(backupText);
      if (!initialMaster || initialMaster.app !== "Ortho Logbook" ||
          !Array.isArray(initialMaster.patients) || !Array.isArray(initialMaster.inventory)) {
        throw new Error("The first full local backup is incomplete; existing Drive files were not changed.");
      }
      initialMaster.version = Math.max(Number(initialMaster.version || 0), 7);
      initialMaster.createdAt = new Date().toISOString();
      initialMaster.filter = { type: "all" };
      delete initialMaster.incremental;
      delete initialMaster.changedTables;
      delete initialMaster._rowDelta;
      delete initialMaster.deletedIds;
      delete initialMaster.fullTables;
      pruneBackupPhotoAssets(initialMaster);
      backupText = JSON.stringify(initialMaster);
    }
  }

  options.onProgress?.("Checking whether backup changed…");
  const contentHash = stagedFileUri
    ? "streamed-" + stagedFileSize + "-" + Date.now()
    : await backupContentHash(backupText as string, options.onProgress);
  const fileName = driveBackupName(filter);
  options.onProgress?.("Finding the master Drive backup…");
  let existing = await findBackupByName(fileName);
  if (!existing && filter.type === "all") existing = await findBackupByName(BACKUP_NAME);
  const previousHash = await storage.getItem(LAST_DRIVE_CONTENT_HASH_KEY + ":" + fileName, "");
  const previousSuccess = await getLastDriveBackupStatus();
  if (!stagedFileUri && existing?.id && previousSuccess && options.skipIfUnchanged && previousHash === contentHash &&
      (!isMasterBackup || (!migrationAttempted && migrationMarker === "1"))) {
    return { skipped: true, completedAt: previousSuccess, accountEmail: getConnectedGoogleAccount(), name: fileName };
  }

  options.onProgress?.("Uploading backup to Google Drive…");
  let result: any;
  try {
    result = stagedFileUri
      ? await uploadStagedJsonFile(stagedFileUri, stagedFileSize, existing?.id, options.onProgress, fileName)
      : await uploadContent(backupText as string, existing?.id, options.onProgress, fileName);
  } finally {
    if (stagedFileUri) {
      try { await FileSystem.deleteAsync(stagedFileUri, { idempotent: true }); } catch {}
    }
  }
  await markBackupTaken();
  const completedAt = new Date().toISOString();
  await storage.secureSet(LAST_DRIVE_BACKUP_KEY, completedAt);
  await storage.setItem(LAST_DRIVE_CONTENT_HASH_KEY + ":" + fileName, contentHash);
  const cleanupFailures: string[] = [];
  if (isMasterBackup && result?.id) {
    if (stagedFileUri) {
      await verifyStreamedDriveFile(String(result.id), fileName, stagedFileSize);
    } else {
      const verifiedMaster = await downloadDriveJsonValidated(String(result.id));
      if (!verifiedMaster || verifiedMaster.app !== "Ortho Logbook" ||
          !Array.isArray(verifiedMaster.patients) || !Array.isArray(verifiedMaster.inventory)) {
        throw new Error("The all-time backup could not be verified. Older Drive backups were kept; retry backup after checking the connection.");
      }
    }
    await storage.secureSet(MASTER_MIGRATION_KEY, "1");
    await storage.secureSet(MASTER_LOCAL_SNAPSHOT_VERSION_KEY, "1");
  }
  // Legacy backup files are retained as recovery copies; no history-wide cleanup.
  if (isMasterBackup && seededCacheForLocalSnapshot && result?.id) {
    await commitIncrementalSnapshotCache(String(result.id) + ":" + String(result.modifiedTime || ""));
  }
  if (isMasterBackup) {
    const archiveCursor = String((await storage.secureGet(MONTH_ARCHIVE_CURSOR_KEY, "")) || "");
    if (!/^\d{4}-\d{2}$/.test(archiveCursor)) {
      // Don't trigger a second huge archive upload right after the first baseline.
      await storage.secureSet(MONTH_ARCHIVE_CURSOR_KEY, monthKeyFromDate(new Date()));
    }
  }
  // A verified full monthly snapshot supersedes that month's journal. Removing
  // the old journal prevents deletions/edits from being applied twice on restore.
  if (isMasterBackup && result?.id && (!migrationAttempted || (migrationComplete && cleanupSafe))) {
    const monthJournal = await findBackupByName("Ortho Logbook Backup Changes.orbackup");
    if (monthJournal?.id) {
      try { await driveRequest(DRIVE_API + "/" + encodeURIComponent(String(monthJournal.id)) + "?supportsAllDrives=true", { method: "DELETE" }); }
      catch (error) { console.warn("[drive-backup] monthly journal cleanup deferred", error); }
    }
  }
  // Do not launch a second large upload after a full snapshot; it previously
  // restarted the progress bar near 100% while archiving another huge file.
  return {
    ...result, skipped: false, completedAt, name: fileName, accountEmail: getConnectedGoogleAccount(),
    cleanupFailures, migrationPending: isMasterBackup && (!migrationComplete || !cleanupSafe || cleanupFailures.length > 0),
  };
}

export function backupToGoogleDrive(
  password?: string,
  filter: BackupFilter = { type: "all" },
  options: DriveBackupOptions = {},
): Promise<any> {
  // Drive stores one rolling all-time master; period filters are for restore/export, not separate Drive snapshots.
  return queueDriveOperation(() => backupToGoogleDriveUnlocked(password, { type: "all" }, options), options.onProgress);
}

async function listIncrementalFiles() {
  const q = encodeURIComponent("name contains 'Ortho Logbook' and trashed = false");
  const files: any[] = [];
  let pageToken = "";
  do {
    const tokenParam = pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : "";
    const response = await driveRequest(`${DRIVE_API}?q=${q}&spaces=drive&pageSize=100&orderBy=modifiedTime%20asc&includeItemsFromAllDrives=true&supportsAllDrives=true&fields=files(id,name,modifiedTime,size,mimeType),nextPageToken${tokenParam}`);
    const data = await response.json();
    if (Array.isArray(data.files)) files.push(...data.files);
    pageToken = typeof data.nextPageToken === "string" ? data.nextPageToken : "";
  } while (pageToken);
  return files.filter((file: any) =>
    /Ortho Logbook Incremental/i.test(String(file.name || "")) ||
    /^Ortho Logbook Backup Changes\.orbackup$/i.test(String(file.name || "")) ||
    /^Ortho Logbook Backup - Month \d{4}-\d{2} Changes\.orbackup$/i.test(String(file.name || ""))
  );
}


async function downloadDriveJson(fileId: string, onProgress?: (message: string) => void): Promise<string> {
  const url = DRIVE_API + "/" + encodeURIComponent(fileId) + "?alt=media";
  const token = await accessToken();
  const background = NativeModules.DriveBackgroundUpload;
  if (Platform.OS === "android" && typeof background?.startDownload === "function" && typeof background?.getStatus === "function" && FileSystem.cacheDirectory) {
    const targetUri = FileSystem.cacheDirectory + "ortho-drive-restore-" + fileId.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json";
    // Keep any partial file from a previous interrupted attempt. The native
    // service validates the server's Content-Range before appending, and starts
    // from byte zero if Drive does not support range resume.
    const taskId = await background.startDownload(url, token, targetUri);
    let lastPercent = -1;
    let lastLoaded = -1;
    let lastTotal = -1;
    let lastStatus = "";
    let lastProgressAt = Date.now();
    while (true) {
      const status = await background.getStatus(taskId);
      const loaded = Math.max(0, Number(status?.downloadedBytes ?? status?.bytesDownloaded ?? status?.bytesWritten ?? status?.receivedBytes ?? status?.bytesReceived ?? status?.uploadedBytes ?? 0));
      const total = Math.max(0, Number(status?.totalBytes ?? status?.contentLength ?? status?.total ?? 0));
      const rawPercent = Number(status?.progress);
      const percent = Math.max(0, Math.min(100, Number.isFinite(rawPercent) && rawPercent > 0
        ? rawPercent : total > 0 ? Math.floor((loaded / total) * 100) : 0));
      const currentStatus = String(status?.status || "");
      // Native download progress often advances bytes while integer percent
      // remains 0 (or is not supplied). Update the app whenever bytes/status
      // change, not only when the percent changes.
      if (percent !== lastPercent || loaded !== lastLoaded || total !== lastTotal || currentStatus !== lastStatus) {
        lastPercent = percent;
        lastLoaded = loaded;
        lastTotal = total;
        lastStatus = currentStatus;
        lastProgressAt = Date.now();
        onProgress?.(total > 0
          ? "Downloading master backup: " + percent + "% (" + (loaded / 1048576).toFixed(1) + " / " + (total / 1048576).toFixed(1) + " MB)"
          : "Downloading master backup: " + (loaded / 1048576).toFixed(1) + " MB received" + (currentStatus ? " · " + currentStatus : ""));
      } else if (Date.now() - lastProgressAt > 10 * 60 * 1000) {
        // Do not cancel a native foreground-service download just because Android
        // paused this JavaScript loop while the app was backgrounded. The native
        // service owns retry/resume and may still be waiting for mobile data.
        onProgress?.("Background download is still running; waiting for the native service to resume the connection…");
        lastProgressAt = Date.now();
      }
      if (status?.status === "completed") {
        onProgress?.("Backup file downloaded. Validating contents…");
        const info = await FileSystem.getInfoAsync(targetUri);
        if (!info.exists || Number(info.size || 0) <= 0) throw new Error("Background download completed without a readable backup file.");
        // Read through a native buffered reader in bounded chunks. This avoids
        // Expo allocating a second full-size Java String for large backups.
        // JSON parsing still occurs after the downloaded text has been collected.
        if (typeof background.openTextReader === "function" && typeof background.readTextChunk === "function") {
          const readerId = await background.openTextReader(targetUri);
          const chunks: string[] = [];
          try {
            while (true) {
              const chunk = await background.readTextChunk(readerId, 196608);
              if (chunk?.text) chunks.push(String(chunk.text));
              if (chunk?.done) break;
            }
            return chunks.join("");
          } finally {
            try { await background.closeTextReader?.(readerId); } catch {}
          }
        }
        return await FileSystem.readAsStringAsync(targetUri);
      }
      if (status?.status === "error") throw new Error(String(status?.error || "Background Google Drive download failed."));
      await new Promise<void>(resolve => setTimeout(resolve, 700));
    }
  }
  return await new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url);
    xhr.setRequestHeader("Authorization", "Bearer " + token);
    xhr.timeout = 10 * 60 * 1000;
    xhr.onprogress = (event) => {
      const loaded = Number(event.loaded || 0);
      const total = Number(event.total || 0);
      if (total > 0) {
        const percent = Math.min(99, Math.floor((loaded / total) * 100));
        onProgress?.("Downloading backup file: " + percent + "% (" + (loaded / 1048576).toFixed(1) + " / " + (total / 1048576).toFixed(1) + " MB)");
      } else onProgress?.("Downloading backup file: " + (loaded / 1048576).toFixed(1) + " MB received");
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.("Backup file downloaded. Validating contents…");
        resolve(xhr.responseText || "");
        return;
      }
      let message = "Google Drive backup download failed (HTTP " + xhr.status + ").";
      try { const data = JSON.parse(xhr.responseText || "{}"); message = data?.error?.message || message; } catch {}
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error("Google Drive backup download failed. Check your internet connection and Google Drive access."));
    xhr.ontimeout = () => reject(new Error("Google Drive backup download timed out. You can retry without changing local records."));
    xhr.onabort = () => reject(new Error("Google Drive backup download was cancelled."));
    xhr.send();
  });
}

// Drive media can contain a BOM/XSSI prefix or a JSON string wrapping the
// actual document (some older upload paths produced this). Normalize those
// harmless wrappers before deciding that a backup is unreadable.
function parseDownloadedBackup(raw: string): any {
  let text = String(raw || "").replace(/^\uFEFF/, "").trim();
  if (!text) throw new Error("Google Drive returned an empty backup file.");
  text = text.replace(/^\)\]}'[,]?\s*/, "");
  // Accept legacy Markdown-fenced exports and base64 data-URI wrappers.
  text = text.replace(/^\x60{3}(?:json)?\s*/i, "").replace(/\s*\x60{3}\s*$/, "").trim();
  const dataUri = /^data:application\/(?:json|octet-stream);base64,([\s\S]+)$/i.exec(text);
  if (dataUri) text = decodeBackupBase64(dataUri[1]);
  let parsed: any;
  try { parsed = JSON.parse(text); } catch (firstError: any) {
    if (/^[A-Za-z0-9+/=\r\n]+$/.test(text) && text.length > 16) {
      try { parsed = JSON.parse(decodeBackupBase64(text)); } catch {
        throw new Error("Google Drive file is not valid backup JSON (plain and base64 formats both failed).");
      }
    } else {
      throw new Error("Google Drive file is not valid backup JSON: " + String(firstError?.message || firstError));
    }
  }
  if (typeof parsed === "string") {
    const inner = parsed.replace(/^\uFEFF/, "").trim();
    if (!inner) throw new Error("Google Drive backup contains an empty wrapped document.");
    parsed = JSON.parse(inner);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Google Drive file does not contain a valid Ortho Logbook backup.");
  }
  return parsed;
}
function decodeBackupBase64(value: string): string {
  try {
    const decoded = globalThis.atob(value.replace(/\s/g, ""));
    return decodeURIComponent(Array.from(decoded, ch => "%" + ch.charCodeAt(0).toString(16).padStart(2, "0")).join(""));
  } catch { throw new Error("Google Drive backup base64 content could not be decoded."); }
}

async function downloadDriveJsonValidated(fileId: string, onProgress?: (message: string) => void): Promise<any> {
  // Do not restart a multi-hundred-MB download just because parsing/validation
  // failed after the bytes were already received. The old retry loop wrapped
  // both download and JSON parsing, so an invalid/too-large JSON parse at 99%
  // restarted the entire transfer up to three times and looked like progress
  // was resetting. Download once, then validate that same downloaded payload.
  const raw = await downloadDriveJson(fileId, onProgress);
  onProgress?.("Master backup downloaded. Checking file contents…");
  try {
    return parseDownloadedBackup(raw);
  } catch (error: any) {
    const detail = String(error?.message || error || "Unknown validation error");
    throw new Error("The master backup finished downloading, but validation failed: " + detail + " The downloaded file was kept on the phone; retrying will not silently restart the same download.");
  }
}

// If an incremental JSON document was truncated, recover complete table
// values that still parse. Full baselines are never reconstructed this way.
function extractCompleteJsonProperty(text: string, key: string): any {
  const quoted = '"' + key + '"';
  const keyIndex = text.indexOf(quoted);
  if (keyIndex < 0) return undefined;
  let start = keyIndex + quoted.length;
  while (/\s/.test(text[start] || "")) start++;
  if (text[start] !== ":") return undefined;
  start++;
  while (/\s/.test(text[start] || "")) start++;
  const first = text[start];
  if (first === "[" || first === "{") {
    const close = first === "[" ? "]" : "}";
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === first) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(text.slice(start, i + 1)); } catch { return undefined; }
        }
      }
    }
    // For a truncated array, keep only complete top-level elements before
    // the cut-off. This can recover earlier patient/stock rows without
    // fabricating the incomplete final row.
    if (first === "[") {
      const values: any[] = [];
      let itemStart = start + 1;
      const stack: string[] = [];
      let inString = false, escaped = false;
      for (let i = start + 1; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === "\\") escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === "{" || ch === "[") stack.push(ch);
        else if (ch === "}" || ch === "]") {
          if (stack.length) stack.pop();
          else if (ch === "]") {
            const tail = text.slice(itemStart, i).trim();
            if (tail) { try { values.push(JSON.parse(tail)); } catch {} }
            return values.length ? values : undefined;
          }
        } else if (ch === "," && stack.length === 0) {
          const item = text.slice(itemStart, i).trim();
          if (item) { try { values.push(JSON.parse(item)); } catch { break; } }
          itemStart = i + 1;
        }
      }
      return values.length ? values : undefined;
    }
    return undefined;
  }
  let end = start, inString = false, escaped = false;
  for (; end < text.length; end++) {
    const ch = text[end];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "," || ch === "}" || ch === "]") break;
  }
  try { return JSON.parse(text.slice(start, end).trim()); } catch { return undefined; }
}

async function downloadIncrementalWithRecovery(fileId: string, fileName: string): Promise<{ data: any; warning?: string }> {
  try {
    const data = await downloadDriveJsonValidated(fileId);
    return { data };
  } catch {
    // A second pass tries to salvage complete table arrays from a truncated
    // JSON payload. Never invent missing rows or overwrite a table with [].
    let raw = "";
    try { raw = (await downloadDriveJson(fileId)).replace(/^\uFEFF/, "").trim(); } catch {}
    const app = extractCompleteJsonProperty(raw, "app");
    const changedTables = extractCompleteJsonProperty(raw, "changedTables");
    const rowDelta = extractCompleteJsonProperty(raw, "_rowDelta") === true;
    const deletedIds = extractCompleteJsonProperty(raw, "deletedIds");
    const fullTables = extractCompleteJsonProperty(raw, "fullTables");
    if (app !== "Ortho Logbook") {
      throw new Error("Incremental backup " + fileName + " could not be recovered. Its contents are unavailable or corrupted.");
    }
    const knownTables = ["patients","procedures","inventoryCategories","inventory","patientImplants","patientCustomFields","implantRecords","expenses","users","patientHistory","inventoryMovements","inventoryPurchaseReceipts","stockReceipts","trash"];
    const recovered: any = { app, incremental: true, _recoveredFromDamage: true, changedTables: Array.isArray(changedTables) ? changedTables : [], _rowDelta: rowDelta, deletedIds: deletedIds && typeof deletedIds === "object" ? deletedIds : {}, fullTables: Array.isArray(fullTables) ? fullTables : [] };
    for (const table of knownTables) {
      const value = extractCompleteJsonProperty(raw, table);
      if (Array.isArray(value)) recovered[table] = value;
    }
    const branding = extractCompleteJsonProperty(raw, "branding");
    if (branding !== undefined) recovered.branding = branding;
    const appSettings = extractCompleteJsonProperty(raw, "appSettings");
    if (appSettings !== undefined && appSettings && typeof appSettings === "object") recovered.appSettings = appSettings;
    if (!recovered.changedTables.length) recovered.changedTables = [
      ...knownTables.filter(table => Array.isArray(recovered[table])),
      ...(Object.prototype.hasOwnProperty.call(recovered, "branding") ? ["branding"] : []),
      ...(Object.prototype.hasOwnProperty.call(recovered, "appSettings") ? ["appSettings"] : []),
    ];
    if (!recovered.changedTables.some((table: string) => Array.isArray(recovered[table]) || (table === "branding" && Object.prototype.hasOwnProperty.call(recovered, "branding")) || (table === "appSettings" && Object.prototype.hasOwnProperty.call(recovered, "appSettings")))) {
      throw new Error("Incremental backup " + fileName + " is damaged and contains no recoverable complete table. The full backup and other readable updates can still be restored.");
    }
    return { data: recovered, warning: fileName + " was damaged; only complete table data could be recovered." };
  }
}

function mergeIncrementalPayloads(previous: any, incoming: any): any {
  if (!previous) return incoming;
  const tableNames = [
    "patients", "procedures", "inventoryCategories", "inventory", "patientImplants",
    "patientCustomFields", "implantRecords", "expenses", "users", "patientHistory",
    "inventoryMovements", "inventoryPurchaseReceipts", "stockReceipts", "trash",
  ];
  const changedTables = Array.from(new Set([
    ...(Array.isArray(previous.changedTables) ? previous.changedTables : []),
    ...(Array.isArray(incoming.changedTables) ? incoming.changedTables : []),
  ]));
  const previousFull = new Set<string>(Array.isArray(previous.fullTables) ? previous.fullTables : []);
  const incomingFull = new Set<string>(Array.isArray(incoming.fullTables) ? incoming.fullTables : []);
  const fullTables = new Set<string>(previousFull);
  const deletedIds: Record<string, string[]> = {
    ...(previous.deletedIds && typeof previous.deletedIds === "object" ? previous.deletedIds : {}),
  };
  const merged: any = { ...previous, ...incoming, changedTables, fullTables: [] };
  merged.photoAssets = { ...(previous.photoAssets || {}), ...(incoming.photoAssets || {}) };
  const archiveMap = new Map<string, any>((Array.isArray(previous.patientImageArchives) ? previous.patientImageArchives : [])
    .filter((x:any) => x?.patientId).map((x:any) => [String(x.patientId), x]));
  for (const item of Array.isArray(incoming.patientImageArchives) ? incoming.patientImageArchives : []) {
    if (item?.patientId) archiveMap.set(String(item.patientId), { ...archiveMap.get(String(item.patientId)), ...item });
  }
  merged.patientImageArchives = Array.from(archiveMap.values());

  for (const table of tableNames) {
    const wasChanged = Array.isArray(previous.changedTables) && previous.changedTables.includes(table);
    const isChanged = Array.isArray(incoming.changedTables) && incoming.changedTables.includes(table);
    if (!isChanged) continue;
    const newRows = Array.isArray(incoming[table]) ? incoming[table] : [];
    const oldRows = Array.isArray(previous[table]) ? previous[table] : [];
    const incomingIsFull = incoming._rowDelta !== true || incomingFull.has(table);

    if (incomingIsFull) {
      merged[table] = newRows;
      fullTables.add(table);
      deletedIds[table] = Array.isArray(incoming.deletedIds?.[table]) ? incoming.deletedIds[table] : [];
      continue;
    }

    const rows = new Map<string, any>();
    if (wasChanged) {
      for (const row of oldRows) {
        const key = row && row.id != null ? "id:" + String(row.id) : "row:" + JSON.stringify(row);
        rows.set(key, row);
      }
    }
    const tombstones = new Set<string>([
      ...(Array.isArray(deletedIds[table]) ? deletedIds[table].map(String) : []),
      ...(Array.isArray(incoming.deletedIds?.[table]) ? incoming.deletedIds[table].map(String) : []),
    ]);
    for (const id of incoming.deletedIds?.[table] || []) rows.delete("id:" + String(id));
    for (const row of newRows) {
      const key = row && row.id != null ? "id:" + String(row.id) : "row:" + JSON.stringify(row);
      const old = rows.get(key);
      if (table === "patients" && old &&
          !Object.prototype.hasOwnProperty.call(row, "photo_uri") &&
          !Object.prototype.hasOwnProperty.call(row, "photos_json")) {
        rows.set(key, { ...old, ...row });
      } else {
        rows.set(key, row);
      }
      if (row && row.id != null) tombstones.delete(String(row.id));
    }
    merged[table] = Array.from(rows.values());
    deletedIds[table] = Array.from(tombstones);
  }

  for (const table of ["branding", "appSettings"]) {
    if (!Object.prototype.hasOwnProperty.call(incoming, table) &&
        Object.prototype.hasOwnProperty.call(previous, table)) merged[table] = previous[table];
  }
  merged._rowDelta = true;
  merged.deletedIds = deletedIds;
  merged.fullTables = Array.from(fullTables);
  merged.incremental = true;
  merged.filter = { type: "all" };
  return merged;
}

async function ensureGoogleDriveBaselineUnlocked(onProgress?: (stage: string) => void) {
  const currentMonthName = driveBackupName({ type: "all" });
  const existing = await findBackupByName(currentMonthName);
  const localSnapshotVersion = String((await storage.secureGet(MASTER_LOCAL_SNAPSHOT_VERSION_KEY, "")) || "");
  if (existing?.id && localSnapshotVersion === "1") {
    const cursor = String((await storage.secureGet(MONTH_ARCHIVE_CURSOR_KEY, "")) || "");
    if (!/^\d{4}-\d{2}$/.test(cursor)) await storage.secureSet(MONTH_ARCHIVE_CURSOR_KEY, monthKeyFromDate(new Date()));
    return { skipped: true, name: currentMonthName };
  }
  // Replace any old active master with a complete snapshot of this phone. Legacy
  // backups are not merged; old files are left untouched as inactive recovery copies.
  onProgress?.(existing?.id ? "Replacing the old merged master with a fresh full phone backup…" : "Creating the first complete phone backup…");
  const result = await backupToGoogleDriveUnlocked(undefined, { type: "all" }, { onProgress });
  const confirmed = await findBackupByName(currentMonthName);
  if (!confirmed?.id) throw new Error("The rolling Drive master could not be confirmed. Local data remains on this phone.");
  await commitIncrementalSnapshotCache(String(confirmed.id) + ":" + String(confirmed.modifiedTime || ""));
  await storage.secureSet(MASTER_LOCAL_SNAPSHOT_VERSION_KEY, "1");
  const cursor = String((await storage.secureGet(MONTH_ARCHIVE_CURSOR_KEY, "")) || "");
  if (!/^\d{4}-\d{2}$/.test(cursor)) await storage.secureSet(MONTH_ARCHIVE_CURSOR_KEY, monthKeyFromDate(new Date()));
  return { ...result, baselineCreated: true, snapshotFailures: [] };
}

export function ensureGoogleDriveBaseline(onProgress?: (stage: string) => void): Promise<any> {
  return queueDriveOperation(() => ensureGoogleDriveBaselineUnlocked(onProgress), onProgress);
}

function monthKeyFromDate(date: Date): string {
  return String(date.getFullYear()) + "-" + String(date.getMonth() + 1).padStart(2, "0");
}

function nextMonthKey(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return monthKeyFromDate(new Date());
  const date = new Date(Number(match[1]), Number(match[2]) - 1, 1);
  date.setMonth(date.getMonth() + 1);
  return monthKeyFromDate(date);
}

async function archiveMonthSnapshot(month: string, onProgress?: (stage: string) => void) {
  const name = "Ortho Logbook Backup - Month " + month + ".orbackup";
  const existing = await findBackupByName(name);
  onProgress?.("Preparing monthly backup " + month + "…");
  let uploaded: any;
  const canStreamMonth = Platform.OS === "android" &&
    !!NativeModules.DriveBackgroundUpload?.writeTextChunk &&
    !!NativeModules.DriveBackgroundUpload?.startUpload &&
    !!NativeModules.DriveBackgroundUpload?.getStatus &&
    !!FileSystem.cacheDirectory;
  if (canStreamMonth) {
    const monthData = await exportUnencryptedBackupData({ type: "month", value: month }, onProgress);
    const hasMonthActivity = ["patients", "patientImplants", "implantRecords", "expenses", "patientHistory", "inventoryMovements", "inventoryPurchaseReceipts", "stockReceipts", "trash"]
      .some((table) => Array.isArray((monthData as any)[table]) && (monthData as any)[table].length > 0);
    if (!hasMonthActivity) {
      onProgress?.("No dated activity for " + month + "; keeping any existing monthly backup unchanged.");
      return;
    }
    pruneBackupPhotoAssets(monthData);
    const stageUri = FileSystem.cacheDirectory + "ortho-drive-month-" + month + "-" + Date.now() + ".json";
    try {
      await writeBackupObjectToFile(stageUri, monthData, onProgress);
      const info = await FileSystem.getInfoAsync(stageUri);
      if (!info.exists || typeof info.size !== "number" || info.size <= 0) {
        throw new Error("The monthly backup file is missing or empty.");
      }
      onProgress?.("Uploading monthly backup " + month + "…");
      uploaded = await uploadStagedJsonFile(stageUri, info.size, existing?.id, onProgress, name);
    } finally {
      try { await FileSystem.deleteAsync(stageUri, { idempotent: true }); } catch {}
    }
  } else {
    const monthData = await exportUnencryptedBackupData({ type: "month", value: month }, onProgress);
    const hasMonthActivity = ["patients", "patientImplants", "implantRecords", "expenses", "patientHistory", "inventoryMovements", "inventoryPurchaseReceipts", "stockReceipts", "trash"]
      .some((table) => Array.isArray((monthData as any)[table]) && (monthData as any)[table].length > 0);
    if (!hasMonthActivity) {
      onProgress?.("No dated activity for " + month + "; keeping any existing monthly backup unchanged.");
      return;
    }
    pruneBackupPhotoAssets(monthData);
    const text = JSON.stringify(monthData);
    onProgress?.("Uploading monthly backup " + month + "…");
    uploaded = await uploadContent(text, existing?.id, onProgress, name);
  }
  if (!uploaded?.id) throw new Error("Google Drive did not confirm the monthly archive for " + month + ". Local data remains safe.");
  const verified = await downloadDriveJsonValidated(String(uploaded.id));
  if (!verified || verified.app !== "Ortho Logbook" || !Array.isArray(verified.patients) || !Array.isArray(verified.inventory) ||
      verified.filter?.type !== "month" || String(verified.filter?.value || "") !== month) {
    throw new Error("The monthly archive for " + month + " could not be verified. Local data remains safe; monthly archiving will retry.");
  }
}

async function archiveCompletedMonths(onProgress?: (stage: string) => void) {
  const currentMonth = monthKeyFromDate(new Date());
  let cursor = String((await storage.secureGet(MONTH_ARCHIVE_CURSOR_KEY, "")) || "");
  // A monthly archive is finalized only after that month has ended. This avoids
  // uploading the same enormous month snapshot on every small edit and avoids
  // keeping both an all-time file and a duplicate current-month copy in sync.
  if (!/^\d{4}-\d{2}$/.test(cursor)) {
    // Start tracking this month after the full baseline is made. Avoid a second
    // enormous archive upload immediately after reaching 100%.
    await storage.secureSet(MONTH_ARCHIVE_CURSOR_KEY, currentMonth);
    return;
  } else if (cursor > currentMonth) {
    // Older builds advanced the cursor past the open month after archiving it.
    // Reset to the open month so it is archived exactly once when it closes.
    cursor = currentMonth;
    await storage.secureSet(MONTH_ARCHIVE_CURSOR_KEY, cursor);
  }
  let guard = 0;
  while (cursor < currentMonth && guard++ < 120) {
    await archiveMonthSnapshot(cursor, onProgress);
    cursor = nextMonthKey(cursor);
    await storage.secureSet(MONTH_ARCHIVE_CURSOR_KEY, cursor);
  }
}

async function backupIncrementalToGoogleDriveUnlocked(changedTables: string[], onProgress?: (stage: string) => void) {
  onProgress?.("Checking whether saved records changed…");
  // Patient PDF work is deliberately gated on patient-table changes. Previously
  // every inventory/settings edit scanned every patient and checked every Drive
  // PDF before syncing ordinary data, making unrelated syncs feel stuck.
  // A patient-table sync still discovers missing PDFs and retries any failed PDF
  // uploads; the normal record delta remains independent of image-PDF generation.
  const patientDataChanged = changedTables.includes("patients");
  let archiveChanged = false;
  if (patientDataChanged) {
    archiveChanged = await archiveEligiblePatientImages(onProgress);
    await uploadPatientImageArchivesToDrive(onProgress);
  }
  const effectiveChangedTables = archiveChanged ? Array.from(new Set([...changedTables, "patients"])) : changedTables;
  const currentMonthName = driveBackupName({ type: "all" });
  const base = await findBackupByName(currentMonthName);
  if (!base?.id) return ensureGoogleDriveBaselineUnlocked(onProgress);
  // Finalize the previous month as its own dated snapshot once that month has
  // ended. This call was missing from the active sync path, so the archive
  // helper existed but normal backups did not reliably create monthly files.
  // Keep one rolling master backup. Do not create per-month Drive snapshot files.
  const baselineKey = String(base.id) + ":" + String(base.modifiedTime || "");
  const canStreamIncremental = Platform.OS === "android" &&
    !!NativeModules.DriveBackgroundUpload?.writeTextChunk &&
    !!NativeModules.DriveBackgroundUpload?.startUpload &&
    !!NativeModules.DriveBackgroundUpload?.getStatus;
  let delta: any;
  if (canStreamIncremental) {
    // Avoid JSON.stringify on the entire changed-table payload before upload.
    delta = await exportIncrementalBackupData(effectiveChangedTables, onProgress, baselineKey);
  } else {
    const backupText = await exportIncrementalBackup(effectiveChangedTables, onProgress, baselineKey);
    delta = JSON.parse(backupText);
  }
  const hasActualChanges = (Array.isArray(delta.changedTables) ? delta.changedTables : []).some((table: string) => {
    if (table === "branding" || table === "appSettings") return Object.prototype.hasOwnProperty.call(delta, table);
    if (Array.isArray(delta.fullTables) && delta.fullTables.includes(table)) return true;
    const rows = Array.isArray(delta[table]) ? delta[table].length : 0;
    const deleted = Array.isArray(delta.deletedIds?.[table]) ? delta.deletedIds[table].length : 0;
    return rows > 0 || deleted > 0;
  });

  const migrationNeeded = String((await storage.secureGet(MASTER_MIGRATION_KEY, "")) || "") !== "1";
  // A failed monthly archive must be retried even when the master has no new
  // rows; otherwise a month file can remain missing forever after one failure.
  // The cursor advances only after the month file is verified, so this is a
  // no-op for already completed months.
  if (!hasActualChanges && !migrationNeeded) {
    await commitIncrementalSnapshotCache(baselineKey);
    return { skipped: true, completedAt: new Date().toISOString(), name: "No changes", accountEmail: getConnectedGoogleAccount() };
  }

  // The one-time legacy migration is the only normal sync path that needs a
  // full snapshot immediately. Thereafter, keep the full master stable and
  // update one compact rolling delta journal instead of re-uploading all photos
  // and every patient row after each small edit.
  if (migrationNeeded) {
    onProgress?.("Completing one-time safe merge of older Drive backups…");
    const migrated = await backupToGoogleDriveUnlocked(undefined, { type: "all" }, {
      onProgress,
      preferDriveOnMigration: true,
      localChanges: hasActualChanges ? delta : undefined,
    });
    const migratedBase = await findLatestBackup();
    if (!migratedBase?.id) throw new Error("The complete backup was uploaded but could not be confirmed. Local data remains safe.");
    if (canStreamIncremental) {
      // The complete baseline is named "Month YYYY-MM", not "All Time".
      // This stale expected name made verification fail after the huge upload and
      // retried the same full backup instead of finishing sync.
      await verifyStreamedDriveFile(String(migratedBase.id), currentMonthName,
        migrated?.size != null ? Number(migrated.size) : undefined);
    } else {
      const verified = await downloadDriveJsonValidated(String(migratedBase.id));
      if (!verified || verified.app !== "Ortho Logbook" || !Array.isArray(verified.patients) || !Array.isArray(verified.inventory)) {
        throw new Error("The complete backup could not be verified. The local change has not been marked as backed up.");
      }
    }
    await commitIncrementalSnapshotCache(String(migratedBase.id) + ":" + String(migratedBase.modifiedTime || ""));
    // backupToGoogleDrive already created and verified the current month archive.
    // Do not reset its cursor here: doing so made the next automatic sync upload
    // the same large monthly file again immediately after reaching 100%.
    return { ...migrated, skipped: false, baselineCreated: true, completedAt: new Date().toISOString(), name: currentMonthName, accountEmail: getConnectedGoogleAccount(), snapshotFailures: [] };
  }

  // Month archive reconciliation ran above, before the no-change early return.
  const JOURNAL_NAME = "Ortho Logbook Backup Changes.orbackup";
  onProgress?.("Preparing the small change journal…");
  let journalFile = await findBackupByName(JOURNAL_NAME);
  let journal: any = null;
  if (journalFile?.id) {
    try {
      const parsed = await downloadDriveJsonValidated(String(journalFile.id));
      // Never mix changes that belong to a different master baseline. A manual
      // full backup may have replaced the baseline since the journal was written.
      // The full master is updated in place, so its modifiedTime changes even
      // though the file ID (and the journal's baseline identity) is unchanged.
      // Keep the prior journal when it belongs to this same master file; otherwise
      // the next edit would overwrite older un-compacted changes.
      const journalBaseline = String(parsed?._baselineKey || "");
      if (parsed?.incremental === true &&
          (journalBaseline === baselineKey || journalBaseline.startsWith(String(base.id) + ":"))) journal = parsed;
    } catch (error) {
      // Keep the old journal file until a replacement has been verified. If it
      // cannot be read, start a fresh delta based on the confirmed full master.
      console.warn("[drive-backup] old delta journal unreadable; rebuilding from local diff", error);
    }
  }

  const combined = journal ? mergeIncrementalPayloads(journal, delta) : delta;
  combined.version = Math.max(Number(combined.version || 0), 8);
  combined.app = "Ortho Logbook";
  combined.createdAt = new Date().toISOString();
  combined.filter = { type: "all" };
  combined.incremental = true;
  combined._baselineKey = baselineKey;
  combined._updateCount = Math.max(0, Number(journal?._updateCount || 0)) + (hasActualChanges ? 1 : 0);
  pruneBackupPhotoAssets(combined);
  let journalText: string | null = null;
  let journalStageUri: string | null = null;
  let journalBytes = 0;
  if (hasActualChanges && canStreamIncremental) {
    if (!FileSystem.cacheDirectory) throw new Error("Device cache storage is unavailable for the Drive backup.");
    journalStageUri = FileSystem.cacheDirectory + "ortho-drive-journal-" + Date.now() + ".json";
    try {
      await writeBackupObjectToFile(journalStageUri, combined);
      const info = await FileSystem.getInfoAsync(journalStageUri);
      if (!info.exists || typeof info.size !== "number" || info.size <= 0) throw new Error("The streamed change journal is missing or empty.");
      journalBytes = info.size;
    } catch (error: any) {
      try { await FileSystem.deleteAsync(journalStageUri, { idempotent: true }); } catch {}
      journalStageUri = null;
      throw new Error("Could not prepare the change journal in safe chunks: " + String(error?.message || error) + ". Local data remains on this phone.");
    }
  } else if (hasActualChanges) {
    journalText = JSON.stringify(combined);
    journalBytes = new TextEncoder().encode(journalText).length;
  }
  // Keep routine edits in the rolling journal. Rebuilding the complete master
  // after only 20 small edits made Drive appear to restart a huge upload even
  // when each edit changed just one row. Compact only after a substantial
  // accumulated journal or a large number of edits; until then PATCH the same
  // journal file in place and leave the full photo-heavy master untouched.
  const shouldCompact = combined._updateCount >= 100 || journalBytes >= 32 * 1024 * 1024;

  if (hasActualChanges) {
    onProgress?.("Uploading only changed records to Google Drive…");
    let uploaded: any;
    try {
      if (journalStageUri) uploaded = await uploadStagedJsonFile(journalStageUri, journalBytes, journalFile?.id, onProgress, JOURNAL_NAME);
      else uploaded = await uploadContent(journalText as string, journalFile?.id, onProgress, JOURNAL_NAME);
    } finally {
      if (journalStageUri) {
        try { await FileSystem.deleteAsync(journalStageUri, { idempotent: true }); } catch {}
        journalStageUri = null;
      }
    }
    if (!uploaded?.id) throw new Error("Google Drive did not confirm the changed-record journal. Local data remains safe.");
    if (canStreamIncremental) {
      await verifyStreamedDriveFile(String(uploaded.id), JOURNAL_NAME, journalBytes);
    } else {
      const check = await downloadDriveJsonValidated(String(uploaded.id));
      if (!check || check.app !== "Ortho Logbook" || check.incremental !== true ||
          check._baselineKey !== baselineKey || !Array.isArray(check.changedTables)) {
        throw new Error("The changed-record journal could not be verified. Local data remains safe; the sync will retry.");
      }
    }
    journalFile = { ...uploaded, id: String(uploaded.id), name: JOURNAL_NAME };
  }

  if (shouldCompact && hasActualChanges) {
    onProgress?.("Safely consolidating accumulated changes into the full backup…");
    const master = await downloadDriveJsonValidated(String(base.id));
    if (!master || master.app !== "Ortho Logbook" || !Array.isArray(master.patients) || !Array.isArray(master.inventory)) {
      throw new Error("The current full backup could not be verified. The change journal is retained and local data is safe.");
    }
    applyIncrementalToMaster(master, combined, combined._rowDelta !== true);
    pruneBackupPhotoAssets(master);
    master.version = Math.max(Number(master.version || 0), 8);
    master.createdAt = new Date().toISOString();
    master.filter = { type: "all" };
    delete master.incremental;
    delete master.changedTables;
    delete master._rowDelta;
    delete master.deletedIds;
    delete master.fullTables;
    delete master._baselineKey;
    delete master._updateCount;
    const masterResult = await backupToGoogleDriveUnlocked(undefined, { type: "all" }, {
      onProgress,
      backupDataOverride: master,
    });
    const refreshedBase = await findLatestBackup();
    if (!refreshedBase?.id) throw new Error("The refreshed full backup could not be found. The delta journal is retained.");
    if (canStreamIncremental) {
      await verifyStreamedDriveFile(String(refreshedBase.id), currentMonthName,
        masterResult?.size != null ? Number(masterResult.size) : undefined);
    } else {
      const verifiedMaster = await downloadDriveJsonValidated(String(refreshedBase.id));
      if (!verifiedMaster || verifiedMaster.app !== "Ortho Logbook" ||
          !Array.isArray(verifiedMaster.patients) || !Array.isArray(verifiedMaster.inventory)) {
        throw new Error("The refreshed full backup could not be verified. The delta journal is retained.");
      }
    }
    // The full master now contains the journal. Delete the journal only after
    // verification; if deletion fails, its timestamp is older than the master
    // and restore will not apply it twice.
    try {
      await driveRequest(DRIVE_API + "/" + encodeURIComponent(String(journalFile?.id)) + "?supportsAllDrives=true", { method: "DELETE" });
    } catch (error) {
      console.warn("[drive-backup] consolidated journal cleanup deferred", error);
    }
    await commitIncrementalSnapshotCache(String(refreshedBase.id) + ":" + String(refreshedBase.modifiedTime || ""));
    await markBackupTaken();
    const completedAt = new Date().toISOString();
    await storage.secureSet(LAST_DRIVE_BACKUP_KEY, completedAt);
    return { ...masterResult, skipped: false, completedAt, name: currentMonthName, accountEmail: getConnectedGoogleAccount(), snapshotFailures: [] };
  }

  // If the Drive delta was confirmed, promote the local diff cache. If there
  // were no actual changes, this only records that the checked rows match.
  await commitIncrementalSnapshotCache(baselineKey);
  await markBackupTaken();
  const completedAt = new Date().toISOString();
  await storage.secureSet(LAST_DRIVE_BACKUP_KEY, completedAt);
  return {
    skipped: !hasActualChanges,
    completedAt,
    name: hasActualChanges ? JOURNAL_NAME : "No changes",
    accountEmail: getConnectedGoogleAccount(),
    snapshotFailures: [],
    deltaJournal: hasActualChanges,
    compacted: false,
  };
}

export function backupIncrementalToGoogleDrive(changedTables: string[], onProgress?: (stage: string) => void): Promise<any> {
  return queueDriveOperation(() => backupIncrementalToGoogleDriveUnlocked(changedTables, onProgress), onProgress);
}

export async function restoreLatestFromGoogleDrive(onProgress?: (stage: string) => void) {
  // Restore the rolling master and its change journal only; do not merge every
  // historical monthly snapshot during routine restore (it can take hours).
  onProgress?.("Finding the rolling master backup…");
  const candidates = (await findLatestBackupCandidates()).filter((item: any) =>
    String(item.name || "") === BACKUP_NAME ||
    /^Ortho Logbook Backup - Month \d{4}-\d{2}\.orbackup$/.test(String(item.name || "")) ||
    String(item.name || "") === "Ortho Logbook Backup - All Time.orbackup" ||
    /^Ortho Logbook Backup - (Year|Date) /.test(String(item.name || ""))
  );
  candidates.sort((a: any, b: any) => {
    const rank = (name: string) => name === BACKUP_NAME ? 0 : /^Ortho Logbook Backup - Month \d{4}-\d{2}\.orbackup$/.test(name) ? 1 : /all time/i.test(name) ? 2 : 3;
    return rank(String(a.name || "")) - rank(String(b.name || "")) ||
      Date.parse(String(b.modifiedTime || "")) - Date.parse(String(a.modifiedTime || ""));
  });
  if (!candidates.length) throw new Error("No rolling Ortho Logbook backup was found in Google Drive. Your phone data was not changed.");
  let file: any = null;
  let composed: any = null;
  let effectiveModifiedTime = "";
  const rejectedFiles: string[] = [];
  // Prefer the newest valid full backup, but fall back to older full backups
  // if the newest matching file is damaged or is an unrelated similarly named file.
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
    const candidate = candidates[candidateIndex];
    onProgress?.("Checking master backup " + (candidateIndex + 1) + " of " + candidates.length + "…");
    let parsed: any;
    try {
      onProgress?.("Downloading " + String(candidate.name || "backup") + " from Google Drive…");
      parsed = await downloadDriveJsonValidated(candidate.id, onProgress);
    } catch (error: any) {
      // Keep the real reason visible so a malformed legacy file can be
      // diagnosed instead of every failure being reported as "not readable".
      const reason = String(error?.message || "unknown download/JSON error").slice(0, 180);
      rejectedFiles.push(String(candidate.name || "Unnamed backup") + " (unreadable: " + reason + ")");
      continue;
    }
    if (!parsed || parsed.app !== "Ortho Logbook" || !Array.isArray(parsed.patients) || !Array.isArray(parsed.inventory)) {
      rejectedFiles.push(String(candidate.name || "Unnamed backup") + " (incomplete format)");
      continue;
    }
    file = candidate;
    composed = parsed;
    effectiveModifiedTime = String(candidate.modifiedTime || "");
    break;
  }
  if (!file || !composed) {
    throw new Error("No readable full Ortho Logbook backup was found. Checked " + candidates.length + " matching file(s); " +
      rejectedFiles.slice(0, 3).join(", ") + (rejectedFiles.length > 3 ? ", and more" : "") +
      ". Your phone data was not changed. Check that the backup file itself—not only a folder—is present in Google Drive.");
  }

  // Only apply incremental snapshots created after the full baseline. A manual
  // full backup therefore becomes the new baseline without needing risky file deletion.
  const baseTime = Date.parse(String(file.modifiedTime || ""));
  // Inspect keyed journals even when their Drive timestamp is older than the
  // master. The master may have been updated in place after the journal was
  // written; the baseline file ID determines whether the journal still applies.
  const deltas = (await listIncrementalFiles())
    .filter((item: any) => item?.id && (
      String(item.name || "") === "Ortho Logbook Backup Changes.orbackup" ||
      (String(file.name || "") !== BACKUP_NAME &&
        /^Ortho Logbook Backup - Month \d{4}-\d{2} Changes\.orbackup$/i.test(String(item.name || "")))
    ))
    .sort((a: any, b: any) => Date.parse(String(a.modifiedTime || "")) - Date.parse(String(b.modifiedTime || "")));
  const recoveryWarnings: string[] = [];
  let appliedIncrementals = 0;
  for (let deltaIndex = 0; deltaIndex < deltas.length; deltaIndex++) {
    const deltaFile = deltas[deltaIndex];
    onProgress?.("Applying saved changes " + (deltaIndex + 1) + " of " + deltas.length + "…");
    let delta: any;
    try {
      const recovered = await downloadIncrementalWithRecovery(deltaFile.id, String(deltaFile.name || "An incremental backup"));
      delta = recovered.data;
      if (recovered.warning) recoveryWarnings.push(recovered.warning);
    } catch (error: any) {
      // Preserve the full baseline and every other recoverable update. A
      // damaged delta is reported instead of blocking all older patient data.
      recoveryWarnings.push(String(error?.message || (String(deltaFile.name || "An incremental backup") + " could not be recovered.")));
      continue;
    }
    if (!delta || delta.app !== "Ortho Logbook" || delta.incremental !== true || !Array.isArray(delta.changedTables)) {
      recoveryWarnings.push(String(deltaFile.name || "An incremental backup") + " has an invalid format and was skipped.");
      continue;
    }
    const deltaBaseline = String(delta._baselineKey || "");
    const belongsToCurrentBaseline = deltaBaseline
      ? deltaBaseline.startsWith(String(file.id) + ":")
      : Number.isFinite(baseTime) && Date.parse(String(deltaFile.modifiedTime || "")) > baseTime;
    if (!belongsToCurrentBaseline) continue;
    let appliedAnyTable = false;
    for (const table of delta.changedTables) {
      if (table === "branding" || table === "appSettings") {
        if (Object.prototype.hasOwnProperty.call(delta, table)) {
          (composed as any)[table] = (delta as any)[table];
          appliedAnyTable = true;
        } else {
          recoveryWarnings.push(String(deltaFile.name || "An incremental backup") + " is missing its " + table + " data.");
        }
      } else if (["patients","procedures","inventoryCategories","inventory","patientImplants","patientCustomFields","implantRecords","expenses","users","patientHistory","inventoryMovements","inventoryPurchaseReceipts","stockReceipts","trash"].includes(table)) {
        if (Array.isArray(delta[table])) {
          if (delta._recoveredFromDamage !== true && delta._rowDelta === true && !(Array.isArray(delta.fullTables) && delta.fullTables.includes(table))) {
            // Apply only changed records and explicit deletion tombstones.
            // This keeps old records intact while allowing true row-level sync.
            const merged = new Map<string, any>();
            for (const row of Array.isArray(composed[table]) ? composed[table] : []) {
              const key = row && row.id != null ? "id:" + String(row.id) : "row:" + JSON.stringify(row);
              merged.set(key, row);
            }
            const deleted = delta.deletedIds && Array.isArray(delta.deletedIds[table]) ? delta.deletedIds[table] : [];
            for (const id of deleted) merged.delete("id:" + String(id));
            for (const row of delta[table]) {
              const key = row && row.id != null ? "id:" + String(row.id) : "row:" + JSON.stringify(row);
              const existing = merged.get(key);
              if (table === "patients" && existing &&
                  !Object.prototype.hasOwnProperty.call(row, "photo_uri") &&
                  !Object.prototype.hasOwnProperty.call(row, "photos_json")) {
                merged.set(key, { ...existing, ...row });
              } else {
                merged.set(key, row);
              }
            }
            composed[table] = Array.from(merged.values());
          } else if (delta._recoveredFromDamage === true && Array.isArray(composed[table])) {
            // Salvaged legacy/table snapshots are merged conservatively because
            // a damaged file may omit valid rows.
            const merged = new Map<string, any>();
            for (const row of composed[table]) {
              const key = row && row.id != null ? "id:" + String(row.id) : "row:" + JSON.stringify(row);
              merged.set(key, row);
            }
            for (const row of delta[table]) {
              const key = row && row.id != null ? "id:" + String(row.id) : "row:" + JSON.stringify(row);
              const existing = merged.get(key);
              if (table === "patients" && existing &&
                  !Object.prototype.hasOwnProperty.call(row, "photo_uri") &&
                  !Object.prototype.hasOwnProperty.call(row, "photos_json")) {
                merged.set(key, { ...existing, ...row });
              } else {
                merged.set(key, row);
              }
            }
            // Apply explicit tombstones recovered as a complete JSON property.
            // A missing row in a damaged/truncated array is not itself a tombstone.
            for (const deletedId of (Array.isArray(delta.deletedIds?.[table]) ? delta.deletedIds[table] : [])) {
              merged.delete("id:" + String(deletedId));
            }
            composed[table] = Array.from(merged.values());
          } else {
            // Do not replace the current master with a possibly older full-table
            // journal snapshot: keep newer master records and apply tombstones.
            let mergedRows = mergeRowsByRecency(composed[table] || [], delta[table], table);
            const deletedIds = new Set<string>(Array.isArray(delta.deletedIds?.[table]) ? delta.deletedIds[table].map(String) : []);
            if (deletedIds.size) mergedRows = mergedRows.filter((row: any) => row?.id == null || !deletedIds.has(String(row.id)));
            composed[table] = mergedRows;
          }
          appliedAnyTable = true;
        } else {
          recoveryWarnings.push(String(deltaFile.name || "An incremental backup") + " is missing table data for " + table + ".");
        }
      }
    }
    if (appliedAnyTable) {
      appliedIncrementals += 1;
      composed.createdAt = delta.createdAt || composed.createdAt;
      const deltaModifiedTime = String(deltaFile.modifiedTime || "");
      if (deltaModifiedTime && (!effectiveModifiedTime || Date.parse(deltaModifiedTime) > Date.parse(effectiveModifiedTime))) {
        effectiveModifiedTime = deltaModifiedTime;
      }
    }
  }
  composed.incremental = false;
  delete composed.changedTables;
  composed.filter = { type: "all" };
  await downloadPatientImageArchivesFromDrive(composed, onProgress);
  return { backupText: JSON.stringify(composed), name: file.name, modifiedTime: effectiveModifiedTime || String(file.modifiedTime || ""), appliedIncrementals, recoveryWarnings };
}

