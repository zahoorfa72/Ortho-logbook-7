import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { triggerAutomaticDriveBackup } from "@/src/utils/storage/drive-auto-backup";
import { extractLabReportDate, isLikelyLabReportText, parseLabReportRows, recognizeLabText } from "@/src/utils/lab-ocr";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  Text,
  TextInput,
  View,
  Modal,
  ScrollView,
} from "react-native";
import Ionicons from "@react-native-vector-icons/ionicons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api } from "@/src/api/client";
import { formatInventoryLabel } from "@/src/utils/inventory-label";
import { useAuth } from "@/src/auth/AuthContext";
import { EmptyState } from "@/src/components/EmptyState";
import { SortMenu } from "@/src/components/SortMenu";
import { PinPromptModal } from "@/src/components/PinPromptModal";
import { PrimaryButton } from "@/src/components/PrimaryButton";
import { useToast } from "@/src/components/toast";
import { usesNativeTabs } from "@/src/navigation";
import {
  fontFamily,
  fontSize,
  makeStyles,
  radius,
  spacing,
  useTheme,
} from "@/src/theme";
import { hasAdminPin } from "@/src/utils/admin-pin";
import {
  dismissReminderForToday,
  evaluateReminder,
  type ReminderState,
} from "@/src/utils/backup-reminder";
import { buildPatientListHtml, generateAndSharePdf } from "@/src/utils/pdf";

type LabScanStatus = {
  status: "not-scanned" | "queued" | "scanning" | "success" | "failed" | "stopped";
  message: string;
  reportDate?: string;
  resultCount?: number;
  updatedAt?: string;
};

const LAB_SCAN_STATUS_STORAGE_KEY = "ortho_lab_ocr_scan_states_v1";
const NEW_PATIENT_LAB_SCAN_QUEUE_KEY = "ortho_lab_ocr_new_patient_queue_v1";

type Patient = {
  id: string;
  mrNo: string;
  name: string;
  gender: string;
  age: string;
  diagnosis: string;
  procedure: string;
  procedureII?: string;
  implant: string;
  implantII: string;
  date: string;
  address: string;
  fileName: string;
  photos: string[];
  customData?: Record<string,string>;
  hcvPlus?: boolean;
  hbaSg?: boolean;
  hiv?: boolean;
  operationCount?: number;
  totalOperations?: number;
  implants?: { id:string; inventoryId:string; name:string; category:string; size:string; quantity:number }[];
};

function labPhotoCacheKey(uri: string): string {
  let hash = 2166136261;
  for (let i = 0; i < uri.length; i++) hash = Math.imul(hash ^ uri.charCodeAt(i), 16777619);
  return "photo-" + (hash >>> 0).toString(16);
}

function ordinalShort(n: number) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function abnormalLabLabels(patient: Patient, automaticFlags?: string[], includeWarnings = true): string[] {
  const cachedFlags = Array.isArray(automaticFlags) ? automaticFlags : [];
  const persistedFlags = String(patient.customData?.labOcrPossibleFlags || "").split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  const saved = [...cachedFlags, ...persistedFlags].filter((value, index, all) => all.indexOf(value) === index).join("\n").trim();
  const labels: string[] = [];
  for (const raw of saved.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const statusMatch = line.match(/^(WARNING|ALERT|HIGH|LOW)\s*:\s*/i);
    if (!statusMatch) continue;
    const status = statusMatch[1].toUpperCase() === "WARNING" ? "WARNING" : "ALERT";
    const withoutStatus = statusMatch ? line.slice(statusMatch[0].length) : line;
    const dateMatch = withoutStatus.match(/\|\s*Date\s*:\s*([^|]+)/i);
    const reportDate = dateMatch?.[1]?.trim() || "";
    const withoutDate = withoutStatus.replace(/\|\s*Date\s*:\s*[^|]+/i, "").trim();
    const refMatch = withoutDate.match(/\|\s*Ref\s*:\s*(.+)$/i);
    const reference = refMatch?.[1]?.trim();
    const core = refMatch ? withoutDate.slice(0, refMatch.index).trim() : withoutDate.replace(/\s+—\s*POSSIBLY OUT OF RANGE.*$/i, "").trim();
    const resultMatch = core.match(/[-+]?\d+(?:[.,]\d+)?/);
    const resultText = resultMatch?.[0] || "";
    const first = resultMatch?.index ?? -1;
    let test = first > 0 ? core.slice(0, first).replace(/^[\s:|•-]+|[\s:|•-]+$/g, "").trim() : "";
    test = test.replace(/^(?:image\s+\d+\s*)/i, "").trim();
    if (!test || /^(?:ref(?:erence)?|normal|range|result|value)$/i.test(test)) test = "Test unclear";
    const unit = resultMatch ? core.slice(first + resultText.length).replace(/[|:;]/g, " ").replace(/\s+/g, " ").trim().slice(0, 12) : "";
    const label = status + ": " + test + (resultText ? " " + resultText : "") + (unit ? " " + unit : "") + (reference ? " (Ref " + reference + ")" : "") + (reportDate ? " · DATE: " + reportDate : "");
    if (!labels.includes(label) && (includeWarnings || status !== "WARNING")) labels.push(label);
  }

  let manual: any[] = [];
  try {
    const parsed = patient.customData?.labOcrManualResults ? JSON.parse(patient.customData.labOcrManualResults) : [];
    if (Array.isArray(parsed)) manual = parsed;
  } catch {}
  for (const item of manual) {
    if (!item || !String(item.test || "").trim() || !String(item.result ?? "").trim()) continue;
    const value = Number(String(item.result).replace(",", "."));
    const range = String(item.reference || "").match(/^\s*([-+]?\d+(?:[.,]\d+)?)\s*(?:-|–|—|to)\s*([-+]?\d+(?:[.,]\d+)?)\s*$/i)
      || String(item.reference || "").match(/([-+]?\d+(?:[.,]\d+)?)\s*(?:-|–|—|to)\s*([-+]?\d+(?:[.,]\d+)?)/i);
    const min = item.min !== undefined && item.min !== null && item.min !== "" ? Number(item.min) : range ? Number(range[1].replace(",", ".")) : NaN;
    const max = item.max !== undefined && item.max !== null && item.max !== "" ? Number(item.max) : range ? Number(range[2].replace(",", ".")) : NaN;
    const hasRange = Number.isFinite(value) && Number.isFinite(min) && Number.isFinite(max) && max > min;
    const outside = hasRange && (value < min || value > max);
    let severity = "";
    if (outside) {
      const boundary = value < min ? min : max;
      const deviation = Math.abs(value - boundary) / Math.max(Math.abs(boundary), 0.000001) * 100;
      if (deviation > 1) severity = deviation <= 10 ? "WARNING" : "ALERT";
    }
    if (!severity || (severity === "WARNING" && !includeWarnings)) continue;
    const resultStatus = severity;
    const label = resultStatus + ": [MANUAL] " + String(item.test).trim() + " " + String(item.result).trim()
      + (item.unit ? " " + String(item.unit).trim() : "")
      + (item.reference ? " (Ref " + String(item.reference).trim() + ")" : "")
      + " · DATE: " + String(item.date || item.reportDate || "Date not entered").trim();
    if (!labels.includes(label)) labels.push(label);
  }
  return labels.slice(0, 20);
}
export default function Logbook() {
  const styles = useStyles();
  const { colors, branding } = useTheme();
  const insets = useSafeAreaInsets();
  const { user, logout } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [patientSort, setPatientSort] = useState<"date-desc" | "date-asc" | "name-asc" | "name-desc" | "mr-asc" | "mr-desc">("date-desc");
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [pinPromptFor, setPinPromptFor] = useState<null | "settings" | "export">(null);
  const [exporting, setExporting] = useState(false);
  const [pdfFilterOpen, setPdfFilterOpen] = useState(false);
  const [pdfFromDate, setPdfFromDate] = useState("");
  const [pdfToDate, setPdfToDate] = useState("");
  const [pdfMonth, setPdfMonth] = useState("");
  const [pdfYear, setPdfYear] = useState("");
  const [reminder, setReminder] = useState<ReminderState>({ show: false, lastBackupIso: null, reason: null });
  const [labOcrEnabled, setLabOcrEnabled] = useState(false);
  const [labWarningsEnabled, setLabWarningsEnabled] = useState(true);
  const [labResultsHiddenByPatient, setLabResultsHiddenByPatient] = useState<Record<string, boolean>>({});
  const [labFlagsByPatient, setLabFlagsByPatient] = useState<Record<string, { signature: string; flags: string[]; reportDate?: string }>>({});
  const [labScanStates, setLabScanStates] = useState<Record<string, LabScanStatus>>({});
  const [labScanStateLoaded, setLabScanStateLoaded] = useState(false);
  const labScanStatesRef = useRef<Record<string, LabScanStatus>>({});
  const latestPatientsRef = useRef<Patient[]>([]);
  const pendingLabScansRef = useRef<string[]>([]);
  const runningLabScansRef = useRef<Set<string>>(new Set());
  const activeLabScanRef = useRef<string | null>(null);
  const stopLabScansRef = useRef<Set<string>>(new Set());
  const scanQueueRunningRef = useRef(false);
  const autoQueuedPatientIdsRef = useRef<Set<string>>(new Set());
  const requestLabScanRef = useRef<(patientId: string, autoForNewPatient?: boolean) => void>(() => {});

  useEffect(() => {
    AsyncStorage.getItem("ortho_lab_ocr_enabled").then(value => setLabOcrEnabled(value === "true")).catch(() => setLabOcrEnabled(false));
    AsyncStorage.getItem("ortho_lab_warnings_enabled").then(value => setLabWarningsEnabled(value !== "false")).catch(() => setLabWarningsEnabled(true));
    AsyncStorage.getItem("ortho_lab_results_hidden_by_patient_v1").then(raw => { if (raw) { try { const parsed = JSON.parse(raw); if (parsed && typeof parsed === "object") setLabResultsHiddenByPatient(parsed); } catch {} } }).catch(() => {});
    AsyncStorage.getItem("ortho_lab_ocr_patient_cache_v7").then(raw => {
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") setLabFlagsByPatient(parsed);
      } catch {}
    }).catch(() => {});
  }, []);

  // Re-evaluate the daily backup reminder whenever the Logbook tab regains focus.
  useFocusEffect(
    useCallback(() => {
      if (user?.role !== "admin") {
        setReminder({ show: false, lastBackupIso: null, reason: null });
        return;
      }
      let cancelled = false;
      evaluateReminder().then((r) => {
        if (!cancelled) setReminder(r);
      });
      return () => {
        cancelled = true;
      };
    }, [user?.role]),
  );

  const dismissReminder = useCallback(async () => {
    await dismissReminderForToday();
    setReminder({ show: false, lastBackupIso: reminder.lastBackupIso, reason: null });
  }, [reminder.lastBackupIso]);

  const goBackupNow = useCallback(() => {
    setReminder({ show: false, lastBackupIso: reminder.lastBackupIso, reason: null });
    router.push("/backup-restore");
  }, [reminder.lastBackupIso]);

  const bottomChrome = usesNativeTabs ? insets.bottom : 0;

  const { data: customFields = [] } = useQuery<any[]>({
    queryKey: ["patient-custom-fields"],
    queryFn: () => api.get("/patient-custom-fields"),
  });

  const {
    data,
    isLoading,
    isError,
    refetch,
    isRefetching,
  } = useQuery<Patient[]>({
    queryKey: ["patients"],
    queryFn: () => api.get("/patients"),
  });

  latestPatientsRef.current = data || [];

  const saveLabScanState = useCallback((patientId: string, nextState: LabScanStatus) => {
    const next = { ...labScanStatesRef.current, [patientId]: nextState };
    labScanStatesRef.current = next;
    setLabScanStates(next);
    AsyncStorage.setItem(LAB_SCAN_STATUS_STORAGE_KEY, JSON.stringify(next)).catch(() => {});
  }, []);

  const removeNewPatientQueueEntry = useCallback(async (patientId: string) => {
    try {
      const raw = await AsyncStorage.getItem(NEW_PATIENT_LAB_SCAN_QUEUE_KEY);
      const saved: unknown = raw ? JSON.parse(raw) : [];
      const next = (Array.isArray(saved) ? saved : []).filter(value => String(value) !== patientId);
      await AsyncStorage.setItem(NEW_PATIENT_LAB_SCAN_QUEUE_KEY, JSON.stringify(next));
      autoQueuedPatientIdsRef.current.delete(patientId);
    } catch {}
  }, []);

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(LAB_SCAN_STATUS_STORAGE_KEY).then(raw => {
      if (cancelled) return;
      let saved: Record<string, LabScanStatus> = {};
      try {
        const parsed = raw ? JSON.parse(raw) : {};
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) saved = parsed;
      } catch {}
      const normalized: Record<string, LabScanStatus> = {};
      for (const [id, state] of Object.entries(saved)) {
        if (!state || typeof state !== "object") continue;
        normalized[id] = (state.status === "scanning" || state.status === "queued")
          ? { ...state, status: "stopped", message: "Scan did not finish before the app closed. Tap Retry to run it again." }
          : state;
      }
      labScanStatesRef.current = normalized;
      setLabScanStates(normalized);
      setLabScanStateLoaded(true);
    }).catch(() => { if (!cancelled) setLabScanStateLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  const runOnePatientLabScan = useCallback(async (patientId: string, forceRetry = true) => {
    if (runningLabScansRef.current.has(patientId)) return;
    let patient = latestPatientsRef.current.find(value => value.id === patientId);
    if (!patient) {
      saveLabScanState(patientId, { status: "failed", message: "Patient record is not available in the current list.", updatedAt: new Date().toISOString() });
      return;
    }
    if (!labOcrEnabled) {
      saveLabScanState(patientId, { status: "failed", message: "Lab reader is disabled. Enable Offline Lab Report Reader in Settings, then Retry.", updatedAt: new Date().toISOString() });
      return;
    }
    runningLabScansRef.current.add(patientId);
    saveLabScanState(patientId, { status: "scanning", message: "Scanning this patient's saved photos…", updatedAt: new Date().toISOString() });
    try {
      // The patient-list endpoint omits photo URIs, so load the full patient record before scanning.
      try {
        const fullPatient = await api.get<Patient>("/patients/" + patientId);
        if (fullPatient?.id) patient = { ...patient, ...fullPatient };
      } catch {}
      const photos = [...new Set([...(patient.photos || []), ...((patient as any).photoUri ? [(patient as any).photoUri] : [])])].filter(Boolean);
      if (!photos.length) {
        saveLabScanState(patientId, { status: "failed", message: "No saved photos found. Add the lab report photo to this patient, then tap Retry.", updatedAt: new Date().toISOString() });
        await removeNewPatientQueueEntry(patientId);
        return;
      }
      let photoCache: Record<string, { text: string; structuredText: string; isReport: boolean; reportDate: string; checkedAt?: number }> = {};
      let configuredTests: import("@/src/utils/lab-ocr").LabTestDefinition[] = [];
      let onlineOcrKey = "";
      let warningPercent = 10;
      try {
        const raw = await AsyncStorage.getItem("ortho_lab_ocr_photo_cache_v3");
        if (raw) photoCache = JSON.parse(raw);
      } catch {}
      try {
        const raw = await AsyncStorage.getItem("ortho_lab_test_definitions_v1");
        if (raw) { const value = JSON.parse(raw); if (Array.isArray(value)) configuredTests = value; }
      } catch {}
      try { onlineOcrKey = (await AsyncStorage.getItem("ortho_lab_online_ocr_api_key_v1")) || ""; } catch {}
      try {
        const raw = await AsyncStorage.getItem("ortho_lab_warning_threshold_percent_v1");
        const parsed = Number(raw);
        if (raw && Number.isInteger(parsed) && parsed >= 1 && parsed <= 100) warningPercent = parsed;
      } catch {}
      let unreadableImages = 0;
      for (let offset = 0; offset < photos.length; offset += 2) {
        if (stopLabScansRef.current.has(patientId)) return;
        const batch = photos.slice(offset, offset + 2);
        const results = await Promise.all(batch.map(async uri => {
          const key = labPhotoCacheKey(uri);
          const cached = photoCache[key];
          if (!forceRetry && cached && cached.checkedAt && Date.now() - cached.checkedAt < 10 * 60 * 1000) {
            return { uri, ...cached };
          }
          try {
            const result = await recognizeLabText(uri, onlineOcrKey);
            const text = String(result?.text || "").trim();
            const structuredText = result?.mode === "online" ? "" : String(result?.structuredText || "").trim();
            const combined = text + "\n" + structuredText;
            const hasNumbers = /[-+]?\d+(?:[.,]\d+)?/.test(combined);
            const hasLabCue = /\b(?:laboratory|lab report|investigation|test name|test results?|reference range|normal range|biological reference|specimen|hemoglobin|haemoglobin|platelets|glucose|creatinine|hbsag|hcv|hiv|wbc|rbc)\b/i.test(combined);
            const isReport = !!combined.trim() && (
              isLikelyLabReportText(text, configuredTests) ||
              isLikelyLabReportText(structuredText, configuredTests) ||
              (hasNumbers && hasLabCue)
            );
            if (!text && !structuredText) unreadableImages += 1;
            return { uri, text, structuredText, isReport, reportDate: extractLabReportDate(text + "\n" + structuredText), checkedAt: Date.now() };
          } catch {
            unreadableImages += 1;
            return { uri, text: "", structuredText: "", isReport: false, reportDate: "", checkedAt: Date.now() };
          }
        }));
        if (stopLabScansRef.current.has(patientId)) return;
        for (const result of results) {
          photoCache[labPhotoCacheKey(result.uri)] = {
            text: result.text, structuredText: result.structuredText, isReport: result.isReport,
            reportDate: result.reportDate || extractLabReportDate(result.text + "\n" + result.structuredText),
            checkedAt: result.checkedAt || Date.now(),
          };
        }
        await AsyncStorage.setItem("ortho_lab_ocr_photo_cache_v3", JSON.stringify(photoCache)).catch(() => {});
      }
      if (stopLabScansRef.current.has(patientId)) return;

      const reportPages: Array<{ text: string; reportDate: string }> = [];
      for (const uri of photos) {
        const entry = photoCache[labPhotoCacheKey(uri)];
        if (!entry?.isReport) continue;
        const reportDate = entry.reportDate || extractLabReportDate(entry.text + "\n" + entry.structuredText) || "";
        reportPages.push({
          reportDate,
          text: "LAB REPORT IMAGE " + (reportPages.length + 1) + "\n" +
            (reportDate ? "IMAGE REPORT DATE: " + reportDate + "\n" : "") +
            (entry.structuredText ? "RECONSTRUCTED TABLE ROWS (test | result | unit | reference range)\n" + entry.structuredText + "\n" : "") +
            "RAW OCR TEXT FOR REVIEW\n" + entry.text,
        });
      }
      if (!reportPages.length) {
        const emptyFlags: string[] = [];
        setLabFlagsByPatient(previous => ({ ...previous, [patientId]: { signature: photos.join("|"), flags: emptyFlags } }));
        try {
          await api.put("/patients/" + patientId, {
            ...patient,
            customData: { ...(patient.customData || {}), labOcrPossibleFlags: "", labOcrDetectedAt: new Date().toISOString(), labOcrReportDate: "" },
          });
          queryClient.invalidateQueries({ queryKey: ["patients"] });
        } catch {}
        try {
          let snapshot: Record<string, any> = {};
          const raw = await AsyncStorage.getItem("ortho_lab_ocr_patient_cache_v7");
          if (raw) snapshot = JSON.parse(raw);
          snapshot[patientId] = { signature: photos.join("|"), flags: [], reportDate: "" };
          await AsyncStorage.setItem("ortho_lab_ocr_patient_cache_v7", JSON.stringify(snapshot));
        } catch {}
        saveLabScanState(patientId, { status: "failed", message: unreadableImages === photos.length
          ? "The photos could not be read. Check that the report is clear, then Retry."
          : "No lab report was recognized in these photos. Check the photo, then Retry.", updatedAt: new Date().toISOString() });
        await removeNewPatientQueueEntry(patientId);
        return;
      }

      const flags: string[] = [];
      for (const page of reportPages) {
        const reportDate = page.reportDate || extractLabReportDate(page.text) || "Date not detected";
        for (const row of parseLabReportRows(page.text, configuredTests, patient.gender, warningPercent)) {
          flags.push(row.severity + ": " + row.test + " " + row.result +
            (row.unit ? " " + row.unit : "") +
            " | Date: " + reportDate + " | Ref: " + row.reference);
        }
      }
      const uniqueFlags = flags.filter((flag, i, all) => all.indexOf(flag) === i).slice(0, 20);
      const availableDates = reportPages.map(page => page.reportDate).filter(Boolean);
      const reportDateSummary = availableDates.length === 0 ? "Date not detected"
        : [...new Set(availableDates)].length > 1 ? "Multiple report dates — see each result"
        : availableDates[0];
      const signature = photos.join("|") + "|gender:" + String(patient.gender || "") +
        "|ranges:" + configuredTests.map(item => [item.name,item.maleMin,item.maleMax,item.femaleMin,item.femaleMax,item.unit].join(":")).join(";");
      setLabFlagsByPatient(previous => ({ ...previous, [patientId]: { signature, flags: uniqueFlags, reportDate: reportDateSummary } }));
      try {
        const existingCustomData = patient.customData || {};
        const updated = await api.put("/patients/" + patientId, {
          ...patient,
          customData: {
            ...existingCustomData,
            labOcrPossibleFlags: uniqueFlags.join("\n"),
            labOcrDetectedAt: new Date().toISOString(),
            labOcrReportDate: reportDateSummary,
          },
        });
        void updated;
        queryClient.invalidateQueries({ queryKey: ["patients"] });
      } catch (error: any) {
        saveLabScanState(patientId, { status: "failed", message: "OCR read the report, but results could not be saved automatically. Retry or save the results from Patient Form.", reportDate: reportDateSummary, resultCount: uniqueFlags.length, updatedAt: new Date().toISOString() });
        await removeNewPatientQueueEntry(patientId);
        return;
      }
      let photoSnapshot: Record<string, any> = {};
      try {
        const raw = await AsyncStorage.getItem("ortho_lab_ocr_patient_cache_v7");
        if (raw) photoSnapshot = JSON.parse(raw);
      } catch {}
      photoSnapshot[patientId] = { signature, flags: uniqueFlags, reportDate: reportDateSummary };
      await AsyncStorage.setItem("ortho_lab_ocr_patient_cache_v7", JSON.stringify(photoSnapshot)).catch(() => {});
      const message = unreadableImages
        ? "Scan completed with " + unreadableImages + " unreadable photo(s). Verify those photos manually."
        : uniqueFlags.length
          ? "Scan successful — " + uniqueFlags.length + " abnormal result(s) flagged. Verify them against the original report."
          : "Scan successful — no out-of-range result was flagged against the saved reference ranges. This does not prove every result is normal.";
      saveLabScanState(patientId, { status: "success", message, reportDate: reportDateSummary, resultCount: uniqueFlags.length, updatedAt: new Date().toISOString() });
      await removeNewPatientQueueEntry(patientId);
    } catch (error: any) {
      if (!stopLabScansRef.current.has(patientId)) {
        saveLabScanState(patientId, { status: "failed", message: error?.message || "The lab scan failed. Check the photo and tap Retry.", updatedAt: new Date().toISOString() });
        await removeNewPatientQueueEntry(patientId);
      }
    } finally {
      runningLabScansRef.current.delete(patientId);
      if (activeLabScanRef.current === patientId) activeLabScanRef.current = null;
    }
  }, [labOcrEnabled, queryClient, removeNewPatientQueueEntry, saveLabScanState]);

  const drainLabScanQueue = useCallback(async () => {
    if (scanQueueRunningRef.current) return;
    scanQueueRunningRef.current = true;
    try {
      while (pendingLabScansRef.current.length) {
        const patientId = pendingLabScansRef.current.shift()!;
        if (stopLabScansRef.current.has(patientId)) continue;
        activeLabScanRef.current = patientId;
        await runOnePatientLabScan(patientId, true);
      }
    } finally {
      scanQueueRunningRef.current = false;
      if (pendingLabScansRef.current.length) void drainLabScanQueue();
    }
  }, [runOnePatientLabScan]);

  const requestLabScan = useCallback((patientId: string, autoForNewPatient = false) => {
    stopLabScansRef.current.delete(patientId);
    if (runningLabScansRef.current.has(patientId) || pendingLabScansRef.current.includes(patientId)) return;
    if (autoForNewPatient) autoQueuedPatientIdsRef.current.add(patientId);
    pendingLabScansRef.current.push(patientId);
    saveLabScanState(patientId, { status: "queued", message: autoForNewPatient ? "New patient: waiting to scan saved photos…" : "Retry requested — waiting to scan this patient's photos…", updatedAt: new Date().toISOString() });
    void drainLabScanQueue();
  }, [drainLabScanQueue, saveLabScanState]);
  requestLabScanRef.current = requestLabScan;

  const stopLabScan = useCallback((patientId: string) => {
    stopLabScansRef.current.add(patientId);
    pendingLabScansRef.current = pendingLabScansRef.current.filter(id => id !== patientId);
    saveLabScanState(patientId, { status: "stopped", message: "Scan stopped by administrator. Tap Retry to continue.", updatedAt: new Date().toISOString() });
    void removeNewPatientQueueEntry(patientId);
  }, [removeNewPatientQueueEntry, saveLabScanState]);

  useEffect(() => {
    if (!labScanStateLoaded || !labOcrEnabled || isLoading || !Array.isArray(data)) return;
    AsyncStorage.getItem(NEW_PATIENT_LAB_SCAN_QUEUE_KEY).then(raw => {
      let queuedIds: string[] = [];
      try { const parsed = raw ? JSON.parse(raw) : []; if (Array.isArray(parsed)) queuedIds = parsed.map(String); } catch {}
      const patientIds = new Set((data || []).map(patient => patient.id));
      for (const patientId of queuedIds) {
        if (!patientIds.has(patientId) || autoQueuedPatientIdsRef.current.has(patientId)) continue;
        requestLabScanRef.current(patientId, true);
      }
    }).catch(() => {});
  }, [labScanStateLoaded, labOcrEnabled, isLoading, data]);

  const toggleLabResultsHidden = async (id: string) => {
    const next = { ...labResultsHiddenByPatient, [id]: !labResultsHiddenByPatient[id] };
    setLabResultsHiddenByPatient(next);
    try {
      await AsyncStorage.setItem("ortho_lab_results_hidden_by_patient_v1", JSON.stringify(next));
      triggerAutomaticDriveBackup("appSettings");
    } catch {
      setLabResultsHiddenByPatient(labResultsHiddenByPatient);
      toast("Could not save this patient's lab-result visibility setting.", "error");
    }
  };

  const togglePatient = (id: string) => setSelectedIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  const selectAllPatients = () => setSelectedIds(selectedIds.length === filtered.length ? [] : filtered.map((p) => p.id));
  const deleteSelectedPatients = () => {
    if (!selectedIds.length) {
      Alert.alert("No patients selected", "Select at least one patient first.");
      return;
    }
    Alert.alert(
      "Delete patients?",
      `Move ${selectedIds.length} selected patient record(s) to Trash for 30 days? Used implants will be returned to inventory. You can restore these records from Settings → Trash before they expire.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            const idsToDelete = [...selectedIds];
            try {
              const result = await api.post<{ success: boolean; deleted: number }>("/patients-bulk-delete", { ids: idsToDelete });
              if (result.deleted !== idsToDelete.length) {
                throw new Error(`Only ${result.deleted} of ${idsToDelete.length} selected patient record(s) were deleted.`);
              }
              // Refresh directly from SQLite after the transaction has committed.
              setSelectedIds([]);
              setSelectMode(false);
              queryClient.invalidateQueries({ queryKey: ["patients"] });
              await refetch();
            } catch (e:any) {
              Alert.alert("Delete failed", e?.message || "Could not delete selected patients.");
            }
          },
        },
      ],
    );
  };

  const patientsWithOperationCounts = useMemo(() => {
    const source = data || [];
    const groups = new Map<string, Patient[]>();

    const keyOf = (p: Patient) =>
      (p.name || "").trim().toLowerCase() +
      "|" +
      (p.mrNo || "").trim().toLowerCase();

    for (const p of source) {
      if (!p.name?.trim() || !p.mrNo?.trim()) continue;
      const key = keyOf(p);
      const list = groups.get(key) || [];
      list.push(p);
      groups.set(key, list);
    }

    const counts = new Map<string, { operationCount: number; totalOperations: number }>();

    for (const list of groups.values()) {
      const sorted = [...list].sort(
        (a, b) =>
          String(a.date || "").localeCompare(String(b.date || "")) ||
          String(a.id || "").localeCompare(String(b.id || "")),
      );
      sorted.forEach((p, i) =>
        counts.set(p.id, {
          operationCount: i + 1,
          totalOperations: sorted.length,
        }),
      );
    }

    return source.map((p) => ({ ...p, ...(counts.get(p.id) || {}) }));
  }, [data]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = patientsWithOperationCounts.filter((p) =>
      !q ||
      [p.mrNo, p.name, p.diagnosis, p.procedure, p.procedureII, p.implant, p.implantII, ...(p.implants || []).flatMap(x => [x.category, x.name, x.size])]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );

    list = [...list].sort((a, b) => {
      if (patientSort === "name-asc") return (a.name || "").localeCompare(b.name || "", undefined, { numeric: true, sensitivity: "base" });
      if (patientSort === "name-desc") return (b.name || "").localeCompare(a.name || "", undefined, { numeric: true, sensitivity: "base" });
      if (patientSort === "mr-asc") return (a.mrNo || "").localeCompare(b.mrNo || "", undefined, { numeric: true, sensitivity: "base" });
      if (patientSort === "mr-desc") return (b.mrNo || "").localeCompare(a.mrNo || "", undefined, { numeric: true, sensitivity: "base" });
      if (patientSort === "date-asc") return (a.date || "").localeCompare(b.date || "");
      return (b.date || "").localeCompare(a.date || "");
    });
    return list;
  }, [patientsWithOperationCounts, query, patientSort]);

  const availableYears = useMemo(() => [...new Set((data || []).map(p => String(p.date || "").slice(0,4)).filter(Boolean))].sort().reverse(), [data]);
  const filteredForPdf = useCallback(() => {
    const dateKey = (v:string) => {
      const raw=String(v||"").trim();
      const iso=raw.match(/^(\\d{4})[-\\/](\\d{1,2})[-\\/](\\d{1,2})$/);
      if(iso) return iso[1]+iso[2].padStart(2,"0")+iso[3].padStart(2,"0");
      const dmy=raw.match(/^(\\d{1,2})[-\\/](\\d{1,2})[-\\/](\\d{4})$/);
      if(dmy) return dmy[3]+dmy[2].padStart(2,"0")+dmy[1].padStart(2,"0");
      return raw;
    };
    let list = [...(data || [])];
    const year = Number(pdfYear); const month = Number(pdfMonth);
    if (year) list = list.filter(p => dateKey(String(p.date||"")).startsWith(String(year)));
    if (month >= 1 && month <= 12 && year) list = list.filter(p => dateKey(String(p.date||"")).startsWith(String(year)+String(month).padStart(2,"0")));
    const fromKey=dateKey(pdfFromDate); const toKey=dateKey(pdfToDate);
    if (fromKey) list = list.filter(p => { const d=dateKey(String(p.date||"")); return d && d>=fromKey; });
    if (toKey) list = list.filter(p => { const d=dateKey(String(p.date||"")); return d && d<=toKey; });
    return list;
  }, [data,pdfFromDate,pdfToDate,pdfMonth,pdfYear]);
  const openPdfFilter = useCallback(() => { setPdfFromDate(""); setPdfToDate(""); setPdfMonth(""); setPdfYear(""); setPdfFilterOpen(true); }, []);
  const doExport = useCallback(async () => {
    if (pdfFromDate && pdfToDate && pdfFromDate > pdfToDate) { toast("From date cannot be after To date.", "error"); return; }
    const list = filteredForPdf();
    if (!list.length) { toast("No patients match the selected PDF dates.", "info"); return; }
    setExporting(true);
    try {
      let effectiveFrom = pdfFromDate; let effectiveTo = pdfToDate;
      const y = Number(pdfYear); const m = Number(pdfMonth);
      if (y && m >= 1 && m <= 12) { effectiveFrom = effectiveFrom || String(y) + "-" + String(m).padStart(2,"0") + "-01"; effectiveTo = effectiveTo || String(y) + "-" + String(m).padStart(2,"0") + "-" + String(new Date(y,m,0).getDate()).padStart(2,"0"); }
      else if (y) { effectiveFrom = effectiveFrom || String(y) + "-01-01"; effectiveTo = effectiveTo || String(y) + "-12-31"; }
      const html = buildPatientListHtml(branding, list, effectiveFrom, effectiveTo); setPdfFilterOpen(false); await generateAndSharePdf(html, "Patient List");
    }
    catch(e:any) { toast(e?.message || "Could not create PDF.", "error"); }
    finally { setExporting(false); }
  }, [branding,filteredForPdf,pdfFromDate,pdfToDate,pdfMonth,pdfYear,toast]);


  const requestExport = useCallback(async () => { if (await hasAdminPin()) setPinPromptFor("export"); else openPdfFilter(); }, [openPdfFilter]);
  const requestSettings = useCallback(async () => {
    if (await hasAdminPin()) setPinPromptFor("settings");
    else router.push("/settings");
  }, []);

  const infectionResults = (item: Patient) => [
    ["HCV+", Boolean(item.hcvPlus) || String(item.customData?.hcvPlus || "").toLowerCase() === "true"],
    ["HbAsg", Boolean(item.hbaSg) || String(item.customData?.hbaSg || "").toLowerCase() === "true"],
    ["HIV", Boolean(item.hiv) || String(item.customData?.hiv || "").toLowerCase() === "true"],
  ].filter(([,positive]) => positive).map(([label]) => String(label));

  const chip = (label: string, key: string) =>
    label ? (
      <View key={key} style={styles.chip}>
        <Text style={styles.chipText} numberOfLines={1}>
          {label}
        </Text>
      </View>
    ) : null;

  return (
    <View style={styles.container}>
      {/* Sticky header */}
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <View style={styles.headerTop}>
          <View style={{ flex: 1 }}>
            <Text style={styles.hello}>{branding.title}</Text>
            <Text style={styles.name} numberOfLines={1}>
              {user?.name || "Doctor"}
            </Text>
          </View>

          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            {user?.role === "admin" && (
              <Pressable testID="patient-select-mode" onPress={() => { setSelectMode(!selectMode); setSelectedIds([]); }} style={styles.iconBtn}><Ionicons name={selectMode ? "close" : "checkmark-circle-outline"} size={22} color={colors.onSurfaceSecondary} /></Pressable>
            )}
            {user?.role === "admin" && (
              <Pressable
                testID="export-pdf-button"
                onPress={requestExport}
                style={styles.iconBtn}
                hitSlop={8}
                disabled={exporting}
              >
                {exporting ? (
                  <ActivityIndicator size="small" color={colors.brandPrimary} />
                ) : (
                  <Ionicons name="document-text-outline" size={22} color={colors.onSurfaceSecondary} />
                )}
              </Pressable>
            )}
            {user?.role === "admin" && (
              <Pressable
                testID="settings-button"
                onPress={requestSettings}
                style={styles.iconBtn}
                hitSlop={8}
              >
                <Ionicons name="settings-outline" size={22} color={colors.onSurfaceSecondary} />
              </Pressable>
            )}
            <Pressable
              testID="logout-button"
              onPress={logout}
              style={styles.iconBtn}
              hitSlop={8}
            >
              <Ionicons name="log-out-outline" size={22} color={colors.onSurfaceSecondary} />
            </Pressable>
          </View>
        </View>

        <View style={styles.searchWrap}>
          <Ionicons name="search" size={18} color={colors.muted} />
          <TextInput
            testID="logbook-search-input"
            value={query}
            onChangeText={setQuery}
            placeholder="Search MRNo, name, diagnosis, inventory…"
            placeholderTextColor={colors.muted}
            style={styles.searchInput}
          />
          {query.length > 0 && (
            <Pressable onPress={() => setQuery("")} hitSlop={8}>
              <Ionicons name="close-circle" size={18} color={colors.muted} />
            </Pressable>
          )}
        </View>
        <View style={{ marginTop: spacing.sm }}>
          <SortMenu
            value={patientSort}
            onChange={setPatientSort}
            testID="patient-sort"
            options={[
              { value: "date-desc", label: "Date — Newest first" },
              { value: "date-asc", label: "Date — Oldest first" },
              { value: "name-asc", label: "Patient name — A to Z" },
              { value: "name-desc", label: "Patient name — Z to A" },
              { value: "mr-asc", label: "MR No — low to high" },
              { value: "mr-desc", label: "MR No — high to low" },
            ]}
          />
        </View>
      </View>

      {selectMode ? (
        <View style={styles.selectionBar}>
          <Pressable onPress={selectAllPatients} style={styles.selectionAction}>
            <Ionicons name={selectedIds.length === filtered.length && filtered.length > 0 ? "checkbox" : "square-outline"} size={20} color={colors.brandPrimary} />
            <Text style={styles.selectionActionText}>
              {selectedIds.length === filtered.length && filtered.length > 0 ? "Clear All" : "Select All"}
            </Text>
          </Pressable>
          <Text style={styles.selectionCount}>{selectedIds.length} selected</Text>
          <Pressable
            onPress={deleteSelectedPatients}
            disabled={selectedIds.length === 0}
            style={[styles.deleteSelectionAction, selectedIds.length === 0 && { opacity: 0.45 }]}
          >
            <Ionicons name="trash-outline" size={19} color={colors.error || colors.onSurfaceSecondary} />
            <Text style={[styles.deleteSelectionText, { color: colors.error || colors.onSurfaceSecondary }]}>Delete</Text>
          </Pressable>
        </View>
      ) : null}

      {reminder.show ? (
        <View style={styles.reminder} testID="backup-reminder-banner">
          <View style={styles.reminderIcon}>
            <Ionicons name="cloud-upload-outline" size={20} color={colors.onBrandPrimary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.reminderTitle}>
              {reminder.reason === "never"
                ? "Back up today's records"
                : "It's evening — back up today's work"}
            </Text>
            <Text style={styles.reminderSub} numberOfLines={2}>
              {reminder.lastBackupIso
                ? `Last backup: ${new Date(reminder.lastBackupIso).toLocaleString()}`
                : "You haven't shared a backup yet."}
            </Text>
          </View>
          <View style={styles.reminderActions}>
            <Pressable
              testID="backup-reminder-cta"
              onPress={goBackupNow}
              style={styles.reminderCta}
              hitSlop={6}
            >
              <Text style={styles.reminderCtaText}>Back up</Text>
            </Pressable>
            <Pressable
              testID="backup-reminder-dismiss"
              onPress={dismissReminder}
              style={styles.reminderDismiss}
              hitSlop={6}
            >
              <Ionicons name="close" size={18} color={colors.muted} />
            </Pressable>
          </View>
        </View>
      ) : null}

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.brandPrimary} />
        </View>
      ) : isError ? (
        <View style={styles.center}>
          <EmptyState
            icon="cloud-offline-outline"
            title="Failed to load logbook"
            subtitle="Pull to retry."
          />
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{
            padding: spacing.lg,
            paddingBottom: bottomChrome + 96,
            flexGrow: 1,
          }}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.brandPrimary} />
          }
          ListHeaderComponent={
            filtered.length > 0 ? (
              <Text style={styles.count}>
                {filtered.length} record{filtered.length === 1 ? "" : "s"}
              </Text>
            ) : null
          }
          ListEmptyComponent={
            <EmptyState
              icon="reader-outline"
              title={query ? "No matching records" : "No patients logged yet"}
              subtitle={query ? "Try a different search." : "Tap the + button to add your first patient."}
            />
          }
          renderItem={({ item }) => (
            <Pressable
              testID={`patient-card-${item.id}`}
              style={[styles.card, selectMode && selectedIds.includes(item.id) && styles.selectedCard]}
              onPress={() => {
                if (selectMode) togglePatient(item.id);
                else router.push({ pathname: "/patient-form", params: { id: item.id } });
              }}
              onLongPress={() => {
                if (!selectMode) {
                  setSelectMode(true);
                  setSelectedIds([item.id]);
                }
              }}
              delayLongPress={350}
            >
              <View style={styles.cardTop}>
                {selectMode ? (
                  <View style={styles.patientSelectIndicator}>
                    <Ionicons
                      name={selectedIds.includes(item.id) ? "checkbox" : "square-outline"}
                      size={23}
                      color={selectedIds.includes(item.id) ? colors.brandPrimary : colors.muted}
                    />
                  </View>
                ) : null}
                <Text style={styles.mrNo}>{item.mrNo || "—"}</Text>
                <Text style={styles.date}>{item.date}</Text>
              </View>

              <View style={styles.nameRow}>
                <Text style={styles.patientName} numberOfLines={1}>
                  {item.name || "Unnamed patient"}
                </Text>
                {item.totalOperations && item.totalOperations > 1 ? (
                  <View
                    testID={`op-badge-${item.id}`}
                    style={[
                      styles.opBadge,
                      (item.operationCount || 1) > 1 && { backgroundColor: colors.warning },
                    ]}
                  >
                    <Ionicons name="repeat" size={11} color="#FFF" />
                    <Text style={styles.opBadgeText}>
                      {ordinalShort(item.operationCount || 1)} time
                    </Text>
                  </View>
                ) : null}
              </View>

              <View style={styles.chipRow}>
                {chip(item.diagnosis, "dx")}
                {chip(item.procedure, "px")}
                {chip(item.procedureII || "", "px2")}
              </View>
              {infectionResults(item).length ? (
                <View style={styles.infectionRow}>
                  {infectionResults(item).map(label => <Text key={label} style={styles.infectionText}>{label}</Text>)}
                </View>
              ) : null}
              {(() => {
                const labLabels = abnormalLabLabels(item, labFlagsByPatient[item.id]?.flags, labWarningsEnabled);
                const persistedReportDate = String(item.customData?.labOcrReportDate || "").trim();
                const persistedScanAt = String(item.customData?.labOcrDetectedAt || "").trim();
                const savedScanExists = !!persistedScanAt && !!persistedReportDate;
                const status: LabScanStatus = labScanStates[item.id] || (savedScanExists
                  ? { status: "success", message: "Scan result and report date restored from this patient record.", reportDate: persistedReportDate, updatedAt: persistedScanAt }
                  : { status: "not-scanned", message: "Older patient — not scanned automatically. An administrator can tap Retry when needed." });
                const hidden = labResultsHiddenByPatient[item.id] === true;
                let manualReportDates: string[] = [];
                try {
                  const savedManual = item.customData?.labOcrManualResults ? JSON.parse(item.customData.labOcrManualResults) : [];
                  if (Array.isArray(savedManual)) manualReportDates = savedManual
                    .map((result: any) => String(result?.date || result?.reportDate || "").trim())
                    .filter((date: string) => !!date && !/^date not (?:detected|entered)$/i.test(date));
                } catch {}
                // Build dates from raw saved scan results, not warning-filtered labels.
                // This keeps report dates visible when mild WARNING rows are hidden.
                const rawSavedLabFlags = [
                  ...(Array.isArray(labFlagsByPatient[item.id]?.flags) ? labFlagsByPatient[item.id].flags : []),
                  ...String(item.customData?.labOcrPossibleFlags || "").split(/\r?\n/).map(value => value.trim()).filter(Boolean),
                ];
                const datesFromFlags = rawSavedLabFlags
                  .map(label => label.match(/\|\s*Date\s*:\s*([^|]+)/i)?.[1]?.trim()
                    || label.match(/\s· DATE:\s*(.+)$/i)?.[1]?.trim() || "")
                  .filter(date => !!date && !/^date not (?:detected|entered)$/i.test(date));
                const dateCandidates = [
                  ...datesFromFlags,
                  ...manualReportDates,
                  ...(persistedReportDate && !/^(?:date not detected|multiple report dates — see each result)$/i.test(persistedReportDate) ? [persistedReportDate] : []),
                  ...(status.reportDate && !/^(?:date not detected|multiple report dates — see each result)$/i.test(status.reportDate) ? [status.reportDate] : []),
                ];
                const uniqueReportDates = [...new Set(dateCandidates)];
                const reportDateDisplay = uniqueReportDates.length
                  ? uniqueReportDates.join(", ")
                  : status.reportDate || persistedReportDate;
                const reportDateLabel = uniqueReportDates.length > 1 ? "Report dates: " : "Report date: ";
                const hasAlert = labLabels.some(label => label.startsWith("ALERT:"));
                const hasWarning = labLabels.some(label => label.startsWith("WARNING:"));
                const tone = hasAlert ? (colors.error || "#B91C1C") : hasWarning ? (colors.warning || "#B7791F")
                  : status.status === "failed" ? (colors.error || "#B91C1C")
                  : status.status === "success" ? "#15803D" : colors.brandPrimary;
                const statusLabel = status.status === "queued" ? "WAITING TO SCAN"
                  : status.status === "scanning" ? "SCANNING"
                  : status.status === "success" ? "SCAN SUCCESSFUL"
                  : status.status === "failed" ? "SCAN FAILED"
                  : status.status === "stopped" ? "SCAN STOPPED" : "NOT SCANNED";
                const canStop = status.status === "queued" || status.status === "scanning";
                const dateMatchExists = labLabels.some(label => /\s· DATE:\s*/.test(label));
                return <View style={{ marginTop: spacing.xs, paddingVertical: spacing.sm, paddingHorizontal: spacing.sm, borderRadius: radius.sm, borderWidth: 1, borderColor: tone, backgroundColor: tone + "10" }}>
                  <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                    {status.status === "scanning" || status.status === "queued"
                      ? <ActivityIndicator size="small" color={tone} />
                      : <Ionicons name={hasAlert ? "alert-circle" : hasWarning ? "warning" : status.status === "success" ? "checkmark-circle" : status.status === "failed" ? "close-circle" : status.status === "stopped" ? "pause-circle" : "flask-outline"} size={15} color={tone} />}
                    <Text style={{ color: tone, fontFamily: fontFamily.bold, fontSize: fontSize.xs }}>
                      {hasAlert ? "LAB ALERT" : hasWarning ? "LAB WARNING" : labLabels.length ? "LAB RESULTS" : "LAB SCAN"} · {statusLabel}
                    </Text>
                    {user?.role === "admin" ? (canStop
                      ? <Pressable onPress={event => { event.stopPropagation(); stopLabScan(item.id); }} hitSlop={8} style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1, borderColor: tone }}>
                          <Text style={{ color: tone, fontFamily: fontFamily.semibold, fontSize: fontSize.xs }}>Stop</Text>
                        </Pressable>
                      : <Pressable onPress={event => { event.stopPropagation(); requestLabScan(item.id, false); }} hitSlop={8} style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1, borderColor: tone }}>
                          <Text style={{ color: tone, fontFamily: fontFamily.semibold, fontSize: fontSize.xs }}>Retry</Text>
                        </Pressable>) : null}
                  </View>
                  {status.message ? <Text style={{ color: status.status === "failed" ? tone : colors.onSurfaceSecondary, fontSize: 10, marginTop: 4 }}>{status.message}</Text> : null}
                  {reportDateDisplay ? <Text testID={`lab-report-date-${item.id}`} style={{ color: colors.muted, fontSize: 10, marginTop: 2 }}>{reportDateLabel}{reportDateDisplay}</Text> : status.status === "success" ? <Text testID={`lab-report-date-${item.id}`} style={{ color: colors.muted, fontSize: 10, marginTop: 2 }}>Report date: Date not detected</Text> : null}
                  {labLabels.length ? <View style={{ marginTop: spacing.xs }}>
                    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 4 }}>
                      {hidden ? <Text style={{ color: tone, fontSize: fontSize.xs }}>Results hidden — status indicator remains visible</Text> : labLabels.map((label, index) => {
                        const warning = label.startsWith("WARNING:");
                        const labelTone = warning ? (colors.warning || "#B7791F") : (colors.error || "#B91C1C");
                        const dateMatch = label.match(/\s· DATE:\s*(.+)$/);
                        const visibleLabel = dateMatch ? label.slice(0, dateMatch.index) : label;
                        return <Text key={label + index} style={{ color: labelTone, fontFamily: fontFamily.bold, fontSize: fontSize.xs }}>{visibleLabel} · {dateMatch ? dateMatch[1] : "Date not detected"}</Text>;
                      })}
                      <Pressable onPress={event => { event.stopPropagation(); void toggleLabResultsHidden(item.id); }} hitSlop={8} accessibilityLabel={hidden ? "Show this patient's lab results" : "Hide this patient's lab results"} style={{ flexDirection: "row", alignItems: "center", gap: 3, paddingHorizontal: 4, paddingVertical: 2 }}>
                        <Ionicons name={hidden ? "eye-outline" : "eye-off-outline"} size={14} color={tone} />
                        <Text style={{ color: tone, fontFamily: fontFamily.semibold, fontSize: fontSize.xs }}>{hidden ? "Show results" : "Hide results"}</Text>
                      </Pressable>
                    </View>
                    {!hidden ? <Text style={{ color: colors.muted, fontSize: 10, marginTop: 1 }}>Verify abnormal flags against the original report; this is not a diagnosis.</Text> : null}
                  </View> : null}
                  {!dateMatchExists && labLabels.length === 0 && status.status === "success" ? <Text style={{ color: colors.muted, fontSize: 10, marginTop: 2 }}>No abnormal result row to display. Normal results stay hidden; verify the original report if needed.</Text> : null}
                </View>;
              })()}

              {((item.implants && item.implants.length) || item.implant || item.implantII) ? (
                <View style={styles.implantRow}>
                  <Ionicons name="hardware-chip-outline" size={12} color={colors.muted} />
                  <View style={{ flex: 1 }}>
                    {(item.implants && item.implants.length ? item.implants : [
                      { id:"legacy-1", category:"", name:item.implant, size:"", quantity:1 },
                      { id:"legacy-2", category:"", name:item.implantII, size:"", quantity:1 },
                    ]).filter((x:any) => x.name).map((x:any) => (
                      <Text key={x.id} style={styles.implant} numberOfLines={1}>
                        {formatInventoryLabel(x.category, x.name, x.size)}{x.quantity > 1 ? ` × ${x.quantity}` : ""}
                      </Text>
                    ))}
                  </View>
                </View>
              ) : null}
            </Pressable>
          )}
        />
      )}

      {/* FAB */}
      <Pressable
        testID="add-patient-fab"
        style={[styles.fab, { bottom: bottomChrome + spacing.lg }]}
        onPress={() => router.push("/patient-form")}
      >
        <Ionicons name="add" size={30} color={colors.onBrandPrimary} />
      </Pressable>

      <Modal visible={pdfFilterOpen} transparent animationType="slide" onRequestClose={() => setPdfFilterOpen(false)}>
        <View style={styles.pdfModalOverlay}><View style={[styles.pdfModalCard,{paddingBottom:insets.bottom+spacing.lg}]}>
          <View style={styles.pdfModalHeader}><Text style={styles.pdfModalTitle}>Patient List PDF</Text><Pressable onPress={()=>setPdfFilterOpen(false)}><Ionicons name="close" size={24} color={colors.onSurface}/></Pressable></View>
          <Text style={styles.pdfModalLabel}>From date</Text>
          <TextInput value={pdfFromDate} onChangeText={setPdfFromDate} placeholder="YYYY-MM-DD (optional)" placeholderTextColor={colors.muted} style={styles.pdfDateInput}/>
          <Text style={styles.pdfModalLabel}>To date</Text>
          <TextInput value={pdfToDate} onChangeText={setPdfToDate} placeholder="YYYY-MM-DD (optional)" placeholderTextColor={colors.muted} style={styles.pdfDateInput}/>
          <Text style={styles.pdfModalLabel}>Month / Year (optional)</Text>
          <View style={styles.pdfFilterRow}><TextInput value={pdfMonth} onChangeText={v=>setPdfMonth(v.replace(/[^0-9]/g,"").slice(0,2))} placeholder="Month 1-12" placeholderTextColor={colors.muted} keyboardType="number-pad" style={[styles.pdfDateInput,{flex:1}]}/><TextInput value={pdfYear} onChangeText={v=>setPdfYear(v.replace(/[^0-9]/g,"").slice(0,4))} placeholder="Year" placeholderTextColor={colors.muted} keyboardType="number-pad" style={[styles.pdfDateInput,{flex:1}]}/></View>
          {availableYears.length ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pdfDateRow}>{availableYears.map(y=><Pressable key={y} onPress={()=>setPdfYear(y)} style={[styles.pdfDateChip,pdfYear===y&&styles.pdfDateChipActive]}><Text style={[styles.pdfDateText,pdfYear===y&&styles.pdfDateTextActive]}>{y}</Text></Pressable>)}</ScrollView> : null}
          <Text style={styles.pdfModalHint}>Patient List PDF uses the existing Branding settings and remains unchanged.</Text>
          <PrimaryButton title="Create Patient PDF" onPress={doExport} loading={exporting} testID="create-patient-list-pdf"/>
          <View style={{height:spacing.sm}} />
          <PrimaryButton title="Patient Detail PDF — Separate Option" onPress={()=>{setPdfFilterOpen(false);router.push("/patient-detail-pdf");}} testID="open-patient-detail-pdf"/>
        </View></View>
      </Modal>

      <PinPromptModal
        visible={pinPromptFor !== null}
        title="Admin PIN required"
        description={
          pinPromptFor === "export"
            ? "Enter admin PIN to export the patient list."
            : "Enter admin PIN to open settings."
        }
        onSuccess={() => {
          const kind = pinPromptFor;
          setPinPromptFor(null);
          if (kind === "export") doExport();
          if (kind === "settings") router.push("/settings");
        }}
        onCancel={() => setPinPromptFor(null)}
      />
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  container: { flex: 1, backgroundColor: colors.surfaceSecondary },
  header: {
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerTop: { flexDirection: "row", alignItems: "center", marginBottom: spacing.md },
  hello: { fontFamily: fontFamily.medium, fontSize: fontSize.sm, color: colors.muted },
  name: { fontFamily: fontFamily.bold, fontSize: fontSize.xl, color: colors.onSurface },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSecondary,
    alignItems: "center",
    justifyContent: "center",
  },
  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  searchInput: {
    flex: 1,
    paddingVertical: spacing.md,
    fontFamily: fontFamily.regular,
    fontSize: fontSize.base,
    color: colors.onSurface,
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  count: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSize.sm,
    color: colors.muted,
    marginBottom: spacing.md,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  headerAction: { flexDirection:"row", alignItems:"center", gap:4, paddingHorizontal:spacing.sm, paddingVertical:spacing.xs, borderRadius:radius.sm, backgroundColor:colors.surfaceSecondary },
  headerActionText: { fontFamily:fontFamily.semibold, fontSize:fontSize.sm, color:colors.brandPrimary },
  selectionBar: { flexDirection:"row", alignItems:"center", marginHorizontal:spacing.lg, marginTop:spacing.md, padding:spacing.sm, borderRadius:radius.md, backgroundColor:colors.surface, borderWidth:1, borderColor:colors.border },
  selectionAction: { flexDirection:"row", alignItems:"center", gap:spacing.xs, paddingHorizontal:spacing.sm, paddingVertical:spacing.xs },
  selectionActionText: { fontFamily:fontFamily.semibold, fontSize:fontSize.sm, color:colors.brandPrimary },
  selectionCount: { flex:1, textAlign:"center", fontFamily:fontFamily.semibold, fontSize:fontSize.sm, color:colors.muted },
  deleteSelectionAction: { flexDirection:"row", alignItems:"center", gap:spacing.xs, paddingHorizontal:spacing.sm, paddingVertical:spacing.xs },
  deleteSelectionText: { fontFamily:fontFamily.semibold, fontSize:fontSize.sm },
  patientSelectIndicator: { marginRight:spacing.sm },
  selectedCard: { borderWidth:2, borderColor:colors.brandPrimary },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  mrNo: { fontFamily: fontFamily.monoBold, fontSize: fontSize.base, color: colors.brandPrimary },
  date: { fontFamily: fontFamily.monoRegular, fontSize: fontSize.sm, color: colors.muted },
  nameRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.xs, marginBottom: spacing.sm },
  patientName: { flex: 1, fontFamily: fontFamily.bold, fontSize: fontSize.lg, color: colors.onSurface },
  opBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.brandPrimary,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  opBadgeText: { fontFamily: fontFamily.bold, fontSize: 10, color: "#FFF" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  chip: {
    backgroundColor: colors.brandTertiary,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    maxWidth: "100%",
  },
  chipText: { fontFamily: fontFamily.semibold, fontSize: fontSize.sm, color: colors.onBrandTertiary },
  implantRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs, marginTop: spacing.sm },
  implant: { fontFamily: fontFamily.regular, fontSize: fontSize.sm, color: colors.muted, flex: 1 },
  infectionRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md, marginTop: spacing.xs },
  infectionText: { fontFamily: fontFamily.regular, fontSize: fontSize.xs, color: colors.muted },
  fab: {
    position: "absolute",
    right: spacing.lg,
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: colors.brandPrimary,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: colors.brandPrimary,
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  reminder: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.brandTertiary,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  reminderIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.brandPrimary,
    alignItems: "center",
    justifyContent: "center",
  },
  reminderTitle: {
    fontFamily: fontFamily.bold,
    fontSize: fontSize.sm,
    color: colors.onBrandTertiary,
  },
  reminderSub: {
    fontFamily: fontFamily.regular,
    fontSize: fontSize.xs,
    color: colors.onBrandTertiary,
    opacity: 0.8,
    marginTop: 2,
  },
  reminderActions: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  reminderCta: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.brandPrimary,
  },
  reminderCtaText: {
    fontFamily: fontFamily.bold,
    fontSize: fontSize.sm,
    color: colors.onBrandPrimary,
  },
  reminderDismiss: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  pdfModalOverlay:{flex:1,backgroundColor:"rgba(15,23,42,0.45)",justifyContent:"flex-end"},
  pdfModalCard:{backgroundColor:colors.surface,borderTopLeftRadius:radius.lg,borderTopRightRadius:radius.lg,padding:spacing.lg,maxHeight:"92%"},
  pdfModalHeader:{flexDirection:"row",alignItems:"center",justifyContent:"space-between",marginBottom:spacing.md},
  pdfModalTitle:{fontFamily:fontFamily.bold,fontSize:fontSize.xl,color:colors.onSurface},
  pdfModalLabel:{fontFamily:fontFamily.semibold,fontSize:fontSize.sm,color:colors.onSurfaceSecondary,marginTop:spacing.md,marginBottom:spacing.sm},
  pdfDateInput:{borderWidth:1,borderColor:colors.border,borderRadius:radius.md,padding:spacing.md,color:colors.onSurface,backgroundColor:colors.surfaceSecondary,fontSize:fontSize.base},
  pdfDateRow:{gap:spacing.sm,paddingVertical:spacing.sm},
  pdfDateChip:{paddingHorizontal:spacing.md,paddingVertical:spacing.sm,borderRadius:radius.pill,borderWidth:1,borderColor:colors.border,backgroundColor:colors.surfaceSecondary},
  pdfDateChipActive:{backgroundColor:colors.brandPrimary,borderColor:colors.brandPrimary},
  pdfDateText:{fontFamily:fontFamily.semibold,fontSize:fontSize.sm,color:colors.muted},
  pdfDateTextActive:{color:colors.onBrandPrimary},
  pdfFieldList:{maxHeight:220,borderWidth:1,borderColor:colors.border,borderRadius:radius.md},
  pdfFieldRow:{flexDirection:"row",alignItems:"center",gap:spacing.sm,padding:spacing.md,borderBottomWidth:1,borderBottomColor:colors.divider},
  pdfFieldText:{fontFamily:fontFamily.medium,fontSize:fontSize.base,color:colors.onSurface},
  pdfFilterRow:{flexDirection:"row",gap:spacing.sm},
  pdfModalHint:{fontFamily:fontFamily.regular,fontSize:fontSize.xs,color:colors.muted,marginVertical:spacing.md,lineHeight:16},
}));
