import * as Crypto from "expo-crypto";
import nacl from "tweetnacl";
import { db, initializeDatabase } from "@/src/db/database";

const BACKUP_VERSION = 2;
const BACKUP_APP = "Ortho Logbook";

type BackupData = {
  version:number; app:string; createdAt:string;
  patients:any[]; procedures:any[]; inventory:any[]; expenses:any[]; users:any[];
  patientHistory:any[]; inventoryMovements:any[];
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

function createBackupData():BackupData{
 initializeDatabase();
 return {
  version:BACKUP_VERSION,app:BACKUP_APP,createdAt:new Date().toISOString(),
  patients:db.getAllSync<any>("SELECT * FROM patients ORDER BY date DESC, created_at DESC"),
  procedures:db.getAllSync<any>("SELECT * FROM procedures ORDER BY name COLLATE NOCASE"),
  inventory:db.getAllSync<any>("SELECT * FROM inventory ORDER BY name COLLATE NOCASE"),
  expenses:db.getAllSync<any>("SELECT * FROM expenses ORDER BY date DESC, created_at DESC"),
  users:db.getAllSync<any>("SELECT * FROM users ORDER BY created_at ASC"),
  patientHistory:db.getAllSync<any>("SELECT * FROM patient_history ORDER BY created_at ASC"),
  inventoryMovements:db.getAllSync<any>("SELECT * FROM inventory_movements ORDER BY created_at ASC"),
 };
}

export async function exportBackup(password:string):Promise<string>{
 const backup=createBackupData(); const salt=await Crypto.getRandomBytesAsync(16); const nonce=await Crypto.getRandomBytesAsync(nacl.secretbox.nonceLength);
 const key=await deriveKey(password,salt); const ciphertext=nacl.secretbox(stringToBytes(JSON.stringify(backup)),nonce,key);
 return JSON.stringify({version:BACKUP_VERSION,app:BACKUP_APP,encrypted:true,algorithm:"XSalsa20-Poly1305",kdf:"SHA-256",createdAt:backup.createdAt,salt:bytesToHex(salt),nonce:bytesToHex(nonce),ciphertext:bytesToHex(ciphertext)} satisfies EncryptedBackup);
}

function parseHeader(text:string):EncryptedBackup{
 let b:any;try{b=JSON.parse(text);}catch{throw new Error("The selected backup file is not valid.");}
 if(!b||b.version!==BACKUP_VERSION||b.app!==BACKUP_APP||b.encrypted!==true||b.algorithm!=="XSalsa20-Poly1305"||b.kdf!=="SHA-256")throw new Error("Invalid or unsupported Ortho Logbook backup.");
 if(!b.createdAt||!b.salt||!b.nonce||!b.ciphertext)throw new Error("The backup file is incomplete or damaged.");
 return b;
}
export function getBackupInfo(text:string){const b=parseHeader(text);return {createdAt:b.createdAt,encrypted:true,version:b.version};}

export async function decryptBackup(text:string,password:string):Promise<BackupData>{
 const b=parseHeader(text);
 try{
  const key=await deriveKey(password,hexToBytes(b.salt));
  const plain=nacl.secretbox.open(hexToBytes(b.ciphertext),hexToBytes(b.nonce),key);
  if(!plain)throw new Error("Incorrect backup password or damaged backup.");
  const data=JSON.parse(bytesToString(plain)) as BackupData;
  if(!data||data.version!==BACKUP_VERSION||data.app!==BACKUP_APP)throw new Error("The decrypted backup is invalid.");
  for(const keyName of ["patients","procedures","inventory","expenses","users","patientHistory","inventoryMovements"]){if(!Array.isArray((data as any)[keyName]))throw new Error("The backup is incomplete or damaged.");}
  return data;
 }catch(e){if(e instanceof Error&&e.message.includes("Incorrect backup password"))throw e;throw new Error("Unable to decrypt backup. Check the password and backup file.");}
}

export function restoreBackup(backup:BackupData){
 initializeDatabase();
 if(!backup||backup.version!==BACKUP_VERSION||backup.app!==BACKUP_APP)throw new Error("Invalid Ortho Logbook backup.");
 db.withTransactionSync(()=>{
  db.runSync("DELETE FROM inventory_movements"); db.runSync("DELETE FROM patient_history"); db.runSync("DELETE FROM expenses"); db.runSync("DELETE FROM patients"); db.runSync("DELETE FROM procedures"); db.runSync("DELETE FROM inventory"); db.runSync("DELETE FROM users");
  for(const p of backup.patients) db.runSync("INSERT INTO patients (id,mr_no,name,gender,age,diagnosis,procedure,implant,implant_ii,address,file_name,photo_uri,photos_json,date,created_at,created_by,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",[p.id,p.mr_no,p.name,p.gender||"",p.age||"",p.diagnosis||"",p.procedure||"",p.implant||"",p.implant_ii||"",p.address||"",p.file_name||"",p.photo_uri||"",p.photos_json||null,p.date,p.created_at,p.created_by||null,p.updated_at||null,p.updated_by||null]);
  for(const p of backup.procedures) db.runSync("INSERT INTO procedures (id,name) VALUES (?,?)",[p.id,p.name]);
  for(const i of backup.inventory) db.runSync("INSERT INTO inventory (id,name,quantity,unit,minimum_stock) VALUES (?,?,?,?,?)",[i.id,i.name,Number(i.quantity||0),i.unit||"pcs",Number(i.minimum_stock||0)]);
  for(const e of backup.expenses) db.runSync("INSERT INTO expenses (id,description,amount,belongs_to,doctor_id,date,created_at) VALUES (?,?,?,?,?,?,?)",[e.id,e.description,Number(e.amount||0),e.belongs_to||"hospital",e.doctor_id||null,e.date,e.created_at]);
  for(const u of backup.users) db.runSync("INSERT INTO users (id,email,name,password_hash,recovery_code,role,can_edit_patients,disabled,created_at) VALUES (?,?,?,?,?,?,?,?,?)",[u.id,u.email,u.name,u.password_hash,u.recovery_code||null,u.role||"doctor",Number(u.can_edit_patients??1),Number(u.disabled??0),u.created_at]);
  for(const h of backup.patientHistory) db.runSync("INSERT INTO patient_history (id,patient_id,user_id,action,snapshot_json,created_at) VALUES (?,?,?,?,?,?)",[h.id,h.patient_id,h.user_id||null,h.action,h.snapshot_json,h.created_at]);
  for(const m of backup.inventoryMovements) db.runSync("INSERT INTO inventory_movements (id,inventory_id,user_id,type,amount,quantity_after,note,created_at) VALUES (?,?,?,?,?,?,?,?)",[m.id,m.inventory_id,m.user_id||null,m.type,Number(m.amount||0),Number(m.quantity_after||0),m.note||null,m.created_at]);
 });
 return {patients:backup.patients.length,procedures:backup.procedures.length,inventory:backup.inventory.length,expenses:backup.expenses.length,users:backup.users.length,patientHistory:backup.patientHistory.length,inventoryMovements:backup.inventoryMovements.length};
}

// Merge mode: add records from an incoming backup without wiping current data.
// - Rows with same PK id are skipped (idempotent).
// - Inventory items with the same name (case-insensitive) sum quantities so
//   multiple phones' new stock does not overwrite each other.
export function mergeBackup(backup: BackupData) {
 initializeDatabase();
 if(!backup||backup.version!==BACKUP_VERSION||backup.app!==BACKUP_APP)throw new Error("Invalid Ortho Logbook backup.");
 const stats = { patients: 0, procedures: 0, inventory: 0, expenses: 0, users: 0, patientHistory: 0, inventoryMovements: 0 };
 db.withTransactionSync(() => {
  const has = (table: string, id: string) => !!db.getFirstSync<any>(`SELECT id FROM ${table} WHERE id=?`, [id]);
  for (const p of backup.patients) {
   if (has("patients", p.id)) continue;
   db.runSync("INSERT INTO patients (id,mr_no,name,gender,age,diagnosis,procedure,implant,implant_ii,address,file_name,photo_uri,photos_json,date,created_at,created_by,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",[p.id,p.mr_no,p.name,p.gender||"",p.age||"",p.diagnosis||"",p.procedure||"",p.implant||"",p.implant_ii||"",p.address||"",p.file_name||"",p.photo_uri||"",p.photos_json||null,p.date,p.created_at,p.created_by||null,p.updated_at||null,p.updated_by||null]);
   stats.patients++;
  }
  for (const p of backup.procedures) {
   const existing = db.getFirstSync<any>("SELECT id FROM procedures WHERE LOWER(name)=LOWER(?) LIMIT 1", [p.name]);
   if (existing) continue;
   try { db.runSync("INSERT INTO procedures (id,name) VALUES (?,?)", [p.id, p.name]); stats.procedures++; } catch {}
  }
  for (const i of backup.inventory) {
   const existing = db.getFirstSync<any>("SELECT id,quantity,minimum_stock FROM inventory WHERE LOWER(name)=LOWER(?) LIMIT 1", [i.name]);
   if (existing) {
    const q = Number(existing.quantity || 0) + Number(i.quantity || 0);
    db.runSync("UPDATE inventory SET quantity=?,minimum_stock=? WHERE id=?", [q, Math.max(Number(existing.minimum_stock||0), Number(i.minimum_stock||0)), existing.id]);
   } else {
    db.runSync("INSERT INTO inventory (id,name,quantity,unit,minimum_stock) VALUES (?,?,?,?,?)", [i.id, i.name, Number(i.quantity||0), i.unit||"pcs", Number(i.minimum_stock||0)]);
   }
   stats.inventory++;
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
   db.runSync("INSERT INTO inventory_movements (id,inventory_id,user_id,type,amount,quantity_after,note,created_at) VALUES (?,?,?,?,?,?,?,?)", [m.id, m.inventory_id, m.user_id||null, m.type, Number(m.amount||0), Number(m.quantity_after||0), m.note||null, m.created_at]);
   stats.inventoryMovements++;
  }
 });
 return stats;
}

export async function restoreEncryptedBackup(text:string,password:string){return restoreBackup(await decryptBackup(text,password));}
