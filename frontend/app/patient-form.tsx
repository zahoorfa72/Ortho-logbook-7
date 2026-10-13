import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import * as CameraPermissions from "expo-camera";
import { CameraView } from "expo-camera";
import * as ImageManipulator from "expo-image-manipulator";
import { Asset, requestPermissionsAsync } from "expo-media-library";
import * as FileSystem from "expo-file-system/legacy";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { hasKnownLabTestName, isLabMetadataLine, isLikelyLabReportText, parseLabReportRows, recognizeLabText } from "@/src/utils/lab-ocr";
import { Dimensions } from "react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AppState, Image, InteractionManager, Modal, Pressable, ScrollView, Text, View } from "react-native";
import Ionicons from "@react-native-vector-icons/ionicons";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api } from "@/src/api/client";
import { checkAndSendImmediateLowStockAlerts } from "@/src/utils/low-stock-auto-report";
import { useAuth } from "@/src/auth/AuthContext";
import { AutocompleteField, type Suggestion } from "@/src/components/AutocompleteField";
import { Field } from "@/src/components/Field";
import { PrimaryButton } from "@/src/components/PrimaryButton";
import { Segmented } from "@/src/components/Segmented";
import { useToast } from "@/src/components/toast";
import { formatInventoryLabel } from "@/src/utils/inventory-label";
import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";

type Patient = {
  id: string; mrNo: string; name: string; gender: string; age: string;
  diagnosis: string; procedure: string; procedureII?: string; implant: string; implantII: string; implants?: SelectedImplant[];
  address: string; fileName: string; photoUri: string; photos: string[]; date: string;
  operationCount?: number; totalOperations?: number; customData?: Record<string,string>;
  hcvPlus?: boolean; hbaSg?: boolean; hiv?: boolean;
};
type Procedure = { id: string; name: string };
type InventoryItem = { id: string; name: string; category: string; categoryId?: string; size: string; quantity: number };
type SelectedImplant = { id: string; inventoryId: string; name: string; category: string; size: string; quantity: number };

const today = () => new Date().toISOString().slice(0, 10);

function detectPositiveScreening(text: string): { hcvPlus: boolean; hbaSg: boolean; hiv: boolean } {
  const found = { hcvPlus: false, hbaSg: false, hiv: false };
  const lines = String(text || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (const line of lines) {
    const cells = line.includes("|") ? line.split("|").map(cell => cell.trim()) : [];
    const candidates = cells.length >= 2 ? [cells[0] + " " + cells[1]] : [line];
    for (const candidate of candidates) {
      const name = candidate.match(/\b(?:hbsag|hba\s*sg|hepatitis\s*b\s*surface\s*antigen|hcv(?:\s*(?:antibody|ab|antigen))?|hepatitis\s*c(?:\s*(?:antibody|ab))?|hiv(?:\s*(?:1\s*\/?\s*2)?\s*(?:antibody|ab|screen))?)\b/i)?.[0] || "";
      if (!name) continue;
      const resultPart = cells.length >= 2 ? cells[1] : candidate.slice(candidate.toLowerCase().indexOf(name.toLowerCase()) + name.length);
      if (/\b(?:negative|non[\s-]?reactive|not\s+detected|non[\s-]?detected|absent|normal)\b/i.test(resultPart)) continue;
      const positive = /\b(?:positive|reactive|detected|presumptive\s+positive|pos\.?)\b/i.test(resultPart);
      if (!positive) continue;
      if (/\b(?:hbsag|hba\s*sg|hepatitis\s*b\s*surface\s*antigen)\b/i.test(name)) found.hbaSg = true;
      else if (/\b(?:hcv|hepatitis\s*c)\b/i.test(name)) found.hcvPlus = true;
      else if (/\bhiv\b/i.test(name)) found.hiv = true;
    }
  }
  return found;
}
const empty = (): Patient => ({
  id: "", mrNo: "", name: "", gender: "", age: "", diagnosis: "",
  procedure: "", procedureII: "", implant: "", implantII: "", address: "", fileName: "",
  photoUri: "", photos: [], date: today(), implants: [], customData: {},
  hcvPlus: false, hbaSg: false, hiv: false,
});

export default function PatientForm() {
  const styles = useStyles();
  const { colors, branding } = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const qc = useQueryClient();
  const { user } = useAuth();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const isEdit = !!id;
  const [implantSearch, setImplantSearch] = useState("");

  const { data: patients } = useQuery<Patient[]>({ queryKey: ["patients"], queryFn: () => api.get("/patients") });
  const { data: procedures } = useQuery<Procedure[]>({ queryKey: ["procedures"], queryFn: () => api.get("/procedures") });
  const { data: customFields = [] } = useQuery<any[]>({
    queryKey: ["patient-custom-fields"],
    queryFn: () => api.get("/patient-custom-fields"),
  });
  const { data: inventory = [] } = useQuery<InventoryItem[]>({
    queryKey: ["inventory", "patient-search", implantSearch.trim().toLowerCase()],
    queryFn: () => api.get("/inventory?q=" + encodeURIComponent(implantSearch.trim())),
    enabled: implantSearch.trim().length > 0,
    staleTime: 10000,
  });
  const existing = useMemo(() => (id ? patients?.find((p) => p.id === id) : undefined), [id, patients]);
  const { data: detailedExisting } = useQuery<Patient | null>({
    queryKey: ["patient-detail", id],
    queryFn: () => api.get("/patients/" + encodeURIComponent(String(id))),
    enabled: isEdit && !!id,
  });

  // Type-ahead sources: procedure catalogue + any procedure names used on past
  // records; implants come from inventory only (saving validates stock).
  const procedureSuggestions = useMemo<Suggestion[]>(() => {
    const byLower = new Map<string, string>();
    for (const x of procedures ?? []) {
      const n = x.name?.trim();
      if (n) byLower.set(n.toLowerCase(), n);
    }
    for (const pt of patients ?? []) {
      const n = pt.procedure?.trim();
      if (n && !byLower.has(n.toLowerCase())) byLower.set(n.toLowerCase(), n);
      const n2 = (pt as any).procedureII?.trim();
      if (n2 && !byLower.has(n2.toLowerCase())) byLower.set(n2.toLowerCase(), n2);
    }
    return [...byLower.values()]
      .sort((a, b) => a.localeCompare(b))
      .map((n) => ({ key: n.toLowerCase(), label: n }));
  }, [procedures, patients]);

  const [selectedPhoto, setSelectedPhoto] = useState<string | null>(null);
  const [labOcrEnabled, setLabOcrEnabled] = useState(false);
  const [labOcrBusy, setLabOcrBusy] = useState(false);
  const [labOcrText, setLabOcrText] = useState("");
  const [labOcrFindings, setLabOcrFindings] = useState<string[]>([]);
  const [labManualReviews, setLabManualReviews] = useState<Array<{ test: string; unit: string; result: string; reference: string; photoUri: string; min?: number; max?: number }>>([]);
  const [labWarningsEnabled, setLabWarningsEnabled] = useState(true);
  const [labWarningThreshold, setLabWarningThreshold] = useState(10);
  const [showLabRawText, setShowLabRawText] = useState(false);
  const [labOcrOnlineHelp, setLabOcrOnlineHelp] = useState<string[]>([]);
  const screenWidth = Dimensions.get("window").width;
  const [editingPhotoIndex, setEditingPhotoIndex] = useState<number | null>(null);
  const [editingPhotoOriginal, setEditingPhotoOriginal] = useState<string | null>(null);
  const [editingPhotoUri, setEditingPhotoUri] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [imagePickerReady, setImagePickerReady] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraTaking, setCameraTaking] = useState(false);
  const cameraRef = useRef<any>(null);
  const [cameraPermission, requestCameraPermission] = CameraPermissions.useCameraPermissions();
  const imagePickerOpening = useRef(false);
  const imagePickerReadyRef = useRef(false);
  const appStateRef = useRef(AppState.currentState);
  const [cropScale, setCropScale] = useState(0.78);
  const [cropX, setCropX] = useState(0.5);
  const [cropY, setCropY] = useState(0.5);
  const [p, setP] = useState<Patient>(empty);
  const allViewerPhotos = [...new Set(p.photos)];
  const [dismissedTrashMatchId, setDismissedTrashMatchId] = useState<string | null>(null);
  const selectedImplants = p.implants || [];

  useEffect(() => {
    AsyncStorage.getItem("ortho_lab_ocr_enabled").then(value => setLabOcrEnabled(value === "true")).catch(() => setLabOcrEnabled(false));
    AsyncStorage.getItem("ortho_lab_warnings_enabled").then(value => setLabWarningsEnabled(value !== "false")).catch(() => setLabWarningsEnabled(true));
    AsyncStorage.getItem("ortho_lab_warning_threshold_percent_v1").then(value => { const n = Number(value); if (value && Number.isInteger(n) && n >= 1 && n <= 100) setLabWarningThreshold(n); }).catch(() => setLabWarningThreshold(10));
  }, []);

  const analyzeLabPhotos = async (photoUris: string[] = [...new Set(p.photos)], automatic = false) => {
    if (!labOcrEnabled || !photoUris.length || labOcrBusy) return;
    setLabOcrBusy(true);
    try {
      let configuredLabTests: import("@/src/utils/lab-ocr").LabTestDefinition[] = [];
      try { const savedTests = await AsyncStorage.getItem("ortho_lab_test_definitions_v1"); if (savedTests) configuredLabTests = JSON.parse(savedTests); } catch {}
      const pages: string[] = [];
      const recognizedPhotoUris: string[] = [];
      let onlineOcrKey = "";
      try { onlineOcrKey = (await AsyncStorage.getItem("ortho_lab_online_ocr_api_key_v1")) || ""; } catch {}
      for (let i = 0; i < photoUris.length; i++) {
        try {
          const result = await recognizeLabText(photoUris[i], onlineOcrKey);
          const text = String(result?.text || "").trim();
          const structuredText = result?.mode === "online" ? "" : String(result?.structuredText || "").trim();
          // Prefer rows reconstructed from OCR bounding-box positions. Keep the
          // original OCR text too, so the admin can verify any uncertain mapping.
          // Unknown rows remain review-only; the parser never guesses a test name.
          const recognizedRows = text && isLikelyLabReportText(text, configuredLabTests);
          const labCues = /\b(?:laboratory|lab report|investigation|test name|test results?|reference range|normal range|biological reference|specimen|result|units?)\b/i.test(text);
          const numericContent = /[-+]?\d+(?:[.,]\d+)?/.test(text);
          if (text && (recognizedRows || (labCues && numericContent))) {
            pages.push("LAB REPORT IMAGE " + (i + 1) + "\n" +
              (structuredText ? "RECONSTRUCTED TABLE ROWS (test | result | unit | reference range)\n" + structuredText + "\n" : "") +
              "RAW OCR TEXT FOR REVIEW\n" + text);
            recognizedPhotoUris.push(photoUris[i]);
          }
        } catch {
          // Continue scanning other pictures; a single damaged/unavailable image
          // must not prevent readable pages from being checked.
        }
      }
      const extracted = pages.join("\n\n");
      if (!extracted.trim()) {
        setLabOcrText("");
        setLabOcrFindings([]);
        if (automatic) toast("Lab text could not be read from the saved photos. Retake the lab report clearly; no abnormality can be confirmed.", "info");
        else toast("No readable text found. Retake the report in good light with the full page in focus.", "error");
        return;
      }
      const parsedRows = parseLabReportRows(extracted, configuredLabTests, p.gender, labWarningThreshold);
      const reviewSourcePhotos = [...new Set(recognizedPhotoUris)];
      const canonical = (value: string) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
      const isHemoglobin = (value: string) => ["hemoglobin", "haemoglobin", "hgb", "hb"].includes(canonical(value));
      const configuredCandidates = configuredLabTests.map(item => ({
        name: String(item.name || "").trim(), unit: String(item.unit || ""),
        min: /^\s*(?:m|male|man|men)\s*$/i.test(p.gender) ? item.maleMin : item.femaleMin,
        max: /^\s*(?:m|male|man|men)\s*$/i.test(p.gender) ? item.maleMax : item.femaleMax
      }));
      const commonCandidates = [
        { name: "Hemoglobin", unit: "g/dL" }, { name: "Haemoglobin", unit: "g/dL" },
        { name: "HGB", unit: "g/dL" }, { name: "HB", unit: "g/dL" },
        { name: "Hematocrit", unit: "%" }, { name: "RBC", unit: "x10^6 cells/uL" },
        { name: "WBC", unit: "x10^3 cells/uL" }, { name: "Platelets", unit: "x10^3 cells/uL" },
        { name: "MCV", unit: "fL" }, { name: "MCH", unit: "pg" }, { name: "MCHC", unit: "g/dL" },
        { name: "Neutrophils", unit: "%" }, { name: "Lymphocytes", unit: "%" },
        { name: "Creatinine", unit: "mg/dL" }, { name: "Glucose", unit: "mg/dL" }
      ].map(item => ({ ...item, min: "", max: "" }));
      const testCandidates = [...configuredCandidates, ...commonCandidates].filter((item, index, all) =>
        item.name && all.findIndex(other => canonical(other.name) === canonical(item.name) ||
          (isHemoglobin(other.name) && isHemoglobin(item.name))) === index
      );
      const rawOnly = extracted;
      const rawLines = rawOnly.split(/\r?\n/);
      const missingResultReviews = testCandidates.filter(test => {
        const aliases = isHemoglobin(test.name) ? ["hemoglobin", "haemoglobin", "hgb", "hb"] : [test.name];
        const aliasSeen = (line: string) => aliases.some(alias => canonical(line).includes(canonical(alias)));
        const matchingParsed = parsedRows.find(row => canonical(row.test) === canonical(test.name) ||
          (isHemoglobin(row.test) && isHemoglobin(test.name)));
        const parsedValue = matchingParsed ? Number(String(matchingParsed.result).replace(",", ".")) : NaN;
        const min = Number(String(test.min ?? "").replace(",", "."));
        const max = Number(String(test.max ?? "").replace(",", "."));
        const hasRange = String(test.min ?? "").trim() !== "" && String(test.max ?? "").trim() !== "" && Number.isFinite(min) && Number.isFinite(max) && min > 0 && max > min;
        // Look at the test row and the next line because OCR often separates a circled result
        // from its label. Strip the reference-range section before deciding if a value was read.
        let resultValue: number | null = null;
        for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex++) {
          if (!aliasSeen(rawLines[lineIndex])) continue;
          const nearby = [rawLines[lineIndex], rawLines[lineIndex + 1] || ""].join(" | ");
          const beforeReference = nearby.split(/(?:reference\s*range|normal\s*range|biological\s*reference|ref(?:erence)?\s*range|male\s*:|female\s*:|(?:^|\s)[mf]\s*:)/i)[0];
          const afterTest = beforeReference.replace(new RegExp(aliases.map(alias => canonical(alias)).join("|"), "i"), "");
          const numbers = [...afterTest.matchAll(/(?:^|[|:\s(])([<>≤≥]?\s*\d+(?:[.,]\d+)?)/g)]
            .map(match => Number(String(match[1]).replace(/[<>≤≥\s]/g, "").replace(",", ".")))
            .filter(value => Number.isFinite(value));
          if (numbers.length) { resultValue = numbers[0]; break; }
        }
        const suspiciousScale = (matchingParsed && hasRange && Number.isFinite(parsedValue) &&
          (parsedValue > max * 3 || parsedValue < min / 3)) ||
          (resultValue !== null && hasRange && (resultValue > max * 3 || resultValue < min / 3));
        const hasReadableResult = resultValue !== null || Number.isFinite(parsedValue);
        const alreadyParsed = hasReadableResult && !suspiciousScale;
        return rawLines.some(aliasSeen) && (!alreadyParsed || suspiciousScale);
      }).map(test => {
        const min = Number(String(test.min ?? "").replace(",", "."));
        const max = Number(String(test.max ?? "").replace(",", "."));
        const validRange = String(test.min ?? "").trim() !== "" && String(test.max ?? "").trim() !== "" && Number.isFinite(min) && Number.isFinite(max);
        const range = validRange ? String(test.min) + "–" + String(test.max) : "";
        return { test: test.name, unit: test.unit || "", result: "", reference: range, photoUri: reviewSourcePhotos[0] || "", min: validRange ? min : undefined, max: validRange ? max : undefined };
      });
      const candidates: string[] = parsedRows
        .filter(row => row.severity === "ALERT" || labWarningsEnabled)
        .map(row => row.severity + ": " + row.test + " " + row.result + (row.unit ? " " + row.unit : "") + " | Ref: " + row.reference);
      const uncertain: string[] = [];
      const seenReviewLines = new Set<string>();
      // Only generate review suggestions from reconstructed table rows. Raw OCR
      // includes headings, reference ranges, and normal rows, so scanning every
      // raw line produced false "could not match" warnings even for clear reports.
      for (const page of extracted.split(/(?=LAB REPORT IMAGE\\s+\\d+)/i)) {
        const marker = "RECONSTRUCTED TABLE ROWS (test | result | unit | reference range)";
        const rawMarker = "RAW OCR TEXT FOR REVIEW";
        const at = page.indexOf(marker);
        const rawAt = page.indexOf(rawMarker);
        if (at < 0) continue;
        const section = page.slice(at + marker.length, rawAt >= 0 ? rawAt : undefined);
        for (const rawLine of section.split(/\\r?\\n/)) {
          const line = rawLine.replace(/\\s+/g, " ").trim();
          if (!line || !line.includes("|")) continue;
          const cells = line.split("|").map(cell => cell.trim());
          if (cells.length < 2 || !/[a-z]{2,}/i.test(cells[0])) continue;
          const knownTest = hasKnownLabTestName(cells[0], configuredLabTests);
          const resultLooksNumeric = /^\\s*[<>≤≥]?\\s*[-+]?\\d+(?:[.,]\\d+)?(?:\\s|$)/.test(cells[1] || "");
          let reason = "";
          // Ignore header/logo noise that OCR mistakenly placed in the test-name
          // column (e.g. "SASINS") when that row has no numeric patient result.
          // Keep warnings when an unknown name is paired with an actual result.
          if (!knownTest && resultLooksNumeric) {
            reason = "Check test name (OCR may have misread it)";
          } else if (knownTest && !resultLooksNumeric) {
            reason = "Check result (OCR could not read a clear numeric value)";
          } else if (knownTest && resultLooksNumeric) {
            const testName = cells[0];
            const saved = configuredLabTests.find(item => item.name.toLowerCase() === testName.toLowerCase()) ||
              configuredLabTests.find(item => testName.toLowerCase().startsWith(item.name.toLowerCase()));
            const sex = /^\\s*(?:m|male|man|men)\\s*$/i.test(p.gender) ? "male" :
              /^\\s*(?:f|female|woman|women)\\s*$/i.test(p.gender) ? "female" : "";
            const savedRangeExists = !!saved && !!sex &&
              String(sex === "male" ? saved.maleMin : saved.femaleMin).trim() !== "" &&
              String(sex === "male" ? saved.maleMax : saved.femaleMax).trim() !== "";
            const reportRangeExists = /[-+]?\\d+(?:[.,]\\d+)?\\s*(?:-|–|—|\\bto\\b)\\s*[-+]?\\d+(?:[.,]\\d+)?/i.test(cells.slice(3).join(" "));
            if (!reportRangeExists && !savedRangeExists) reason = "Check reference range (not readable and no saved range is available for this patient's sex)";
          }
          if (reason && !seenReviewLines.has(line.toLowerCase())) {
            seenReviewLines.add(line.toLowerCase());
            uncertain.push(reason + ": " + line);
          }
        }
      }
      // Lab analysis is deliberately offline-only. Uncertain rows are shown for
      // human review; the app never guesses a test name or uploads OCR text.
      const onlineHelp: string[] = [];
      setShowLabRawText(false);
      setLabOcrText(extracted);
      setLabManualReviews(missingResultReviews);
      setLabOcrFindings([...candidates, ...uncertain.map(item => "REVIEW: " + item),
        ...missingResultReviews.map(item => "REVIEW: " + item.test + " result not confidently recognized — admin must verify against the original report")]);
      setLabOcrOnlineHelp(onlineHelp);
      const positiveScreening = detectPositiveScreening(extracted);
      setP(prev => ({
        ...prev,
        hcvPlus: prev.hcvPlus || positiveScreening.hcvPlus,
        hbaSg: prev.hbaSg || positiveScreening.hbaSg,
        hiv: prev.hiv || positiveScreening.hiv,
        customData: { ...(prev.customData || {}), labOcrExtractedText: extracted, labOcrPossibleFlags: candidates.join("\n"), labOcrNeedsReview: uncertain.join("\n"), labOcrOnlineTestNameHelp: onlineHelp.join("\n") },
      }));
      const newlyTicked = [
        positiveScreening.hcvPlus && !p.hcvPlus ? "HCV+" : "",
        positiveScreening.hbaSg && !p.hbaSg ? "HbAsg" : "",
        positiveScreening.hiv && !p.hiv ? "HIV" : "",
      ].filter(Boolean);
      if (newlyTicked.length) toast("Positive lab result detected; screening checkbox ticked for review: " + newlyTicked.join(", "), "info");
      const alertCandidates = candidates.filter(row => row.startsWith("ALERT:"));
      if (alertCandidates.length && automatic && isEdit && id && ready) {
        // Show a lab warning only when opening an existing patient's detail.
        // Limit to two alerts per patient per local calendar day.
        const now = new Date();
        const dayKey = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
        const storageKey = "ortho_lab_alert_daily_counts_v1";
        try {
          const rawCounts = await AsyncStorage.getItem(storageKey);
          const counts = rawCounts ? JSON.parse(rawCounts) : {};
          const patientDayKey = String(id) + ":" + dayKey;
          const shown = Number(counts?.[patientDayKey] || 0);
          if (shown < 2) {
            counts[patientDayKey] = shown + 1;
            await AsyncStorage.setItem(storageKey, JSON.stringify(counts));
            Alert.alert(
              "Possible abnormal lab result",
              "Results to verify for " + (p.name || "this patient") + ":\n\n" + alertCandidates.join("\n") + "\n\nCompare each result, unit and reference range with the original report and clinical guidance."
            );
          }
        } catch {
          // If local rate-limit storage is unavailable, avoid repeated popups.
        }
      } else if (uncertain.length && automatic) {
        toast("Some test rows could not be matched confidently to a reference range. Check the extracted report text below; no abnormality was assumed.", "info");
      }
    } catch (e: any) {
      if (!automatic) toast(e?.message || "Could not read lab photos on this device.", "error");
    } finally { setLabOcrBusy(false); }
  };

  const { data: trashedPatientMatch, isFetching: checkingTrashMatch } = useQuery<{
    id: string; title: string; deleted_at: string; expires_at: string; patient: { mrNo: string; name: string };
  } | null>({
    queryKey: ["trash-patient-match", p.mrNo.trim().toLocaleLowerCase(), p.name.trim().toLocaleLowerCase()],
    queryFn: () => api.get("/trash/patient-match?mrNo=" + encodeURIComponent(p.mrNo.trim()) + "&name=" + encodeURIComponent(p.name.trim())),
    enabled: !isEdit && user?.role === "admin" && !!p.mrNo.trim() && !!p.name.trim(),
    staleTime: 0,
    retry: false,
  });
  const addImplant = (item: InventoryItem) => {
    setP(prev => {
      const current = prev.implants || [];
      const existingIndex = current.findIndex(x => x.inventoryId === item.id);
      if (existingIndex >= 0) {
        const next = [...current];
        next[existingIndex] = { ...next[existingIndex], quantity: next[existingIndex].quantity + 1 };
        return { ...prev, implants: next };
      }
      return {
        ...prev,
        implants: [...current, { id: `pi-${Date.now()}-${Math.random().toString(36).slice(2,7)}`, inventoryId:item.id, name:item.name, category:item.category, size:item.size, quantity:1 }],
        implant: "",
        implantId: undefined as any,
      };
    });
    setImplantSearch("");
  };
  const removeImplant = (id: string) => setP(prev => ({ ...prev, implants:(prev.implants || []).filter(x => x.id !== id) }));
  const changeImplantQty = (id: string, delta: number) => setP(prev => ({
    ...prev,
    implants:(prev.implants || []).map(x => x.id === id ? { ...x, quantity:Math.max(1,x.quantity + delta) } : x),
  }));
  const [ready, setReady] = useState(false);
  const lastAutoLabScan = useRef("");
  useEffect(() => {
    if (!labOcrEnabled || labOcrBusy) return;
    // Inspect only pictures already saved in this patient's file; the OCR
    // classifier excludes ordinary clinical photos from lab-result parsing.
    const uris = [...new Set(p.photos)].filter(Boolean);
    if (!uris.length || (isEdit && !ready)) return;
    const signature = uris.join("|");
    if (lastAutoLabScan.current === signature) return;
    lastAutoLabScan.current = signature;
    const timer = setTimeout(() => { void analyzeLabPhotos(uris, true); }, 500);
    return () => clearTimeout(timer);
  }, [labOcrEnabled, labOcrBusy, p.photos, ready, isEdit]);
  useEffect(() => {
    const source = isEdit ? detailedExisting : existing;
    if (!source) return;
    // Normalise legacy records that only had photoUri.
    const photos = Array.isArray(source.photos) && source.photos.length
      ? source.photos
      : source.photoUri ? [source.photoUri] : [];
    const customData = source.customData || {};
    setP({ ...source, photos, customData });
    setReady(true);
  }, [isEdit, detailedExisting, existing]);

  // Duplicate-tracking: for the current draft, how many earlier records share
  // the same trimmed lowercased name + MR number? This is only for the header
  // badge preview so users know they're about to log a repeat operation.
  const duplicate = useMemo(() => {
    const rawName = p.name.trim().toLowerCase();
    const rawMr = p.mrNo.trim().toLowerCase();
    if (!rawName || !rawMr || !patients?.length) return null;
    const matches = patients.filter(
      (x) =>
        x.id !== p.id &&
        x.name.trim().toLowerCase() === rawName &&
        x.mrNo.trim().toLowerCase() === rawMr,
    );
    if (!matches.length) return null;
    // If editing an existing record we prefer the computed operation count on the list.
    if (isEdit && existing?.operationCount && (existing.totalOperations || 0) > 1) {
      return { current: existing.operationCount, total: existing.totalOperations || matches.length + 1 };
    }
    return { current: matches.length + 1, total: matches.length + 1 };
  }, [p.name, p.mrNo, p.id, patients, isEdit, existing]);

  const ordinal = (n: number) => {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };

  const set = (key: keyof Patient) => (v: any) => setP((x) => ({ ...x, [key]: v }));

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      appStateRef.current = nextState;
      if (nextState !== "active") {
        imagePickerReadyRef.current = false;
        setImagePickerReady(false);
        return;
      }
      // Wait until Android has resumed the host Activity before allowing a
      // native picker launch after a permission dialog or app switch.
      setTimeout(() => {
        if (appStateRef.current === "active") {
          imagePickerReadyRef.current = true;
          setImagePickerReady(true);
        }
      }, 800);
    });
    return () => subscription.remove();
  }, []);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      imagePickerReadyRef.current = false;
      setImagePickerReady(false);

      const timer = setTimeout(() => {
        if (!cancelled && appStateRef.current === "active") {
          imagePickerReadyRef.current = true;
          setImagePickerReady(true);
        }
      }, 800);
      return () => {
        cancelled = true;
        clearTimeout(timer);
        imagePickerOpening.current = false;
        imagePickerReadyRef.current = false;
        setImagePickerReady(false);
      };
    }, []),
  );

  async function waitForImagePickerActivity() {
    // Read refs, not React state captured by an old async closure. The old
    // implementation could retry immediately or wait forever after a state
    // update because it read a stale imagePickerReady value.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (appStateRef.current === "active" && imagePickerReadyRef.current) return true;
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
    }
    return false;
  }

  async function rearmImagePickerAfterLauncherError() {
    imagePickerReadyRef.current = false;
    setImagePickerReady(false);
    // Let Android finish ActivityResultRegistry lifecycle restoration before
    // retrying. Only re-arm when the app is genuinely active again.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (appStateRef.current === "active") {
        await new Promise<void>((resolve) => setTimeout(resolve, 900));
        if (appStateRef.current === "active") {
          imagePickerReadyRef.current = true;
          setImagePickerReady(true);
          return true;
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
    }
    return false;
  }

  const isUnregisteredLauncherError = (error: any) => {
    const message = String(error?.message || error || "").toLowerCase();
    return message.includes("unregistered activityresult launcher") ||
      message.includes("must ensure the activityresult launcher is registered");
  };

  async function ensureLibraryPermission() {
    const perm = await ImagePicker.getMediaLibraryPermissionsAsync();
    if (perm.granted) return true;
    if (!perm.canAskAgain) {
      toast("Photo permission is blocked. Enable it from Settings.", "error");
      return false;
    }
    const req = await ImagePicker.requestMediaLibraryPermissionsAsync();
    return req.granted;
  }

  async function ensureCameraPermission() {
    let perm = cameraPermission;
    if (!perm?.granted) {
      if (perm && !perm.canAskAgain) {
        toast("Camera permission is blocked. Enable it from Settings.", "error");
        return false;
      }
      perm = await requestCameraPermission();
    }
    if (!perm.granted) toast("Camera permission is required to take a patient photo.", "error");
    return !!perm.granted;
  }

  // Keep a private, permanent copy inside the app. Gallery/camera URIs can
  // point to temporary cache/content-provider locations that stop working later.
  // We copy/normalize every newly added photo immediately so the saved patient
  // record never depends on the gallery app or a temporary URI.
  const persistPhoto = async (sourceUri: string) => {
    if (!sourceUri || sourceUri.startsWith("data:")) return sourceUri;
    const directory = `${FileSystem.documentDirectory}patient-photos/`;
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true }).catch(() => {});
    // Keep patient photos sharp enough for clinical reference, while avoiding
    // full-resolution camera files bloating the offline database and Drive backups.
    const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
      Image.getSize(sourceUri, (width, height) => resolve({ width, height }), reject);
    });
    const actions: any[] = [];
    if (dimensions.width > 2200 || dimensions.height > 2200) {
      actions.push(dimensions.width >= dimensions.height
        ? { resize: { width: 2200 } }
        : { resize: { height: 2200 } });
    }
    const normalized = await ImageManipulator.manipulateAsync(
      sourceUri,
      actions,
      { compress: 0.84, format: ImageManipulator.SaveFormat.JPEG },
    );
    const filename = `patient-photo-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.jpg`;
    const destination = `${directory}${filename}`;
    await FileSystem.copyAsync({ from: normalized.uri, to: destination });
    return destination;
  };

  // No cropping (allowsEditing:false). Library allows multi-select.
  const addFromLibrary = async () => {
    if (!imagePickerReady || imagePickerOpening.current) return;
    imagePickerOpening.current = true;
    try {
      await new Promise<void>((resolve) => InteractionManager.runAfterInteractions(() => setTimeout(resolve, 120)));
      if (!(await waitForImagePickerActivity())) {
        toast("Photo picker is still starting. Please try again in a moment.", "error");
        return;
      }

      let result: ImagePicker.ImagePickerResult;
      try {
        result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ["images"], allowsEditing: false, allowsMultipleSelection: true,
          selectionLimit: 20, quality: 0.9,
        });
      } catch (firstError: any) {
        // Android can recreate the Activity while the JS screen is still
        // mounted. In that narrow window Expo's launcher is temporarily
        // unregistered. Re-arm the screen and retry once after the Activity
        // has had time to register the launcher again.
        if (!isUnregisteredLauncherError(firstError)) throw firstError;
        if (!(await rearmImagePickerAfterLauncherError())) {
          throw firstError;
        }
        result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ["images"], allowsEditing: false, allowsMultipleSelection: true,
          selectionLimit: 20, quality: 0.9,
        });
      }
      if (result.canceled) return;
      const permanentUris: string[] = [];
      for (const uri of result.assets.map((x) => x.uri).filter(Boolean)) permanentUris.push(await persistPhoto(uri));
      setP((x) => ({ ...x, photos: [...x.photos, ...permanentUris] }));
    } catch (e: any) { toast(e?.message || "Could not save the selected photo.", "error"); }
    finally { imagePickerOpening.current = false; }
  };

  const addFromCamera = async () => {
    // Use an in-app CameraView rather than launching an external camera Activity.
    // This avoids Android's ActivityResultLauncher registration failure.
    if (photoBusy || cameraOpen || imagePickerOpening.current) return;
    imagePickerOpening.current = true;
    try {
      if (!(await ensureCameraPermission())) return;
      setCameraReady(false);
      setCameraOpen(true);
    } catch (e: any) {
      toast(e?.message || "Could not open the camera.", "error");
    } finally {
      imagePickerOpening.current = false;
    }
  };

  const capturePatientPhoto = async () => {
    if (!cameraRef.current || !cameraReady || cameraTaking) return;
    setCameraTaking(true);
    try {
      const result = await cameraRef.current.takePictureAsync({ quality: 0.9 });
      if (!result?.uri) throw new Error("The camera did not return a photo.");
      const permanentUri = await persistPhoto(result.uri);
      setP((x) => ({ ...x, photos: [...x.photos, permanentUri] }));
      toast("Photo added. Take another photo or tap Done.", "success");
    } catch (e: any) {
      toast(e?.message || "Could not save the camera photo.", "error");
    } finally {
      setCameraTaking(false);
    }
  };

  const savePhotoToDevice = async (uri: string) => {
    if (!uri) return;
    setPhotoBusy(true);
    try {
      let localUri = uri;
      if (uri.startsWith("data:image/")) {
        const match = uri.match(/^data:image\/[^;]+;base64,(.+)$/);
        if (!match?.[1]) throw new Error("Invalid patient photo.");
        const directory = `${FileSystem.cacheDirectory}patient-photo-export/`;
        await FileSystem.makeDirectoryAsync(directory, { intermediates: true }).catch(() => {});
        localUri = `${directory}patient-photo-${Date.now()}.jpg`;
        await FileSystem.writeAsStringAsync(localUri, match[1], { encoding: FileSystem.EncodingType.Base64 });
      }
      const permission = await requestPermissionsAsync(true, ["photo"]);
      if (!permission.granted) {
        toast("Photo permission is required to save the picture to your device.", "error");
        return;
      }
      await Asset.create(localUri);
      toast("Patient photo saved to your device.", "success");
    } catch (e: any) {
      toast(e?.message || "Could not save the patient photo.", "error");
    } finally {
      setPhotoBusy(false);
    }
  };

  const removePhoto = (idx: number) => {
    setP((x) => ({ ...x, photos: x.photos.filter((_, i) => i !== idx) }));
  };
  const openPhotoEditor = (idx: number) => {
    const uri = p.photos[idx];
    if (!uri) return;
    setSelectedPhoto(null);
    setEditingPhotoIndex(idx);
    setEditingPhotoOriginal(uri);
    setEditingPhotoUri(uri);
    setCropScale(0.78);
    setCropX(0.5);
    setCropY(0.5);
  };

  const closePhotoEditor = () => {
    if (photoBusy) return;
    setEditingPhotoIndex(null);
    setEditingPhotoOriginal(null);
    setEditingPhotoUri(null);
    setCropScale(0.78);
    setCropX(0.5);
    setCropY(0.5);
  };

  const editPhoto = async (action: "rotate" | "crop") => {
    if (!editingPhotoUri) return;
    setPhotoBusy(true);
    try {
      let actions: any[] = [];
      if (action === "rotate") {
        actions = [{ rotate: 90 }];
      } else {
        const size = await new Promise<{ width: number; height: number }>((resolve, reject) =>
          Image.getSize(editingPhotoUri, (width, height) => resolve({ width, height }), reject),
        );
        const side = Math.max(1, Math.round(Math.min(size.width, size.height) * cropScale));
        const maxX = Math.max(0, size.width - side);
        const maxY = Math.max(0, size.height - side);
        actions = [{
          crop: {
            originX: Math.max(0, Math.min(maxX, Math.round(maxX * cropX))),
            originY: Math.max(0, Math.min(maxY, Math.round(maxY * cropY))),
            width: side,
            height: side,
          },
        }];
      }
      const result = await ImageManipulator.manipulateAsync(editingPhotoUri, actions, {
        compress: 0.9,
        format: ImageManipulator.SaveFormat.JPEG,
      });
      setEditingPhotoUri(result.uri);
      if (action === "crop") {
        setCropScale(0.78);
        setCropX(0.5);
        setCropY(0.5);
      }
    } catch (e: any) {
      toast(e?.message || "Could not edit photo.", "error");
    } finally {
      setPhotoBusy(false);
    }
  };

  const resetPhotoEdits = () => {
    if (photoBusy || !editingPhotoOriginal) return;
    setEditingPhotoUri(editingPhotoOriginal);
    setCropScale(0.78);
    setCropX(0.5);
    setCropY(0.5);
  };

  const savePhotoEdits = async () => {
    if (editingPhotoIndex === null || !editingPhotoUri) return;
    setPhotoBusy(true);
    try {
      const permanent = await persistPhoto(editingPhotoUri);
      setP((x) => ({
        ...x,
        photos: x.photos.map((v, i) => i === editingPhotoIndex ? permanent : v),
      }));
      toast("Photo changes saved.", "success");
      closePhotoEditor();
    } catch (e: any) {
      toast(e?.message || "Could not save photo changes.", "error");
    } finally {
      setPhotoBusy(false);
    }
  };

  const save = useMutation({
    mutationFn: () => {
      const customData = {
        ...(p.customData || {}),
        hcvPlus: p.hcvPlus ? "true" : "false",
        hbaSg: p.hbaSg ? "true" : "false",
        hiv: p.hiv ? "true" : "false",
      };
      const payload = { ...p, customData };
      return isEdit ? api.put("/patients/" + id, payload) : api.post("/patients", payload);
    },
    onSuccess: () => {
      void checkAndSendImmediateLowStockAlerts().catch(() => {});
      qc.invalidateQueries({ queryKey: ["patients"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
      toast(isEdit ? "Record updated." : "Patient saved.", "success");
      router.back();
    },
    onError: (e: any) => toast(e?.message || "Could not save record.", "error"),
  });

  const restoreDeletedPatient = useMutation({
    mutationFn: () => {
      if (!trashedPatientMatch?.id) throw new Error("No matching deleted patient was found.");
      return api.post("/trash/restore-patient", { id: trashedPatientMatch.id, patientDate: today() });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["patients"] });
      qc.invalidateQueries({ queryKey: ["trash"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
      qc.invalidateQueries({ queryKey: ["patient-history"] });
      qc.invalidateQueries({ queryKey: ["trash-patient-match"] });
      toast("Deleted patient restored with today's date and all saved details.", "success");
      router.back();
    },
    onError: (e: any) => toast(e?.message || "Could not restore the deleted patient.", "error"),
  });

  const del = useMutation({
    mutationFn: () => api.del("/patients/" + id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["patients"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
      toast("Record deleted.", "success");
      router.back();
    },
    onError: (e: any) => toast(e?.message || "Could not delete.", "error"),
  });

  const canEdit = !!user?.canEditPatients || user?.role === "admin";
  const onSave = () => {
    if (!canEdit && isEdit) { toast("You do not have permission to edit patient records.", "error"); return; }
    if (!p.name.trim() && !p.mrNo.trim()) { toast("Enter at least an MRNo or patient name.", "error"); return; }
    save.mutate();
  };

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={() => router.back()} style={styles.headerBtn}>
          <Ionicons name="close" size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>{isEdit ? "Edit Patient" : "New Patient"}</Text>
        {isEdit && canEdit ? (
          <Pressable testID="delete-patient-button" onPress={() => Alert.alert(
            "Move patient to Trash?",
            "This patient and its saved details will be moved to Trash for 30 days. You can restore it from Settings → Trash before it expires.",
            [{ text: "Cancel", style: "cancel" }, { text: "Move to Trash", style: "destructive", onPress: () => del.mutate() }],
          )} style={styles.headerBtn}>
            <Ionicons name="trash-outline" size={22} color={colors.error} />
          </Pressable>
        ) : (
          <View style={styles.headerBtn} />
        )}
      </View>

      <KeyboardAwareScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxxl }}
        bottomOffset={100}
        keyboardShouldPersistTaps="handled"
      >
        <Modal
          visible={!isEdit && !!trashedPatientMatch?.id && dismissedTrashMatchId !== trashedPatientMatch.id}
          transparent
          animationType="fade"
          onRequestClose={() => setDismissedTrashMatchId(trashedPatientMatch?.id || null)}
        >
          <View style={styles.restorePatientOverlay} testID="matching-trash-patient-banner">
            <View style={styles.restorePatientDialog}>
              <View style={styles.restorePatientDialogHeader}>
                <Ionicons name="person-circle-outline" size={34} color={colors.brandPrimary} />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Dismiss patient restore suggestion"
                  onPress={() => setDismissedTrashMatchId(trashedPatientMatch?.id || null)}
                  hitSlop={10}
                >
                  <Ionicons name="close" size={24} color={colors.muted} />
                </Pressable>
              </View>
              <View style={styles.restorePatientCopy}>
                <Text style={styles.restorePatientTitle}>Matching patient found in Trash</Text>
                <Text style={styles.restorePatientText}>
                  MR {trashedPatientMatch?.patient.mrNo} · {trashedPatientMatch?.patient.name}
                </Text>
                <Text style={styles.restorePatientText}>
                  Restore all saved details and photos. Only the patient date will be changed to today.
                </Text>
              </View>
              <PrimaryButton
                title={restoreDeletedPatient.isPending ? "Restoring…" : "Restore patient"}
                onPress={() => Alert.alert(
                  "Restore deleted patient?",
                  "All saved patient details, photos, procedures and linked records will be restored. The patient date will be set to today.",
                  [{ text: "Cancel", style: "cancel" }, { text: "Restore", onPress: () => restoreDeletedPatient.mutate() }],
                )}
                disabled={restoreDeletedPatient.isPending}
                testID="restore-matching-trash-patient"
              />
            </View>
          </View>
        </Modal>
        {duplicate ? (
          <View style={styles.duplicateBanner} testID="duplicate-banner">
            <Ionicons name="repeat" size={20} color={colors.onWarning} />
            <Text style={styles.duplicateText}>
              {isEdit ? "This is the " : "Will be logged as the "}
              <Text style={styles.duplicateStrong}>{ordinal(duplicate.current)} time</Text>
              {" operated for "}
              <Text style={styles.duplicateStrong} numberOfLines={1}>{p.name.trim()}</Text>
              {" (MR "}
              <Text style={styles.duplicateStrong}>{p.mrNo.trim()}</Text>
              {")."}
            </Text>
          </View>
        ) : null}
        <Text style={styles.section}>Patient photos</Text>
        <View style={styles.photoActions}>
          <PrimaryButton title={`Add from Gallery${p.photos.length ? " (+)" : ""}`} onPress={addFromLibrary} disabled={!imagePickerReady || photoBusy} testID="add-photo-library-button" />
          <Pressable style={[styles.secondary, (!imagePickerReady || photoBusy) && { opacity: 0.5 }]} onPress={addFromCamera} disabled={photoBusy || cameraOpen} testID="add-photo-camera-button">
            <Ionicons name="camera" size={18} color={colors.onSurface} />
            <Text style={styles.secondaryText}> Take Photo</Text>
          </Pressable>
        </View>
        {p.photos.length === 0 ? (
          <View style={styles.photoPlaceholder}>
            <Ionicons name="images-outline" size={38} color={colors.muted} />
            <Text style={styles.hint}>No photos yet. Add uncropped full-size photos.</Text>
          </View>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.photoStrip}>
            {p.photos.map((uri, idx) => (
              <View key={`${uri}-${idx}`} style={styles.photoBox} testID={`patient-photo-${idx}`}>
                <Pressable style={{ flex: 1 }} onPress={() => setSelectedPhoto(uri)} testID={`open-patient-photo-${idx}`}>
                  <Image source={{ uri }} style={styles.photoThumb} resizeMode="cover" />
                </Pressable>
                <Pressable style={styles.photoRemove} onPress={() => removePhoto(idx)} hitSlop={8} testID={`remove-photo-${idx}`}>
                  <Ionicons name="close" size={16} color="#FFFFFF" />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        )}

        <Modal visible={editingPhotoIndex !== null} transparent animationType="fade" onRequestClose={closePhotoEditor}>
          <View style={styles.photoEditOverlay}>
            <View style={styles.photoEditCard}>
              <View style={styles.photoEditHeader}>
                <View>
                  <Text style={styles.photoEditTitle}>Edit Patient Photo</Text>
                  <Text style={styles.photoEditHint}>Rotate or crop, then save when you are satisfied.</Text>
                </View>
                <Pressable onPress={closePhotoEditor} disabled={photoBusy} style={styles.photoEditIconButton}>
                  <Ionicons name="close" size={22} color={colors.onSurface} />
                </Pressable>
              </View>

              <View style={styles.photoEditPreviewWrap}>
                {editingPhotoUri ? (
                  <Image source={{ uri: editingPhotoUri }} style={styles.photoEditPreview} resizeMode="contain" />
                ) : null}
              </View>

              <View style={styles.cropControls}>
                <View style={styles.cropControlHeader}>
                  <View>
                    <Text style={styles.cropTitle}>Crop area</Text>
                    <Text style={styles.cropHint}>Adjust the frame, position it, then apply crop.</Text>
                  </View>
                  <Text style={styles.cropValue}>{Math.round(cropScale * 100)}%</Text>
                </View>
                <View style={styles.cropSizeRow}>
                  <Pressable style={styles.cropCircleButton} disabled={photoBusy} onPress={() => setCropScale(v => Math.max(0.45, Number((v - 0.08).toFixed(2))))}>
                    <Ionicons name="remove" size={20} color={colors.onSurface} />
                  </Pressable>
                  <View style={styles.cropTrack}><View style={[styles.cropTrackFill, { width: `${Math.round(((cropScale - 0.45) / 0.45) * 100)}%` }]} /></View>
                  <Pressable style={styles.cropCircleButton} disabled={photoBusy} onPress={() => setCropScale(v => Math.min(0.9, Number((v + 0.08).toFixed(2))))}>
                    <Ionicons name="add" size={20} color={colors.onSurface} />
                  </Pressable>
                </View>
                <View style={styles.cropPosition}>
                  <Pressable style={styles.cropArrow} disabled={photoBusy} onPress={() => setCropY(v => Math.max(0, Number((v - 0.08).toFixed(2))))}><Ionicons name="chevron-up" size={20} color={colors.onSurface} /></Pressable>
                  <View style={styles.cropMiddle}>
                    <Pressable style={styles.cropArrow} disabled={photoBusy} onPress={() => setCropX(v => Math.max(0, Number((v - 0.08).toFixed(2))))}><Ionicons name="chevron-back" size={20} color={colors.onSurface} /></Pressable>
                    <View style={styles.cropCenter}><Ionicons name="scan-outline" size={18} color={colors.muted} /></View>
                    <Pressable style={styles.cropArrow} disabled={photoBusy} onPress={() => setCropX(v => Math.min(1, Number((v + 0.08).toFixed(2))))}><Ionicons name="chevron-forward" size={20} color={colors.onSurface} /></Pressable>
                  </View>
                  <Pressable style={styles.cropArrow} disabled={photoBusy} onPress={() => setCropY(v => Math.min(1, Number((v + 0.08).toFixed(2))))}><Ionicons name="chevron-down" size={20} color={colors.onSurface} /></Pressable>
                </View>
              </View>

              <View style={styles.photoEditActions}>
                <Pressable style={styles.photoTool} disabled={photoBusy} onPress={() => editPhoto("rotate")}>
                  <Ionicons name="refresh-outline" size={20} color={colors.onSurface} />
                  <Text style={styles.photoToolText}>Rotate 90°</Text>
                </Pressable>
                <Pressable style={styles.photoTool} disabled={photoBusy} onPress={() => editPhoto("crop")}>
                  <Ionicons name="crop-outline" size={20} color={colors.onSurface} />
                  <Text style={styles.photoToolText}>Apply Crop</Text>
                </Pressable>
                <Pressable style={styles.photoTool} disabled={photoBusy} onPress={resetPhotoEdits}>
                  <Ionicons name="refresh-circle-outline" size={20} color={colors.onSurface} />
                  <Text style={styles.photoToolText}>Reset</Text>
                </Pressable>
              </View>

              <View style={styles.photoEditFooter}>
                <Pressable style={styles.photoCancelButton} disabled={photoBusy} onPress={closePhotoEditor}>
                  <Text style={styles.photoCancelText}>Cancel</Text>
                </Pressable>
                <Pressable style={styles.photoSaveButton} disabled={photoBusy} onPress={savePhotoEdits}>
                  <Ionicons name="checkmark" size={19} color={colors.onBrandPrimary} />
                  <Text style={styles.photoSaveText}>{photoBusy ? "Working…" : "Save changes"}</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
        {labOcrEnabled ? (
          <View style={{ marginTop: spacing.md, marginBottom: spacing.md }}>
            <Text style={styles.section}>Automatic lab report check</Text>
            <Text style={styles.hint}>{labOcrBusy ? "Automatically checking existing patient-file pictures for laboratory reports…" : "No photo needs to be added or selected. Existing patient-file pictures are checked automatically; only pictures recognized as laboratory reports are used for lab-result analysis."}</Text>
            {labOcrText ? <View style={{ marginTop: spacing.sm, padding: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md }}>
              {labOcrFindings.length ? <><Text style={[styles.label, { marginTop: spacing.xs }]}>Lab results to verify</Text>{labOcrFindings.map((finding, i) => { const isWarning = finding.startsWith("WARNING:"); const tone = isWarning ? (colors.warning || "#B7791F") : (colors.error || "#B91C1C"); return <Text key={i} style={{ color: tone, marginTop: spacing.xs, fontFamily: isWarning ? fontFamily.medium : fontFamily.bold }}>{finding}</Text>; })}</> : <Text style={{ color: colors.onSurfaceSecondary, marginTop: spacing.sm }}>{labWarningsEnabled ? "No out-of-range rows were detected by this scan. This does not prove that every result is normal." : "No larger alerts were detected. Mild warnings are disabled in Settings; this does not prove that every result is normal."}</Text>}
              <Pressable onPress={() => setShowLabRawText(value => !value)} style={{ marginTop: spacing.md, paddingVertical: spacing.sm, flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
                <Ionicons name={showLabRawText ? "chevron-up" : "document-text-outline"} size={18} color={colors.brandPrimary} />
                <Text style={{ color: colors.brandPrimary, fontFamily: fontFamily.semibold }}>{showLabRawText ? "Hide full OCR text" : "Show full OCR text (" + labOcrText.length + " characters)"}</Text>
              </Pressable>
              {showLabRawText ? <Text selectable style={{ color: colors.onSurface, fontSize: fontSize.sm, marginTop: spacing.xs }}>{labOcrText}</Text> : null}
              {labManualReviews.length ? <View style={{ marginTop: spacing.md, padding: spacing.sm, borderWidth: 1, borderColor: colors.warning || "#B7791F", borderRadius: radius.md }}>
                <Text style={[styles.label, { color: colors.warning || "#B7791F" }]}>Admin verification required</Text>
                <Text style={{ color: colors.onSurfaceSecondary, marginTop: spacing.xs }}>{user?.role === "admin" ? "OCR may miss digits circled on the report. Open the original image, read the result yourself, and enter the value below. These are manual review entries, not OCR-confirmed results." : "Some lab results need visual verification. Please ask an administrator to open the original report and confirm the result."}</Text>
                {user?.role === "admin" ? labManualReviews.map((item, index) => {
                  const numeric = Number(String(item.result || "").replace(",", ".").trim());
                  const hasValue = !!item.result.trim() && Number.isFinite(numeric);
                  const abnormal = hasValue && item.min !== undefined && item.max !== undefined && (numeric < item.min || numeric > item.max);
                  return <View key={item.test + "-" + index} style={{ marginTop: spacing.md, paddingTop: spacing.sm, borderTopWidth: index ? 1 : 0, borderColor: colors.border }}>
                    <Text style={[styles.label, { color: colors.onSurface }]}>{item.test}</Text>
                    <Pressable onPress={() => item.photoUri && setSelectedPhoto(item.photoUri)} style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingVertical: spacing.sm }}>
                      <Ionicons name="image-outline" size={18} color={colors.brandPrimary} />
                      <Text style={{ color: colors.brandPrimary, fontFamily: fontFamily.semibold }}>View original report image</Text>
                    </Pressable>
                    <Field label={"Enter result" + (item.unit ? " (" + item.unit + ")" : "")} value={item.result} onChangeText={(value: string) => {
                      // Keep manual lab results numeric even if the keyboard allows pasted text.
                      const cleaned = value.replace(/,/g, ".").replace(/[^0-9.]/g, "");
                      const firstDot = cleaned.indexOf(".");
                      const numericValue = firstDot < 0 ? cleaned : cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, "");
                      setLabManualReviews(previous => previous.map((row, rowIndex) => rowIndex === index ? { ...row, result: numericValue } : row));
                    }} keyboardType="decimal-pad" inputMode="decimal" placeholder="Digits only — read the value from the report" />
                    {item.reference ? <Text style={{ color: colors.onSurfaceSecondary, marginTop: spacing.xs }}>Reference range: {item.reference}</Text> : <Text style={{ color: colors.onSurfaceSecondary, marginTop: spacing.xs }}>No saved reference range available. Compare with the printed range.</Text>}
                    {hasValue ? <Text style={{ color: abnormal ? (colors.error || "#B91C1C") : colors.onSurfaceSecondary, marginTop: spacing.xs, fontFamily: abnormal ? fontFamily.bold : fontFamily.regular }}>{abnormal ? "Outside the saved reference range — verify promptly with a qualified clinician." : item.min !== undefined && item.max !== undefined ? "Within the saved reference range; still verify the source and units." : "Value entered. Verify against the printed reference range."}</Text> : null}
                  </View>;
                }) : null}
                {user?.role === "admin" ? <Pressable onPress={() => {
                  const manual = labManualReviews.filter(item => item.result.trim()).map(item => ({ test: item.test, result: item.result.trim(), unit: item.unit, reference: item.reference, manuallyVerified: true }));
                  setP(previous => ({ ...previous, customData: { ...(previous.customData || {}), labOcrManualResults: JSON.stringify(manual) } }));
                  toast("Manual lab review values added to this patient form draft. Verify them before saving.", "info");
                }} style={{ marginTop: spacing.md, padding: spacing.md, backgroundColor: colors.brandPrimary, borderRadius: radius.md, alignItems: "center" }}>
                  <Text style={{ color: colors.onBrandPrimary, fontFamily: fontFamily.semibold }}>Apply manual review to patient draft</Text>
                </Pressable> : null}
              </View> : null}
              {labOcrOnlineHelp.length ? <><Text style={[styles.label, { marginTop: spacing.md }]}>Test-name reference assistance</Text><Text style={{ color: colors.onSurfaceSecondary, marginTop: spacing.xs }}>Only non-identifying test-name labels are checked. No photo, patient details, report text, result values or units are uploaded. This assistance does not confirm whether a result is normal.</Text>{labOcrOnlineHelp.map((item, i) => <Text key={i} style={{ color: colors.onSurface, marginTop: spacing.xs }}>{item}</Text>)}</> : null}
            </View> : null}
          </View>
        ) : null}
        <Text style={styles.section}>Patient Details</Text>
        {(() => {
          const builtIn = ["mrNo","name","gender","age","address","diagnosis","procedure","procedureII","fileName","date"];
          const customKeys = customFields.filter((f:any)=>f?.key && f?.label).map((f:any)=>String(f.key));
          const allowed = [...builtIn,...customKeys.filter((k:string)=>!builtIn.includes(k))];
          const saved = Array.isArray(branding.patientFormFieldOrder) ? branding.patientFormFieldOrder : [];
          const order = [...saved.filter((key:string)=>allowed.includes(key))];
          allowed.forEach(key=>{if(!order.includes(key))order.push(key)});
          const customByKey = new Map(customFields.filter((f:any)=>f?.key).map((f:any)=>[String(f.key),f]));
          return order.map((key:string) => {
            switch (key) {
              case "mrNo": return <Field key={key} label="MRNo" testID="patient-mrno-input" value={p.mrNo} onChangeText={set("mrNo")} placeholder="e.g. 10234" />;
              case "name": return <Field key={key} label="Patient Name" testID="patient-name-input" value={p.name} onChangeText={set("name")} placeholder="Full name" autoCapitalize="words" />;
              case "gender": return <View key={key}><Text style={styles.label}>Gender</Text><View style={{ marginBottom: spacing.lg }}><Segmented options={["Male", "Female", "Other"]} value={p.gender} onChange={set("gender")} /></View></View>;
              case "age": return <Field key={key} label="Age" testID="patient-age-input" value={p.age} onChangeText={set("age")} keyboardType="number-pad" placeholder="e.g. 45" />;
              case "address": return <Field key={key} label="Address" testID="patient-address-input" value={p.address} onChangeText={set("address")} placeholder="Patient address" />;
              case "diagnosis": return <Field key={key} label="Diagnosis" testID="patient-diagnosis-input" value={p.diagnosis} onChangeText={set("diagnosis")} placeholder="Diagnosis" />;
              case "procedure": return <View key={key}><AutocompleteField label="Procedure" testID="patient-procedure-input" value={p.procedure} onChangeText={set("procedure")} placeholder="Type to search procedures" suggestions={procedureSuggestions} />{!!procedures?.length && <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.quickScroller} contentContainerStyle={styles.quickRow}>{procedures.map((x) => <Pressable key={x.id} style={styles.quickChip} onPress={() => set("procedure")(x.name)}><Text style={styles.quickChipText}>{x.name}</Text></Pressable>)}</ScrollView>}</View>;
              case "procedureII": return <View key={key}><AutocompleteField label={branding.procedureSecondLabel?.trim() || "Procedure 2"} testID="patient-procedure2-input" value={p.procedureII || ""} onChangeText={set("procedureII")} placeholder="Type to search second procedure" suggestions={procedureSuggestions} />{!!procedures?.length && <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.quickScroller} contentContainerStyle={styles.quickRow}>{procedures.map((x) => <Pressable key={x.id} style={styles.quickChip} onPress={() => set("procedureII")(x.name)}><Text style={styles.quickChipText}>{x.name}</Text></Pressable>)}</ScrollView>}</View>;
              case "fileName": return <Field key={key} label="File / Reference" testID="patient-file-input" value={p.fileName} onChangeText={set("fileName")} placeholder="File reference" />;
              case "date": return <Field key={key} label="Date" testID="patient-date-input" value={p.date} onChangeText={set("date")} placeholder="YYYY-MM-DD" />;
              default: {
                const f:any = customByKey.get(key);
                if (!f) return null;
                const value=String((p.customData || {})[f.key] || "");
                const update=(v:string)=>setP(prev=>({ ...prev, customData:{ ...(prev.customData || {}), [f.key]:v } }));
                return <Field key={key} label={f.label} value={value} onChangeText={update} placeholder={f.type === "date" ? "YYYY-MM-DD" : f.label} keyboardType={f.type === "number" ? "numeric" : "default"} multiline={f.type === "multiline"} textAlignVertical={f.type === "multiline" ? "top" : "center"} style={f.type === "multiline" ? { minHeight: 100 } : undefined} testID={"patient-custom-field-" + f.id} />;
              }
            }
          });
        })()}

        <Text style={styles.section}>Infection Screening</Text>
        {([
          ["hcvPlus", "HCV+"],
          ["hbaSg", "HbAsg"],
          ["hiv", "HIV"],
        ] as const).map(([key, label]) => (
          <Pressable
            key={key}
            onPress={() => setP(prev => ({ ...prev, [key]: !prev[key] }))}
            style={styles.screeningRow}
            testID={"patient-screening-" + key}
          >
            <Ionicons
              name={p[key] ? "checkbox" : "square-outline"}
              size={22}
              color={p[key] ? colors.brandPrimary : colors.muted}
            />
            <Text style={styles.screeningText}>{label}</Text>
          </Pressable>
        ))}

        <Text style={styles.section}>Inventory Items Used</Text>
        <Field
          label="Search inventory"
          testID="patient-inventory-search"
          value={implantSearch}
          onChangeText={setImplantSearch}
          placeholder="Search category, item or size"
        />
        {!!implantSearch.trim() && (
          <View style={styles.inventoryPicker}>
            {(inventory ?? [])
              .filter(x => {
                const q = implantSearch.trim().toLowerCase();
                return [x.category,x.name,x.size].some(v => String(v || "").toLowerCase().includes(q));
              })
              .slice(0, 20)
              .map(x => (
                <Pressable key={x.id} style={styles.inventoryOption} onPress={() => addImplant(x)}>
                  <Text style={styles.inventoryOptionTitle} numberOfLines={2}>
                    {formatInventoryLabel(x.category, x.name, x.size)}
                  </Text>
                  <Text style={styles.inventoryOptionDetail}>{x.quantity} {x.quantity === 1 ? "available" : "available"}</Text>
                </Pressable>
              ))}
          </View>
        )}
        {selectedImplants.length > 0 ? (
          <View style={styles.selectedInventory}>
            {selectedImplants.map((x) => (
              <View key={x.id} style={styles.selectedInventoryRow}>
                <View style={{flex:1}}>
                  <Text style={styles.selectedInventoryTitle} numberOfLines={2}>
                    {[x.category, x.name, x.size].filter(Boolean).join(" · ")}
                  </Text>
                  <Text style={styles.selectedInventoryDetail}>Selected separately · Qty {x.quantity}</Text>
                </View>
                <Pressable style={styles.qtyButton} onPress={() => changeImplantQty(x.id,-1)}>
                  <Ionicons name="remove" size={17} color={colors.onSurface} />
                </Pressable>
                <Text style={styles.selectedQty}>{x.quantity}</Text>
                <Pressable style={styles.qtyButton} onPress={() => changeImplantQty(x.id,1)}>
                  <Ionicons name="add" size={17} color={colors.onSurface} />
                </Pressable>
                <Pressable style={styles.removeSelected} onPress={() => removeImplant(x.id)}>
                  <Ionicons name="trash-outline" size={18} color={colors.error} />
                </Pressable>
              </View>
            ))}
          </View>
        ) : (
          <Text style={styles.hint}>Select one or more inventory items. Each category, item and size is kept separately.</Text>
        )}

        {isEdit && (
          <Pressable style={styles.history} onPress={() => router.push({ pathname: "/patient-history", params: { id } })}>
            <Ionicons name="time-outline" size={20} color={colors.brandPrimary} />
            <Text style={styles.historyText}>View edit history</Text>
          </Pressable>
        )}
      </KeyboardAwareScrollView>

      <Modal
        visible={cameraOpen}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => { setCameraOpen(false); setCameraReady(false); }}
      >
        <View style={styles.cameraScreen}>
          <View style={[styles.cameraHeader, { paddingTop: insets.top + spacing.sm }]}>
            <Pressable
              onPress={() => { setCameraOpen(false); setCameraReady(false); }}
              style={styles.photoEditIconButton}
              disabled={cameraTaking}
              accessibilityLabel="Close camera"
            >
              <Ionicons name="close" size={24} color="#FFFFFF" />
            </Pressable>
            <Text style={styles.cameraTitle}>Take Patient Photo</Text>
            <Pressable onPress={() => { setCameraOpen(false); setCameraReady(false); }} style={styles.photoEditIconButton} disabled={cameraTaking}><Text style={{ color: "#FFFFFF", fontWeight: "700" }}>Done</Text></Pressable>
          </View>
          <View style={styles.cameraPreviewWrap}>
            {cameraOpen ? (
              <CameraView
                ref={cameraRef}
                style={styles.cameraPreview}
                facing="back"
                mode="picture"
                onCameraReady={() => setCameraReady(true)}
              />
            ) : null}
            {!cameraReady ? (
              <View style={styles.cameraLoading}>
                <Text style={styles.cameraLoadingText}>Starting camera…</Text>
              </View>
            ) : null}
          </View>
          <View style={[styles.cameraControls, { paddingBottom: insets.bottom + spacing.lg }]}>
            <Text style={styles.cameraHint}>Photos are saved privately inside Ortho Logbook.</Text>
            <Pressable
              style={[styles.cameraShutter, (!cameraReady || cameraTaking) && { opacity: 0.5 }]}
              onPress={capturePatientPhoto}
              disabled={!cameraReady || cameraTaking}
              accessibilityLabel="Capture patient photo"
            >
              <View style={styles.cameraShutterInner} />
            </Pressable>
            <Text style={styles.cameraLoadingText}>{cameraTaking ? "Saving photo…" : cameraReady ? "Tap to capture" : "Please wait"}</Text>
          </View>
        </View>
      </Modal>

      <Modal visible={!!selectedPhoto} transparent animationType="fade" onRequestClose={() => setSelectedPhoto(null)}>
        <View style={styles.photoViewer}>
          <Pressable style={styles.photoViewerClose} onPress={() => setSelectedPhoto(null)} hitSlop={10}>
            <Ionicons name="close" size={30} color="#FFFFFF" />
          </Pressable>
          {!!selectedPhoto && (
            <ScrollView key={selectedPhoto || "none"} horizontal pagingEnabled showsHorizontalScrollIndicator={false} contentOffset={{ x: Math.max(0, allViewerPhotos.indexOf(selectedPhoto)) * screenWidth, y: 0 }} onMomentumScrollEnd={(event) => { const idx = Math.max(0, Math.min(allViewerPhotos.length - 1, Math.round(event.nativeEvent.contentOffset.x / screenWidth))); setSelectedPhoto(allViewerPhotos[idx] || null); }} style={{ flex: 1, width: screenWidth }} contentContainerStyle={{ alignItems: "center" }}>
              {allViewerPhotos.map((uri, idx) => <View key={uri + "-" + idx} style={{ width: screenWidth, height: "100%", alignItems: "center", justifyContent: "center" }}><Image source={{ uri }} style={styles.photoFull} resizeMode="contain" /></View>)}
            </ScrollView>
          )}
          {!!selectedPhoto && (
            <View style={styles.photoViewerToolbar}>
              <Pressable style={styles.photoViewerAction} onPress={() => selectedPhoto && savePhotoToDevice(selectedPhoto)} disabled={photoBusy}>
                <Ionicons name="download-outline" size={19} color="#FFFFFF" />
                <Text style={styles.photoViewerActionText}>{photoBusy ? "Saving..." : "Save to device"}</Text>
              </Pressable>
              <Pressable style={styles.photoViewerAction} onPress={() => {
                const idx = p.photos.indexOf(selectedPhoto);
                if (idx >= 0) { setSelectedPhoto(null); openPhotoEditor(idx); }
              }}>
                <Ionicons name="create-outline" size={19} color="#FFFFFF" />
                <Text style={styles.photoViewerActionText}>Edit photo</Text>
              </Pressable>
              <Pressable style={styles.photoViewerAction} onPress={() => setSelectedPhoto(null)}>
                <Ionicons name="checkmark" size={19} color="#FFFFFF" />
                <Text style={styles.photoViewerActionText}>Done</Text>
              </Pressable>
            </View>
          )}
        </View>
      </Modal>

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}>
        {canEdit || !isEdit ? (
          <PrimaryButton title={isEdit ? "Update Record" : "Save Record"} onPress={onSave} testID="save-patient-button" loading={save.isPending} />
        ) : (
          <Text style={styles.permission}>This record is read-only for your account.</Text>
        )}
      </View>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  container: { flex: 1, backgroundColor: colors.surface },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.md, paddingBottom: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  headerBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  headerTitle: { fontFamily: fontFamily.bold, fontSize: fontSize.lg, color: colors.onSurface },
  section: { fontFamily: fontFamily.bold, fontSize: fontSize.sm, color: colors.brandPrimary, textTransform: "uppercase", letterSpacing: 0.6, marginTop: spacing.md, marginBottom: spacing.md },
  label: { fontFamily: fontFamily.semibold, fontSize: fontSize.sm, color: colors.onSurfaceSecondary, marginBottom: spacing.xs },
  screeningRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: spacing.sm, marginBottom: spacing.xs },
  screeningText: { fontFamily: fontFamily.medium, fontSize: fontSize.base, color: colors.onSurface },
  photoActions: { flexDirection: "row", gap: spacing.md, marginBottom: spacing.md, alignItems: "center", flexWrap: "wrap" },
  secondary: { flexDirection: "row", alignItems: "center", height: 48, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: spacing.md, justifyContent: "center" },
  secondaryText: { fontFamily: fontFamily.semibold, color: colors.onSurface },
  cropControls: { backgroundColor: colors.surfaceSecondary, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: spacing.md, marginBottom: spacing.md },
  cropControlHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.sm },
  cropTitle: { fontFamily: fontFamily.semibold, fontSize: fontSize.sm, color: colors.onSurface },
  cropHint: { fontFamily: fontFamily.regular, fontSize: fontSize.xs, color: colors.muted, marginTop: 2 },
  cropValue: { fontFamily: fontFamily.bold, fontSize: fontSize.sm, color: colors.brandPrimary },
  cropSizeRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  cropCircleButton: { width: 38, height: 38, borderRadius: 19, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" },
  cropTrack: { flex: 1, height: 6, borderRadius: 3, backgroundColor: colors.border, overflow: "hidden" },
  cropTrackFill: { height: "100%", backgroundColor: colors.brandPrimary, borderRadius: 3 },
  cropPosition: { alignItems: "center", marginTop: spacing.sm },
  cropMiddle: { flexDirection: "row", alignItems: "center", gap: spacing.lg },
  cropArrow: { width: 38, height: 38, borderRadius: 19, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" },
  cropCenter: { width: 44, height: 44, borderRadius: 10, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface },
  cameraScreen: { flex: 1, backgroundColor: "#080808" },
  cameraHeader: { minHeight: 64, paddingHorizontal: spacing.md, paddingBottom: spacing.sm, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  cameraTitle: { fontFamily: fontFamily.bold, fontSize: fontSize.base, color: "#FFFFFF" },
  cameraPreviewWrap: { flex: 1, overflow: "hidden", backgroundColor: "#000000" },
  cameraPreview: { flex: 1 },
  cameraLoading: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.35)" },
  cameraLoadingText: { fontFamily: fontFamily.medium, fontSize: fontSize.sm, color: "#FFFFFF", textAlign: "center" },
  cameraControls: { minHeight: 150, alignItems: "center", justifyContent: "center", gap: spacing.sm, paddingTop: spacing.md, backgroundColor: "#080808" },
  cameraHint: { fontFamily: fontFamily.regular, fontSize: fontSize.xs, color: "#D1D5DB", textAlign: "center" },
  cameraShutter: { width: 76, height: 76, borderRadius: 38, borderWidth: 4, borderColor: "#FFFFFF", alignItems: "center", justifyContent: "center" },
  cameraShutterInner: { width: 58, height: 58, borderRadius: 29, backgroundColor: "#FFFFFF" },
  photoViewerToolbar: { position: "absolute", bottom: 32, left: 20, right: 20, flexDirection: "row", justifyContent: "center", gap: spacing.sm },
  photoViewerAction: { minWidth: 120, height: 46, borderRadius: 23, paddingHorizontal: spacing.md, backgroundColor: "rgba(0,0,0,0.68)", borderWidth: 1, borderColor: "rgba(255,255,255,0.25)", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.xs },
  photoViewerActionText: { fontFamily: fontFamily.semibold, color: "#FFFFFF", fontSize: fontSize.sm },
  photoEditOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.72)", justifyContent: "center", padding: spacing.lg },
  photoEditCard: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.lg, width: "100%", maxWidth: 520, maxHeight: "92%" },
  photoEditHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.md },
  photoEditTitle: { fontFamily: fontFamily.bold, fontSize: fontSize.lg, color: colors.onSurface },
  photoEditHint: { fontFamily: fontFamily.regular, fontSize: fontSize.xs, color: colors.muted, marginTop: 3, paddingRight: spacing.md },
  photoEditIconButton: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  photoEditPreviewWrap: { width: "100%", height: 360, borderRadius: radius.md, backgroundColor: "#111111", overflow: "hidden", marginBottom: spacing.md, alignItems: "center", justifyContent: "center" },
  photoEditPreview: { width: "100%", height: "100%" },
  photoEditActions: { flexDirection: "row", gap: spacing.sm, marginBottom: spacing.md },
  photoTool: { flex: 1, minHeight: 72, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSecondary, alignItems: "center", justifyContent: "center", gap: 5 },
  photoToolText: { fontFamily: fontFamily.semibold, fontSize: fontSize.xs, color: colors.onSurface },
  photoEditFooter: { flexDirection: "row", gap: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.md },
  photoCancelButton: { flex: 1, minHeight: 48, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  photoCancelText: { fontFamily: fontFamily.semibold, color: colors.onSurface },
  photoSaveButton: { flex: 1.5, minHeight: 48, borderRadius: radius.md, backgroundColor: colors.brandPrimary, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.xs },
  photoSaveText: { fontFamily: fontFamily.bold, color: colors.onBrandPrimary },
  photoPlaceholder: { height: 140, borderRadius: radius.lg, backgroundColor: colors.surfaceTertiary, alignItems: "center", justifyContent: "center", marginBottom: spacing.md, gap: spacing.sm },
  hint: { fontFamily: fontFamily.regular, fontSize: fontSize.sm, color: colors.muted },
  photoStrip: { gap: spacing.md, paddingVertical: spacing.sm, paddingRight: spacing.md },
  photoViewer: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.96)",
    alignItems: "center",
    justifyContent: "center",
  },
  photoFull: { width: "100%", height: "100%" },
  photoViewerClose: {
    position: "absolute",
    zIndex: 10,
    top: 52,
    right: 18,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center",
    justifyContent: "center",
  },
  photoBox: { width: 140, height: 180, borderRadius: radius.md, overflow: "hidden", backgroundColor: colors.surfaceTertiary },
  photoThumb: { width: "100%", height: "100%" },
  photoRemove: { position: "absolute", top: 6, right: 6, backgroundColor: "rgba(0,0,0,0.65)", width: 26, height: 26, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  quickScroller: { marginTop: -spacing.sm, marginBottom: spacing.lg },
  inventoryPicker: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surfaceSecondary, marginTop: -spacing.md, marginBottom: spacing.md, overflow: "hidden" },
  inventoryOption: { paddingHorizontal: spacing.md, paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.divider },
  inventoryOptionTitle: { fontFamily: fontFamily.semibold, fontSize: fontSize.base, color: colors.onSurface },
  inventoryOptionDetail: { fontFamily: fontFamily.regular, fontSize: fontSize.sm, color: colors.muted, marginTop: 3 },
  selectedInventory: { gap: spacing.sm, marginBottom: spacing.md },
  selectedInventoryRow: { flexDirection:"row", alignItems:"center", gap:spacing.xs, padding:spacing.md, borderWidth:1, borderColor:colors.border, borderRadius:radius.md, backgroundColor:colors.surfaceSecondary },
  selectedInventoryTitle: { fontFamily:fontFamily.semibold, fontSize:fontSize.sm, color:colors.onSurface },
  selectedInventoryDetail: { fontFamily:fontFamily.regular, fontSize:fontSize.xs, color:colors.muted, marginTop:3 },
  qtyButton: { width:32, height:32, borderRadius:16, borderWidth:1, borderColor:colors.border, alignItems:"center", justifyContent:"center" },
  selectedQty: { minWidth:22, textAlign:"center", fontFamily:fontFamily.bold, color:colors.onSurface },
  removeSelected: { width:32, height:32, alignItems:"center", justifyContent:"center" },
  quickRow: { gap: spacing.sm, paddingRight: spacing.lg },
  quickChip: { height: 36, justifyContent: "center", backgroundColor: colors.surfaceTertiary, borderRadius: radius.pill, paddingHorizontal: spacing.md },
  quickChipText: { fontFamily: fontFamily.medium, fontSize: fontSize.sm, color: colors.onSurfaceTertiary },
  history: { flexDirection: "row", alignItems: "center", gap: spacing.sm, padding: spacing.lg, backgroundColor: colors.surfaceTertiary, borderRadius: radius.md, marginTop: spacing.md },
  historyText: { fontFamily: fontFamily.semibold, color: colors.brandPrimary },
  restorePatientOverlay: {
    flex: 1,
    backgroundColor: "rgba(15,23,42,0.58)",
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.lg,
  },
  restorePatientDialog: {
    width: "100%",
    maxWidth: 440,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.brandPrimary,
    padding: spacing.lg,
    gap: spacing.lg,
    elevation: 12,
  },
  restorePatientDialogHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  restorePatientCopy: { gap: spacing.xs },
  restorePatientTitle: { fontFamily: fontFamily.bold, fontSize: fontSize.base, color: colors.brandPrimary },
  restorePatientText: { fontFamily: fontFamily.regular, fontSize: fontSize.sm, color: colors.onSurface, lineHeight: 20 },
  duplicateBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    backgroundColor: colors.warning,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  duplicateText: {
    flex: 1,
    fontFamily: fontFamily.medium,
    fontSize: fontSize.sm,
    color: colors.onWarning,
    lineHeight: 20,
  },
  duplicateStrong: { fontFamily: fontFamily.bold, color: colors.onWarning },
  footer: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface },
  permission: { textAlign: "center", color: colors.muted, fontFamily: fontFamily.semibold, padding: spacing.md },
}));
