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
  const token = await accessToken();
  // Use a single multipart request instead of a resumable session. React Native's
  // fetch can fail to expose Google's resumable-session Location header reliably.
  // A single request also avoids a second unauthenticated-looking session URL hop.
  const boundary = "ortho_logbook_drive_boundary_7ma2";
  const metadata = JSON.stringify({
    name: BACKUP_NAME,
    mimeType: "application/json",
  });
  const body =
    `--${boundary}\r\n` +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    metadata + "\r\n" +
    `--${boundary}\r\n` +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    backupText + "\r\n" +
    `--${boundary}--`;

  const target = existingId
    ? `${DRIVE_UPLOAD}/${encodeURIComponent(existingId)}?uploadType=multipart&fields=id,name,modifiedTime,size`
    : `${DRIVE_UPLOAD}?uploadType=multipart&fields=id,name,modifiedTime,size`;

  let response: Response;
  try {
    response = await fetch(target, {
      method: existingId ? "PATCH" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    });
  } catch (error: any) {
    throw new Error(`Google Drive network request failed during upload. Check internet access, VPN/firewall, and Google Play Services, then retry. ${error?.message || ""}`.trim());
  }

  if (!response.ok) {
    let message = `Google Drive upload failed (HTTP ${response.status}).`;
    try {
      const result = await response.json();
      message = result?.error?.message || message;
    } catch {}
    throw new Error(message);
  }
  return response.json();
}

async function backupContentHash(backupText: string) {
  const parsed = JSON.parse(backupText);
  // Ignore the generated timestamp so unchanged records do not upload again.
  delete parsed.createdAt;
  const value = JSON.stringify(parsed);
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return `fnv1a-${(hash >>> 0).toString(16)}-${value.length}`;
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

