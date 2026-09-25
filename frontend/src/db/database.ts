import * as SQLite from "expo-sqlite";

export const db = SQLite.openDatabaseSync("ortho-logbook.db");

function addColumn(table: string, column: string, definition: string) {
  try { db.execSync(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`); } catch {}
}

function migrateInventorySchema() {
  try {
    const indexes = db.getAllSync<any>("PRAGMA index_list('inventory')");
    const hasUniqueName = indexes.some((x) => Number(x.unique) === 1);
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
      implant_ii TEXT, address TEXT, file_name TEXT, photo_uri TEXT,
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
    CREATE INDEX IF NOT EXISTS idx_inventory_movements_item ON inventory_movements(inventory_id, created_at);
  `);
  // Non-destructive migration for databases created by older builds.
  addColumn("patients", "photo_uri", "TEXT");
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
