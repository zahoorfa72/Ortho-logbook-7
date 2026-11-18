import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator, Alert, Image, InteractionManager, Modal, Pressable, ScrollView, Switch,
  Text, TextInput, View,
} from "react-native";
import { router } from "expo-router";
import Ionicons from "@react-native-vector-icons/ionicons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
import { launchImageLibraryAsync } from "expo-image-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";

import { db } from "@/src/db/database";
import { useAuth } from "@/src/auth/AuthContext";
import { useToast } from "@/src/components/toast";
import { EmptyState } from "@/src/components/EmptyState";
import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";
import {
  deleteKnowledgeArticle, getIntelligencePatientContext, getIntelligenceRecordsForResearch, getPatientJourney, initializeIntelligenceStore,
  INTELLIGENCE_MODULES, listIntelligenceModuleSettings, listIntelligencePatients,
  listIntelligenceRecords, listIntelligenceRevisions, listKnowledgeArticles, listArchivedIntelligenceRecords,
  restoreArchivedIntelligenceRecord, restoreIntelligenceRevision, saveIntelligenceRecord, saveKnowledgeArticle,
  setIntelligenceModuleEnabled, softDeleteIntelligenceRecord,
  type IntelligenceModuleId, type IntelligenceRecord, type KnowledgeArticle, type PatientOption, type PatientJourneyItem, type PatientContext,
} from "@/src/intelligence/store";

type FieldDefinition = { key: string; label: string; placeholder?: string; multiline?: boolean };
const FIELD_DEFINITIONS: Record<IntelligenceModuleId, FieldDefinition[]> = {
  body_map: [
    { key: "region", label: "Anatomical region", placeholder: "e.g. distal radius" },
    { key: "side", label: "Side", placeholder: "Right / Left / Bilateral" },
    { key: "bone", label: "Bone", placeholder: "Bone name" },
    { key: "fractureType", label: "Injury / fracture type", placeholder: "Describe the injury" },
    { key: "classification", label: "Classification", placeholder: "Classification system and grade" },
    { key: "mechanism", label: "Mechanism of injury", placeholder: "How the injury occurred" },
    { key: "notes", label: "Clinical notes", multiline: true },
  ],
  xray: [
    { key: "view", label: "X-ray view", placeholder: "AP / lateral / oblique / other" },
    { key: "bodyRegion", label: "Body region", placeholder: "Anatomy and side" },
    { key: "report", label: "Report / observations", multiline: true },
    { key: "comparison", label: "Comparison with previous study", multiline: true },
    { key: "reviewer", label: "Reviewed by" },
  ],
  implant_passport: [
    { key: "implantName", label: "Implant name", placeholder: "Exact device name" },
    { key: "category", label: "Category", placeholder: "Plate / nail / screw / prosthesis" },
    { key: "manufacturer", label: "Manufacturer" },
    { key: "model", label: "Model / catalogue number" },
    { key: "lotNumber", label: "Batch / lot number" },
    { key: "serialNumber", label: "Serial number" },
    { key: "expiryDate", label: "Expiry date (YYYY-MM-DD)" },
    { key: "supplier", label: "Supplier" },
    { key: "dimensions", label: "Dimensions / size" },
    { key: "compatibilityGroup", label: "Implant system / compatibility group" },
    { key: "compatibleWith", label: "Compatible components (catalogue-confirmed)", multiline: true },
    { key: "instrumentSet", label: "Required instrument set" },
    { key: "compatibilityVerifiedBy", label: "Compatibility checked by" },
    { key: "compatibilityVerifiedDate", label: "Compatibility verification date (YYYY-MM-DD)" },
    { key: "barcode", label: "Barcode / QR content" },
    { key: "procedure", label: "Procedure / operation reference" },
  ],
  digital_twin: [
    { key: "milestone", label: "Journey milestone", placeholder: "Injury / admission / surgery / review / discharge" },
    { key: "status", label: "Status" },
    { key: "notes", label: "Clinical event details", multiline: true },
  ],
  xray_review: [
    { key: "view", label: "Imaging view / modality" },
    { key: "region", label: "Region and side" },
    { key: "imageQuality", label: "Image quality", placeholder: "Adequate / limited / repeat required" },
    { key: "findings", label: "Clinician-entered findings", multiline: true },
    { key: "measurement", label: "Measurement / angle" },
    { key: "measurementUnit", label: "Measurement unit" },
    { key: "reviewer", label: "Reviewer" },
    { key: "reviewStatus", label: "Review status", placeholder: "Needs review / reviewed / escalated" },
  ],
  rehab: [
    { key: "painScore", label: "Pain score (0–10)" },
    { key: "flexionDegrees", label: "Flexion (degrees)" },
    { key: "extensionDegrees", label: "Extension (degrees)" },
    { key: "weightBearing", label: "Weight-bearing status" },
    { key: "mobility", label: "Mobility / gait" },
    { key: "exercises", label: "Rehabilitation activities", multiline: true },
    { key: "notes", label: "Therapist / clinician notes", multiline: true },
  ],
  surgery_checklist: [
    { key: "procedure", label: "Procedure" },
    { key: "checklist", label: "Checklist (edit and tick each item)", multiline: true },
    { key: "surgeon", label: "Surgeon / lead clinician" },
    { key: "assistant", label: "Assistant / scrub team" },
    { key: "signOff", label: "Sign-off name and role" },
    { key: "status", label: "Checklist status", placeholder: "Pending / completed / exception recorded" },
  ],
  clinical_note: [
    { key: "complaint", label: "Presenting complaint", multiline: true },
    { key: "examination", label: "Examination", multiline: true },
    { key: "diagnosis", label: "Working diagnosis", multiline: true },
    { key: "plan", label: "Plan / treatment", multiline: true },
    { key: "followUp", label: "Follow-up instructions", multiline: true },
  ],
  follow_up: [
    { key: "dueDate", label: "Due date (YYYY-MM-DD)" },
    { key: "priority", label: "Priority", placeholder: "Routine / soon / urgent" },
    { key: "status", label: "Status", placeholder: "Open / contacted / completed / cancelled" },
    { key: "reason", label: "Reason for review" },
    { key: "contactAttempt", label: "Contact attempts" },
    { key: "notes", label: "Follow-up notes", multiline: true },
  ],
  research: [],
  knowledge: [],
  recovery: [],
};

const BODY_REGIONS = [
  "Skull / face", "Cervical spine", "Thoracic spine", "Lumbar spine", "Pelvis",
  "Shoulder", "Clavicle", "Scapula", "Humerus", "Elbow", "Radius / ulna",
  "Wrist", "Hand / fingers", "Hip", "Femur", "Knee", "Patella", "Tibia / fibula",
  "Ankle", "Foot / toes", "Multiple regions",
];
const CHECKLIST_TEMPLATE = [
  "[ ] Correct patient identity confirmed",
  "[ ] Consent and procedure documentation checked",
  "[ ] Correct side and site confirmed",
  "[ ] Relevant imaging available",
  "[ ] Implants and instruments checked",
  "[ ] Sterility indicators confirmed",
  "[ ] Team time-out completed",
  "[ ] Post-operative plan documented",
].join("\n");

const today = () => new Date().toISOString().slice(0, 10);
function safePayload(record: IntelligenceRecord): Record<string, string> {
  try {
    const parsed = JSON.parse(record.payload_json || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const output: Record<string, string> = {};
    Object.entries(parsed).forEach(([key, value]) => { output[key] = String(value ?? ""); });
    return output;
  } catch { return {}; }
}
function csvCell(value: unknown) {
  const text = String(value ?? "");
  return '"' + text.replace(/"/g, '""') + '"';
}

export default function IntelligenceHubScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const toast = useToast();
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const xrayCameraRef = useRef<any>(null);
  const [xrayCameraOpen, setXrayCameraOpen] = useState(false);
  const [xrayCameraReady, setXrayCameraReady] = useState(false);

  const [moduleId, setModuleId] = useState<IntelligenceModuleId>("body_map");
  const [records, setRecords] = useState<IntelligenceRecord[]>([]);
  const [journeyItems, setJourneyItems] = useState<PatientJourneyItem[]>([]);
  const [archivedRecords, setArchivedRecords] = useState<IntelligenceRecord[]>([]);
  const [patients, setPatients] = useState<PatientOption[]>([]);
  const [moduleSettings, setModuleSettings] = useState<Record<string, boolean>>({});
  const [knowledgeArticles, setKnowledgeArticles] = useState<KnowledgeArticle[]>([]);
  const [knowledgeSearch, setKnowledgeSearch] = useState("");
  const [selectedArticle, setSelectedArticle] = useState<KnowledgeArticle | null>(null);
  const [selectedPatientId, setSelectedPatientId] = useState("");
  const [search, setSearch] = useState("");
  const [patientPickerOpen, setPatientPickerOpen] = useState(false);
  const [patientPickerSearch, setPatientPickerSearch] = useState("");
  const [formPatientId, setFormPatientId] = useState("");
  const [formPatientContext, setFormPatientContext] = useState<PatientContext | null>(null);
  const [formVisible, setFormVisible] = useState(false);
  const [editing, setEditing] = useState<IntelligenceRecord | null>(null);
  const [formTitle, setFormTitle] = useState("");
  const [formDate, setFormDate] = useState(today());
  const [formSummary, setFormSummary] = useState("");
  const [formFields, setFormFields] = useState<Record<string, string>>({});
  const [mediaUri, setMediaUri] = useState("");
  const [saving, setSaving] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [moduleSettingsOpen, setModuleSettingsOpen] = useState(false);
  const [articleEditorOpen, setArticleEditorOpen] = useState(false);
  const [articleEditing, setArticleEditing] = useState<KnowledgeArticle | null>(null);
  const [articleTitle, setArticleTitle] = useState("");
  const [articleCategory, setArticleCategory] = useState("");
  const [articleBody, setArticleBody] = useState("");
  const [articleTags, setArticleTags] = useState("");
  const [selectedRecordId, setSelectedRecordId] = useState("");
  const [revisions, setRevisions] = useState<any[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const userId = user?.id || "";
  const isAdmin = user?.role === "admin";
  const selectedPatient = patients.find((patient) => patient.id === selectedPatientId) || null;
  const formPatient = patients.find((patient) => patient.id === formPatientId) || null;
  const patientById = useMemo(() => new Map(patients.map((patient) => [patient.id, patient])), [patients]);

  const refresh = useCallback(() => {
    if (!userId) return;
    try {
      initializeIntelligenceStore();
      // Only Recovery needs all module records. Other views query a compact
      // page for the active type and selected patient.
      const nextRecords = moduleId === "recovery"
        ? listIntelligenceRecords({ userId, isAdmin, limit: 120 })
        : moduleId === "digital_twin" || moduleId === "research" || moduleId === "knowledge"
          ? []
          : listIntelligenceRecords({ userId, isAdmin, kind: moduleId, patientId: selectedPatientId || undefined, limit: 80 });
      setRecords(nextRecords);
      setArchivedRecords(moduleId === "recovery" ? listArchivedIntelligenceRecords({ userId, isAdmin }) : []);
      setPatients(listIntelligencePatients(userId, isAdmin, "", 60));
      setModuleSettings(listIntelligenceModuleSettings());
    } catch (error: any) {
      toast(error?.message || "Could not load Orthopaedic Intelligence data.", "error");
    }
  }, [userId, isAdmin, moduleId, selectedPatientId, toast]);

  useEffect(() => {
    // Allow the first navigation frame to paint before synchronous SQLite reads.
    const task = InteractionManager.runAfterInteractions(refresh);
    return () => task.cancel();
  }, [refresh]);

  useEffect(() => {
    if (!selectedPatientId || !userId || moduleId !== "digital_twin") { setJourneyItems([]); return; }
    const task = InteractionManager.runAfterInteractions(() => {
      try { setJourneyItems(getPatientJourney(selectedPatientId, userId, isAdmin)); }
      catch (error: any) { setJourneyItems([]); toast(error?.message || "Could not load patient journey.", "error"); }
    });
    return () => task.cancel();
  }, [selectedPatientId, userId, isAdmin, moduleId, toast]);

  useEffect(() => {
    if (!userId || moduleId !== "knowledge") return;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    const timer = setTimeout(() => {
      task = InteractionManager.runAfterInteractions(() => {
        if (!cancelled) {
          try { setKnowledgeArticles(listKnowledgeArticles(knowledgeSearch, 50)); }
          catch (error: any) { toast(error?.message || "Could not search the knowledge library.", "error"); }
        }
      });
    }, 180);
    return () => { cancelled = true; clearTimeout(timer); task?.cancel(); };
  }, [userId, moduleId, knowledgeSearch, toast]);

  const visibleModules = INTELLIGENCE_MODULES.filter((module) => moduleSettings[module.id] !== false);
  const activeModule = INTELLIGENCE_MODULES.find((module) => module.id === moduleId) || INTELLIGENCE_MODULES[0];

  const visibleRecords = useMemo(() => {
    let rows = records;
    if (moduleId !== "digital_twin" && moduleId !== "recovery") rows = rows.filter((record) => record.kind === moduleId);
    if (selectedPatientId) rows = rows.filter((record) => record.patient_id === selectedPatientId);
    const q = search.trim().toLowerCase();
    if (q) rows = rows.filter((record) => {
      const payload = safePayload(record);
      return [record.title, record.summary, ...Object.values(payload)].join(" ").toLowerCase().includes(q);
    });
    if (moduleId === "follow_up") {
      rows = rows.slice().sort((a, b) => {
        const av = safePayload(a), bv = safePayload(b);
        const ad = av.dueDate || a.event_date, bd = bv.dueDate || b.event_date;
        return ad.localeCompare(bd);
      });
    }
    return rows;
  }, [records, moduleId, selectedPatientId, search]);

  const rehabTrend = useMemo(() => {
    if (!selectedPatientId) return [];
    return records.filter((record) => record.kind === "rehab" && record.patient_id === selectedPatientId)
      .slice().sort((a,b) => a.event_date.localeCompare(b.event_date)).slice(-8)
      .map((record) => {
        const payload = safePayload(record);
        const pain = Number(payload.painScore);
        return { id: record.id, date: record.event_date, pain: Number.isFinite(pain) && payload.painScore !== "" ? pain : null, flexion: payload.flexionDegrees || "" };
      });
  }, [records, selectedPatientId]);

  const compareRecords = useMemo(
    () => records.filter((record) => record.kind === "xray" && !!selectedPatientId && record.patient_id === selectedPatientId).slice(0, 2).reverse(),
    [records, selectedPatientId],
  );

  const reloadKnowledge = (query = knowledgeSearch) => setKnowledgeArticles(listKnowledgeArticles(query, 50));
  const openNewRecord = () => {
    if (moduleId === "research" || moduleId === "knowledge" || moduleId === "recovery") return;
    setEditing(null);
    setFormTitle("");
    setFormDate(today());
    setFormSummary("");
    setFormFields(moduleId === "surgery_checklist" ? { checklist: CHECKLIST_TEMPLATE, status: "Pending" } :
      moduleId === "follow_up" ? { dueDate: today(), status: "Open", priority: "Routine" } : {});
    setMediaUri("");
    const context = selectedPatientId ? getIntelligencePatientContext(selectedPatientId, userId, isAdmin) : null;
    setFormPatientId(selectedPatientId);
    setFormPatientContext(context);
    if (moduleId === "xray" && context) {
      setFormTitle(context.mrNo + " · " + context.name + " · X-ray");
      setFormSummary([context.diagnosis, context.procedure, context.procedureII].filter(Boolean).join(" · "));
    }
    setFormVisible(true);
  };

  const openEditRecord = (record: IntelligenceRecord) => {
    setEditing(record);
    setModuleId(record.kind);
    setFormTitle(record.title);
    setFormDate(record.event_date || today());
    setFormSummary(record.summary || "");
    setFormFields(safePayload(record));
    setMediaUri(record.media_uri || "");
    setFormPatientId(record.patient_id || "");
    setFormPatientContext(record.patient_id ? getIntelligencePatientContext(record.patient_id, userId, isAdmin) : null);
    setFormVisible(true);
  };

  const saveRecord = () => {
    if (!userId) return;
    setSaving(true);
    try {
      saveIntelligenceRecord({
        id: editing?.id,
        expectedUpdatedAt: editing?.updated_at,
        patientId: formPatientId || null,
        kind: moduleId,
        title: formTitle,
        eventDate: formDate,
        summary: formSummary,
        payload: formFields,
        mediaUri,
        userId,
        isAdmin,
        changeNote: "Edited in Orthopaedic Intelligence",
      });
      setFormVisible(false);
      setEditing(null);
      toast(editing ? "Record updated and previous version preserved." : "Record saved offline.", "success");
      refresh();
    } catch (error: any) {
      toast(error?.message || "Could not save this record.", "error");
    } finally {
      setSaving(false);
    }
  };

  const deleteRecord = (record: IntelligenceRecord) => {
    Alert.alert("Move entry to recovery history?", "The entry will be hidden from the timeline. A revision is retained for recovery.", [
      { text: "Cancel", style: "cancel" },
      { text: "Move to recovery", style: "destructive", onPress: () => {
        try {
          softDeleteIntelligenceRecord(record.id, userId, isAdmin);
          toast("Entry moved to recovery history.", "success");
          if (selectedRecordId === record.id) { setSelectedRecordId(""); setRevisions([]); }
          refresh();
        } catch (error: any) { toast(error?.message || "Could not remove entry.", "error"); }
      } },
    ]);
  };

  const saveXrayImageCopy = async (sourceUri: string) => {
    const base = FileSystem.documentDirectory;
    if (!base) throw new Error("Private app storage is unavailable for this X-ray.");
    const destination = base + "ortho-intelligence-xray-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".jpg";
    await FileSystem.copyAsync({ from: sourceUri, to: destination });
    return destination;
  };

  const pickXray = async () => {
    try {
      // Keep diagnostic images at source quality; lossy resizing is not applied.
      const result = await launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1, allowsEditing: false });
      if (!result.canceled && result.assets[0]?.uri) {
        const destination = await saveXrayImageCopy(result.assets[0].uri);
        setMediaUri(destination);
      }
    } catch (error: any) {
      toast(error?.message || "Could not open image library.", "error");
    }
  };

  const openXrayCamera = async () => {
    try {
      if (!cameraPermission?.granted) {
        const permission = await requestCameraPermission();
        if (!permission.granted) { toast("Camera permission is required to capture an X-ray.", "error"); return; }
      }
      setXrayCameraReady(false);
      setXrayCameraOpen(true);
    } catch (error: any) {
      toast(error?.message || "Could not open the camera.", "error");
    }
  };

  const captureXray = async () => {
    if (!xrayCameraRef.current || !xrayCameraReady) return;
    try {
      const photo = await xrayCameraRef.current.takePictureAsync({ quality: 1, skipProcessing: false, exif: true });
      if (!photo?.uri) throw new Error("The camera did not return an image.");
      const destination = await saveXrayImageCopy(photo.uri);
      setMediaUri(destination);
      setXrayCameraOpen(false);
      toast("X-ray image saved at original capture quality.", "success");
    } catch (error: any) {
      toast(error?.message || "Could not capture the X-ray.", "error");
    }
  };

  const selectPatient = (patient: PatientOption | null, mode: "filter" | "form") => {
    setPatients(listIntelligencePatients(userId, isAdmin, "", 60));
    if (mode === "filter") {
      setSelectedPatientId(patient?.id || "");
    } else {
      setFormPatientId(patient?.id || "");
      const context = patient ? getIntelligencePatientContext(patient.id, userId, isAdmin) : null;
      setFormPatientContext(context);
      if (context && (moduleId === "xray" || moduleId === "xray_review")) {
        setFormTitle(current => current || (context.mrNo + " · " + context.name + " · Imaging"));
        setFormSummary(current => current || [context.diagnosis, context.procedure, context.procedureII].filter(Boolean).join(" · "));
      }
      if (context && moduleId === "implant_passport" && context.implants.length === 1) {
        const existing = context.implants[0];
        setFormFields(current => ({
          ...current,
          implantName: current.implantName || existing.name,
          category: current.category || existing.category,
          dimensions: current.dimensions || existing.size,
          patientImplantId: existing.id,
          patientImplantSource: "Existing patient implant record",
        }));
      }
    }
    setPatientPickerOpen(false);
    setPatientPickerSearch("");
  };

  const openPatientPicker = (mode: "filter" | "form") => {
    setPickerMode(mode);
    setPatientPickerSearch("");
    setPatientPickerOpen(true);
  };
  const [pickerMode, setPickerMode] = useState<"filter" | "form">("filter");

  const filteredPatients = patients;
  useEffect(() => {
    if (!patientPickerOpen || !userId) return;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    const timer = setTimeout(() => {
      task = InteractionManager.runAfterInteractions(() => {
        if (!cancelled) {
          try { setPatients(listIntelligencePatients(userId, isAdmin, patientPickerSearch, 50)); }
          catch (error: any) { toast(error?.message || "Could not search patients.", "error"); }
        }
      });
    }, 180);
    return () => { cancelled = true; clearTimeout(timer); task?.cancel(); };
  }, [patientPickerOpen, patientPickerSearch, userId, isAdmin, toast]);

  const showRevisions = (record: IntelligenceRecord) => {
    setSelectedRecordId(record.id);
    try { setRevisions(listIntelligenceRevisions(record.id, userId, isAdmin)); }
    catch { setRevisions([]); }
  };

  const restoreRevision = (revisionId: string) => {
    if (!selectedRecordId) return;
    Alert.alert("Restore this version?", "The current entry will also be preserved in version history.", [
      { text: "Cancel", style: "cancel" },
      { text: "Restore version", onPress: () => {
        try {
          restoreIntelligenceRevision(selectedRecordId, revisionId, userId, isAdmin);
          toast("Saved version restored.", "success");
          setRevisions(listIntelligenceRevisions(selectedRecordId, userId, isAdmin));
          refresh();
        } catch (error: any) { toast(error?.message || "Could not restore version.", "error"); }
      } },
    ]);
  };
  const saveArticle = () => {
    try {
      saveKnowledgeArticle({
        id: articleEditing?.id, title: articleTitle, category: articleCategory,
        body: articleBody, tags: articleTags.split(",").map((tag) => tag.trim()).filter(Boolean), userId,
      });
      setArticleEditorOpen(false);
      setArticleEditing(null);
      setArticleTitle(""); setArticleCategory(""); setArticleBody(""); setArticleTags("");
      reloadKnowledge("");
      toast("Knowledge reference saved on this device.", "success");
    } catch (error: any) { toast(error?.message || "Could not save reference.", "error"); }
  };

  const openArticleEditor = (article?: KnowledgeArticle) => {
    if (article && !isAdmin) return;
    setArticleEditing(article || null);
    setArticleTitle(article?.title || "");
    setArticleCategory(article?.category || "");
    setArticleBody(article?.body || "");
    try { setArticleTags(article ? JSON.parse(article.tags_json || "[]").join(", ") : ""); } catch { setArticleTags(""); }
    setArticleEditorOpen(true);
  };

  const exportResearch = async () => {
    try {
      const summary = getIntelligenceRecordsForResearch(userId, isAdmin);
      const rows: string[][] = [["Dataset", "Category", "Count", "Disclosure"]];
      const append = (label: string, values: any[]) => values.forEach((row) => {
        const count = Number(row.count || 0);
        if (count >= 5) rows.push([label, String(row.label || "Unspecified"), String(count), ""]);
        else rows.push([label, String(row.label || "Unspecified"), "<5", "Suppressed for privacy"]);
      });
      append("Procedures", summary.procedures);
      append("Diagnoses", summary.diagnoses);
      summary.rehabilitation.forEach((row: any) => {
        const count = Number(row.count || 0);
        rows.push(["Recorded pain scores", String(row.pain_score || "Not recorded"), count >= 5 ? String(count) : "<5", count >= 5 ? "" : "Suppressed for privacy"]);
      });
      const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
      const uri = (FileSystem.cacheDirectory || "") + "ortho-research-summary-" + today() + ".csv";
      if (!uri) throw new Error("File storage is unavailable on this device.");
      await FileSystem.writeAsStringAsync(uri, csv, { encoding: FileSystem.EncodingType.UTF8 });
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType: "text/csv", dialogTitle: "Share anonymized orthopaedic summary" });
      else toast("Research CSV saved to the app cache.", "success");
    } catch (error: any) { toast(error?.message || "Could not prepare the research export.", "error"); }
  };

  const startBarcodeScan = async () => {
    if (!cameraPermission?.granted) {
      const permission = await requestCameraPermission();
      if (!permission.granted) { toast("Camera permission is required to scan a product code.", "error"); return; }
    }
    setScannerOpen(true);
  };

  const toggleModule = (id: string, enabled: boolean) => {
    try {
      setIntelligenceModuleEnabled(id, enabled, userId);
      setModuleSettings(listIntelligenceModuleSettings());
      if (!enabled && id === moduleId) {
        const next = INTELLIGENCE_MODULES.find((module) => module.id !== id && moduleSettings[module.id] !== false);
        if (next) setModuleId(next.id);
      }
      toast("Module settings saved.", "success");
    } catch (error: any) { toast(error?.message || "Could not update module settings.", "error"); }
  };

  const restoreArchivedEntry = (record: IntelligenceRecord) => {
    Alert.alert("Restore archived entry?", "This entry will return to the active timeline. Its previous versions remain available.", [
      { text: "Cancel", style: "cancel" },
      { text: "Restore entry", onPress: () => {
        try {
          restoreArchivedIntelligenceRecord(record.id, userId, isAdmin);
          setSelectedRecordId(record.id);
          setRevisions(listIntelligenceRevisions(record.id, userId, isAdmin));
          toast("Entry restored.", "success");
          refresh();
        } catch (error: any) { toast(error?.message || "Could not restore entry.", "error"); }
      } },
    ]);
  };

  const toggleChecklistLine = (line: string) => {
    const checked = line.startsWith("[x] ") || line.startsWith("[X] ");
    const next = line.replace(/^\[[ xX]\]\s*/, checked ? "[ ] " : "[x] ");
    setFormFields((current) => ({
      ...current,
      checklist: (current.checklist || CHECKLIST_TEMPLATE).split("\n").map((item) => item === line ? next : item).join("\n"),
    }));
  };

  const followUpStatus = (record: IntelligenceRecord) => {
    const payload = safePayload(record);
    const due = payload.dueDate || record.event_date;
    const status = (payload.status || "Open").toLowerCase();
    if (["completed", "cancelled", "closed"].includes(status)) return "Completed";
    if (due < today()) return "Overdue";
    const soon = new Date(); soon.setDate(soon.getDate() + 7);
    if (due <= soon.toISOString().slice(0, 10)) return "Due soon";
    return "Scheduled";
  };

  const renderResearchPanel = () => {
    const stats = getIntelligenceRecordsForResearch(userId, isAdmin);
    return (
      <View style={styles.panel}>
        <Text style={styles.panelTitle}>Anonymized aggregate report</Text>
        <Text style={styles.description}>This export contains category counts only. It excludes patient names, MR numbers, phone numbers, exact dates and record IDs. Categories with fewer than five cases are suppressed.</Text>
        <View style={styles.metricRow}>
          <View style={styles.metric}><Text style={styles.metricValue}>{stats.procedures.length}</Text><Text style={styles.metricLabel}>Procedure groups</Text></View>
          <View style={styles.metric}><Text style={styles.metricValue}>{stats.diagnoses.length}</Text><Text style={styles.metricLabel}>Diagnosis groups</Text></View>
          <View style={styles.metric}><Text style={styles.metricValue}>{stats.rehabilitation.length}</Text><Text style={styles.metricLabel}>Rehab groups</Text></View>
        </View>
        <Text style={styles.sectionTitle}>Procedure frequency</Text>
        {stats.procedures.slice(0, 12).map((row: any) => <View key={row.label} style={styles.dataRow}><Text style={styles.dataLabel}>{row.label}</Text><Text style={styles.dataValue}>{Number(row.count) >= 5 ? row.count : "<5"}</Text></View>)}
        <Text style={styles.sectionTitle}>Diagnosis frequency</Text>
        {stats.diagnoses.slice(0, 12).map((row: any) => <View key={row.label} style={styles.dataRow}><Text style={styles.dataLabel}>{row.label}</Text><Text style={styles.dataValue}>{Number(row.count) >= 5 ? row.count : "<5"}</Text></View>)}
        <Pressable style={styles.primaryButton} onPress={exportResearch}><Ionicons name="download-outline" size={18} color="#FFFFFF"/><Text style={styles.primaryButtonText}>Export privacy-conscious CSV</Text></Pressable>
        <Text style={styles.caption}>Use institutional approval and ethics review where required before research use or publication.</Text>
      </View>
    );
  };

  const renderKnowledgePanel = () => (
    <View style={styles.panel}>
      <View style={styles.rowBetween}>
        <Text style={styles.panelTitle}>Clinician-approved library</Text>
        {isAdmin ? <Pressable style={styles.smallAction} onPress={() => openArticleEditor()}><Ionicons name="add" size={17} color={colors.brandPrimary}/><Text style={styles.smallActionText}>Add reference</Text></Pressable> : null}
      </View>
      <Text style={styles.description}>Only add material approved by your clinical team. The app does not supply or automatically update clinical protocols.</Text>
      <TextInput value={knowledgeSearch} onChangeText={setKnowledgeSearch} placeholder="Search articles, categories and tags" placeholderTextColor={colors.muted} style={styles.searchInput}/>
      {selectedArticle ? (
        <View style={styles.articleCard}>
          <Pressable onPress={() => setSelectedArticle(null)} style={styles.backInline}><Ionicons name="arrow-back" size={17} color={colors.brandPrimary}/><Text style={styles.smallActionText}>All references</Text></Pressable>
          <Text style={styles.sectionTitle}>{selectedArticle.title}</Text>
          <Text style={styles.meta}>{selectedArticle.category}</Text>
          <Text selectable style={styles.articleBody}>{selectedArticle.body}</Text>
          {isAdmin ? <View style={styles.actionRow}><Pressable onPress={() => openArticleEditor(selectedArticle)} style={styles.smallAction}><Ionicons name="create-outline" size={17} color={colors.brandPrimary}/><Text style={styles.smallActionText}>Edit</Text></Pressable><Pressable onPress={() => Alert.alert("Delete reference?", "This permanently deletes this knowledge article.", [{text:"Cancel",style:"cancel"},{text:"Delete",style:"destructive",onPress:()=>{deleteKnowledgeArticle(selectedArticle.id);setSelectedArticle(null);reloadKnowledge();}}])} style={styles.smallAction}><Ionicons name="trash-outline" size={17} color={colors.error}/><Text style={[styles.smallActionText,{color:colors.error}]}>Delete</Text></Pressable></View> : null}
        </View>
      ) : knowledgeArticles.map((article) => (
        <Pressable key={article.id} style={styles.articleListItem} onPress={() => setSelectedArticle(article)}>
          <View style={styles.flexOne}><Text style={styles.recordTitle}>{article.title}</Text><Text style={styles.meta}>{article.category || "General"} · Updated {article.updated_at.slice(0,10)}</Text></View>
          <Ionicons name="chevron-forward" size={19} color={colors.muted}/>
        </Pressable>
      ))}
      {!knowledgeArticles.length ? <EmptyState icon="library-outline" title="No references saved" subtitle="An administrator can add locally approved references."/> : null}
    </View>
  );

  const renderRecoveryPanel = () => (
    <View style={styles.panel}>
      <Text style={styles.panelTitle}>Record recovery</Text>
      <Text style={styles.description}>Every edit and removal creates a retained snapshot. Select an entry to inspect its previous versions. Restore creates another snapshot before changing the current entry.</Text>
      <Text style={styles.sectionTitle}>Active entries</Text>
      {records.map((record) => (
        <Pressable key={record.id} style={[styles.articleListItem, selectedRecordId === record.id && styles.selectedRow]} onPress={() => showRevisions(record)}>
          <View style={styles.flexOne}><Text style={styles.recordTitle}>{record.title}</Text><Text style={styles.meta}>{record.kind.replace(/_/g," ")} · {record.event_date}</Text></View>
          <Ionicons name="time-outline" size={19} color={colors.muted}/>
        </Pressable>
      ))}
      <Text style={styles.sectionTitle}>Archived entries</Text>
      {archivedRecords.map((record) => (
        <View key={record.id} style={[styles.articleListItem, selectedRecordId === record.id && styles.selectedRow]}>
          <Pressable style={styles.flexOne} onPress={() => showRevisions(record)}>
            <Text style={styles.recordTitle}>{record.title}</Text>
            <Text style={styles.meta}>Archived · {record.kind.replace(/_/g," ")} · {record.event_date}</Text>
          </Pressable>
          <Pressable style={styles.smallAction} onPress={() => restoreArchivedEntry(record)}><Text style={styles.smallActionText}>Restore</Text></Pressable>
        </View>
      ))}
      {selectedRecordId ? (
        <View style={styles.revisionPanel}>
          <Text style={styles.sectionTitle}>Saved versions ({revisions.length})</Text>
          {revisions.map((revision) => {
            let title = "Previous version";
            try { title = JSON.parse(revision.snapshot_json).title || title; } catch {}
            return <View key={revision.id} style={styles.revisionRow}>
              <View style={styles.flexOne}><Text style={styles.recordTitle}>{title}</Text><Text style={styles.meta}>{new Date(revision.created_at).toLocaleString()} · {revision.change_note || "Saved version"}</Text></View>
              <Pressable onPress={() => restoreRevision(revision.id)} style={styles.smallAction}><Text style={styles.smallActionText}>Restore</Text></Pressable>
            </View>;
          })}
          {!revisions.length ? <Text style={styles.caption}>No earlier edit snapshots are available.</Text> : null}
        </View>
      ) : null}
      {!records.length && !archivedRecords.length ? <EmptyState icon="time-outline" title="No records to recover" subtitle="New and edited entries will appear here."/> : null}
    </View>
  );

  const renderJourneyItem = (item: PatientJourneyItem) => (
    <View key={item.id} style={styles.recordCard}>
      <View style={styles.rowBetween}>
        <View style={styles.flexOne}>
          <Text style={styles.recordTitle}>{item.title}</Text>
          <Text style={styles.meta}>{String(item.date || "").slice(0, 16).replace("T", " ")} · {item.source.replace(/_/g, " ")}</Text>
        </View>
        <Ionicons name={item.source === "implant" ? "hardware-chip-outline" : item.source === "history" ? "document-text-outline" : item.source === "patient" ? "person-outline" : "medical-outline"} size={19} color={colors.brandPrimary}/>
      </View>
      {item.description ? <Text style={styles.summaryText}>{item.description}</Text> : null}
      {item.mediaUri ? <Image source={{uri:item.mediaUri}} resizeMode="contain" style={styles.recordImage}/> : null}
    </View>
  );

  const renderRecordCard = (record: IntelligenceRecord) => {
    const payload = safePayload(record);
    const patient = record.patient_id ? patientById.get(record.patient_id) : null;
    const status = record.kind === "follow_up" ? followUpStatus(record) : "";
    const details = Object.entries(payload).filter(([, value]) => value).slice(0, 4);
    return (
      <View key={record.id} style={styles.recordCard}>
        <View style={styles.rowBetween}>
          <View style={styles.flexOne}>
            <Text style={styles.recordTitle}>{record.title}</Text>
            <Text style={styles.meta}>{record.event_date}{patient ? " · " + patient.mrNo + " " + patient.name : " · Not linked to a patient"}</Text>
          </View>
          {status ? <View style={[styles.statusPill, status === "Overdue" ? styles.statusDanger : status === "Due soon" ? styles.statusWarning : styles.statusNormal]}><Text style={styles.statusText}>{status}</Text></View> : null}
        </View>
        {record.summary ? <Text style={styles.summaryText}>{record.summary}</Text> : null}
        {record.media_uri ? <Image source={{ uri: record.media_uri }} resizeMode="contain" style={styles.recordImage}/> : null}
        {details.map(([key, value]) => <View key={key} style={styles.detailLine}><Text style={styles.detailKey}>{key.replace(/([A-Z])/g," $1")}</Text><Text style={styles.detailValue}>{value}</Text></View>)}
        <View style={styles.actionRow}>
          <Pressable style={styles.smallAction} onPress={() => openEditRecord(record)}><Ionicons name="create-outline" size={17} color={colors.brandPrimary}/><Text style={styles.smallActionText}>Edit</Text></Pressable>
          <Pressable style={styles.smallAction} onPress={() => showRevisions(record)}><Ionicons name="time-outline" size={17} color={colors.brandPrimary}/><Text style={styles.smallActionText}>Versions</Text></Pressable>
          <Pressable style={styles.smallAction} onPress={() => deleteRecord(record)}><Ionicons name="archive-outline" size={17} color={colors.error}/><Text style={[styles.smallActionText,{color:colors.error}]}>Archive</Text></Pressable>
        </View>
      </View>
    );
  };

  const renderModuleDescription = () => {
    if (moduleId === "body_map") return <Text style={styles.description}>Choose a body region and record side, bone and classification. This is a structured anatomical locator, not a rotatable 3D skeleton.</Text>;
    if (moduleId === "xray") return <Text style={styles.description}>Load the patient context and saved images, select an existing X-ray or capture a new image, then record the clinician-reviewed study. Image diagnosis is not automatic.</Text>;
    if (moduleId === "implant_passport") return <Text style={styles.description}>Record manufacturer, batch, serial and expiry data. Scan a package barcode/QR code or type it manually. This records traceability; it does not decide clinical compatibility.</Text>;
    if (moduleId === "digital_twin") return <Text style={styles.description}>Select a patient to view the combined chronological history of their injuries, images, implants, surgery notes, rehabilitation and follow-ups.</Text>;
    if (moduleId === "xray_review") return <Text style={styles.warningText}>Clinician-led image review only. No AI diagnostic model is connected. Measurements and findings must be entered and verified by a qualified clinician.</Text>;
    if (moduleId === "rehab") return <Text style={styles.description}>Track pain, range of motion, mobility and rehabilitation activities against clinician-defined goals.</Text>;
    if (moduleId === "surgery_checklist") return <Text style={styles.description}>Use the editable checklist for local sign-off. It does not replace your hospital's approved surgical safety checklist.</Text>;
    if (moduleId === "clinical_note") return <Text style={styles.description}>Use the microphone on your phone keyboard to dictate into the structured fields, then review and correct every field before saving.</Text>;
    if (moduleId === "follow_up") return <Text style={styles.description}>The radar flags overdue and upcoming appointments from saved due dates and statuses. It is a reminder list, not a clinical risk prediction.</Text>;
    return null;
  };

  const header = (
    <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
      <Pressable onPress={() => router.canGoBack() ? router.back() : router.replace("/(tabs)/index" as any)} style={styles.backButton}><Ionicons name="arrow-back" size={22} color={colors.onSurface}/></Pressable>
      <View style={styles.flexOne}><Text style={styles.headerTitle}>Orthopaedic Intelligence</Text><Text style={styles.headerSubtitle}>Local-first clinical workspace</Text></View>
      {isAdmin ? <Pressable onPress={() => setModuleSettingsOpen(true)} style={styles.backButton}><Ionicons name="options-outline" size={22} color={colors.onSurface}/></Pressable> : <View style={styles.backButton}/>}
    </View>
  );

  return (
    <View style={styles.container}>
      {header}
      <ScrollView contentContainerStyle={{ padding: spacing.md, paddingBottom: insets.bottom + spacing.xxl }} keyboardShouldPersistTaps="handled">
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.moduleStrip}>
          {visibleModules.map((module) => (
            <Pressable key={module.id} onPress={() => { setModuleId(module.id); setSearch(""); setSelectedRecordId(""); setRevisions([]); setSelectedArticle(null); }} style={[styles.moduleChip, module.id === moduleId && styles.moduleChipActive]}>
              <Ionicons name={module.icon as any} size={17} color={module.id === moduleId ? colors.onBrandPrimary : colors.brandPrimary}/>
              <Text style={[styles.moduleChipText,module.id === moduleId && styles.moduleChipTextActive]}>{module.title}</Text>
            </Pressable>
          ))}
        </ScrollView>

        <View style={styles.pageIntro}>
          <View style={styles.rowBetween}>
            <Text style={styles.pageTitle}>{activeModule.title}</Text>
            {moduleId === "xray" && !!selectedPatientId && compareRecords.length >= 2 ? <Pressable onPress={() => setCompareOpen(true)} style={styles.smallAction}><Ionicons name="swap-horizontal-outline" size={17} color={colors.brandPrimary}/><Text style={styles.smallActionText}>Compare</Text></Pressable> : null}
          </View>
          {renderModuleDescription()}
        </View>

        {moduleId !== "research" && moduleId !== "knowledge" && moduleId !== "recovery" ? (
          <>
            <View style={styles.filterRow}>
              <Pressable style={styles.patientFilter} onPress={() => openPatientPicker("filter")}>
                <Ionicons name="person-outline" size={17} color={colors.brandPrimary}/>
                <Text numberOfLines={1} style={styles.patientFilterText}>{selectedPatient ? selectedPatient.mrNo + " · " + selectedPatient.name : "All my patients"}</Text>
                <Ionicons name="chevron-down" size={16} color={colors.muted}/>
              </Pressable>
              {selectedPatientId ? <Pressable onPress={() => setSelectedPatientId("")} style={styles.clearFilter}><Ionicons name="close-circle" size={19} color={colors.muted}/></Pressable> : null}
            </View>
            <TextInput value={search} onChangeText={setSearch} placeholder="Search entries" placeholderTextColor={colors.muted} style={styles.searchInput}/>
            {moduleId !== "digital_twin" ? <Pressable onPress={openNewRecord} style={styles.primaryButton}><Ionicons name="add" size={19} color="#FFFFFF"/><Text style={styles.primaryButtonText}>Add {activeModule.title.toLowerCase()} entry</Text></Pressable> : null}
            {moduleId === "digital_twin" && !selectedPatientId ? <Text style={styles.warningText}>Choose a patient to open their complete clinical journey.</Text> : null}
            {moduleId === "rehab" ? (
              <View style={styles.panel}>
                <Text style={styles.panelTitle}>Recovery trend</Text>
                <Text style={styles.description}>Pain scores are patient-reported or clinician-recorded values entered for this patient. This chart does not predict recovery.</Text>
                {!selectedPatientId ? <Text style={styles.caption}>Select a patient to view their trend.</Text> : rehabTrend.filter((item) => item.pain !== null).length ? rehabTrend.filter((item) => item.pain !== null).map((item) => (
                  <View key={item.id} style={styles.trendRow}>
                    <Text style={styles.trendDate}>{item.date.slice(5)}</Text>
                    <View style={styles.trendTrack}><View style={[styles.trendFill,{width:(String((item.pain || 0)*10)+"%") as `${number}%`}]}/></View>
                    <Text style={styles.trendValue}>{item.pain}/10</Text>
                    {item.flexion ? <Text style={styles.trendMeta}>Flexion {item.flexion}°</Text> : null}
                  </View>
                )) : <Text style={styles.caption}>No pain-score measurements are recorded yet.</Text>}
              </View>
            ) : null}
            {moduleId === "follow_up" ? (
              <View style={styles.metricRow}>
                <View style={styles.metric}><Text style={styles.metricValue}>{visibleRecords.filter((record) => followUpStatus(record) === "Overdue").length}</Text><Text style={styles.metricLabel}>Overdue</Text></View>
                <View style={styles.metric}><Text style={styles.metricValue}>{visibleRecords.filter((record) => followUpStatus(record) === "Due soon").length}</Text><Text style={styles.metricLabel}>Due soon</Text></View>
                <View style={styles.metric}><Text style={styles.metricValue}>{visibleRecords.filter((record) => followUpStatus(record) === "Scheduled").length}</Text><Text style={styles.metricLabel}>Scheduled</Text></View>
              </View>
            ) : null}
            {moduleId === "digital_twin" ? journeyItems.map(renderJourneyItem) : visibleRecords.map(renderRecordCard)}
            {(moduleId === "digital_twin" ? journeyItems.length === 0 && !!selectedPatientId : visibleRecords.length === 0) ? <EmptyState icon="file-tray-outline" title="No entries yet" subtitle={moduleId === "digital_twin" ? "This patient has no dated clinical history or intelligence entries." : "Add the first entry. Your data stays on this device until backed up."}/> : null}
            {moduleId === "xray_review" ? <View style={styles.notice}><Text style={styles.noticeTitle}>AI and diagnosis limitations</Text><Text style={styles.description}>This screen stores clinician-entered observations and measurements only. It does not detect fractures, measure radiographs automatically, diagnose or recommend treatment. A validated medical imaging model and clinical governance are required for those functions.</Text></View> : null}
          </>
        ) : null}

        {moduleId === "research" ? renderResearchPanel() : null}
        {moduleId === "knowledge" ? renderKnowledgePanel() : null}
        {moduleId === "recovery" ? renderRecoveryPanel() : null}

        <View style={styles.offlineNotice}>
          <Ionicons name="shield-checkmark-outline" size={18} color={colors.brandPrimary}/>
          <Text style={styles.caption}>Records are saved in the device's local SQLite database. Use Sync & Backup to move them to another device. Version history helps recover overwritten entries; keep routine encrypted backups as well.</Text>
        </View>
      </ScrollView>

      <Modal visible={formVisible} animationType="slide" onRequestClose={() => setFormVisible(false)}>
        <View style={styles.modalScreen}>
          <View style={[styles.modalHeader,{paddingTop:insets.top + spacing.sm}]}>
            <Pressable onPress={() => setFormVisible(false)} style={styles.backButton}><Ionicons name="close" size={23} color={colors.onSurface}/></Pressable>
            <Text style={styles.modalTitle}>{editing ? "Edit entry" : "New " + activeModule.title.toLowerCase()}</Text>
            <View style={styles.backButton}/>
          </View>
          <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + spacing.xl }} keyboardShouldPersistTaps="handled">
            <Text style={styles.inputLabel}>Record title *</Text>
            <TextInput value={formTitle} onChangeText={setFormTitle} placeholder="Enter a clear title" placeholderTextColor={colors.muted} style={styles.formInput}/>
            <Text style={styles.inputLabel}>Event date (YYYY-MM-DD) *</Text>
            <TextInput value={formDate} onChangeText={setFormDate} placeholder="YYYY-MM-DD" placeholderTextColor={colors.muted} style={styles.formInput}/>
            <Text style={styles.inputLabel}>Link to patient</Text>
            <Pressable style={styles.patientFilter} onPress={() => openPatientPicker("form")}>
              <Ionicons name="person-add-outline" size={17} color={colors.brandPrimary}/>
              <Text style={styles.patientFilterText}>{formPatient ? formPatient.mrNo + " · " + formPatient.name : "Select a patient (optional)"}</Text>
              <Ionicons name="chevron-down" size={16} color={colors.muted}/>
            </Pressable>
            {formPatientId ? <Pressable onPress={() => { setFormPatientId(""); setFormPatientContext(null); }}><Text style={styles.smallActionText}>Remove patient link</Text></Pressable> : null}
            {formPatientContext ? (
              <View style={{ padding: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surface, marginTop: spacing.sm }}>
                <View style={styles.rowBetween}>
                  <Text style={styles.panelTitle}>Saved patient context</Text>
                  <Ionicons name="checkmark-circle" size={18} color={colors.success}/>
                </View>
                <Text style={styles.recordTitle}>{formPatientContext.mrNo} · {formPatientContext.name}</Text>
                <Text style={styles.meta}>{[formPatientContext.gender, formPatientContext.age, formPatientContext.date].filter(Boolean).join(" · ")}</Text>
                {formPatientContext.diagnosis ? <Text style={styles.summaryText}>Existing diagnosis: {formPatientContext.diagnosis}</Text> : null}
                {[formPatientContext.procedure, formPatientContext.procedureII].filter(Boolean).length ? <Text style={styles.summaryText}>Recorded procedure: {[formPatientContext.procedure, formPatientContext.procedureII].filter(Boolean).join(" · ")}</Text> : null}
                {(moduleId === "xray" || moduleId === "xray_review") ? (
                  <>
                    <Text style={styles.inputLabel}>Images already saved in this patient's file</Text>
                    <Text style={styles.caption}>Choose the image that is actually an X-ray. Patient photos may also contain documents or other images, so the app will not classify them automatically.</Text>
                    {formPatientContext.photoUris.length ? (
                      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm, paddingVertical: spacing.xs }}>
                        {formPatientContext.photoUris.slice(0, 12).map((uri, index) => (
                          <Pressable key={uri + "-" + index} onPress={() => {
                            setMediaUri(uri);
                            setFormFields(current => ({ ...current, sourceImage: "Selected from saved patient photos", sourcePhotoIndex: String(index + 1) }));
                            toast("Saved patient image linked. Confirm that it is the correct X-ray.", "info");
                          }} style={{ width: 104, padding: spacing.xs, borderWidth: mediaUri === uri ? 2 : 1, borderColor: mediaUri === uri ? colors.brandPrimary : colors.border, borderRadius: radius.md }}>
                            <Image source={{ uri }} resizeMode="cover" style={{ width: 88, height: 82, borderRadius: radius.sm }}/>
                            <Text style={styles.caption}>Patient image {index + 1}</Text>
                            {mediaUri === uri ? <Text style={styles.smallActionText}>Selected</Text> : null}
                          </Pressable>
                        ))}
                      </ScrollView>
                    ) : <Text style={styles.caption}>No existing local patient images were found for this record.</Text>}
                  </>
                ) : null}
                {moduleId === "implant_passport" && formPatientContext.implants.length ? (
                  <>
                    <Text style={styles.inputLabel}>Implants already recorded for this patient</Text>
                    {formPatientContext.implants.slice(0, 20).map((implant) => (
                      <Pressable key={implant.id} onPress={() => {
                        setFormFields(current => ({
                          ...current,
                          implantName: implant.name,
                          category: implant.category,
                          dimensions: implant.size,
                          patientImplantId: implant.id,
                          patientImplantSource: "Existing patient implant record",
                        }));
                        toast("Existing implant details copied. Batch, serial and manufacturer still need package verification.", "info");
                      }} style={{ paddingVertical: spacing.sm, borderTopWidth: 1, borderColor: colors.border }}>
                        <Text style={styles.recordTitle}>{implant.name}</Text>
                        <Text style={styles.meta}>{[implant.category, implant.size, "Qty " + implant.quantity].filter(Boolean).join(" · ")} · Tap to use</Text>
                      </Pressable>
                    ))}
                  </>
                ) : null}
              </View>
            ) : null}
            <Text style={styles.inputLabel}>Short summary</Text>
            <TextInput value={formSummary} onChangeText={setFormSummary} placeholder="Optional summary" placeholderTextColor={colors.muted} multiline style={[styles.formInput,styles.multilineInput]}/>
            {moduleId === "body_map" ? (
              <View style={styles.bodyMapPanel}>
                <Text style={styles.inputLabel}>Choose anatomical region</Text>
                <View style={styles.regionGrid}>
                  {BODY_REGIONS.map((region) => <Pressable key={region} onPress={() => setFormFields((current) => ({...current,region}))} style={[styles.regionChip,formFields.region===region && styles.regionChipActive]}><Text style={[styles.regionText,formFields.region===region && styles.regionTextActive]}>{region}</Text></Pressable>)}
                </View>
              </View>
            ) : null}
            {FIELD_DEFINITIONS[moduleId].map((field) => (
              <View key={field.key}>
                <Text style={styles.inputLabel}>{field.label}</Text>
                {moduleId === "surgery_checklist" && field.key === "checklist" ? (
                  <View style={styles.checklistBox}>
                    {(formFields.checklist || CHECKLIST_TEMPLATE).split("\n").filter(Boolean).map((line, index) => {
                      const checked = /^\[[xX]\]/.test(line);
                      const label = line.replace(/^\[[ xX]\]\s*/, "");
                      return <Pressable key={String(index) + label} onPress={() => toggleChecklistLine(line)} style={styles.checklistItem}>
                        <Ionicons name={checked ? "checkbox" : "square-outline"} size={21} color={checked ? colors.success : colors.muted}/>
                        <Text style={styles.checklistText}>{label}</Text>
                      </Pressable>;
                    })}
                    <TextInput
                      value={(formFields.checklist || "").split("\n").filter((line) => !/^\s*\[[xX ]\]/.test(line)).join("\n")}
                      onChangeText={(value) => setFormFields((current) => ({
                        ...current,
                        checklist: (current.checklist || CHECKLIST_TEMPLATE).split("\n").filter((line) => /^\s*\[[xX ]\]/.test(line)).concat(value.split("\n").filter(Boolean)).join("\n"),
                      }))}
                      placeholder="Add a custom checklist item on a new line"
                      placeholderTextColor={colors.muted}
                      multiline
                      style={[styles.formInput,styles.multilineInput]}
                    />
                  </View>
                ) : (
                  <TextInput
                    value={formFields[field.key] || ""}
                    onChangeText={(value) => setFormFields((current) => ({ ...current, [field.key]: value }))}
                    placeholder={field.placeholder || field.label}
                    placeholderTextColor={colors.muted}
                    multiline={!!field.multiline}
                    autoCapitalize="sentences"
                    style={[styles.formInput, field.multiline && styles.multilineInput]}
                  />
                )}
              </View>
            ))}
            {moduleId === "implant_passport" ? <Pressable onPress={startBarcodeScan} style={styles.secondaryButton}><Ionicons name="scan-outline" size={18} color={colors.brandPrimary}/><Text style={styles.secondaryButtonText}>Scan barcode / QR code</Text></Pressable> : null}
            {moduleId === "xray" || moduleId === "xray_review" ? (
              <View style={styles.imagePickerBox}>
                {mediaUri ? <Image source={{ uri: mediaUri }} style={styles.imagePreview} resizeMode="contain"/> : <Ionicons name="image-outline" size={34} color={colors.muted}/>}
                <Pressable onPress={pickXray} style={styles.secondaryButton}><Ionicons name="image" size={18} color={colors.brandPrimary}/><Text style={styles.secondaryButtonText}>{mediaUri ? "Choose another image" : "Choose X-ray image"}</Text></Pressable>
                <Pressable onPress={openXrayCamera} style={styles.secondaryButton}><Ionicons name="camera-outline" size={18} color={colors.brandPrimary}/><Text style={styles.secondaryButtonText}>Take X-ray photo with camera</Text></Pressable>
                {mediaUri ? <Pressable onPress={() => { setMediaUri(""); setFormFields(current => ({ ...current, sourceImage: "", sourcePhotoIndex: "" })); }}><Text style={styles.smallActionText}>Remove attached image</Text></Pressable> : null}
                <Text style={styles.caption}>Images are saved at original capture/import quality. Automatic fracture interpretation is not enabled; a clinician must review the image.</Text>
              </View>
            ) : null}
            {moduleId === "clinical_note" ? <Text style={styles.caption}>Dictation tip: tap a field, then use the microphone button on your phone's keyboard. Speech recognition is provided by the device keyboard, not processed by this app.</Text> : null}
            <Pressable disabled={saving} onPress={saveRecord} style={[styles.primaryButton,saving && styles.disabledButton]}>{saving ? <ActivityIndicator color="#FFFFFF"/> : <Ionicons name="save-outline" size={18} color="#FFFFFF"/>}<Text style={styles.primaryButtonText}>{saving ? "Saving…" : "Save entry"}</Text></Pressable>
          </ScrollView>
        </View>
      </Modal>

      <Modal visible={patientPickerOpen} transparent animationType="slide" onRequestClose={() => setPatientPickerOpen(false)}>
        <View style={styles.overlay}><View style={[styles.pickerCard,{paddingBottom:insets.bottom+spacing.lg}]}>
          <View style={styles.rowBetween}><Text style={styles.modalTitle}>Select patient</Text><Pressable onPress={() => selectPatient(null,pickerMode)}><Text style={styles.smallActionText}>Clear</Text></Pressable></View>
          <TextInput value={patientPickerSearch} onChangeText={setPatientPickerSearch} placeholder="Search MR number or patient name" placeholderTextColor={colors.muted} style={styles.searchInput}/>
          <ScrollView keyboardShouldPersistTaps="handled">
            {filteredPatients.map((patient) => <Pressable key={patient.id} style={styles.articleListItem} onPress={() => selectPatient(patient,pickerMode)}><View style={styles.flexOne}><Text style={styles.recordTitle}>{patient.mrNo} · {patient.name}</Text><Text style={styles.meta}>{patient.diagnosis || patient.procedure || patient.date}</Text></View><Ionicons name="chevron-forward" size={18} color={colors.muted}/></Pressable>)}
            {!filteredPatients.length ? <Text style={styles.caption}>No matching patients in your permitted patient list.</Text> : null}
          </ScrollView>
        </View></View>
      </Modal>

      <Modal visible={xrayCameraOpen} animationType="slide" onRequestClose={() => setXrayCameraOpen(false)}>
        <View style={styles.scannerScreen}>
          <View style={[styles.modalHeader,{paddingTop:insets.top+spacing.sm}]}>
            <Pressable onPress={() => setXrayCameraOpen(false)} style={styles.backButton}><Ionicons name="close" size={23} color={colors.onSurface}/></Pressable>
            <Text style={styles.modalTitle}>Capture X-ray</Text>
            <View style={styles.backButton}/>
          </View>
          <CameraView
            ref={xrayCameraRef}
            style={styles.camera}
            facing="back"
            onCameraReady={() => setXrayCameraReady(true)}
          />
          <View style={{ padding: spacing.md }}>
            <Pressable disabled={!xrayCameraReady} onPress={captureXray} style={[styles.primaryButton,!xrayCameraReady && styles.disabledButton]}>
              {!xrayCameraReady ? <ActivityIndicator color="#FFFFFF"/> : <Ionicons name="camera" size={19} color="#FFFFFF"/>}
              <Text style={styles.primaryButtonText}>{xrayCameraReady ? "Capture image" : "Preparing camera…"}</Text>
            </Pressable>
            <Text style={styles.caption}>Use the original radiograph or image source where possible. A phone photo of an X-ray film may lose detail and must be checked for glare, rotation and crop.</Text>
          </View>
        </View>
      </Modal>

      <Modal visible={scannerOpen} animationType="slide" onRequestClose={() => setScannerOpen(false)}>
        <View style={styles.scannerScreen}>
          <View style={[styles.modalHeader,{paddingTop:insets.top+spacing.sm}]}><Pressable onPress={() => setScannerOpen(false)} style={styles.backButton}><Ionicons name="close" size={23} color={colors.onSurface}/></Pressable><Text style={styles.modalTitle}>Scan implant code</Text><View style={styles.backButton}/></View>
          {cameraPermission?.granted ? <CameraView style={styles.camera} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr","ean13","ean8","code128","upc_a","upc_e"] }} onBarcodeScanned={({data}) => { setFormFields((current) => ({...current,barcode:String(data||"").slice(0,500)})); setScannerOpen(false); toast("Barcode captured. Verify it before saving.","success"); }}/> : <View style={styles.centerFill}><Text style={styles.description}>Camera permission is needed to scan an implant label.</Text><Pressable onPress={startBarcodeScan} style={styles.primaryButton}><Text style={styles.primaryButtonText}>Grant camera permission</Text></Pressable></View>}
          <Text style={styles.caption}>Check that the scanned code matches the original sterile package label.</Text>
        </View>
      </Modal>

      <Modal visible={compareOpen} transparent animationType="fade" onRequestClose={() => setCompareOpen(false)}>
        <View style={styles.overlay}><View style={styles.compareCard}>
          <View style={styles.rowBetween}><Text style={styles.modalTitle}>X-ray comparison</Text><Pressable onPress={() => setCompareOpen(false)}><Ionicons name="close" size={22} color={colors.onSurface}/></Pressable></View>
          <View style={styles.compareRow}>{compareRecords.map((record) => <View key={record.id} style={styles.compareItem}><Text style={styles.meta}>{record.event_date}</Text>{record.media_uri ? <Image source={{uri:record.media_uri}} resizeMode="contain" style={styles.compareImage}/> : <View style={styles.compareEmpty}><Text style={styles.caption}>No image attached</Text></View>}<Text style={styles.recordTitle}>{record.title}</Text><Text style={styles.caption}>{record.summary || safePayload(record).report || "No observation recorded"}</Text></View>)}</View>
        </View></View>
      </Modal>

      <Modal visible={moduleSettingsOpen} transparent animationType="slide" onRequestClose={() => setModuleSettingsOpen(false)}>
        <View style={styles.overlay}><View style={[styles.pickerCard,{paddingBottom:insets.bottom+spacing.lg}]}>
          <View style={styles.rowBetween}><Text style={styles.modalTitle}>Module controls</Text><Pressable onPress={() => setModuleSettingsOpen(false)}><Ionicons name="close" size={22} color={colors.onSurface}/></Pressable></View>
          <Text style={styles.description}>Administrators can hide modules without deleting their saved records.</Text>
          <ScrollView>{INTELLIGENCE_MODULES.map((module) => <View key={module.id} style={styles.toggleRow}><View style={styles.flexOne}><Text style={styles.recordTitle}>{module.title}</Text><Text style={styles.meta}>{module.subtitle}</Text></View><Switch value={moduleSettings[module.id] !== false} onValueChange={(value) => toggleModule(module.id,value)} trackColor={{false:colors.border,true:colors.brandPrimary}} /></View>)}</ScrollView>
        </View></View>
      </Modal>

      <Modal visible={articleEditorOpen} animationType="slide" onRequestClose={() => setArticleEditorOpen(false)}>
        <View style={styles.modalScreen}>
          <View style={[styles.modalHeader,{paddingTop:insets.top+spacing.sm}]}><Pressable onPress={() => setArticleEditorOpen(false)} style={styles.backButton}><Ionicons name="close" size={23} color={colors.onSurface}/></Pressable><Text style={styles.modalTitle}>{articleEditing ? "Edit reference" : "Add reference"}</Text><View style={styles.backButton}/></View>
          <ScrollView contentContainerStyle={{padding:spacing.lg,paddingBottom:insets.bottom+spacing.xl}}>
            <Text style={styles.inputLabel}>Title *</Text><TextInput value={articleTitle} onChangeText={setArticleTitle} style={styles.formInput} placeholder="Reference title" placeholderTextColor={colors.muted}/>
            <Text style={styles.inputLabel}>Category</Text><TextInput value={articleCategory} onChangeText={setArticleCategory} style={styles.formInput} placeholder="Anatomy / classification / local protocol" placeholderTextColor={colors.muted}/>
            <Text style={styles.inputLabel}>Tags (comma separated)</Text><TextInput value={articleTags} onChangeText={setArticleTags} style={styles.formInput} placeholder="fracture, fixation, follow-up" placeholderTextColor={colors.muted}/>
            <Text style={styles.inputLabel}>Reference content *</Text><TextInput value={articleBody} onChangeText={setArticleBody} multiline textAlignVertical="top" style={[styles.formInput,styles.articleEditorBody]} placeholder="Paste or write your approved reference material" placeholderTextColor={colors.muted}/>
            <Pressable onPress={saveArticle} style={styles.primaryButton}><Ionicons name="save-outline" size={18} color="#FFFFFF"/><Text style={styles.primaryButtonText}>Save reference</Text></Pressable>
            <Text style={styles.caption}>Add only material your clinical governance team has approved. Record its source and review date in the article text.</Text>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  container:{flex:1,backgroundColor:colors.surfaceSecondary},
  header:{flexDirection:"row",alignItems:"center",gap:spacing.sm,paddingHorizontal:spacing.md,paddingBottom:spacing.md,backgroundColor:colors.surface,borderBottomWidth:1,borderBottomColor:colors.border},
  backButton:{width:40,height:40,alignItems:"center",justifyContent:"center"},
  headerTitle:{fontFamily:fontFamily.bold,fontSize:fontSize.lg,color:colors.onSurface},
  headerSubtitle:{fontFamily:fontFamily.regular,fontSize:fontSize.xs,color:colors.muted,marginTop:2},
  flexOne:{flex:1},
  moduleStrip:{gap:spacing.sm,paddingBottom:spacing.md},
  checklistBox:{padding:spacing.md,backgroundColor:colors.surface,borderWidth:1,borderColor:colors.border,borderRadius:radius.md},
  checklistItem:{flexDirection:"row",alignItems:"center",gap:spacing.sm,paddingVertical:spacing.sm},
  checklistText:{fontFamily:fontFamily.regular,fontSize:fontSize.sm,color:colors.onSurface,flex:1},
  moduleChip:{flexDirection:"row",alignItems:"center",gap:6,paddingHorizontal:12,paddingVertical:10,borderRadius:radius.pill,backgroundColor:colors.surface,borderWidth:1,borderColor:colors.border},
  moduleChipActive:{backgroundColor:colors.brandPrimary,borderColor:colors.brandPrimary},
  moduleChipText:{fontFamily:fontFamily.semibold,fontSize:fontSize.xs,color:colors.onSurface},
  moduleChipTextActive:{color:colors.onBrandPrimary},
  pageIntro:{marginBottom:spacing.md},
  pageTitle:{fontFamily:fontFamily.bold,fontSize:fontSize.xl,color:colors.onSurface},
  description:{fontFamily:fontFamily.regular,fontSize:fontSize.sm,color:colors.muted,lineHeight:20,marginTop:spacing.xs},
  warningText:{fontFamily:fontFamily.semibold,fontSize:fontSize.sm,color:colors.warning||colors.brandPrimary,lineHeight:20,marginTop:spacing.xs},
  filterRow:{flexDirection:"row",gap:spacing.xs,alignItems:"center",marginBottom:spacing.sm},
  patientFilter:{flexDirection:"row",alignItems:"center",gap:spacing.sm,padding:spacing.md,borderRadius:radius.md,borderWidth:1,borderColor:colors.border,backgroundColor:colors.surface,flex:1,minHeight:48},
  patientFilterText:{fontFamily:fontFamily.semibold,fontSize:fontSize.sm,color:colors.onSurface,flex:1},
  clearFilter:{padding:spacing.xs},
  searchInput:{minHeight:46,paddingHorizontal:spacing.md,paddingVertical:spacing.sm,backgroundColor:colors.surface,borderWidth:1,borderColor:colors.border,borderRadius:radius.md,color:colors.onSurface,fontFamily:fontFamily.regular,fontSize:fontSize.sm,marginBottom:spacing.md},
  primaryButton:{minHeight:48,flexDirection:"row",alignItems:"center",justifyContent:"center",gap:spacing.sm,paddingHorizontal:spacing.lg,paddingVertical:spacing.md,backgroundColor:colors.brandPrimary,borderRadius:radius.md,marginBottom:spacing.md},
  primaryButtonText:{fontFamily:fontFamily.bold,fontSize:fontSize.sm,color:"#FFFFFF"},
  disabledButton:{opacity:0.55},
  secondaryButton:{minHeight:44,flexDirection:"row",alignItems:"center",justifyContent:"center",gap:spacing.sm,padding:spacing.md,borderWidth:1,borderColor:colors.brandPrimary,borderRadius:radius.md,marginVertical:spacing.sm},
  secondaryButtonText:{fontFamily:fontFamily.semibold,fontSize:fontSize.sm,color:colors.brandPrimary},
  panel:{backgroundColor:colors.surface,borderWidth:1,borderColor:colors.border,borderRadius:radius.lg,padding:spacing.lg,marginTop:spacing.sm},
  panelTitle:{fontFamily:fontFamily.bold,fontSize:fontSize.lg,color:colors.onSurface,marginBottom:spacing.xs},
  sectionTitle:{fontFamily:fontFamily.bold,fontSize:fontSize.base,color:colors.onSurface,marginTop:spacing.md,marginBottom:spacing.sm},
  metricRow:{flexDirection:"row",gap:spacing.sm,marginVertical:spacing.md},
  trendRow:{flexDirection:"row",alignItems:"center",gap:spacing.sm,paddingVertical:spacing.xs,flexWrap:"wrap"},
  trendDate:{fontFamily:fontFamily.medium,fontSize:fontSize.xs,color:colors.muted,width:42},
  trendTrack:{height:10,flex:1,minWidth:70,backgroundColor:colors.surfaceTertiary,borderRadius:99,overflow:"hidden"},
  trendFill:{height:10,backgroundColor:colors.brandPrimary,borderRadius:99},
  trendValue:{fontFamily:fontFamily.bold,fontSize:fontSize.xs,color:colors.onSurface,width:36,textAlign:"right"},
  trendMeta:{fontFamily:fontFamily.regular,fontSize:fontSize.xs,color:colors.muted,width:"100%",marginLeft:42},
  metric:{flex:1,padding:spacing.md,borderWidth:1,borderColor:colors.border,borderRadius:radius.md,backgroundColor:colors.surfaceSecondary},
  metricValue:{fontFamily:fontFamily.bold,fontSize:fontSize.xl,color:colors.brandPrimary},
  metricLabel:{fontFamily:fontFamily.semibold,fontSize:fontSize.xs,color:colors.muted,marginTop:3},
  dataRow:{flexDirection:"row",justifyContent:"space-between",paddingVertical:spacing.sm,borderBottomWidth:1,borderBottomColor:colors.border},
  dataLabel:{fontFamily:fontFamily.regular,fontSize:fontSize.sm,color:colors.onSurface,flex:1},
  dataValue:{fontFamily:fontFamily.bold,fontSize:fontSize.sm,color:colors.onSurface},
  caption:{fontFamily:fontFamily.regular,fontSize:fontSize.xs,color:colors.muted,lineHeight:18,marginTop:spacing.sm},
  notice:{padding:spacing.md,backgroundColor:colors.surface,borderRadius:radius.md,borderWidth:1,borderColor:colors.border,marginTop:spacing.md},
  noticeTitle:{fontFamily:fontFamily.bold,fontSize:fontSize.sm,color:colors.onSurface},
  recordCard:{padding:spacing.md,backgroundColor:colors.surface,borderWidth:1,borderColor:colors.border,borderRadius:radius.md,marginBottom:spacing.sm},
  rowBetween:{flexDirection:"row",alignItems:"center",justifyContent:"space-between",gap:spacing.sm},
  recordTitle:{fontFamily:fontFamily.semibold,fontSize:fontSize.sm,color:colors.onSurface},
  meta:{fontFamily:fontFamily.regular,fontSize:fontSize.xs,color:colors.muted,marginTop:3},
  summaryText:{fontFamily:fontFamily.regular,fontSize:fontSize.sm,color:colors.onSurface,lineHeight:20,marginTop:spacing.sm},
  recordImage:{width:"100%",height:170,marginTop:spacing.sm,backgroundColor:colors.surfaceSecondary,borderRadius:radius.sm},
  detailLine:{flexDirection:"row",paddingTop:spacing.xs,gap:spacing.sm},
  detailKey:{fontFamily:fontFamily.semibold,fontSize:fontSize.xs,color:colors.muted,width:112,textTransform:"capitalize"},
  detailValue:{fontFamily:fontFamily.regular,fontSize:fontSize.xs,color:colors.onSurface,flex:1},
  actionRow:{flexDirection:"row",gap:spacing.lg,alignItems:"center",marginTop:spacing.md,paddingTop:spacing.sm,borderTopWidth:1,borderTopColor:colors.border},
  smallAction:{flexDirection:"row",alignItems:"center",gap:5,paddingVertical:4},
  smallActionText:{fontFamily:fontFamily.semibold,fontSize:fontSize.xs,color:colors.brandPrimary},
  statusPill:{borderRadius:999,paddingHorizontal:9,paddingVertical:5},
  statusDanger:{backgroundColor:"#FCE7E7"},
  statusWarning:{backgroundColor:"#FFF1CC"},
  statusNormal:{backgroundColor:colors.brandTertiary},
  statusText:{fontFamily:fontFamily.bold,fontSize:fontSize.xs,color:"#5D3420"},
  offlineNotice:{flexDirection:"row",alignItems:"flex-start",gap:spacing.sm,marginTop:spacing.lg,padding:spacing.md,backgroundColor:colors.surface,borderWidth:1,borderColor:colors.border,borderRadius:radius.md},
  modalScreen:{flex:1,backgroundColor:colors.surfaceSecondary},
  modalHeader:{flexDirection:"row",alignItems:"center",justifyContent:"space-between",paddingHorizontal:spacing.md,paddingBottom:spacing.md,backgroundColor:colors.surface,borderBottomWidth:1,borderBottomColor:colors.border},
  modalTitle:{fontFamily:fontFamily.bold,fontSize:fontSize.lg,color:colors.onSurface},
  inputLabel:{fontFamily:fontFamily.semibold,fontSize:fontSize.sm,color:colors.onSurface,marginTop:spacing.md,marginBottom:spacing.xs},
  formInput:{minHeight:46,paddingHorizontal:spacing.md,paddingVertical:spacing.sm,borderWidth:1,borderColor:colors.border,borderRadius:radius.md,backgroundColor:colors.surface,color:colors.onSurface,fontFamily:fontFamily.regular,fontSize:fontSize.sm},
  multilineInput:{minHeight:88,textAlignVertical:"top"},
  bodyMapPanel:{padding:spacing.md,borderWidth:1,borderColor:colors.border,borderRadius:radius.md,backgroundColor:colors.surface,marginTop:spacing.md},
  regionGrid:{flexDirection:"row",flexWrap:"wrap",gap:spacing.xs},
  regionChip:{paddingHorizontal:10,paddingVertical:8,borderRadius:radius.md,borderWidth:1,borderColor:colors.border,backgroundColor:colors.surfaceSecondary},
  regionChipActive:{backgroundColor:colors.brandPrimary,borderColor:colors.brandPrimary},
  regionText:{fontFamily:fontFamily.medium,fontSize:fontSize.xs,color:colors.onSurface},
  regionTextActive:{color:colors.onBrandPrimary},
  imagePickerBox:{alignItems:"center",padding:spacing.md,borderWidth:1,borderColor:colors.border,borderRadius:radius.md,marginTop:spacing.md,backgroundColor:colors.surface},
  imagePreview:{width:"100%",height:180,backgroundColor:colors.surfaceSecondary,borderRadius:radius.sm},
  overlay:{flex:1,justifyContent:"flex-end",backgroundColor:"rgba(0,0,0,0.42)"},
  pickerCard:{maxHeight:"88%",backgroundColor:colors.surface,borderTopLeftRadius:radius.lg,borderTopRightRadius:radius.lg,padding:spacing.lg},
  articleListItem:{flexDirection:"row",alignItems:"center",gap:spacing.sm,padding:spacing.md,backgroundColor:colors.surfaceSecondary,borderRadius:radius.md,marginTop:spacing.sm,borderWidth:1,borderColor:colors.border},
  articleCard:{padding:spacing.md,backgroundColor:colors.surfaceSecondary,borderRadius:radius.md,marginTop:spacing.sm},
  backInline:{flexDirection:"row",alignItems:"center",gap:spacing.xs},
  articleBody:{fontFamily:fontFamily.regular,fontSize:fontSize.sm,color:colors.onSurface,lineHeight:22,marginTop:spacing.md},
  selectedRow:{borderColor:colors.brandPrimary},
  revisionPanel:{marginTop:spacing.md,padding:spacing.md,borderRadius:radius.md,backgroundColor:colors.surfaceSecondary},
  revisionRow:{flexDirection:"row",alignItems:"center",gap:spacing.sm,paddingVertical:spacing.sm,borderBottomWidth:1,borderBottomColor:colors.border},
  toggleRow:{flexDirection:"row",alignItems:"center",gap:spacing.md,paddingVertical:spacing.md,borderBottomWidth:1,borderBottomColor:colors.border},
  scannerScreen:{flex:1,backgroundColor:colors.surface},
  camera:{flex:1},
  centerFill:{flex:1,alignItems:"center",justifyContent:"center",padding:spacing.xl},
  compareCard:{width:"94%",maxHeight:"85%",alignSelf:"center",backgroundColor:colors.surface,borderRadius:radius.lg,padding:spacing.md},
  compareRow:{flexDirection:"row",gap:spacing.sm,marginTop:spacing.md},
  compareItem:{flex:1,minWidth:0},
  compareImage:{height:220,width:"100%",backgroundColor:colors.surfaceSecondary,borderRadius:radius.md,marginTop:spacing.xs},
  compareEmpty:{height:220,alignItems:"center",justifyContent:"center",backgroundColor:colors.surfaceSecondary,borderRadius:radius.md,marginTop:spacing.xs},
  articleEditorBody:{minHeight:220,textAlignVertical:"top"},
}));
