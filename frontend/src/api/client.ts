import * as Crypto from "expo-crypto";
import { db, initializeDatabase } from "@/src/db/database";
import { storage } from "@/src/utils/storage";

const id = () => Crypto.randomUUID();
const nowIso = () => new Date().toISOString();
const normalizeRoute = (path: string) => String(path || "").replace(/\/+$/, "").split("?")[0] || "/";
const currentUser = async () => {
  const uid = await storage.secureGet("ortho_current_user", null);
  return typeof uid === "string" ? uid : null;
};
async function currentUserRow() {
  const uid = await currentUser();
  if (!uid) return null;
  return db.getFirstSync<any>(
    "SELECT id,role,can_edit_patients FROM users WHERE id=? AND disabled=0 LIMIT 1",
    [uid],
  );
}
async function requireAdmin() {
  const me = await currentUserRow();
  if (me?.role !== "admin") throw new Error("Administrator permission required.");
  return me;
}

export type Patient = {
  id: string; mrNo: string; name: string; gender: string; age: string;
  diagnosis: string; procedure: string; implant: string; implantII: string; implantId?: string; implantIIId?: string;
  address: string; fileName: string; photoUri: string; photos: string[]; date: string;
  createdAt?: string; createdBy?: string; updatedAt?: string; updatedBy?: string;
  operationCount?: number; // Nth-time operated (1 = first, 2 = 2nd time, ...)
  totalOperations?: number; // total ops on this same identity
  customData?: Record<string, string>;
};

function parsePhotos(raw: any, legacyUri: string | null | undefined): string[] {
  if (!raw) return legacyUri ? [String(legacyUri)] : [];
  try {
    const arr = JSON.parse(String(raw));
    if (Array.isArray(arr)) return arr.filter((x) => typeof x === "string" && x.length > 0);
  } catch {}
  return legacyUri ? [String(legacyUri)] : [];
}

const fromPatient = (r: any): Patient => {
  const photos = parsePhotos(r.photos_json, r.photo_uri);
  return {
    id: r.id, mrNo: r.mr_no, name: r.name || "", gender: r.gender || "",
    age: r.age || "", diagnosis: r.diagnosis || "", procedure: r.procedure || "",
    implant: r.implant || "", implantII: r.implant_ii || "", implantId: r.implant_id || "", implantIIId: r.implant_ii_id || "", address: r.address || "",
    fileName: r.file_name || "", photoUri: photos[0] || "", photos,
    date: r.date, createdAt: r.created_at, createdBy: r.created_by,
    updatedAt: r.updated_at, updatedBy: r.updated_by,
    customData: (() => { try { const v=JSON.parse(String(r.custom_data_json||"{}")); return v && typeof v==="object" ? v : {}; } catch { return {}; } })(),
  };
};

const snapshot = (p: any) => JSON.stringify(p);

function movement(inventoryId: string, type: string, amount: number, quantityAfter: number, note: string, userId: string | null) {
  db.runSync(
    "INSERT INTO inventory_movements (id,inventory_id,user_id,type,amount,quantity_after,note,created_at) VALUES (?,?,?,?,?,?,?,?)",
    [id(), inventoryId, userId, type, amount, quantityAfter, note, nowIso()],
  );
}

function changeInventory(name: string, amount: number, type: string, note: string, userId: string | null, inventoryId?: string) {
  const clean = String(name || "").trim();
  if (!clean || !amount) return;
  const item = inventoryId
    ? db.getFirstSync<any>("SELECT id,name,quantity FROM inventory WHERE id=? LIMIT 1",[inventoryId])
    : db.getFirstSync<any>("SELECT id,quantity FROM inventory WHERE LOWER(name)=LOWER(?) LIMIT 1",[clean]);
  if (!item) {
    if (amount < 0) throw new Error(`Implant "${clean}" is not available in inventory.`);
    return;
  }
  const current = Number(item.quantity) || 0;
  const q = current + amount;
  if (q < 0) throw new Error(`Insufficient stock for "${clean}". Available: ${current}.`);
  db.runSync("UPDATE inventory SET quantity=? WHERE id=?", [q, item.id]);
  movement(item.id, type, amount, q, note, userId);
}

function selectedImplants(p: Patient) {
  const list = Array.isArray((p as any).implants) ? (p as any).implants : [];
  if (list.length) return list.map((x:any) => ({
    id: String(x.id || id()),
    inventoryId: x.inventoryId ? String(x.inventoryId) : undefined,
    name: String(x.name || "").trim(),
    category: String(x.category || "").trim(),
    size: String(x.size || "").trim(),
    quantity: Math.max(1, Number(x.quantity) || 1),
  })).filter((x:any) => x.name);
  const legacy = [[p.implant,p.implantId],[p.implantII,p.implantIIId]];
  return legacy.map(([name, inventoryId]) => ({
    id: id(), inventoryId: inventoryId ? String(inventoryId) : undefined,
    name: String(name || "").trim(), category:"", size:"", quantity:1,
  })).filter((x:any) => x.name);
}

function validateImplants(p: Patient) {
  const required = new Map<string, { name:string; inventoryId?:string; count:number }>();
  for (const x of selectedImplants(p)) {
    const key = x.inventoryId || x.name.toLowerCase();
    const prev = required.get(key);
    required.set(key, { name:x.name, inventoryId:x.inventoryId, count:(prev?.count || 0) + x.quantity });
  }
  for (const req of required.values()) {
    const item = req.inventoryId
      ? db.getFirstSync<any>("SELECT name,quantity FROM inventory WHERE id=? LIMIT 1",[req.inventoryId])
      : db.getFirstSync<any>("SELECT name,quantity FROM inventory WHERE LOWER(name)=? LIMIT 1",[req.name.toLowerCase()]);
    if (!item) throw new Error(`Implant "${req.name}" is not available in inventory.`);
    const available = Number(item.quantity) || 0;
    if (available < req.count) throw new Error(`Insufficient stock for "${item.name}". Available: ${available}, required: ${req.count}.`);
  }
}

function deduct(p: Patient, userId: string | null) {
  for (const x of selectedImplants(p)) {
    changeInventory(x.name, -x.quantity, "patient-use", `Used by patient ${p.mrNo || p.name}`, userId, x.inventoryId);
  }
}

function restoreStock(p: Patient, userId: string | null) {
  for (const x of selectedImplants(p)) {
    changeInventory(x.name, x.quantity, "patient-return", `Returned from patient ${p.mrNo || p.name}`, userId, x.inventoryId);
  }
}

function deletePatientRows(ids: string[], me: any) {
  const cleanIds = [...new Set(ids.map(String).filter(Boolean))];
  if (!cleanIds.length) return 0;
  let deletedCount = 0;

  db.withTransactionSync(() => {
    const placeholders = cleanIds.map(() => "?").join(",");
    const rows = db.getAllSync<any>(
      `SELECT * FROM patients WHERE id IN (${placeholders})`,
      cleanIds,
    );
    const allowed = rows.filter((p: any) => me.role === "admin" || p.created_by === me.id);

    for (const patient of allowed) {
      restoreStock(hydratePatientImplants(patient.id, fromPatient(patient)), me.id);
      db.runSync(
        "INSERT INTO patient_history (id,patient_id,user_id,action,snapshot_json,created_at) VALUES (?,?,?,?,?,?)",
        [id(), patient.id, me.id, "delete", snapshot(fromPatient(patient)), nowIso()],
      );
    }

    const allowedIds = allowed.map((p: any) => p.id);
    if (!allowedIds.length) return;

    const allowedPlaceholders = allowedIds.map(() => "?").join(",");
    // A hard delete must remove the relational inventory selections as well.
    // Otherwise deleted patients can still appear in inventory usage/backup data.
    db.runSync(
      `DELETE FROM patient_implants WHERE patient_id IN (${allowedPlaceholders})`,
      allowedIds,
    );
    db.runSync(
      `DELETE FROM patients WHERE id IN (${allowedPlaceholders})`,
      allowedIds,
    );

    const remaining = Number(
      db.getFirstSync<any>(
        `SELECT COUNT(*) AS n FROM patients WHERE id IN (${allowedPlaceholders})`,
        allowedIds,
      )?.n || 0,
    );
    if (remaining > 0) throw new Error("Patient deletion did not complete.");
    deletedCount = allowed.length;
  });

  return deletedCount;
}

function deleteInventoryRows(ids: string[]) {
  const cleanIds = [...new Set(ids.map(String).filter(Boolean))];
  if (!cleanIds.length) return 0;
  let deletedCount = 0;

  db.withTransactionSync(() => {
    const placeholders = cleanIds.map(() => "?").join(",");
    const rows = db.getAllSync<any>(
      `SELECT id FROM inventory WHERE id IN (${placeholders})`,
      cleanIds,
    );
    if (!rows.length) return;

    // Detach patient selections first so deleted inventory IDs can never
    // resurrect through relational/backup data.
    db.runSync(
      `UPDATE patient_implants SET inventory_id=NULL WHERE inventory_id IN (${placeholders})`,
      cleanIds,
    );
    db.runSync(
      `DELETE FROM inventory_movements WHERE inventory_id IN (${placeholders})`,
      cleanIds,
    );
    db.runSync(
      `DELETE FROM inventory WHERE id IN (${placeholders})`,
      cleanIds,
    );

    const remaining = Number(
      db.getFirstSync<any>(
        `SELECT COUNT(*) AS n FROM inventory WHERE id IN (${placeholders})`,
        cleanIds,
      )?.n || 0,
    );
    if (remaining > 0) throw new Error("Inventory deletion did not complete.");
    deletedCount = rows.length;
  });

  return deletedCount;
}

function hydratePatientImplants(patientId:string, p:Patient): Patient {
  const rows = db.getAllSync<any>(
    "SELECT id,inventory_id,name,category,size,quantity FROM patient_implants WHERE patient_id=? ORDER BY created_at ASC",
    [patientId],
  );
  if (rows.length) {
    (p as any).implants = rows.map((x:any) => ({
      id:x.id, inventoryId:x.inventory_id || "", name:x.name || "",
      category:x.category || "", size:x.size || "", quantity:Number(x.quantity || 1),
    }));
  }
  return p;
}

function replacePatientImplants(patientId:string, p:Patient) {
  db.runSync("DELETE FROM patient_implants WHERE patient_id=?",[patientId]);
  for (const x of selectedImplants(p)) {
    db.runSync(
      "INSERT INTO patient_implants (id,patient_id,inventory_id,name,category,size,quantity,created_at) VALUES (?,?,?,?,?,?,?,?)",
      [x.id,patientId,x.inventoryId||null,x.name,x.category||null,x.size||null,x.quantity,nowIso()]
    );
  }
}

async function canEdit(): Promise<boolean> {
  const me = await currentUserRow();
  return !!me && (me.role === "admin" || Number(me.can_edit_patients) === 1);
}

// Non-admins can only touch records they created. Admins can touch any record.
async function assertRecordAccess(recordCreatedBy: string | null | undefined) {
  const me = await currentUserRow();
  if (!me) throw new Error("Not signed in.");
  if (me.role === "admin") return me;
  if (!recordCreatedBy || recordCreatedBy !== me.id) {
    throw new Error("You can only modify records you created.");
  }
  return me;
}

function serializePhotos(p: Patient): string {
  const list = Array.isArray(p.photos) && p.photos.length ? p.photos : (p.photoUri ? [p.photoUri] : []);
  return JSON.stringify(list);
}

async function savePatient(p: Patient, editing: boolean) {
  const uid = await currentUser();
  if (editing && !(await canEdit())) throw new Error("You do not have permission to edit patient records.");
  const now = nowIso();
  const patientId = p.id || id();
  const photosJson = serializePhotos(p);
  const primaryPhoto = (Array.isArray(p.photos) && p.photos[0]) || p.photoUri || "";

  if (editing) {
    return db.withTransactionSync(() => {
      const old = db.getFirstSync<any>("SELECT * FROM patients WHERE id=?", [patientId]);
      if (!old) throw new Error("Patient not found.");
      // Ownership check for non-admins (sync inside transaction: we already ran assertRecordAccess above? No -- do it here using a sync fetch of current user role).
      restoreStock(hydratePatientImplants(patientId, fromPatient(old)), uid);
      validateImplants(p);
      db.runSync(
        "UPDATE patients SET mr_no=?,name=?,gender=?,age=?,diagnosis=?,procedure=?,implant=?,implant_ii=?,implant_id=?,implant_ii_id=?,address=?,file_name=?,photo_uri=?,photos_json=?,custom_data_json=?,date=?,updated_at=?,updated_by=? WHERE id=?",
        [p.mrNo, p.name, p.gender, p.age, p.diagnosis, p.procedure, p.implant, p.implantII, p.implantId || null, p.implantIIId || null, p.address, p.fileName, primaryPhoto, photosJson, JSON.stringify((p as any).customData || {}), p.date, now, uid, patientId],
      );
      db.runSync(
        "INSERT INTO patient_history (id,patient_id,user_id,action,snapshot_json,created_at) VALUES (?,?,?,?,?,?)",
        [id(), patientId, uid, "edit", snapshot(fromPatient(old)), now],
      );
      deduct({ ...p, id: patientId }, uid);
      replacePatientImplants(patientId, p);
      return { ...p, id: patientId };
    });
  }

  validateImplants(p);
  db.runSync(
    "INSERT INTO patients (id,mr_no,name,gender,age,diagnosis,procedure,implant,implant_ii,implant_id,implant_ii_id,address,file_name,photo_uri,photos_json,custom_data_json,date,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [patientId, p.mrNo, p.name, p.gender, p.age, p.diagnosis, p.procedure, p.implant, p.implantII, p.implantId || null, p.implantIIId || null, p.address, p.fileName, primaryPhoto, photosJson, JSON.stringify((p as any).customData || {}), p.date, now, uid],
  );
  db.runSync(
    "INSERT INTO patient_history (id,patient_id,user_id,action,snapshot_json,created_at) VALUES (?,?,?,?,?,?)",
    [id(), patientId, uid, "create", snapshot(p), now],
  );
  deduct({ ...p, id: patientId }, uid);
  replacePatientImplants(patientId, p);
  return { ...p, id: patientId };
}

async function listPatients(): Promise<Patient[]> {
  const me = await currentUserRow();
  if (!me) return [];
  const rows = me.role === "admin"
    ? db.getAllSync<any>("SELECT * FROM patients ORDER BY date DESC, created_at DESC")
    : db.getAllSync<any>("SELECT * FROM patients WHERE created_by=? ORDER BY date DESC, created_at DESC", [me.id]);
  const patients = rows.map(fromPatient);
  if (patients.length) {
    const ids = patients.map((p) => p.id);
    const placeholders = ids.map(() => "?").join(",");
    const implantRows = db.getAllSync<any>(
      `SELECT id,patient_id,inventory_id,name,category,size,quantity FROM patient_implants
       WHERE patient_id IN (${placeholders}) ORDER BY created_at ASC`,
      ids,
    );
    const byPatient = new Map<string, any[]>();
    for (const x of implantRows) {
      const list = byPatient.get(x.patient_id) || [];
      list.push({
        id:x.id, inventoryId:x.inventory_id || "", name:x.name || "",
        category:x.category || "", size:x.size || "", quantity:Number(x.quantity || 1),
      });
      byPatient.set(x.patient_id, list);
    }
    for (const p of patients) {
      const items = byPatient.get(p.id);
      if (items?.length) (p as any).implants = items;
    }
  }

  // Compute Nth-time-operated: identical (name lowercased + MR no).
  // For each duplicate group, the earliest surgery is 1st time, next is 2nd, etc.
  const identity = (p: Patient) => `${(p.name || "").trim().toLowerCase()}|${(p.mrNo || "").trim().toLowerCase()}`;
  const groups = new Map<string, Patient[]>();
  for (const p of patients) {
    if (!p.name.trim() && !p.mrNo.trim()) continue;
    const k = identity(p);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(p);
  }
  for (const list of groups.values()) {
    // Sort ascending by date then createdAt for stable order
    const sorted = [...list].sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return (a.createdAt || "") < (b.createdAt || "") ? -1 : 1;
    });
    const total = sorted.length;
    sorted.forEach((p, i) => {
      p.operationCount = i + 1;
      p.totalOperations = total;
    });
  }
  return patients;
}

const inventoryCategories = () =>
  db.getAllSync<any>(
    "SELECT c.id,c.name,c.created_at,COUNT(i.id) AS item_count FROM inventory_categories c LEFT JOIN inventory i ON i.category_id=c.id GROUP BY c.id,c.name,c.created_at ORDER BY c.name COLLATE NOCASE",
  ).map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, itemCount: Number(r.item_count) }));

const inventory = (categoryId?: string, term?: string) => {
  const args: any[] = [];
  const where: string[] = [];
  if (categoryId) { where.push("i.category_id=?"); args.push(categoryId); }
  if (term?.trim()) {
    where.push("(LOWER(i.name) LIKE ? OR LOWER(COALESCE(i.size,'')) LIKE ? OR LOWER(COALESCE(i.category,'')) LIKE ?)");
    const q = "%" + term.trim().toLowerCase() + "%"; args.push(q,q,q);
  }
  const sql = `SELECT i.id,i.name,i.category_id,i.category,i.size,i.quantity,i.unit,i.minimum_stock,
      c.name AS category_name
      FROM inventory i LEFT JOIN inventory_categories c ON c.id=i.category_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY COALESCE(c.name,i.category,''), i.name COLLATE NOCASE, COALESCE(i.size,'')`;
  return db.getAllSync<any>(sql,args).map((r) => ({
    id:r.id,name:r.name,categoryId:r.category_id||"",category:r.category_name||r.category||"",size:r.size||"",
    quantity:Number(r.quantity),unit:r.unit||"pcs",minimumStock:Number(r.minimum_stock),
  }));
};

export const api = {
  async get<T = any>(path: string): Promise<T> {
    initializeDatabase();
    // Normalize offline API paths so trailing slashes/query strings cannot
    // accidentally bypass the local SQLite endpoint handlers.
    const normalizedPath = normalizeRoute(path);
    if (normalizedPath === "/me") {
      const me = await currentUserRow();
      return (me ? { id: me.id, role: me.role, canEditPatients: Number(me.can_edit_patients) === 1 } : null) as any;
    }
    if (normalizedPath === "/patients") return (await listPatients()) as any;
    if (normalizedPath === "/procedures")
      return db.getAllSync<any>("SELECT id,name FROM procedures ORDER BY name COLLATE NOCASE") as any;
    if (normalizedPath === "/patient-custom-fields")
      return db.getAllSync<any>("SELECT id,key,label,type,sort_order,enabled,created_at,updated_at FROM patient_custom_fields WHERE enabled=1 ORDER BY sort_order ASC,label COLLATE NOCASE") as any;
    if (normalizedPath === "/implant-records") {
      await requireAdmin();
      return db.getAllSync<any>("SELECT * FROM implant_records ORDER BY COALESCE(category,''),name COLLATE NOCASE,COALESCE(size,'')") as any;
    }
    if (normalizedPath === "/inventory-categories") return inventoryCategories() as any;
    if (normalizedPath.startsWith("/inventory-patients/")) {
      const iid = normalizedPath.split("/").pop() || "";
      return db.getAllSync<any>(
        `SELECT pi.id,pi.patient_id,pi.name,pi.category,pi.size,pi.quantity,p.mr_no,p.name AS patient_name,p.date
         FROM patient_implants pi JOIN patients p ON p.id=pi.patient_id
         WHERE pi.inventory_id=? ORDER BY p.date DESC, pi.created_at DESC`,
        [iid],
      ) as any;
    }
    if (normalizedPath.startsWith("/inventory-history/")) {
      const iid = path.split("/").pop() || "";
      return db.getAllSync<any>(
        "SELECT h.*,u.name AS user_name FROM inventory_movements h LEFT JOIN users u ON u.id=h.user_id WHERE inventory_id=? ORDER BY created_at DESC",
        [iid],
      ) as any;
    }
    if (normalizedPath.startsWith("/inventory-usage")) {
      const params = new URLSearchParams(path.split("?")[1] || "");
      const period = params.get("period") || "all";
      const year = Number(params.get("year"));
      const month = Number(params.get("month"));
      const me = await currentUserRow();
      if (!me) return [] as any;

      const conditions: string[] = [];
      const args: any[] = [];
      if (me.role !== "admin") { conditions.push("p.created_by=?"); args.push(me.id); }
      if (period === "month" && year && month) { conditions.push("p.date LIKE ?"); args.push(`${year}-${String(month).padStart(2, "0")}-%`); }
      else if (period === "year" && year) { conditions.push("p.date LIKE ?"); args.push(`${year}-%`); }
      const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

      const usageRows = db.getAllSync<any>(`
        SELECT
          COALESCE(pi.inventory_id, pi.category || '|' || pi.name || '|' || pi.size) AS id,
          COALESCE(pi.category, '') AS category,
          COALESCE(pi.name, '') AS name,
          COALESCE(pi.size, '') AS size,
          SUM(pi.quantity) AS quantity
        FROM patient_implants pi
        JOIN patients p ON p.id=pi.patient_id
        ${where}
        GROUP BY pi.inventory_id, pi.category, pi.name, pi.size
        ORDER BY quantity DESC
      `, args);

      const values = usageRows.map((r:any) => Number(r.quantity) || 0).sort((a:number,b:number)=>b-a);
      const highCut = values.length ? values[Math.max(0, Math.floor((values.length - 1) * 0.25))] : 0;
      const lowCut = values.length ? values[Math.min(values.length - 1, Math.ceil((values.length - 1) * 0.75))] : 0;
      return usageRows.map((r:any, index:number) => {
        const q = Number(r.quantity) || 0;
        let usageLevel: "high"|"medium"|"low" = "medium";
        if (values.length === 1) usageLevel = "high";
        else if (q >= highCut && q > lowCut) usageLevel = "high";
        else if (q <= lowCut && q < highCut) usageLevel = "low";
        return { id:String(r.id), category:r.category||"", name:r.name||"", size:r.size||"", quantity:q, usageLevel, rank:index+1 };
      });
    }
    if (normalizedPath.startsWith("/inventory")) {
      const q = path.split("?")[1] || "";
      const params = new URLSearchParams(q);
      return inventory(params.get("categoryId") || undefined, params.get("q") || "") as any;
    }
    if (normalizedPath.startsWith("/patient-history/")) {
      const pid = normalizedPath.split("/").pop() || "";
      return db.getAllSync<any>(
        "SELECT h.*,u.name AS user_name FROM patient_history h LEFT JOIN users u ON u.id=h.user_id WHERE patient_id=? ORDER BY created_at DESC",
        [pid],
      ) as any;
    }


    if (normalizedPath === "/users") {
      await requireAdmin();
      return db
        .getAllSync<any>(
          "SELECT id,email,name,role,can_edit_patients,disabled,recovery_code,created_at FROM users ORDER BY name COLLATE NOCASE",
        )
        .map((u) => ({
          ...u,
          canEditPatients: Number(u.can_edit_patients) === 1,
          recoveryCode: u.recovery_code || "",
        })) as any;
    }
    if (normalizedPath.startsWith("/stats")) {
      const params = new URLSearchParams(path.split("?")[1] || "");
      const year = Number(params.get("year"));
      const month = Number(params.get("month"));
      const me = await currentUserRow();
      const scope = me?.role === "admin" ? "" : " AND created_by=?";
      const scopeArgs = me?.role === "admin" ? [] : [me?.id];
      const rows = month
        ? db.getAllSync<any>(`SELECT * FROM patients WHERE date LIKE ?${scope}`, [`${year}-${String(month).padStart(2, "0")}-%`, ...scopeArgs])
        : year
        ? db.getAllSync<any>(`SELECT * FROM patients WHERE date LIKE ?${scope}`, [`${year}-%`, ...scopeArgs])
        : await listPatients();
      const counts: Record<string, number> = {};
      (rows as any[]).forEach((r) => {
        const n = String(r.procedure || "").trim();
        if (n) counts[n] = (counts[n] || 0) + 1;
      });
      return {
        total_patients: rows.length,
        procedures: Object.entries(counts).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      } as any;
    }
    throw new Error(`Offline API endpoint not implemented: ${path}`);
  },

  async post<T = any>(path: string, body?: any): Promise<T> {
    initializeDatabase();
    const normalizedPath = normalizeRoute(path);

    if (normalizedPath === "/patient-custom-fields") {
      await requireAdmin();
      const label=String(body?.label||"").trim();
      const type=["text","number","date","multiline"].includes(String(body?.type)) ? String(body.type) : "text";
      if(!label) throw new Error("Field name is required.");
      if(db.getFirstSync<any>("SELECT id FROM patient_custom_fields WHERE LOWER(label)=LOWER(?) LIMIT 1",[label])) throw new Error("This patient field already exists.");
      const fieldId=id();
      const key=(label.toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"")||"field")+"_"+fieldId.slice(0,8);
      const maxOrder=Number(db.getFirstSync<any>("SELECT COALESCE(MAX(sort_order),0) AS n FROM patient_custom_fields")?.n||0);
      db.runSync("INSERT INTO patient_custom_fields (id,key,label,type,sort_order,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",[fieldId,key,label,type,maxOrder+1,1,nowIso(),nowIso()]);
      return {id:fieldId,key,label,type,sort_order:maxOrder+1,enabled:1} as any;
    }
    if (normalizedPath === "/implant-records") {
      await requireAdmin();
      const now=nowIso();
      const uid=await currentUser();
      const record={
        id:id(), name:String(body?.name||"").trim(), category:String(body?.category||"").trim(), size:String(body?.size||"").trim(),
        manufacturer:String(body?.manufacturer||"").trim(), model:String(body?.model||"").trim(),
        lot_number:String(body?.lotNumber||"").trim(), serial_number:String(body?.serialNumber||"").trim(),
        expiry_date:String(body?.expiryDate||"").trim(), supplier:String(body?.supplier||"").trim(),
        quantity:Math.max(0,Number(body?.quantity)||0), unit:String(body?.unit||"pcs").trim()||"pcs",
        purchase_price:Math.max(0,Number(body?.purchasePrice)||0), notes:String(body?.notes||"").trim(),
        bill_files_json:JSON.stringify(Array.isArray(body?.billFiles)?body.billFiles:[]),
        created_at:now,updated_at:now,created_by:uid,updated_by:uid
      };
      if(!record.name) throw new Error("Implant name is required.");
      db.runSync("INSERT INTO implant_records (id,name,category,size,manufacturer,model,lot_number,serial_number,expiry_date,supplier,quantity,unit,purchase_price,notes,bill_files_json,created_at,updated_at,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [record.id,record.name,record.category,record.size,record.manufacturer,record.model,record.lot_number,record.serial_number,record.expiry_date,record.supplier,record.quantity,record.unit,record.purchase_price,record.notes,record.bill_files_json,record.created_at,record.updated_at,record.created_by,record.updated_by]);
      return record as any;
    }
    if (normalizedPath === "/inventory-categories") {
      await requireAdmin();
      const name = String(body?.name || "").trim();
      if (!name) throw new Error("Category name is required.");
      const duplicate = db.getFirstSync<any>(
        "SELECT id FROM inventory_categories WHERE LOWER(name)=LOWER(?) LIMIT 1",
        [name],
      );
      if (duplicate) throw new Error("This inventory category already exists.");
      const categoryId = id();
      db.runSync(
        "INSERT INTO inventory_categories (id,name,created_at) VALUES (?,?,?)",
        [categoryId, name, nowIso()],
      );
      return { id: categoryId, name, createdAt: nowIso(), itemCount: 0 } as any;
    }

    if (normalizedPath === "/inventory") {
      await requireAdmin();
      let categoryId = String(body?.categoryId || "").trim();
      let categoryName = String(body?.category || "").trim();
      if (!categoryId && !categoryName) throw new Error("Select an inventory category first.");

      if (categoryId) {
        const cat = db.getFirstSync<any>(
          "SELECT id,name FROM inventory_categories WHERE id=? LIMIT 1",
          [categoryId],
        );
        if (!cat) throw new Error("Inventory category not found.");
        categoryName = String(cat.name || categoryName).trim();
      } else {
        const cat = db.getFirstSync<any>(
          "SELECT id,name FROM inventory_categories WHERE LOWER(name)=LOWER(?) LIMIT 1",
          [categoryName],
        );
        if (cat) {
          categoryId = cat.id;
          categoryName = String(cat.name || categoryName).trim();
        } else {
          categoryId = id();
          db.runSync(
            "INSERT INTO inventory_categories (id,name,created_at) VALUES (?,?,?)",
            [categoryId, categoryName, nowIso()],
          );
        }
      }

      const size = String(body?.size || "").trim();
      const quantity = Math.max(0, Number(body?.quantity) || 0);
      const minimumStock = Math.max(0, Number(body?.minimumStock) || 0);
      const unit = String(body?.unit || "pcs").trim() || "pcs";
      if (quantity <= 0) throw new Error("Enter quantity received above 0.");

      const existing = db.getFirstSync<any>(
        "SELECT * FROM inventory WHERE category_id=? AND LOWER(COALESCE(size,''))=LOWER(?) LIMIT 1",
        [categoryId, size],
      );
      if (existing) {
        const next = Number(existing.quantity || 0) + quantity;
        db.runSync(
          "UPDATE inventory SET name=?,category_id=?,category=?,size=?,quantity=?,unit=?,minimum_stock=? WHERE id=?",
          [categoryName, categoryId, categoryName, size, next, unit, minimumStock, existing.id],
        );
        const uid = await currentUser();
        movement(existing.id, "purchase", quantity, next, body?.note || "Stock received", uid);
        return { id: existing.id, name: categoryName, categoryId, category: categoryName, size, quantity: next, unit, minimumStock } as any;
      }

      const inventoryId = id();
      db.runSync(
        "INSERT INTO inventory (id,name,quantity,unit,minimum_stock,category_id,category,size) VALUES (?,?,?,?,?,?,?,?)",
        [inventoryId, categoryName, quantity, unit, minimumStock, categoryId, categoryName, size],
      );
      const uid = await currentUser();
      movement(inventoryId, "purchase", quantity, quantity, body?.note || "Stock received", uid);
      return { id: inventoryId, name: categoryName, categoryId, category: categoryName, size, quantity, unit, minimumStock } as any;
    }

    if (normalizedPath === "/procedures") {
      await requireAdmin();
      const name = String(body?.name || "").trim();
      if (!name) throw new Error("Procedure name is required.");
      const duplicate = db.getFirstSync<any>(
        "SELECT id FROM procedures WHERE LOWER(name)=LOWER(?) LIMIT 1",
        [name],
      );
      if (duplicate) throw new Error("This procedure already exists.");
      const procedure = { id: id(), name };
      db.runSync("INSERT INTO procedures (id,name) VALUES (?,?)", [procedure.id, procedure.name]);
      return procedure as any;
    }

    // Bulk inventory deletion belongs to POST. It must work offline and
    // must not depend on stock being zero.
    if (normalizedPath === "/implant-records-bulk-delete") {
      await requireAdmin();
      const ids=Array.isArray(body?.ids)?[...new Set(body.ids.map(String).filter(Boolean))]:[];
      if(!ids.length) return {success:true,deleted:0} as any;
      const placeholders=ids.map(()=>"?").join(",");
      const rows=db.getAllSync<any>(`SELECT id FROM implant_records WHERE id IN (${placeholders})`,ids);
      db.runSync(`DELETE FROM implant_records WHERE id IN (${placeholders})`,ids);
      return {success:true,deleted:rows.length} as any;
    }
    if (normalizedPath === "/inventory-bulk-delete") {
      await requireAdmin();
      const ids = Array.isArray(body?.ids) ? body.ids.map(String).filter(Boolean) : [];
      const deleted = deleteInventoryRows(ids);
      return { success: true, deleted } as any;
    }
    if (normalizedPath === "/patients") return (await savePatient(body, false)) as any;
    if (normalizedPath === "/patients-bulk-delete") {
      const me = await currentUserRow();
      if (!me) throw new Error("Not signed in.");
      const ids = Array.isArray(body?.ids) ? body.ids.map(String).filter(Boolean) : [];
      const deleted = deletePatientRows(ids, me);
      return { success: true, deleted } as any;
    }
    if (normalizedPath === "/users") {
      await requireAdmin();
      const password = String(body?.password || "");
      if (password.length < 6) throw new Error("Password must be at least 6 characters.");
      const email = String(body?.email || "").trim().toLowerCase();
      if (!email) throw new Error("Email is required.");
      const name = String(body?.name || "").trim();
      if (!name) throw new Error("Name is required.");
      if (db.getFirstSync<any>("SELECT id FROM users WHERE email=? LIMIT 1", [email])) {
        throw new Error("An account with this email already exists.");
      }
      const salt = id();
      const hash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${salt}:${password}`);
      const u = {
        id: id(),
        email,
        name,
        role: body.role || "doctor",
        canEditPatients: body.canEditPatients !== false,
      };
      db.runSync(
        "INSERT INTO users (id,email,name,password_hash,recovery_code,role,can_edit_patients,created_at) VALUES (?,?,?,?,?,?,?,?)",
        [
          u.id, u.email, u.name, salt + ":" + hash,
          String(Math.floor(10000000 + Math.random() * 90000000)),
          u.role, u.canEditPatients ? 1 : 0, nowIso(),
        ],
      );
      return u as any;
    }
    // Admin resets a staff's password. Returns nothing sensitive back to
    // caller — the admin already typed the new password themselves.
    const rp = normalizedPath.match(/^\/users\/(.+)\/reset-password$/);
    if (rp) {
      await requireAdmin();
      const password = String(body?.password || "");
      if (password.length < 6) throw new Error("Password must be at least 6 characters.");
      const target = db.getFirstSync<any>("SELECT id FROM users WHERE id=?", [rp[1]]);
      if (!target) throw new Error("User not found.");
      const salt = id();
      const hash = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        `${salt}:${password}`,
      );
      db.runSync("UPDATE users SET password_hash=? WHERE id=?", [salt + ":" + hash, rp[1]]);
      return { ok: true } as any;
    }
    // Admin regenerates a staff's recovery code (used for self-service reset).
    const rc = normalizedPath.match(/^\/users\/(.+)\/regenerate-recovery-code$/);
    if (rc) {
      await requireAdmin();
      const target = db.getFirstSync<any>("SELECT id FROM users WHERE id=?", [rc[1]]);
      if (!target) throw new Error("User not found.");
      const code = String(Math.floor(10000000 + Math.random() * 90000000));
      db.runSync("UPDATE users SET recovery_code=? WHERE id=?", [code, rc[1]]);
      return { recoveryCode: code } as any;
    }
    throw new Error(`Offline API endpoint not implemented: ${path}`);
  },

  async put<T = any>(path: string, body?: any): Promise<T> {
    initializeDatabase();
    const normalizedPath = normalizeRoute(path);
    const pm = normalizedPath.match(/^\/patients\/(.+)$/);
    if (pm) {
      const existing = db.getFirstSync<any>("SELECT created_by FROM patients WHERE id=?", [pm[1]]);
      if (!existing) throw new Error("Patient not found.");
      await assertRecordAccess(existing.created_by);
      return (await savePatient(body, true)) as any;
    }
    const pcf=normalizedPath.match(/^\/patient-custom-fields\/(.+)$/);
    if(pcf){
      await requireAdmin();
      const existing=db.getFirstSync<any>("SELECT * FROM patient_custom_fields WHERE id=? LIMIT 1",[pcf[1]]);
      if(!existing) throw new Error("Patient field not found.");
      const label=String(body?.label||"").trim();
      if(!label) throw new Error("Field name is required.");
      if(db.getFirstSync<any>("SELECT id FROM patient_custom_fields WHERE LOWER(label)=LOWER(?) AND id<>? LIMIT 1",[label,pcf[1]])) throw new Error("This patient field already exists.");
      const type=["text","number","date","multiline"].includes(String(body?.type)) ? String(body.type) : "text";
      db.runSync("UPDATE patient_custom_fields SET label=?,type=?,sort_order=?,updated_at=? WHERE id=?",[label,type,Math.max(0,Number(body?.sort_order??existing.sort_order)||0),nowIso(),pcf[1]]);
      return db.getFirstSync<any>("SELECT * FROM patient_custom_fields WHERE id=?",[pcf[1]]) as any;
    }
    const ir=normalizedPath.match(/^\/implant-records\/(.+)$/);
    if(ir){
      await requireAdmin();
      const existing=db.getFirstSync<any>("SELECT * FROM implant_records WHERE id=? LIMIT 1",[ir[1]]);
      if(!existing) throw new Error("Implant record not found.");
      const now=nowIso(); const uid=await currentUser();
      let bills:any[]=Array.isArray(body?.billFiles)?body.billFiles:[];
      if(!Array.isArray(body?.billFiles)){ try { bills=JSON.parse(String(existing.bill_files_json||"[]")); } catch { bills=[]; } }
      const values=[
        String(body?.name??existing.name).trim(),String((body?.category ?? existing.category) || "").trim(),String((body?.size ?? existing.size) || "").trim(),
        String((body?.manufacturer ?? existing.manufacturer) || "").trim(),String((body?.model ?? existing.model) || "").trim(),
        String((body?.lotNumber ?? existing.lot_number) || "").trim(),String((body?.serialNumber ?? existing.serial_number) || "").trim(),
        String((body?.expiryDate ?? existing.expiry_date) || "").trim(),String((body?.supplier ?? existing.supplier) || "").trim(),
        Math.max(0,Number(body?.quantity ?? existing.quantity) || 0),String((body?.unit ?? existing.unit) || "pcs").trim()||"pcs",
        Math.max(0,Number(body?.purchasePrice ?? existing.purchase_price) || 0),String((body?.notes ?? existing.notes) || "").trim(),
        JSON.stringify(bills),now,uid,ir[1]
      ];
      if(!values[0]) throw new Error("Implant name is required.");
      db.runSync("UPDATE implant_records SET name=?,category=?,size=?,manufacturer=?,model=?,lot_number=?,serial_number=?,expiry_date=?,supplier=?,quantity=?,unit=?,purchase_price=?,notes=?,bill_files_json=?,updated_at=?,updated_by=? WHERE id=?",values);
      return db.getFirstSync<any>("SELECT * FROM implant_records WHERE id=?",[ir[1]]) as any;
    }
        const cm = normalizedPath.match(/^\/inventory-categories\/(.+)$/);
    if (cm) {
      await requireAdmin();
      const name = String(body?.name || "").trim();
      if (!name) throw new Error("Category name is required.");
      const existing = db.getFirstSync<any>("SELECT id FROM inventory_categories WHERE LOWER(name)=LOWER(?) AND id<>? LIMIT 1",[name,cm[1]]);
      if (existing) throw new Error("This inventory category already exists.");
      const cat = db.getFirstSync<any>("SELECT id FROM inventory_categories WHERE id=? LIMIT 1",[cm[1]]);
      if (!cat) throw new Error("Category not found.");
      db.runSync("UPDATE inventory_categories SET name=? WHERE id=?",[name,cm[1]]);
      db.runSync("UPDATE inventory SET name=?,category=? WHERE category_id=?",[name,name,cm[1]]);
      return { id:cm[1], name } as any;
    }
    const im = normalizedPath.match(/^\/inventory\/(.+)$/);
    if (im) {
      await requireAdmin();
      const item = db.getFirstSync<any>("SELECT * FROM inventory WHERE id=?", [im[1]]);
      if (!item) throw new Error("Inventory item not found.");
      const next = Math.max(0, Number(body?.quantity ?? item.quantity));
      const delta = next - Number(item.quantity);
      const uid = await currentUser();
      let categoryId = String(body?.categoryId || item.category_id || "").trim();
      let categoryName = String(body?.category || item.category || "").trim();
      if (categoryId) {
        const cat = db.getFirstSync<any>("SELECT id,name FROM inventory_categories WHERE id=? LIMIT 1", [categoryId]);
        if (!cat) throw new Error("Inventory category not found.");
        categoryName = String(cat.name || categoryName).trim();
      } else if (categoryName) {
        const cat = db.getFirstSync<any>("SELECT id,name FROM inventory_categories WHERE LOWER(name)=LOWER(?) LIMIT 1", [categoryName]);
        if (cat) categoryId = cat.id;
      }
      if (!categoryId && categoryName) {
        categoryId = id();
        db.runSync("INSERT INTO inventory_categories (id,name,created_at) VALUES (?,?,?)", [categoryId, categoryName, nowIso()]);
      }
      db.runSync(
        "UPDATE inventory SET name=?,category_id=?,category=?,size=?,quantity=?,unit=?,minimum_stock=? WHERE id=?",
        [String(body?.name || item.name || categoryName).trim(), categoryId || null, categoryName, String(body?.size ?? item.size ?? "").trim(), next, String(body?.unit || item.unit || "pcs"), Math.max(0, Number(body?.minimumStock ?? item.minimum_stock) || 0), im[1]],
      );
      if (delta) movement(im[1], "adjust", delta, next, body?.note || "Manual adjustment", uid);
      return { ...body, id: im[1], quantity: next } as any;
    }
    const proc = normalizedPath.match(/^\/procedures\/(.+)$/);
    if (proc) {
      await requireAdmin();
      const name = String(body?.name || "").trim();
      if (!name) throw new Error("Procedure name is required.");
      const duplicate = db.getFirstSync<any>(
        "SELECT id FROM procedures WHERE LOWER(name)=LOWER(?) AND id<>? LIMIT 1",
        [name, proc[1]],
      );
      if (duplicate) throw new Error("This procedure already exists.");
      const existing = db.getFirstSync<any>("SELECT id FROM procedures WHERE id=? LIMIT 1", [proc[1]]);
      if (!existing) throw new Error("Procedure not found.");
      db.runSync("UPDATE procedures SET name=? WHERE id=?", [name, proc[1]]);
      return { id: proc[1], name } as any;
    }

        const um = normalizedPath.match(/^\/users\/(.+)$/);
    if (um) {
      await requireAdmin();
      db.runSync(
        "UPDATE users SET name=?,role=?,can_edit_patients=?,disabled=? WHERE id=?",
        [body.name, body.role, body.canEditPatients ? 1 : 0, body.disabled ? 1 : 0, um[1]],
      );
      return body as any;
    }
    throw new Error(`Offline API endpoint not implemented: ${path}`);
  },

  async del<T = any>(path: string): Promise<T> {
    initializeDatabase();
    const normalizedPath = normalizeRoute(path);
    const pm = normalizedPath.match(/^\/patients\/(.+)$/);
    if (pm) {
      if (!(await canEdit())) throw new Error("You do not have permission to delete patient records.");
      const patient = db.getFirstSync<any>("SELECT * FROM patients WHERE id=?", [pm[1]]);
      if (patient) {
        await assertRecordAccess(patient.created_by);
        const uid = await currentUser();
        const deleted = deletePatientRows([pm[1]], { ...(await currentUserRow()), id: uid });
        if (deleted !== 1) throw new Error("Patient deletion did not complete.");
      }
      return { success: true } as any;
    }
    const pcf=normalizedPath.match(/^\/patient-custom-fields\/(.+)$/);
    if(pcf){ await requireAdmin(); db.runSync("DELETE FROM patient_custom_fields WHERE id=?",[pcf[1]]); return {success:true} as any; }
    const ir=normalizedPath.match(/^\/implant-records\/(.+)$/);
    if(ir){ await requireAdmin(); db.runSync("DELETE FROM implant_records WHERE id=?",[ir[1]]); return {success:true} as any; }
    const cat = normalizedPath.match(/^\/inventory-categories\/(.+)$/);
    if (cat) {
      await requireAdmin();
      const count = db.getFirstSync<any>("SELECT COUNT(*) AS n FROM inventory WHERE category_id=?",[cat[1]]);
      if (Number(count?.n) > 0) throw new Error("Cannot delete a category that still contains items. Move or delete its items first.");
      db.runSync("DELETE FROM inventory_categories WHERE id=?",[cat[1]]);
      return {success:true} as any;
    }
    const proc = normalizedPath.match(/^\/procedures\/(.+)$/);
    if (proc) {
      await requireAdmin();
      db.runSync("DELETE FROM procedures WHERE id=?", [proc[1]]);
      return { success: true } as any;
    }
    const inv = normalizedPath.match(/^\/inventory\/(.+)$/);
    if (inv) {
      await requireAdmin();
      const deleted = deleteInventoryRows([inv[1]]);
      if (deleted > 0) return { success: true, deleted } as any;
      return { success: true, deleted: 0 } as any;
    }
    throw new Error(`Offline API endpoint not implemented: ${path}`);
  },
};
