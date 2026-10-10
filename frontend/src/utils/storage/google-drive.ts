import { GoogleSignin, statusCodes } from "@react-native-google-signin/google-signin";
import { NativeModules, Platform } from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import { exportUnencryptedBackup, exportIncrementalBackup, commitIncrementalSnapshotCache, type BackupFilter } from "@/src/utils/storage/backup";
import { markBackupTaken } from "@/src/utils/backup-reminder";
import { storage } from "@/src/utils/storage";

const LAST_DRIVE_BACKUP_KEY = "ortho_drive_last_successful_backup";
const LAST_DRIVE_CONTENT_HASH_KEY = "ortho_drive_last_uploaded_content_hash";
const DRIVE_SCOPE_VERSION_KEY = "ortho_drive_scope_version";
const DRIVE_SCOPE_VERSION = "full-drive-v1";
export async function getLastDriveBackupStatus(): Promise<string | null> {
  return (await storage.secureGet(LAST_DRIVE_BACKUP_KEY, "")) || null;
}

// Full Drive access is needed to discover backups created by earlier app builds or under a different file authorization.
export const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const BACKUP_NAME = "Ortho Logbook Backup.orbackup";
const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

let configured = false;
let accessTokenInFlight: Promise<string> | null = null;

function configure() {
  if (configured) return;
  GoogleSignin.configure({ scopes: [GOOGLE_DRIVE_SCOPE] });
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

async function resolveAccessToken(): Promise<string> {
  configure();
  const current = GoogleSignin.getCurrentUser();
  const scopeVersion = String((await storage.secureGet(DRIVE_SCOPE_VERSION_KEY, "")) || "");
  if (!current || scopeVersion !== DRIVE_SCOPE_VERSION) {
    await connectGoogleAccount();
  }
  try {
    const tokens = await GoogleSignin.getTokens();
    if (!tokens.accessToken) throw new Error("Google did not return a Drive access token.");
    return tokens.accessToken;
  } catch (error: any) {
    if (error?.code === statusCodes.SIGN_IN_REQUIRED || error?.code === "NO_SAVED_CREDENTIAL_FOUND") {
      await connectGoogleAccount();
      const tokens = await GoogleSignin.getTokens();
      if (!tokens.accessToken) throw new Error("Google did not return a Drive access token.");
      return tokens.accessToken;
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
  const response = await fetchWithTimeout(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...Object.fromEntries(extraHeaders) },
  }, 30000);
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
  return "Ortho Logbook Backup - All Time.orbackup";
}

async function findBackupByName(name: string) {
  const q = encodeURIComponent("name = '" + name.replace(/'/g, "\\\\'") + "' and trashed = false");
  const response = await driveRequest(`${DRIVE_API}?q=${q}&spaces=drive&pageSize=10&orderBy=modifiedTime%20desc&fields=files(id,name,modifiedTime,size,mimeType)`);
  const data = await response.json();
  return Array.isArray(data.files) ? data.files.find((item: any) => item?.id && item.mimeType !== "application/vnd.google-apps.folder") || null : null;
}

export async function listGoogleDriveBackups(): Promise<Array<{id:string;name:string;modifiedTime:string;size?:string}>> {
  const files = await findLatestBackupCandidates();
  return files
    // New builds use one rolling master file. Ignore legacy month/year/date
    // snapshots in the picker so a partial historical file cannot be mistaken
    // for a complete restore. Those old files are left untouched in Drive.
    .filter((file:any) => file.id && (
      String(file.name || "") === "Ortho Logbook Backup - All Time.orbackup" ||
      String(file.name || "") === BACKUP_NAME
    ))
    .map((file:any) => ({id:String(file.id),name:String(file.name || "Ortho Logbook Backup"),modifiedTime:String(file.modifiedTime || ""),size:file.size == null ? undefined : String(file.size)}))
    .sort((a,b) => Date.parse(b.modifiedTime || "") - Date.parse(a.modifiedTime || ""));
}

export async function restoreGoogleDriveBackupById(fileId: string) {
  if (!fileId) throw new Error("Select a Google Drive backup first.");
  const metadataResponse = await driveRequest(`${DRIVE_API}/${encodeURIComponent(fileId)}?fields=id,name,modifiedTime,size,mimeType,trashed`);
  const metadata = await metadataResponse.json();
  if (!metadata?.id || metadata.trashed || metadata.mimeType === "application/vnd.google-apps.folder") {
    throw new Error("The selected Google Drive item is not a backup file.");
  }
  const parsed = await downloadDriveJsonValidated(fileId);
  if (!parsed || parsed.app !== "Ortho Logbook" || !Array.isArray(parsed.patients) || !Array.isArray(parsed.inventory)) {
    throw new Error("The selected file is not a complete Ortho Logbook backup.");
  }
  return {name:String(metadata.name || "Ortho Logbook Backup"),modifiedTime:String(metadata.modifiedTime || ""),backupText:JSON.stringify(parsed)};
}

async function findLatestBackup() {
  // Auto-sync only needs the newest full baseline. Do not page through the entire
  // Drive history on every tiny edit; restore still uses the exhaustive search.
  const current = await findBackupByName("Ortho Logbook Backup - All Time.orbackup");
  if (current) return current;
  // Compatibility with the original filename used by earlier releases.
  return await findBackupByName(BACKUP_NAME);
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
): Promise<any> {
  const nativeUploader = NativeModules.DriveBackgroundUpload;
  if (!nativeUploader?.startUpload || !nativeUploader?.getStatus) {
    throw new Error("This Android build does not include the background upload service. Install the latest Ortho Logbook APK.");
  }
  const taskId: string = await nativeUploader.startUpload(sessionUrl, token, fileUri, totalBytes);
  let lastProgress = -1;
  while (true) {
    const status = await nativeUploader.getStatus(taskId);
    if (status?.status === "completed") {
      try { return status.result ? JSON.parse(status.result) : {}; } catch { return {}; }
    }
    if (status?.status === "error") {
      throw new Error(status.error || "Google Drive background upload failed. Your local data is unchanged; retry when connected.");
    }
    const progress = Number(status?.progress ?? 0);
    if (progress !== lastProgress) {
      lastProgress = progress;
      onProgress?.("Uploading backup to Google Drive in background… " + progress + "%");
    }
    await new Promise<void>(resolve => setTimeout(resolve, 1000));
  }
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

async function uploadContent(backupText: string, existingId?: string, onProgress?: (stage: string) => void, fileName: string = BACKUP_NAME) {
  const token = await accessToken();
  const useNativeBackground = Platform.OS === "android" && !!NativeModules.DriveBackgroundUpload?.startUpload;
  let stagedFileUri: string | null = null;
  let totalBytes = 0;
  let bytes: Uint8Array | null = null;

  if (useNativeBackground) {
    if (!FileSystem.cacheDirectory) throw new Error("Device cache storage is unavailable for the Drive backup.");
    stagedFileUri = FileSystem.cacheDirectory + "ortho-drive-backup-" + Date.now() + ".json";
    try {
      await FileSystem.writeAsStringAsync(stagedFileUri, backupText, { encoding: FileSystem.EncodingType.UTF8 });
      const info = await FileSystem.getInfoAsync(stagedFileUri);
      if (!info.exists || typeof info.size !== "number" || info.size <= 0) {
        throw new Error("Could not prepare the backup file for background upload.");
      }
      totalBytes = info.size;
    } catch (error: any) {
      try { await FileSystem.deleteAsync(stagedFileUri, { idempotent: true }); } catch {}
      throw new Error("Could not prepare the backup for background upload: " + String(error?.message || error));
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
      const nativeResult = await uploadNativeBackground(sessionUrl, token, stagedFileUri, totalBytes, onProgress);
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

export async function backupToGoogleDrive(
  _password?: string,
  filter: BackupFilter = { type: "all" },
  options: { skipIfUnchanged?: boolean; onProgress?: (stage: string) => void } = {},
) {
  // Google Drive backup is intentionally plain JSON at the user's request.
  // Local phone/file backups remain encrypted by exportBackup().
  options.onProgress?.("Preparing backup data…");
  const backupText = await exportUnencryptedBackup(filter, options.onProgress);
  options.onProgress?.("Checking whether backup changed…");
  const contentHash = await backupContentHash(backupText, options.onProgress);
  const fileName = driveBackupName(filter);
  // Find only this exact scope so a month/year backup can never overwrite the
  // all-time backup or another month.
  options.onProgress?.("Finding this range's Drive backup…");
  let existing = await findBackupByName(fileName);
  // Upgrade path: reuse the legacy full backup only for an all-time request.
  if (!existing && filter.type === "all") existing = await findBackupByName(BACKUP_NAME);
  const previousHash = await storage.secureGet(LAST_DRIVE_CONTENT_HASH_KEY + ":" + fileName, "");
  const previousSuccess = await getLastDriveBackupStatus();
  if (existing?.id && previousSuccess && options.skipIfUnchanged && previousHash === contentHash) {
    return { skipped: true, completedAt: previousSuccess, accountEmail: getConnectedGoogleAccount(), name: fileName };
  }

  options.onProgress?.("Uploading backup to Google Drive…");
  const result = await uploadContent(backupText, existing?.id, options.onProgress, fileName);
  await markBackupTaken();
  const completedAt = new Date().toISOString();
  await storage.secureSet(LAST_DRIVE_BACKUP_KEY, completedAt);
  await storage.secureSet(LAST_DRIVE_CONTENT_HASH_KEY + ":" + fileName, contentHash);
  return { ...result, skipped: false, completedAt, name: fileName, accountEmail: getConnectedGoogleAccount() };
}

async function listIncrementalFiles() {
  const q = encodeURIComponent("name contains 'Ortho Logbook Incremental' and trashed = false");
  const files: any[] = [];
  let pageToken = "";
  // Page through the entire delta history so older phones can restore even
  // after more than 100 incremental uploads.
  do {
    const tokenParam = pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : "";
    const response = await driveRequest(`${DRIVE_API}?q=${q}&spaces=drive&pageSize=100&orderBy=modifiedTime%20asc&includeItemsFromAllDrives=true&supportsAllDrives=true&fields=files(id,name,modifiedTime,size,mimeType),nextPageToken${tokenParam}`);
    const data = await response.json();
    if (Array.isArray(data.files)) files.push(...data.files);
    pageToken = typeof data.nextPageToken === "string" ? data.nextPageToken : "";
  } while (pageToken);
  return files;
}

async function downloadDriveJson(fileId: string): Promise<string> {
  const url = `${DRIVE_API}/${encodeURIComponent(fileId)}?alt=media`;
  let fetchError: any = null;
  try {
    const response = await driveRequest(url);
    return await response.text();
  } catch (error: any) {
    fetchError = error;
  }

  // React Native fetch can fail with the generic "Network request failed"
  // for large Drive media downloads even when Drive's metadata API works.
  // Retry the same authenticated media request with XHR, which has a separate
  // native networking path. Keep the local database untouched on either failure.
  const token = await accessToken();
  return await new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url);
    xhr.setRequestHeader("Authorization", "Bearer " + token);
    xhr.timeout = 120000;
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.responseText || "");
        return;
      }
      let message = "Google Drive backup download failed (HTTP " + xhr.status + ").";
      try {
        const data = JSON.parse(xhr.responseText || "{}");
        message = data?.error?.message || message;
      } catch {}
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error(
      "Google Drive media download failed over both fetch and XHR. Fetch: " +
      String(fetchError?.message || "network error") +
      "; XHR returned no HTTP response. Check Google Drive connectivity, VPN, or network restrictions."
    ));
    xhr.ontimeout = () => reject(new Error("Google Drive backup download timed out after 120 seconds. Check the connection and retry."));
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

async function downloadDriveJsonValidated(fileId: string): Promise<any> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return parseDownloadedBackup(await downloadDriveJson(fileId));
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise<void>(resolve => setTimeout(resolve, attempt * 900));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Google Drive backup could not be parsed.");
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
    const knownTables = ["patients","procedures","inventoryCategories","inventory","patientImplants","patientCustomFields","implantRecords","expenses","users","patientHistory","inventoryMovements","inventoryPurchaseReceipts","stockReceipts"];
    const recovered: any = { app, incremental: true, _recoveredFromDamage: true, changedTables: Array.isArray(changedTables) ? changedTables : [], _rowDelta: rowDelta, deletedIds: deletedIds && typeof deletedIds === "object" ? deletedIds : {}, fullTables: Array.isArray(fullTables) ? fullTables : [] };
    for (const table of knownTables) {
      const value = extractCompleteJsonProperty(raw, table);
      if (Array.isArray(value)) recovered[table] = value;
    }
    const branding = extractCompleteJsonProperty(raw, "branding");
    if (branding !== undefined) recovered.branding = branding;
    if (!recovered.changedTables.length) recovered.changedTables = knownTables.filter(table => Array.isArray(recovered[table]));
    if (!recovered.changedTables.some((table: string) => Array.isArray(recovered[table]) || (table === "branding" && Object.prototype.hasOwnProperty.call(recovered, "branding")))) {
      throw new Error("Incremental backup " + fileName + " is damaged and contains no recoverable complete table. The full backup and other readable updates can still be restored.");
    }
    return { data: recovered, warning: fileName + " was damaged; only complete table data could be recovered." };
  }
}

async function ensureAutomaticRangeSnapshots(onProgress?: (stage: string) => void) {
  const now = new Date();
  const dayKey = now.toISOString().slice(0, 10);
  const month = dayKey.slice(0, 7);
  const year = dayKey.slice(0, 4);
  const failures: string[] = [];

  // Keep exactly one rolling file per month/year and check after each sync.
  // The content hash ignores generated timestamps, so unchanged ranges are
  // skipped while edits made later the same day are still uploaded.
  for (const scope of [
    { type: "month" as const, value: month, label: "monthly" },
    { type: "year" as const, value: year, label: "yearly" },
  ]) {
    try {
      onProgress?.("Checking automatic " + scope.label + " Drive backup…");
      await backupToGoogleDrive(undefined, { type: scope.type, value: scope.value }, { skipIfUnchanged: true, onProgress });
      await storage.secureSet("ortho_drive_auto_" + scope.label + "_snapshot_day_" + scope.value, dayKey);
    } catch (error: any) {
      failures.push(scope.label + " snapshot: " + String(error?.message || "upload failed"));
      console.warn("[drive-auto-backup] " + scope.label + " snapshot failed", error);
    }
  }
  return failures;
}

function mergeIncrementalPayloads(previous: any, incoming: any): any {
  if (!previous) return incoming;
  const tableNames = [
    "patients", "procedures", "inventoryCategories", "inventory", "patientImplants",
    "patientCustomFields", "implantRecords", "expenses", "users", "patientHistory",
    "inventoryMovements", "inventoryPurchaseReceipts", "stockReceipts",
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

export async function ensureGoogleDriveBaseline(onProgress?: (stage: string) => void) {
  const existing = await findLatestBackup();
  if (existing?.id) return { skipped: true, name: String(existing.name || "Ortho Logbook Backup - All Time.orbackup") };
  onProgress?.("Creating the first complete all-time backup…");
  const result = await backupToGoogleDrive(undefined, { type: "all" }, { onProgress });
  // A single complete master file avoids tripling storage with month/year copies.
  return { ...result, baselineCreated: true, snapshotFailures: [] };
}

export async function backupIncrementalToGoogleDrive(changedTables: string[], onProgress?: (stage: string) => void) {
  onProgress?.("Checking whether saved records changed…");
  const base = await findLatestBackup();
  if (!base?.id) return ensureGoogleDriveBaseline(onProgress);

  const baselineKey = String(base.id) + ":" + String(base.modifiedTime || "");
  const backupText = await exportIncrementalBackup(changedTables, onProgress, baselineKey);
  const delta = JSON.parse(backupText);
  const hasActualChanges = (Array.isArray(delta.changedTables) ? delta.changedTables : []).some((table: string) => {
    if (table === "branding" || table === "appSettings") return Object.prototype.hasOwnProperty.call(delta, table);
    if (Array.isArray(delta.fullTables) && delta.fullTables.includes(table)) return true;
    const rows = Array.isArray(delta[table]) ? delta[table].length : 0;
    const deleted = Array.isArray(delta.deletedIds?.[table]) ? delta.deletedIds[table].length : 0;
    return rows > 0 || deleted > 0;
  });

  if (!hasActualChanges) {
    // Do not upload or rebuild range snapshots for duplicate/no-op SQLite events.
    // Most importantly, scrolling/navigation must not create Drive traffic.
    await commitIncrementalSnapshotCache(baselineKey);
    return { skipped: true, completedAt: new Date().toISOString(), name: "No changes", accountEmail: getConnectedGoogleAccount() };
  }

  // Each named Drive backup is a complete, rolling snapshot, not a partial
  // day or a standalone delta. Refresh all-time first, then the current month
  // and year from the full local database. Each upload updates the existing
  // same-name Drive file rather than making a new daily file.
  onProgress?.("Refreshing the complete all-time backup…");
  const allTimeResult = await backupToGoogleDrive(undefined, { type: "all" }, { onProgress });
  // Keep one rolling master backup. Month/year selection is handled during
  // restore by filtering this complete snapshot, not by uploading duplicates.

  const refreshedBase = await findLatestBackup();
  if (!refreshedBase?.id) throw new Error("The all-time backup was uploaded but could not be found again to confirm it.");
  const refreshedBaselineKey = String(refreshedBase.id) + ":" + String(refreshedBase.modifiedTime || "");
  await commitIncrementalSnapshotCache(refreshedBaselineKey);
  await markBackupTaken();
  const completedAt = new Date().toISOString();
  await storage.secureSet(LAST_DRIVE_BACKUP_KEY, completedAt);
  return {
    ...allTimeResult,
    skipped: false,
    completedAt,
    name: "Ortho Logbook Backup - All Time.orbackup",
    accountEmail: getConnectedGoogleAccount(),
    snapshotFailures: [],
  };
}

export async function restoreLatestFromGoogleDrive() {
  const candidates = await findLatestBackupCandidates();
  // Scoped month/year files must not accidentally become the default full restore.
  // Prefer the all-time snapshot, then the original legacy full-backup filename.
  candidates.sort((a:any,b:any) => {
    const rank = (name:string) => /all time/i.test(name) ? 0 : name === BACKUP_NAME ? 1 : /month|year|date/i.test(name) ? 3 : 2;
    return rank(String(a.name || "")) - rank(String(b.name || "")) ||
      Date.parse(String(b.modifiedTime || "")) - Date.parse(String(a.modifiedTime || ""));
  });
  if (!candidates.length) throw new Error("No Ortho Logbook backup file was found in this Google Drive account. Backup folders are searched recursively; only actual backup files can be restored.");
  let file: any = null;
  let composed: any = null;
  const rejectedFiles: string[] = [];
  // Prefer the newest valid full backup, but fall back to older full backups
  // if the newest matching file is damaged or is an unrelated similarly named file.
  for (const candidate of candidates) {
    let parsed: any;
    try {
      parsed = await downloadDriveJsonValidated(candidate.id);
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
  const deltas = (await listIncrementalFiles())
    .filter((item: any) => item?.id && Number.isFinite(Date.parse(String(item.modifiedTime || ""))) &&
      (!Number.isFinite(baseTime) || Date.parse(String(item.modifiedTime)) > baseTime))
    .sort((a: any, b: any) => Date.parse(String(a.modifiedTime)) - Date.parse(String(b.modifiedTime)));
  const recoveryWarnings: string[] = [];
  let appliedIncrementals = 0;
  for (const deltaFile of deltas) {
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
    let appliedAnyTable = false;
    for (const table of delta.changedTables) {
      if (table === "branding" || table === "appSettings") {
        if (Object.prototype.hasOwnProperty.call(delta, table)) {
          (composed as any)[table] = (delta as any)[table];
          appliedAnyTable = true;
        } else {
          recoveryWarnings.push(String(deltaFile.name || "An incremental backup") + " is missing its " + table + " data.");
        }
      } else if (["patients","procedures","inventoryCategories","inventory","patientImplants","patientCustomFields","implantRecords","expenses","users","patientHistory","inventoryMovements","inventoryPurchaseReceipts","stockReceipts"].includes(table)) {
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
            composed[table] = Array.from(merged.values());
          } else {
            composed[table] = delta[table];
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
    }
  }
  composed.incremental = false;
  delete composed.changedTables;
  composed.filter = { type: "all" };
  return { backupText: JSON.stringify(composed), name: file.name, modifiedTime: file.modifiedTime, appliedIncrementals, recoveryWarnings };
}

