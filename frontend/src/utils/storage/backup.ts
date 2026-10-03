import * as Crypto from "expo-crypto";
import { File } from "expo-file-system";
import * as ImageManipulator from "expo-image-manipulator";
import nacl from "tweetnacl";
import { db, initializeDatabase, markInventoryResetDone } from "@/src/db/database";

const BACKUP_VERSION = 5;
const BACKUP_APP = "Ortho Logbook";

type BackupData = {
  version:number; app:string; createdAt:string;
  patients:any[]; procedures:any[]; inventoryCategories:any[]; inventory:any[]; patientImplants:any[]; patientCustomFields:any[]; implantRecords:any[]; expenses:any[]; users:any[];
  patientHistory:any[]; inventoryMovements:any[];
  filter?: BackupFilter;
};
type EncryptedBackup = {
  version:number; app:string; encrypted:true; algorithm:"XSalsa20-Poly1305"; kdf:"SHA-256";
  createdAt:string; salt:string; nonce:string; ciphertext:string;
};

const bytesToHex=(b:Uint8Array)=>Array.from(b).map(x=>x.toString(16).padStart(2,"0")).join("");
function hexToBytes(hex:string){if(!hex||hex.length%2)throw new Error("Invalid encrypted backup data.");const b=new Uint8Array(hex.length/2);for(let i=0;i<b.length;i++){const n=parseInt(hex.slice(i*2,i*2+2),16);if(Number.isNaN(n))throw new Error("Invalid encrypted backup data.");b[i]=n;}return b;}
const stringToBytes=(v:string)=>new TextEncoder().encode(v);
const bytesToString=(b:Uint8Array)=>new TextDecoder().decode(b);
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
async function embedPhoto(uri:string):Promise<string>{
  if(!uri)return "";
  if(uri.startsWith("data:"))return uri;
  try{
    // Backup copies are deliberately made small: resize to max 1280px and
    // use strong JPEG compression. This does not change the patient's stored photo.
    const result=await ImageManipulator.manipulateAsync(
      uri,
      [{resize:{width:1280}}],
      {compress:0.25,format:ImageManipulator.SaveFormat.JPEG,base64:true}
    );
    if(!result.base64)throw new Error("Empty compressed photo.");
    return `data:image/jpeg;base64,${result.base64}`;
  }catch{
    throw new Error("Could not compress a patient photo for backup. Please make sure the photo is still available on this device and try again.");
  }
}

async function embedPatientPhotos(row:any){
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
  for(const uri of photos)embedded.push(await embedPhoto(uri));
  return {
    ...row,
    photo_uri: embedded[0] || "",
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

async function createBackupData(filter: BackupFilter = { type: "all" }):Promise<BackupData>{
 initializeDatabase();
 const pf=whereForFilter(filter, "date");
 const patients=db.getAllSync<any>(`SELECT * FROM patients${pf.sql} ORDER BY date DESC, created_at DESC`, pf.args);
 const selectedPatientIds = new Set(patients.map((p:any)=>p.id));
 const embeddedPatients:any[]=[];
 for(const patient of patients)embeddedPatients.push(await embedPatientPhotos(patient));

 const historyAll=db.getAllSync<any>("SELECT * FROM patient_history ORDER BY created_at ASC");
 const history=filter.type==="all" ? historyAll : historyAll.filter((h:any)=>selectedPatientIds.has(h.patient_id));
 // Keep history portable too when an old snapshot contains patient photos.
 const embeddedHistory=history.map((h:any)=>{
   try{
     const snap=JSON.parse(String(h.snapshot_json||""));
     if(snap && Array.isArray(snap.photos)) snap.photos=snap.photos.slice();
     if(snap && snap.photoUri && !snap.photos?.length) snap.photos=[snap.photoUri];
     return {...h,snapshot_json:JSON.stringify(snap)};
   }catch{return h;}
 });

 return {
  version:BACKUP_VERSION,app:BACKUP_APP,createdAt:new Date().toISOString(),
  patients:embeddedPatients,
  procedures:db.getAllSync<any>("SELECT * FROM procedures ORDER BY name COLLATE NOCASE"),
  inventoryCategories:db.getAllSync<any>("SELECT * FROM inventory_categories ORDER BY name COLLATE NOCASE"),
  inventory:db.getAllSync<any>("SELECT id,name,category_id,category,size,quantity,unit,minimum_stock FROM inventory ORDER BY COALESCE(category,''),name COLLATE NOCASE,COALESCE(size,'')"),
  patientImplants:db.getAllSync<any>("SELECT * FROM patient_implants ORDER BY created_at ASC"),
  patientCustomFields:db.getAllSync<any>("SELECT * FROM patient_custom_fields ORDER BY sort_order ASC,label COLLATE NOCASE"),
  implantRecords:db.getAllSync<any>("SELECT * FROM implant_records ORDER BY created_at ASC"),
  expenses:(()=>{const f=whereForFilter(filter,"date");return db.getAllSync<any>(`SELECT * FROM expenses${f.sql} ORDER BY date DESC, created_at DESC`,f.args);})(),
  users:db.getAllSync<any>("SELECT * FROM users ORDER BY created_at ASC"),
  patientHistory:embeddedHistory,
  inventoryMovements:(()=>{if(filter.type==="all") return db.getAllSync<any>("SELECT * FROM inventory_movements ORDER BY created_at ASC"); const f=filter.type==="date" ? {sql:" WHERE date(created_at)=?",args:[filter.value||""]} : filter.type==="month" ? {sql:" WHERE created_at LIKE ?",args:[`${filter.value||""}-%`]} : {sql:" WHERE created_at LIKE ?",args:[`${filter.value||""}-%`]}; return db.getAllSync<any>(`SELECT * FROM inventory_movements${f.sql} ORDER BY created_at ASC`,f.args);})(),
 };
}

export async function exportBackup(password:string, filter: BackupFilter = { type: "all" }):Promise<string>{
 const backup=await createBackupData(filter);
 backup.filter = filter;
 const salt=await Crypto.getRandomBytesAsync(16);
 const nonce=await Crypto.getRandomBytesAsync(nacl.secretbox.nonceLength);
 const key=await deriveKey(password,salt);
 const ciphertext=nacl.secretbox(stringToBytes(JSON.stringify(backup)),nonce,key);
 return JSON.stringify({version:BACKUP_VERSION,app:BACKUP_APP,encrypted:true,algorithm:"XSalsa20-Poly1305",kdf:"SHA-256",createdAt:backup.createdAt,salt:bytesToHex(salt),nonce:bytesToHex(nonce),ciphertext:bytesToHex(ciphertext)} satisfies EncryptedBackup);
}

function parseHeader(text:string):EncryptedBackup{
 let b:any;try{b=JSON.parse(text);}catch{throw new Error("The selected backup file is not valid.");}
 if(!b||![2,3,4,5].includes(b.version)||b.app!==BACKUP_APP||b.encrypted!==true||b.algorithm!=="XSalsa20-Poly1305"||b.kdf!=="SHA-256")throw new Error("Invalid or unsupported Ortho Logbook backup.");
 if(!b.createdAt||!b.salt||!b.nonce||!b.ciphertext)throw new Error("The backup file is incomplete or damaged.");
 return b;
}
export function getBackupInfo(text:string){const b=parseHeader(text);return {createdAt:b.createdAt,encrypted:true,version:b.version,includesPhotos:b.version>=3};}

export async function decryptBackup(text:string,password:string):Promise<BackupData>{
 const b=parseHeader(text);
 try{
  const key=await deriveKey(password,hexToBytes(b.salt));
  const plain=nacl.secretbox.open(hexToBytes(b.ciphertext),hexToBytes(b.nonce),key);
  if(!plain)throw new Error("Incorrect backup password or damaged backup.");
  const data=JSON.parse(bytesToString(plain)) as BackupData;
  if(!data||![2,3,4,5].includes(data.version)||data.app!==BACKUP_APP)throw new Error("The decrypted backup is invalid.");
  for(const keyName of ["patients","procedures","inventory","expenses","users","patientHistory","inventoryMovements"]){
    if(!Array.isArray((data as any)[keyName]))throw new Error("The backup is incomplete or damaged.");
  }
  // v2/v3 backups did not contain these relational inventory tables.
  data.inventoryCategories=Array.isArray((data as any).inventoryCategories) ? (data as any).inventoryCategories : [];
  data.patientImplants=Array.isArray((data as any).patientImplants) ? (data as any).patientImplants : [];
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
  return {photoUri:primary,photosJson:photos.length?JSON.stringify(photos):null};
}

export function restoreBackup(backup:BackupData){
 initializeDatabase({ skipInventoryReset: true });
 if(!backup||![2,3,4].includes(backup.version)||backup.app!==BACKUP_APP)throw new Error("Invalid Ortho Logbook backup.");
 db.withTransactionSync(()=>{
  db.runSync("DELETE FROM inventory_movements"); db.runSync("DELETE FROM patient_implants"); db.runSync("DELETE FROM patient_history"); db.runSync("DELETE FROM expenses"); db.runSync("DELETE FROM patients"); db.runSync("DELETE FROM procedures"); db.runSync("DELETE FROM inventory"); db.runSync("DELETE FROM inventory_categories"); db.runSync("DELETE FROM users");
  for(const p of backup.patients){
   const photos=restorePatientPhotos(p);
   db.runSync("INSERT INTO patients (id,mr_no,name,gender,age,diagnosis,procedure,implant,implant_ii,implant_id,implant_ii_id,address,file_name,photo_uri,photos_json,date,created_at,created_by,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",[p.id,p.mr_no,p.name,p.gender||"",p.age||"",p.diagnosis||"",p.procedure||"",p.implant||"",p.implant_ii||"",p.implant_id||null,p.implant_ii_id||null,p.address||"",p.file_name||"",photos.photoUri,photos.photosJson,p.date,p.created_at,p.created_by||null,p.updated_at||null,p.updated_by||null]);
  }
  for(const p of backup.procedures) db.runSync("INSERT INTO procedures (id,name) VALUES (?,?)",[p.id,p.name]);
  for(const f of backup.patientCustomFields||[]){
    db.runSync("INSERT OR REPLACE INTO patient_custom_fields (id,key,label,type,sort_order,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",[f.id,f.key,f.label,f.type||"text",Number(f.sort_order||0),Number(f.enabled??1),f.created_at||new Date().toISOString(),f.updated_at||f.created_at||new Date().toISOString()]);
  }
  const categoryIds=new Map<string,string>();
  for(const c of backup.inventoryCategories||[]){
    const cid=String(c.id);
    db.runSync("INSERT INTO inventory_categories (id,name,created_at) VALUES (?,?,?)",[cid,c.name,c.created_at||new Date().toISOString()]);
    categoryIds.set(String(c.name||"").toLowerCase(),cid);
  }
  for(const i of backup.inventory){
    let cid=i.category_id||categoryIds.get(String(i.category||"").toLowerCase())||null;
    if(!cid && i.category){
      cid=Math.random().toString(36).slice(2)+Date.now().toString(36);
      db.runSync("INSERT INTO inventory_categories (id,name,created_at) VALUES (?,?,?)",[cid,i.category,new Date().toISOString()]);
      categoryIds.set(String(i.category).toLowerCase(),cid);
    }
    db.runSync("INSERT INTO inventory (id,name,category_id,category,size,quantity,unit,minimum_stock) VALUES (?,?,?,?,?,?,?,?)",[i.id,i.name,cid,i.category||"",i.size||"",Number(i.quantity||0),i.unit||"pcs",Number(i.minimum_stock||0)]);
  }
  // Restore patient inventory selections without creating duplicate rows.
  // Older backups/restore versions could contain the same patient + implant more
  // than once. Combine identical selections into one row and keep the quantity.
  for(const pi of backup.patientImplants||[]){
    const patientId=String(pi.patient_id||"");
    const inventoryId=String(pi.inventory_id||"");
    const name=String(pi.name||"").trim();
    const category=String(pi.category||"").trim();
    const size=String(pi.size||"").trim();
    const qty=Math.max(1,Number(pi.quantity)||1);
    const existing=db.getFirstSync<any>(
      "SELECT id,quantity FROM patient_implants WHERE patient_id=? AND COALESCE(inventory_id,'')=? AND LOWER(TRIM(COALESCE(name,'')))=LOWER(?) AND LOWER(TRIM(COALESCE(category,'')))=LOWER(?) AND LOWER(TRIM(COALESCE(size,'')))=LOWER(?) LIMIT 1",
      [patientId,inventoryId,name,category,size]
    );
    if(existing){
      db.runSync("UPDATE patient_implants SET quantity=? WHERE id=?",[Number(existing.quantity||0)+qty,existing.id]);
      continue;
    }
    db.runSync("INSERT INTO patient_implants (id,patient_id,inventory_id,name,category,size,quantity,created_at) VALUES (?,?,?,?,?,?,?,?)",[pi.id,patientId,pi.inventory_id||null,name,pi.category||null,pi.size||null,qty,pi.created_at]);
  }
  for(const rec of backup.implantRecords||[]){
    db.runSync("INSERT INTO implant_records (id,name,category,size,manufacturer,model,lot_number,serial_number,expiry_date,supplier,quantity,unit,purchase_price,notes,bill_files_json,created_at,updated_at,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [rec.id,rec.name,rec.category||"",rec.size||"",rec.manufacturer||"",rec.model||"",rec.lot_number||"",rec.serial_number||"",rec.expiry_date||"",rec.supplier||"",Number(rec.quantity||0),rec.unit||"pcs",Number(rec.purchase_price||0),rec.notes||"",rec.bill_files_json||"[]",rec.created_at,rec.updated_at||rec.created_at,rec.created_by||null,rec.updated_by||null]);
  }
  for(const e of backup.expenses (id,description,amount,belongs_to,doctor_id,date,created_at) VALUES (?,?,?,?,?,?,?)",[e.id,e.description,Number(e.amount||0),e.belongs_to||"hospital",e.doctor_id||null,e.date,e.created_at]);
  for(const u of backup.users) db.runSync("INSERT INTO users (id,email,name,password_hash,recovery_code,role,can_edit_patients,disabled,created_at) VALUES (?,?,?,?,?,?,?,?,?)",[u.id,u.email,u.name,u.password_hash,u.recovery_code||null,u.role||"doctor",Number(u.can_edit_patients??1),Number(u.disabled??0),u.created_at]);
  for(const h of backup.patientHistory) db.runSync("INSERT INTO patient_history (id,patient_id,user_id,action,snapshot_json,created_at) VALUES (?,?,?,?,?,?)",[h.id,h.patient_id,h.user_id||null,h.action,h.snapshot_json,h.created_at]);
  for(const m of backup.inventoryMovements) db.runSync("INSERT INTO inventory_movements (id,inventory_id,user_id,type,amount,quantity_after,note,created_at) VALUES (?,?,?,?,?,?,?,?)",[m.id,m.inventory_id,m.user_id||null,m.type,Number(m.amount||0),Number(m.quantity_after||0),m.note||null,m.created_at]);
 });
 markInventoryResetDone();
 return {patients:backup.patients.length,procedures:backup.procedures.length,inventory:backup.inventory.length,expenses:backup.expenses.length,users:backup.users.length,patientHistory:backup.patientHistory.length,inventoryMovements:backup.inventoryMovements.length};
}

// Merge mode: add records from an incoming backup without wiping current data.
// - Rows with the same primary-key id are always skipped, making repeated
//   imports of the same backup idempotent.
// - Inventory items from a different source phone can still be combined by
//   matching name + category + size and summing quantities.
export function mergeBackup(backup: BackupData) {
 initializeDatabase({ skipInventoryReset: true });
 if(!backup||![2,3,4].includes(backup.version)||backup.app!==BACKUP_APP)throw new Error("Invalid Ortho Logbook backup.");
 const stats = { patients: 0, procedures: 0, inventory: 0, expenses: 0, users: 0, patientHistory: 0, inventoryMovements: 0 };
 db.withTransactionSync(() => {
  const has = (table: string, id: string) => !!db.getFirstSync<any>(`SELECT id FROM ${table} WHERE id=?`, [id]);
  for (const p of backup.patients) {
   if (has("patients", p.id)) continue;
   const photos=restorePatientPhotos(p);
   db.runSync("INSERT INTO patients (id,mr_no,name,gender,age,diagnosis,procedure,implant,implant_ii,implant_id,implant_ii_id,address,file_name,photo_uri,photos_json,date,created_at,created_by,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",[p.id,p.mr_no,p.name,p.gender||"",p.age||"",p.diagnosis||"",p.procedure||"",p.implant||"",p.implant_ii||"",p.implant_id||null,p.implant_ii_id||null,p.address||"",p.file_name||"",photos.photoUri,photos.photosJson,p.date,p.created_at,p.created_by||null,p.updated_at||null,p.updated_by||null]);
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
    db.runSync("INSERT INTO inventory (id,name,category_id,category,size,quantity,unit,minimum_stock) VALUES (?,?,?,?,?,?,?,?)", [i.id, i.name, categoryId, categoryName, i.size||"", Number(i.quantity||0), i.unit||"pcs", Number(i.minimum_stock||0)]);
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
  for (const m of backup.inventoryMovements) {
   if (has("inventory_movements", m.id)) continue;
   db.runSync("INSERT INTO inventory_movements (id,inventory_id,user_id,type,amount,quantity_after,note,created_at) VALUES (?,?,?,?,?,?,?,?)", [m.id,m.inventory_id,m.user_id||null,m.type,Number(m.amount||0),Number(m.quantity_after||0),m.note||null,m.created_at]);
   stats.inventoryMovements++;
  }
 });
 markInventoryResetDone();
 return stats;
}

export async function restoreEncryptedBackup(text:string,password:string){return restoreBackup(await decryptBackup(text,password));}
