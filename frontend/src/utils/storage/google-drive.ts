import { GoogleSignin, statusCodes } from "@react-native-google-signin/google-signin";
import { File, Paths } from "expo-file-system";
import * as Crypto from "expo-crypto";
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

async function accessToken() {
  configure();
  const current = GoogleSignin.getCurrentUser();
  const scopeVersion = await storage.secureGet(DRIVE_SCOPE_VERSION_KEY, "");
  // Re-authorize once after upgrading from the old drive.file scope. This avoids
  // repeated addScopes failures and ensures older Drive backups can be listed.
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

async function driveRequest(url: string, init: RequestInit = {}) {
  const token = await accessToken();
  const extraHeaders = init.headers && typeof init.headers === "object" && !Array.isArray(init.headers)
    ? Object.entries(init.headers as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    : [];
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...Object.fromEntries(extraHeaders) },
  });
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

async function uploadContent(backupText: string, existingId?: string) {
  const temp = new File(Paths.cache, "ortho-logbook-drive-upload.orbackup");
  if (temp.exists) temp.delete();
  temp.create();
  temp.write(backupText);

  const token = await accessToken();
  const target = existingId
    ? `${DRIVE_UPLOAD}/${encodeURIComponent(existingId)}?uploadType=resumable&fields=id,name,modifiedTime,size`
    : `${DRIVE_UPLOAD}?uploadType=resumable&fields=id,name,modifiedTime,size`;

  const initResponse = await fetch(target, {
    method: existingId ? "PATCH" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": "application/octet-stream",
      "X-Upload-Content-Length": String(temp.size),
    },
    body: JSON.stringify({
      name: BACKUP_NAME,
      mimeType: "application/octet-stream",
    }),
  });

  if (!initResponse.ok) {
    let message = `Google Drive upload could not be started (HTTP ${initResponse.status}).`;
    try {
      const body = await initResponse.json();
      message = body?.error?.message || message;
    } catch {}
    try { temp.delete(); } catch {}
    throw new Error(message);
  }

  const sessionUrl = initResponse.headers.get("Location");
  if (!sessionUrl) {
    try { temp.delete(); } catch {}
    throw new Error("Google Drive did not return an upload session.");
  }

  const uploadResponse = await fetch(sessionUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(temp.size),
    },
    body: temp as any,
  });

  try { temp.delete(); } catch {}
  if (!uploadResponse.ok) {
    let message = `Google Drive upload failed (HTTP ${uploadResponse.status}).`;
    try {
      const body = await uploadResponse.json();
      message = body?.error?.message || message;
    } catch {}
    throw new Error(message);
  }
  return uploadResponse.json();
}

async function backupContentHash(backupText: string) {
  const parsed = JSON.parse(backupText);
  // Ignore the generated timestamp so unchanged records do not upload again.
  delete parsed.createdAt;
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, JSON.stringify(parsed));
}

export async function backupToGoogleDrive(
  _password?: string,
  filter: BackupFilter = { type: "all" },
  options: { skipIfUnchanged?: boolean } = {},
) {
  // Google Drive backup is intentionally plain JSON at the user's request.
  // Local phone/file backups remain encrypted by exportBackup().
  const backupText = await exportUnencryptedBackup(filter);
  const contentHash = await backupContentHash(backupText);
  const previousHash = await storage.secureGet(LAST_DRIVE_CONTENT_HASH_KEY, "");
  if (options.skipIfUnchanged && previousHash === contentHash) {
    const completedAt = await getLastDriveBackupStatus();
    return { skipped: true, completedAt, accountEmail: getConnectedGoogleAccount(), name: BACKUP_NAME };
  }

  const existing = await findLatestBackup();
  const result = await uploadContent(backupText, existing?.id);
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

