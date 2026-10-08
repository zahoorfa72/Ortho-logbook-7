import { GoogleSignin, statusCodes } from "@react-native-google-signin/google-signin";
import { File, Paths } from "expo-file-system";
import { exportBackup, type BackupFilter } from "@/src/utils/storage/backup";
import { markBackupTaken } from "@/src/utils/backup-reminder";

export const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
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
    await GoogleSignin.addScopes({ scopes: [GOOGLE_DRIVE_SCOPE] });
    const current = GoogleSignin.getCurrentUser();
    if (!current?.user?.email) throw new Error("Google account was not returned.");
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
  if (!current) {
    await connectGoogleAccount();
  }
  try {
    const granted = await GoogleSignin.addScopes({ scopes: [GOOGLE_DRIVE_SCOPE] });
    if (!granted) throw new Error("Google Drive permission was not granted.");
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
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
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
  const q = encodeURIComponent(`name = '${BACKUP_NAME.replace(/'/g, "\\'")}' and trashed = false`);
  const response = await driveRequest(`${DRIVE_API}?q=${q}&pageSize=10&orderBy=modifiedTime%20desc&fields=files(id,name,modifiedTime,size)`);
  const data = await response.json();
  return data.files?.[0] || null;
}

async function uploadContent(encryptedBackup: string, existingId?: string) {
  const temp = new File(Paths.cache, "ortho-logbook-drive-upload.orbackup");
  if (temp.exists) temp.delete();
  temp.create();
  temp.write(encryptedBackup);

  const metadata = JSON.stringify({
    name: BACKUP_NAME,
    mimeType: "application/octet-stream",
  });

  const form = new FormData();
  form.append("metadata", new Blob([metadata], { type: "application/json" }) as any);
  form.append("file", { uri: temp.uri, name: BACKUP_NAME, type: "application/octet-stream" } as any);

  const token = await accessToken();
  const url = existingId
    ? `${DRIVE_UPLOAD}/${encodeURIComponent(existingId)}?uploadType=multipart&fields=id,name,modifiedTime,size`
    : `${DRIVE_UPLOAD}?uploadType=multipart&fields=id,name,modifiedTime,size`;
  const response = await fetch(url, {
    method: existingId ? "PATCH" : "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  try { temp.delete(); } catch {}
  if (!response.ok) {
    let message = `Google Drive upload failed (HTTP ${response.status}).`;
    try {
      const body = await response.json();
      message = body?.error?.message || message;
    } catch {}
    throw new Error(message);
  }
  return response.json();
}

export async function backupToGoogleDrive(password: string, filter: BackupFilter = { type: "all" }) {
  const encryptedBackup = await exportBackup(password, filter);
  const existing = await findLatestBackup();
  const result = await uploadContent(encryptedBackup, existing?.id);
  await markBackupTaken();
  return { ...result, accountEmail: getConnectedGoogleAccount() };
}

export async function restoreLatestFromGoogleDrive() {
  const file = await findLatestBackup();
  if (!file?.id) throw new Error("No Ortho Logbook backup was found in this Google Drive account.");
  const response = await driveRequest(`${DRIVE_API}/${encodeURIComponent(file.id)}?alt=media`);
  const backupText = await response.text();
  return { backupText, name: file.name, modifiedTime: file.modifiedTime };
}
