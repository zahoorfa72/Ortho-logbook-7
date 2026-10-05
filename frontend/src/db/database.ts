import * as SQLite from "expo-sqlite";
import { HOLD_INVENTORY_RESET } from "@/src/data/hold-inventory-reset";

export const db = SQLite.openDatabaseSync("ortho-logbook.db");

function addColumn(table: string, column: string, definition: string) {
  try { db.execSync(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`); } catch {}
}

function migrateInventorySchema() {
  try {
    const indexes = db.getAllSync<any>("PRAGMA index_list('inventory')");
    let hasUniqueName = false;
    for (const index of indexes) {
      if (Number(index.unique) !== 1) continue;
      const cols = db.getAllSync<any>(`PRAGMA index_info('${String(index.name).replace(/'/g, "''")}')`);
      if (cols.length === 1 && String(cols[0]?.name || "") === "name") {
        hasUniqueName = true;
        break;
      }
    }
    if (!hasUniqueName) return;
    db.execSync(`
      CREATE TABLE inventory_v2 (
        id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, quantity REAL NOT NULL DEFAULT 0,
        unit TEXT NOT NULL DEFAULT 'pcs', minimum_stock REAL NOT NULL DEFAULT 0,
        category_id TEXT, category TEXT, size TEXT
      );
      INSERT INTO inventory_v2 (id,name,quantity,unit,minimum_stock,category_id,category,size)
        SELECT id,name,quantity,unit,minimum_stock,category_id,category,size FROM inventory;
      DROP TABLE inventory;
      ALTER TABLE inventory_v2 RENAME TO inventory;
    `);
  } catch {}
}

export function initializeDatabase(options?: { skipInventoryReset?: boolean }) {
  db.execSync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS patients (
      id TEXT PRIMARY KEY NOT NULL, mr_no TEXT NOT NULL, name TEXT NOT NULL,
      gender TEXT, age TEXT, diagnosis TEXT, procedure TEXT, implant TEXT,
      implant_ii TEXT, implant_id TEXT, implant_ii_id TEXT, address TEXT, file_name TEXT, photo_uri TEXT,
      date TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT,
      updated_at TEXT, updated_by TEXT
    );
    CREATE TABLE IF NOT EXISTS procedures (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS inventory_categories (
      id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inventory (
      id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, quantity REAL NOT NULL DEFAULT 0,
      unit TEXT NOT NULL DEFAULT 'pcs', minimum_stock REAL NOT NULL DEFAULT 0,
      category_id TEXT, category TEXT, size TEXT, added_date TEXT, bill_image TEXT
    );
    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY NOT NULL, description TEXT NOT NULL, amount REAL NOT NULL,
      belongs_to TEXT NOT NULL DEFAULT 'hospital', doctor_id TEXT, date TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY NOT NULL, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      password_hash TEXT NOT NULL, recovery_code TEXT, role TEXT NOT NULL DEFAULT 'doctor',
      can_edit_patients INTEGER NOT NULL DEFAULT 1, disabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS patient_history (
      id TEXT PRIMARY KEY NOT NULL, patient_id TEXT NOT NULL, user_id TEXT,
      action TEXT NOT NULL, snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS patient_implants (
      id TEXT PRIMARY KEY NOT NULL, patient_id TEXT NOT NULL, inventory_id TEXT,
      name TEXT NOT NULL, category TEXT, size TEXT, quantity REAL NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS patient_custom_fields (
      id TEXT PRIMARY KEY NOT NULL, key TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'text', sort_order INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS implant_records (
      id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, category TEXT, size TEXT,
      manufacturer TEXT, model TEXT, lot_number TEXT, serial_number TEXT, expiry_date TEXT,
      supplier TEXT, quantity REAL NOT NULL DEFAULT 0, unit TEXT NOT NULL DEFAULT 'pcs',
      purchase_price REAL NOT NULL DEFAULT 0, notes TEXT, bill_files_json TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT, updated_by TEXT
    );
    CREATE TABLE IF NOT EXISTS inventory_movements (
      id TEXT PRIMARY KEY NOT NULL, inventory_id TEXT NOT NULL, user_id TEXT,
      type TEXT NOT NULL, amount REAL NOT NULL, quantity_after REAL NOT NULL,
      note TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inventory_purchase_receipts (
      id TEXT PRIMARY KEY NOT NULL, inventory_id TEXT NOT NULL, category_id TEXT,
      category TEXT, size TEXT, quantity REAL NOT NULL DEFAULT 0, unit TEXT NOT NULL DEFAULT 'pcs',
      minimum_stock REAL NOT NULL DEFAULT 0, added_date TEXT, bill_image TEXT,
      created_at TEXT NOT NULL, created_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_inventory_purchase_receipts_item ON inventory_purchase_receipts(inventory_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_inventory_purchase_receipts_date ON inventory_purchase_receipts(added_date);
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY NOT NULL, value TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_patients_date ON patients(date);
    CREATE INDEX IF NOT EXISTS idx_patients_procedure ON patients(procedure);
    CREATE INDEX IF NOT EXISTS idx_patients_mr ON patients(mr_no);
    CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(name);
    CREATE INDEX IF NOT EXISTS idx_patient_custom_fields_order ON patient_custom_fields(sort_order, label);
    CREATE INDEX IF NOT EXISTS idx_implant_records_name ON implant_records(name);
    CREATE INDEX IF NOT EXISTS idx_implant_records_category ON implant_records(category);
    CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
    CREATE INDEX IF NOT EXISTS idx_history_patient ON patient_history(patient_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_patient_implants_patient ON patient_implants(patient_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_patient_implants_inventory ON patient_implants(inventory_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_inventory_category_size ON inventory(category_id, size);
    CREATE INDEX IF NOT EXISTS idx_inventory_name ON inventory(name);
    CREATE INDEX IF NOT EXISTS idx_inventory_size ON inventory(size);
    CREATE INDEX IF NOT EXISTS idx_inventory_movements_item ON inventory_movements(inventory_id, created_at);
  `);
  // Non-destructive migration for databases created by older builds.
  addColumn("patients", "photo_uri", "TEXT");
  addColumn("patients", "implant_id", "TEXT");
  addColumn("patients", "implant_ii_id", "TEXT");
  addColumn("inventory", "category", "TEXT");
  addColumn("inventory", "size", "TEXT");
  addColumn("inventory", "added_date", "TEXT");
  addColumn("inventory", "bill_image", "TEXT");
  addColumn("patients", "photos_json", "TEXT");
  addColumn("patients", "custom_data_json", "TEXT");
  addColumn("patients", "created_by", "TEXT");
  addColumn("patients", "updated_at", "TEXT");
  addColumn("patients", "updated_by", "TEXT");
  addColumn("users", "recovery_code", "TEXT");
  addColumn("users", "role", "TEXT NOT NULL DEFAULT 'doctor'");
  addColumn("users", "can_edit_patients", "INTEGER NOT NULL DEFAULT 1");
  addColumn("users", "disabled", "INTEGER NOT NULL DEFAULT 0");
  addColumn("inventory", "category_id", "TEXT");
  addColumn("inventory", "category", "TEXT");
  addColumn("inventory", "size", "TEXT");
  migrateInventorySchema();
  // Every inventory item uses minimum stock = 1, including existing records.
  db.runSync("UPDATE inventory SET minimum_stock = 1");
  // Startup must be strictly non-destructive. User-created inventory and
  // categories are persistent local data and must never be seeded, cleaned,
  // or deleted during an app update.
  ensureInventoryCategoryLinks();
  // One-time migration for the Receive Stock history UI. Old aggregate/legacy
  // receiving data is removed from the receipt-history table only; inventory
  // quantities themselves are never changed.
  const receiptHistoryReset=db.getFirstSync<any>("SELECT value FROM app_meta WHERE key=? LIMIT 1",[RECEIPT_HISTORY_RESET_MARKER]);
  if(!receiptHistoryReset){
    db.runSync("DELETE FROM inventory_purchase_receipts");
    db.runSync("INSERT OR REPLACE INTO app_meta (key,value) VALUES (?,?)",[RECEIPT_HISTORY_RESET_MARKER,"done"]);
  }
  if (!options?.skipInventoryReset) applyHoldInventoryResetOnce();
}

const INVENTORY_RESET_MARKER = "hold-inventory-reset-available-v5";
const RECEIPT_HISTORY_RESET_MARKER = "received-stock-history-reset-v3";

export function markInventoryResetDone() {
  db.runSync("INSERT OR REPLACE INTO app_meta (key,value) VALUES (?,?)", [INVENTORY_RESET_MARKER, "done"]);
}

function seedHoldInventory() {
  for (const group of HOLD_INVENTORY_RESET) {
      const categoryName = String(group.category).trim();
      let category = db.getFirstSync<any>(
        "SELECT id FROM inventory_categories WHERE LOWER(name)=LOWER(?) LIMIT 1",
        [categoryName],
      );
      if (!category) {
        const categoryId = Math.random().toString(36).slice(2) + Date.now().toString(36);
        db.runSync(
          "INSERT INTO inventory_categories (id,name,created_at) VALUES (?,?,?)",
          [categoryId, categoryName, new Date().toISOString()],
        );
        category = { id: categoryId };
      }
      for (const item of group.items) {
        const inventoryId =
          Math.random().toString(36).slice(2) +
          Date.now().toString(36) +
          Math.random().toString(36).slice(2);
        db.runSync(
          "INSERT INTO inventory (id,name,quantity,unit,minimum_stock,category_id,category,size) VALUES (?,?,?,?,?,?,?,?)",
          [inventoryId, categoryName, Math.max(0, Number(item.quantity) || 0), "pcs", 1, category.id, categoryName, String(item.size)],
        );
      }
  }
}

function applyHoldInventoryResetOnce() {
  const marker = INVENTORY_RESET_MARKER;
  const done = db.getFirstSync<any>("SELECT value FROM app_meta WHERE key=?", [marker]);
  const count = Number(db.getFirstSync<any>("SELECT COUNT(*) AS count FROM inventory")?.count || 0);
  const categoryCount = Number(db.getFirstSync<any>("SELECT COUNT(*) AS count FROM inventory_categories")?.count || 0);
  const patientCount = Number(db.getFirstSync<any>("SELECT COUNT(*) AS count FROM patients")?.count || 0);

  // App updates are strictly non-destructive. Once the marker exists, never
  // seed, replace, or duplicate inventory. An older database without the
  // marker is seeded only when it is completely fresh.
  if (done?.value === "done") return;
  if (count > 0 || categoryCount > 0 || patientCount > 0) {
    markInventoryResetDone();
    return;
  }

  db.withTransactionSync(() => {
    seedHoldInventory();
    db.runSync("INSERT OR REPLACE INTO app_meta (key,value) VALUES (?,?)", [marker, "done"]);
  });
}

export function repairDatabaseData() {
  try {
    db.withTransactionSync(() => {
      // Repair only lightweight relational integrity at startup. Never scan
      // photo or attachment blobs here because restored backups may be large.
      db.runSync("DELETE FROM patient_implants WHERE patient_id NOT IN (SELECT id FROM patients)");
      db.runSync("DELETE FROM inventory_movements WHERE inventory_id NOT IN (SELECT id FROM inventory)");
      db.runSync("DELETE FROM patient_history WHERE patient_id NOT IN (SELECT id FROM patients)");
      db.runSync("UPDATE users SET role='doctor' WHERE role NOT IN ('admin','doctor','staff') OR role IS NULL OR role=''");
      db.runSync("UPDATE users SET can_edit_patients=CASE WHEN can_edit_patients>0 THEN 1 ELSE 0 END");
      db.runSync("UPDATE users SET disabled=CASE WHEN disabled>0 THEN 1 ELSE 0 END");
      ensureInventoryCategoryLinks();
    });
    return true;
  } catch (e) {
    console.error("[database] repairDatabaseData failed:", e);
    return false;
  }
}

function ensureInventoryCategoryLinks() {
  const legacyCategories = db.getAllSync<any>(
    "SELECT DISTINCT TRIM(category) AS name FROM inventory WHERE TRIM(COALESCE(category,'')) <> ''",
  );
  for (const row of legacyCategories) {
    const categoryName = String(row.name || "").trim();
    if (!categoryName) continue;
    let categoryRow = db.getFirstSync<any>(
      "SELECT id FROM inventory_categories WHERE LOWER(name)=LOWER(?) LIMIT 1",
      [categoryName],
    );
    if (!categoryRow) {
      const categoryId = Math.random().toString(36).slice(2) + Date.now().toString(36);
      db.runSync("INSERT INTO inventory_categories (id,name,created_at) VALUES (?,?,?)", [categoryId, categoryName, new Date().toISOString()]);
      categoryRow = { id: categoryId };
    }
    db.runSync(
      "UPDATE inventory SET category_id=? WHERE LOWER(TRIM(COALESCE(category,'')))=LOWER(?) AND (category_id IS NULL OR category_id='')",
      [categoryRow.id, categoryName],
    );
  }
}
