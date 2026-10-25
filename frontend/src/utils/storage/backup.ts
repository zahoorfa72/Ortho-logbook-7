import * as Crypto from "expo-crypto";
import { File } from "expo-file-system";
import * as LegacyFileSystem from "expo-file-system/legacy";
import * as ImageManipulator from "expo-image-manipulator";
import * as SecureStore from "expo-secure-store";
import nacl from "tweetnacl";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { db, initializeDatabase, markInventoryResetDone, repairDatabaseData } from "@/src/db/database";
import { storage } from "@/src/utils/storage";
import type { BrandingConfig } from "@/src/theme";
import { archiveEligiblePatientImages, getLocalPatientImageArchives } from "@/src/utils/storage/patient-image-archive";

const BACKUP_VERSION = 11;
const BACKUP_APP = "Ortho Logbook";

type BackupData = {
  version:number; app:string; createdAt:string;
  patients:any[]; procedures:any[]; inventoryCategories:any[]; inventory:any[]; patientImplants:any[]; patientCustomFields:any[]; implantRecords:any[]; expenses:any[]; users:any[];
  patientHistory:any[]; inventoryMovements:any[]; inventoryPurchaseReceipts:any[]; stockReceipts:any[]; trash?:any[];
  // Each unique compressed image is stored once and referenced by its rows.
  photoAssets?: Record<string, string>;
  patientImageArchives?: Array<{patientId:string;patientName:string;mrNo:string;fileName:string;sourceStamp:string;archivedAt:string;imageCount:number;driveFileId?:string}>;
  branding?: BrandingConfig | null;
  appSettings?: { googleOAuthClientId: string | null; googleCloudProjectId: string | null; googleAccountEmail: string | null; labOcrEnabled?: string | null; labWarningsEnabled?: string | null; labTestDefinitions?: string | null; labTestBranches?: string | null; labResultsHiddenByPatient?: string | null; labWarningThresholdPercent?: string | null; labOldResultDays?: string | null; labOcrApiKey?: string | null; asyncStorageSettings?: Record<string, string | null> };
  filter?: BackupFilter;
  incremental?: boolean;
  changedTables?: string[];
};
type EncryptedBackup = {
  version:number; app:string; encrypted:true; algorithm:"XSalsa20-Poly1305"; kdf:"SHA-256";
  createdAt:string; salt:string; nonce:string; ciphertext:string; ciphertextEncoding?: "base64";
};

function normalizeSecureSetting(value: string): string {
  // Older backups captured raw SecureStore JSON strings and may contain one
  // extra pair of quotes. Normalize them before re-saving via the shared wrapper.
  try { const parsed = JSON.parse(value); if (typeof parsed === "string") return parsed; } catch {}
  return value;
}

async function restoreLabSettings(settings: BackupData["appSettings"] | undefined) {
  if (!settings) return;
  const mappings: Array<[keyof NonNullable<BackupData["appSettings"]>, string]> = [
    ["labOcrEnabled", "ortho_lab_ocr_enabled"],
    ["labWarningsEnabled", "ortho_lab_warnings_enabled"],
    ["labTestDefinitions", "ortho_lab_test_definitions_v1"],
    ["labTestBranches", "ortho_lab_test_branches_v1"],
    ["labResultsHiddenByPatient", "ortho_lab_results_hidden_by_patient_v1"],
    ["labWarningThresholdPercent", "ortho_lab_warning_threshold_percent_v1"],
    ["labOldResultDays", "ortho_lab_old_result_days_v1"],
    ["labOcrApiKey", "ortho_lab_online_ocr_api_key_v1"],
  ];
  for (const [field, key] of mappings) {
    if (!(field in settings)) continue;
    const value = settings[field];
    if (typeof value === "string") await AsyncStorage.setItem(key, value);
    else await AsyncStorage.removeItem(key);
  }
}

// Snapshot durable application settings stored in AsyncStorage, not just the
// handful of keys known to this backup version. This keeps newly added admin
// settings (including lab ranges/branches and feature toggles) recoverable
// without requiring a backup-code change for every key.
function isBackupableSettingKey(key: string): boolean {
  const normalized = String(key || "").toLowerCase();
  if (!normalized) return false;
  // Never restore stale login/session material or sync cursors from a backup.
  if (/(^|[_-])(access[_-]?token|refresh[_-]?token|auth[_-]?token|password|session|current[_-]?user|credential)([_-]|$)/i.test(normalized)) return false;
  if (/(^|[_-])(query[_-]?cache|persisted[_-]?query|last[_-]?successful[_-]?backup|last[_-]?uploaded[_-]?content[_-]?hash|incremental[_-]?snapshot|delta[_-]?cache|backup[_-]?reminder|last[_-]?drive[_-]?restore|drive[_-]?pending[_-]?tables|pending[_-]?tables|drive[_-]?last[_-]|drive[_-]?master[_-]|drive[_-]?month[_-]?archive[_-]?cursor|drive[_-]?scope[_-]?version|backup[_-]?content[_-]?hash)([_-]|$)/i.test(normalized)) return false;
  return true;
}
async function captureAsyncStorageSettings(): Promise<Record<string, string | null>> {
  const keys = (await AsyncStorage.getAllKeys()).filter(isBackupableSettingKey);
  const pairs = await AsyncStorage.multiGet(keys);
  const result: Record<string, string | null> = {};
  for (const [key, value] of pairs) result[key] = value;
  return result;
}
async function restoreAsyncStorageSettings(settings: BackupData["appSettings"] | undefined): Promise<void> {
  const saved = settings?.asyncStorageSettings;
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return;
  for (const [key, value] of Object.entries(saved)) {
    if (!isBackupableSettingKey(key) || (value !== null && typeof value !== "string")) continue;
    if (value === null) await AsyncStorage.removeItem(key);
    else await AsyncStorage.setItem(key, value);
  }
}

const bytesToHex=(b:Uint8Array)=>Array.from(b).map(x=>x.toString(16).padStart(2,"0")).join("");
function hexToBytes(hex:string){if(!hex||hex.length%2)throw new Error("Invalid encrypted backup data.");const b=new Uint8Array(hex.length/2);for(let i=0;i<b.length;i++){const n=parseInt(hex.slice(i*2,i*2+2),16);if(Number.isNaN(n))throw new Error("Invalid encrypted backup data.");b[i]=n;}return b;}
const stringToBytes=(v:string)=>new TextEncoder().encode(v);
const bytesToString=(b:Uint8Array)=>new TextDecoder().decode(b);
// Base64 is much smaller than hex for large encrypted backups. Process in small
// chunks so btoa does not spread a huge byte array onto the JS call stack.
function bytesToBase64(bytes: Uint8Array): string {
  let output = "";
  const chunkSize = 0x6000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    let binary = "";
    for (let j = 0; j < chunk.length; j++) binary += String.fromCharCode(chunk[j]);
    output += globalThis.btoa(binary);
  }
  return output;
}
function base64ToBytes(value: string): Uint8Array {
  // atob() creates one additional enormous binary string. On large backup
  // files Hermes/JSC can throw "String is too long" before decryption starts.
  // Decode bounded, 4-character-aligned chunks into the final byte buffer.
  const encoded = value.replace(/\s/g, "");
  if (!encoded) return new Uint8Array(0);
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const outputLength = Math.max(0, Math.floor(encoded.length * 3 / 4) - padding);
  const bytes = new Uint8Array(outputLength);
  const encodedChunkSize = 64 * 1024; // multiple of four; keeps each atob result small
  let byteOffset = 0;
  for (let offset = 0; offset < encoded.length; offset += encodedChunkSize) {
    const end = Math.min(encoded.length, offset + encodedChunkSize);
    const binary = globalThis.atob(encoded.slice(offset, end));
    for (let i = 0; i < binary.length && byteOffset < outputLength; i++) {
      bytes[byteOffset++] = binary.charCodeAt(i);
    }
  }
  if (byteOffset !== outputLength) throw new Error("Encrypted backup data is incomplete or invalid.");
  return bytes;
}
async function deriveKey(password:string,salt:Uint8Array){if(!password||password.length<8)throw new Error("Backup password must contain at least 8 characters.");const h=await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256,`${bytesToHex(salt)}:${password}`);return hexToBytes(h);}

function photoMime(uri:string){
  const clean=uri.split("?")[0].toLowerCase();
  if(clean.endsWith(".png"))return "image/png";
  if(clean.endsWith(".webp"))return "image/webp";
  if(clean.endsWith(".heic")||clean.endsWith(".heif"))return "image/heic";
  return "image/jpeg";
}

// Convert local phone photo files into self-contained data URIs.
// This is the important difference from the old backup: file:// or content://
// paths are not portable between phones, so the actual photo bytes are stored
// inside the encrypted backup.
type BackupPhotoCache = Map<string, string> & { assets?: Map<string, string> };
const BACKUP_PHOTO_REF_PREFIX = "__ORTHO_PHOTO_REF__:";

async function embedPhoto(uri:string, cache?: Map<string,string>, profile: "patient" | "document" = "patient"):Promise<string>{
  if (!uri) return "";
  if (uri.startsWith(BACKUP_PHOTO_REF_PREFIX)) return uri;

  const cacheKey = uri;
  const photoCache = cache as BackupPhotoCache | undefined;
  const assets = photoCache?.assets;
  // Signature uses the original URI/bytes and is stable between patient rows,
  // history snapshots and trash. Repeated images become a short reference.
  const assetRef = assets ? BACKUP_PHOTO_REF_PREFIX + photoSourceSignature({ photo_uri: uri }) : "";
  const cached = cache?.get(cacheKey);
  if (cached) return cached;
  const remember = (value: string) => {
    if (assets) {
      if (!assets.has(assetRef)) assets.set(assetRef, value);
      if (cache) {
        while (!cache.has(cacheKey) && cache.size >= 3) {
          const oldest = cache.keys().next().value;
          if (oldest === undefined) break;
          cache.delete(oldest);
        }
        cache.set(cacheKey, assetRef);
      }
      return assetRef;
    }
    if (cache) {
      while (!cache.has(cacheKey) && cache.size >= 3) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      cache.set(cacheKey, value);
    }
    return value;
  };
  if (assets?.has(assetRef)) return remember(assetRef);

  try {
    // Keep already-small embedded images byte-for-byte. Larger images are
    // encoded as high-quality JPEG at their ORIGINAL dimensions: no resize,
    // crop, filters, sharpening, or repeated generations of compression.
    const isDataImage = /^data:image\//i.test(uri);
    const comma = isDataImage ? uri.indexOf(",") : -1;
    const estimatedBytes = isDataImage && comma >= 0
      ? Math.floor(((uri.length - comma - 1) * 3) / 4)
      : 0;
    const targetBytes = 1.5 * 1024 * 1024;
    if (isDataImage && estimatedBytes > 0 && estimatedBytes <= targetBytes) {
      return remember(uri);
    }
    if (!isDataImage && /^(file:\/\/|content:\/\/)/i.test(uri)) {
      try {
        const sourceInfo = await LegacyFileSystem.getInfoAsync(uri);
        if (sourceInfo.exists && typeof sourceInfo.size === "number" && sourceInfo.size > 0 && sourceInfo.size <= targetBytes) {
          // Keep small local report images byte-for-byte; only large images need
          // lossy JPEG compression. This avoids needless changes to fine text.
          const base64 = await LegacyFileSystem.readAsStringAsync(uri, {
            encoding: LegacyFileSystem.EncodingType.Base64,
          });
          if (base64) {
            const path = uri.split("?")[0].toLowerCase();
            const mime = path.endsWith(".png") ? "image/png"
              : path.endsWith(".webp") ? "image/webp"
              : path.endsWith(".heic") || path.endsWith(".heif") ? "image/heic"
              : path.endsWith(".gif") ? "image/gif"
              : "image/jpeg";
            const portable = "data:" + mime + ";base64," + base64;
            return remember(portable);
          }
        }
      } catch {
        // Some content:// providers do not expose file size; continue through
        // the normal high-quality compression path in that case.
      }
    }

    // Convert embedded data URIs to a temporary file first. Native image
    // manipulation is unreliable with data: URIs on Android and could leave
    // backup progress stuck on the final image. Use one high-quality pass,
    // without resizing, and cap the wait so a broken decoder cannot hang sync.
    const tempUris: string[] = [];
    let inputUri = uri;
    let bestResultUri = "";
    let bestResultSize = Number.POSITIVE_INFINITY;
    try {
      if (isDataImage) {
        if (!LegacyFileSystem.cacheDirectory) throw new Error("Image cache directory unavailable.");
        const comma = uri.indexOf(",");
        if (comma < 0) throw new Error("Malformed image data URI.");
        const mime = (uri.slice(5, uri.indexOf(";") > 0 ? uri.indexOf(";") : comma) || "image/jpeg").toLowerCase();
        const extension = mime.includes("png") ? ".png" : mime.includes("webp") ? ".webp" : mime.includes("heic") ? ".heic" : ".jpg";
        inputUri = LegacyFileSystem.cacheDirectory + "ortho-backup-photo-" + Date.now() + "-" + Math.floor(Math.random() * 100000) + extension;
        const base64Start = comma + 1;
        await LegacyFileSystem.writeAsStringAsync(inputUri, uri.slice(base64Start), {
          encoding: LegacyFileSystem.EncodingType.Base64,
        });
        tempUris.push(inputUri);
      }
      // Retry from the original source at progressively lower-but-still-high
      // JPEG quality. Keep original pixel dimensions; never resize medical text.
      // Stop as soon as the file is near 2 MB, otherwise keep the best quality
      // result reached rather than generating a visibly degraded thumbnail.
      // Patient attachments are often lab reports too; keep a strict 0.88
      // minimum quality rather than forcing a tiny file at the expense of text.
      const qualities = profile === "document" ? [0.97, 0.95, 0.93, 0.90] : [0.96, 0.94, 0.92, 0.90];
      let selectedSize = 0;
      for (const quality of qualities) {
        const result = await new Promise<any>((resolve, reject) => {
          let settled = false;
          const timeout = setTimeout(() => {
            if (!settled) { settled = true; reject(new Error("Image processing timed out after 45 seconds.")); }
          }, 45000);
          ImageManipulator.manipulateAsync(inputUri, [], {
            compress: quality,
            format: ImageManipulator.SaveFormat.JPEG,
          }).then((value) => {
            if (!settled) { settled = true; clearTimeout(timeout); resolve(value); }
            else if (value?.uri) void LegacyFileSystem.deleteAsync(value.uri, { idempotent: true }).catch(() => {});
          }, (error) => {
            if (!settled) { settled = true; clearTimeout(timeout); reject(error); }
          });
        });
        const info = await LegacyFileSystem.getInfoAsync(result.uri);
        if (!info.exists || typeof info.size !== "number" || info.size <= 0) {
          try { await LegacyFileSystem.deleteAsync(result.uri, { idempotent: true }); } catch {}
          throw new Error("Compressed image is empty.");
        }
        if (info.size < bestResultSize) {
          if (bestResultUri) {
            try { await LegacyFileSystem.deleteAsync(bestResultUri, { idempotent: true }); } catch {}
            const oldIndex = tempUris.indexOf(bestResultUri);
            if (oldIndex >= 0) tempUris.splice(oldIndex, 1);
          }
          bestResultUri = result.uri;
          bestResultSize = info.size;
          selectedSize = info.size;
          tempUris.push(bestResultUri);
        } else {
          try { await LegacyFileSystem.deleteAsync(result.uri, { idempotent: true }); } catch {}
        }
        if (selectedSize > 0 && selectedSize <= targetBytes) break;
      }
      if (!bestResultUri) throw new Error("Image compression did not produce a usable file.");
      const base64 = await LegacyFileSystem.readAsStringAsync(bestResultUri, {
        encoding: LegacyFileSystem.EncodingType.Base64,
      });
      if (!base64) throw new Error("Compressed image data is empty.");
      const portable = "data:image/jpeg;base64," + base64;
      return remember(portable);
    } catch (compressionError) {
      // Preserve the source if the device decoder cannot safely finish. A
      // large original may exceed the preferred size, but it must not be lost.
      if (isDataImage) {
        return remember(uri);
      }
      const base64 = await LegacyFileSystem.readAsStringAsync(uri, {
        encoding: LegacyFileSystem.EncodingType.Base64,
      });
      if (!base64) throw compressionError;
      const path = uri.split("?")[0].toLowerCase();
      const mime = path.endsWith(".png") ? "image/png"
        : path.endsWith(".webp") ? "image/webp"
        : path.endsWith(".heic") || path.endsWith(".heif") ? "image/heic"
        : path.endsWith(".gif") ? "image/gif"
        : "image/jpeg";
      const portable = "data:" + mime + ";base64," + base64;
      return remember(portable);
    } finally {
      for (const tempUri of tempUris) {
        try { await LegacyFileSystem.deleteAsync(tempUri, { idempotent: true }); } catch {}
      }
    }
  } catch (error) {
    throw new Error("Could not safely compress this image for backup without changing its dimensions. Please keep the original and try again.");
  }
}
async function embedOptionalPhoto(uri: string, cache?: Map<string,string>): Promise<string> {
  if (!uri) return uri;
  try { return await embedPhoto(uri, cache, "document"); }
  catch (error) {
    // A bill attachment must not prevent the entire backup from succeeding.
    // Valid local/data URIs are compressed and embedded; legacy unsupported
    // attachment formats are retained as-is for backward compatibility.
    console.warn("[backup] optional bill photo could not be compressed", error);
    return uri;
  }
}

async function embedPatientPhotos(row:any, cache?: Map<string,string>, onProgress?: (stage: string) => void, context = "patient"){
  const raw = row.photos_json;
  let photos:string[]=[];
  if(raw){
    try{
      const parsed=JSON.parse(String(raw));
      if(Array.isArray(parsed))photos=parsed.filter((x)=>typeof x==="string"&&x.length>0);
    }catch{}
  }
  if(!photos.length && row.photo_uri)photos=[String(row.photo_uri)];
  const embedded:string[]=[];
  for(let photoIndex=0;photoIndex<photos.length;photoIndex++){
    onProgress?.("Compressing " + context + " image " + (photoIndex+1) + "/" + photos.length + "…");
    embedded.push(await embedPhoto(photos[photoIndex], cache));
    // Yield between full-resolution images so the progress label can refresh
    // and Android does not queue multiple native image allocations at once.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return {
    ...row,
    photo_uri: "",
    photos_json: embedded,
  };
}

export type BackupFilter = { type: "all" | "date" | "month" | "year" | "halfYear"; value?: string };

function halfYearBounds(value: string | undefined): { start: string; end: string } | null {
  const match = /^(\d{4})-H([12])$/.exec(String(value || ""));
  if (!match) return null;
  const year = Number(match[1]);
  return match[2] === "1"
    ? { start: `${match[1]}-01-01`, end: `${match[1]}-07-01` }
    : { start: `${match[1]}-07-01`, end: `${year + 1}-01-01` };
}

function whereForFilter(filter: BackupFilter, column: string) {
  if (filter.type === "date") return { sql: ` WHERE ${column}=?`, args: [filter.value || ""] };
  if (filter.type === "month") return { sql: ` WHERE ${column} LIKE ?`, args: [`${filter.value || ""}-%`] };
  if (filter.type === "year") return { sql: ` WHERE ${column} LIKE ?`, args: [`${filter.value || ""}-%`] };
  if (filter.type === "halfYear") {
    const bounds = halfYearBounds(filter.value);
    if (!bounds) throw new Error("Choose a half-year as YYYY-H1 or YYYY-H2.");
    return { sql: ` WHERE ${column} >= ? AND ${column} < ?`, args: [bounds.start, bounds.end] };
  }
  return { sql: "", args: [] };
}

// Bound concurrent photo work to avoid many full-resolution images being
// decoded/compressed at once on low-memory Android devices.
async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let next = 0;
  const workers = Math.min(items.length, Math.max(1, Math.floor(concurrency) || 1));
  await Promise.all(Array.from({ length: workers }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      output[index] = await mapper(items[index], index);
    }
  }));
  return output;
}


const DRIVE_OCR_TRANSIENT_KEYS = new Set([
 "labocrextractedtext", "labocrphotosignature", "labocrphotoscancomplete",
 "labocrpipelineversion", "labocrpossibleflags", "labocrneedsreview",
 "labocronlinetestnamehelp", "labocrmanualresults",
]);
function isDriveOcrOutputKey(key: string): boolean {
 const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
 return DRIVE_OCR_TRANSIENT_KEYS.has(normalized) ||
   normalized.startsWith("labocr") ||
   normalized.includes("recognizedlabtext") ||
   normalized.includes("extractedlabtext");
}
// Raw OCR and scan-cache metadata can be regenerated by rescanning saved photos.
// Preserve reviewed lab results (labOcrManualResults) and admin lab settings.
function stripDriveOcrText(value: any, parentKey = ""): any {
 if (Array.isArray(value)) return value.map((item) => stripDriveOcrText(item));
 if (!value || typeof value !== "object") {
  if (typeof value === "string" && /^(?:customdata|custom_data|snapshot_json|payload_json)$/i.test(parentKey)) {
   try { return JSON.stringify(stripDriveOcrText(JSON.parse(value), parentKey)); } catch { return value; }
  }
  return value;
 }
 const result: Record<string, any> = {};
 for (const [key, child] of Object.entries(value)) {
  if (isDriveOcrOutputKey(key)) continue;
  if (typeof child === "string" && /^(?:customdata|custom_data|snapshot_json|payload_json)$/i.test(key)) {
   try { result[key] = JSON.stringify(stripDriveOcrText(JSON.parse(child), key)); continue; } catch {}
  }
  result[key] = stripDriveOcrText(child, key);
 }
 return result;
}

async function createBackupData(filter: BackupFilter = { type: "all" }, onProgress?: (stage: string) => void, changedTables?: string[], previousPatientRows?: any[], previousPhotoSources?: Record<string, string>, includePatientImages = true, includeAttachedImages = true, incrementalHistorySince?: string, incrementalHistoryExcludedIds: string[] = []):Promise<BackupData>{
 if (filter.type === "halfYear" && !halfYearBounds(filter.value)) throw new Error("Choose a half-year as YYYY-H1 or YYYY-H2.");
 initializeDatabase();
 if (includePatientImages && filter.type === "all" && (!changedTables || changedTables.includes("patients"))) await archiveEligiblePatientImages(onProgress);
 const localPatientArchives = await getLocalPatientImageArchives(); // metadata only; image PDFs are separate
 const archiveByPatientId = new Map(localPatientArchives.map((archive:any) => [String(archive.patientId), archive]));
 const include = (name: string) => !changedTables || changedTables.includes(name);
 let branding: BrandingConfig | null | undefined;
 if (include("branding")) {
   // Storage normally returns a JSON string for this legacy key, but older
 // builds may have stored the branding object directly. Accept both formats
 // so logos and all PDF/font/colour settings are always included.
 const brandingRaw=await storage.getItem<any>("ortho_branding","");
 if(brandingRaw && typeof brandingRaw==="object" && !Array.isArray(brandingRaw)){
   branding=brandingRaw as BrandingConfig;
 } else if(typeof brandingRaw==="string" && brandingRaw.trim()){
   try{
     let parsed:any=JSON.parse(brandingRaw);
     if(typeof parsed==="string") parsed=JSON.parse(parsed);
     if(parsed && typeof parsed==="object" && !Array.isArray(parsed)) branding=parsed as BrandingConfig;
     else branding=null;
   }catch{ branding=null; }
 } else {
   branding = null;
 }
 }
 const appSettings = include("appSettings") ? {
   googleOAuthClientId: (await storage.secureGet("ortho_google_drive_client_id", "")) || null,
   googleCloudProjectId: (await storage.secureGet("ortho_google_drive_cloud_project_id", "")) || null,
   // Recovery metadata only; Google credentials must be re-authorized after reinstall.
   googleAccountEmail: (await storage.secureGet("ortho_drive_account_email", "")) || null,
   labOcrEnabled: await AsyncStorage.getItem("ortho_lab_ocr_enabled"),
   labWarningsEnabled: await AsyncStorage.getItem("ortho_lab_warnings_enabled"),
   labWarningThresholdPercent: await AsyncStorage.getItem("ortho_lab_warning_threshold_percent_v1"),
   labOldResultDays: await AsyncStorage.getItem("ortho_lab_old_result_days_v1"),
   // Included because the user requested OCR settings to survive restore. Note:
   // Google Drive snapshots are currently unencrypted, so this key is visible to
   // anyone who can read the backup file. Keep Drive access restricted.
   labOcrApiKey: await AsyncStorage.getItem("ortho_lab_online_ocr_api_key_v1"),
   labTestDefinitions: await AsyncStorage.getItem("ortho_lab_test_definitions_v1"),
   labTestBranches: await AsyncStorage.getItem("ortho_lab_test_branches_v1"),
   labResultsHiddenByPatient: await AsyncStorage.getItem("ortho_lab_results_hidden_by_patient_v1"),
   // Include durable settings added by future admin screens as well.
   asyncStorageSettings: await captureAsyncStorageSettings(),
 } : undefined;
 const pf=whereForFilter(filter, "date");
 const patientMetadataColumns = "id,mr_no,name,gender,age,diagnosis,procedure,procedure_ii,implant,implant_ii,implant_id,implant_ii_id,address,file_name,date,created_at,created_by,updated_at,updated_by" + (includePatientImages ? ",custom_data_json" : "");
 let patients: any[] = [];
 if (include("patients")) {
   if (filter.type === "month" || filter.type === "year") {
     const pattern = `${filter.value || ""}-%`;
     // Include patient records for anyone with history created in this period,
     // even if their original admit date was earlier.
     patients = db.getAllSync<any>(
       `SELECT ${patientMetadataColumns} FROM patients WHERE date LIKE ? OR id IN (SELECT DISTINCT patient_id FROM patient_history WHERE created_at LIKE ?) ORDER BY date DESC, created_at DESC`,
       [pattern, pattern],
     );
   } else if (filter.type === "halfYear") {
     const patientFilter = whereForFilter(filter, "date");
     const historyFilter = whereForFilter(filter, "created_at");
     patients = db.getAllSync<any>(
       // A half-year snapshot contains only patients whose own admission/entry
       // date belongs to that half-year. A later edit/history event must not
       // pull an older patient into H2 and make the H2 backup look all-time.
       `SELECT ${patientMetadataColumns} FROM patients${patientFilter.sql} ORDER BY date DESC, created_at DESC`,
       patientFilter.args,
     );
   } else {
     patients = db.getAllSync<any>(`SELECT ${patientMetadataColumns} FROM patients${pf.sql} ORDER BY date DESC, created_at DESC`, pf.args);
   }
 }
 const selectedPatientIds = new Set(patients.map((p:any)=>String(p.id)));
 const compressedPhotoCache = new Map<string,string>() as BackupPhotoCache;
 compressedPhotoCache.assets = new Map<string,string>();
 const embeddedPatients:any[]=[];
 const previousPatientsById = new Map<string, any>((previousPatientRows || []).filter((p:any)=>p?.id!=null).map((p:any)=>[String(p.id),p]));
 for(let i=0;i<patients.length;i++){
   const patient = patients[i];
   const patientId = String(patient.id ?? "");
   if (!includePatientImages) {
     // Patient photo bytes live in per-patient PDFs. Do not select huge photo
     // columns into Android's CursorWindow in metadata-only backups.
     const archivedImage = archiveByPatientId.get(patientId);
     const archiveMatchesRevision = !!archivedImage &&
       String(archivedImage.patientUpdatedAt || "") === String(patient.updated_at || "");
     const backupCustomData = readJsonColumnWithoutPhotoPayload("patients", "custom_data_json", patientId);
     embeddedPatients.push({
       ...patient, custom_data_json: backupCustomData, photo_uri: "", photos_json: "",
       ...(archiveMatchesRevision ? {
         photo_archive_file_name: archivedImage!.fileName,
         photo_archive_source_stamp: archivedImage!.sourceStamp,
         photo_archived_at: archivedImage!.archivedAt,
         photo_archive_image_count: archivedImage!.imageCount,
       } : {}),
     });
     continue;
   }
   const photoRow = db.getFirstSync<any>("SELECT photo_uri,photos_json FROM patients WHERE id=?", [patientId]) || {};
   const patientWithPhotos = { ...patient, ...photoRow };
   const sourceSignature = photoSourceSignature(patientWithPhotos);
   const previous = previousPatientsById.get(patientId);
   const archivedImage = archiveByPatientId.get(patientId);
   // Only replace live patient photos with a PDF reference when that PDF was
   // explicitly synchronized to this exact saved patient revision. If the
   // patient has since changed, keep the current photos in the master backup
   // until an admin approves updating the separate Drive PDF.
   if (archivedImage && String(archivedImage.patientUpdatedAt || "") === String(patient.updated_at || "")) {
     embeddedPatients.push({
       ...patient, photo_uri: "", photos_json: "",
       photo_archive_file_name: archivedImage.fileName,
       photo_archive_source_stamp: archivedImage.sourceStamp,
       photo_archived_at: archivedImage.archivedAt,
       photo_archive_image_count: archivedImage.imageCount,
     });
     patient.photo_uri = ""; patient.photos_json = "";
     patientWithPhotos.photo_uri = ""; patientWithPhotos.photos_json = "";
     photoRow.photo_uri = ""; photoRow.photos_json = "";
     continue;
   }
   if (changedTables?.includes("patients") && patientId && previous &&
       previousPhotoSources?.[patientId] === sourceSignature) {
     // For incremental sync, unchanged original photo bytes are already in the
     // confirmed master. Keep row metadata for diff/deletion detection, but do
     // not read or duplicate every unchanged image into the new delta.
     embeddedPatients.push({...patient, photo_uri: "", photos_json: ""});
   } else if (!changedTables?.includes("patients") && patientId && previous &&
       previousPhotoSources?.[patientId] === sourceSignature &&
       typeof previous.photos_json === "string") {
     // A full export may reuse a confirmed portable copy when available.
     embeddedPatients.push({...patient, photo_uri: previous.photo_uri || "", photos_json: previous.photos_json});
   } else {
     onProgress?.("Reading original patient photos… " + (i + 1) + "/" + patients.length);
     embeddedPatients.push(await embedPatientPhotos(patientWithPhotos, compressedPhotoCache, onProgress, "patient " + (i + 1) + "/" + patients.length));
     onProgress?.("Patient photos prepared " + (i + 1) + "/" + patients.length);
     // Yield after each patient so progress updates and Back remain responsive
     // on phones with large reports.
     await new Promise<void>((resolve) => setTimeout(resolve, 0));
   }
   // Drop the raw base64/photo JSON from the source row immediately after the
   // compressed portable copy has been produced. Keeping both copies of all
   // 57+ patient reports alive is enough to exhaust Android's JS heap.
   patient.photo_uri = "";
   patient.photos_json = "";
   patientWithPhotos.photo_uri = "";
   patientWithPhotos.photos_json = "";
   photoRow.photo_uri = "";
   photoRow.photos_json = "";
 }

 onProgress?.("Patient photos prepared; reading historical reports…");
 // Incremental exports query only audit rows after the full-master baseline,
 // excluding rows already represented by the remote journal. This avoids
 // reopening many historic image-heavy snapshots when a restored phone saves
 // one new patient, without dropping older unsynced history.
 const incrementalHistoryWindow = !!changedTables && changedTables.includes("patientHistory");
 const parsedHistorySince = Date.parse(String(incrementalHistorySince || ""));
 const incrementalHistoryCutoff = Number.isFinite(parsedHistorySince)
   ? new Date(parsedHistorySince).toISOString()
   : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
 const historyAll = !include("patientHistory") ? [] : incrementalHistoryWindow
   ? db.getAllSync<any>(
       "SELECT id,patient_id,user_id,action,created_at FROM patient_history WHERE created_at >= ? AND id NOT IN (SELECT value FROM json_each(?)) ORDER BY created_at ASC",
       [incrementalHistoryCutoff, JSON.stringify(incrementalHistoryExcludedIds)],
     )
   : db.getAllSync<any>("SELECT id,patient_id,user_id,action,created_at FROM patient_history ORDER BY created_at ASC");
 const history=filter.type==="all" ? historyAll : filter.type === "month" || filter.type === "year"
   ? historyAll.filter((h:any)=>String(h.created_at || "").startsWith(String(filter.value || "") + "-"))
   : filter.type === "halfYear"
     ? (() => { const bounds = halfYearBounds(filter.value)!; return historyAll.filter((h:any) => String(h.created_at || "") >= bounds.start && String(h.created_at || "") < bounds.end); })()
     : historyAll.filter((h:any)=>selectedPatientIds.has(String(h.patient_id)) && String(h.created_at || "").startsWith(String(filter.value || "")));
 const embeddedHistory:any[]=[];
 onProgress?.("Processing patient history images… 0/" + history.length);
 for (let historyIndex = 0; historyIndex < history.length; historyIndex++) {
   const h = history[historyIndex];
   if (historyIndex % 3 === 0) {
     onProgress?.("Processing patient history… " + (historyIndex + 1) + "/" + history.length);
     // Yield to React Native so the progress message and cancel/back UI remain responsive.
     await new Promise<void>((resolve) => setTimeout(resolve, 0));
   }
   // Strip nested legacy images inside SQLite before a multi-megabyte JSON
    // snapshot crosses into Hermes. Fixed JSON paths miss older PDF-import shapes.
    const snapshotRow = includePatientImages
      ? db.getFirstSync<any>("SELECT snapshot_json FROM patient_history WHERE id=? LIMIT 1", [h.id])
      : { snapshot_json: readJsonColumnWithoutPhotoPayload("patient_history", "snapshot_json", String(h.id)) };
    const rawSnapshot = String(snapshotRow?.snapshot_json || "");
   if (!includePatientImages) {
     try {
       const snapshot = JSON.parse(rawSnapshot || "{}");
       embeddedHistory.push({ ...h, snapshot_json: JSON.stringify(stripPatientPhotosDeep(snapshot)) });
     } catch { embeddedHistory.push({ ...h, snapshot_json: "{}" }); }
     h.snapshot_json = "";
     continue;
   }

   const historySourceSignature = rowImageSignature({ snapshot_json: rawSnapshot });
   const historySignatureKey = "images:patientHistory:" + String(h.id);
   if (changedTables?.includes("patientHistory") &&
       previousPhotoSources?.[historySignatureKey] === historySourceSignature) {
     embeddedHistory.push({ ...h, snapshot_json: rawSnapshot });
     h.snapshot_json = "";
     continue;
   }
   try {
     const snap = JSON.parse(rawSnapshot);
     // Historical patient snapshots can contain another copy of every photo.
     // Keep history intact but compress/embed those copies too, and reuse
     // already-compressed identical photos instead of allocating them again.
     let historyPhotos: string[] = Array.isArray(snap?.photos)
       ? snap.photos.filter((photo:any) => typeof photo === "string" && photo.length > 0)
       : [];
     const photosJson = snap?.photos_json;
     if (!historyPhotos.length && typeof photosJson === "string") {
       try {
         const parsedPhotos = JSON.parse(photosJson);
         if (Array.isArray(parsedPhotos)) historyPhotos = parsedPhotos.filter((photo:any) => typeof photo === "string" && photo.length > 0);
       } catch {}
     }
     const singlePhoto = typeof snap?.photoUri === "string" && snap.photoUri
       ? snap.photoUri
       : typeof snap?.photo_uri === "string" ? snap.photo_uri : "";
     if (!historyPhotos.length && singlePhoto) historyPhotos = [singlePhoto];
     if (historyPhotos.length) {
       const embeddedHistoryPhotos: string[] = [];
       for (let photoIndex = 0; photoIndex < historyPhotos.length; photoIndex++) {
         onProgress?.("Compressing historical report image " + (photoIndex + 1) + "/" + historyPhotos.length + " · history " + (historyIndex + 1) + "/" + history.length);
         embeddedHistoryPhotos.push(await embedPhoto(historyPhotos[photoIndex], compressedPhotoCache));
         await new Promise<void>((resolve) => setTimeout(resolve, 0));
       }
       if (Array.isArray(snap.photos)) snap.photos = embeddedHistoryPhotos;
       else if (typeof snap.photos_json === "string") snap.photos_json = JSON.stringify(embeddedHistoryPhotos);
       else snap.photos = embeddedHistoryPhotos;
       if (snap.photoUri) snap.photoUri = "";
       if (snap.photo_uri) snap.photo_uri = "";
     }
     embeddedHistory.push({...h, snapshot_json:JSON.stringify(snap)});
     // The history array is still needed for iteration, but not its original
     // image-heavy snapshot after a portable replacement has been made.
     h.snapshot_json = "";
   } catch {
     embeddedHistory.push({ ...h, snapshot_json: rawSnapshot });
   }
 }

 const trashSourceRows = include("trash") ? (() => {
   const all = db.getAllSync<any>("SELECT id,kind,title,deleted_at,expires_at,deleted_by FROM deleted_records ORDER BY deleted_at DESC");
   if (filter.type === "all") return all;
   if (filter.type === "halfYear") {
     const bounds = halfYearBounds(filter.value)!;
     return all.filter((row:any) => String(row.deleted_at || "") >= bounds.start && String(row.deleted_at || "") < bounds.end);
   }
   const prefix = String(filter.value || "");
   return all.filter((row:any) => String(row.deleted_at || "").startsWith(prefix));
 })() : [];
 onProgress?.("Processing deleted records and trash… 0/" + trashSourceRows.length);
 const trashRows = include("trash") ? await mapWithConcurrency(trashSourceRows, 2, async (entry:any, trashIndex:number) => {
   if (trashIndex % 2 === 0) {
     onProgress?.("Processing deleted records and trash… " + (trashIndex + 1) + "/" + trashSourceRows.length);
     await new Promise<void>((resolve) => setTimeout(resolve, 0));
   }
    let payloadRow: any;
    if (includePatientImages) {
      payloadRow = db.getFirstSync<any>("SELECT payload_json FROM deleted_records WHERE id=?", [entry.id]);
    } else {
      // Strip patient image fields in SQLite before a large deleted-record JSON row
      // is copied through CursorWindow into JavaScript.
      const counts = db.getFirstSync<any>(
        "SELECT CASE WHEN json_valid(payload_json) THEN json_array_length(payload_json, '$.patients') ELSE 0 END AS patient_count, CASE WHEN json_valid(payload_json) THEN json_array_length(payload_json, '$.patient_history') ELSE 0 END AS history_count FROM deleted_records WHERE id=?",
        [entry.id],
      ) || {};
      const paths = ["$.photo_uri", "$.photoUri", "$.photos_json", "$.photos",
        "$.patient.photo_uri", "$.patient.photoUri", "$.patient.photos_json", "$.patient.photos"];
      const patientCount = Math.min(200, Math.max(0, Number(counts.patient_count || 0)));
      const historyCount = Math.min(200, Math.max(0, Number(counts.history_count || 0)));
      for (let n = 0; n < patientCount; n++) {
        paths.push("$.patients[" + n + "].photo_uri", "$.patients[" + n + "].photoUri",
          "$.patients[" + n + "].photos_json", "$.patients[" + n + "].photos");
      }
      for (let n = 0; n < historyCount; n++) {
        paths.push("$.patient_history[" + n + "].photo_uri", "$.patient_history[" + n + "].photoUri",
          "$.patient_history[" + n + "].photos_json", "$.patient_history[" + n + "].photos",
          "$.patient_history[" + n + "].snapshot.photos", "$.patient_history[" + n + "].snapshot.photos_json",
          "$.patient_history[" + n + "].snapshot.photo_uri", "$.patient_history[" + n + "].snapshot.photoUri");
      }
      let expression = "payload_json";
      // SQLite limits function arguments. Nested small json_remove calls handle
      // large multi-patient trash entries without returning the original image blob.
      for (let start = 0; start < paths.length; start += 20) {
        const group = paths.slice(start, start + 20).map(path => "'" + path.replace(/'/g, "''") + "'").join(", ");
        expression = "json_remove(" + expression + ", " + group + ")";
      }
      payloadRow = db.getFirstSync<any>(
        "SELECT CASE WHEN json_valid(payload_json) THEN " + expression + " ELSE '{}' END AS payload_json FROM deleted_records WHERE id=?",
        [entry.id],
      );
    }

   const rawPayload = String(payloadRow?.payload_json || "{}");
   let payload:any = {};
   try { payload = JSON.parse(rawPayload); } catch { payload = {}; }
   if (!includePatientImages) payload = stripPatientPhotosDeep(payload);
   if (payloadRow) payloadRow.payload_json = "";
   for (const patient of Array.isArray(payload.patients) ? payload.patients : []) {
     const embedded = await embedPatientPhotos(patient, compressedPhotoCache, onProgress, "trash patient " + (trashIndex + 1) + "/" + trashSourceRows.length);
     Object.assign(patient, embedded);
   }
   for (const table of ["inventory", "inventory_purchase_receipts", "stock_receipts"]) {
     if (!Array.isArray(payload[table])) continue;
     for (const row of payload[table]) {
       if (typeof row.bill_image === "string" && /^(data:image\/|file:\/\/|content:\/\/)/i.test(row.bill_image)) {
         row.bill_image = await embedOptionalPhoto(row.bill_image, compressedPhotoCache);
       }
     }
   }
   for (const row of Array.isArray(payload.implant_records) ? payload.implant_records : []) {
     try {
       const files = JSON.parse(String(row.bill_files_json || "[]"));
       if (Array.isArray(files)) {
         const compressed = [];
         for (const file of files) compressed.push(typeof file === "string" && /^(data:image\/|file:\/\/|content:\/\/)/i.test(file) ? await embedOptionalPhoto(file, compressedPhotoCache) : file);
         row.bill_files_json = JSON.stringify(compressed);
       }
     } catch {}
   }
   for (const history of Array.isArray(payload.patient_history) ? payload.patient_history : []) {
     try {
       const snap = JSON.parse(String(history.snapshot_json || "{}"));
       let photos:string[] = Array.isArray(snap.photos) ? snap.photos.filter((x:any) => typeof x === "string" && x.length > 0) : [];
       if (!photos.length && typeof snap.photos_json === "string") {
         try { const parsed = JSON.parse(snap.photos_json); if (Array.isArray(parsed)) photos = parsed.filter((x:any) => typeof x === "string" && x.length > 0); } catch {}
       }
       const single = typeof snap.photoUri === "string" ? snap.photoUri : typeof snap.photo_uri === "string" ? snap.photo_uri : "";
       if (!photos.length && single) photos = [single];
       if (photos.length) {
         const embeddedPhotos:string[] = [];
         for (const photo of photos) embeddedPhotos.push(await embedPhoto(photo, compressedPhotoCache));
         if (Array.isArray(snap.photos)) snap.photos = embeddedPhotos;
         else if (typeof snap.photos_json === "string") snap.photos_json = JSON.stringify(embeddedPhotos);
         else snap.photos = embeddedPhotos;
         snap.photoUri = ""; snap.photo_uri = "";
       }
       history.snapshot_json = JSON.stringify(snap);
     } catch {}
   }
   const portableEntry = { ...entry, payload_json: JSON.stringify(payload) };
   // Avoid holding the original and portable trash payload (which may contain
   // many photos) simultaneously until the entire backup has finished.
   entry.payload_json = "";
   return portableEntry;
 }) : [];

 return {
  version:BACKUP_VERSION,app:BACKUP_APP,createdAt:new Date().toISOString(),
  patients:embeddedPatients,
  procedures:include("procedures") ? db.getAllSync<any>("SELECT * FROM procedures ORDER BY name COLLATE NOCASE") : [],
  inventoryCategories:include("inventoryCategories") ? db.getAllSync<any>("SELECT * FROM inventory_categories ORDER BY name COLLATE NOCASE") : [],
  // Half-year snapshots must be independently restorable, so they include the
  // complete current stock and bill attachments plus period-specific dated activity.
  inventory:include("inventory") && (filter.type==="all" || filter.type==="halfYear") ? await mapWithConcurrency(db.getAllSync<any>("SELECT id,name,category_id,category,size,quantity,unit,minimum_stock,added_date,low_stock_triggered_at,low_stock_since FROM inventory ORDER BY COALESCE(category,''),name COLLATE NOCASE,COALESCE(size,'')"), 2, async (row:any) => {
    const billRow = db.getFirstSync<any>("SELECT bill_image FROM inventory WHERE id=?", [row.id]);
    const sourceBillImage = billRow?.bill_image;
    const billImage = !includeAttachedImages ? "" : typeof sourceBillImage === "string" && /^(data:image\/|file:\/\/|content:\/\/)/i.test(sourceBillImage)
      ? await embedOptionalPhoto(sourceBillImage, compressedPhotoCache)
      : sourceBillImage;
    billRow && (billRow.bill_image = "");
    return { ...row, bill_image: billImage };
  }) : [],
  patientImplants:include("patientImplants") ? db.getAllSync<any>("SELECT * FROM patient_implants ORDER BY created_at ASC").filter((row:any)=>filter.type==="all" || selectedPatientIds.has(String(row.patient_id))) : [],
  patientCustomFields:include("patientCustomFields") ? db.getAllSync<any>("SELECT * FROM patient_custom_fields ORDER BY sort_order ASC,label COLLATE NOCASE") : [],
  implantRecords:include("implantRecords") ? await mapWithConcurrency((() => { const f = filter.type === "halfYear" ? { sql: "", args: [] as any[] } : whereForFilter(filter, "created_at"); return db.getAllSync<any>(`SELECT id,name,category,size,manufacturer,model,lot_number,serial_number,expiry_date,supplier,quantity,unit,purchase_price,notes,created_at,updated_at,created_by,updated_by FROM implant_records${f.sql} ORDER BY created_at ASC`, f.args); })(), 2, async (row:any) => {
    const billRow = db.getFirstSync<any>("SELECT bill_files_json FROM implant_records WHERE id=?", [row.id]);
    if (!includeAttachedImages) {
      const portableRow = { ...row, bill_files_json: "[]" };
      row.bill_files_json = "";
      if (billRow) billRow.bill_files_json = "";
      return portableRow;
    }
    let billFiles = billRow?.bill_files_json;
    try {
      const parsed = JSON.parse(String(billFiles || "[]"));
      if (Array.isArray(parsed)) {
        const compressed = [];
        for (const file of parsed) {
          if (typeof file === "string" && /^(data:image\/|file:\/\/|content:\/\/)/i.test(file)) {
            try { compressed.push(await embedPhoto(file, compressedPhotoCache, "document")); } catch { compressed.push(file); }
          } else compressed.push(file);
        }
        billFiles = JSON.stringify(compressed);
      }
    } catch {}
    const portableRow = { ...row, bill_files_json: billFiles };
    row.bill_files_json = "";
    if (billRow) billRow.bill_files_json = "";
    return portableRow;
  }) : [],
  expenses:include("expenses") ? (()=>{const f=whereForFilter(filter,"date");return db.getAllSync<any>(`SELECT * FROM expenses${f.sql} ORDER BY date DESC, created_at DESC`,f.args);})() : [],
  // Back up account records as well as clinical data. password_hash is the salted
  // verifier (never the user's plain-text password); role, permissions, disabled
  // status and recovery_code are retained so restored admin/staff accounts work.
  // Live access/session tokens are deliberately excluded from settings backups.
  users:include("users") ? db.getAllSync<any>("SELECT * FROM users ORDER BY created_at ASC") : [],
  patientHistory:embeddedHistory,
  inventoryMovements:include("inventoryMovements") ? (()=>{if(filter.type==="all") return db.getAllSync<any>("SELECT * FROM inventory_movements ORDER BY created_at ASC"); const f=filter.type==="date" ? {sql:" WHERE date(created_at)=?",args:[filter.value||""]} : whereForFilter(filter,"created_at"); return db.getAllSync<any>(`SELECT * FROM inventory_movements${f.sql} ORDER BY created_at ASC`,f.args);})() : [],
  inventoryPurchaseReceipts:include("inventoryPurchaseReceipts") ? await (async()=>{const f=whereForFilter(filter,"created_at");const rows=db.getAllSync<any>(`SELECT id,inventory_id,batch_id,category_id,category,size,quantity,unit,minimum_stock,added_date,description,created_at,created_by FROM inventory_purchase_receipts${f.sql} ORDER BY created_at ASC`,f.args);return await mapWithConcurrency(rows, 2, async (row:any)=>{const billRow=db.getFirstSync<any>("SELECT bill_image FROM inventory_purchase_receipts WHERE id=?",[row.id]);const source=billRow?.bill_image;const billImage=!includeAttachedImages ? "" : typeof source==="string" && /^(data:image\/|file:\/\/|content:\/\/)/i.test(source) ? await embedOptionalPhoto(source,compressedPhotoCache) : source; if(billRow)billRow.bill_image=""; return {...row,bill_image:billImage};});})() : [],
  stockReceipts:include("stockReceipts") ? await (async()=>{const f=whereForFilter(filter,"created_at");const rows=db.getAllSync<any>(`SELECT id,inventory_id,batch_id,category_id,category,size,quantity,unit,minimum_stock,added_date,description,created_at,created_by FROM stock_receipts${f.sql} ORDER BY created_at ASC`,f.args);return await mapWithConcurrency(rows, 2, async (row:any)=>{const billRow=db.getFirstSync<any>("SELECT bill_image FROM stock_receipts WHERE id=?",[row.id]);const source=billRow?.bill_image;const billImage=!includeAttachedImages ? "" : typeof source==="string" && /^(data:image\/|file:\/\/|content:\/\/)/i.test(source) ? await embedOptionalPhoto(source,compressedPhotoCache) : source; if(billRow)billRow.bill_image=""; return {...row,bill_image:billImage};});})() : [],
  trash:trashRows,
  branding,
  appSettings,
  patientImageArchives: localPatientArchives.filter((archive:any) => selectedPatientIds.has(String(archive.patientId))).map((archive:any) => ({
    patientId: archive.patientId, patientName: archive.patientName, mrNo: archive.mrNo,
    fileName: archive.fileName, sourceStamp: archive.sourceStamp, archivedAt: archive.archivedAt,
    imageCount: archive.imageCount, driveFileId: archive.driveFileId,
  })),
  photoAssets: includeAttachedImages ? Object.fromEntries(compressedPhotoCache.assets?.entries() || []) : {},
 };
}

export async function exportBackup(password:string, filter: BackupFilter = { type: "all" }, options: { includePatientImages?: boolean } = {}):Promise<string>{
 // Phone/file backups omit patient report photos by default. Inventory bills remain included.
 const backup=await createBackupData(filter, undefined, undefined, undefined, undefined, options.includePatientImages === true);
 backup.filter = filter;
 const salt=await Crypto.getRandomBytesAsync(16);
 const nonce=await Crypto.getRandomBytesAsync(nacl.secretbox.nonceLength);
 const key=await deriveKey(password,salt);
 const ciphertext=nacl.secretbox(stringToBytes(JSON.stringify(backup)),nonce,key);
 return JSON.stringify({version:BACKUP_VERSION,app:BACKUP_APP,encrypted:true,algorithm:"XSalsa20-Poly1305",kdf:"SHA-256",createdAt:backup.createdAt,salt:bytesToHex(salt),nonce:bytesToHex(nonce),ciphertext:bytesToBase64(ciphertext),ciphertextEncoding:"base64"} satisfies EncryptedBackup);
}

// Google Drive uses a plain JSON snapshot so automatic backup does not depend on a password.
// Phone/file backups continue using exportBackup() and remain encrypted.
export async function exportUnencryptedBackupData(filter: BackupFilter = { type: "all" }, onProgress?: (stage: string) => void): Promise<BackupData> {
 // Keep the backup as structured data so Drive can serialize it in bounded
 // chunks instead of constructing one potentially oversized JSON string.
 const cache = filter.type === "all" ? await readDeltaCache() : null;
 const backup = await createBackupData(
   filter,
   onProgress,
   undefined,
   cache?.tables?.patients,
   cache?.photoSources,
   false,
 );
 backup.filter = filter;
 return stripDriveOcrText(backup) as BackupData;
}

export async function exportUnencryptedBackup(filter: BackupFilter = { type: "all" }, onProgress?: (stage: string) => void): Promise<string> {
 return JSON.stringify(await exportUnencryptedBackupData(filter, onProgress));
}

// Drive auto-sync keeps a local copy of each successfully uploaded table so
// subsequent backups can contain only locally changed rows and deletion tombstones,
// even if another device has advanced the shared master file. The cache is promoted
// only after Google Drive confirms the merged upload.
const DELTA_CACHE_PATH = (LegacyFileSystem.documentDirectory || LegacyFileSystem.cacheDirectory || "") + "ortho-drive-delta-cache-v1.json";
let pendingDeltaCacheText: string | null = null;

type DriveDeltaCache = { baselineKey: string; tables: Record<string, any>; photoSources?: Record<string, string> };

async function readDeltaCache(): Promise<DriveDeltaCache | null> {
 try {
  if (!DELTA_CACHE_PATH) return null;
  const info = await LegacyFileSystem.getInfoAsync(DELTA_CACHE_PATH);
  if (!info.exists) return null;
  const parsed = JSON.parse(await LegacyFileSystem.readAsStringAsync(DELTA_CACHE_PATH));
  if (!parsed || typeof parsed.baselineKey !== "string" || !parsed.tables || typeof parsed.tables !== "object") return null;
  return parsed;
 } catch { return null; }
}

/** True only when the compact local comparison cache belongs to this Drive master. */
export async function hasIncrementalSnapshotCacheForBaseline(baselineKey: string): Promise<boolean> {
 const cache = await readDeltaCache();
 return !!cache && !!baselineKey && cache.baselineKey === baselineKey &&
   !!cache.tables && typeof cache.tables === "object";
}

export async function commitIncrementalSnapshotCache(baselineKey?: string): Promise<void> {
 if (!DELTA_CACHE_PATH) return;
 let textToSave = pendingDeltaCacheText;
 try {
  if (!textToSave) {
   const existing = await readDeltaCache();
   if (!existing) return;
   textToSave = JSON.stringify(existing);
  }
  // When a new full all-time snapshot is uploaded, the row cache now describes
  // that exact baseline. Rebase it so the next edit is diffed against the new
  // full file instead of resending every table.
  if (baselineKey) {
   const parsed = JSON.parse(textToSave);
   parsed.baselineKey = baselineKey;
   textToSave = JSON.stringify(parsed);
  }
  await LegacyFileSystem.writeAsStringAsync(DELTA_CACHE_PATH, textToSave);
  pendingDeltaCacheText = null;
 } catch (error) {
  // Cache failure is not a backup failure. The next sync safely falls back
  // to a complete table snapshot instead of risking omissions.
  console.warn("[drive-auto-backup] snapshot cache could not be saved", error);
  pendingDeltaCacheText = null;
 }
}

function rowKey(row: any): string | null {
 return row && row.id !== undefined && row.id !== null && String(row.id) !== "" ? String(row.id) : null;
}

// Keep original photo bytes out of the local comparison cache. Hash source strings
// in-place instead of JSON-stringifying potentially huge base64 data URIs.
function photoSourceSignature(row: any): string {
 const values = [String(row?.photo_uri || ""), String(row?.photos_json || "")];
 let h1 = 0x811c9dc5;
 let h2 = 0x9e3779b9;
 let total = 0;
 for (let field = 0; field < values.length; field++) {
  const value = values[field];
  total += value.length;
  // Avoid synchronously scanning every character of large base64 photos. This
  // check runs after photo preparation and previously froze navigation at 57/57.
  const sampleLimit = 4096;
  const step = Math.max(1, Math.ceil(value.length / sampleLimit));
  const addCode = (code: number) => {
   h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
   h2 = Math.imul(h2 ^ (code + field + 1), 0x85ebca6b) >>> 0;
  };
  addCode(value.length & 0xffff);
  addCode((value.length >>> 16) & 0xffff);
  if (value.length <= sampleLimit) {
   for (let i = 0; i < value.length; i++) addCode(value.charCodeAt(i));
  } else {
   for (let i = 0; i < value.length; i += step) addCode(value.charCodeAt(i));
   for (let i = Math.max(0, value.length - 64); i < value.length; i++) addCode(value.charCodeAt(i));
  }
  h1 = Math.imul(h1 ^ 0xff, 0x01000193) >>> 0;
  h2 = Math.imul(h2 ^ 0x9d, 0xc2b2ae35) >>> 0;
 }
 return total + ":" + h1.toString(16) + ":" + h2.toString(16);
}

function stripPatientPhotoPayload(row: any): any {
 const { photo_uri: _photoUri, photos_json: _photosJson, ...metadata } = row || {};
 return metadata;
}

// Strip patient photo fields recursively, but retain inventory bills/documents.
// Remove legacy embedded image payloads inside SQLite, not after JSON.parse in
// JavaScript. Older backups can nest photo fields at arbitrary depths; parsing
// an unfiltered multi-megabyte snapshot can exhaust Hermes' JavaScript heap.
function readJsonColumnWithoutPhotoPayload(
  table: "patients" | "patient_history",
  column: "custom_data_json" | "snapshot_json",
  rowId: string,
): string {
  const allowedColumn = table === "patients" ? "custom_data_json" : "snapshot_json";
  if (column !== allowedColumn || !rowId) return "{}";
  const jsonExpr = "CASE WHEN json_valid(source." + column + ") THEN source." + column + " ELSE '{}' END";
  const pathRows = db.getAllSync<any>(
    "SELECT node.fullkey AS path FROM " + table + " AS source, json_tree(" + jsonExpr + ") AS node " +
    "WHERE source.id=? AND (" +
    "lower(CAST(COALESCE(node.key, '') AS TEXT)) IN (" +
    "'photos','photos_json','photouri','photo_uri','photo','image','images'," +
    "'bill_image','bill_files_json','image_data','imagedata','image_base64'," +
    "'imagebase64','photo_data','photodata','photo_base64','photobase64'," +
    "'photo_url','photourl','patient_photo','patientphoto','patient_photos'," +
    "'patientphotos','patient_images','patientimages','attached_images'," +
    "'attachedimages','scan_images','scanimages') " +
    "OR lower(CAST(COALESCE(node.key, '') AS TEXT)) LIKE '%photo_uri' " +
    "OR lower(CAST(COALESCE(node.key, '') AS TEXT)) LIKE '%photouri' " +
    "OR lower(CAST(COALESCE(node.key, '') AS TEXT)) LIKE '%photo_data' " +
    "OR lower(CAST(COALESCE(node.key, '') AS TEXT)) LIKE '%photodata' " +
    "OR lower(CAST(COALESCE(node.key, '') AS TEXT)) LIKE '%photo_base64' " +
    "OR lower(CAST(COALESCE(node.key, '') AS TEXT)) LIKE '%photobase64' " +
    "OR lower(CAST(COALESCE(node.key, '') AS TEXT)) LIKE '%image_data' " +
    "OR lower(CAST(COALESCE(node.key, '') AS TEXT)) LIKE '%imagedata' " +
    "OR lower(CAST(COALESCE(node.key, '') AS TEXT)) LIKE '%image_base64' " +
    "OR lower(CAST(COALESCE(node.key, '') AS TEXT)) LIKE '%imagebase64' " +
    "OR lower(CAST(COALESCE(node.key, '') AS TEXT)) LIKE '%photos' " +
    "OR lower(CAST(COALESCE(node.key, '') AS TEXT)) LIKE '%images' " +
    "OR (node.type='text' AND lower(substr(CAST(node.value AS TEXT),1,11))='data:image/')" +
    ") ORDER BY length(node.fullkey) ASC",
    [rowId],
  );
  const paths: string[] = [];
  for (const item of pathRows) {
    const path = String(item?.path || "");
    if (!path) continue;
    if (paths.some(parent => path === parent || path.startsWith(parent + ".") || path.startsWith(parent + "["))) continue;
    paths.push(path);
  }
  const placeholders = paths.map(() => "?").join(",");
  const expression = paths.length ? "json_remove(" + column + "," + placeholders + ")" : column;
  const row = db.getFirstSync<any>(
    "SELECT CASE WHEN json_valid(" + column + ") THEN " + expression + " ELSE '{}' END AS safe_json " +
    "FROM " + table + " WHERE id=? LIMIT 1",
    [...paths, rowId],
  );
  return String(row?.safe_json || "{}");
}

function stripPatientPhotosDeep(value: any, key = ""): any {
 if (Array.isArray(value)) return value.map((item) => stripPatientPhotosDeep(item));
 if (!value || typeof value !== "object") {
  if (BACKUP_NESTED_JSON_KEYS.has(key.toLowerCase()) && typeof value === "string") {
   try { return JSON.stringify(stripPatientPhotosDeep(JSON.parse(value))); } catch {}
  }
  return value;
 }
 const output: Record<string, any> = {};
 for (const [childKey, child] of Object.entries(value)) {
  const normalized = childKey.toLowerCase();
  if (normalized === "photo_uri" || normalized === "photouri" || normalized === "photos_json" || normalized === "photos") continue;
  if (BACKUP_NESTED_JSON_KEYS.has(normalized) && typeof child === "string") {
   try { output[childKey] = JSON.stringify(stripPatientPhotosDeep(JSON.parse(child))); continue; } catch {}
  }
  output[childKey] = stripPatientPhotosDeep(child, childKey);
 }
 return output;
}

const BACKUP_IMAGE_KEYS = new Set(["photo_uri", "photouri", "photos_json", "photos", "bill_image", "bill_files_json"]);
const BACKUP_NESTED_JSON_KEYS = new Set(["snapshot_json", "payload_json"]);
const IMAGE_SIGNATURE_TABLES = new Set(["inventory", "inventoryPurchaseReceipts", "stockReceipts", "implantRecords", "patientHistory", "trash"]);

function stripBackupImages(value: any, key = ""): any {
 if (Array.isArray(value)) return value.map((item) => stripBackupImages(item));
 if (!value || typeof value !== "object") {
  if (BACKUP_NESTED_JSON_KEYS.has(key.toLowerCase()) && typeof value === "string") {
   try { return JSON.stringify(stripBackupImages(JSON.parse(value))); } catch {}
  }
  return value;
 }
 const output: Record<string, any> = {};
 for (const [childKey, child] of Object.entries(value)) {
  const normalized = childKey.toLowerCase();
  if (BACKUP_IMAGE_KEYS.has(normalized)) continue;
  if (BACKUP_NESTED_JSON_KEYS.has(normalized) && typeof child === "string") {
   try { output[childKey] = JSON.stringify(stripBackupImages(JSON.parse(child))); continue; } catch {}
  }
  output[childKey] = stripBackupImages(child, childKey);
 }
 return output;
}

// Comparison caches must never re-serialize potentially huge nested JSON columns.
// Their full contents are hashed separately, so cache rows keep only lightweight metadata.
function stripBackupCacheRow(value: any): any {
 if (Array.isArray(value)) return value.map(stripBackupCacheRow);
 if (!value || typeof value !== "object") return value;
 const output: Record<string, any> = {};
 for (const [key, child] of Object.entries(value)) {
  const normalized = key.toLowerCase();
  if (BACKUP_IMAGE_KEYS.has(normalized) || BACKUP_NESTED_JSON_KEYS.has(normalized)) continue;
  output[key] = stripBackupCacheRow(child);
 }
 return output;
}

// Prune orphaned photo assets without parsing history/trash JSON columns that
// may be many megabytes. The asset token uses only safe ASCII characters.
export function pruneBackupPhotoAssets(backup: any): void {
 const assets = backup?.photoAssets;
 if (!assets || typeof assets !== "object" || Array.isArray(assets)) return;
 const used = new Set<string>();
 const referencePattern = /__ORTHO_PHOTO_REF__:[A-Za-z0-9:_-]+/g;
 const visit = (value: any): void => {
  if (typeof value === "string") {
   referencePattern.lastIndex = 0;
   let match: RegExpExecArray | null;
   while ((match = referencePattern.exec(value)) !== null) used.add(match[0]);
   return;
  }
  if (Array.isArray(value)) {
   for (const item of value) visit(item);
   return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
   if (key === "photoAssets") continue;
   visit(child);
  }
 };
 visit(backup);
 const retained: Record<string, string> = {};
 for (const id of used) {
  if (typeof assets[id] !== "string") {
   throw new Error("Backup data is missing a referenced medical image (" + id.slice(0, 64) + "). This backup was not uploaded.");
  }
  retained[id] = assets[id];
 }
 backup.photoAssets = retained;
}

// Hash only media fields for comparison-cache entries. Image bytes stay in the
// real Drive backup but are never copied into the local diff cache.
function rowImageSignature(row: any): string {
 let h1 = 0x811c9dc5;
 let h2 = 0x9e3779b9;
 let total = 0;
 let found = false;
 const add = (text: string) => {
  found = true;
  total += text.length;
  // Medical photos can be several megabytes encoded as base64. Walking every
  // character of every image (and nested trash/history snapshot) on each sync
  // blocks the JS thread and makes the backup spinner appear frozen. Hash a
  // bounded, evenly distributed sample plus the exact length instead. This is
  // only a change detector; the actual full image data is still uploaded.
  const sampleLimit = 4096;
  const step = Math.max(1, Math.ceil(text.length / sampleLimit));
  const addCode = (code: number) => {
   h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
   h2 = Math.imul(h2 ^ (code + 1), 0x85ebca6b) >>> 0;
  };
  addCode(text.length & 0xffff);
  addCode((text.length >>> 16) & 0xffff);
  if (text.length <= sampleLimit) {
   for (let i = 0; i < text.length; i++) addCode(text.charCodeAt(i));
  } else {
   // Include the beginning and end, then sample throughout the complete value.
   for (let i = 0; i < text.length; i += step) addCode(text.charCodeAt(i));
   for (let i = Math.max(0, text.length - 64); i < text.length; i++) addCode(text.charCodeAt(i));
  }
  h1 = Math.imul(h1 ^ 0xff, 0x01000193) >>> 0;
  h2 = Math.imul(h2 ^ 0x9d, 0xc2b2ae35) >>> 0;
 };
 const addImageValue = (value: any): void => {
  if (typeof value === "string") { add(value); return; }
  if (Array.isArray(value)) { add("["); for (const item of value) addImageValue(item); add("]"); return; }
  if (value && typeof value === "object") {
   for (const key of Object.keys(value).sort()) { add(key); addImageValue(value[key]); }
  }
 };
 const visit = (value: any, key = ""): void => {
  const normalized = key.toLowerCase();
  if (BACKUP_IMAGE_KEYS.has(normalized)) {
   if (value === null || value === undefined || value === "") return;
   add(normalized);
   addImageValue(value);
   return;
  }
  if (BACKUP_NESTED_JSON_KEYS.has(normalized) && typeof value === "string") {
   // Hash original nested JSON as-is; parsing and re-stringifying huge
   // trash/history payloads can exceed the JS/native string limit.
   add(normalized);
   add(value);
   return;
  }
  if (Array.isArray(value)) { for (const item of value) visit(item); return; }
  if (value && typeof value === "object") {
   for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
  }
 };
 visit(row);
 return found ? total + ":" + h1.toString(16) + ":" + h2.toString(16) : "";
}

export async function exportIncrementalBackupData(changedTables: string[], onProgress?: (stage: string) => void, baselineKey = "", incrementalHistorySince = "", incrementalHistoryExcludedIds: string[] = []): Promise<BackupData> {
 const allowed = new Set([
  "patients","procedures","inventoryCategories","inventory","patientImplants",
  "patientCustomFields","implantRecords","expenses","users","patientHistory",
  "inventoryMovements","inventoryPurchaseReceipts","stockReceipts","trash","branding","appSettings"
 ]);
 const requestedTables = Array.from(new Set(changedTables)).filter((name) => allowed.has(name));
 if (!requestedTables.length) throw new Error("There are no changed data tables to sync.");
 const previous = await readDeltaCache();
 // A cache from another Drive file/version cannot safely produce deletion
 // tombstones. After reinstall or master replacement, fall back to append-only
 // rows; the journal applies these without deleting master-only records.
 const canDiff = !!previous && (!baselineKey || previous.baselineKey === baselineKey);
 const cachedHistoryIds = canDiff && Array.isArray(previous?.tables?.patientHistory)
   ? previous!.tables.patientHistory.map((row: any) => String(row?.id || "")).filter(Boolean)
   : [];
 const effectiveHistoryExcludedIds = Array.from(new Set([
   ...incrementalHistoryExcludedIds.map(String).filter(Boolean),
   ...cachedHistoryIds,
 ]));
 const cachedPatientPhotos = canDiff && Object.keys(previous?.photoSources || {}).some((key) => !key.startsWith("images:"));
 const cachedHistoryPhotos = canDiff && Object.keys(previous?.photoSources || {}).some((key) => key.startsWith("images:patientHistory:"));
 const tables = Array.from(new Set([
   ...requestedTables,
   ...(cachedPatientPhotos ? ["patients"] : []),
   ...(cachedHistoryPhotos ? ["patientHistory"] : []),
 ])).filter((name) => allowed.has(name));
 const backup = await createBackupData(
  { type: "all" }, onProgress, tables,
  canDiff ? previous!.tables.patients : undefined,
  canDiff && previous!.photoSources ? previous!.photoSources : undefined,
  false,
  true,
  incrementalHistorySince,
  effectiveHistoryExcludedIds
 );
 // Sanitize before diff/cache generation too, so OCR text is not re-saved in the Drive baseline.
 const sanitizedBackup = stripDriveOcrText(backup) as BackupData;
 Object.keys(backup).forEach((key) => delete (backup as any)[key]);
 Object.assign(backup, sanitizedBackup);

 const nextTables: Record<string, any> = canDiff ? { ...previous!.tables } : {};
 const nextPhotoSources: Record<string, string> = canDiff && previous!.photoSources ? { ...previous!.photoSources } : {};
 const deletedIds: Record<string, string[]> = {};
 const fullTables: string[] = [];
 const currentRowsForCache: Record<string, any[]> = {};
 if (canDiff) {
  // Older app versions kept embedded bill photos in this comparison cache. Strip
  // those bytes during migration before the cache is serialized again.
  for (const table of Object.keys(nextTables)) {
   const rows = nextTables[table];
   if (Array.isArray(rows)) {
    if (IMAGE_SIGNATURE_TABLES.has(table)) {
     for (const row of rows) {
      const id = rowKey(row);
      if (id === null) continue;
      const signatureKey = "images:" + table + ":" + id;
      if (nextPhotoSources[signatureKey] === undefined) {
       const signature = rowImageSignature(row);
       if (signature) nextPhotoSources[signatureKey] = signature;
      }
     }
    }
    nextTables[table] = rows.map((row) => stripBackupCacheRow(row));
   } else {
    nextTables[table] = stripBackupCacheRow(rows);
   }
  }
 }
 for (const table of tables) {
  if (table === "branding" || table === "appSettings") {
   nextTables[table] = (backup as any)[table] ?? null;
   // Settings are compared with the last confirmed cache below; app launch/navigation is not a change.
   continue;
  }
  const currentRows = Array.isArray((backup as any)[table]) ? (backup as any)[table] as any[] : [];
  currentRowsForCache[table] = currentRows;

  // Patient history is append-only and incremental exports query only rows
  // after the last journal/master baseline. Never compare that bounded set
  // with an old full-table cache, or older history rows would look deleted.
  if (table === "patientHistory" && incrementalHistorySince) {
   (backup as any)[table] = currentRows;
   deletedIds[table] = [];
   // Retain every history ID already seen since this master baseline. New
   // audit rows are appended, but prior IDs are not reread/re-uploaded on each
   // save. Values in the comparison cache are stripped of image payloads.
   const knownHistory = new Map<string, any>();
   for (const row of Array.isArray(nextTables.patientHistory) ? nextTables.patientHistory : []) {
    const historyId = rowKey(row);
    if (historyId !== null) knownHistory.set(historyId, row);
   }
   // On a reinstall, seed the local cache with IDs recovered from daily Drive
   // journals, even when the corresponding snapshot is not returned to JS.
   for (const historyId of effectiveHistoryExcludedIds) {
    if (!knownHistory.has(historyId)) knownHistory.set(historyId, { id: historyId });
   }
   for (const row of currentRows) {
    const historyId = rowKey(row);
    if (historyId !== null) knownHistory.set(historyId, stripBackupCacheRow(row));
   }
   nextTables[table] = Array.from(knownHistory.values());
   continue;
  }
   const currentImageSignatures = new Map<string, string>();
   if (IMAGE_SIGNATURE_TABLES.has(table)) {
    for (const row of currentRows) {
     const id = rowKey(row);
     if (id !== null) currentImageSignatures.set(id, rowImageSignature(row));
    }
   }

  const previousRows = canDiff && Array.isArray(nextTables[table]) ? nextTables[table] : null;
  if (!previousRows) {
   // First sync for this table, or a changed full-backup baseline: use a
   // complete table snapshot. This is slower once but remains restorable.
   nextTables[table] = currentRows.map((row) => stripBackupCacheRow(row));
   if (canDiff) fullTables.push(table);
   continue;
  }
  const oldById = new Map<string, any>();
  const newById = new Map<string, any>();
  for (const row of previousRows) { const id = rowKey(row); if (id !== null) oldById.set(id, row); }
  for (const row of currentRows) { const id = rowKey(row); if (id !== null) newById.set(id, row); }
   // Patient images are archived separately as PDFs, not in the master JSON.
   const currentPhotoSignatures: Record<string, string> = {};

  const changedRows = currentRows.filter((row) => {
   const id = rowKey(row);
   if (id === null) return true;
   const old = oldById.get(id);
   const comparableRow = stripBackupCacheRow(row);
   const metadataChanged = !old || JSON.stringify(old) !== JSON.stringify(comparableRow);
   const patientPhotosChanged = table === "patients" && (!previous!.photoSources || previous!.photoSources[id] !== currentPhotoSignatures[id]);
   const currentImageSignature = currentImageSignatures.get(id) || "";
   const previousImageSignature = previous!.photoSources?.["images:" + table + ":" + id];
   const rowImagesChanged = IMAGE_SIGNATURE_TABLES.has(table) &&
     (currentImageSignature !== "" || previousImageSignature !== undefined) &&
     currentImageSignature !== previousImageSignature;
   return metadataChanged || patientPhotosChanged || rowImagesChanged;
  });
  deletedIds[table] = Array.from(oldById.keys()).filter((id) => !newById.has(id));
  (backup as any)[table] = changedRows.map((row) => {
   const id = String(row.id ?? "");
   const old = oldById.get(id);
   if (table === "patients") {
    const oldPhotoSignature = previous!.photoSources?.[id];
    if (old && oldPhotoSignature && oldPhotoSignature === currentPhotoSignatures[id]) {
     // Patient metadata changed but the image source did not. Keep the original
     // photo in the master and omit its bytes from this delta.
     return stripBackupImages(row);
    }
   } else if (IMAGE_SIGNATURE_TABLES.has(table)) {
    const oldImageSignature = previous!.photoSources?.["images:" + table + ":" + id];
    const currentImageSignature = currentImageSignatures.get(id) || "";
    if (old && oldImageSignature === currentImageSignature) return stripBackupImages(row);
   }
   return row;
  });
  // Keep cache records lightweight: the Drive payload retains media, while this
  // local comparison cache retains only metadata plus media signatures.
  nextTables[table] = currentRows.map((row) => stripBackupCacheRow(row));
 }
 const effectiveTables = tables.filter((table) => {
  if (table === "branding" || table === "appSettings") {
   const currentValue = (backup as any)[table] ?? null;
   const previousValue = canDiff ? previous!.tables[table] : undefined;
   return !canDiff || JSON.stringify(previousValue) !== JSON.stringify(currentValue);
  }
  const rows = Array.isArray((backup as any)[table]) ? (backup as any)[table] : [];
  const hasDeletes = Array.isArray(deletedIds[table]) && deletedIds[table].length > 0;
  return !canDiff || fullTables.includes(table) || rows.length > 0 || hasDeletes;
 });
 backup.filter = { type: "all" };
 backup.incremental = true;
 backup.changedTables = effectiveTables;
 (backup as any)._rowDelta = canDiff;
 (backup as any).deletedIds = canDiff ? deletedIds : {};
 (backup as any).fullTables = canDiff ? fullTables : effectiveTables.filter((table) => table !== "branding" && table !== "appSettings");
 // Track the source URIs separately from portable compressed photo bytes. This
 // lets future backups reuse unchanged photo payloads without recompressing them.
 for (const table of tables) {
  if (!IMAGE_SIGNATURE_TABLES.has(table)) continue;
  const prefix = "images:" + table + ":";
  for (const key of Object.keys(nextPhotoSources)) if (key.startsWith(prefix)) delete nextPhotoSources[key];
   for (const row of currentRowsForCache[table] || []) {
    const id = rowKey(row);
    if (id === null) continue;
    const signature = rowImageSignature(row);
    if (signature) nextPhotoSources[prefix + id] = signature;
   }
  }

  if (tables.includes("patients")) {
   for (const key of Object.keys(nextPhotoSources)) {
    if (!key.startsWith("images:")) delete nextPhotoSources[key];
   }
  }

 // Changed rows can omit unchanged photos. Keep only assets referenced by this delta.
 pruneBackupPhotoAssets(backup);
 // Do not persist the new baseline until the upload succeeds.
 pendingDeltaCacheText = JSON.stringify({ baselineKey, tables: nextTables, photoSources: nextPhotoSources });
 return backup;
}

export async function exportIncrementalBackup(changedTables: string[], onProgress?: (stage: string) => void, baselineKey = "", incrementalHistorySince = "", incrementalHistoryExcludedIds: string[] = []): Promise<string> {
 return JSON.stringify(await exportIncrementalBackupData(changedTables, onProgress, baselineKey, incrementalHistorySince, incrementalHistoryExcludedIds));
}

export async function prepareIncrementalSnapshotCacheFromBackupData(baselineKey: string, backup: BackupData): Promise<void> {
 const tableNames = [
  "patients", "procedures", "inventoryCategories", "inventory", "patientImplants",
  "patientCustomFields", "implantRecords", "expenses", "users", "patientHistory",
  "inventoryMovements", "inventoryPurchaseReceipts", "stockReceipts", "trash",
 ];
 const tables: Record<string, any> = {};
 const photoSources: Record<string, string> = {};
 for (const table of tableNames) {
  const rows = Array.isArray((backup as any)[table]) ? (backup as any)[table] as any[] : [];
  tables[table] = rows.map((row) => stripBackupCacheRow(row));
   if (table === "patients") {
    // Patient photos are maintained as separate PDFs, not cached JSON signatures.
   } else if (IMAGE_SIGNATURE_TABLES.has(table)) {
    for (const row of rows) {
     const id = rowKey(row);
     if (id === null) continue;
     const signature = rowImageSignature(row);
     if (signature) photoSources["images:" + table + ":" + id] = signature;
    }
   }
 }
 tables.branding = (backup as any).branding ?? null;
 tables.appSettings = (backup as any).appSettings ?? null;
 pendingDeltaCacheText = JSON.stringify({ baselineKey, tables, photoSources });
}

function parseHeader(text:string):any{
 let b:any;try{b=JSON.parse(text);}catch{throw new Error("The selected backup file is not valid.");}
 if(!b||![2,3,4,5,6,7,8,9,10,11].includes(b.version)||b.app!==BACKUP_APP)throw new Error("Invalid or unsupported Ortho Logbook backup.");
 if(b.encrypted===true){
  if(b.algorithm!=="XSalsa20-Poly1305"||b.kdf!=="SHA-256"||!b.createdAt||!b.salt||!b.nonce||!b.ciphertext)throw new Error("The backup file is incomplete or damaged.");
 } else if(!Array.isArray(b.patients)||!Array.isArray(b.inventory)||!Array.isArray(b.users)){
  throw new Error("The unencrypted backup is incomplete or damaged.");
 }
 return b;
}
export function getBackupInfo(text:string){const b=parseHeader(text);return {createdAt:b.createdAt||new Date().toISOString(),encrypted:b.encrypted===true,version:b.version,includesPhotos:b.version>=3};}

export async function decryptBackup(text:string,password:string):Promise<BackupData>{
 const b=parseHeader(text);
 if(b.encrypted!==true){
  const data=b as BackupData;
  for(const keyName of ["patients","procedures","inventory","expenses","users","patientHistory","inventoryMovements"]){
   if(!Array.isArray((data as any)[keyName]))throw new Error("The backup is incomplete or damaged.");
  }
  data.inventoryCategories=Array.isArray((data as any).inventoryCategories)?data.inventoryCategories:[];
  data.patientImplants=Array.isArray((data as any).patientImplants)?data.patientImplants:[];
  data.stockReceipts=Array.isArray((data as any).stockReceipts)?data.stockReceipts:[];
  data.inventoryPurchaseReceipts=Array.isArray((data as any).inventoryPurchaseReceipts)?data.inventoryPurchaseReceipts:[];
  data.patientCustomFields=Array.isArray((data as any).patientCustomFields)?data.patientCustomFields:[];
  data.implantRecords=Array.isArray((data as any).implantRecords)?data.implantRecords:[];
  data.trash=Array.isArray((data as any).trash)?data.trash:[];
  return data;
 }
 try{
  const key=await deriveKey(password,hexToBytes(b.salt));
  const cipherBytes=b.ciphertextEncoding === "base64" ? base64ToBytes(b.ciphertext) : hexToBytes(b.ciphertext);
  const plain=nacl.secretbox.open(cipherBytes,hexToBytes(b.nonce),key);
  if(!plain)throw new Error("Incorrect backup password or damaged backup.");
  const data=JSON.parse(bytesToString(plain)) as BackupData;
  if(!data||![2,3,4,5,6,7,8,9,10,11].includes(data.version)||data.app!==BACKUP_APP)throw new Error("The decrypted backup is invalid.");
  for(const keyName of ["patients","procedures","inventory","expenses","users","patientHistory","inventoryMovements"]){
    if(!Array.isArray((data as any)[keyName]))throw new Error("The backup is incomplete or damaged.");
  }
  // v2/v3 backups did not contain these relational inventory tables.
  data.inventoryCategories=Array.isArray((data as any).inventoryCategories) ? (data as any).inventoryCategories : [];
  data.patientImplants=Array.isArray((data as any).patientImplants) ? (data as any).patientImplants : [];
  data.stockReceipts=Array.isArray((data as any).stockReceipts) ? (data as any).stockReceipts : [];
  data.trash=Array.isArray((data as any).trash) ? (data as any).trash : [];
  return data;
 }catch(e){if(e instanceof Error&&e.message.includes("Incorrect backup password"))throw e;throw new Error("Unable to decrypt backup. Check the password and backup file.");}
}

function restorePatientPhotos(p:any){
  // v3 contains data:image/...;base64,... strings, which work directly with
  // React Native Image and therefore survive moving the backup to another phone.
  // v2 is still accepted for backward compatibility.
  const photosJson = p.photos_json ?? null;
  let photos:string[]=[];
  if(Array.isArray(photosJson)) {
    photos = photosJson.filter((x:any)=>typeof x==="string"&&x.length>0);
  } else if(photosJson) {
    try{const parsed=JSON.parse(String(photosJson));if(Array.isArray(parsed))photos=parsed.filter((x)=>typeof x==="string"&&x.length>0);}catch{}
  }
  const primary=photos[0]||p.photo_uri||"";
  // Portable data URIs are already stored in photos_json. Do not duplicate
  // the first base64 photo into photo_uri; this can nearly double database size.
  const photoUri=primary.startsWith("data:") ? "" : primary;
  return {photoUri,photosJson:photos.length?JSON.stringify(photos):null};
}

// Phone backups are intentionally data-only: patient images belong in the
// separate patient-image PDFs. Older .orbackup files may still contain a large
// photoAssets map. Do not expand those assets into every patient/history row
// during restore; that multiplies memory use and can crash Android on next launch.
function materializeBackupPhotoReferences(backup: BackupData): BackupData {
 const stripPhotoFields = (value: any): any => {
  if (Array.isArray(value)) return value.map(stripPhotoFields);
  if (!value || typeof value !== "object") return value;
  for (const key of Object.keys(value)) {
   const normalized = key.toLowerCase();
   if (["photo_uri", "photouri", "photos_json", "photos", "photoassets"].includes(normalized)) {
    if (normalized === "photos" && Array.isArray(value[key])) value[key] = [];
    else value[key] = normalized === "photos_json" ? "" : "";
    continue;
   }
   if (normalized === "snapshot_json" || normalized === "payload_json" || normalized === "custom_data_json") {
    const raw = value[key];
    if (typeof raw === "string" && raw.length) {
     try { value[key] = JSON.stringify(stripPhotoFields(JSON.parse(raw))); } catch {}
    } else if (raw && typeof raw === "object") value[key] = stripPhotoFields(raw);
    continue;
   }
   value[key] = stripPhotoFields(value[key]);
  }
  return value;
 };
 // Remove photo payloads before database insertion. Keep patient image archive
 // metadata so the separately stored PDF workflow continues to work.
 const sanitized = stripPhotoFields(backup) as BackupData;
 delete sanitized.photoAssets;
 return sanitized;
}
function restoreRowId(value:any, prefix:string, used:Set<string>){
  const raw=String(value||"").trim();
  if(raw && !used.has(raw)){ used.add(raw); return raw; }
  let next="";
  do { next=prefix+"-"+Crypto.randomUUID(); } while(used.has(next));
  used.add(next);
  return next;
}
function restoreArray(value:any){return Array.isArray(value)?value:[];}
function restoreText(value:any,fallback=""){const v=String(value ?? "").trim();return v || fallback;}
function restoreReal(value:any,fallback=0,min=-Infinity){const n=typeof value==="number" ? value : Number(String(value ?? "").replace(/,/g,"").trim());if(!Number.isFinite(n)) return fallback;return Math.max(min,n);}
function restoreJsonObject(value:any){try{const parsed=JSON.parse(String(value ?? "{}"));return parsed && typeof parsed==="object" && !Array.isArray(parsed) ? JSON.stringify(parsed) : "{}";}catch{return "{}";}}
function restoreJsonArray(value:any){try{const parsed=JSON.parse(String(value ?? "[]"));return Array.isArray(parsed) ? JSON.stringify(parsed) : "[]";}catch{return "[]";}}

export async function restoreBackup(backup:BackupData){
 initializeDatabase({ skipInventoryReset: true });
 if(!backup||![2,3,4,5,6,7,8,9,10,11].includes(backup.version)||backup.app!==BACKUP_APP)throw new Error("Invalid Ortho Logbook backup.");
 backup = materializeBackupPhotoReferences(backup);
 const patients=restoreArray((backup as any).patients);
 const procedures=restoreArray((backup as any).procedures);
 const inventoryCategories=restoreArray((backup as any).inventoryCategories);
 const inventory=restoreArray((backup as any).inventory);
 const patientImplants=restoreArray((backup as any).patientImplants);
 const patientCustomFields=restoreArray((backup as any).patientCustomFields);
 const implantRecords=restoreArray((backup as any).implantRecords);
 const expenses=restoreArray((backup as any).expenses);
 const users=restoreArray((backup as any).users);
 const patientHistory=restoreArray((backup as any).patientHistory);
 const inventoryMovements=restoreArray((backup as any).inventoryMovements);
 const inventoryPurchaseReceipts=restoreArray((backup as any).inventoryPurchaseReceipts);
 const stockReceipts=restoreArray((backup as any).stockReceipts);
 const trash=restoreArray((backup as any).trash);
 db.withTransactionSync(()=>{
  db.runSync("DELETE FROM inventory_movements"); db.runSync("DELETE FROM inventory_purchase_receipts"); db.runSync("DELETE FROM stock_receipts"); db.runSync("DELETE FROM patient_implants"); db.runSync("DELETE FROM patient_history"); db.runSync("DELETE FROM expenses"); db.runSync("DELETE FROM patients"); db.runSync("DELETE FROM patient_custom_fields"); db.runSync("DELETE FROM implant_records"); db.runSync("DELETE FROM procedures"); db.runSync("DELETE FROM inventory"); db.runSync("DELETE FROM inventory_categories"); db.runSync("DELETE FROM users"); db.runSync("DELETE FROM deleted_records");
  const usedPatientIds=new Set<string>();
  const patientIdMap=new Map<string,string>();
  for(const p of patients){
   const photos=restorePatientPhotos(p);
   const restoredPatientId=restoreRowId(p.id,"patient",usedPatientIds);
   if(p.id) patientIdMap.set(String(p.id),restoredPatientId);
   const patientDate=restoreText(p.date,new Date().toISOString().slice(0,10));
   const patientCreatedAt=restoreText(p.created_at,new Date().toISOString());
   db.runSync("INSERT INTO patients (id,mr_no,name,gender,age,diagnosis,procedure,procedure_ii,implant,implant_ii,implant_id,implant_ii_id,address,file_name,photo_uri,photos_json,custom_data_json,date,created_at,created_by,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",[restoredPatientId,restoreText(p.mr_no),restoreText(p.name,"Unnamed patient"),restoreText(p.gender),restoreText(p.age),restoreText(p.diagnosis),restoreText(p.procedure),restoreText(p.procedure_ii),restoreText(p.implant),restoreText(p.implant_ii),restoreText(p.implant_id)||null,restoreText(p.implant_ii_id)||null,restoreText(p.address),restoreText(p.file_name),photos.photoUri,photos.photosJson,restoreJsonObject(p.custom_data_json),patientDate,patientCreatedAt,restoreText(p.created_by)||null,restoreText(p.updated_at)||null,restoreText(p.updated_by)||null]);
  }
  const usedProcedureIds=new Set<string>();
  const usedProcedureNames=new Set<string>();
  for(const p of procedures){
    const name=restoreText(p.name,"Unnamed procedure");
    const key=name.toLowerCase();
    if(usedProcedureNames.has(key)) continue;
    usedProcedureNames.add(key);
    db.runSync("INSERT INTO procedures (id,name) VALUES (?,?)",[restoreRowId(p.id,"procedure",usedProcedureIds),name]);
  }
  const usedCustomFieldIds=new Set<string>();
  const usedCustomFieldKeys=new Set<string>();
  for(const f of patientCustomFields){
    const key=restoreText(f.key,"field-"+Crypto.randomUUID().slice(0,8));
    const keyLower=key.toLowerCase();
    if(usedCustomFieldKeys.has(keyLower)) continue;
    usedCustomFieldKeys.add(keyLower);
    const type=["text","number","date","multiline"].includes(String(f.type)) ? String(f.type) : "text";
    const createdAt=restoreText(f.created_at,new Date().toISOString());
    const updatedAt=restoreText(f.updated_at,createdAt);
    db.runSync("INSERT OR REPLACE INTO patient_custom_fields (id,key,label,type,sort_order,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",[restoreRowId(f.id,"custom-field",usedCustomFieldIds),key,restoreText(f.label,"Custom field"),type,Math.trunc(restoreReal(f.sort_order,0)),restoreReal(f.enabled,1,0)>0?1:0,createdAt,updatedAt]);
  }
  const categoryIds=new Map<string,string>();
  const categoryIdsBySourceId=new Map<string,string>();
  const usedCategoryIds=new Set<string>();
  for(const c of inventoryCategories){
    const name=restoreText(c.name,"Unnamed category");
    const nameKey=name.toLowerCase();
    // Category IDs may be regenerated during restore. Keep both the original
    // ID mapping and the case-insensitive name mapping for every source row.
    let cid=categoryIds.get(nameKey);
    if(!cid){
      cid=restoreRowId(c.id,"category",usedCategoryIds);
      db.runSync("INSERT INTO inventory_categories (id,name,created_at) VALUES (?,?,?)",[cid,name,restoreText(c.created_at,new Date().toISOString())]);
      categoryIds.set(nameKey,cid);
    }
    if(c.id!==undefined && c.id!==null && String(c.id)) categoryIdsBySourceId.set(String(c.id),cid);
  }
  const usedInventoryIds=new Set<string>();
  const inventoryIdMap=new Map<string,string>();
  for(const i of inventory){
    const categoryName=restoreText(i.category);
    const categoryKey=categoryName.toLowerCase();
    // Prefer the portable category name over a source-phone ID that may point to another category after restore.
    let cid=categoryIds.get(categoryKey)||categoryIdsBySourceId.get(String(i.category_id||""))||null;
    if(!cid && categoryName){
      // Older backups may omit the category table or contain stale IDs. Reuse
      // the existing category by name before creating a new one.
      const existingCategory=db.getFirstSync<any>("SELECT id FROM inventory_categories WHERE LOWER(TRIM(name))=LOWER(?) LIMIT 1",[categoryName]);
      cid=existingCategory?.id||null;
      if(!cid){
        cid=Math.random().toString(36).slice(2)+Date.now().toString(36);
        db.runSync("INSERT INTO inventory_categories (id,name,created_at) VALUES (?,?,?)",[cid,categoryName,new Date().toISOString()]);
      }
      categoryIds.set(categoryKey,cid);
    }
    const restoredInventoryId=restoreRowId(i.id,"inventory",usedInventoryIds);
    if(i.id) inventoryIdMap.set(String(i.id),restoredInventoryId);
    const itemName=restoreText(i.name,"Unnamed item");
    const itemCategory=restoreText(i.category);
    const itemSize=restoreText(i.size);
    db.runSync("INSERT INTO inventory (id,name,category_id,category,size,quantity,unit,minimum_stock,added_date,bill_image,low_stock_triggered_at,low_stock_since) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",[restoredInventoryId,itemName,cid,itemCategory,itemSize,restoreReal(i.quantity,0,0),restoreText(i.unit,"pcs"),restoreReal(i.minimum_stock,0,0),restoreText(i.added_date)||null,restoreText(i.bill_image)||null,restoreText(i.low_stock_triggered_at)||null,restoreText(i.low_stock_since)||null]);
  }
  // Restore patient inventory selections without creating duplicate rows.
  // Older backups/restore versions could contain the same patient + implant more
  // than once. Combine identical selections into one row and keep the quantity.
  const usedPatientImplantIds=new Set<string>();
  for(const pi of patientImplants){
    const patientId=String(pi.patient_id||"");
    const inventoryId=String(pi.inventory_id||"");
    const name=String(pi.name||"").trim();
    const category=String(pi.category||"").trim();
    const size=String(pi.size||"").trim();
    const qty=Math.max(1,Number(pi.quantity)||1);
    const mappedPatientId=patientIdMap.get(patientId)||"";
    if(!mappedPatientId) continue;
    const mappedInventoryId=inventoryId ? (inventoryIdMap.get(inventoryId)||"") : "";
    const existing=db.getFirstSync<any>(
      "SELECT id,quantity FROM patient_implants WHERE patient_id=? AND COALESCE(inventory_id,'')=? AND LOWER(TRIM(COALESCE(name,'')))=LOWER(?) AND LOWER(TRIM(COALESCE(category,'')))=LOWER(?) AND LOWER(TRIM(COALESCE(size,'')))=LOWER(?) LIMIT 1",
      [mappedPatientId,mappedInventoryId,name,category,size]
    );
    if(existing){
      db.runSync("UPDATE patient_implants SET quantity=? WHERE id=?",[Number(existing.quantity||0)+qty,existing.id]);
      continue;
    }
    if(!name) continue;
    db.runSync("INSERT INTO patient_implants (id,patient_id,inventory_id,name,category,size,quantity,created_at) VALUES (?,?,?,?,?,?,?,?)",[restoreRowId(pi.id,"patient-implant",usedPatientImplantIds),mappedPatientId,mappedInventoryId||null,name,restoreText(pi.category)||null,restoreText(pi.size)||null,restoreReal(pi.quantity,1,1),restoreText(pi.created_at,new Date().toISOString())]);
  }
  const usedImplantRecordIds=new Set<string>();
  for(const rec of implantRecords){
    const recName=restoreText(rec.name,"Unnamed implant");
    const createdAt=restoreText(rec.created_at,new Date().toISOString());
    db.runSync("INSERT INTO implant_records (id,name,category,size,manufacturer,model,lot_number,serial_number,expiry_date,supplier,quantity,unit,purchase_price,notes,bill_files_json,created_at,updated_at,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [restoreRowId(rec.id,"implant-record",usedImplantRecordIds),recName,restoreText(rec.category),restoreText(rec.size),restoreText(rec.manufacturer),restoreText(rec.model),restoreText(rec.lot_number),restoreText(rec.serial_number),restoreText(rec.expiry_date),restoreText(rec.supplier),restoreReal(rec.quantity,0,0),restoreText(rec.unit,"pcs"),restoreReal(rec.purchase_price,0,0),restoreText(rec.notes),restoreJsonArray(rec.bill_files_json),createdAt,restoreText(rec.updated_at,createdAt),restoreText(rec.created_by)||null,restoreText(rec.updated_by)||null]);
  }
  const usedUserIds=new Set<string>();
  const userIdMap=new Map<string,string>();
  const usedUserEmails=new Set<string>();
  for(const u of users) {
    const restoredUserId=restoreRowId(u.id,"user",usedUserIds);
    if(u.id) userIdMap.set(String(u.id),restoredUserId);
    const baseEmail=restoreText(u.email).toLowerCase();
    const email=baseEmail && !usedUserEmails.has(baseEmail) ? baseEmail : ("restored-"+Crypto.randomUUID().slice(0,12)+"@local.invalid");
    usedUserEmails.add(email);
    const role=["admin","doctor","staff"].includes(String(u.role)) ? String(u.role) : "doctor";
    db.runSync("INSERT INTO users (id,email,name,password_hash,recovery_code,role,can_edit_patients,disabled,created_at) VALUES (?,?,?,?,?,?,?,?,?)",[restoredUserId,email,restoreText(u.name,"User"),restoreText(u.password_hash),restoreText(u.recovery_code)||null,role,restoreReal(u.can_edit_patients,1,0)>0?1:0,restoreReal(u.disabled,0,0)>0?1:0,restoreText(u.created_at,new Date().toISOString())]);
  }
  const usedExpenseIds=new Set<string>();
  for(const e of expenses) db.runSync("INSERT INTO expenses (id,description,amount,belongs_to,doctor_id,date,created_at) VALUES (?,?,?,?,?,?,?)",[restoreRowId(e.id,"expense",usedExpenseIds),restoreText(e.description),restoreReal(e.amount,0,0),restoreText(e.belongs_to,"hospital"),userIdMap.get(String(e.doctor_id||""))||null,restoreText(e.date,new Date().toISOString().slice(0,10)),restoreText(e.created_at,new Date().toISOString())]);
  const usedHistoryIds=new Set<string>();
  for(const h of patientHistory){
    const patientId=patientIdMap.get(String(h.patient_id||""));
    if(!patientId) continue;
    db.runSync("INSERT INTO patient_history (id,patient_id,user_id,action,snapshot_json,created_at) VALUES (?,?,?,?,?,?)",[restoreRowId(h.id,"history",usedHistoryIds),patientId,userIdMap.get(String(h.user_id||""))||null,restoreText(h.action,"snapshot"),restoreText(h.snapshot_json,"{}"),restoreText(h.created_at,new Date().toISOString())]);
  }
  const usedReceiptIds=new Set<string>();
  for(const r of inventoryPurchaseReceipts){
    const inventoryId=inventoryIdMap.get(String(r.inventory_id||""));
    if(!inventoryId) continue;
    db.runSync("INSERT INTO inventory_purchase_receipts (id,inventory_id,category_id,category,size,quantity,unit,minimum_stock,added_date,bill_image,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",[restoreRowId(r.id,"receipt",usedReceiptIds),inventoryId,r.category_id||null,restoreText(r.category),restoreText(r.size),restoreReal(r.quantity,0,0),restoreText(r.unit,"pcs"),restoreReal(r.minimum_stock,0,0),restoreText(r.added_date),restoreText(r.bill_image),restoreText(r.created_at,new Date().toISOString()),restoreText(r.created_by)||null]);
  }
  const usedStockReceiptIds=new Set<string>();
  for(const r of stockReceipts){
    const inventoryId=inventoryIdMap.get(String(r.inventory_id||""));
    if(!inventoryId) continue;
    db.runSync("INSERT INTO stock_receipts (id,inventory_id,batch_id,category_id,category,size,quantity,unit,minimum_stock,added_date,bill_image,description,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",[
      restoreRowId(r.id,"stock-receipt",usedStockReceiptIds),
      inventoryId,
      restoreText(r.batch_id)||null,
      r.category_id||null,
      restoreText(r.category),
      restoreText(r.size),
      restoreReal(r.quantity,0,0),
      restoreText(r.unit,"pcs"),
      restoreReal(r.minimum_stock,0,0),
      restoreText(r.added_date)||null,
      restoreText(r.bill_image)||null,
      restoreText(r.description)||null,
      restoreText(r.created_at,new Date().toISOString()),
      restoreText(r.created_by)||null
    ]);
  }
  const usedMovementIds=new Set<string>();
  for(const m of inventoryMovements){
    const inventoryId=inventoryIdMap.get(String(m.inventory_id||""));
    if(!inventoryId) continue;
    db.runSync("INSERT INTO inventory_movements (id,inventory_id,user_id,type,amount,quantity_after,note,created_at) VALUES (?,?,?,?,?,?,?,?)",[restoreRowId(m.id,"movement",usedMovementIds),inventoryId,userIdMap.get(String(m.user_id||""))||null,restoreText(m.type,"adjust"),restoreReal(m.amount,0),restoreReal(m.quantity_after,0,0),restoreText(m.note)||null,restoreText(m.created_at,new Date().toISOString())]);
  }
  const usedTrashIds=new Set<string>();
  for(const t of trash){
    const deletedAt=restoreText(t.deleted_at,new Date().toISOString());
    const expiresAt=restoreText(t.expires_at,new Date(Date.parse(deletedAt)+30*24*60*60*1000).toISOString());
    if(Date.parse(expiresAt)<=Date.now()) continue;
    db.runSync("INSERT OR IGNORE INTO deleted_records (id,kind,title,payload_json,deleted_at,expires_at,deleted_by) VALUES (?,?,?,?,?,?,?)",[
      restoreRowId(t.id,"trash",usedTrashIds),restoreText(t.kind,"deleted-record"),restoreText(t.title,"Deleted item"),
      restoreText(t.payload_json,"{}"),deletedAt,expiresAt,restoreText(t.deleted_by)||null
    ]);
  }
 });
 repairDatabaseData();
 // Verify persisted settings before restore is reported as complete.
 if (backup.version >= 6 && backup.branding === null) {
   if (!(await storage.removeItem("ortho_branding"))) throw new Error("Could not clear saved branding during restore.");
 } else if (backup.version >= 6 && backup.branding && typeof backup.branding === "object") {
   if (!(await storage.setItem("ortho_branding", JSON.stringify(backup.branding)))) throw new Error("Could not save branding during restore.");
   const saved = await storage.getItem<any>("ortho_branding", "");
   let parsed: any = saved;
   if (typeof parsed === "string") { try { parsed = JSON.parse(parsed); } catch {} }
   if (!parsed || typeof parsed !== "object" || JSON.stringify(parsed) !== JSON.stringify(backup.branding)) throw new Error("Branding was not verified after restore. Please retry.");
 }
 if (backup.appSettings && typeof backup.appSettings === "object") {
   const settings = backup.appSettings;
   if (typeof settings.googleOAuthClientId === "string" && settings.googleOAuthClientId.trim()) {
     if (!(await storage.secureSet("ortho_google_drive_client_id", normalizeSecureSetting(settings.googleOAuthClientId)))) throw new Error("Could not save Google OAuth client ID during restore.");
   } else {
     await SecureStore.deleteItemAsync("ortho_google_drive_client_id");
   }
   if (typeof settings.googleCloudProjectId === "string" && settings.googleCloudProjectId.trim()) {
     if (!(await storage.secureSet("ortho_google_drive_cloud_project_id", normalizeSecureSetting(settings.googleCloudProjectId)))) throw new Error("Could not save Google Cloud project ID during restore.");
   } else {
     await SecureStore.deleteItemAsync("ortho_google_drive_cloud_project_id");
   }
   if (typeof settings.googleAccountEmail === "string" && settings.googleAccountEmail.trim()) {
     if (!(await storage.secureSet("ortho_drive_account_email", settings.googleAccountEmail))) throw new Error("Could not save Google account recovery email.");
   } else {
     await storage.secureRemove("ortho_drive_account_email");
   }
 }
 await restoreLabSettings(backup.appSettings);
 await restoreAsyncStorageSettings(backup.appSettings);
  markInventoryResetDone();
 return {patients:patients.length,procedures:procedures.length,inventory:inventory.length,inventoryCategories:inventoryCategories.length,patientImplants:patientImplants.length,expenses:expenses.length,users:users.length,patientHistory:patientHistory.length,inventoryMovements:inventoryMovements.length};
}

// Merge mode: add records from an incoming backup without wiping current data.
// - Rows with the same primary-key id are always skipped, making repeated
//   imports of the same backup idempotent.
// - Inventory items from a different source phone can still be combined by
//   matching name + category + size and summing quantities.
export async function mergeBackup(backup: BackupData) {
 initializeDatabase({ skipInventoryReset: true });
 if(!backup||![2,3,4,5,6,7,8,9,10,11].includes(backup.version)||backup.app!==BACKUP_APP)throw new Error("Invalid Ortho Logbook backup.");
 backup = materializeBackupPhotoReferences(backup);
 const stats = { patients: 0, procedures: 0, inventory: 0, inventoryCategories: 0, patientImplants: 0, expenses: 0, users: 0, patientHistory: 0, inventoryMovements: 0, stockReceipts: 0 };
 db.withTransactionSync(() => {
  const has = (table: string, id: string) => !!db.getFirstSync<any>(`SELECT id FROM ${table} WHERE id=?`, [id]);
  for (const p of backup.patients) {
   if (has("patients", p.id)) continue;
   const photos=restorePatientPhotos(p);
   db.runSync("INSERT INTO patients (id,mr_no,name,gender,age,diagnosis,procedure,procedure_ii,implant,implant_ii,implant_id,implant_ii_id,address,file_name,photo_uri,photos_json,custom_data_json,date,created_at,created_by,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",[p.id,p.mr_no,p.name,p.gender||"",p.age||"",p.diagnosis||"",p.procedure||"",p.procedure_ii||"",p.implant||"",p.implant_ii||"",p.implant_id||null,p.implant_ii_id||null,p.address||"",p.file_name||"",photos.photoUri,photos.photosJson,p.custom_data_json||"{}",p.date,p.created_at,p.created_by||null,p.updated_at||null,p.updated_by||null]);
   stats.patients++;
  }
  for (const p of backup.procedures) {
   const existing = db.getFirstSync<any>("SELECT id FROM procedures WHERE LOWER(name)=LOWER(?) LIMIT 1", [p.name]);
   if (existing) continue;
   try { db.runSync("INSERT INTO procedures (id,name) VALUES (?,?)", [p.id, p.name]); stats.procedures++; } catch {}
  }
  const categoryIds = new Map<string,string>();
  const categoryIdsBySourceId = new Map<string,string>();
  for (const c of backup.inventoryCategories || []) {
   const categoryName = restoreText(c.name, "Unnamed category");
   const nameKey = categoryName.toLowerCase();
   const existing = db.getFirstSync<any>("SELECT id FROM inventory_categories WHERE LOWER(TRIM(name))=LOWER(?) LIMIT 1", [categoryName]);
   const cid = existing?.id || String(c.id || (Math.random().toString(36).slice(2)+Date.now().toString(36)));
   if (!existing) {
    db.runSync("INSERT INTO inventory_categories (id,name,created_at) VALUES (?,?,?)", [cid,categoryName,c.created_at||new Date().toISOString()]);
   }
   categoryIds.set(nameKey, cid);
   if(c.id!==undefined && c.id!==null && String(c.id)) categoryIdsBySourceId.set(String(c.id), cid);
  }
  // Preserve admin-defined patient fields during merge, using their stable key
  // to avoid creating duplicates when the same backup is imported repeatedly.
  const customFields = Array.isArray(backup.patientCustomFields) ? backup.patientCustomFields : [];
  const usedCustomFieldIds = new Set<string>();
  for (const field of customFields) {
   const key = restoreText(field.key);
   if (!key) continue;
   if (db.getFirstSync<any>("SELECT id FROM patient_custom_fields WHERE LOWER(key)=LOWER(?) LIMIT 1", [key])) continue;
   const fieldType = ["text","number","date","multiline"].includes(String(field.type)) ? String(field.type) : "text";
   const createdAt = restoreText(field.created_at, new Date().toISOString());
   db.runSync(
    "INSERT OR IGNORE INTO patient_custom_fields (id,key,label,type,sort_order,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
    [restoreRowId(field.id, "custom-field", usedCustomFieldIds), key, restoreText(field.label, "Custom field"), fieldType, Math.trunc(restoreReal(field.sort_order, 0)), restoreReal(field.enabled, 1, 0) > 0 ? 1 : 0, createdAt, restoreText(field.updated_at, createdAt)]
   );
  }
  for (const i of backup.inventory) {
   const sourceId = String(i.id || "");
   // Critical: importing the same backup again must never add its quantity again.
   // If this exact inventory row already exists by primary key, it was already
   // imported from this backup/source and must be skipped.
   const alreadyImported = Boolean(sourceId && has("inventory", sourceId));

   let categoryName = String(i.category||"").trim();
   const categoryKey = categoryName.toLowerCase();
   // Never write a backup's category_id directly: it may belong to another
   // phone/database. Resolve it through the source-ID map or category name.
   let categoryId = categoryIds.get(categoryKey) || categoryIdsBySourceId.get(String(i.category_id||"")) || null;
   if (!categoryId && i.category_id) {
    const localCategory = db.getFirstSync<any>("SELECT id,name FROM inventory_categories WHERE id=? LIMIT 1", [String(i.category_id)]);
    if(localCategory){ categoryId=String(localCategory.id); if(!categoryName) categoryName=String(localCategory.name||"").trim(); }
   }
   if (!categoryId && categoryName) {
    const existingCategory = db.getFirstSync<any>("SELECT id FROM inventory_categories WHERE LOWER(TRIM(name))=LOWER(?) LIMIT 1", [categoryName]);
    categoryId = existingCategory?.id || null;
    if (!categoryId) {
     categoryId = Math.random().toString(36).slice(2)+Date.now().toString(36);
     db.runSync("INSERT INTO inventory_categories (id,name,created_at) VALUES (?,?,?)",[categoryId,categoryName,new Date().toISOString()]);
    }
    categoryIds.set(categoryKey,categoryId);
   }

   if (alreadyImported) {
    const existingRow = db.getFirstSync<any>("SELECT id,category_id,category,size,minimum_stock FROM inventory WHERE id=? LIMIT 1", [sourceId]);
    if (existingRow) {
     db.runSync("UPDATE inventory SET category_id=?,category=?,size=?,minimum_stock=? WHERE id=?", [
      categoryId || existingRow.category_id || null,
      categoryName || existingRow.category || "",
      i.size || existingRow.size || "",
      Math.max(Number(existingRow.minimum_stock || 0), Number(i.minimum_stock || 0)),
      sourceId,
     ]);
    }
    continue;
   }

   // A merge restore must never add the same stock quantity a second time.
   // Match cross-phone copies only with a strong receipt identity (same bill
   // image and date). Other rows remain separate because multiple batches may
   // share the same name/category/size and even the same day.
   const candidates = db.getAllSync<any>(
    "SELECT id,quantity,minimum_stock,category_id,category,size,unit,added_date,bill_image FROM inventory WHERE LOWER(name)=LOWER(?) AND LOWER(COALESCE(size,''))=LOWER(?) AND LOWER(COALESCE(category,''))=LOWER(?)",
    [i.name, i.size||"", categoryName]
   );
   const incomingBill = String(i.bill_image || "").trim();
   const incomingDate = String(i.added_date || "").trim();
   const existing = candidates.find((row: any) => {
    const currentBill = String(row.bill_image || "").trim();
    const currentDate = String(row.added_date || "").trim();
    if (incomingBill && currentBill) return incomingBill === currentBill && incomingDate === currentDate;
    // Legacy rows without any receipt identity can be matched only when the
    // incoming row and the single existing candidate are both metadata-free.
    return !incomingBill && !currentBill && !incomingDate && !currentDate && candidates.length === 1;
   });
   if (existing) {
    // Preserve existing quantity rather than summing two snapshots of one row.
    db.runSync("UPDATE inventory SET minimum_stock=?,category_id=?,category=?,size=? WHERE id=?", [
     Math.max(Number(existing.minimum_stock||0), Number(i.minimum_stock||0)),
     categoryId || existing.category_id || null, categoryName||existing.category||"",
     i.size||existing.size||"", existing.id
    ]);
    continue;
   }
   db.runSync("INSERT INTO inventory (id,name,category_id,category,size,quantity,unit,minimum_stock,added_date,bill_image,low_stock_triggered_at,low_stock_since) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", [
    sourceId || (Math.random().toString(36).slice(2)+Date.now().toString(36)),
    i.name, categoryId, categoryName, i.size||"", Number(i.quantity||0), i.unit||"pcs",
    Number(i.minimum_stock||0), incomingDate||null, incomingBill||null,
    restoreText(i.low_stock_triggered_at)||null, restoreText(i.low_stock_since)||null
   ]);
   stats.inventory++;
  }
  for (const rec of backup.implantRecords || []) {
   if (has("implant_records", rec.id)) continue;
   db.runSync("INSERT INTO implant_records (id,name,category,size,manufacturer,model,lot_number,serial_number,expiry_date,supplier,quantity,unit,purchase_price,notes,bill_files_json,created_at,updated_at,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
     [rec.id,rec.name,rec.category||"",rec.size||"",rec.manufacturer||"",rec.model||"",rec.lot_number||"",rec.serial_number||"",rec.expiry_date||"",rec.supplier||"",Number(rec.quantity||0),rec.unit||"pcs",Number(rec.purchase_price||0),rec.notes||"",rec.bill_files_json||"[]",rec.created_at,rec.updated_at||rec.created_at,rec.created_by||null,rec.updated_by||null]);
  }
  for (const pi of backup.patientImplants || []) {
   if (has("patient_implants", pi.id)) continue;
   const patientId=String(pi.patient_id||"");
   const inventoryId=String(pi.inventory_id||"");
   const name=String(pi.name||"").trim();
   const category=String(pi.category||"").trim();
   const size=String(pi.size||"").trim();
   const qty=Math.max(1,Number(pi.quantity)||1);
   // Stronger than the row id: old backups may have regenerated IDs for the
   // same patient selection. Never add the same patient + implant selection twice.
   const existing=db.getFirstSync<any>(
     "SELECT id FROM patient_implants WHERE patient_id=? AND COALESCE(inventory_id,'')=? AND LOWER(TRIM(COALESCE(name,'')))=LOWER(?) AND LOWER(TRIM(COALESCE(category,'')))=LOWER(?) AND LOWER(TRIM(COALESCE(size,'')))=LOWER(?) LIMIT 1",
     [patientId,inventoryId,name,category,size]
   );
   if (existing) continue;
   db.runSync("INSERT INTO patient_implants (id,patient_id,inventory_id,name,category,size,quantity,created_at) VALUES (?,?,?,?,?,?,?,?)", [pi.id,patientId,pi.inventory_id||null,name,pi.category||null,pi.size||null,qty,pi.created_at]);
  }
  for (const e of backup.expenses) {
   if (has("expenses", e.id)) continue;
   db.runSync("INSERT INTO expenses (id,description,amount,belongs_to,doctor_id,date,created_at) VALUES (?,?,?,?,?,?,?)", [e.id, e.description, Number(e.amount||0), e.belongs_to||"hospital", e.doctor_id||null, e.date, e.created_at]);
   stats.expenses++;
  }
  for (const u of backup.users) {
   const existing = db.getFirstSync<any>("SELECT id FROM users WHERE email=? LIMIT 1", [u.email]);
   if (existing) continue;
   db.runSync("INSERT INTO users (id,email,name,password_hash,recovery_code,role,can_edit_patients,disabled,created_at) VALUES (?,?,?,?,?,?,?,?,?)", [u.id, u.email, u.name, u.password_hash, u.recovery_code||null, u.role||"doctor", Number(u.can_edit_patients??1), Number(u.disabled??0), u.created_at]);
   stats.users++;
  }
  for (const h of backup.patientHistory) {
   if (has("patient_history", h.id)) continue;
   db.runSync("INSERT INTO patient_history (id,patient_id,user_id,action,snapshot_json,created_at) VALUES (?,?,?,?,?,?)", [h.id, h.patient_id, h.user_id||null, h.action, h.snapshot_json, h.created_at]);
   stats.patientHistory++;
  }
  for (const r of backup.inventoryPurchaseReceipts || []) {
   if (has("inventory_purchase_receipts", r.id)) continue;
   db.runSync("INSERT INTO inventory_purchase_receipts (id,inventory_id,category_id,category,size,quantity,unit,minimum_stock,added_date,bill_image,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",[r.id,r.inventory_id,r.category_id||null,r.category||"",r.size||"",Number(r.quantity||0),r.unit||"pcs",Number(r.minimum_stock||0),r.added_date||null,r.bill_image||null,r.created_at||new Date().toISOString(),r.created_by||null]);
  }
  for (const r of backup.stockReceipts || []) {
   if (has("stock_receipts", r.id)) continue;
   db.runSync("INSERT INTO stock_receipts (id,inventory_id,batch_id,category_id,category,size,quantity,unit,minimum_stock,added_date,bill_image,description,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [
     r.id,r.inventory_id,r.batch_id||null,r.category_id||null,r.category||"",r.size||"",
     Number(r.quantity||0),r.unit||"pcs",Number(r.minimum_stock||0),r.added_date||null,
     r.bill_image||null,r.description||null,r.created_at||new Date().toISOString(),r.created_by||null
   ]);
   stats.stockReceipts++;
  }
  for (const m of backup.inventoryMovements) {
   if (has("inventory_movements", m.id)) continue;
   db.runSync("INSERT INTO inventory_movements (id,inventory_id,user_id,type,amount,quantity_after,note,created_at) VALUES (?,?,?,?,?,?,?,?)", [m.id,m.inventory_id,m.user_id||null,m.type,Number(m.amount||0),Number(m.quantity_after||0),m.note||null,m.created_at]);
   stats.inventoryMovements++;
  }
  // Keep unexpired deleted-record payloads and tombstones when merging a backup.
  // Existing IDs are skipped so repeated imports stay idempotent.
  const usedTrashIds = new Set<string>();
  for (const item of Array.isArray(backup.trash) ? backup.trash : []) {
   const deletedAt = restoreText(item.deleted_at, new Date().toISOString());
   const expiresAt = restoreText(item.expires_at, new Date(Date.parse(deletedAt) + 30 * 24 * 60 * 60 * 1000).toISOString());
   if (Date.parse(expiresAt) <= Date.now()) continue;
   const sourceId = restoreText(item.id);
   if (sourceId && has("deleted_records", sourceId)) continue;
   db.runSync(
    "INSERT OR IGNORE INTO deleted_records (id,kind,title,payload_json,deleted_at,expires_at,deleted_by) VALUES (?,?,?,?,?,?,?)",
    [restoreRowId(sourceId, "trash", usedTrashIds), restoreText(item.kind, "deleted-record"), restoreText(item.title, "Deleted item"), restoreText(item.payload_json, "{}"), deletedAt, expiresAt, restoreText(item.deleted_by) || null]
   );
  }
 });
 // Verify persisted settings before restore is reported as complete.
 if (backup.version >= 6 && backup.branding === null) {
   if (!(await storage.removeItem("ortho_branding"))) throw new Error("Could not clear saved branding during restore.");
 } else if (backup.version >= 6 && backup.branding && typeof backup.branding === "object") {
   if (!(await storage.setItem("ortho_branding", JSON.stringify(backup.branding)))) throw new Error("Could not save branding during restore.");
   const saved = await storage.getItem<any>("ortho_branding", "");
   let parsed: any = saved;
   if (typeof parsed === "string") { try { parsed = JSON.parse(parsed); } catch {} }
   if (!parsed || typeof parsed !== "object" || JSON.stringify(parsed) !== JSON.stringify(backup.branding)) throw new Error("Branding was not verified after restore. Please retry.");
 }
 if (backup.appSettings && typeof backup.appSettings === "object") {
   const settings = backup.appSettings;
   if (typeof settings.googleOAuthClientId === "string" && settings.googleOAuthClientId.trim()) {
     if (!(await storage.secureSet("ortho_google_drive_client_id", normalizeSecureSetting(settings.googleOAuthClientId)))) throw new Error("Could not save Google OAuth client ID during restore.");
   } else {
     await SecureStore.deleteItemAsync("ortho_google_drive_client_id");
   }
   if (typeof settings.googleCloudProjectId === "string" && settings.googleCloudProjectId.trim()) {
     if (!(await storage.secureSet("ortho_google_drive_cloud_project_id", normalizeSecureSetting(settings.googleCloudProjectId)))) throw new Error("Could not save Google Cloud project ID during restore.");
   } else {
     await SecureStore.deleteItemAsync("ortho_google_drive_cloud_project_id");
   }
   if (typeof settings.googleAccountEmail === "string" && settings.googleAccountEmail.trim()) {
     if (!(await storage.secureSet("ortho_drive_account_email", settings.googleAccountEmail))) throw new Error("Could not save Google account recovery email.");
   } else {
     await storage.secureRemove("ortho_drive_account_email");
   }
 }
 await restoreLabSettings(backup.appSettings);
 await restoreAsyncStorageSettings(backup.appSettings);
  markInventoryResetDone();
 return stats;
}

export async function restoreEncryptedBackup(text:string,password:string){return restoreBackup(await decryptBackup(text,password));}
