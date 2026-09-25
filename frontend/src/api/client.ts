import * as Crypto from "expo-crypto";
import { db, initializeDatabase } from "@/src/db/database";
import { storage } from "@/src/utils/storage";

const id = () => Crypto.randomUUID();
const nowIso = () => new Date().toISOString();
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
  diagnosis: string; procedure: string; implant: string; implantII: string;
  address: string; fileName: string; photoUri: string; photos: string[]; date: string;
  createdAt?: string; createdBy?: string; updatedAt?: string; updatedBy?: string;
  operationCount?: number; // Nth-time operated (1 = first, 2 = 2nd time, ...)
  totalOperations?: number; // total ops on this same identity
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
    implant: r.implant || "", implantII: r.implant_ii || "", address: r.address || "",
    fileName: r.file_name || "", photoUri: photos[0] || "", photos,
    date: r.date, createdAt: r.created_at, createdBy: r.created_by,
    updatedAt: r.updated_at, updatedBy: r.updated_by,
  };
};

const snapshot = (p: any) => JSON.stringify(p);

function movement(inventoryId: string, type: string, amount: number, quantityAfter: number, note: string, userId: string | null) {
  db.runSync(
    "INSERT INTO inventory_movements (id,inventory_id,user_id,type,amount,quantity_after,note,created_at) VALUES (?,?,?,?,?,?,?,?)",
    [id(), inventoryId, userId, type, amount, quantityAfter, note, nowIso()],
  );
}

function changeInventory(name: string, amount: number, type: string, note: string, userId: string | null) {
  const clean = String(name || "").trim();
  if (!clean || !amount) return;
  const item = db.getFirstSync<any>(
    "SELECT id,quantity FROM inventory WHERE LOWER(name)=LOWER(?) LIMIT 1",
    [clean],
  );
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

function validateImplants(p: Patient) {
  const required = new Map<string, number>();
  for (const name of [p.implant, p.implantII]) {
    const clean = String(name || "").trim().toLowerCase();
    if (clean) required.set(clean, (required.get(clean) || 0) + 1);
  }
  for (const [clean, count] of required) {
    const item = db.getFirstSync<any>(
      "SELECT name,quantity FROM inventory WHERE LOWER(name)=? LIMIT 1",
      [clean],
    );
    if (!item) throw new Error(`Implant "${clean}" is not available in inventory.`);
    const available = Number(item.quantity) || 0;
    if (available < count) throw new Error(`Insufficient stock for "${item.name}". Available: ${available}, required: ${count}.`);
  }
}

function deduct(p: Patient, userId: string | null) {
  changeInventory(p.implant, -1, "patient-use", `Used by patient ${p.mrNo || p.name}`, userId);
  changeInventory(p.implantII, -1, "patient-use", `Used by patient ${p.mrNo || p.name}`, userId);
}

function restoreStock(p: Patient, userId: string | null) {
  changeInventory(p.implant, 1, "patient-return", `Returned from patient ${p.mrNo || p.name}`, userId);
  changeInventory(p.implantII, 1, "patient-return", `Returned from patient ${p.mrNo || p.name}`, userId);
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
      restoreStock(fromPatient(old), uid);
      validateImplants(p);
      db.runSync(
        "UPDATE patients SET mr_no=?,name=?,gender=?,age=?,diagnosis=?,procedure=?,implant=?,implant_ii=?,address=?,file_name=?,photo_uri=?,photos_json=?,date=?,updated_at=?,updated_by=? WHERE id=?",
        [p.mrNo, p.name, p.gender, p.age, p.diagnosis, p.procedure, p.implant, p.implantII, p.address, p.fileName, primaryPhoto, photosJson, p.date, now, uid, patientId],
      );
      db.runSync(
        "INSERT INTO patient_history (id,patient_id,user_id,action,snapshot_json,created_at) VALUES (?,?,?,?,?,?)",
        [id(), patientId, uid, "edit", snapshot(fromPatient(old)), now],
      );
      deduct({ ...p, id: patientId }, uid);
      return { ...p, id: patientId };
    });
  }

  validateImplants(p);
  db.runSync(
    "INSERT INTO patients (id,mr_no,name,gender,age,diagnosis,procedure,implant,implant_ii,address,file_name,photo_uri,photos_json,date,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [patientId, p.mrNo, p.name, p.gender, p.age, p.diagnosis, p.procedure, p.implant, p.implantII, p.address, p.fileName, primaryPhoto, photosJson, p.date, now, uid],
  );
  db.runSync(
    "INSERT INTO patient_history (id,patient_id,user_id,action,snapshot_json,created_at) VALUES (?,?,?,?,?,?)",
    [id(), patientId, uid, "create", snapshot(p), now],
  );
  deduct({ ...p, id: patientId }, uid);
  return { ...p, id: patientId };
}

async function listPatients(): Promise<Patient[]> {
  const me = await currentUserRow();
  if (!me) return [];
  const rows = me.role === "admin"
    ? db.getAllSync<any>("SELECT * FROM patients ORDER BY date DESC, created_at DESC")
    : db.getAllSync<any>("SELECT * FROM patients WHERE created_by=? ORDER BY date DESC, created_at DESC", [me.id]);
  const patients = rows.map(fromPatient);

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
    if (path === "/me") {
      const me = await currentUserRow();
      return (me ? { id: me.id, role: me.role, canEditPatients: Number(me.can_edit_patients) === 1 } : null) as any;
    }
    if (path === "/patients") return (await listPatients()) as any;
    if (path === "/procedures")
      return db.getAllSync<any>("SELECT id,name FROM procedures ORDER BY name COLLATE NOCASE") as any;
    if (path === "/inventory-categories") return inventoryCategories() as any;
    if (path.startsWith("/inventory-history/")) {
      const iid = path.split("/").pop() || "";
      return db.getAllSync<any>(
        "SELECT h.*,u.name AS user_name FROM inventory_movements h LEFT JOIN users u ON u.id=h.user_id WHERE inventory_id=? ORDER BY created_at DESC",
        [iid],
      ) as any;
    }
    if (path.startsWith("/inventory")) {
      const q = path.split("?")[1] || "";
      const params = new URLSearchParams(q);
      return inventory(params.get("categoryId") || undefined, params.get("q") || "") as any;
    }
    if (path.startsWith("/patient-history/")) {
      const pid = path.split("/").pop() || "";
      return db.getAllSync<any>(
        "SELECT h.*,u.name AS user_name FROM patient_history h LEFT JOIN users u ON u.id=h.user_id WHERE patient_id=? ORDER BY created_at DESC",
        [pid],
      ) as any;
    }
    if (path === "/users") {
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
    if (path.startsWith("/stats")) {
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
    if (path === "/patients") return (await savePatient(body, false)) as any;
    if (path === "/inventory-categories") {
      await requireAdmin();
      const name = String(body?.name || "").trim();
      if (!name) throw new Error("Category name is required.");
      const existing = db.getFirstSync<any>("SELECT id,name FROM inventory_categories WHERE LOWER(name)=LOWER(?) LIMIT 1",[name]);
      if (existing) throw new Error("This inventory category already exists.");
      const item = { id:id(), name, createdAt:nowIso() };
      db.runSync("INSERT INTO inventory_categories (id,name,created_at) VALUES (?,?,?)",[item.id,item.name,item.createdAt]);
      return item as any;
    }
    if (path === "/procedures") {
      await requireAdmin();
      const name = String(body?.name || "").trim();
      if (!name) throw new Error("Procedure name is required.");
      const item = { id: id(), name };
      db.runSync("INSERT INTO procedures (id,name) VALUES (?,?)", [item.id, item.name]);
      return item as any;
    }
    if (path === "/inventory") {
      await requireAdmin();
      const name = String(body?.name || "").trim();
      const category = String(body?.category || "").trim();
      const categoryId = String(body?.categoryId || "").trim();
      const size = String(body?.size || "").trim();
      const quantity = Number(body?.quantity || 0);
      const minimumStock = Number(body?.minimumStock || 0);
      const unit = String(body?.unit || "pcs").trim() || "pcs";
      if (!name) throw new Error("Inventory item name is required.");
      if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("Quantity must be greater than 0.");
      if (!Number.isFinite(minimumStock) || minimumStock < 0) throw new Error("Minimum stock cannot be negative.");
      const uid = await currentUser();
      let categoryName = category;
      if (categoryId) {
        const cat = db.getFirstSync<any>("SELECT name FROM inventory_categories WHERE id=? LIMIT 1",[categoryId]);
        if (!cat) throw new Error("Selected category was not found.");
        categoryName = cat.name;
      }
      if (!categoryId && !categoryName) throw new Error("Select an inventory category.");
      const existing = db.getFirstSync<any>(
        "SELECT id,name,quantity,unit,minimum_stock,category,size FROM inventory WHERE LOWER(name)=LOWER(?) AND LOWER(COALESCE(size,''))=LOWER(?) AND COALESCE(category_id,'')=COALESCE(?, '') LIMIT 1",
        [name, size, categoryId || null],
      );
      if (existing) {
        const next = Number(existing.quantity) + quantity;
        db.runSync("UPDATE inventory SET quantity=?,unit=?,minimum_stock=?,category_id=?,category=? WHERE id=?", [next, unit, minimumStock, categoryId || null, categoryName, existing.id]);
        movement(existing.id, "receive", quantity, next, "Stock received", uid);
        return { id: existing.id, name: existing.name, quantity: next, unit, minimumStock } as any;
      }
      const item = { id: id(), name, categoryId, category: categoryName, size, quantity, unit, minimumStock };
      db.runSync("INSERT INTO inventory (id,name,category_id,category,size,quantity,unit,minimum_stock) VALUES (?,?,?,?,?,?,?,?)", [item.id, name, categoryId || null, categoryName, size, quantity, unit, minimumStock]);
      movement(item.id, "receive", quantity, quantity, "Initial stock", uid);
      return item as any;
    }
    if (path === "/users") {
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
    const rp = path.match(/^\/users\/(.+)\/reset-password$/);
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
    const rc = path.match(/^\/users\/(.+)\/regenerate-recovery-code$/);
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
    const pm = path.match(/^\/patients\/(.+)$/);
    if (pm) {
      const existing = db.getFirstSync<any>("SELECT created_by FROM patients WHERE id=?", [pm[1]]);
      if (!existing) throw new Error("Patient not found.");
      await assertRecordAccess(existing.created_by);
      return (await savePatient(body, true)) as any;
    }
    const im = path.match(/^\/inventory\/(.+)$/);
    if (im) {
      await requireAdmin();
      const item = db.getFirstSync<any>("SELECT * FROM inventory WHERE id=?", [im[1]]);
      if (!item) throw new Error("Inventory item not found.");
      const next = Number(body?.quantity ?? item.quantity);
      const delta = next - Number(item.quantity);
      const uid = await currentUser();
      db.runSync(
        "UPDATE inventory SET name=?,category=?,size=?,quantity=?,unit=?,minimum_stock=? WHERE id=?",
        [String(body.name).trim(), String(body.category || "").trim(), String(body.size || "").trim(), next, String(body.unit || "pcs"), Number(body.minimumStock || 0), im[1]],
      );
      if (delta) movement(im[1], "adjust", delta, next, body?.note || "Manual adjustment", uid);
      return { ...body, id: im[1], quantity: next } as any;
    }
    const um = path.match(/^\/users\/(.+)$/);
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
    const pm = path.match(/^\/patients\/(.+)$/);
    if (pm) {
      if (!(await canEdit())) throw new Error("You do not have permission to delete patient records.");
      const patient = db.getFirstSync<any>("SELECT * FROM patients WHERE id=?", [pm[1]]);
      if (patient) {
        await assertRecordAccess(patient.created_by);
        const uid = await currentUser();
        restoreStock(fromPatient(patient), uid);
        db.runSync(
          "INSERT INTO patient_history (id,patient_id,user_id,action,snapshot_json,created_at) VALUES (?,?,?,?,?,?)",
          [id(), pm[1], uid, "delete", snapshot(fromPatient(patient)), nowIso()],
        );
        db.runSync("DELETE FROM patients WHERE id=?", [pm[1]]);
      }
      return { success: true } as any;
    }
    const cat = path.match(/^\/inventory-categories\/(.+)$/);
    if (cat) {
      await requireAdmin();
      const count = db.getFirstSync<any>("SELECT COUNT(*) AS n FROM inventory WHERE category_id=?",[cat[1]]);
      if (Number(count?.n) > 0) throw new Error("Cannot delete a category that still contains items. Move or delete its items first.");
      db.runSync("DELETE FROM inventory_categories WHERE id=?",[cat[1]]);
      return {success:true} as any;
    }
    const proc = path.match(/^\/procedures\/(.+)$/);
    if (proc) {
      await requireAdmin();
      db.runSync("DELETE FROM procedures WHERE id=?", [proc[1]]);
      return { success: true } as any;
    }
    const inv = path.match(/^\/inventory\/(.+)$/);
    if (inv) {
      await requireAdmin();
      db.runSync("DELETE FROM inventory WHERE id=?", [inv[1]]);
      return { success: true } as any;
    }
    throw new Error(`Offline API endpoint not implemented: ${path}`);
  },
};
