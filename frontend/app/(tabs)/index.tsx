import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { triggerAutomaticDriveBackup } from "@/src/utils/storage/drive-auto-backup";
import { extractLabReportDate, isLikelyLabReportText, parseLabReportRows, recognizeLabText } from "@/src/utils/lab-ocr";
import {
  ActivityIndicator,
  Linking,
  Alert,
  DeviceEventEmitter,
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
import { deletePatientImagePdfFromDrive, ensurePatientImagePdfOnDrive } from "@/src/utils/storage/google-drive";

type LabScanStatus = {
  status: "not-scanned" | "queued" | "scanning" | "success" | "failed" | "stopped";
  message: string;
  reportDate?: string;
  resultCount?: number;
  updatedAt?: string;
};

const LAB_SCAN_STATUS_STORAGE_KEY = "ortho_lab_ocr_scan_states_v1";
const NEW_PATIENT_LAB_SCAN_QUEUE_KEY = "ortho_lab_ocr_new_patient_queue_v1";
const LAB_OCR_PIPELINE_VERSION = "row-aware-2026-10-17-v4-admin-aliases";

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
  createdAt?: string;
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

const LAB_OLD_RESULT_DAYS_KEY = "ortho_lab_old_result_days_v1";
function parseLabDate(value: string): Date | null {
  const text = String(value || "").trim();
  let iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:T.*)?$/.exec(text);
  if (iso) {
    // A date-only value is already a calendar date. For a timestamp (created_at),
    // convert the instant to the device's local calendar day before comparing days.
    let year = Number(iso[1]), month = Number(iso[2]) - 1, day = Number(iso[3]);
    if (text.length > 10) {
      const timestamp = new Date(text);
      if (Number.isNaN(timestamp.getTime())) return null;
      year = timestamp.getFullYear();
      month = timestamp.getMonth();
      day = timestamp.getDate();
    }
    const date = new Date(year, month, day);
    return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day ? date : null;
  }
  let m = /^(\d{1,2})[-/. ]([A-Za-z]{3})[-/. ](\d{4})$/.exec(text);
  if (m) {
    const months: Record<string, number> = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
    const month = months[m[2].toLowerCase()];
    if (month === undefined) return null;
    const date = new Date(Number(m[3]), month, Number(m[1]));
    return date.getFullYear() === Number(m[3]) && date.getMonth() === month && date.getDate() === Number(m[1]) ? date : null;
  }
  m = /^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{4})$/.exec(text);
  if (m) {
    const date = new Date(Number(m[3]), Number(m[2])-1, Number(m[1]));
    return date.getFullYear() === Number(m[3]) && date.getMonth() === Number(m[2])-1 && date.getDate() === Number(m[1]) ? date : null;
  }
  return null;
}
function normalizeLabDateInput(value: string): string | null {
  const date = parseLabDate(String(value || ""));
  if (!date) return null;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return String(date.getDate()).padStart(2, "0") + "-" + months[date.getMonth()] + "-" + date.getFullYear();
}

function oldLabResultLabels(patient: Patient, days: number): string[] {
  if (!Number.isFinite(days) || days < 1) return [];
  const addedDate = parseLabDate(String(patient.createdAt || patient.date || ""));
  if (!addedDate) return [];
  const addedDay = new Date(addedDate.getFullYear(), addedDate.getMonth(), addedDate.getDate()).getTime();
  const staleByTestResult = new Map<string, string>();
  let manual: any[] = [];
  let detected: any[] = [];
  try {
    const parsed = patient.customData?.labOcrManualResults ? JSON.parse(patient.customData.labOcrManualResults) : [];
    if (Array.isArray(parsed)) manual = parsed;
  } catch {}
  try {
    const parsed = patient.customData?.labOcrDetectedResults ? JSON.parse(patient.customData.labOcrDetectedResults) : [];
    if (Array.isArray(parsed)) detected = parsed;
  } catch {}
  const normalizeSavedResult = (value: unknown) => {
    const found = String(value ?? "").replace(/,/g, ".").match(/[-+]?\d+(?:\.\d+)?/);
    if (!found) return String(value ?? "").trim().toLowerCase();
    const n = Number(found[0]);
    return Number.isFinite(n) ? String(n) : found[0];
  };
  const normalizeTestKey = (value: unknown) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const resultKey = (testName: unknown, result: unknown, rawDate: unknown) =>
    normalizeTestKey(testName) + "|" + normalizeSavedResult(result) + "|"
      + (normalizeLabDateInput(String(rawDate || "")) || String(rawDate || "").trim().toLowerCase());
  const manualResultKeys = new Set(manual
    .filter(item => item && String(item.test || "").trim() && String(item.result ?? "").trim()
      && !!parseLabDate(String(item.date || item.reportDate || "")))
    .map(item => resultKey(item.test, item.result, item.date || item.reportDate))
    .filter(Boolean));
  const addIfOld = (testName: string, result: string, rawDate: string, unit = "") => {
    const test = String(testName || "").trim();
    const resultText = String(result || "").trim();
    if (!test || !resultText) return;
    const reportDate = parseLabDate(String(rawDate || "").trim());
    if (!reportDate) return;
    const reportDay = new Date(reportDate.getFullYear(), reportDate.getMonth(), reportDate.getDate()).getTime();
    const ageDays = Math.floor((addedDay - reportDay) / 86400000);
    if (ageDays < days) return;
    const key = resultKey(test, resultText, rawDate);
    if (!staleByTestResult.has(key)) {
      const formattedDate = normalizeLabDateInput(rawDate) || String(rawDate).trim();
      staleByTestResult.set(key, "OLD RESULT: " + test + " " + resultText
        + (String(unit || "").trim() ? " " + String(unit).trim() : "")
        + " · Report date " + formattedDate
        + " is " + ageDays + " days before patient was added");
    }
  };

  // Corrected/manual values have priority; rows without a usable manual date do not
  // suppress a dated OCR result for the same test and value.
  for (const item of manual) {
    if (!item || !String(item.test || "").trim() || !String(item.result ?? "").trim()) continue;
    addIfOld(String(item.test), String(item.result), String(item.date || item.reportDate || ""), String(item.unit || ""));
  }
  for (const item of detected) {
    if (!item || !String(item.test || "").trim() || !String(item.result ?? "").trim()) continue;
    if (manualResultKeys.has(resultKey(item.test, item.result, item.date || item.reportDate))) continue;
    addIfOld(String(item.test), String(item.result), String(item.date || item.reportDate || ""), String(item.unit || ""));
  }

  // Before structured rows were saved, only abnormal flags were retained. Keep
  // reading those old records, but don't parse the same result twice on newer scans.
  if (!detected.length) {
    const lines = String(patient.customData?.labOcrPossibleFlags || "").split(/\r?\n/).map(x => x.trim()).filter((date): date is string => typeof date === "string" && date.length > 0);
    for (const line of lines) {
      const dateMatch = line.match(/\|\s*Date\s*:\s*([^|]+)/i)
        || line.match(/\s·\s*DATE:\s*([^|]+)/i);
      if (!dateMatch) continue;
      const withoutStatus = line.replace(/^(?:WARNING|ALERT|HIGH|LOW)\s*:\s*/i, "");
      const withoutDate = withoutStatus.replace(/\|\s*Date\s*:\s*[^|]*/i, "").replace(/\s·\s*DATE:\s*[^|]*/i, "");
      const referenceMatch = /\|\s*Ref\s*:/i.exec(withoutDate);
      const testAndResult = (referenceMatch ? withoutDate.slice(0, referenceMatch.index) : withoutDate).trim();
      const resultMatch = /[-+]?\d+(?:[.,]\d+)?/.exec(testAndResult);
      if (!resultMatch || resultMatch.index === undefined) continue;
      const testName = testAndResult.slice(0, resultMatch.index).replace(/[\s:|•-]+$/g, "").trim();
      if (!testName) continue;
      addIfOld(testName, resultMatch[0], dateMatch[1].trim(), testAndResult.slice(resultMatch.index + resultMatch[0].length).trim());
    }
  }
  return [...staleByTestResult.values()].slice(0, 20);
}

function abnormalLabLabels(patient: Patient, automaticFlags?: string[], includeWarnings = true): string[] {
  const cachedFlags = Array.isArray(automaticFlags) ? automaticFlags : [];
  const persistedFlags = String(patient.customData?.labOcrPossibleFlags || "").split(/\r?\n/).map(value => value.trim()).filter((date): date is string => typeof date === "string" && date.length > 0);
  const canonicalFindingKey = (value: string) => value
    .replace(/\|\s*Date\s*:\s*[^|]+/ig, "")
    .replace(/\s·\s*DATE:\s*.+$/ig, "")
    .replace(/\|\s*Ref\s*:\s*/ig, " | Ref: ")
    .replace(/\s+/g, " ").trim().toLowerCase();
  const uniqueAutomatic = new Map<string, string>();
  for (const value of [...cachedFlags, ...persistedFlags]) {
    const key = canonicalFindingKey(value);
    if (key && !uniqueAutomatic.has(key)) uniqueAutomatic.set(key, value);
  }
  const saved = [...uniqueAutomatic.values()].join("\n").trim();
  let manual: any[] = [];
  try {
    const parsed = patient.customData?.labOcrManualResults ? JSON.parse(patient.customData.labOcrManualResults) : [];
    if (Array.isArray(parsed)) manual = parsed;
  } catch {}
  const normalizeTestKey = (value: unknown) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const normalizeFindingResult = (value: unknown) => {
    const parsed = Number(String(value ?? "").replace(",", ".").match(/[-+]?\d+(?:\.\d+)?/)?.[0]);
    return Number.isFinite(parsed) ? String(parsed) : String(value ?? "").trim().toLowerCase();
  };
  const manuallyVerifiedResults = new Set(manual
    .filter(item => item && String(item.test || "").trim() && String(item.result ?? "").trim())
    .map(item => normalizeTestKey(item.test) + "|" + normalizeFindingResult(item.result))
    .filter(Boolean));
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
    // A manually verified copy of this same test/result is authoritative over duplicate OCR dates.
    if (manuallyVerifiedResults.has(normalizeTestKey(test) + "|" + normalizeFindingResult(resultText))) continue;
    const unit = resultMatch ? core.slice(first + resultText.length).replace(/[|:;]/g, " ").replace(/\s+/g, " ").trim().slice(0, 12) : "";
    const label = status + ": " + test + (resultText ? " " + resultText : "") + (unit ? " " + unit : "") + (reference ? " (Ref " + reference + ")" : "") + (reportDate ? " · DATE: " + reportDate : "");
    if (!labels.includes(label) && (includeWarnings || status !== "WARNING")) labels.push(label);
  }

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
function labTestBranch(label: string, definitions: Array<{ name: string; aliases?: string; category?: string }>): string {
  const core = String(label || "").replace(/^(?:WARNING|ALERT|HIGH|LOW)\s*:\s*/i, "").replace(/^\[MANUAL\]\s*/i, "");
  const resultMatch = core.match(/[-+]?\d+(?:[.,]\d+)?/);
  const testName = (resultMatch && resultMatch.index !== undefined ? core.slice(0, resultMatch.index) : core).replace(/[\s:|•-]+$/g, "").trim();
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const testKey = normalize(testName);
  const fullKey = normalize(core);
  const definition = definitions.find(item => {
    const names = [item.name, ...(String(item.aliases || "").split(/[,;\\n]+/))].map(normalize).filter(Boolean);
    return names.some(name => fullKey.includes(name) || testKey === name || testKey.includes(name) || name.includes(testKey));
  });
  if (definition?.category?.trim()) return definition.category.trim();
  const value = testName.toLowerCase();
  if (/\b(?:hbsag|hcv|hepatitis|hiv)\b/.test(value)) return "Viral markers";
  if (/\b(?:hemoglobin|haemoglobin|hgb|hb|platelets?|wbc|rbc|mcv|mch|mchc|hct|pcv|esr|rdw|mpv|neutrophils|lymphocytes)\b/.test(value)) return "CBC / Hematology";
  if (/\b(?:alt|ast|sgpt|sgot|bilirubin|albumin|alp|ggt|liver)\b/.test(value)) return "LFT / Liver";
  if (/\b(?:creatinine|urea|bun|sodium|potassium|chloride|renal|calcium|uric acid)\b/.test(value)) return "RFT / Kidney & Electrolytes";
  if (/\b(?:glucose|sugar|fbs|rbs|hba1c|diabetes)\b/.test(value)) return "Diabetes";
  if (/\b(?:tsh|thyroid|t3|t4)\b/.test(value)) return "Thyroid";
  return "Other tests";
}
function cleanLabDisplayLabel(label: string): { visible: string; date: string } {
  const match = label.match(/\s· DATE:\s*(.+)$/i);
  return { visible: match ? label.slice(0, match.index) : label, date: match?.[1] || "" };
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
  const labOcrEnabledRef = useRef(false);
  const [labWarningsEnabled, setLabWarningsEnabled] = useState(true);
  const [labResultsHiddenByPatient, setLabResultsHiddenByPatient] = useState<Record<string, boolean>>({});
  const [labBranchesExpandedByPatient, setLabBranchesExpandedByPatient] = useState<Record<string, boolean>>({});
  const [configuredLabTestDefinitions, setConfiguredLabTestDefinitions] = useState<Array<{ name: string; aliases?: string; category?: string }>>([]);
  const [oldLabResultDays, setOldLabResultDays] = useState(10);
  const [labDateEditorOpenByPatient, setLabDateEditorOpenByPatient] = useState<Record<string, boolean>>({});
  const [labDateInputsByPatient, setLabDateInputsByPatient] = useState<Record<string, string>>({});
  const [labDateTargetsByPatient, setLabDateTargetsByPatient] = useState<Record<string, string>>({});
  const [labDateSavingByPatient, setLabDateSavingByPatient] = useState<Record<string, boolean>>({});
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
  const forceRetryLabScanIdsRef = useRef<Set<string>>(new Set());
  const requestLabScanRef = useRef<(patientId: string, autoForNewPatient?: boolean) => void>(() => {});

  useEffect(() => {
    const subscription = DeviceEventEmitter.addListener("ortho_lab_ocr_enabled_changed", (value: unknown) => {
      const enabled = value === true || value === "true";
      // Update the ref synchronously so an in-flight image loop stops before
      // starting the next OCR pass, even while Settings covers this screen.
      labOcrEnabledRef.current = enabled;
      setLabOcrEnabled(enabled);
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    AsyncStorage.getItem("ortho_lab_ocr_enabled").then(value => {
      const enabled = value === "true";
      labOcrEnabledRef.current = enabled;
      setLabOcrEnabled(enabled);
    }).catch(() => {
      labOcrEnabledRef.current = false;
      setLabOcrEnabled(false);
    });
    AsyncStorage.getItem("ortho_lab_warnings_enabled").then(value => setLabWarningsEnabled(value !== "false")).catch(() => setLabWarningsEnabled(true));
    AsyncStorage.getItem("ortho_lab_results_hidden_by_patient_v1").then(raw => { if (raw) { try { const parsed = JSON.parse(raw); if (parsed && typeof parsed === "object") setLabResultsHiddenByPatient(parsed); } catch {} } }).catch(() => {});
    AsyncStorage.getItem("ortho_lab_old_result_days_v1").then(raw => { const value = Number(raw); if (raw && Number.isInteger(value) && value >= 1 && value <= 3650) setOldLabResultDays(value); }).catch(() => {});
    AsyncStorage.getItem("ortho_lab_ocr_patient_cache_v7").then(raw => {
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") setLabFlagsByPatient(parsed);
      } catch {}
    }).catch(() => {});
  }, []);

  // Refresh admin-configured age threshold when the Logbook screen returns from Settings.
  useFocusEffect(useCallback(() => {
    let cancelled = false;
    // Settings is a separate screen; refresh this value on focus so disabling
    // auto-scan really pauses the still-mounted dashboard screen.
    AsyncStorage.getItem("ortho_lab_ocr_enabled").then(value => {
      if (cancelled) return;
      const enabled = value === "true";
      labOcrEnabledRef.current = enabled;
      setLabOcrEnabled(enabled);
    }).catch(() => {
      if (!cancelled) {
        labOcrEnabledRef.current = false;
        setLabOcrEnabled(false);
      }
    });
    AsyncStorage.getItem("ortho_lab_test_definitions_v1").then(raw => { if (!cancelled && raw) { try { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) setConfiguredLabTestDefinitions(parsed); } catch {} } }).catch(() => {});
    AsyncStorage.getItem(LAB_OLD_RESULT_DAYS_KEY).then(raw => {
      const value = Number(raw);
      if (!cancelled && raw && Number.isInteger(value) && value >= 1 && value <= 3650) setOldLabResultDays(value);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []));

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
    if (!labOcrEnabledRef.current) {
      saveLabScanState(patientId, { status: "stopped", message: "Automatic lab scanning is off. Enable it in Settings to resume.", updatedAt: new Date().toISOString() });
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
      const photos = [...new Set([...(patient.photos || []), ...((patient as any).photoUri ? [(patient as any).photoUri] : [])])].filter((date): date is string => typeof date === "string" && date.length > 0);
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
        // Read the current cache first, then migrate the older cache key if needed.
        let raw = await AsyncStorage.getItem("ortho_lab_ocr_photo_cache_v5");
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
      for (let offset = 0; offset < photos.length; offset += 1) {
        if (stopLabScansRef.current.has(patientId) || !labOcrEnabledRef.current) return;
        const batch = photos.slice(offset, offset + 1);
        const results = await Promise.all(batch.map(async uri => {
          const key = labPhotoCacheKey(uri);
          const cached = photoCache[key];
          if (!forceRetry && cached && cached.checkedAt && Date.now() - cached.checkedAt < 10 * 60 * 1000) {
            return { uri, ...cached };
          }
          try {
            const result = await recognizeLabText(uri, onlineOcrKey, configuredTests, patient?.gender || "");
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
        if (stopLabScansRef.current.has(patientId) || !labOcrEnabledRef.current) return;
        for (const result of results) {
          photoCache[labPhotoCacheKey(result.uri)] = {
            text: result.text, structuredText: result.structuredText, isReport: result.isReport,
            reportDate: result.reportDate || extractLabReportDate(result.text + "\n" + result.structuredText),
            checkedAt: result.checkedAt || Date.now(),
          };
        }
        await AsyncStorage.setItem("ortho_lab_ocr_photo_cache_v5", JSON.stringify(photoCache)).catch(() => {});
      }
      if (stopLabScansRef.current.has(patientId) || !labOcrEnabledRef.current) return;

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
            customData: { ...(patient.customData || {}), labOcrPossibleFlags: "", labOcrDetectedResults: "[]", labOcrDetectedAt: new Date().toISOString(), labOcrReportDate: "", labOcrPhotoSignature: photos.join("|"), labOcrPipelineVersion: LAB_OCR_PIPELINE_VERSION, labOcrDateNeedsAdmin: "false", labOcrDateManuallyConfirmed: "false" },
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

      const existingCustomData = patient.customData || {};
      // Only reuse a previously confirmed date when the saved photo set is unchanged.
      // Newly added photos must be scanned/confirmed independently.
      const previouslyConfirmedDate = existingCustomData.labOcrDateManuallyConfirmed === "true"
        && existingCustomData.labOcrPhotoSignature === photos.join("|")
        ? normalizeLabDateInput(String(existingCustomData.labOcrReportDate || ""))
        : null;
      const detectedPageDates = reportPages.map(page =>
        normalizeLabDateInput(page.reportDate || "") || normalizeLabDateInput(extractLabReportDate(page.text)) || ""
      );
      const effectivePageDates = detectedPageDates.map(date => date || previouslyConfirmedDate || "");
      const reportDateNeedsAdmin = effectivePageDates.some(date => !date);
      const distinctReportDates = [...new Set(effectivePageDates.filter(Boolean))];
      const reportDateSummary = distinctReportDates.length === 0 ? "Date not detected"
        : distinctReportDates.length > 1 ? "Multiple report dates — see each result"
        : distinctReportDates[0];
      const flags: string[] = [];
      const detectedResults: Array<{ test: string; result: string; unit: string; reference: string; severity: string; date: string }> = [];
      for (let pageIndex = 0; pageIndex < reportPages.length; pageIndex++) {
        const page = reportPages[pageIndex];
        const reportDate = effectivePageDates[pageIndex] || "";
        // Normal values can still be stale compared with when the patient was added.
        const parsedRows = parseLabReportRows(page.text, configuredTests, patient.gender, warningPercent, true);
        for (const row of parsedRows) {
          detectedResults.push({
            test: row.test, result: row.result, unit: row.unit, reference: row.reference,
            severity: row.severity, date: reportDate,
          });
          if (!row.severity) continue;
          flags.push(row.severity + ": " + row.test + " " + row.result +
            (row.unit ? " " + row.unit : "") +
            " | Date: " + (reportDate || "Date not detected") + " | Ref: " + row.reference);
        }
      }
      const uniqueFlags = flags.filter((flag, i, all) => all.indexOf(flag) === i).slice(0, 20);
      const uniqueDetectedResults = detectedResults
        .filter((row, index, all) => all.findIndex(other =>
          other.test.toLowerCase() === row.test.toLowerCase() &&
          other.result.replace(/,/g, ".") === row.result.replace(/,/g, ".") &&
          other.unit.toLowerCase() === row.unit.toLowerCase() &&
          other.date === row.date) === index)
        .slice(0, 200);
      const signature = LAB_OCR_PIPELINE_VERSION + "|" + photos.join("|") + "|gender:" + String(patient.gender || "") +
        "|ranges:" + configuredTests.map(item => [item.name,item.maleMin,item.maleMax,item.femaleMin,item.femaleMax,item.unit].join(":")).join(";");
      setLabFlagsByPatient(previous => ({ ...previous, [patientId]: { signature, flags: uniqueFlags, reportDate: reportDateSummary } }));
      try {
        const existingCustomData = patient.customData || {};
        const updated = await api.put("/patients/" + patientId, {
          ...patient,
          customData: {
            ...existingCustomData,
            labOcrPossibleFlags: uniqueFlags.join("\n"),
            labOcrDetectedResults: JSON.stringify(uniqueDetectedResults),
            labOcrPipelineVersion: LAB_OCR_PIPELINE_VERSION,
            labOcrPhotoSignature: photos.join("|"),
            labOcrDetectedAt: new Date().toISOString(),
            labOcrReportDate: reportDateSummary,
            labOcrDateNeedsAdmin: reportDateNeedsAdmin ? "true" : "false",
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
    // Keep new-patient OCR independent of dashboard focus so opening Settings,
    // patient details, or another in-app screen does not interrupt the queue.
    if (scanQueueRunningRef.current || !labOcrEnabledRef.current) return;
    scanQueueRunningRef.current = true;
    try {
      while (labOcrEnabledRef.current && pendingLabScansRef.current.length) {
        const patientId = pendingLabScansRef.current.shift()!;
        if (stopLabScansRef.current.has(patientId)) continue;
        activeLabScanRef.current = patientId;
        const forceRetry = forceRetryLabScanIdsRef.current.delete(patientId);
        await runOnePatientLabScan(patientId, forceRetry);
      }
    } finally {
      scanQueueRunningRef.current = false;
      if (labOcrEnabledRef.current && pendingLabScansRef.current.length) void drainLabScanQueue();
    }
  }, [runOnePatientLabScan]);

  const requestLabScan = useCallback((patientId: string, autoForNewPatient = false) => {
    if (!labOcrEnabledRef.current) return;
    stopLabScansRef.current.delete(patientId);
    if (runningLabScansRef.current.has(patientId) || pendingLabScansRef.current.includes(patientId)) return;
    if (autoForNewPatient) autoQueuedPatientIdsRef.current.add(patientId);
    else forceRetryLabScanIdsRef.current.add(patientId);
    pendingLabScansRef.current.push(patientId);
    saveLabScanState(patientId, { status: "queued", message: autoForNewPatient ? "Automatic scan: waiting to read saved lab photos…" : "Retry requested — waiting to scan this patient's photos…", updatedAt: new Date().toISOString() });
    void drainLabScanQueue();
  }, [drainLabScanQueue, saveLabScanState]);
  requestLabScanRef.current = requestLabScan;

  const stopLabScan = useCallback((patientId: string) => {
    stopLabScansRef.current.add(patientId);
    pendingLabScansRef.current = pendingLabScansRef.current.filter(id => id !== patientId);
    forceRetryLabScanIdsRef.current.delete(patientId);
    saveLabScanState(patientId, { status: "stopped", message: "Scan stopped by administrator. Tap Retry to continue.", updatedAt: new Date().toISOString() });
    void removeNewPatientQueueEntry(patientId);
  }, [removeNewPatientQueueEntry, saveLabScanState]);

  useEffect(() => {
    if (labOcrEnabled) {
      labOcrEnabledRef.current = true;
      return;
    }
    labOcrEnabledRef.current = false;
    // Drop in-memory work immediately; leave the saved new-patient queue intact
    // so it can resume when the administrator enables scanning again.
    for (const patientId of pendingLabScansRef.current.splice(0)) {
      autoQueuedPatientIdsRef.current.delete(patientId);
      forceRetryLabScanIdsRef.current.delete(patientId);
    }
    for (const patientId of runningLabScansRef.current) {
      stopLabScansRef.current.add(patientId);
      saveLabScanState(patientId, {
        status: "stopped",
        message: "Scan paused because automatic lab scanning is off.",
        updatedAt: new Date().toISOString(),
      });
    }
    if (activeLabScanRef.current) stopLabScansRef.current.add(activeLabScanRef.current);
  }, [labOcrEnabled, saveLabScanState]);

  useEffect(() => {
    if (!labScanStateLoaded || !labOcrEnabled || !labOcrEnabledRef.current || isLoading || !Array.isArray(data)) return;
    AsyncStorage.getItem(NEW_PATIENT_LAB_SCAN_QUEUE_KEY).then(raw => {
      let queuedIds: string[] = [];
      try { const parsed = raw ? JSON.parse(raw) : []; if (Array.isArray(parsed)) queuedIds = parsed.map(String); } catch {}
      const patientIds = new Set((data || []).map(patient => patient.id));
      for (const patientId of queuedIds) {
        if (!patientIds.has(patientId) || autoQueuedPatientIdsRef.current.has(patientId)) continue;
        requestLabScanRef.current(patientId, true);
      }

      // Upgrade existing records that were already scanned under the old parser.
      // They have a saved photo signature; rescan each once so the new row-aware
      // extractor replaces stale/manual-review-only results. The queue is serial.
      for (const patient of (data || []) as Patient[]) {
        const priorPhotoSignature = String(patient.customData?.labOcrPhotoSignature || "").trim();
        const currentVersion = String(patient.customData?.labOcrPipelineVersion || "");
        if (!priorPhotoSignature || currentVersion === LAB_OCR_PIPELINE_VERSION) continue;
        if (autoQueuedPatientIdsRef.current.has(patient.id) ||
            runningLabScansRef.current.has(patient.id) ||
            pendingLabScansRef.current.includes(patient.id)) continue;
        requestLabScanRef.current(patient.id, true);
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

  const openLabDateEditor = (patientId: string, initialDate: string, targetDate: string) => {
    setLabDateInputsByPatient(previous => ({ ...previous, [patientId]: initialDate }));
    setLabDateTargetsByPatient(previous => ({ ...previous, [patientId]: targetDate }));
    setLabDateEditorOpenByPatient(previous => ({ ...previous, [patientId]: true }));
  };

  const saveConfirmedLabDate = async (patientId: string) => {
    const confirmedDate = normalizeLabDateInput(labDateInputsByPatient[patientId] || "");
    if (!confirmedDate) {
      toast("Enter a valid report date, for example 06-Oct-2026.", "error");
      return;
    }
    setLabDateSavingByPatient(previous => ({ ...previous, [patientId]: true }));
    try {
      const fullPatient = await api.get<Patient>("/patients/" + patientId);
      if (!fullPatient?.id) throw new Error("Could not load the full patient record.");
      const customData = { ...(fullPatient.customData || {}) };
      const targetDate = normalizeLabDateInput(labDateTargetsByPatient[patientId] || "");
      const shouldReplaceDate = (rawDate: string) => {
        const oldDate = normalizeLabDateInput(rawDate);
        return !oldDate || (!!targetDate && oldDate === targetDate);
      };
      const updateFlagDate = (line: string) => {
        const pipeDate = /\|\s*Date\s*:\s*([^|]*)/i.exec(line);
        if (pipeDate) {
          if (!shouldReplaceDate(pipeDate[1].trim())) return line;
          return line.replace(pipeDate[0], "| Date: " + confirmedDate);
        }
        const suffixDate = /\s·\s*DATE:\s*([^|]*)/i.exec(line);
        if (suffixDate) {
          if (!shouldReplaceDate(suffixDate[1].trim())) return line;
          return line.replace(suffixDate[0], " · DATE: " + confirmedDate);
        }
        const ref = /\|\s*Ref\s*:/i.exec(line);
        return ref ? line.slice(0, ref.index) + "| Date: " + confirmedDate + " " + line.slice(ref.index)
          : line + " | Date: " + confirmedDate;
      };
      const updatedFlags = String(customData.labOcrPossibleFlags || "").split(/\r?\n/)
        .map(line => line.trim()).filter(Boolean).map(updateFlagDate);
      let savedManualResults: any[] = [];
      try {
        const parsed = customData.labOcrManualResults ? JSON.parse(customData.labOcrManualResults) : [];
        if (Array.isArray(parsed)) savedManualResults = parsed;
      } catch {}
      const updatedManualResults = savedManualResults.map(item => {
        if (!item || !String(item.test || "").trim() || !String(item.result ?? "").trim()) return item;
        const oldDate = String(item.date || item.reportDate || "").trim();
        if (!shouldReplaceDate(oldDate)) return item;
        return { ...item, date: confirmedDate, reportDate: confirmedDate };
      });
      let savedDetectedResults: any[] = [];
      try {
        const parsed = customData.labOcrDetectedResults ? JSON.parse(customData.labOcrDetectedResults) : [];
        if (Array.isArray(parsed)) savedDetectedResults = parsed;
      } catch {}
      const updatedDetectedResults = savedDetectedResults.map(item => {
        if (!item || !String(item.test || "").trim() || !String(item.result ?? "").trim()) return item;
        const oldDate = String(item.date || item.reportDate || "").trim();
        if (!shouldReplaceDate(oldDate)) return item;
        return { ...item, date: confirmedDate, reportDate: confirmedDate, dateManuallyVerified: true };
      });
      const dates = [
        ...updatedFlags.map(line => {
          const m = /\|\s*Date\s*:\s*([^|]+)/i.exec(line) || /\s·\s*DATE:\s*([^|]+)/i.exec(line);
          return m ? normalizeLabDateInput(m[1].trim()) : null;
        }),
        ...updatedManualResults.filter(item => item && String(item.test || "").trim() && String(item.result ?? "").trim())
          .map(item => normalizeLabDateInput(String(item.date || item.reportDate || ""))),
        ...updatedDetectedResults.filter(item => item && String(item.test || "").trim() && String(item.result ?? "").trim())
          .map(item => normalizeLabDateInput(String(item.date || item.reportDate || ""))),
      ].filter((date): date is string => !!date);
      const uniqueDates = [...new Set(dates)];
      const reportDateSummary = uniqueDates.length > 1 ? "Multiple report dates — see each result"
        : uniqueDates[0] || confirmedDate;
      const confirmedPhotoUris = [...new Set([
        ...(fullPatient.photos || []),
        ...((fullPatient as any).photoUri ? [(fullPatient as any).photoUri] : []),
      ])].filter((date): date is string => typeof date === "string" && date.length > 0);
      const updatedCustomData: Record<string, string> = {
        ...customData,
        labOcrPossibleFlags: updatedFlags.join("\n"),
        labOcrPhotoSignature: confirmedPhotoUris.join("|"),
        labOcrReportDate: reportDateSummary,
        labOcrDateNeedsAdmin: "false",
        labOcrDateManuallyConfirmed: "true",
        labOcrDateConfirmedAt: new Date().toISOString(),
      };
      if (savedManualResults.length) updatedCustomData.labOcrManualResults = JSON.stringify(updatedManualResults);
      if (savedDetectedResults.length) updatedCustomData.labOcrDetectedResults = JSON.stringify(updatedDetectedResults);
      await api.put("/patients/" + patientId, { ...fullPatient, customData: updatedCustomData });
      setLabFlagsByPatient(previous => ({
        ...previous,
        [patientId]: {
          ...(previous[patientId] || { signature: (fullPatient.photos || []).join("|") }),
          signature: previous[patientId]?.signature || (fullPatient.photos || []).join("|"),
          flags: updatedFlags,
          reportDate: reportDateSummary,
        },
      }));
      try {
        const raw = await AsyncStorage.getItem("ortho_lab_ocr_patient_cache_v7");
        const snapshot = raw ? JSON.parse(raw) : {};
        snapshot[patientId] = {
          ...(snapshot[patientId] || {}),
          signature: snapshot[patientId]?.signature || (fullPatient.photos || []).join("|"),
          flags: updatedFlags,
          reportDate: reportDateSummary,
        };
        await AsyncStorage.setItem("ortho_lab_ocr_patient_cache_v7", JSON.stringify(snapshot));
      } catch {}
      setLabDateInputsByPatient(previous => ({ ...previous, [patientId]: confirmedDate }));
      setLabDateEditorOpenByPatient(previous => ({ ...previous, [patientId]: false }));
      setLabDateTargetsByPatient(previous => ({ ...previous, [patientId]: confirmedDate }));
      queryClient.invalidateQueries({ queryKey: ["patients"] });
      toast("Lab report date confirmed: " + confirmedDate + ".", "success");
    } catch (error: any) {
      toast(error?.message || "Could not save the confirmed report date.", "error");
    } finally {
      setLabDateSavingByPatient(previous => ({ ...previous, [patientId]: false }));
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
              let pdfCleanupFailures = 0;
              for (const patientId of idsToDelete) {
                try { await deletePatientImagePdfFromDrive(String(patientId)); }
                catch { pdfCleanupFailures++; }
              }
              if (pdfCleanupFailures) {
                Alert.alert("Patient records deleted", "The selected records were moved to Trash, but " + pdfCleanupFailures + " Drive patient PDF(s) could not be deleted. Reconnect Google Drive and retry the PDF cleanup.");
              }
              await Promise.allSettled(idsToDelete.map(patientId => deletePatientImagePdfFromDrive(String(patientId))));
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
              testID="report-problem-button"
              accessibilityLabel="Report a Problem"
              onPress={() => router.push("/report-problem")}
              style={styles.iconBtn}
              hitSlop={8}
            >
              <Ionicons name="bug-outline" size={22} color={colors.onSurfaceSecondary} />
            </Pressable>
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
          // Keep the visible patient list responsive on lower-memory Android
          // phones. The default render window can mount many expensive lab
          // result cards at once; smaller batches reduce JS/UI thread stalls.
          initialNumToRender={6}
          maxToRenderPerBatch={5}
          updateCellsBatchingPeriod={40}
          windowSize={7}
          removeClippedSubviews={true}
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
              {(
                <Pressable
                  accessibilityRole="button"
                  testID={`patient-image-pdf-${item.id}`
                  onPress={async (event: any) => {
                    event?.stopPropagation?.();
                    try {
                      const result = await ensurePatientImagePdfOnDrive(String(item.id));
                      await Linking.openURL(result.url);
                    } catch (error: any) {
                      Alert.alert("Could not open patient PDF", String(error?.message || "Please check the Google Drive connection and try again."));
                    }
                  }}
                  style={{ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: spacing.xs, marginTop: spacing.sm, paddingVertical: spacing.xs, paddingHorizontal: spacing.sm, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border }}
                >
                  <Ionicons name="document-attach-outline" size={16} color={colors.brandPrimary} />
                  <Text style={{ fontFamily: fontFamily.semibold, fontSize: fontSize.xs, color: colors.brandPrimary }}>Open patient image PDF in Drive</Text>
                </Pressable>
              )}
              {infectionResults(item).length ? (
                <View style={styles.infectionRow}>
                  {infectionResults(item).map(label => <Text key={label} style={styles.infectionText}>{label}</Text>)}
                </View>
              ) : null}
              {(() => {
                const labLabels = abnormalLabLabels(item, labFlagsByPatient[item.id]?.flags, labWarningsEnabled);
                const oldResultLabels = oldLabResultLabels(item, oldLabResultDays);
                const persistedReportDate = String(item.customData?.labOcrReportDate || "").trim();
                const persistedScanAt = String(item.customData?.labOcrDetectedAt || "").trim();
                const status: LabScanStatus = labScanStates[item.id] || (persistedScanAt
                  ? { status: "success", message: "", reportDate: persistedReportDate, updatedAt: persistedScanAt }
                  : { status: "not-scanned", message: "", reportDate: "", updatedAt: "" });
                const hidden = labResultsHiddenByPatient[item.id] === true;
                const allDisplayLabLabels = [...labLabels, ...oldResultLabels];
                const datesFromDisplayedResults = allDisplayLabLabels
                  .map(label => {
                    const matched = label.match(/\s· DATE:\s*(.+)$/i)?.[1]?.trim()
                      || label.match(/Report date\s+(\d{1,2}-[A-Za-z]{3}-\d{4})/i)?.[1]?.trim() || "";
                    return normalizeLabDateInput(matched) || "";
                  })
                  .filter(Boolean) as string[];
                let automaticReportDates: string[] = [];
                try {
                  const parsed = item.customData?.labOcrDetectedResults ? JSON.parse(item.customData.labOcrDetectedResults) : [];
                  if (Array.isArray(parsed)) automaticReportDates = parsed
                    .map((row: any) => normalizeLabDateInput(String(row?.date || row?.reportDate || "")) || "")
                    .filter((date): date is string => typeof date === "string" && date.length > 0);
                } catch {}
                let manualReportDates: string[] = [];
                try {
                  const parsed = item.customData?.labOcrManualResults ? JSON.parse(item.customData.labOcrManualResults) : [];
                  if (Array.isArray(parsed)) manualReportDates = parsed
                    .map((row: any) => normalizeLabDateInput(String(row?.date || row?.reportDate || "")) || "")
                    .filter((date): date is string => typeof date === "string" && date.length > 0);
                } catch {}
                const uniquePerResultDates = [...new Set([...datesFromDisplayedResults, ...automaticReportDates, ...manualReportDates])];
                const summaryDate = normalizeLabDateInput(persistedReportDate)
                  || normalizeLabDateInput(status.reportDate || "") || "";
                const reportDateDisplay = uniquePerResultDates.length ? uniquePerResultDates.join(", ") : summaryDate;
                const automaticResultLines = String(item.customData?.labOcrPossibleFlags || "").split(/\r?\n/).map(line => line.trim()).filter((date): date is string => typeof date === "string" && date.length > 0);
                const hasUndatedAutomaticResult = automaticResultLines.some(line => {
                  const match = line.match(/\|\s*Date\s*:\s*([^|]+)/i) || line.match(/\s·\s*DATE:\s*([^|]+)/i);
                  return !!match && !normalizeLabDateInput(match[1].trim());
                });
                let savedManualRows: any[] = [];
                try {
                  const parsed = item.customData?.labOcrManualResults ? JSON.parse(item.customData.labOcrManualResults) : [];
                  if (Array.isArray(parsed)) savedManualRows = parsed;
                } catch {}
                const hasUndatedManualResult = savedManualRows.some(row =>
                  row && String(row.test || "").trim() && String(row.result ?? "").trim()
                  && !normalizeLabDateInput(String(row.date || row.reportDate || ""))
                );
                let savedDetectedRows: any[] = [];
                try {
                  const parsed = item.customData?.labOcrDetectedResults ? JSON.parse(item.customData.labOcrDetectedResults) : [];
                  if (Array.isArray(parsed)) savedDetectedRows = parsed;
                } catch {}
                const hasUndatedDetectedResult = savedDetectedRows.some(row =>
                  row && String(row.test || "").trim() && String(row.result ?? "").trim()
                  && !normalizeLabDateInput(String(row.date || row.reportDate || ""))
                );
                const dateNeedsAdmin = item.customData?.labOcrDateNeedsAdmin === "true"
                  || hasUndatedAutomaticResult || hasUndatedManualResult || hasUndatedDetectedResult
                  || (!reportDateDisplay && status.status === "success" && item.customData?.labOcrDateManuallyConfirmed !== "true"
                    && !/^multiple report dates — see each result$/i.test(persistedReportDate));
                const hasAlert = !hidden && (labLabels.some(label => label.startsWith("ALERT:")) || oldResultLabels.length > 0);
                const hasWarning = !hidden && labLabels.some(label => label.startsWith("WARNING:"));
                const tone = hasAlert ? (colors.error || "#B91C1C") : hasWarning ? (colors.warning || "#B7791F")
                  : status.status === "failed" ? (colors.error || "#B91C1C")
                  : status.status === "success" ? "#15803D" : colors.brandPrimary;
                const statusLabel = status.status === "queued" ? "WAITING"
                  : status.status === "scanning" ? "SCANNING"
                  : status.status === "success" ? "SUCCESS"
                  : status.status === "failed" ? "FAILED"
                  : status.status === "stopped" ? "STOPPED" : "NOT SCANNED";
                const canStop = status.status === "queued" || status.status === "scanning";
                const defaultDate = dateNeedsAdmin ? "" : (uniquePerResultDates.length === 1 ? uniquePerResultDates[0] : summaryDate);
                const targetDate = dateNeedsAdmin ? "" : (normalizeLabDateInput(defaultDate || "") || "");
                const editorOpen = labDateEditorOpenByPatient[item.id] === true;
                return <View style={{ marginTop: spacing.xs, paddingVertical: 5, paddingHorizontal: 6, borderRadius: radius.sm, borderWidth: 1, borderColor: tone, backgroundColor: tone + "10" }}>
                  <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 5 }}>
                    {status.status === "scanning" || status.status === "queued"
                      ? <ActivityIndicator size="small" color={tone} />
                      : <Ionicons name={hasAlert ? "alert-circle" : hasWarning ? "warning" : status.status === "success" ? "checkmark-circle" : status.status === "failed" ? "close-circle" : status.status === "stopped" ? "pause-circle" : "flask-outline"} size={14} color={tone} />}
                    <Text style={{ color: tone, fontFamily: fontFamily.bold, fontSize: 10 }}>
                      {hidden ? "LAB RESULTS HIDDEN · " + statusLabel : oldResultLabels.length ? "OLD LAB RESULT" : hasAlert ? "LAB ALERT" : hasWarning ? "LAB WARNING" : "LAB SCAN · " + statusLabel}
                    </Text>
                    {user?.role === "admin" ? (canStop
                      ? <Pressable onPress={event => { event.stopPropagation(); stopLabScan(item.id); }} hitSlop={8} style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 5, borderWidth: 1, borderColor: tone }}><Text style={{ color: tone, fontFamily: fontFamily.semibold, fontSize: 10 }}>Stop</Text></Pressable>
                      : <Pressable onPress={event => { event.stopPropagation(); requestLabScan(item.id, false); }} hitSlop={8} style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 5, borderWidth: 1, borderColor: tone }}><Text style={{ color: tone, fontFamily: fontFamily.semibold, fontSize: 10 }}>Retry</Text></Pressable>) : null}
                    {allDisplayLabLabels.length || reportDateDisplay || dateNeedsAdmin ? <Pressable onPress={event => { event.stopPropagation(); void toggleLabResultsHidden(item.id); }} hitSlop={8} accessibilityLabel={hidden ? "Show this patient's lab results" : "Hide this patient's lab results"} style={{ flexDirection: "row", alignItems: "center", gap: 3, paddingHorizontal: 4, paddingVertical: 2 }}>
                      <Ionicons name={hidden ? "eye-outline" : "eye-off-outline"} size={14} color={tone} />
                      <Text style={{ color: tone, fontFamily: fontFamily.semibold, fontSize: 10 }}>{hidden ? "Show" : "Hide"}</Text>
                    </Pressable> : null}
                  </View>
                  {!hidden ? <>
                    {dateNeedsAdmin ? <View style={{ marginTop: 4, flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 5 }}>
                      <Text style={{ color: colors.warning || "#B7791F", fontFamily: fontFamily.semibold, fontSize: 10 }}>REPORT DATE NEEDS ADMIN CONFIRMATION</Text>
                      {user?.role === "admin" ? <Pressable onPress={event => {
                        event.stopPropagation();
                        openLabDateEditor(item.id, "", "");
                      }} hitSlop={6} style={{ paddingHorizontal: 7, paddingVertical: 3, borderWidth: 1, borderColor: colors.warning || "#B7791F", borderRadius: 5 }}>
                        <Text style={{ color: colors.warning || "#B7791F", fontFamily: fontFamily.semibold, fontSize: 10 }}>Enter date</Text>
                      </Pressable> : <Text style={{ color: colors.muted, fontSize: 10 }}>Ask an administrator.</Text>}
                    </View> : reportDateDisplay ? <View style={{ marginTop: 3, flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <Text testID={"lab-report-date-" + item.id} style={{ color: colors.muted, fontSize: 10 }}>Report date: {reportDateDisplay}</Text>
                      {user?.role === "admin" && uniquePerResultDates.length === 1 ? <Pressable onPress={event => {
                        event.stopPropagation();
                        openLabDateEditor(item.id, uniquePerResultDates[0], uniquePerResultDates[0]);
                      }} hitSlop={6}><Text style={{ color: colors.brandPrimary, fontSize: 10, fontFamily: fontFamily.semibold }}>Edit date</Text></Pressable> : null}
                    </View> : null}
                    {editorOpen && user?.role === "admin" ? <View style={{ marginTop: 5, flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 5 }}>
                      <TextInput value={labDateInputsByPatient[item.id] || ""} onChangeText={value => setLabDateInputsByPatient(previous => ({ ...previous, [item.id]: value }))}
                        placeholder="DD-MMM-YYYY e.g. 06-Oct-2026" placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false}
                        style={{ flex: 1, minWidth: 150, borderWidth: 1, borderColor: colors.border, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 6, color: colors.onSurface, fontSize: 12 }} />
                      <Pressable disabled={labDateSavingByPatient[item.id] === true} onPress={event => { event.stopPropagation(); void saveConfirmedLabDate(item.id); }} style={{ backgroundColor: colors.brandPrimary, borderRadius: 6, paddingHorizontal: 9, paddingVertical: 7, opacity: labDateSavingByPatient[item.id] ? 0.6 : 1 }}>
                        <Text style={{ color: colors.onBrandPrimary, fontSize: 10, fontFamily: fontFamily.semibold }}>{labDateSavingByPatient[item.id] ? "Saving…" : "Save date"}</Text>
                      </Pressable>
                      <Pressable onPress={event => { event.stopPropagation(); setLabDateEditorOpenByPatient(previous => ({ ...previous, [item.id]: false })); }} style={{ paddingHorizontal: 6, paddingVertical: 6 }}>
                        <Text style={{ color: colors.muted, fontSize: 10 }}>Cancel</Text>
                      </Pressable>
                    </View> : null}
                    {allDisplayLabLabels.length ? (() => {
                      const oldLabels = allDisplayLabLabels.filter(label => label.startsWith("OLD RESULT:"));
                      const abnormalLabels = allDisplayLabLabels.filter(label => !label.startsWith("OLD RESULT:"));
                      const groups = new Map<string, string[]>();
                      for (const label of abnormalLabels) {
                        const branch = labTestBranch(label, configuredLabTestDefinitions);
                        groups.set(branch, [...(groups.get(branch) || []), label]);
                      }
                      const renderLabel = (label: string, index: number) => {
                        const warning = label.startsWith("WARNING:");
                        const oldResult = label.startsWith("OLD RESULT:");
                        const labelTone = oldResult ? (colors.error || "#B91C1C") : warning ? (colors.warning || "#B7791F") : (colors.error || "#B91C1C");
                        const cleaned = cleanLabDisplayLabel(label);
                        const compactLabel = cleaned.visible.length > 92 ? cleaned.visible.slice(0, 89) + "…" : cleaned.visible;
                        return <Text key={label + index} numberOfLines={2} style={{ color: labelTone, fontFamily: fontFamily.semibold, fontSize: 10, lineHeight: 13, flexShrink: 1 }}>{compactLabel}{cleaned.date ? " · " + cleaned.date : ""}</Text>;
                      };
                      return <View style={{ marginTop: 3, gap: 5 }}>
                        {[...groups.entries()].map(([branch, labels]) => {
                          const branchKey = item.id + "::" + branch;
                          const branchExpanded = labBranchesExpandedByPatient[branchKey] === true;
                          return <View key={branch} style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 5, overflow: "hidden" }}>
                            <Pressable onPress={event => { event.stopPropagation(); setLabBranchesExpandedByPatient(previous => ({ ...previous, [branchKey]: !previous[branchKey] })); }} accessibilityRole="button" accessibilityLabel={(branchExpanded ? "Collapse " : "Expand ") + branch + " abnormal lab results"} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 7, paddingVertical: 5, backgroundColor: colors.surface }}>
                              <Text style={{ color: colors.error || "#B91C1C", fontFamily: fontFamily.semibold, fontSize: 10, flex: 1 }}>{branch} · {labels.length} out of range</Text>
                              <Ionicons name={branchExpanded ? "chevron-up" : "chevron-down"} size={14} color={colors.muted} />
                            </Pressable>
                            {branchExpanded ? <View style={{ paddingHorizontal: 7, paddingVertical: 5, gap: 4 }}>{labels.map(renderLabel)}</View> : null}
                          </View>;
                        })}
                        {oldLabels.length ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>{oldLabels.map(renderLabel)}</View> : null}
                      </View>;
                    })() : null}
                  </> : null}
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
