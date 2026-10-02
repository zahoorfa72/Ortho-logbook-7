import { PDF_INVENTORY } from "../data/pdf-inventory";

import * as SQLite from "expo-sqlite";

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

export function initializeDatabase() {
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
      category_id TEXT, category TEXT, size TEXT
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
    CREATE TABLE IF NOT EXISTS inventory_movements (
      id TEXT PRIMARY KEY NOT NULL, inventory_id TEXT NOT NULL, user_id TEXT,
      type TEXT NOT NULL, amount REAL NOT NULL, quantity_after REAL NOT NULL,
      note TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_patients_date ON patients(date);
    CREATE INDEX IF NOT EXISTS idx_patients_procedure ON patients(procedure);
    CREATE INDEX IF NOT EXISTS idx_patients_mr ON patients(mr_no);
    CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(name);
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
  addColumn("patients", "photos_json", "TEXT");
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
  seedPdfInventory();
  cleanupPdfImportedInventoryOnce();

function cleanupPdfImportedInventoryOnce() {
  db.execSync("CREATE TABLE IF NOT EXISTS inventory_imports (name TEXT PRIMARY KEY NOT NULL, imported_at TEXT NOT NULL)");
  const marker = "orthopaedic-inventory-pdf-cleanup-v1";
  if (db.getFirstSync<any>("SELECT name FROM inventory_imports WHERE name=?", [marker])) return;
  const imported = db.getAllSync<any>("SELECT DISTINCT inventory_id FROM inventory_movements WHERE type='import' AND note LIKE 'Imported from Orthopaedic Implants Management PDF%'");
  const ids = imported.map((x:any) => String(x.inventory_id || "")).filter(Boolean);
  if (ids.length) {
    const placeholders = ids.map(() => "?").join(",");
    db.withTransactionSync(() => {
      db.runSync(`DELETE FROM inventory_movements WHERE inventory_id IN (${placeholders})`, ids);
      db.runSync(`DELETE FROM inventory WHERE id IN (${placeholders})`, ids);
    });
  }
  db.runSync("DELETE FROM inventory_categories WHERE id NOT IN (SELECT DISTINCT category_id FROM inventory WHERE category_id IS NOT NULL AND category_id <> '')");
  db.runSync("INSERT INTO inventory_imports (name,imported_at) VALUES (?,?)", [marker, new Date().toISOString()]);
}

function seedPdfInventory() {
  db.execSync("CREATE TABLE IF NOT EXISTS inventory_imports (name TEXT PRIMARY KEY NOT NULL, imported_at TEXT NOT NULL)");
  const markerV2 = db.getFirstSync<any>(
    "SELECT name FROM inventory_imports WHERE name=?",
    ["orthopaedic-inventory-pdf-v2-available-only"],
  );
  if (markerV2) return;

  const markerV1 = db.getFirstSync<any>(
    "SELECT name FROM inventory_imports WHERE name=?",
    ["orthopaedic-inventory-pdf-v1"],
  );

  const now = new Date().toISOString();

  for (const [categoryName, encodedItems] of PDF_INVENTORY) {
    const category = String(categoryName).trim();
    let categoryRow = db.getFirstSync<any>(
      "SELECT id FROM inventory_categories WHERE LOWER(name)=LOWER(?) LIMIT 1",
      [category],
    );
    if (!categoryRow) {
      const categoryId = Math.random().toString(36).slice(2) + Date.now().toString(36);
      db.runSync(
        "INSERT INTO inventory_categories (id,name,created_at) VALUES (?,?,?)",
        [categoryId, category, now],
      );
      categoryRow = { id: categoryId };
    }

    if (!encodedItems) continue;

    for (const entry of String(encodedItems).split(";")) {
      const separator = entry.lastIndexOf("=");
      if (separator <= 0) continue;

      const size = entry.slice(0, separator).trim();
      const rawQuantity = Number(entry.slice(separator + 1));
      const availableQuantity = Math.max(0, Number.isFinite(rawQuantity) ? rawQuantity : 0);
      if (!size) continue;

      const existing = db.getFirstSync<any>(
        "SELECT id, quantity FROM inventory WHERE category_id=? AND LOWER(COALESCE(size,''))=LOWER(?) LIMIT 1",
        [categoryRow.id, size],
      );

      if (!existing) {
        const itemId = Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        db.runSync(
          "INSERT INTO inventory (id,name,category_id,category,size,quantity,unit,minimum_stock) VALUES (?,?,?,?,?,?,?,?)",
          [itemId, size, categoryRow.id, category, size, availableQuantity, "pcs", 1],
        );
        db.runSync(
          "INSERT INTO inventory_movements (id,inventory_id,user_id,type,amount,quantity_after,note,created_at) VALUES (?,?,?,?,?,?,?,?)",
          [Math.random().toString(36).slice(2) + Date.now().toString(36), itemId, null, "import", availableQuantity, availableQuantity, "Imported from Orthopaedic Implants Management PDF — Available quantity", now],
        );
        continue;
      }

      // One-time repair for the previous PDF import: use ONLY the PDF's
      // Available value, but never overwrite stock that was already changed
      // manually or through patient usage after the original import.
      if (markerV1) {
        const laterMovements = db.getFirstSync<any>(
          "SELECT COUNT(*) AS count FROM inventory_movements WHERE inventory_id=? AND type NOT IN ('import','import-correction')",
          [existing.id],
        );
        if (Number(laterMovements?.count || 0) === 0) {
          db.runSync(
            "UPDATE inventory SET quantity=?, name=?, category=?, size=? WHERE id=?",
            [availableQuantity, size, category, size, existing.id],
          );
          db.runSync(
            "INSERT INTO inventory_movements (id,inventory_id,user_id,type,amount,quantity_after,note,created_at) VALUES (?,?,?,?,?,?,?,?)",
            [Math.random().toString(36).slice(2) + Date.now().toString(36), existing.id, null, "import-correction", availableQuantity - Number(existing.quantity || 0), availableQuantity, "Corrected PDF import to Available quantity only", now],
          );
        }
      }
    }
  }

  db.runSync(
    "INSERT INTO inventory_imports (name,imported_at) VALUES (?,?)",
    ["orthopaedic-inventory-pdf-v2-available-only", now],
  );
}

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
