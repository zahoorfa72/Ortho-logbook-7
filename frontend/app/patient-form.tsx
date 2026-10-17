import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import * as CameraPermissions from "expo-camera";
import { CameraView } from "expo-camera";
import * as ImageManipulator from "expo-image-manipulator";
import { Asset, requestPermissionsAsync } from "expo-media-library";
import * as FileSystem from "expo-file-system/legacy";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { extractLabReportDate, hasKnownLabTestName, isLabMetadataLine, isLikelyLabReportText, parseLabReportRows, recognizeLabText } from "@/src/utils/lab-ocr";
import { detectScreeningStatuses } from "@/src/utils/screening-status";
import { scanPatientDocuments } from "@/src/utils/document-scanner";
import { buildPerspectiveWarpHtml } from "@/src/utils/perspective-warp";
import { recordDiagnosticError } from "@/src/utils/problem-report";
import { Dimensions } from "react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AppState, Image, InteractionManager, Modal, Pressable, ScrollView, Text, View } from "react-native";
import Ionicons from "@react-native-vector-icons/ionicons";
import { WebView } from "react-native-webview";
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
const LAB_OCR_PIPELINE_VERSION = "row-aware-2026-10-17-v2";

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

function asBooleanFlag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value == null) return false;
  return /^(?:true|1|yes|positive|reactive)$/i.test(String(value).trim());
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
  const [labManualReviews, setLabManualReviews] = useState<Array<{ test: string; unit: string; result: string; reference: string; photoUri: string; reportDate?: string; min?: number; max?: number }>>([]);
  const [labTestTemplates, setLabTestTemplates] = useState<import("@/src/utils/lab-ocr").LabTestDefinition[]>([]);
  const [labDetailsExpanded, setLabDetailsExpanded] = useState(false);
  const [labAddedResults, setLabAddedResults] = useState<Array<{ test: string; unit: string; result: string; reference: string; photoUri: string; reportDate?: string; min?: number; max?: number }>>([]);
  const [manualTestName, setManualTestName] = useState("");
  const [manualTestUnit, setManualTestUnit] = useState("");
  const [manualTestResult, setManualTestResult] = useState("");
  const [manualTestDate, setManualTestDate] = useState(today());
  const [manualTestReference, setManualTestReference] = useState("");
  const [labWarningsEnabled, setLabWarningsEnabled] = useState(true);
  const [labWarningThreshold, setLabWarningThreshold] = useState(10);
  const [showLabRawText, setShowLabRawText] = useState(false);
  const [labOcrOnlineHelp, setLabOcrOnlineHelp] = useState<string[]>([]);
  const screenWidth = Dimensions.get("window").width;
  const [editingPhotoIndex, setEditingPhotoIndex] = useState<number | null>(null);
  const [editingPhotoOriginal, setEditingPhotoOriginal] = useState<string | null>(null);
  const [editingPhotoUri, setEditingPhotoUri] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [perspectiveMode, setPerspectiveMode] = useState(false);
  const [perspectiveHtml, setPerspectiveHtml] = useState("");
  const perspectiveWebViewRef = useRef<any>(null);

  const [existingScanPickerVisible, setExistingScanPickerVisible] = useState(false);
  const [imagePickerReady, setImagePickerReady] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraTaking, setCameraTaking] = useState(false);
  const cameraRef = useRef<any>(null);
  const [cameraPermission, requestCameraPermission] = CameraPermissions.useCameraPermissions();
  const imagePickerOpening = useRef(false);
  const imagePickerReadyRef = useRef(false);
  const appStateRef = useRef(AppState.currentState);
  const [cropRect, setCropRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const cropDragStartRef = useRef<{ x: number; y: number } | null>(null);
  const cropResizeStartRef = useRef<{ rect: { x: number; y: number; width: number; height: number }; handle: string; pageX: number; pageY: number } | null>(null);
  const [photoPreviewSize, setPhotoPreviewSize] = useState({ width: 0, height: 0 });
  const [editingPhotoDimensions, setEditingPhotoDimensions] = useState<{ width: number; height: number } | null>(null);
  const [p, setP] = useState<Patient>(empty);
  const savedManualLabResults = useMemo(() => {
    try {
      const raw = p.customData?.labOcrManualResults;
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((item: any) => item && String(item.test || "").trim() && String(item.result || "").trim()) : [];
    } catch {
      return [];
    }
  }, [p.customData?.labOcrManualResults]);
  const allViewerPhotos = [...new Set(p.photos)];
  const [dismissedTrashMatchId, setDismissedTrashMatchId] = useState<string | null>(null);
  const selectedImplants = p.implants || [];

  useEffect(() => {
    AsyncStorage.getItem("ortho_lab_ocr_enabled").then(value => setLabOcrEnabled(value === "true")).catch(() => setLabOcrEnabled(false));
    AsyncStorage.getItem("ortho_lab_test_definitions_v1").then(raw => { if (raw) { try { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) setLabTestTemplates(parsed); } catch {} } }).catch(() => {});
    AsyncStorage.getItem("ortho_lab_warnings_enabled").then(value => setLabWarningsEnabled(value !== "false")).catch(() => setLabWarningsEnabled(true));
    AsyncStorage.getItem("ortho_lab_warning_threshold_percent_v1").then(value => { const n = Number(value); if (value && Number.isInteger(n) && n >= 1 && n <= 100) setLabWarningThreshold(n); }).catch(() => setLabWarningThreshold(10));
  }, []);

  const analyzeLabPhotos = async (photoUris: string[] = [...new Set(p.photos)], automatic = false, forceRescan = false) => {
    if (!labOcrEnabled || !photoUris.length) return;
    const photoSignature = [...new Set(photoUris)].filter(Boolean).join("|");
    // Reuse the last completed scan for an unchanged photo set. This prevents
    // reopening a patient from running several expensive OCR passes on every
    // saved photo again. Administrators can explicitly force a fresh scan.
    const hasCachedScan = !forceRescan && automatic &&
      String(p.customData?.labOcrPhotoScanComplete || "") === "true" &&
      p.customData?.labOcrPipelineVersion === LAB_OCR_PIPELINE_VERSION &&
      p.customData?.labOcrPhotoSignature === photoSignature;
    const cachedExtracted = hasCachedScan ? String(p.customData?.labOcrExtractedText || "") : null;
    if (labOcrBusy) {
      // The automatic-scan effect may have queued a new photo set while another
      // scan was finishing. Clear its signature so the effect retries when idle.
      lastAutoLabScan.current = "";
      return;
    }
    setLabOcrBusy(true);
    try {
      let configuredLabTests: import("@/src/utils/lab-ocr").LabTestDefinition[] = [];
      try { const savedTests = await AsyncStorage.getItem("ortho_lab_test_definitions_v1"); if (savedTests) configuredLabTests = JSON.parse(savedTests); } catch {}
      const pages: string[] = [];
      const recognizedPhotoUris: string[] = [];
      let onlineOcrKey = "";
      try { onlineOcrKey = (await AsyncStorage.getItem("ortho_lab_online_ocr_api_key_v1")) || ""; } catch {}
      if (cachedExtracted === null) for (let i = 0; i < photoUris.length; i++) {
        try {
          // Yield between photos so the form can repaint and respond while a
          // large patient file is being checked.
          await new Promise<void>(resolve => setTimeout(resolve, 0));
          const result = await recognizeLabText(photoUris[i], onlineOcrKey, configuredLabTests, p.gender);
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
      const extracted = cachedExtracted !== null ? cachedExtracted : pages.join("\n\n");
      if (!extracted.trim()) {
        setLabOcrText("");
        setLabOcrFindings([]);
        if (cachedExtracted === null) {
          // Cache the completed negative scan too, so ordinary clinical photos
          // do not make the app repeat full OCR whenever the patient is opened.
          setP(prev => ({ ...prev, customData: {
            ...(prev.customData || {}),
            labOcrPhotoSignature: photoSignature,
            labOcrPhotoScanComplete: "false",
            labOcrExtractedText: "",
          }}));
        }
        if (automatic && cachedExtracted === null) toast("Lab text could not be read from the saved photos. Retake the lab report clearly; no abnormality can be confirmed.", "info");
        else if (!automatic) toast("No readable lab text found. Use Rescan lab photos after checking the image.", "error");
        return;
      }
      const parsedRows = parseLabReportRows(extracted, configuredLabTests, p.gender, labWarningThreshold, true);
      const reviewSourcePhotos = cachedExtracted !== null
        ? [...new Set([...extracted.matchAll(/LAB REPORT IMAGE\s+(\d+)/gi)].map(match => photoUris[Number(match[1]) - 1]).filter(Boolean))]
        : [...new Set(recognizedPhotoUris)];
      const canonical = (value: string) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
      const isHemoglobin = (value: string) => ["hemoglobin", "haemoglobin", "hgb", "hb"].includes(canonical(value));
      const reportDateForTest = (testName: string) => {
        const pages = extracted.split(/(?=LAB REPORT IMAGE\s+\d+)/i).filter(page => /LAB REPORT IMAGE\s+\d+/i.test(page));
        const aliases = isHemoglobin(testName) ? ["hemoglobin", "haemoglobin", "hgb", "hb"] : [String(testName || "")];
        const cellMatches = (value: string) => {
          const normalized = canonical(value);
          return aliases.some(alias => {
            const aliasKey = canonical(alias);
            return normalized === aliasKey || (aliasKey.length >= 4 && normalized.startsWith(aliasKey));
          });
        };
        const rawLineMatches = (line: string) => aliases.some(alias => {
          const aliasKey = canonical(alias);
          if (!aliasKey) return false;
          if (aliasKey.length >= 4) return canonical(line).includes(aliasKey);
          return line.split(/[^a-z0-9]+/i).some(token => canonical(token) === aliasKey);
        });
        const matchingPage = pages.find(page => page.split(/\r?\n/).some(line =>
          line.includes("|") && cellMatches(line.split("|")[0])
        )) || pages.find(page => page.split(/\r?\n/).some(rawLineMatches)) || "";
        return extractLabReportDate(matchingPage) || extractLabReportDate(extracted);
      };
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
      const genderIsMale = /^\s*(?:m|male|man|men)\s*$/i.test(p.gender);
      const observedCandidates: Array<{ name: string; unit: string; min: string; max: string }> = [];
      // OCR may identify test names, but it must never teach or overwrite saved
      // reference ranges. The patient's saved sex-specific range and saved unit
      // are the only sources used for classification.
      for (const page of extracted.split(/(?=LAB REPORT IMAGE\s+\d+)/i)) {
        const marker = "RECONSTRUCTED TABLE ROWS (test | result | unit | reference range)";
        const rawMarker = "RAW OCR TEXT FOR REVIEW";
        const at = page.indexOf(marker);
        if (at < 0) continue;
        const rawAt = page.indexOf(rawMarker, at + marker.length);
        const section = page.slice(at + marker.length, rawAt >= 0 ? rawAt : undefined);
        for (const line of section.split(/\r?\n/)) {
          const cells = line.split("|").map(cell => cell.trim());
          if (cells.length < 2 || !hasKnownLabTestName(cells[0], configuredLabTests)) continue;
          const configured = configuredLabTests.find(item => canonical(item.name) === canonical(cells[0]) ||
            (isHemoglobin(item.name) && isHemoglobin(cells[0])));
          const common = commonCandidates.find(item => canonical(item.name) === canonical(cells[0]) ||
            (isHemoglobin(item.name) && isHemoglobin(cells[0])));
          observedCandidates.push({
            name: configured?.name || common?.name || cells[0],
            unit: configured?.unit || common?.unit || "",
            min: configured ? String(genderIsMale ? configured.maleMin : configured.femaleMin) : "",
            max: configured ? String(genderIsMale ? configured.maleMax : configured.femaleMax) : "",
          });
        }
      }
      const testCandidates = [...configuredCandidates, ...commonCandidates, ...observedCandidates].filter((item, index, all) =>
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
          const currentLine = rawLines[lineIndex];
          // Structured OCR rows have explicit columns: inspect only the result
          // cell, never a number from the reference-range cell.
          if (currentLine.includes("|")) {
            const cells = currentLine.split("|").map(cell => cell.trim());
            if (aliasSeen(cells[0] || "")) {
              const scalar = /^\s*[<>≤≥]?\s*(\d+(?:[.,]\d+)?)(?:\s|$)/.exec(cells[1] || "");
              if (scalar) {
                const parsed = Number(scalar[1].replace(",", "."));
                if (Number.isFinite(parsed)) { resultValue = parsed; break; }
              }
              continue;
            }
          }
          const nearby = [currentLine, rawLines[lineIndex + 1] || ""].join(" | ");
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
        return rawLines.some(aliasSeen) && (!alreadyParsed || suspiciousScale || !hasRange);
      }).map(test => {
        const min = Number(String(test.min ?? "").replace(",", "."));
        const max = Number(String(test.max ?? "").replace(",", "."));
        const validRange = String(test.min ?? "").trim() !== "" && String(test.max ?? "").trim() !== "" && Number.isFinite(min) && Number.isFinite(max);
        const range = validRange ? String(test.min) + "–" + String(test.max) : "";
        const reportDate = reportDateForTest(test.name);
        return { test: test.name, unit: test.unit || "", result: "", reference: range, photoUri: reviewSourcePhotos[0] || "", reportDate: reportDate || undefined, min: validRange ? min : undefined, max: validRange ? max : undefined };
      });
      const candidates: string[] = parsedRows
        .filter(row => row.severity === "ALERT" || (row.severity === "WARNING" && labWarningsEnabled))
        .map(row => {
          const reportDate = reportDateForTest(row.test);
          return row.severity + ": " + row.test + " " + row.result + (row.unit ? " " + row.unit : "") +
            (reportDate ? " | Date: " + reportDate : "") + " | Ref: " + row.reference;
        });
      const uncertain: string[] = [];
      const seenReviewLines = new Set<string>();
      // Only generate review suggestions from reconstructed table rows. Raw OCR
      // includes headings, reference ranges, and normal rows, so scanning every
      // raw line produced false "could not match" warnings even for clear reports.
      for (const page of extracted.split(/(?=LAB REPORT IMAGE\s+\d+)/i)) {
        const marker = "RECONSTRUCTED TABLE ROWS (test | result | unit | reference range)";
        const rawMarker = "RAW OCR TEXT FOR REVIEW";
        const at = page.indexOf(marker);
        const rawAt = page.indexOf(rawMarker);
        if (at < 0) continue;
        const section = page.slice(at + marker.length, rawAt >= 0 ? rawAt : undefined);
        for (const rawLine of section.split(/\r?\n/)) {
          const line = rawLine.replace(/\s+/g, " ").trim();
          if (!line || !line.includes("|")) continue;
          const cells = line.split("|").map(cell => cell.trim());
          if (cells.length < 2 || !/[a-z]{2,}/i.test(cells[0])) continue;
          const knownTest = hasKnownLabTestName(cells[0], configuredLabTests);
          const resultLooksNumeric = /^\s*[<>≤≥]?\s*[-+]?\d+(?:[.,]\d+)?(?:\s|$)/.test(cells[1] || "");
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
            const sex = /^\s*(?:m|male|man|men)\s*$/i.test(p.gender) ? "male" :
              /^\s*(?:f|female|woman|women)\s*$/i.test(p.gender) ? "female" : "";
            const savedRangeExists = !!saved && !!sex &&
              String(sex === "male" ? saved.maleMin : saved.femaleMin).trim() !== "" &&
              String(sex === "male" ? saved.maleMax : saved.femaleMax).trim() !== "";
            const reportRangeExists = /[-+]?\d+(?:[.,]\d+)?\s*(?:-|–|—|\bto\b)\s*[-+]?\d+(?:[.,]\d+)?/i.test(cells.slice(3).join(" "));
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
      // Do not ask the admin to manually verify a test again once a result for
      // that patient/test has been saved as manually verified. Compare normalized
      // test names so small differences in spaces/case do not create repeat prompts.
      const normalizeReviewTestName = (value: unknown) => String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "");
      let alreadyVerifiedNames = new Set<string>();
      try {
        const rawSaved = p.customData?.labOcrManualResults;
        const parsedSaved = rawSaved ? JSON.parse(rawSaved) : [];
        if (Array.isArray(parsedSaved)) {
          alreadyVerifiedNames = new Set(parsedSaved
            .filter((item: any) => item && item.manuallyVerified === true && String(item.result ?? "").trim())
            .map((item: any) => normalizeReviewTestName(item.test))
            .filter(Boolean));
        }
      } catch {}
      const pendingManualReviews = missingResultReviews.filter(item =>
        !alreadyVerifiedNames.has(normalizeReviewTestName(item.test))
      );
      const screeningStatuses = detectScreeningStatuses(extracted);
      const screeningLabels: Array<[keyof typeof screeningStatuses, string]> = [
        ["hcvPlus", "HCV+"],
        ["hbaSg", "HBsAg"],
        ["hiv", "HIV"],
      ];
      const screeningConflicts = screeningLabels
        .filter(([key]) => screeningStatuses[key] === "conflict")
        .map(([, label]) => label);
      uncertain.push(...screeningConflicts.map(label =>
        label + ": conflicting positive/negative results were found across the saved report text; administrator must verify the original report"
      ));
      setShowLabRawText(false);
      setLabOcrText(extracted);
      setLabManualReviews(pendingManualReviews);
      setLabOcrFindings([...candidates, ...uncertain.map(item => "REVIEW: " + item),
        ...pendingManualReviews.map(item => "REVIEW: " + item.test + " result not confidently recognized — admin must verify against the original report")]);
      setLabOcrOnlineHelp(onlineHelp);
      // Only a clearly recognized result changes a screening checkbox. Clear
      // negatives remove stale ticks; unreadable or conflicting results preserve
      // the current value and are flagged for manual verification.
      const applyScreeningStatus = (status: typeof screeningStatuses.hcvPlus, current: boolean | undefined) =>
        status === "positive" ? true : status === "negative" ? false : current;
      setP(prev => ({
        ...prev,
        hcvPlus: applyScreeningStatus(screeningStatuses.hcvPlus, prev.hcvPlus),
        hbaSg: applyScreeningStatus(screeningStatuses.hbaSg, prev.hbaSg),
        hiv: applyScreeningStatus(screeningStatuses.hiv, prev.hiv),
        customData: { ...(prev.customData || {}), labOcrExtractedText: extracted, labOcrPhotoSignature: photoSignature, labOcrPhotoScanComplete: "true", labOcrPipelineVersion: LAB_OCR_PIPELINE_VERSION, labOcrPossibleFlags: candidates.join("\n"), labOcrNeedsReview: uncertain.join("\n"), labOcrOnlineTestNameHelp: onlineHelp.join("\n") },
      }));
      const newlyTicked = [
        screeningStatuses.hcvPlus === "positive" && !p.hcvPlus ? "HCV+" : "",
        screeningStatuses.hbaSg === "positive" && !p.hbaSg ? "HBsAg" : "",
        screeningStatuses.hiv === "positive" && !p.hiv ? "HIV" : "",
      ].filter(Boolean);
      const newlyCleared = [
        screeningStatuses.hcvPlus === "negative" && !!p.hcvPlus ? "HCV+" : "",
        screeningStatuses.hbaSg === "negative" && !!p.hbaSg ? "HBsAg" : "",
        screeningStatuses.hiv === "negative" && !!p.hiv ? "HIV" : "",
      ].filter(Boolean);
      const screeningMessages = [
        newlyTicked.length ? "Possible positive screening result detected for " + newlyTicked.join(", ") + "; verify the original report." : "",
        newlyCleared.length ? "Clear negative/non-reactive result found; checkbox cleared for " + newlyCleared.join(", ") + ". Verify the original report." : "",
        screeningConflicts.length ? "Conflicting screening results need manual review: " + screeningConflicts.join(", ") + "." : "",
      ].filter(Boolean);
      if (screeningMessages.length) toast(screeningMessages.join(" "), "info");
      const alertCandidates = candidates.filter(row => row.startsWith("ALERT:"));
      if (!automatic) {
        const scanMessage = alertCandidates.length
          ? "Lab scan complete: " + alertCandidates.length + " result(s) need review."
          : uncertain.length
            ? "Lab scan complete: " + uncertain.length + " item(s) need manual review."
            : "Lab scan complete. Verify extracted values and dates before saving.";
        toast(scanMessage, alertCandidates.length ? "error" : uncertain.length ? "info" : "success");
      }
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
            toast("Possible abnormal lab results for " + (p.name || "this patient") + ". Review flagged rows below against the original report.", "error");
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
    queryFn: async () => {
      const mrNo = p.mrNo.trim();
      const name = p.name.trim();
      const url = "/trash/patient-match?mrNo=" + encodeURIComponent(mrNo) + "&name=" + encodeURIComponent(name);
      try {
        const direct: any = await api.get(url);
        const match = direct?.patient ? direct : direct?.match?.patient ? direct.match : direct;
        if (match?.id && match?.patient?.mrNo && match?.patient?.name) return match;
      } catch {
        // Older deployments may not expose the dedicated match endpoint.
      }
      // Fallback: inspect Trash titles so the suggestion still works on older APIs.
      try {
        const entries = await api.get<Array<{ id: string; kind: string; title: string; deleted_at: string; expires_at: string }>>("/trash");
        const norm = (value: unknown) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
        const wantedName = norm(name);
        const wantedMr = norm(mrNo);
        const entry = (Array.isArray(entries) ? entries : []).find(item => {
          const title = String(item.title || "");
          const normalizedTitle = norm(title);
          const tokens = normalizedTitle.split(" ");
          const patientKind = /patient/i.test(String(item.kind || ""));
          const hasMr = wantedMr.length > 0 && tokens.includes(wantedMr);
          return patientKind && hasMr && wantedName.length > 0 && normalizedTitle.includes(wantedName);
        });
        if (entry) return { ...entry, patient: { mrNo, name } };
      } catch {}
      return null;
    },
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
    const signature = LAB_OCR_PIPELINE_VERSION + "|" + uris.join("|");
    if (lastAutoLabScan.current === signature) return;
    const timer = setTimeout(() => {
      // Mark the set only when the scan can start; if another scan is busy,
      // analyzeLabPhotos clears this signature and the effect retries.
      lastAutoLabScan.current = signature;
      void analyzeLabPhotos(uris, true);
    }, 500);
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
    // Older API records may contain the literal strings "true"/"false".
    // Normalize them to booleans before rendering or applying OCR flags.
    const readFlag = (primary: unknown, fallback: unknown) =>
      primary === undefined || primary === null || primary === ""
        ? asBooleanFlag(fallback)
        : asBooleanFlag(primary);
    setP({
      ...source,
      photos,
      customData,
      hcvPlus: readFlag((source as any).hcvPlus, customData.hcvPlus),
      hbaSg: readFlag((source as any).hbaSg, customData.hbaSg),
      hiv: readFlag((source as any).hiv, customData.hiv),
    });
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
    const directory = String(FileSystem.documentDirectory || "") + "patient-photos/";
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true }).catch(() => {});
    // Keep patient pictures sharp while avoiding very large camera files.
    const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
      Image.getSize(sourceUri, (width, height) => resolve({ width, height }), reject);
    });
    const actions: any[] = [];
    // Preserve the selected photo's original orientation and crop. Never rotate
    // landscape photos just because they are wider than they are tall. Only
    // resize extremely large files, keeping enough pixels for small lab text.
    const longest = Math.max(dimensions.width, dimensions.height);
    if (longest > 4000) {
      actions.push(dimensions.width >= dimensions.height
        ? { resize: { width: 4000 } }
        : { resize: { height: 4000 } });
    }
    const normalized = await ImageManipulator.manipulateAsync(sourceUri, actions, {
      compress: 0.98, format: ImageManipulator.SaveFormat.JPEG,
    });
    const filename = "patient-photo-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10) + ".jpg";
    const destination = directory + filename;
    await FileSystem.copyAsync({ from: normalized.uri, to: destination });
    return destination;
  };

  // Gallery keeps multi-select. Scan Document detects page edges and straightens paper records.

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

  const openExistingPhotoForScan = async (idx: number) => {
    const uri = p.photos[idx];
    if (!uri || photoBusy) return;
    setExistingScanPickerVisible(false);
    setPerspectiveMode(false);
    setPerspectiveHtml("");
    setSelectedPhoto(null);
    setPhotoBusy(true);
    try {
      // Let the native source-picker modal finish dismissing before opening
      // the editor modal; overlapping Android modal animations can hide it.
      await new Promise<void>(resolve => setTimeout(resolve, 350));
      // Materialize restored data-URI photos before any native image view,
      // size lookup, or perspective editor tries to display them.
      const usableUri = await materializeImageUri(uri);
      setEditingPhotoIndex(idx);
      setEditingPhotoOriginal(uri);
      setEditingPhotoUri(usableUri);
      setCropRect(null);
      cropDragStartRef.current = null;
      cropResizeStartRef.current = null;
      setPhotoPreviewSize({ width: 0, height: 0 });
      loadEditingPhotoDimensions(usableUri);
      await openPerspectiveEditor(usableUri);
    } catch (e: any) {
      toast("Could not open this saved photo for document scanning. " + String(e?.message || e || "Please try again."), "error");
    } finally {
      setPhotoBusy(false);
    }
  };
  const chooseGalleryPhotoForScan = async () => {
    if (photoBusy || cameraOpen || imagePickerOpening.current) return;
    imagePickerOpening.current = true;
    setPhotoBusy(true);
    try {
      await new Promise<void>((resolve) => InteractionManager.runAfterInteractions(() => setTimeout(resolve, 120)));
      if (!(await waitForImagePickerActivity())) {
        toast("Photo picker is still starting. Please try again in a moment.", "error");
        return;
      }
      let result: ImagePicker.ImagePickerResult;
      try {
        result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ["images"], allowsEditing: false, allowsMultipleSelection: false, quality: 1,
        });
      } catch (firstError: any) {
        if (!isUnregisteredLauncherError(firstError) || !(await rearmImagePickerAfterLauncherError())) throw firstError;
        result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ["images"], allowsEditing: false, allowsMultipleSelection: false, quality: 1,
        });
      }
      if (result.canceled || !result.assets?.[0]?.uri) return;
      const permanentUri = await persistPhoto(result.assets[0].uri);
      const nextIndex = p.photos.length;
      setP(previous => ({ ...previous, photos: [...previous.photos, permanentUri] }));
      setExistingScanPickerVisible(false);
      setSelectedPhoto(null);
      await new Promise<void>(resolve => setTimeout(resolve, 350));
      setEditingPhotoIndex(nextIndex);
      setEditingPhotoOriginal(permanentUri);
      setEditingPhotoUri(permanentUri);
      setCropRect(null);
      cropDragStartRef.current = null;
      cropResizeStartRef.current = null;
      setPhotoPreviewSize({ width: 0, height: 0 });
      loadEditingPhotoDimensions(permanentUri);
      void openPerspectiveEditor(permanentUri);
    } catch (e: any) {
      toast(e?.message || "Could not open that gallery photo for document scanning.", "error");
    } finally {
      setPhotoBusy(false);
      imagePickerOpening.current = false;
    }
  };

  const captureFallbackDocument = async () => {
    if (photoBusy || cameraOpen || imagePickerOpening.current) return;
    imagePickerOpening.current = true;
    setPhotoBusy(true);
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) throw new Error("Camera permission is required. Enable it in Android Settings and try again.");
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ["images"], allowsEditing: false, quality: 1,
      });
      if (result.canceled || !result.assets?.[0]?.uri) return;
      const permanentUri = await persistPhoto(result.assets[0].uri);
      const nextIndex = p.photos.length;
      setP(previous => ({ ...previous, photos: [...previous.photos, permanentUri] }));
      setExistingScanPickerVisible(false);
      setSelectedPhoto(null);
      setEditingPhotoIndex(nextIndex);
      setEditingPhotoOriginal(permanentUri);
      setEditingPhotoUri(permanentUri);
      setCropRect(null);
      cropDragStartRef.current = null;
      cropResizeStartRef.current = null;
      setPhotoPreviewSize({ width: 0, height: 0 });
      loadEditingPhotoDimensions(permanentUri);
      void openPerspectiveEditor(permanentUri);
    } catch (e: any) {
      toast("Camera fallback failed. " + String(e?.message || e || "Please try again."), "error");
    } finally {
      setPhotoBusy(false);
      imagePickerOpening.current = false;
    }
  };

  const scanWithCameraDocuments = async () => {
    if (photoBusy || cameraOpen || imagePickerOpening.current) return;
    imagePickerOpening.current = true;
    setPhotoBusy(true);
    try {
      const scannedUris = await scanPatientDocuments();
      if (!scannedUris.length) return;
      const permanentUris: string[] = [];
      for (const uri of scannedUris) permanentUris.push(await persistPhoto(uri));
      setP(previous => ({ ...previous, photos: [...previous.photos, ...permanentUris] }));
      toast(permanentUris.length === 1 ? "Document scanned, edge-corrected and saved." : permanentUris.length + " document pages scanned, edge-corrected and saved.", "success");
    } catch (e: any) {
      const detail = String(e?.message || e || "Please try again.");
      Alert.alert(
        "Document scanner unavailable",
        "The automatic document scanner failed to open. You can capture the page with the regular camera and then correct its edges in the perspective editor." + String.fromCharCode(10,10) + detail,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Use camera fallback", onPress: () => { void captureFallbackDocument(); } },
        ],
      );
    } finally {
      setPhotoBusy(false);
      imagePickerOpening.current = false;
    }
  };

  const scanDocumentsToPatientPhotos = () => {
    if (photoBusy || cameraOpen || imagePickerOpening.current) return;
    // Always show the source chooser: users can scan saved patient photos,
    // select a new gallery image, or scan a fresh paper document with camera.
    setExistingScanPickerVisible(true);
  };

  const addFromCamera = async () => {
    // Capture patient-file documents through the native edge-detection scanner
    // so page borders and perspective are corrected automatically at capture.
    if (photoBusy || cameraOpen || imagePickerOpening.current) return;
    imagePickerOpening.current = true;
    setPhotoBusy(true);
    try {
      const scannedUris = await scanPatientDocuments();
      if (!scannedUris.length) return;
      const permanentUris: string[] = [];
      for (const uri of scannedUris) permanentUris.push(await persistPhoto(uri));
      setP(previous => ({ ...previous, photos: [...previous.photos, ...permanentUris] }));
      toast(permanentUris.length === 1
        ? "Photo captured, document edges corrected and saved."
        : permanentUris.length + " scanned pages captured, corrected and saved.", "success");
    } catch (e: any) {
      toast("Camera document scan failed. " + String(e?.message || e || "Please try again."), "error");
    } finally {
      setPhotoBusy(false);
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
  const loadEditingPhotoDimensions = (uri: string) => {
    Image.getSize(uri, (width, height) => setEditingPhotoDimensions({ width, height }), () => setEditingPhotoDimensions(null));
  };
  const materializeImageUri = async (uri: string) => {
    if (!uri.startsWith("data:image/")) return uri;
    const match = uri.match(/^data:image\/([^;]+);base64,([\s\S]+)$/i);
    if (!match?.[2]) throw new Error("The embedded photo data is invalid.");
    const directory = String(FileSystem.cacheDirectory || FileSystem.documentDirectory || "");
    if (!directory) throw new Error("Photo storage is not available.");
    const extension = match[1].toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
    const destination = directory + "patient-photo-open-" + Date.now() + "." + extension;
    await FileSystem.writeAsStringAsync(destination, match[2], { encoding: FileSystem.EncodingType.Base64 });
    return destination;
  };

  const openPerspectiveEditor = async (sourceUri: string | null = editingPhotoUri) => {
    if (!sourceUri || photoBusy) return;
    setPhotoBusy(true);
    try {
      // React Native's native image loaders and ImageManipulator do not support
      // every data: URI scheme. Convert restored embedded backup photos to a
      // local cache file before measuring or editing them.
      const usableUri = await materializeImageUri(sourceUri);
      const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) =>
        Image.getSize(usableUri, (width, height) => resolve({ width, height }), reject));
      const actions: any[] = [];
      if (Math.max(dimensions.width, dimensions.height) > 4096) {
        actions.push(dimensions.width >= dimensions.height ? { resize: { width: 4096 } } : { resize: { height: 4096 } });
      }
      const prepared = await ImageManipulator.manipulateAsync(usableUri, actions, {
        compress: 0.95, format: ImageManipulator.SaveFormat.JPEG, base64: true,
      });
      if (!prepared.base64) throw new Error("Could not prepare this photo for perspective correction.");
      setEditingPhotoUri(usableUri);
      setPerspectiveHtml(buildPerspectiveWarpHtml(prepared.base64));
      setPerspectiveMode(true);
    } catch (e: any) {
      toast("Could not open perspective correction. " + String(e?.message || e || "Please try again."), "error");
    } finally {
      setPhotoBusy(false);
    }
  };
  const handlePerspectiveMessage = async (event: any) => {
    let message: any;
    try { message = JSON.parse(String(event?.nativeEvent?.data || "{}")); } catch { return; }
    if (message?.type === "error") {
      void recordDiagnosticError(new Error(String(message.message || "Perspective correction failed.")), "Photo editor > Auto-Scan / perspective correction WebView");
      toast(String(message.message || "Perspective correction failed."), "error");
      return;
    }
    if (message?.type !== "done") return;
    setPhotoBusy(true);
    try {
      const match = String(message.dataUrl || "").match(/^data:image\/jpeg;base64,([\s\S]+)$/);
      if (!match?.[1]) throw new Error("The corrected image data was empty.");
      const directory = String(FileSystem.cacheDirectory || FileSystem.documentDirectory || "");
      if (!directory) throw new Error("Photo storage is not available.");
      const destination = directory + "patient-perspective-" + Date.now() + ".jpg";
      await FileSystem.writeAsStringAsync(destination, match[1], { encoding: FileSystem.EncodingType.Base64 });
      setEditingPhotoUri(destination);
      loadEditingPhotoDimensions(destination);
      setCropRect(null);
      setPerspectiveMode(false);
      setPerspectiveHtml("");
      toast("Perspective correction applied to this existing patient photo. Tap Save changes to keep it.", "success");
    } catch (e: any) {
      toast("Could not save the corrected preview. " + String(e?.message || e || "Please try again."), "error");
    } finally {
      setPhotoBusy(false);
    }
  };
  const openPhotoEditor = (idx: number) => {
    const uri = p.photos[idx];
    if (!uri) return;
    setSelectedPhoto(null);
    setPerspectiveMode(false);
    setPerspectiveHtml("");
    setEditingPhotoIndex(idx);
    setEditingPhotoOriginal(uri);
    setEditingPhotoUri(uri);
    setCropRect(null);
    cropDragStartRef.current = null;
    cropResizeStartRef.current = null;
    setPhotoPreviewSize({ width: 0, height: 0 });
    loadEditingPhotoDimensions(uri);
  };
  const closePhotoEditor = () => {
    if (photoBusy) return;
    setPerspectiveMode(false);
    setPerspectiveHtml("");
    setEditingPhotoIndex(null);
    setEditingPhotoOriginal(null);
    setEditingPhotoUri(null);
    setEditingPhotoDimensions(null);
    setCropRect(null);
    cropDragStartRef.current = null;
  };
  const getPhotoViewport = () => {
    const image = editingPhotoDimensions, box = photoPreviewSize;
    if (!image || image.width <= 0 || image.height <= 0 || box.width <= 0 || box.height <= 0) return null;
    const scale = Math.min(box.width / image.width, box.height / image.height);
    const width = image.width * scale, height = image.height * scale;
    return { left: (box.width - width) / 2, top: (box.height - height) / 2, width, height, scale };
  };
  const clampPhotoPoint = (x: number, y: number) => {
    const viewport = getPhotoViewport();
    if (!viewport) return { x, y };
    return {
      x: Math.max(viewport.left, Math.min(viewport.left + viewport.width, x)),
      y: Math.max(viewport.top, Math.min(viewport.top + viewport.height, y)),
    };
  };
  const startCropSelection = (event: any) => {
    if (photoBusy || !editingPhotoDimensions) return;
    const point = clampPhotoPoint(Number(event?.nativeEvent?.locationX) || 0, Number(event?.nativeEvent?.locationY) || 0);
    cropDragStartRef.current = point;
    setCropRect({ x: point.x, y: point.y, width: 1, height: 1 });
  };
  const moveCropSelection = (event: any) => {
    const start = cropDragStartRef.current;
    if (!start) return;
    const point = clampPhotoPoint(Number(event?.nativeEvent?.locationX) || 0, Number(event?.nativeEvent?.locationY) || 0);
    setCropRect({ x: Math.min(start.x, point.x), y: Math.min(start.y, point.y), width: Math.abs(point.x - start.x), height: Math.abs(point.y - start.y) });
  };
  const finishCropSelection = (event: any) => {
    moveCropSelection(event);
    cropDragStartRef.current = null;
    setCropRect(current => current && current.width >= 10 && current.height >= 10 ? current : null);
  };
  const startCropResize = (handle: string) => (event: any) => {
    if (photoBusy || !cropRect) return;
    cropDragStartRef.current = null;
    cropResizeStartRef.current = {
      rect: { ...cropRect }, handle,
      pageX: Number(event?.nativeEvent?.pageX) || 0,
      pageY: Number(event?.nativeEvent?.pageY) || 0,
    };
  };
  const moveCropResize = (event: any) => {
    const start = cropResizeStartRef.current;
    if (!start) return;
    const dx = (Number(event?.nativeEvent?.pageX) || start.pageX) - start.pageX;
    const dy = (Number(event?.nativeEvent?.pageY) || start.pageY) - start.pageY;
    const minSize = 24;
    let { x, y, width, height } = start.rect;
    const h = start.handle;
    if (h.includes("w")) { const right = x + width; x = Math.min(right - minSize, x + dx); width = right - x; }
    if (h.includes("e")) width = Math.max(minSize, width + dx);
    if (h.includes("n")) { const bottom = y + height; y = Math.min(bottom - minSize, y + dy); height = bottom - y; }
    if (h.includes("s")) height = Math.max(minSize, height + dy);
    const viewport = getPhotoViewport();
    if (viewport) {
      const rightLimit = viewport.left + viewport.width;
      const bottomLimit = viewport.top + viewport.height;
      x = Math.max(viewport.left, Math.min(x, rightLimit - minSize));
      y = Math.max(viewport.top, Math.min(y, bottomLimit - minSize));
      width = Math.max(minSize, Math.min(width, rightLimit - x));
      height = Math.max(minSize, Math.min(height, bottomLimit - y));
    }
    setCropRect({ x, y, width, height });
  };
  const finishCropResize = () => { cropResizeStartRef.current = null; };
  const editPhoto = async (action: "rotate" | "crop" | "optimize") => {
    if (!editingPhotoUri) return;
    setPhotoBusy(true);
    try {
      let actions: any[] = [];
      if (action === "rotate") actions = [{ rotate: 90 }];
      else if (action === "crop") {
        const image = editingPhotoDimensions, viewport = getPhotoViewport(), rect = cropRect;
        if (!image || !viewport || !rect || rect.width < 10 || rect.height < 10) throw new Error("Touch and drag on the image to draw the area you want to keep.");
        const originX = Math.max(0, Math.min(image.width - 1, Math.floor((rect.x - viewport.left) / viewport.scale)));
        const originY = Math.max(0, Math.min(image.height - 1, Math.floor((rect.y - viewport.top) / viewport.scale)));
        const width = Math.max(1, Math.min(image.width - originX, Math.floor(rect.width / viewport.scale)));
        const height = Math.max(1, Math.min(image.height - originY, Math.floor(rect.height / viewport.scale)));
        if (width < 10 || height < 10) throw new Error("Crop area is too small. Draw a larger rectangle.");
        actions = [{ crop: { originX, originY, width, height } }];
      } else {
        const image = editingPhotoDimensions || await new Promise<{ width: number; height: number }>((resolve, reject) =>
          Image.getSize(editingPhotoUri, (width, height) => resolve({ width, height }), reject));
        if (Math.max(image.width, image.height) > 2800) actions = [image.width >= image.height ? { resize: { width: 2800 } } : { resize: { height: 2800 } }];
      }
      const result = await ImageManipulator.manipulateAsync(editingPhotoUri, actions, {
        compress: action === "optimize" ? 0.94 : 0.92, format: ImageManipulator.SaveFormat.JPEG,
      });
      setEditingPhotoUri(result.uri);
      loadEditingPhotoDimensions(result.uri);
      setCropRect(null);
      cropDragStartRef.current = null;
      cropResizeStartRef.current = null;
      if (action === "crop") toast("Freeform crop applied. You can adjust again before saving.", "success");
      else if (action === "optimize") toast("Photo optimized for sharp display and a manageable file size.", "success");
    } catch (e: any) {
      toast(e?.message || "Could not edit photo.", "error");
    } finally {
      setPhotoBusy(false);
    }
  };
  const resetPhotoEdits = () => {
    if (photoBusy || !editingPhotoOriginal) return;
    setEditingPhotoUri(editingPhotoOriginal);
    loadEditingPhotoDimensions(editingPhotoOriginal);
    setCropRect(null);
    cropDragStartRef.current = null;
  };

  const savePhotoEdits = async () => {
    if (editingPhotoIndex === null || !editingPhotoUri) return;
    setPhotoBusy(true);
    try {
      // AI/perspective previews are first written to cache. Copy them into the
      // app's permanent documents directory before storing the URI anywhere.
      const permanent = await persistPhoto(editingPhotoUri);
      const updatedPhotos = p.photos.map((value, index) =>
        index === editingPhotoIndex ? permanent : value
      );
      const updatedPhotoUri = updatedPhotos[0] || p.photoUri || "";

      // For an existing patient, persist the photo change immediately. Previously
      // this only called setP(), so leaving the patient screen before tapping the
      // separate patient Save button discarded the enhanced photo on next open.
      // Keep the editor open if the record update fails so the user can retry.
      if (isEdit && id) {
        await api.put("/patients/" + id, {
          ...p,
          photos: updatedPhotos,
          photoUri: updatedPhotoUri,
        });
      }

      setP((current) => ({
        ...current,
        photos: current.photos.map((value, index) =>
          index === editingPhotoIndex ? permanent : value
        ),
        photoUri: updatedPhotoUri,
      }));
      toast(isEdit && id
        ? "Photo changes saved to this patient record."
        : "Photo changes saved. Save the patient record to keep them.", "success");
      setEditingPhotoIndex(null);
      setEditingPhotoOriginal(null);
      setEditingPhotoUri(null);
      setEditingPhotoDimensions(null);
      setCropRect(null);
      cropDragStartRef.current = null;
    } catch (e: any) {
      void recordDiagnosticError(e, "Patient photo editor > save AI/perspective changes");
      toast(e?.message || "Could not save photo changes. The editor is still open; please retry.", "error");
    } finally {
      setPhotoBusy(false);
    }
  };

  const save = useMutation({
    mutationFn: () => {
      // Persist the current manual lab-review entries in the same patient save
      // request. Do not rely on a prior asynchronous setP() from the Apply button.
      const reviewedLabResults = [...labManualReviews, ...labAddedResults]
        .filter(item => String(item.result || "").trim())
        .map(item => {
          const range = String(item.reference || "").match(/([-+]?\d+(?:[.,]\d+)?)\s*(?:-|–|—|to)\s*([-+]?\d+(?:[.,]\d+)?)/i);
          const min = item.min ?? (range ? Number(range[1].replace(",", ".")) : undefined);
          const max = item.max ?? (range ? Number(range[2].replace(",", ".")) : undefined);
          const value = Number(String(item.result).replace(",", "."));
          const hasRange = Number.isFinite(min) && Number.isFinite(max) && (max as number) > (min as number);
          const abnormal = hasRange && (value < (min as number) || value > (max as number));
          const boundary = hasRange ? (value < (min as number) ? (min as number) : (max as number)) : 0;
          const excursion = abnormal && boundary !== 0 ? Math.abs(value - boundary) / Math.max(Math.abs(boundary), 0.000001) * 100 : abnormal ? 100 : 0;
          const severity = abnormal && excursion > 1 ? (excursion <= labWarningThreshold ? "WARNING" : "ALERT") : "";
          return {
            test: item.test,
            result: String(item.result).trim(),
            unit: item.unit,
            reference: item.reference,
            min,
            max,
            severity,
            date: extractLabReportDate(item.reportDate || "") || extractLabReportDate(labOcrText) || item.reportDate || "",
            manuallyVerified: true,
          };
        });
      const existingLabResults = (p.customData || {}).labOcrManualResults;
      let previousReviewed: any[] = [];
      try {
        const parsed = existingLabResults ? JSON.parse(existingLabResults) : [];
        if (Array.isArray(parsed)) previousReviewed = parsed;
      } catch {}
      // Keep previously verified tests when this review session only contains
      // a subset. New values replace the same test, but never erase other tests.
      const mergedReviewed = new Map<string, any>();
      previousReviewed.forEach(item => {
        if (item && String(item.test || "").trim()) mergedReviewed.set(String(item.test).trim().toLowerCase(), item);
      });
      reviewedLabResults.forEach(item => mergedReviewed.set(String(item.test).trim().toLowerCase(), item));
      const allReviewedLabResults = [...mergedReviewed.values()];
      const customData = {
        ...(p.customData || {}),
        hcvPlus: p.hcvPlus ? "true" : "false",
        hbaSg: p.hbaSg ? "true" : "false",
        hiv: p.hiv ? "true" : "false",
        ...((reviewedLabResults.length || !existingLabResults) ? {
          labOcrManualResults: JSON.stringify(allReviewedLabResults),
        } : {}),
      };
      const payload = { ...p, customData };
      return isEdit ? api.put("/patients/" + id, payload) : api.post("/patients", payload);
    },
    onSuccess: async (savedPatient: Patient) => {
      if (!isEdit && savedPatient?.id) {
        try {
          const queueKey = "ortho_lab_ocr_new_patient_queue_v1";
          const rawQueue = await AsyncStorage.getItem(queueKey);
          let queued: string[] = [];
          try { const parsed = rawQueue ? JSON.parse(rawQueue) : []; if (Array.isArray(parsed)) queued = parsed.map(String); } catch {}
          if (!queued.includes(String(savedPatient.id))) queued.push(String(savedPatient.id));
          await AsyncStorage.setItem(queueKey, JSON.stringify(queued));
        } catch {}
      }
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
        <View style={{ marginTop: spacing.sm, marginBottom: spacing.sm, padding: spacing.md, borderWidth: 1, borderColor: colors.brandPrimary, borderRadius: radius.md, backgroundColor: colors.surfaceSecondary }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.xs }}>
            <Ionicons name="sparkles" size={22} color={colors.brandPrimary} />
            <Text style={{ color: colors.brandPrimary, fontFamily: fontFamily.bold, fontSize: fontSize.base }}>AI IMAGE TOOLS</Text>
          </View>
          <Text style={{ color: colors.onSurfaceSecondary, fontSize: fontSize.xs, marginBottom: spacing.sm }}>
            Enhance, auto-detect document edges, and correct perspective on photos already saved in this patient file. Processing stays on this phone; AI model setup needs internet once.
          </Text>
          <Pressable
            style={[styles.secondary, { backgroundColor: colors.brandPrimary, justifyContent: "center" }, photoBusy && { opacity: 0.5 }]}
            onPress={scanDocumentsToPatientPhotos}
            disabled={photoBusy || cameraOpen}
            testID="open-ai-image-tools-button"
            accessibilityRole="button"
            accessibilityLabel="AI enhance and auto-scan existing patient images"
          >
            <Ionicons name="sparkles" size={19} color={colors.onBrandPrimary} />
            <Text style={[styles.secondaryText, { color: colors.onBrandPrimary, fontFamily: fontFamily.bold }]}> Scan Existing Images</Text>
          </Pressable>
        </View>
        <View style={styles.photoActions}>
          <PrimaryButton title={"Add from Gallery" + (p.photos.length ? " (+)" : "")} onPress={addFromLibrary} disabled={!imagePickerReady || photoBusy} testID="add-photo-library-button" />
          <Pressable style={[styles.secondary, photoBusy && { opacity: 0.5 }]} onPress={scanDocumentsToPatientPhotos} disabled={photoBusy || cameraOpen} testID="scan-patient-document-button">
            <Ionicons name="scan-outline" size={18} color={colors.brandPrimary} />
            <Text style={styles.secondaryText}> {photoBusy ? "Processing…" : (p.photos.length ? "Scan Existing Photo" : "Scan Document")}</Text>
          </Pressable>
          <Pressable style={[styles.secondary, photoBusy && { opacity: 0.5 }]} onPress={addFromCamera} disabled={photoBusy || cameraOpen} testID="add-photo-camera-button">
            <Ionicons name="camera" size={18} color={colors.onSurface} />
            <Text style={styles.secondaryText}> Take & Auto-Scan</Text>
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

        <Modal visible={existingScanPickerVisible} transparent animationType="fade" onRequestClose={() => setExistingScanPickerVisible(false)}>
          <View style={styles.photoEditOverlay}>
            <View style={[styles.photoEditCard, { maxHeight: "82%" }]}>
              <View style={styles.photoEditHeader}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.photoEditTitle}>Scan Existing Patient Images</Text>
                  <Text style={styles.photoEditHint}>Select any image already saved in this patient file. Auto-Scan Page and manual perspective correction are available in the editor.</Text>
                </View>
                <Pressable onPress={() => setExistingScanPickerVisible(false)} style={styles.photoEditIconButton}>
                  <Ionicons name="close" size={22} color={colors.onSurface} />
                </Pressable>
              </View>
              <Pressable style={styles.photoSaveButton} onPress={() => { void chooseGalleryPhotoForScan(); }} disabled={photoBusy}>
                <Text style={styles.photoSaveText}>{photoBusy ? "Opening gallery…" : "Choose a Gallery Photo to Scan"}</Text>
              </Pressable>
              <Pressable style={styles.photoCancelButton} onPress={() => { setExistingScanPickerVisible(false); void scanWithCameraDocuments(); }} disabled={photoBusy}>
                <Text style={styles.photoCancelText}>Scan a New Paper with Camera</Text>
              </Pressable>
              <ScrollView contentContainerStyle={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
                {p.photos.map((uri, idx) => (
                  <Pressable key={uri + "-scan-" + idx} onPress={() => openExistingPhotoForScan(idx)} disabled={photoBusy} style={{ width: "30%", minWidth: 84, marginBottom: spacing.sm }}>
                    <Image source={{ uri }} style={{ width: "100%", height: 112, borderRadius: radius.sm, backgroundColor: colors.surfaceTertiary }} resizeMode="contain" />
                    <Text style={{ color: colors.onSurface, fontSize: fontSize.xs, textAlign: "center", marginTop: 4 }}>Photo {idx + 1}</Text>
                  </Pressable>
                ))}
              </ScrollView>
              <Pressable style={styles.photoCancelButton} onPress={() => setExistingScanPickerVisible(false)}>
                <Text style={styles.photoCancelText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        </Modal>

        <Modal visible={editingPhotoIndex !== null} transparent animationType="fade" onRequestClose={closePhotoEditor}>
          <View style={styles.photoEditOverlay}>
            <View style={[styles.photoEditCard, perspectiveMode && { height: "88%", maxHeight: "88%", width: "96%", padding: spacing.sm }]}>
              {perspectiveMode ? (
                <View style={{ flex: 1, minHeight: 0, flexShrink: 1 }}>
                  <View style={styles.photoEditHeader}>
                    <View>
                      <Text style={styles.photoEditTitle}>AI IMAGE TOOLS · PERSPECTIVE CORRECTION</Text>
                      <Text style={styles.photoEditHint}>Move all four corners to the paper edges, then apply the correction.</Text>
                    </View>
                    <Pressable onPress={() => { setPerspectiveMode(false); setPerspectiveHtml(""); }} disabled={photoBusy} style={styles.photoEditIconButton}>
                      <Ionicons name="close" size={22} color={colors.onSurface} />
                    </Pressable>
                  </View>
                  
                  <View style={{ flexDirection: "row", gap: spacing.sm, marginBottom: spacing.xs }}>
                    <Pressable
                      style={[styles.secondary, { flex: 1, backgroundColor: colors.surfaceSecondary }]}
                      disabled={photoBusy}
                      onPress={() => perspectiveWebViewRef.current?.injectJavaScript('document.getElementById("autoScan").click(); true;')}
                      testID="auto-scan-existing-photo-button"
                    >
                      <Ionicons name="scan-outline" size={18} color={colors.brandPrimary} />
                      <Text style={styles.secondaryText}> Auto-Scan Page</Text>
                    </Pressable>
                    
                  </View>
                  <View style={{ flex: 1, minHeight: 0, overflow: "hidden", borderRadius: radius.md, backgroundColor: "#141414", marginBottom: spacing.xs }}>
                    <WebView
                      ref={perspectiveWebViewRef}
                      source={{ html: perspectiveHtml }}
                      originWhitelist={["*"]}
                      javaScriptEnabled
                      scrollEnabled={false}
                      style={{ flex: 1, backgroundColor: "#141414" }}
                      onMessage={handlePerspectiveMessage}
                    />
                  </View>
                  <Text style={{ color: colors.muted, fontSize: fontSize.xs, marginBottom: spacing.xs }}>Original photo stays unchanged until you tap Save changes.</Text>
                  <Pressable style={[styles.secondary, { minHeight: 44, height: 44, width: "100%", backgroundColor: colors.surfaceSecondary }]} disabled={photoBusy} onPress={() => { setPerspectiveMode(false); setPerspectiveHtml(""); }}>
                    <Ionicons name="arrow-back" size={18} color={colors.onSurface} />
                    <Text style={styles.secondaryText}>Back to photo editor</Text>
                  </Pressable>
                </View>
              ) : (
                <>
              <View style={styles.photoEditHeader}>
                <View>
                  <Text style={styles.photoEditTitle}>Edit Patient Photo</Text>
                  <Text style={styles.photoEditHint}>Rotate or crop, then save when you are satisfied.</Text>
                </View>
                <Pressable onPress={closePhotoEditor} disabled={photoBusy} style={styles.photoEditIconButton}>
                  <Ionicons name="close" size={22} color={colors.onSurface} />
                </Pressable>
              </View>

              <View
                style={styles.photoEditPreviewWrap}
                onLayout={event => setPhotoPreviewSize({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}
                onStartShouldSetResponder={() => !photoBusy && !!editingPhotoDimensions}
                onMoveShouldSetResponder={() => !photoBusy && !!cropDragStartRef.current}
                onResponderGrant={startCropSelection}
                onResponderMove={moveCropSelection}
                onResponderRelease={finishCropSelection}
                onResponderTerminate={() => { cropDragStartRef.current = null; }}
              >
                {editingPhotoUri ? <Image source={{ uri: editingPhotoUri }} style={styles.photoEditPreview} resizeMode="contain" /> : null}
                {cropRect ? (
                  <View pointerEvents="box-none" style={[styles.cropSelection, { left: cropRect.x, top: cropRect.y, width: cropRect.width, height: cropRect.height }]}>
                    <View pointerEvents="none" style={styles.cropOutline} />
                    {[
                      { key: "nw", style: { left: -9, top: -9 } },
                      { key: "n", style: { left: "50%" as const, top: -5, marginLeft: -14 } },
                      { key: "ne", style: { right: -9, top: -9 } },
                      { key: "e", style: { right: -5, top: "50%" as const, marginTop: -14 } },
                      { key: "se", style: { right: -9, bottom: -9 } },
                      { key: "s", style: { left: "50%" as const, bottom: -5, marginLeft: -14 } },
                      { key: "sw", style: { left: -9, bottom: -9 } },
                      { key: "w", style: { left: -5, top: "50%" as const, marginTop: -14 } },
                    ].map(handle => (
                      <View key={handle.key}
                        style={[styles.cropHandle, handle.style]}
                        onStartShouldSetResponder={() => !photoBusy}
                        onMoveShouldSetResponder={() => !photoBusy}
                        onResponderGrant={startCropResize(handle.key)}
                        onResponderMove={moveCropResize}
                        onResponderRelease={finishCropResize}
                        onResponderTerminate={finishCropResize}
                      />
                    ))}
                  </View>
                ) : (
                  <View pointerEvents="none" style={styles.cropInstruction}>
                    <Text style={styles.cropInstructionText}>Drag to draw a crop. Then drag any corner or side handle to fine-tune it</Text>
                  </View>
                )}
              </View>
              <Text style={styles.photoCropHelp}>Images are automatically rotated to portrait and saved at high quality. Use Scan Document or Take & Auto-Scan for edge detection and perspective correction. Drag any corner or side of the crop frame to adjust it.</Text>

              <View style={styles.photoEditActions}>
                <Pressable style={styles.photoTool} disabled={photoBusy} onPress={() => editPhoto("rotate")}>
                  <Ionicons name="refresh-outline" size={20} color={colors.onSurface} />
                  <Text style={styles.photoToolText}>Rotate 90°</Text>
                </Pressable>
                <Pressable style={styles.photoTool} disabled={photoBusy} onPress={() => editPhoto("crop")}>
                  <Ionicons name="crop-outline" size={20} color={colors.onSurface} />
                  <Text style={styles.photoToolText}>Apply Free Crop</Text>
                </Pressable>
                <Pressable style={styles.photoTool} disabled={photoBusy} onPress={() => { void openPerspectiveEditor(); }}>
                  <Ionicons name="scan-outline" size={20} color={colors.brandPrimary} />
                  <Text style={styles.photoToolText}>Auto-Scan Page</Text>
                </Pressable>
                <Pressable style={styles.photoTool} disabled={photoBusy} onPress={() => editPhoto("optimize")}>
                  <Ionicons name="sparkles-outline" size={20} color={colors.brandPrimary} />
                  <Text style={styles.photoToolText}>Optimize Photo</Text>
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
                </>
              )}
            </View>
          </View>
        </Modal>
        <View style={{ marginTop: spacing.md, marginBottom: spacing.md, padding: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md }}>
          <Pressable testID="patient-lab-results-toggle" onPress={() => setLabDetailsExpanded(value => !value)} accessibilityRole="button" accessibilityLabel={labDetailsExpanded ? "Hide lab result entry" : "Show lab result entry"} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm }}>
            <View style={{ flex: 1 }}>
              <Text style={styles.section}>Lab results for this patient</Text>
              <Text style={{ color: colors.onSurfaceSecondary, fontSize: fontSize.xs }}>{savedManualLabResults.length} saved · {labAddedResults.length + labManualReviews.length} pending · Tap to {labDetailsExpanded ? "hide" : "show"}</Text>
            </View>
            <Ionicons name={labDetailsExpanded ? "chevron-up" : "chevron-down"} size={21} color={colors.brandPrimary} />
          </Pressable>
          {labDetailsExpanded ? <View>
          <Text style={styles.hint}>Choose an admin-defined test or add a patient-specific test. Enter the measured result and report date. Saved reference ranges are used when available; these entries are saved with this patient record.</Text>
          {labTestTemplates.length ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, marginTop: spacing.xs }}>
            {labTestTemplates.map(template => <Pressable key={template.id} onPress={() => {
              const male = /^(?:m|male)$/i.test(String(p.gender || "").trim());
              const female = /^(?:f|female)$/i.test(String(p.gender || "").trim());
              const minText = male ? template.maleMin : female ? template.femaleMin : "";
              const maxText = male ? template.maleMax : female ? template.femaleMax : "";
              const min = minText.trim() ? Number(minText) : undefined;
              const max = maxText.trim() ? Number(maxText) : undefined;
              const reference = minText.trim() && maxText.trim() ? minText + "–" + maxText : "";
              setLabAddedResults(previous => [...previous, { test: template.name, unit: template.unit || "", result: "", reference, photoUri: "", reportDate: today(), min: Number.isFinite(min) ? min : undefined, max: Number.isFinite(max) ? max : undefined }]);
            }} style={{ borderWidth: 1, borderColor: colors.brandPrimary, borderRadius: radius.md, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs }}>
              <Text style={{ color: colors.brandPrimary, fontFamily: fontFamily.semibold, fontSize: fontSize.sm }}>+ {template.name}</Text>
            </Pressable>)}
          </View> : <Text style={{ color: colors.onSurfaceSecondary, marginTop: spacing.xs }}>No test templates yet. An administrator can create them in Settings → Lab Test Reference Ranges.</Text>}
          <Text style={[styles.label, { marginTop: spacing.md }]}>Add an individual test</Text>
          <Field label="Test name" value={manualTestName} onChangeText={setManualTestName} placeholder="e.g. Vitamin D" />
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            <View style={{ flex: 1 }}><Field label="Unit" value={manualTestUnit} onChangeText={setManualTestUnit} placeholder="e.g. ng/mL" /></View>
            <View style={{ flex: 1 }}><Field label="Result" value={manualTestResult} onChangeText={setManualTestResult} keyboardType="decimal-pad" inputMode="decimal" selectTextOnFocus placeholder="Measured value" /></View>
          </View>
          <Field label="Reference range (optional)" value={manualTestReference} onChangeText={setManualTestReference} placeholder="e.g. 20–50" />
          <Field label="Report date (DD-MMM-YYYY)" value={manualTestDate} onChangeText={setManualTestDate} placeholder="DD-MMM-YYYY" />
          <Pressable onPress={() => {
            const test = manualTestName.trim();
            const result = manualTestResult.trim().replace(",", ".");
            if (!test || !result || !Number.isFinite(Number(result))) { toast("Enter a test name and a numeric result.", "error"); return; }
            const range = manualTestReference.match(/([-+]?\d+(?:[.,]\d+)?)\s*(?:-|–|—|to)\s*([-+]?\d+(?:[.,]\d+)?)/i);
            setLabAddedResults(previous => [...previous, { test, unit: manualTestUnit.trim(), result, reference: manualTestReference.trim(), photoUri: "", reportDate: manualTestDate.trim(), min: range ? Number(range[1].replace(",", ".")) : undefined, max: range ? Number(range[2].replace(",", ".")) : undefined }]);
            setManualTestName(""); setManualTestUnit(""); setManualTestResult(""); setManualTestReference(""); setManualTestDate(today());
            toast("Test added to this patient's draft. Save/Update Record to keep it.", "success");
          }} style={{ marginTop: spacing.xs, padding: spacing.md, backgroundColor: colors.brandPrimary, borderRadius: radius.md, alignItems: "center" }}>
            <Text style={{ color: colors.onBrandPrimary, fontFamily: fontFamily.semibold }}>Add individual test</Text>
          </Pressable>
          {labAddedResults.length ? <View style={{ marginTop: spacing.md }}>
            <Text style={styles.label}>Tests waiting to save ({labAddedResults.length})</Text>
            {labAddedResults.map((item, index) => <View key={item.test + "-" + index} style={{ borderTopWidth: 1, borderColor: colors.border, paddingTop: spacing.sm, marginTop: spacing.sm }}>
              <Text style={{ color: colors.onSurface, fontFamily: fontFamily.semibold }}>{item.test}{item.unit ? " (" + item.unit + ")" : ""}</Text>
              <Field label="Result" value={item.result} onChangeText={value => setLabAddedResults(previous => previous.map((row, rowIndex) => rowIndex === index ? { ...row, result: value.replace(",", ".").replace(/[^0-9.]/g, "") } : row))} keyboardType="decimal-pad" inputMode="decimal" selectTextOnFocus />
              <Field label="Report date (DD-MMM-YYYY)" value={item.reportDate || ""} onChangeText={value => setLabAddedResults(previous => previous.map((row, rowIndex) => rowIndex === index ? { ...row, reportDate: value } : row))} />
              {item.reference ? <Text style={{ color: colors.onSurfaceSecondary, fontSize: fontSize.sm }}>Saved reference range: {item.reference}</Text> : <Text style={{ color: colors.onSurfaceSecondary, fontSize: fontSize.sm }}>No reference range saved; result will not be automatically classified.</Text>}
              <Pressable onPress={() => setLabAddedResults(previous => previous.filter((_, rowIndex) => rowIndex !== index))} style={{ alignSelf: "flex-start", paddingVertical: spacing.xs }}>
                <Text style={{ color: colors.error, fontFamily: fontFamily.semibold }}>Remove test</Text>
              </Pressable>
            </View>)}
          </View> : null}
          {savedManualLabResults.length ? <View style={{ marginTop: spacing.md }}>
            <Text style={styles.label}>Saved results</Text>
            {savedManualLabResults.map((item: any, index: number) => <Text key={String(item.test) + "-" + index} style={{ color: colors.onSurface, fontSize: fontSize.sm, marginTop: spacing.xs }}>
              {String(item.test || "Test")}: {String(item.result || "")}{item.unit ? " " + String(item.unit) : ""}{item.date ? " · " + String(item.date) : item.reportDate ? " · " + String(item.reportDate) : ""}{item.severity ? " · " + String(item.severity) : ""}
            </Text>)}
          </View> : null}
          </View> : null}
        </View>
        {labOcrEnabled ? (
          <View style={{ marginTop: spacing.md, marginBottom: spacing.md }}>
            <Text style={styles.section}>Automatic lab report check</Text>
            <Text style={styles.hint}>{labOcrBusy ? "Checking saved pictures for lab reports…" : "Saved photos are checked automatically. Unchanged photos use the previous scan to keep the app responsive; use Rescan if a clear test name or result was missed."}</Text>
            <Pressable disabled={labOcrBusy || !p.photos.length} onPress={() => { lastAutoLabScan.current = ""; void analyzeLabPhotos([...new Set(p.photos)], false, true); }} style={{ alignSelf: "flex-start", marginTop: spacing.xs, paddingVertical: spacing.sm, paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md }}>
              <Text style={{ color: colors.brandPrimary, fontFamily: fontFamily.semibold }}>{labOcrBusy ? "Scanning…" : "Rescan lab photos"}</Text>
            </Pressable>
            {labOcrText ? <View style={{ marginTop: spacing.sm, padding: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md }}>
              {labOcrFindings.length ? <><Text style={[styles.label, { marginTop: spacing.xs }]}>Lab results to verify</Text>{labOcrFindings.map((finding, i) => { const isWarning = finding.startsWith("WARNING:"); const tone = isWarning ? (colors.warning || "#B7791F") : (colors.error || "#B91C1C"); return <Text key={i} style={{ color: tone, marginTop: spacing.xs, fontFamily: isWarning ? fontFamily.medium : fontFamily.bold }}>{finding}</Text>; })}</> : <Text style={{ color: colors.onSurfaceSecondary, marginTop: spacing.sm }}>{labWarningsEnabled ? "No confirmed out-of-range result was extracted. OCR can miss abnormal values; verify every printed test and date against the original image. If any row is unreadable or missing a saved reference range, ask an administrator to review it." : "No larger alerts were detected. Mild warnings are disabled in Settings; this does not prove that every result is normal."}</Text>}
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
                    <Field label="Report date (DD-MMM-YYYY)" value={item.reportDate || ""} onChangeText={(value: string) => setLabManualReviews(previous => previous.map((row, rowIndex) => rowIndex === index ? { ...row, reportDate: value } : row))} placeholder="e.g. 06-Oct-2026" />
                    {item.reference ? <Text style={{ color: colors.onSurfaceSecondary, marginTop: spacing.xs }}>Reference range: {item.reference}</Text> : <Text style={{ color: colors.onSurfaceSecondary, marginTop: spacing.xs }}>No saved reference range available. Compare with the printed range.</Text>}
                    {hasValue ? <Text style={{ color: abnormal ? (colors.error || "#B91C1C") : colors.onSurfaceSecondary, marginTop: spacing.xs, fontFamily: abnormal ? fontFamily.bold : fontFamily.regular }}>{abnormal ? "Outside the saved reference range — verify promptly with a qualified clinician." : item.min !== undefined && item.max !== undefined ? "Within the saved reference range; still verify the source and units." : "Value entered. Verify against the printed reference range."}</Text> : null}
                  </View>;
                }) : null}
                {user?.role === "admin" ? <Pressable onPress={() => {
                  const manual = labManualReviews.filter(item => item.result.trim()).map(item => {
                    const range = String(item.reference || "").match(/([-+]?\d+(?:[.,]\d+)?)\s*(?:-|–|—|to)\s*([-+]?\d+(?:[.,]\d+)?)/i);
                    const min = item.min ?? (range ? Number(range[1].replace(",", ".")) : undefined);
                    const max = item.max ?? (range ? Number(range[2].replace(",", ".")) : undefined);
                    const value = Number(item.result.replace(",", "."));
                    const hasRange = Number.isFinite(min) && Number.isFinite(max) && (max as number) > (min as number);
                    const abnormal = hasRange && (value < (min as number) || value > (max as number));
                    const boundary = hasRange ? (value < (min as number) ? (min as number) : (max as number)) : 0;
                    const excursion = abnormal && boundary !== 0 ? Math.abs(value - boundary) / Math.abs(boundary) * 100 : abnormal ? 100 : 0;
                    const severity = abnormal && excursion > 1 ? (excursion <= labWarningThreshold ? "WARNING" : "ALERT") : "";
                    return { test: item.test, result: item.result.trim(), unit: item.unit, reference: item.reference, date: extractLabReportDate(item.reportDate || "") || extractLabReportDate(labOcrText) || item.reportDate || "", min, max, severity, manuallyVerified: true };
                  });
                  if (!manual.length) {
                    toast("Enter at least one lab result before applying manual review.", "error");
                    return;
                  }
                  setP(previous => ({ ...previous, customData: { ...(previous.customData || {}), labOcrManualResults: JSON.stringify(manual) } }));
                  const abnormal = manual.filter(item => item.severity);
                  const findings = manual.filter(item => item.severity).map(item => item.severity + ": " + item.test + " " + item.result + (item.unit ? " " + item.unit : "") + (item.date ? " | Date: " + item.date : "") + " | Ref: " + (item.reference || "not available"));
                  setLabOcrFindings(previous => [...previous.filter(row => !/^(?:WARNING|ALERT|VERIFIED):/.test(row)), ...findings]);
                  if (abnormal.length) {
                    const alertItems = abnormal.map(item => item.severity + ": " + item.test + " = " + item.result + (item.unit ? " " + item.unit : "") + " (reference " + (item.reference || "not available") + ")");
                    Alert.alert("Manual lab review: out-of-range result", alertItems.join("\n") + "\n\nVerify the value, unit and printed reference range against the original report. This is a range comparison, not a diagnosis.");
                  } else {
                    Alert.alert("Manual lab review applied", "The entered values were attached to this patient draft. No out-of-range result was confirmed from the available reference ranges. Save or update the patient record to keep these values.");
                  }
                  toast("Manual lab results attached to this patient draft. Save or update the patient record to keep them.", "success");
                }} style={{ marginTop: spacing.md, padding: spacing.md, backgroundColor: colors.brandPrimary, borderRadius: radius.md, alignItems: "center" }}>
                  <Text style={{ color: colors.onBrandPrimary, fontFamily: fontFamily.semibold }}>Apply manual review to patient draft</Text>
                </Pressable> : null}
              </View> : null}
              {labOcrOnlineHelp.length ? <><Text style={[styles.label, { marginTop: spacing.md }]}>Test-name reference assistance</Text><Text style={{ color: colors.onSurfaceSecondary, marginTop: spacing.xs }}>Only non-identifying test-name labels are checked. No photo, patient details, report text, result values or units are uploaded. This assistance does not confirm whether a result is normal.</Text>{labOcrOnlineHelp.map((item, i) => <Text key={i} style={{ color: colors.onSurface, marginTop: spacing.xs }}>{item}</Text>)}</> : null}
            </View> : null}
          </View>
        ) : null}
        {savedManualLabResults.some((item: any) => {
          const range = String(item.reference || "").match(/([-+]?\d+(?:[.,]\d+)?)\s*(?:-|–|—|to)\s*([-+]?\d+(?:[.,]\d+)?)/i);
          const min = Number(String(item.min ?? (range ? range[1] : "")).replace(",", "."));
          const max = Number(String(item.max ?? (range ? range[2] : "")).replace(",", "."));
          const value = Number(String(item.result || "").replace(",", "."));
          const deviation = value < min ? Math.abs(value - min) / Math.max(Math.abs(min), 0.000001) * 100 : Math.abs(value - max) / Math.max(Math.abs(max), 0.000001) * 100;
          return Number.isFinite(value) && Number.isFinite(min) && Number.isFinite(max) && max > min && (value < min || value > max) && deviation > 1;
        }) ? (
          <View style={{ marginTop: spacing.md, padding: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md }}>
            <Text style={styles.section}>Abnormal manually verified lab results</Text>
            <Text style={styles.hint}>Only results outside the saved reference range by more than 1% are shown here.</Text>
            {savedManualLabResults.filter((item: any) => {
              const range = String(item.reference || "").match(/([-+]?\d+(?:[.,]\d+)?)\s*(?:-|–|—|to)\s*([-+]?\d+(?:[.,]\d+)?)/i);
              const min = Number(String(item.min ?? (range ? range[1] : "")).replace(",", "."));
              const max = Number(String(item.max ?? (range ? range[2] : "")).replace(",", "."));
              const value = Number(String(item.result || "").replace(",", "."));
              const deviation = value < min ? Math.abs(value - min) / Math.max(Math.abs(min), 0.000001) * 100 : Math.abs(value - max) / Math.max(Math.abs(max), 0.000001) * 100;
              return Number.isFinite(value) && Number.isFinite(min) && Number.isFinite(max) && max > min && (value < min || value > max) && deviation > 1;
            }).map((item: any, index: number) => {
              const range = String(item.reference || "").match(/([-+]?\d+(?:[.,]\d+)?)\s*(?:-|–|—|to)\s*([-+]?\d+(?:[.,]\d+)?)/i);
              const min = Number(String(item.min ?? (range ? range[1] : "")).replace(",", "."));
              const max = Number(String(item.max ?? (range ? range[2] : "")).replace(",", "."));
              const value = Number(String(item.result || "").replace(",", "."));
              const outside = !!range && Number.isFinite(value) && Number.isFinite(min) && Number.isFinite(max) && (value < min || value > max);
              const updateSavedManualResult = (field: string, nextValue: string) => {
                const current = [...savedManualLabResults];
                const updated = { ...current[index], [field]: nextValue };
                const referenceMatch = String(updated.reference || "").match(/([-+]?\d+(?:[.,]\d+)?)\s*(?:-|–|—|to)\s*([-+]?\d+(?:[.,]\d+)?)/i);
                const minValue = referenceMatch ? Number(referenceMatch[1].replace(",", ".")) : Number(updated.min);
                const maxValue = referenceMatch ? Number(referenceMatch[2].replace(",", ".")) : Number(updated.max);
                const resultValue = Number(String(updated.result || "").replace(",", "."));
                updated.min = Number.isFinite(minValue) ? minValue : undefined;
                updated.max = Number.isFinite(maxValue) ? maxValue : undefined;
                const hasRange = Number.isFinite(minValue) && Number.isFinite(maxValue) && maxValue > minValue;
                const outside = hasRange && Number.isFinite(resultValue) && (resultValue < minValue || resultValue > maxValue);
                const boundary = resultValue < minValue ? minValue : maxValue;
                const deviation = outside ? Math.abs(resultValue - boundary) / Math.max(Math.abs(boundary), 0.000001) * 100 : 0;
                updated.severity = outside ? (deviation <= labWarningThreshold ? "WARNING" : "ALERT") : "";
                current[index] = updated;
                const nextCustomData = { ...(p.customData || {}), labOcrManualResults: JSON.stringify(current) };
                setP(previous => ({ ...previous, customData: nextCustomData }));
              };
              return <View key={String(item.test) + "-" + index} style={{ marginTop: spacing.sm, paddingTop: spacing.sm, borderTopWidth: index ? 1 : 0, borderColor: colors.border }}>
                <Text style={{ color: outside ? (colors.error || "#B91C1C") : colors.onSurface, fontFamily: outside ? fontFamily.bold : fontFamily.regular, marginBottom: spacing.xs }}>
                  {String(item.severity || "ALERT").toUpperCase()} — OUT OF RANGE
                </Text>
                <Field label="Test name" value={String(item.test || "")} onChangeText={(value: string) => updateSavedManualResult("test", value)} />
                <Field label="Result" value={String(item.result || "")} onChangeText={(value: string) => updateSavedManualResult("result", value)} keyboardType="decimal-pad" inputMode="decimal" selectTextOnFocus />
                <Field label="Unit" value={String(item.unit || "")} onChangeText={(value: string) => updateSavedManualResult("unit", value)} />
                <Field label="Reference range" value={String(item.reference || "")} onChangeText={(value: string) => updateSavedManualResult("reference", value)} />
                <Text style={{ color: colors.onSurfaceSecondary, marginTop: spacing.xs, fontSize: fontSize.sm }}>Changes are included when you press Save/Update Record.</Text>
              </View>;
            })}
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
              case "date": return <Field key={key} label="Date" testID="patient-date-input" value={p.date} onChangeText={set("date")} placeholder="DD-MMM-YYYY" />;
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
            onPress={() => setP(prev => ({ ...prev, [key]: !asBooleanFlag(prev[key]) }))}
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
  cropSelection: { position: "absolute", borderWidth: 1.5, borderColor: "#FFFFFF", backgroundColor: "rgba(255,255,255,0.05)" },
  cropOutline: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, borderWidth: 1.5, borderColor: "#FFFFFF", backgroundColor: "rgba(255,255,255,0.05)" },
  cropHandle: { position: "absolute", width: 18, height: 18, borderRadius: 5, borderWidth: 2, borderColor: "#FFFFFF", backgroundColor: "#2563EB", zIndex: 20 },
  cropInstruction: { position: "absolute", left: spacing.md, right: spacing.md, bottom: spacing.md, alignItems: "center", backgroundColor: "rgba(0,0,0,0.62)", borderRadius: radius.md, padding: spacing.sm },
  cropInstructionText: { color: "#FFFFFF", fontFamily: fontFamily.semibold, fontSize: fontSize.xs, textAlign: "center" },
  photoCropHelp: { fontFamily: fontFamily.regular, fontSize: fontSize.xs, color: colors.muted, lineHeight: 17, marginBottom: spacing.md },
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
