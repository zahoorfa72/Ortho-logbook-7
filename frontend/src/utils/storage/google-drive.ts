import { GoogleSignin, statusCodes } from "@react-native-google-signin/google-signin";
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

// Google Drive resumable chunks must be multiples of 256 KiB. 4 MiB chunks
// reduce a 50 MiB backup from about 200 sequential requests to about 13.
const DRIVE_CHUNK_SIZE = 4 * 1024 * 1024;

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
      const body = xhr.responseText || "";
      const parsed = parseDriveResponse(body);
      if (xhr.status === 308) {
        const range = xhr.getResponseHeader("Range") || "";
        const match = /bytes=0-(\d+)/i.exec(range);
        resolve({ done: false, nextOffset: match ? Number(match[1]) + 1 : 0 });
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) { resolve({ done: true, result: parsed }); return; }
      reject(new Error(parsed?.error?.message || ("Google Drive rejected an upload chunk (HTTP " + xhr.status + ").")));
    };
    xhr.onerror = () => reject(new Error("No HTTP response while sending a Google Drive upload chunk (readyState " + xhr.readyState + ", status " + (xhr.status || "none") + ")."));
    xhr.ontimeout = () => reject(new Error("Google Drive upload chunk timed out."));
    xhr.timeout = 45000;
    const chunk = bytes.slice(start, end);
    xhr.send(chunk.buffer as ArrayBuffer);
  });
}

async function uploadResumable(sessionUrl: string, token: string, bytes: Uint8Array, onProgress?: (stage: string) => void) {
  const startedAt = Date.now();
  let offset = 0;
  let result: any = null;
  while (offset < bytes.length) {
    if (Date.now() - startedAt > 5 * 60 * 1000) throw new Error("Google Drive upload stopped after 5 minutes without completing. Your local data is unchanged; retry on a stable connection.");
    const end = Math.min(offset + DRIVE_CHUNK_SIZE, bytes.length);
    let lastError: any = null;
    let chunkResult: { done: boolean; result?: any; nextOffset?: number } | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await uploadChunk(sessionUrl, token, bytes, offset, end, bytes.length);
        if (!response.done && (response.nextOffset ?? 0) <= offset) {
          throw new Error("Google Drive did not acknowledge progress for this upload chunk.");
        }
        if (!response.done && (response.nextOffset ?? 0) > end) {
          throw new Error("Google Drive returned an invalid upload offset.");
        }
        chunkResult = response;
        lastError = null;
        break;
      } catch (error: any) {
        lastError = error;
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 700 * (attempt + 1)));
      }
    }
    if (lastError || !chunkResult) throw lastError || new Error("Google Drive upload chunk failed.");
    if (chunkResult.done) {
      offset = end;
      result = chunkResult.result;
      if (offset < bytes.length) throw new Error("Google Drive completed the upload earlier than expected; please retry.");
    } else {
      offset = chunkResult.nextOffset as number;
      if (offset >= bytes.length) throw new Error("Google Drive did not confirm the final upload chunk. Please retry.");
    }
    onProgress?.("Uploading backup to Google Drive… " + Math.min(100, Math.round((offset / bytes.length) * 100)) + "%");
  }
  return result || {};
}

async function uploadContent(backupText: string, existingId?: string, onProgress?: (stage: string) => void) {
  const token = await accessToken();
  const bytes = new TextEncoder().encode(backupText);
  const target = existingId
    ? DRIVE_UPLOAD + "/" + encodeURIComponent(existingId) + "?uploadType=resumable&fields=id,name,modifiedTime,size"
    : DRIVE_UPLOAD + "?uploadType=resumable&fields=id,name,modifiedTime,size";
  let initResponse: Response;
  try {
    initResponse = await fetchWithTimeout(target, {
      method: existingId ? "PATCH" : "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": "application/json",
        "X-Upload-Content-Length": String(bytes.length),
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
  try {
    return await uploadResumable(sessionUrl, token, bytes, onProgress);
  } catch (error: any) {
    const originalMessage = String(error?.message || "Google Drive resumable upload failed.");
    // Do not start a second full-file transfer after the explicit overall deadline.
    if (originalMessage.includes("stopped after 5 minutes")) throw error;
    // Correct multipart/related structure is retained as a fallback for devices
    // whose native XHR cannot transfer a resumable session body.
    const boundary = "ortho_logbook_drive_" + Date.now().toString(36);
    const metadata = JSON.stringify({ name: BACKUP_NAME, mimeType: "application/json" });
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
      if (retry.ok) return await retry.json();
      let message = "Google Drive multipart fallback failed (HTTP " + retry.status + ").";
      try { const data = await retry.json(); message = data?.error?.message || message; } catch {}
      throw new Error(message);
    } catch (retryError: any) {
      const retryMessage = String(retryError?.message || "Network request failed");
      throw new Error("Resumable upload failed: " + originalMessage + " Alternate multipart upload failed: " + retryMessage + ". Local records are unchanged; retry when Google Drive connectivity is available.");
    }
  }
}
async function backupContentHash(backupText: string, onProgress?: (stage: string) => void) {
  // Avoid JSON.parse + JSON.stringify on a potentially 50+ MiB backup. That
  // duplicated the payload in memory and could freeze the UI for a long time.
  // Only the top-level generated timestamp changes when records are unchanged.
  const value = backupText.replace(/("createdAt"\s*:\s*")[^"]*(")/, '$1IGNORED_TIMESTAMP$2');
  let hash = 2166136261;
  const yieldEvery = 256 * 1024;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
    if (i > 0 && i % yieldEvery === 0) {
      onProgress?.("Checking backup contents… " + Math.min(99, Math.round((i / value.length) * 100)) + "%");
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  }
  return `fnv1a-${(hash >>> 0).toString(16)}-${value.length}`;
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
  const previousHash = await storage.secureGet(LAST_DRIVE_CONTENT_HASH_KEY, "");
  if (options.skipIfUnchanged && previousHash === contentHash) {
    const completedAt = await getLastDriveBackupStatus();
    return { skipped: true, completedAt, accountEmail: getConnectedGoogleAccount(), name: BACKUP_NAME };
  }

  options.onProgress?.("Finding previous Drive backup…");
  const existing = await findLatestBackup();
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

