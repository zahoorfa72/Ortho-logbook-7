import * as Crypto from "expo-crypto";
import { db } from "@/src/db/database";

export const INTELLIGENCE_MODULES = [
  { id: "body_map", title: "Anatomy map", subtitle: "Record bone, region and side", icon: "body-outline" },
  { id: "xray", title: "X-ray timeline", subtitle: "Attach and compare dated studies", icon: "scan-outline" },
  { id: "implant_passport", title: "Implant passport", subtitle: "Trace batch, serial and supplier", icon: "barcode-outline" },
  { id: "digital_twin", title: "Patient journey", subtitle: "One chronological clinical timeline", icon: "git-branch-outline" },
  { id: "xray_review", title: "X-ray review", subtitle: "Clinician-led findings and measurements", icon: "eye-outline" },
  { id: "rehab", title: "Rehabilitation", subtitle: "Pain, movement and mobility trends", icon: "fitness-outline" },
  { id: "surgery_checklist", title: "Surgery checklist", subtitle: "Procedure checks and sign-off", icon: "clipboard-outline" },
  { id: "clinical_note", title: "Clinical notes", subtitle: "Structured notes with keyboard dictation", icon: "document-text-outline" },
  { id: "follow_up", title: "Follow-up radar", subtitle: "Due, missed and completed reviews", icon: "calendar-outline" },
  { id: "research", title: "Research studio", subtitle: "Privacy-conscious aggregate reports", icon: "stats-chart-outline" },
  { id: "knowledge", title: "Knowledge library", subtitle: "Search clinician-approved references", icon: "library-outline" },
  { id: "recovery", title: "Recovery & history", subtitle: "Version history and selective restore", icon: "time-outline" },
] as const;

export type IntelligenceModuleId = typeof INTELLIGENCE_MODULES[number]["id"];
const MODULE_IDS = new Set<string>(INTELLIGENCE_MODULES.map((module) => module.id));

export type IntelligenceRecord = {
  id: string; patient_id: string | null; kind: IntelligenceModuleId;
  title: string; event_date: string; summary: string; payload_json: string; media_uri: string;
  created_at: string; created_by: string | null; updated_at: string; updated_by: string | null; deleted_at: string | null;
};
export type KnowledgeArticle = {
  id: string; title: string; category: string; body: string; tags_json: string;
  created_at: string; updated_at: string; updated_by: string | null;
};
export type PatientOption = { id: string; mrNo: string; name: string; diagnosis: string; procedure: string; date: string };
export type PatientJourneyItem = {
  id: string;
  date: string;
  title: string;
  description: string;
  source: "patient" | "history" | "implant" | "intelligence";
  kind?: IntelligenceModuleId;
  mediaUri?: string;
};

export type SaveIntelligenceInput = {
  id?: string; expectedUpdatedAt?: string; patientId?: string | null; kind: IntelligenceModuleId;
  title: string; eventDate: string; summary?: string; payload: Record<string, string>;
  mediaUri?: string; changeNote?: string; userId: string; isAdmin?: boolean;
};

const now = () => new Date().toISOString();
const cleanText = (value: unknown, max = 4000) => String(value ?? "").trim().slice(0, max);

export function initializeIntelligenceStore() {
  db.execSync([
    "CREATE TABLE IF NOT EXISTS ortho_intelligence_records (id TEXT PRIMARY KEY NOT NULL,patient_id TEXT,kind TEXT NOT NULL,title TEXT NOT NULL,event_date TEXT NOT NULL,summary TEXT NOT NULL DEFAULT '',payload_json TEXT NOT NULL DEFAULT '{}',media_uri TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,created_by TEXT,updated_at TEXT NOT NULL,updated_by TEXT,deleted_at TEXT)",
    "CREATE INDEX IF NOT EXISTS idx_ortho_intelligence_patient ON ortho_intelligence_records(patient_id,event_date)",
    "CREATE INDEX IF NOT EXISTS idx_ortho_intelligence_kind_date ON ortho_intelligence_records(kind,event_date)",
    "CREATE INDEX IF NOT EXISTS idx_ortho_intelligence_deleted ON ortho_intelligence_records(deleted_at)",
    "CREATE TABLE IF NOT EXISTS ortho_intelligence_revisions (id TEXT PRIMARY KEY NOT NULL,record_id TEXT NOT NULL,snapshot_json TEXT NOT NULL,change_note TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,created_by TEXT)",
    "CREATE INDEX IF NOT EXISTS idx_ortho_intelligence_revisions_record ON ortho_intelligence_revisions(record_id,created_at)",
    "CREATE TABLE IF NOT EXISTS ortho_knowledge_articles (id TEXT PRIMARY KEY NOT NULL,title TEXT NOT NULL,category TEXT NOT NULL DEFAULT '',body TEXT NOT NULL,tags_json TEXT NOT NULL DEFAULT '[]',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,updated_by TEXT)",
    "CREATE INDEX IF NOT EXISTS idx_ortho_knowledge_title ON ortho_knowledge_articles(title)",
    "CREATE TABLE IF NOT EXISTS ortho_intelligence_settings (module_id TEXT PRIMARY KEY NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL,updated_by TEXT)"
  ].join(";\n") + ";");
}

function serializeRevision(row: IntelligenceRecord) {
  return JSON.stringify({
    id: row.id, patient_id: row.patient_id, kind: row.kind, title: row.title,
    event_date: row.event_date, summary: row.summary, payload_json: row.payload_json, media_uri: row.media_uri,
    updated_at: row.updated_at, updated_by: row.updated_by,
  });
}

export function listIntelligencePatients(userId: string, isAdmin: boolean): PatientOption[] {
  initializeIntelligenceStore();
  const rows = isAdmin
    ? db.getAllSync<any>("SELECT id,mr_no,name,diagnosis,procedure,date FROM patients ORDER BY date DESC,created_at DESC LIMIT 5000")
    : db.getAllSync<any>("SELECT id,mr_no,name,diagnosis,procedure,date FROM patients WHERE created_by=? ORDER BY date DESC,created_at DESC LIMIT 5000", [userId]);
  return rows.map((row) => ({
    id: String(row.id), mrNo: String(row.mr_no || ""), name: String(row.name || ""),
    diagnosis: String(row.diagnosis || ""), procedure: String(row.procedure || ""), date: String(row.date || ""),
  }));
}


export function getPatientJourney(patientId: string, userId: string, isAdmin: boolean): PatientJourneyItem[] {
  initializeIntelligenceStore();
  const patient = db.getFirstSync<any>(
    "SELECT id,mr_no,name,diagnosis,procedure,procedure_ii,implant,implant_ii,date,created_at FROM patients WHERE id=? AND (?=1 OR created_by=?) LIMIT 1",
    [patientId, isAdmin ? 1 : 0, userId],
  );
  if (!patient) throw new Error("Patient not found or access denied.");
  const items: PatientJourneyItem[] = [];
  const patientTitle = [patient.diagnosis, patient.procedure, patient.procedure_ii].filter(Boolean).join(" · ");
  items.push({
    id: "patient:" + String(patient.id),
    date: String(patient.date || patient.created_at || ""),
    title: "Patient record",
    description: [patient.mr_no, patient.name, patientTitle, [patient.implant, patient.implant_ii].filter(Boolean).join(" · ")].filter(Boolean).join(" · "),
    source: "patient",
  });
  const history = db.getAllSync<any>(
    "SELECT id,action,snapshot_json,created_at FROM patient_history WHERE patient_id=? ORDER BY created_at DESC LIMIT 500",
    [patientId],
  );
  history.forEach((row) => {
    let description = "";
    try {
      const snapshot = JSON.parse(String(row.snapshot_json || "{}"));
      description = [snapshot.diagnosis, snapshot.procedure, snapshot.implant, snapshot.notes].filter(Boolean).join(" · ");
    } catch {}
    items.push({
      id: "history:" + String(row.id),
      date: String(row.created_at || ""),
      title: String(row.action || "Patient history"),
      description,
      source: "history",
    });
  });
  const implants = db.getAllSync<any>(
    "SELECT id,name,category,size,quantity,created_at FROM patient_implants WHERE patient_id=? ORDER BY created_at DESC LIMIT 500",
    [patientId],
  );
  implants.forEach((row) => items.push({
    id: "implant:" + String(row.id),
    date: String(row.created_at || ""),
    title: "Implant used: " + String(row.name || "Unnamed implant"),
    description: [row.category, row.size, row.quantity ? "Qty " + row.quantity : ""].filter(Boolean).join(" · "),
    source: "implant",
  }));
  const clinical = db.getAllSync<IntelligenceRecord>(
    "SELECT * FROM ortho_intelligence_records WHERE patient_id=? AND deleted_at IS NULL ORDER BY event_date DESC,created_at DESC LIMIT 1000",
    [patientId],
  );
  clinical.forEach((row) => {
    let description = row.summary || "";
    try {
      const payload = JSON.parse(row.payload_json || "{}");
      const useful = Object.entries(payload).filter(([, value]) => String(value || "").trim()).slice(0, 4)
        .map(([key, value]) => key.replace(/([A-Z])/g, " $1") + ": " + String(value));
      if (useful.length) description = [description, useful.join(" · ")].filter(Boolean).join(" — ");
    } catch {}
    items.push({
      id: "intelligence:" + row.id,
      date: row.event_date || row.created_at,
      title: row.title,
      description,
      source: "intelligence",
      kind: row.kind,
      mediaUri: row.media_uri || "",
    });
  });
  return items.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

export function listIntelligenceRecords(options: { userId: string; isAdmin: boolean; kind?: IntelligenceModuleId; patientId?: string }): IntelligenceRecord[] {
  initializeIntelligenceStore();
  const where = ["r.deleted_at IS NULL"];
  const args: any[] = [];
  if (!options.isAdmin) {
    where.push("(r.created_by=? OR r.patient_id IN (SELECT id FROM patients WHERE created_by=?))");
    args.push(options.userId, options.userId);
  }
  if (options.kind) { where.push("r.kind=?"); args.push(options.kind); }
  if (options.patientId) { where.push("r.patient_id=?"); args.push(options.patientId); }
  return db.getAllSync<IntelligenceRecord>(
    "SELECT r.* FROM ortho_intelligence_records r WHERE " + where.join(" AND ") + " ORDER BY r.event_date DESC,r.created_at DESC LIMIT 1500",
    args,
  );
}

export function getIntelligenceRecord(id: string, userId: string, isAdmin: boolean, includeDeleted = false): IntelligenceRecord | null {
  initializeIntelligenceStore();
  const row = db.getFirstSync<IntelligenceRecord>(
    "SELECT r.* FROM ortho_intelligence_records r WHERE r.id=? AND (?=1 OR r.deleted_at IS NULL) AND (?=1 OR r.created_by=? OR r.patient_id IN (SELECT id FROM patients WHERE created_by=?)) LIMIT 1",
    [id, includeDeleted ? 1 : 0, isAdmin ? 1 : 0, userId, userId],
  );
  return row || null;
}

function validatePayload(payload: Record<string, string>): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Enter valid structured details.");
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload).slice(0, 80)) {
    const safeKey = cleanText(key, 60);
    if (safeKey) clean[safeKey] = cleanText(value, 4000);
  }
  const json = JSON.stringify(clean);
  if (json.length > 65000) throw new Error("This entry is too large. Shorten the notes and try again.");
  return json;
}

function addRevision(row: IntelligenceRecord, userId: string, note = "") {
  db.runSync(
    "INSERT INTO ortho_intelligence_revisions (id,record_id,snapshot_json,change_note,created_at,created_by) VALUES (?,?,?,?,?,?)",
    [Crypto.randomUUID(), row.id, serializeRevision(row), cleanText(note, 180), now(), userId || null],
  );
  db.runSync(
    "DELETE FROM ortho_intelligence_revisions WHERE record_id=? AND id NOT IN (SELECT id FROM ortho_intelligence_revisions WHERE record_id=? ORDER BY created_at DESC LIMIT 100)",
    [row.id, row.id],
  );
}

export function saveIntelligenceRecord(input: SaveIntelligenceInput): IntelligenceRecord {
  initializeIntelligenceStore();
  if (!MODULE_IDS.has(input.kind)) throw new Error("Unknown intelligence module.");
  const title = cleanText(input.title, 180);
  if (!title) throw new Error("Enter a title for this record.");
  const eventDate = cleanText(input.eventDate, 30);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate) || Number.isNaN(Date.parse(eventDate + "T12:00:00"))) throw new Error("Enter a valid event date.");
  const summary = cleanText(input.summary, 1000);
  const payloadValues = input.payload || {};
  const isValidDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + "T12:00:00"));
  if (input.kind === "follow_up" && payloadValues.dueDate && !isValidDate(cleanText(payloadValues.dueDate, 20))) {
    throw new Error("Enter the follow-up due date as YYYY-MM-DD.");
  }
  if (input.kind === "implant_passport" && payloadValues.expiryDate && !isValidDate(cleanText(payloadValues.expiryDate, 20))) {
    throw new Error("Enter the implant expiry date as YYYY-MM-DD.");
  }
  if (input.kind === "implant_passport" && payloadValues.compatibilityVerifiedDate && !isValidDate(cleanText(payloadValues.compatibilityVerifiedDate, 20))) {
    throw new Error("Enter the compatibility verification date as YYYY-MM-DD.");
  }
  if (input.kind === "rehab" && payloadValues.painScore !== undefined && payloadValues.painScore !== "") {
    const pain = Number(payloadValues.painScore);
    if (!Number.isFinite(pain) || pain < 0 || pain > 10) throw new Error("Pain score must be between 0 and 10.");
  }
  for (const key of ["flexionDegrees","extensionDegrees"]) {
    if (payloadValues[key] !== undefined && payloadValues[key] !== "") {
      const angle = Number(payloadValues[key]);
      if (!Number.isFinite(angle) || angle < 0 || angle > 360) throw new Error("Range-of-motion measurements must be between 0 and 360 degrees.");
    }
  }
  const payloadJson = validatePayload(payloadValues);
  const mediaUri = cleanText(input.mediaUri, 24000000);
  const patientId = input.patientId ? cleanText(input.patientId, 100) : null;
  if (patientId) {
    const patient = input.isAdmin
      ? db.getFirstSync<any>("SELECT id FROM patients WHERE id=? LIMIT 1", [patientId])
      : db.getFirstSync<any>("SELECT id FROM patients WHERE id=? AND created_by=? LIMIT 1", [patientId, input.userId]);
    if (!patient) throw new Error("The selected patient no longer exists or you do not have access to it. Choose an available patient again.");
  }
  const timestamp = now();
  if (input.id) {
    const existing = db.getFirstSync<IntelligenceRecord>("SELECT * FROM ortho_intelligence_records WHERE id=? AND deleted_at IS NULL AND (?=1 OR created_by=? OR patient_id IN (SELECT id FROM patients WHERE created_by=?)) LIMIT 1", [input.id, input.isAdmin ? 1 : 0, input.userId, input.userId]);
    if (!existing) throw new Error("This record is no longer available. Refresh and try again.");
    if (input.expectedUpdatedAt && existing.updated_at !== input.expectedUpdatedAt) {
      throw new Error("This record changed on another screen. Reload it before saving to avoid overwriting newer information.");
    }
    db.withTransactionSync(() => {
      addRevision(existing, input.userId, input.changeNote || "Before edit");
      db.runSync(
        "UPDATE ortho_intelligence_records SET patient_id=?,kind=?,title=?,event_date=?,summary=?,payload_json=?,media_uri=?,updated_at=?,updated_by=? WHERE id=?",
        [patientId, input.kind, title, eventDate, summary, payloadJson, mediaUri, timestamp, input.userId, input.id],
      );
    });
    return db.getFirstSync<IntelligenceRecord>("SELECT * FROM ortho_intelligence_records WHERE id=?", [input.id])!;
  }
  const recordId = Crypto.randomUUID();
  db.runSync(
    "INSERT INTO ortho_intelligence_records (id,patient_id,kind,title,event_date,summary,payload_json,media_uri,created_at,created_by,updated_at,updated_by,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL)",
    [recordId, patientId, input.kind, title, eventDate, summary, payloadJson, mediaUri, timestamp, input.userId, timestamp, input.userId],
  );
  return db.getFirstSync<IntelligenceRecord>("SELECT * FROM ortho_intelligence_records WHERE id=?", [recordId])!;
}

export function softDeleteIntelligenceRecord(id: string, userId: string, isAdmin: boolean) {
  const existing = getIntelligenceRecord(id, userId, isAdmin);
  if (!existing) throw new Error("Record not found or access denied.");
  const timestamp = now();
  db.withTransactionSync(() => {
    addRevision(existing, userId, "Before delete");
    db.runSync("UPDATE ortho_intelligence_records SET deleted_at=?,updated_at=?,updated_by=? WHERE id=?", [timestamp, timestamp, userId, id]);
  });
}

export function listArchivedIntelligenceRecords(options: { userId: string; isAdmin: boolean }): IntelligenceRecord[] {
  initializeIntelligenceStore();
  const sql = options.isAdmin
    ? "SELECT * FROM ortho_intelligence_records WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 1000"
    : "SELECT * FROM ortho_intelligence_records WHERE deleted_at IS NOT NULL AND (created_by=? OR patient_id IN (SELECT id FROM patients WHERE created_by=?)) ORDER BY deleted_at DESC LIMIT 1000";
  return db.getAllSync<IntelligenceRecord>(sql, options.isAdmin ? [] : [options.userId, options.userId]);
}

export function restoreArchivedIntelligenceRecord(id: string, userId: string, isAdmin: boolean) {
  const existing = getIntelligenceRecord(id, userId, isAdmin, true);
  if (!existing || !existing.deleted_at) throw new Error("Archived record not found or access denied.");
  const timestamp = now();
  db.withTransactionSync(() => {
    addRevision(existing, userId, "Before restoring archived entry");
    db.runSync("UPDATE ortho_intelligence_records SET deleted_at=NULL,updated_at=?,updated_by=? WHERE id=?", [timestamp, userId, id]);
  });
}
export function listIntelligenceRevisions(recordId: string, userId: string, isAdmin: boolean) {
  if (!getIntelligenceRecord(recordId, userId, isAdmin, true)) return [];
  return db.getAllSync<any>(
    "SELECT id,record_id,snapshot_json,change_note,created_at,created_by FROM ortho_intelligence_revisions WHERE record_id=? ORDER BY created_at DESC LIMIT 100",
    [recordId],
  );
}

export function restoreIntelligenceRevision(recordId: string, revisionId: string, userId: string, isAdmin: boolean) {
  const current = getIntelligenceRecord(recordId, userId, isAdmin, true);
  if (!current) throw new Error("Record not found or access denied.");
  const revision = db.getFirstSync<any>("SELECT snapshot_json FROM ortho_intelligence_revisions WHERE id=? AND record_id=? LIMIT 1", [revisionId, recordId]);
  if (!revision) throw new Error("This saved version is no longer available.");
  let snapshot: any;
  try { snapshot = JSON.parse(String(revision.snapshot_json || "{}")); } catch { throw new Error("The selected saved version is damaged."); }
  if (!snapshot || snapshot.id !== recordId || !MODULE_IDS.has(String(snapshot.kind))) throw new Error("The selected saved version is invalid.");
  const timestamp = now();
  const payload = JSON.parse(String(snapshot.payload_json || "{}"));
  db.withTransactionSync(() => {
    addRevision(current, userId, "Before recovery restore");
    db.runSync(
      "UPDATE ortho_intelligence_records SET patient_id=?,kind=?,title=?,event_date=?,summary=?,payload_json=?,media_uri=?,updated_at=?,updated_by=?,deleted_at=NULL WHERE id=?",
      [snapshot.patient_id || null, snapshot.kind, cleanText(snapshot.title, 180), cleanText(snapshot.event_date, 30),
       cleanText(snapshot.summary, 1000), validatePayload(payload), cleanText(snapshot.media_uri, 24000000), timestamp, userId, recordId],
    );
  });
}

export function listKnowledgeArticles(search = ""): KnowledgeArticle[] {
  initializeIntelligenceStore();
  const query = cleanText(search, 120).toLowerCase();
  if (!query) return db.getAllSync<KnowledgeArticle>("SELECT * FROM ortho_knowledge_articles ORDER BY category COLLATE NOCASE,title COLLATE NOCASE LIMIT 1000");
  const like = "%" + query + "%";
  return db.getAllSync<KnowledgeArticle>(
    "SELECT * FROM ortho_knowledge_articles WHERE LOWER(title) LIKE ? OR LOWER(category) LIKE ? OR LOWER(body) LIKE ? OR LOWER(tags_json) LIKE ? ORDER BY category COLLATE NOCASE,title COLLATE NOCASE LIMIT 1000",
    [like, like, like, like],
  );
}

export function saveKnowledgeArticle(input: { id?: string; title: string; category: string; body: string; tags: string[]; userId: string }) {
  initializeIntelligenceStore();
  const title = cleanText(input.title, 180);
  const category = cleanText(input.category, 80);
  const body = cleanText(input.body, 50000);
  const tags = input.tags.map((tag) => cleanText(tag, 50)).filter(Boolean).slice(0, 30);
  if (!title || !body) throw new Error("Article title and content are required.");
  const timestamp = now();
  if (input.id) {
    const current = db.getFirstSync<any>("SELECT id FROM ortho_knowledge_articles WHERE id=?", [input.id]);
    if (!current) throw new Error("Knowledge article not found.");
    db.runSync("UPDATE ortho_knowledge_articles SET title=?,category=?,body=?,tags_json=?,updated_at=?,updated_by=? WHERE id=?",
      [title, category, body, JSON.stringify(tags), timestamp, input.userId, input.id]);
    return input.id;
  }
  const id = Crypto.randomUUID();
  db.runSync("INSERT INTO ortho_knowledge_articles (id,title,category,body,tags_json,created_at,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?)",
    [id, title, category, body, JSON.stringify(tags), timestamp, timestamp, input.userId]);
  return id;
}

export function deleteKnowledgeArticle(id: string) {
  db.runSync("DELETE FROM ortho_knowledge_articles WHERE id=?", [id]);
}

export function listIntelligenceModuleSettings(): Record<string, boolean> {
  initializeIntelligenceStore();
  const rows = db.getAllSync<any>("SELECT module_id,enabled FROM ortho_intelligence_settings");
  const output: Record<string, boolean> = {};
  INTELLIGENCE_MODULES.forEach((module) => { output[module.id] = true; });
  rows.forEach((row) => {
    if (MODULE_IDS.has(String(row.module_id))) output[String(row.module_id)] = Number(row.enabled) === 1;
  });
  return output;
}

export function setIntelligenceModuleEnabled(moduleId: string, enabled: boolean, userId: string) {
  if (!MODULE_IDS.has(moduleId)) throw new Error("Unknown intelligence module.");
  db.runSync(
    "INSERT OR REPLACE INTO ortho_intelligence_settings (module_id,enabled,updated_at,updated_by) VALUES (?,?,?,?)",
    [moduleId, enabled ? 1 : 0, now(), userId],
  );
}

export function getIntelligenceRecordsForResearch(userId: string, isAdmin: boolean) {
  initializeIntelligenceStore();
  const patientWhere = isAdmin ? "" : " AND created_by=?";
  const patientArgs = isAdmin ? [] : [userId];
  const recordScope = isAdmin ? "" : " AND (created_by=? OR patient_id IN (SELECT id FROM patients WHERE created_by=?))";
  const recordArgs = isAdmin ? [] : [userId, userId];
  return {
    procedures: db.getAllSync<any>("SELECT TRIM(procedure) AS label,COUNT(*) AS count FROM patients WHERE TRIM(COALESCE(procedure,''))<>''" + patientWhere + " GROUP BY TRIM(procedure) ORDER BY count DESC,label COLLATE NOCASE", patientArgs),
    diagnoses: db.getAllSync<any>("SELECT TRIM(diagnosis) AS label,COUNT(*) AS count FROM patients WHERE TRIM(COALESCE(diagnosis,''))<>''" + patientWhere + " GROUP BY TRIM(diagnosis) ORDER BY count DESC,label COLLATE NOCASE", patientArgs),
    rehabilitation: db.getAllSync<any>("SELECT json_extract(payload_json,'$.painScore') AS pain_score,COUNT(*) AS count FROM ortho_intelligence_records WHERE kind='rehab' AND deleted_at IS NULL AND json_valid(payload_json)" + recordScope + " GROUP BY json_extract(payload_json,'$.painScore') ORDER BY pain_score", recordArgs),
  };
}
