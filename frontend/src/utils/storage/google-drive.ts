import { GoogleSignin, statusCodes } from "@react-native-google-signin/google-signin";
import { NativeModules, Platform } from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import { exportUnencryptedBackup, type BackupFilter } from "@/src/utils/storage/backup";
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
    // Sign out first so the Android account chooser is shown. This does not
    // delete Drive files or revoke the user's Google authorization.
    try { await GoogleSignin.signOut(); } catch {}
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

async function resolveAccessToken(): Promise<string> {
  configure();
  const current = GoogleSignin.getCurrentUser();
  const scopeVersion = await storage.secureGet(DRIVE_SCOPE_VERSION_KEY, "");
  if (!current || scopeVersion !== DRIVE_SCOPE_VERSION) {
    await connectGoogleAccount();
  }
  try {
    const tokens = await GoogleSignin.getTokens();
    if (!tokens.accessToken) throw new Error("Google did not return a Drive access token.");
    return tokens.accessToken;
  } catch (error: any) {
    if (error?.code === statusCodes.SIGN_IN_REQUIRED || error?.code === statusCodes.NO_SAVED_CREDENTIAL_FOUND) {
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

async function findLatestBackup() {
  // Search Drive itself, including backups created by older app authorizations.
  const q = encodeURIComponent("name contains 'Ortho Logbook Backup' and trashed = false");
  const response = await driveRequest(
    `${DRIVE_API}?q=${q}&spaces=drive&pageSize=100&orderBy=modifiedTime%20desc&includeItemsFromAllDrives=true&supportsAllDrives=true&fields=files(id,name,modifiedTime,size,mimeType)`,
  );
  const data = await response.json();
  const files = Array.isArray(data.files) ? data.files : [];
  return files.find((file: any) => String(file.name || "").toLowerCase().includes("ortho logbook backup")) || null;
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

async function uploadContent(backupText: string, existingId?: string, onProgress?: (stage: string) => void) {
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
        body: JSON.stringify({ name: BACKUP_NAME, mimeType: "application/json" }),
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
      return await uploadNativeBackground(sessionUrl, token, stagedFileUri, totalBytes, onProgress);
    }

    try {
      return await uploadResumable(sessionUrl, token, bytes as Uint8Array, onProgress);
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
      const metadata = JSON.stringify({ name: BACKUP_NAME, mimeType: "application/json" });
      const body = "--" + boundary + "\\r\\n" +
        "Content-Type: application/json; charset=UTF-8\\r\\n" +
        "\\r\\n" + metadata + "\\r\\n" +
        "--" + boundary + "\\r\\n" +
        "Content-Type: application/json; charset=UTF-8\\r\\n" +
        "\\r\\n" + backupText + "\\r\\n" +
        "--" + boundary + "--\\r\\n";
      const retryTarget = existingId
        ? DRIVE_UPLOAD + "/" + encodeURIComponent(existingId) + "?uploadType=multipart&fields=id,name,modifiedTime,size"
        : DRIVE_UPLOAD + "?uploadType=multipart&fields=id,name,modifiedTime,size";
      try {
        const retry = await fetchWithTimeout(retryTarget, {
          method: existingId ? "PATCH" : "POST",
          headers: { Authorization: "Bearer " + token, "Content-Type": "multipart/related; boundary=" + boundary },
          body,
        }, 45000);
        if (retry.ok) return await retry.json();
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
  // Always verify that a backup file actually exists in Drive before skipping.
  // A hash may remain on this phone after a file was deleted in Drive, or may
  // have been saved by an older build before its first upload completed.
  // In that situation the first automatic backup must CREATE a new Drive file.
  options.onProgress?.("Finding previous Drive backup…");
  const existing = await findLatestBackup();
  const previousHash = await storage.secureGet(LAST_DRIVE_CONTENT_HASH_KEY, "");
  const previousSuccess = await getLastDriveBackupStatus();
  if (existing?.id && previousSuccess && options.skipIfUnchanged && previousHash === contentHash) {
    return { skipped: true, completedAt: previousSuccess, accountEmail: getConnectedGoogleAccount(), name: BACKUP_NAME };
  }

  // No matching file means first-time upload: uploadContent uses POST to create
  // a new Drive file; PATCH is only used when an existing Drive file was found.
  options.onProgress?.("Uploading backup to Google Drive…");
  const result = await uploadContent(backupText, existing?.id, options.onProgress);
  await markBackupTaken();
  const completedAt = new Date().toISOString();
  await storage.secureSet(LAST_DRIVE_BACKUP_KEY, completedAt);
  await storage.secureSet(LAST_DRIVE_CONTENT_HASH_KEY, contentHash);
  return { ...result, skipped: false, completedAt, accountEmail: getConnectedGoogleAccount() };
}

export async function restoreLatestFromGoogleDrive() {
  const file = await findLatestBackup();
  if (!file?.id) throw new Error("No Ortho Logbook backup was found in this Google Drive account.");
  const response = await driveRequest(`${DRIVE_API}/${encodeURIComponent(file.id)}?alt=media`);
  const backupText = await response.text();
  return { backupText, name: file.name, modifiedTime: file.modifiedTime };
}

