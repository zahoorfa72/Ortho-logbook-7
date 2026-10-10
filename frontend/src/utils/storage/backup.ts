import * as Crypto from "expo-crypto";
import { File } from "expo-file-system";
import * as LegacyFileSystem from "expo-file-system/legacy";
import * as ImageManipulator from "expo-image-manipulator";
import * as SecureStore from "expo-secure-store";
import nacl from "tweetnacl";
import { Image } from "react-native";
import { db, initializeDatabase, markInventoryResetDone, repairDatabaseData } from "@/src/db/database";
import { storage } from "@/src/utils/storage";
import type { BrandingConfig } from "@/src/theme";

const BACKUP_VERSION = 7;
const BACKUP_APP = "Ortho Logbook";

type BackupData = {
  version:number; app:string; createdAt:string;
  patients:any[]; procedures:any[]; inventoryCategories:any[]; inventory:any[]; patientImplants:any[]; patientCustomFields:any[]; implantRecords:any[]; expenses:any[]; users:any[];
  patientHistory:any[]; inventoryMovements:any[]; inventoryPurchaseReceipts:any[]; stockReceipts:any[];
  branding?: BrandingConfig | null;
  appSettings?: { googleOAuthClientId?: string; googleCloudProjectId?: string };
  filter?: BackupFilter;
  incremental?: boolean;
  changedTables?: string[];
};
type EncryptedBackup = {
  version:number; app:string; encrypted:true; algorithm:"XSalsa20-Poly1305"; kdf:"SHA-256";
  createdAt:string; salt:string; nonce:string; ciphertext:string; ciphertextEncoding?: "base64";
};

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
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
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
async function embedPhoto(uri:string, cache?: Map<string,string>):Promise<string>{
  if(!uri)return "";
  const cached = cache?.get(uri);
  if (cached) return cached;
  try{
    // Recompress existing data URIs too: older backups stored original-size
    // base64 images and could push a manual backup beyond Android's heap limit.
    // This changes only the backup copy, never the original patient photo.
    let resizeActions: any[] = [];
    try {
      const dimensions = await new Promise<{width:number;height:number}>((resolve,reject) => {
        Image.getSize(uri, (width,height) => resolve({width,height}), reject);
      });
      const longest = Math.max(dimensions.width, dimensions.height);
      if (longest > 720) {
        resizeActions = [dimensions.width >= dimensions.height
          ? {resize:{width:720}}
          : {resize:{height:720}}];
      }
    } catch {
      // Some Android providers do not report dimensions for data: URIs.
      // A conservative width cap still bounds the usual portrait photo to ~720px.
      resizeActions = [{resize:{width:480}}];
    }
    const result=await ImageManipulator.manipulateAsync(
      uri,
      resizeActions,
      {compress:0.2,format:ImageManipulator.SaveFormat.JPEG,base64:true}
    );
    if(!result.base64)throw new Error("Empty compressed photo.");
    const portable = `data:image/jpeg;base64,${result.base64}`;
    cache?.set(uri, portable);
    return portable;
  }catch{
    throw new Error("Could not compress a patient photo for backup. Please make sure the photo is still available on this device and try again.");
  }
}

async function embedOptionalPhoto(uri: string, cache?: Map<string,string>): Promise<string> {
  if (!uri) return uri;
  try { return await embedPhoto(uri, cache); }
  catch (error) {
    // A bill attachment must not prevent the entire backup from succeeding.
    // Valid local/data URIs are compressed and embedded; legacy unsupported
    // attachment formats are retained as-is for backward compatibility.
    console.warn("[backup] optional bill photo could not be compressed", error);
    return uri;
  }
}

async function embedPatientPhotos(row:any, cache?: Map<string,string>){
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
  for(const uri of photos)embedded.push(await embedPhoto(uri, cache));
  return {
    ...row,
    // The first photo is already present in photos_json. Duplicating its
    // base64 payload in photo_uri almost doubles backup size and memory use.
    // restorePatientPhotos() and the app's photo reader use photos_json first.
    photo_uri: "",
    photos_json: JSON.stringify(embedded),
  };
}

export type BackupFilter = { type: "all" | "date" | "month" | "year"; value?: string };

function whereForFilter(filter: BackupFilter, column: string) {
  if (filter.type === "date") return { sql: ` WHERE ${column}=?`, args: [filter.value || ""] };
  if (filter.type === "month") return { sql: ` WHERE ${column} LIKE ?`, args: [`${filter.value || ""}-%`] };
  if (filter.type === "year") return { sql: ` WHERE ${column} LIKE ?`, args: [`${filter.value || ""}-%`] };
  return { sql: "", args: [] };
}

async function createBackupData(filter: BackupFilter = { type: "all" }, onProgress?: (stage: string) => void, changedTables?: string[], previousPatientRows?: any[], previousPhotoSources?: Record<string, string>):Promise<BackupData>{
 initializeDatabase();
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
   googleOAuthClientId: (await SecureStore.getItemAsync("ortho_google_drive_client_id").catch(() => null)) || undefined,
   googleCloudProjectId: (await SecureStore.getItemAsync("ortho_google_drive_cloud_project_id").catch(() => null)) || undefined,
 } : undefined;
 const pf=whereForFilter(filter, "date");
 const patients=include("patients") ? db.getAllSync<any>(`SELECT * FROM patients${pf.sql} ORDER BY date DESC, created_at DESC`, pf.args) : [];
 const selectedPatientIds = new Set(patients.map((p:any)=>p.id));
 const compressedPhotoCache = new Map<string,string>();
 const embeddedPatients:any[]=[];
 const previousPatientsById = new Map<string, any>((previousPatientRows || []).filter((p:any)=>p?.id!=null).map((p:any)=>[String(p.id),p]));
 for(let i=0;i<patients.length;i++){
   const patient = patients[i];
   const patientId = String(patient.id ?? "");
   const sourceSignature = JSON.stringify([String(patient.photo_uri || ""), String(patient.photos_json || "")]);
   const previous = previousPatientsById.get(patientId);
   if (patientId && previous && previousPhotoSources?.[patientId] === sourceSignature &&
       typeof previous.photos_json === "string") {
     // Reuse the already-compressed, portable photo bytes when this patient's
     // photo source has not changed. Editing another field won't recompress it.
     embeddedPatients.push({...patient, photo_uri: previous.photo_uri || "", photos_json: previous.photos_json});
   } else {
     onProgress?.(`Compressing changed patient photos… ${i+1}/${patients.length}`);
     embeddedPatients.push(await embedPatientPhotos(patient, compressedPhotoCache));
   }
 }

 const historyAll=include("patientHistory") ? db.getAllSync<any>("SELECT * FROM patient_history ORDER BY created_at ASC") : [];
 const history=filter.type==="all" ? historyAll : historyAll.filter((h:any)=>selectedPatientIds.has(h.patient_id));
 const embeddedHistory:any[]=[];
 for (let historyIndex = 0; historyIndex < history.length; historyIndex++) {
   const h = history[historyIndex];
   try {
     const snap = JSON.parse(String(h.snapshot_json || ""));
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
       for (const photo of historyPhotos) embeddedHistoryPhotos.push(await embedPhoto(photo, compressedPhotoCache));
       if (Array.isArray(snap.photos)) snap.photos = embeddedHistoryPhotos;
       else if (typeof snap.photos_json === "string") snap.photos_json = JSON.stringify(embeddedHistoryPhotos);
       else snap.photos = embeddedHistoryPhotos;
       if (snap.photoUri) snap.photoUri = "";
       if (snap.photo_uri) snap.photo_uri = "";
     }
     embeddedHistory.push({...h, snapshot_json:JSON.stringify(snap)});
   } catch {
     embeddedHistory.push(h);
   }
 }

 return {
  version:BACKUP_VERSION,app:BACKUP_APP,createdAt:new Date().toISOString(),
  patients:embeddedPatients,
  procedures:include("procedures") ? db.getAllSync<any>("SELECT * FROM procedures ORDER BY name COLLATE NOCASE") : [],
  inventoryCategories:include("inventoryCategories") ? db.getAllSync<any>("SELECT * FROM inventory_categories ORDER BY name COLLATE NOCASE") : [],
  inventory:include("inventory") ? db.getAllSync<any>("SELECT id,name,category_id,category,size,quantity,unit,minimum_stock,low_stock_triggered_at,low_stock_since FROM inventory ORDER BY COALESCE(category,''),name COLLATE NOCASE,COALESCE(size,'')") : [],
  patientImplants:include("patientImplants") ? db.getAllSync<any>("SELECT * FROM patient_implants ORDER BY created_at ASC") : [],
  patientCustomFields:include("patientCustomFields") ? db.getAllSync<any>("SELECT * FROM patient_custom_fields ORDER BY sort_order ASC,label COLLATE NOCASE") : [],
  implantRecords:include("implantRecords") ? await Promise.all(db.getAllSync<any>("SELECT * FROM implant_records ORDER BY created_at ASC").map(async (row:any) => {
    let billFiles = row.bill_files_json;
    try {
      const parsed = JSON.parse(String(row.bill_files_json || "[]"));
      if (Array.isArray(parsed)) {
        const compressed = [];
        for (const file of parsed) {
          if (typeof file === "string" && /^(data:image\/|file:\/\/|content:\/\/)/i.test(file)) {
            try { compressed.push(await embedPhoto(file, compressedPhotoCache)); } catch { compressed.push(file); }
          } else compressed.push(file);
        }
        billFiles = JSON.stringify(compressed);
      }
    } catch {}
    return { ...row, bill_files_json: billFiles };
  })) : [],
  expenses:include("expenses") ? (()=>{const f=whereForFilter(filter,"date");return db.getAllSync<any>(`SELECT * FROM expenses${f.sql} ORDER BY date DESC, created_at DESC`,f.args);})() : [],
  users:include("users") ? db.getAllSync<any>("SELECT * FROM users ORDER BY created_at ASC") : [],
  patientHistory:embeddedHistory,
  inventoryMovements:include("inventoryMovements") ? (()=>{if(filter.type==="all") return db.getAllSync<any>("SELECT * FROM inventory_movements ORDER BY created_at ASC"); const f=filter.type==="date" ? {sql:" WHERE date(created_at)=?",args:[filter.value||""]} : filter.type==="month" ? {sql:" WHERE created_at LIKE ?",args:[`${filter.value||""}-%`]} : {sql:" WHERE created_at LIKE ?",args:[`${filter.value||""}-%`]}; return db.getAllSync<any>(`SELECT * FROM inventory_movements${f.sql} ORDER BY created_at ASC`,f.args);})() : [],
  inventoryPurchaseReceipts:include("inventoryPurchaseReceipts") ? await (async()=>{const f=whereForFilter(filter,"created_at");const rows=db.getAllSync<any>(\`SELECT * FROM inventory_purchase_receipts\${f.sql} ORDER BY created_at ASC\`,f.args);return await Promise.all(rows.map(async (row:any)=>({ ...row, bill_image: typeof row.bill_image==="string" && /^(data:image\/|file:\/\/|content:\/\/)/i.test(row.bill_image) ? await embedOptionalPhoto(row.bill_image,compressedPhotoCache) : row.bill_image })));})() : [],
  stockReceipts:include("stockReceipts") ? await (async()=>{const f=whereForFilter(filter,"created_at");const rows=db.getAllSync<any>(\`SELECT * FROM stock_receipts\${f.sql} ORDER BY created_at ASC\`,f.args);return await Promise.all(rows.map(async (row:any)=>({ ...row, bill_image: typeof row.bill_image==="string" && /^(data:image\/|file:\/\/|content:\/\/)/i.test(row.bill_image) ? await embedOptionalPhoto(row.bill_image,compressedPhotoCache) : row.bill_image })));})() : [],
  branding,
  appSettings,
 };
}

export async function exportBackup(password:string, filter: BackupFilter = { type: "all" }):Promise<string>{
 const backup=await createBackupData(filter);
 backup.filter = filter;
 const salt=await Crypto.getRandomBytesAsync(16);
 const nonce=await Crypto.getRandomBytesAsync(nacl.secretbox.nonceLength);
 const key=await deriveKey(password,salt);
 const ciphertext=nacl.secretbox(stringToBytes(JSON.stringify(backup)),nonce,key);
 return JSON.stringify({version:BACKUP_VERSION,app:BACKUP_APP,encrypted:true,algorithm:"XSalsa20-Poly1305",kdf:"SHA-256",createdAt:backup.createdAt,salt:bytesToHex(salt),nonce:bytesToHex(nonce),ciphertext:bytesToBase64(ciphertext),ciphertextEncoding:"base64"} satisfies EncryptedBackup);
}

// Google Drive uses a plain JSON snapshot so automatic backup does not depend on a password.
// Phone/file backups continue using exportBackup() and remain encrypted.
export async function exportUnencryptedBackup(filter: BackupFilter = { type: "all" }, onProgress?: (stage: string) => void): Promise<string> {
 const backup = await createBackupData(filter, onProgress);
 backup.filter = filter;
 return JSON.stringify(backup);
}

// Drive auto-sync keeps a local copy of each successfully uploaded table so
// subsequent backups can contain only changed rows and deletion tombstones.
// The cache is promoted only after Google Drive confirms the upload.
const DELTA_CACHE_PATH = (LegacyFileSystem.documentDirectory || LegacyFileSystem.cacheDirectory || "") + "ortho-drive-delta-cache-v1.json";
let pendingDeltaCacheText: string | null = null;

type DriveDeltaCache = { baselineKey: string; tables: Record<string, any[]>; photoSources?: Record<string, string> };

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

export async function exportIncrementalBackup(changedTables: string[], onProgress?: (stage: string) => void, baselineKey = ""): Promise<string> {
 const allowed = new Set([
  "patients","procedures","inventoryCategories","inventory","patientImplants",
  "patientCustomFields","implantRecords","expenses","users","patientHistory",
  "inventoryMovements","inventoryPurchaseReceipts","stockReceipts","branding","appSettings"
 ]);
 const tables = Array.from(new Set(changedTables)).filter((name) => allowed.has(name));
 if (!tables.length) throw new Error("There are no changed data tables to sync.");
 const previous = await readDeltaCache();
 const canDiff = !!previous && previous.baselineKey === baselineKey && !!baselineKey;
 const backup = await createBackupData(
  { type: "all" }, onProgress, tables,
  canDiff ? previous!.tables.patients : undefined,
  canDiff && previous!.photoSources ? previous!.photoSources : undefined
 );
 const nextTables: Record<string, any[]> = canDiff ? { ...previous!.tables } : {};
 const deletedIds: Record<string, string[]> = {};
 const fullTables: string[] = [];
 for (const table of tables) {
  if (table === "branding" || table === "appSettings") continue;
  const currentRows = Array.isArray((backup as any)[table]) ? (backup as any)[table] as any[] : [];
  const previousRows = canDiff && Array.isArray(previous!.tables[table]) ? previous!.tables[table] : null;
  if (!previousRows) {
   // First sync for this table, or a changed full-backup baseline: use a
   // complete table snapshot. This is slower once but remains restorable.
   nextTables[table] = currentRows;
   if (canDiff) fullTables.push(table);
   continue;
  }
  const oldById = new Map<string, any>();
  const newById = new Map<string, any>();
  for (const row of previousRows) { const id = rowKey(row); if (id !== null) oldById.set(id, row); }
  for (const row of currentRows) { const id = rowKey(row); if (id !== null) newById.set(id, row); }
  const changedRows = currentRows.filter((row) => {
   const id = rowKey(row);
   if (id === null) return true;
   const old = oldById.get(id);
   return !old || JSON.stringify(old) !== JSON.stringify(row);
  });
  deletedIds[table] = Array.from(oldById.keys()).filter((id) => !newById.has(id));
  (backup as any)[table] = table === "patients" ? changedRows.map((row) => {
   const old = oldById.get(String(row.id ?? ""));
   if (old && old.photo_uri === row.photo_uri && old.photos_json === row.photos_json) {
    // Patient details changed but the photos did not: leave photo bytes out of
    // the delta; restore merges these metadata fields with the saved photo.
    const { photo_uri: _photoUri, photos_json: _photosJson, ...withoutPhotos } = row;
    return withoutPhotos;
   }
   return row;
  }) : changedRows;
  nextTables[table] = currentRows;
 }
 backup.filter = { type: "all" };
 backup.incremental = true;
 backup.changedTables = tables;
 (backup as any)._rowDelta = canDiff;
 (backup as any).deletedIds = canDiff ? deletedIds : {};
 (backup as any).fullTables = canDiff ? fullTables : tables.filter((table) => table !== "branding" && table !== "appSettings");
 // Track the source URIs separately from portable compressed photo bytes. This
 // lets future backups reuse unchanged photo payloads without recompressing them.
 const nextPhotoSources: Record<string, string> = canDiff && previous!.photoSources ? { ...previous!.photoSources } : {};
 if (tables.includes("patients")) {
  const sourceRows = db.getAllSync<any>("SELECT id,photo_uri,photos_json FROM patients");
  const currentIds = new Set<string>();
  for (const row of sourceRows) {
   const id = String(row.id ?? "");
   if (!id) continue;
   currentIds.add(id);
   nextPhotoSources[id] = JSON.stringify([String(row.photo_uri || ""), String(row.photos_json || "")]);
  }
  for (const id of Object.keys(nextPhotoSources)) if (!currentIds.has(id)) delete nextPhotoSources[id];
 }
 // Do not persist the new baseline until the upload succeeds.
 pendingDeltaCacheText = JSON.stringify({ baselineKey, tables: nextTables, photoSources: nextPhotoSources });
 return JSON.stringify(backup);
}

function parseHeader(text:string):any{
 let b:any;try{b=JSON.parse(text);}catch{throw new Error("The selected backup file is not valid.");}
 if(!b||![2,3,4,5,6,7].includes(b.version)||b.app!==BACKUP_APP)throw new Error("Invalid or unsupported Ortho Logbook backup.");
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
  return data;
 }
 try{
  const key=await deriveKey(password,hexToBytes(b.salt));
  const cipherBytes=b.ciphertextEncoding === "base64" ? base64ToBytes(b.ciphertext) : hexToBytes(b.ciphertext);
  const plain=nacl.secretbox.open(cipherBytes,hexToBytes(b.nonce),key);
  if(!plain)throw new Error("Incorrect backup password or damaged backup.");
  const data=JSON.parse(bytesToString(plain)) as BackupData;
  if(!data||![2,3,4,5,6,7].includes(data.version)||data.app!==BACKUP_APP)throw new Error("The decrypted backup is invalid.");
  for(const keyName of ["patients","procedures","inventory","expenses","users","patientHistory","inventoryMovements"]){
    if(!Array.isArray((data as any)[keyName]))throw new Error("The backup is incomplete or damaged.");
  }
  // v2/v3 backups did not contain these relational inventory tables.
  data.inventoryCategories=Array.isArray((data as any).inventoryCategories) ? (data as any).inventoryCategories : [];
  data.patientImplants=Array.isArray((data as any).patientImplants) ? (data as any).patientImplants : [];
  data.stockReceipts=Array.isArray((data as any).stockReceipts) ? (data as any).stockReceipts : [];
  return data;
 }catch(e){if(e instanceof Error&&e.message.includes("Incorrect backup password"))throw e;throw new Error("Unable to decrypt backup. Check the password and backup file.");}
}

function restorePatientPhotos(p:any){
  // v3 contains data:image/...;base64,... strings, which work directly with
  // React Native Image and therefore survive moving the backup to another phone.
  // v2 is still accepted for backward compatibility.
  const photosJson = p.photos_json || null;
  let photos:string[]=[];
  if(photosJson){
    try{const parsed=JSON.parse(String(photosJson));if(Array.isArray(parsed))photos=parsed.filter((x)=>typeof x==="string"&&x.length>0);}catch{}
  }
  const primary=photos[0]||p.photo_uri||"";
  // Portable data URIs are already stored in photos_json. Do not duplicate
  // the first base64 photo into photo_uri; this can nearly double database size.
  const photoUri=primary.startsWith("data:") ? "" : primary;
  return {photoUri,photosJson:photos.length?JSON.stringify(photos):null};
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
 if(!backup||![2,3,4,5,6,7].includes(backup.version)||backup.app!==BACKUP_APP)throw new Error("Invalid Ortho Logbook backup.");
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
 db.withTransactionSync(()=>{
  db.runSync("DELETE FROM inventory_movements"); db.runSync("DELETE FROM inventory_purchase_receipts"); db.runSync("DELETE FROM stock_receipts"); db.runSync("DELETE FROM patient_implants"); db.runSync("DELETE FROM patient_history"); db.runSync("DELETE FROM expenses"); db.runSync("DELETE FROM patients"); db.runSync("DELETE FROM patient_custom_fields"); db.runSync("DELETE FROM implant_records"); db.runSync("DELETE FROM procedures"); db.runSync("DELETE FROM inventory"); db.runSync("DELETE FROM inventory_categories"); db.runSync("DELETE FROM users");
  const usedPatientIds=new Set<string>();
  const patientIdMap=new Map<string,string>();
  for(const p of patients){
   const photos=restorePatientPhotos(p);
   const restoredPatientId=restoreRowId(p.id,"patient",usedPatientIds);
   if(p.id) patientIdMap.set(String(p.id),restoredPatientId);
   const patientDate=restoreText(p.date,new Date().toISOString().slice(0,10));
   const patientCreatedAt=restoreText(p.created_at,new Date().toISOString());
   db.runSync("INSERT INTO patients (id,mr_no,name,gender,age,diagnosis,procedure,implant,implant_ii,implant_id,implant_ii_id,address,file_name,photo_uri,photos_json,custom_data_json,date,created_at,created_by,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",[restoredPatientId,restoreText(p.mr_no),restoreText(p.name,"Unnamed patient"),restoreText(p.gender),restoreText(p.age),restoreText(p.diagnosis),restoreText(p.procedure),restoreText(p.implant),restoreText(p.implant_ii),restoreText(p.implant_id)||null,restoreText(p.implant_ii_id)||null,restoreText(p.address),restoreText(p.file_name),photos.photoUri,photos.photosJson,restoreJsonObject(p.custom_data_json),patientDate,patientCreatedAt,restoreText(p.created_by)||null,restoreText(p.updated_at)||null,restoreText(p.updated_by)||null]);
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
  const usedCategoryIds=new Set<string>();
  const usedCategoryNames=new Set<string>();
  for(const c of inventoryCategories){
    const name=restoreText(c.name,"Unnamed category");
    const nameKey=name.toLowerCase();
    if(usedCategoryNames.has(nameKey)) continue;
    usedCategoryNames.add(nameKey);
    const cid=restoreRowId(c.id,"category",usedCategoryIds);
    db.runSync("INSERT INTO inventory_categories (id,name,created_at) VALUES (?,?,?)",[cid,name,restoreText(c.created_at,new Date().toISOString())]);
    categoryIds.set(nameKey,cid);
  }
  const usedInventoryIds=new Set<string>();
  const inventoryIdMap=new Map<string,string>();
  for(const i of inventory){
    let cid=i.category_id||categoryIds.get(String(i.category||"").toLowerCase())||null;
    if(!cid && i.category){
      cid=Math.random().toString(36).slice(2)+Date.now().toString(36);
      const autoCategoryName=restoreText(i.category,"Uncategorized");
      db.runSync("INSERT INTO inventory_categories (id,name,created_at) VALUES (?,?,?)",[cid,autoCategoryName,new Date().toISOString()]);
      categoryIds.set(autoCategoryName.toLowerCase(),cid);
    }
    const restoredInventoryId=restoreRowId(i.id,"inventory",usedInventoryIds);
    if(i.id) inventoryIdMap.set(String(i.id),restoredInventoryId);
    const itemName=restoreText(i.name,"Unnamed item");
    const itemCategory=restoreText(i.category);
    const itemSize=restoreText(i.size);
    db.runSync("INSERT INTO inventory (id,name,category_id,category,size,quantity,unit,minimum_stock,low_stock_triggered_at,low_stock_since) VALUES (?,?,?,?,?,?,?,?,?,?)",[restoredInventoryId,itemName,cid,itemCategory,itemSize,restoreReal(i.quantity,0,0),restoreText(i.unit,"pcs"),restoreReal(i.minimum_stock,0,0),restoreText(i.low_stock_triggered_at)||null,restoreText(i.low_stock_since)||null]);
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
 });
 repairDatabaseData();
 // Await settings writes so restore cannot report success before branding,
 // logos, PDF styling and Drive configuration have been persisted.
 if (backup.version >= 6 && backup.branding === null) {
   await storage.removeItem("ortho_branding");
 } else if (backup.version >= 6 && backup.branding && typeof backup.branding === "object") {
   await storage.setItem("ortho_branding", JSON.stringify(backup.branding));
 }
 if (backup.appSettings && typeof backup.appSettings === "object") {
   const settings = backup.appSettings;
   if (typeof settings.googleOAuthClientId === "string" && settings.googleOAuthClientId) {
     await SecureStore.setItemAsync("ortho_google_drive_client_id", settings.googleOAuthClientId).catch(() => undefined);
   }
   if (typeof settings.googleCloudProjectId === "string" && settings.googleCloudProjectId) {
     await SecureStore.setItemAsync("ortho_google_drive_cloud_project_id", settings.googleCloudProjectId).catch(() => undefined);
   }
 }
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
 if(!backup||![2,3,4,5,6,7].includes(backup.version)||backup.app!==BACKUP_APP)throw new Error("Invalid Ortho Logbook backup.");
 const stats = { patients: 0, procedures: 0, inventory: 0, inventoryCategories: 0, patientImplants: 0, expenses: 0, users: 0, patientHistory: 0, inventoryMovements: 0, stockReceipts: 0 };
 db.withTransactionSync(() => {
  const has = (table: string, id: string) => !!db.getFirstSync<any>(`SELECT id FROM ${table} WHERE id=?`, [id]);
  for (const p of backup.patients) {
   if (has("patients", p.id)) continue;
   const photos=restorePatientPhotos(p);
   db.runSync("INSERT INTO patients (id,mr_no,name,gender,age,diagnosis,procedure,implant,implant_ii,implant_id,implant_ii_id,address,file_name,photo_uri,photos_json,custom_data_json,date,created_at,created_by,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",[p.id,p.mr_no,p.name,p.gender||"",p.age||"",p.diagnosis||"",p.procedure||"",p.implant||"",p.implant_ii||"",p.implant_id||null,p.implant_ii_id||null,p.address||"",p.file_name||"",photos.photoUri,photos.photosJson,p.custom_data_json||"{}",p.date,p.created_at,p.created_by||null,p.updated_at||null,p.updated_by||null]);
   stats.patients++;
  }
  for (const p of backup.procedures) {
   const existing = db.getFirstSync<any>("SELECT id FROM procedures WHERE LOWER(name)=LOWER(?) LIMIT 1", [p.name]);
   if (existing) continue;
   try { db.runSync("INSERT INTO procedures (id,name) VALUES (?,?)", [p.id, p.name]); stats.procedures++; } catch {}
  }
  const categoryIds = new Map<string,string>();
  for (const c of backup.inventoryCategories || []) {
   const existing = db.getFirstSync<any>("SELECT id FROM inventory_categories WHERE LOWER(name)=LOWER(?) LIMIT 1", [c.name]);
   const cid = existing?.id || String(c.id);
   if (!existing) {
    db.runSync("INSERT INTO inventory_categories (id,name,created_at) VALUES (?,?,?)", [cid,c.name,c.created_at||new Date().toISOString()]);
   }
   categoryIds.set(String(c.name||"").toLowerCase(), cid);
  }
  for (const i of backup.inventory) {
   const sourceId = String(i.id || "");
   // Critical: importing the same backup again must never add its quantity again.
   // If this exact inventory row already exists by primary key, it was already
   // imported from this backup/source and must be skipped.
   if (sourceId && has("inventory", sourceId)) continue;

   const categoryName = String(i.category||"").trim();
   let categoryId = i.category_id || categoryIds.get(categoryName.toLowerCase()) || null;
   if (!categoryId && categoryName) {
    categoryId = Math.random().toString(36).slice(2)+Date.now().toString(36);
    db.runSync("INSERT INTO inventory_categories (id,name,created_at) VALUES (?,?,?)",[categoryId,categoryName,new Date().toISOString()]);
    categoryIds.set(categoryName.toLowerCase(),categoryId);
   }

   // A different phone may have created the same item with a different id.
   // In that case combine the new stock once. Re-importing the same backup is
   // already blocked above by the source id check.
   const existing = db.getFirstSync<any>("SELECT id,quantity,minimum_stock,category_id,category,size FROM inventory WHERE LOWER(name)=LOWER(?) AND LOWER(COALESCE(size,''))=LOWER(?) AND LOWER(COALESCE(category,''))=LOWER(?) LIMIT 1", [i.name, i.size||"", categoryName]);
   if (existing) {
    const q = Number(existing.quantity || 0) + Number(i.quantity || 0);
    db.runSync("UPDATE inventory SET quantity=?,minimum_stock=?,category_id=?,category=?,size=? WHERE id=?", [q, Math.max(Number(existing.minimum_stock||0), Number(i.minimum_stock||0)), categoryId || existing.category_id || null, categoryName||existing.category||"", i.size||existing.size||"", existing.id]);
   } else {
    db.runSync("INSERT INTO inventory (id,name,category_id,category,size,quantity,unit,minimum_stock,low_stock_triggered_at,low_stock_since) VALUES (?,?,?,?,?,?,?,?,?,?)", [i.id, i.name, categoryId, categoryName, i.size||"", Number(i.quantity||0), i.unit||"pcs", Number(i.minimum_stock||0), restoreText(i.low_stock_triggered_at)||null, restoreText(i.low_stock_since)||null]);
   }
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
 });
 // Await settings writes so restore cannot report success before branding,
 // logos, PDF styling and Drive configuration have been persisted.
 if (backup.version >= 6 && backup.branding === null) {
   await storage.removeItem("ortho_branding");
 } else if (backup.version >= 6 && backup.branding && typeof backup.branding === "object") {
   await storage.setItem("ortho_branding", JSON.stringify(backup.branding));
 }
 if (backup.appSettings && typeof backup.appSettings === "object") {
   const settings = backup.appSettings;
   if (typeof settings.googleOAuthClientId === "string" && settings.googleOAuthClientId) {
     await SecureStore.setItemAsync("ortho_google_drive_client_id", settings.googleOAuthClientId).catch(() => undefined);
   }
   if (typeof settings.googleCloudProjectId === "string" && settings.googleCloudProjectId) {
     await SecureStore.setItemAsync("ortho_google_drive_cloud_project_id", settings.googleCloudProjectId).catch(() => undefined);
   }
 }
 markInventoryResetDone();
 return stats;
}

export async function restoreEncryptedBackup(text:string,password:string){return restoreBackup(await decryptBackup(text,password));}
