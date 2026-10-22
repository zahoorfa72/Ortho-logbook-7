import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import * as CameraPermissions from "expo-camera";
import { CameraView } from "expo-camera";
import * as ImageManipulator from "expo-image-manipulator";
import * as Sharing from "expo-sharing";
import { Asset, requestPermissionsAsync } from "expo-media-library";
import * as FileSystem from "expo-file-system/legacy";
import { convert as convertPdfPagesToImages } from "@uzimandias/react-native-pdf-to-image";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { extractLabReportDate, hasKnownLabTestName, isLabMetadataLine, isLikelyLabReportText, parseLabReportRows, recognizeLabText } from "@/src/utils/lab-ocr";
import { fetchTrustedMedicalTestInfo, isMedicalTestInfoFresh, LAB_TEST_DEFINITIONS_KEY, MEDICAL_INFO_CACHE_KEY, medicalInfoCacheKey, type MedicalTestOnlineInfo } from "@/src/utils/medical-test-info";
import { triggerAutomaticDriveBackup } from "@/src/utils/storage/drive-auto-backup";
import { detectScreeningStatuses, detectCustomScreeningStatus } from "@/src/utils/screening-status";
import { buildPerspectiveWarpHtml } from "@/src/utils/perspective-warp";
import { recordDiagnosticError } from "@/src/utils/problem-report";
import { Dimensions } from "react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Animated, AppState, Image, InteractionManager, Linking, Modal, Pressable, ScrollView, Text, View } from "react-native";
import { PinchGestureHandler, State as GestureState } from "react-native-gesture-handler";
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
import { archivePatientImagesForPatient, createPatientImagePdfFile, getPatientImageArchive, openPatientImageArchivePdf } from "@/src/utils/storage/patient-image-archive";
import { deletePatientImagePdfFromDrive, downloadPatientImageArchiveForPatient, uploadPatientImageArchivesToDrive } from "@/src/utils/storage/google-drive";
import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";
const LAB_OCR_PIPELINE_VERSION = "row-safe-2026-10-20-v15-fm-sex-range-tiny-text-retry";
const CUSTOM_SCREENING_BOXES_KEY = "ortho_custom_screening_boxes_v1";
type CustomScreeningBox = { id: string; label: string };

type Patient = {
  id: string; mrNo: string; name: string; gender: string; age: string;
  diagnosis: string; procedure: string; procedureII?: string; implant: string; implantII: string; implants?: SelectedImplant[];
  address: string; fileName: string; photoUri: string; photos: string[]; date: string;
  operationCount?: number; totalOperations?: number; customData?: Record<string,string>;
  hcvPlus?: boolean; hbaSg?: boolean; hiv?: boolean; mp?: boolean; dengue?: boolean;
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
  hcvPlus: false, hbaSg: false, hiv: false, mp: false, dengue: false,
});

export default function PatientForm() {
  const styles = useStyles();
  const { colors, branding } = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const qc = useQueryClient();
  const { user } = useAuth();
  const { id, downloadDriveImages } = useLocalSearchParams<{ id?: string; downloadDriveImages?: string }>();
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
  const [patientArchiveAvailable, setPatientArchiveAvailable] = useState(false);
  const [patientArchiveOnDrive, setPatientArchiveOnDrive] = useState(false);
  useFocusEffect(useCallback(() => {
    let active = true;
    if (!id) {
      setPatientArchiveAvailable(false);
      setPatientArchiveOnDrive(false);
      return () => { active = false; };
    }
    getPatientImageArchive(String(id)).then(value => {
      if (active) {
        setPatientArchiveAvailable(!!value);
        setPatientArchiveOnDrive(!!value?.driveFileId);
      }
    }).catch(() => {
      if (active) {
        setPatientArchiveAvailable(false);
        setPatientArchiveOnDrive(false);
      }
    });
    return () => { active = false; };
  }, [id]));
  const [labOcrEnabled, setLabOcrEnabled] = useState(false);
  const [labOcrBusy, setLabOcrBusy] = useState(false);
  const [labOcrText, setLabOcrText] = useState("");
  const [labOcrFindings, setLabOcrFindings] = useState<string[]>([]);
  const [labManualReviews, setLabManualReviews] = useState<Array<{ test: string; unit: string; result: string; reference: string; photoUri: string; reportDate?: string; min?: number; max?: number; source?: string; confidence?: number }>>([]);
  const [labTestTemplates, setLabTestTemplates] = useState<import("@/src/utils/lab-ocr").LabTestDefinition[]>([]);
  const [expandedMedicalTestId, setExpandedMedicalTestId] = useState("");
  const [medicalInfoCache, setMedicalInfoCache] = useState<Record<string, MedicalTestOnlineInfo>>({});
  const [medicalInfoBusyKey, setMedicalInfoBusyKey] = useState("");
  const [medicalInfoErrors, setMedicalInfoErrors] = useState<Record<string, string>>({});
  const [labDetailsExpanded, setLabDetailsExpanded] = useState(false);
  const [labFindingsExpanded, setLabFindingsExpanded] = useState(false);
  const pinchScale = useRef(new Animated.Value(1)).current;
  const basePhotoScale = useRef(new Animated.Value(1)).current;
  const basePhotoScaleNumber = useRef(1);
  const combinedPhotoScale = Animated.multiply(basePhotoScale, pinchScale);
  const onPhotoPinch = useRef(Animated.event([{ nativeEvent: { scale: pinchScale } }], { useNativeDriver: true })).current;
  const finishPhotoPinch = (event: any) => {
    const state = event?.nativeEvent?.state;
    if (state === GestureState.END || state === GestureState.CANCELLED || state === GestureState.FAILED) {
      const nextScale = Math.max(1, Math.min(5, basePhotoScaleNumber.current * (Number(event?.nativeEvent?.scale) || 1)));
      basePhotoScaleNumber.current = nextScale;
      basePhotoScale.setValue(nextScale);
      pinchScale.setValue(1);
    }
  };
  const resetPhotoZoom = () => {
    basePhotoScaleNumber.current = 1;
    basePhotoScale.setValue(1);
    pinchScale.setValue(1);
  };
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
  const [documentScannerMode, setDocumentScannerMode] = useState(false);
  const [documentScannerTorch, setDocumentScannerTorch] = useState(false);
  const [documentScannerZoom, setDocumentScannerZoom] = useState(0.12);
  const [documentScannerPageCount, setDocumentScannerPageCount] = useState(0);
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
  const [customScreeningBoxes, setCustomScreeningBoxes] = useState<CustomScreeningBox[]>([]);
  useEffect(() => { AsyncStorage.getItem(CUSTOM_SCREENING_BOXES_KEY).then(raw => { try { const parsed = raw ? JSON.parse(raw) : []; if (Array.isArray(parsed)) setCustomScreeningBoxes(parsed.filter(item => item && typeof item.id === "string" && typeof item.label === "string")); } catch {} }).catch(() => {}); }, []);
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
    AsyncStorage.getItem(MEDICAL_INFO_CACHE_KEY).then(raw => {
      if (raw) { try { const parsed = JSON.parse(raw); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) setMedicalInfoCache(parsed as Record<string, MedicalTestOnlineInfo>); } catch {} }
    }).catch(() => {});
    AsyncStorage.getItem("ortho_lab_ocr_enabled").then(value => setLabOcrEnabled(value === "true")).catch(() => setLabOcrEnabled(false));
    AsyncStorage.getItem("ortho_lab_test_definitions_v1").then(raw => { if (raw) { try { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) setLabTestTemplates(parsed); } catch {} } }).catch(() => {});
    AsyncStorage.getItem("ortho_lab_warnings_enabled").then(value => setLabWarningsEnabled(value !== "false")).catch(() => setLabWarningsEnabled(true));
    AsyncStorage.getItem("ortho_lab_warning_threshold_percent_v1").then(value => { const n = Number(value); if (value && Number.isInteger(n) && n >= 1 && n <= 100) setLabWarningThreshold(n); }).catch(() => setLabWarningThreshold(10));
  }, []);

  const loadMedicalTestInfo = async (testName: string, definition?: import("@/src/utils/lab-ocr").LabTestDefinition, forceRefresh = false) => {
    const cacheKey = medicalInfoCacheKey(testName);
    const cached = definition?.onlineMedicalInfo || medicalInfoCache[cacheKey];
    if (!forceRefresh && isMedicalTestInfoFresh(cached)) return;
    setMedicalInfoBusyKey(cacheKey);
    setMedicalInfoErrors(current => { const next = { ...current }; delete next[cacheKey]; return next; });
    try {
      // Search by test label/known aliases only. Patient identity, measured result,
      // reference range, report text, and images are never sent to online services.
      const fetched = await fetchTrustedMedicalTestInfo(testName, definition?.aliases || "");
      if (!fetched) {
        setMedicalInfoErrors(current => ({ ...current, [cacheKey]: "No verified MedlinePlus match was found for this test. The app will not display an unrelated explanation." }));
        return;
      }

      let nextCache: Record<string, MedicalTestOnlineInfo> = {};
      try {
        const rawCache = await AsyncStorage.getItem(MEDICAL_INFO_CACHE_KEY);
        const parsed = rawCache ? JSON.parse(rawCache) : {};
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) nextCache = parsed;
      } catch {}
      nextCache[cacheKey] = fetched;
      await AsyncStorage.setItem(MEDICAL_INFO_CACHE_KEY, JSON.stringify(nextCache));
      setMedicalInfoCache(nextCache);

      // Store the excerpt alongside the configured definition so it is available
      // offline and can travel through the existing settings backup. Never overwrite
      // the administrator's own explanation fields with automatically fetched text.
      if (definition?.id) {
        let definitions: import("@/src/utils/lab-ocr").LabTestDefinition[] = [];
        try {
          const rawDefinitions = await AsyncStorage.getItem(LAB_TEST_DEFINITIONS_KEY);
          const parsed = rawDefinitions ? JSON.parse(rawDefinitions) : [];
          if (Array.isArray(parsed)) definitions = parsed;
        } catch {}
        if (definitions.some(item => item.id === definition.id)) {
          const updated = definitions.map(item => item.id === definition.id ? { ...item, onlineMedicalInfo: fetched } : item);
          await AsyncStorage.setItem(LAB_TEST_DEFINITIONS_KEY, JSON.stringify(updated));
          setLabTestTemplates(updated);
          triggerAutomaticDriveBackup("appSettings");
        }
      }
    } catch {
      setMedicalInfoErrors(current => ({ ...current, [cacheKey]: "Could not reach MedlinePlus right now. Check the internet connection and retry; saved information remains available offline." }));
    } finally {
      setMedicalInfoBusyKey(current => current === cacheKey ? "" : current);
    }
  };

  const analyzeLabPhotos = async (photoUris: string[] = [...new Set(p.photos)], automatic = false, forceRescan = false) => {
    if (!labOcrEnabled || !photoUris.length) return;
    const photoSignature = [...new Set(photoUris)].filter(Boolean).join("|");
    // A manual retry must discard the previous OCR cache immediately. This
    // ensures a failed/partial retry cannot leave stale results to be reused.
    if (forceRescan) {
      setLabOcrText("");
      setLabOcrFindings([]);
      setP(prev => {
        const customData = { ...(prev.customData || {}) };
        delete customData.labOcrPhotoScanComplete;
        delete customData.labOcrExtractedText;
        delete customData.labOcrPhotoSignature;
        delete customData.labOcrPipelineVersion;
        delete customData.labOcrPossibleFlags;
        delete customData.labOcrNeedsReview;
        delete customData.labOcrOnlineTestNameHelp;
        return { ...prev, customData };
      });
    }
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
      if (cachedExtracted === null) for (let i = 0; i < photoUris.length; i++) {
        try {
          // Yield between photos so the form can repaint and respond while a
          // large patient file is being checked.
          await new Promise<void>(resolve => setTimeout(resolve, 0));
          const result = await recognizeLabText(photoUris[i], configuredLabTests, p.gender, automatic);
          const text = String(result?.text || "").trim();
          // Lab images and OCR text are processed locally only. Do not call
          // configured remote vision endpoints from the patient form.
          const structuredText = String(result?.structuredText || "").trim();
          // Prefer rows reconstructed from OCR bounding-box positions. Keep the
          // original OCR text too, so the admin can verify any uncertain mapping.
          // Unknown rows remain review-only; the parser never guesses a test name.
          const evidenceText = [text, structuredText].filter(Boolean).join("\n");
          const recognizedRows = (!!text && isLikelyLabReportText(text, configuredLabTests)) ||
            (!!structuredText && isLikelyLabReportText(structuredText, configuredLabTests));
          const labCues = /\b(?:laboratory|lab report|investigation|test name|test results?|reference range|normal range|biological reference|specimen|result|units?)\b/i.test(evidenceText);
          const numericContent = /[-+]?\d+(?:[.,]\d+)?/.test(evidenceText);
          // Some reports have no "Result" heading and OCR emits test labels and
          // scalar results on separate lines. Preserve those pages for the safe
          // row-aware parser instead of rejecting them before parsing.
          const knownTestLabels = evidenceText.split(/\r?\n/)
            .filter(line => hasKnownLabTestName(line, configuredLabTests)).length;
          const splitLineLabEvidence = knownTestLabels > 0 && numericContent;
          // A reconstructed table may identify a lab page when raw OCR loses its
          // headings/columns. Use both outputs so valid scans aren't silently discarded.
          if (evidenceText && (recognizedRows || (labCues && numericContent) || splitLineLabEvidence)) {
            pages.push("LAB REPORT IMAGE " + (i + 1) + "\n" +
              (structuredText ? "RECONSTRUCTED TABLE ROWS (test | result | unit | reference range)\n" + structuredText + "\n" : "") +
              "RAW OCR TEXT FOR REVIEW\n" + (text || "[No reliable plain-text OCR was returned.]"));
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
      const genderToken = (String(p.gender || "").trim().toLowerCase().match(/[a-z]+/g) || [])[0] || "";
      const genderForRange = ["m", "male", "man", "men"].includes(genderToken)
        ? "male" : ["f", "female", "woman", "women"].includes(genderToken) ? "female" : "";
      const canonical = (value: string) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
      const configuredAliases = (item: any) => [String(item?.name || ""), ...String(item?.aliases || "").split(/[,;\n]+/)].map(value => value.trim()).filter(Boolean);
      const hasSavedSexRange = (item: any) => {
        if (!item || !genderForRange) return false;
        const minValue = genderForRange === "male" ? item.maleMin : item.femaleMin;
        const maxValue = genderForRange === "male" ? item.maleMax : item.femaleMax;
        const minRaw = minValue == null ? "" : String(minValue).trim();
        const maxRaw = maxValue == null ? "" : String(maxValue).trim();
        const min = Number(minRaw.replace(",", "."));
        const max = Number(maxRaw.replace(",", "."));
        return minRaw !== "" && maxRaw !== "" && Number.isFinite(min) && Number.isFinite(max) && max > min;
      };
      const editDistance = (a: string, b: string) => {
        const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
        for (let i = 1; i <= a.length; i++) {
          let diagonal = previous[0];
          previous[0] = i;
          for (let j = 1; j <= b.length; j++) {
            const above = previous[j];
            previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
            diagonal = above;
          }
        }
        return previous[b.length];
      };
      const findSavedRangeTest = (rawName: string) => {
        const name = canonical(rawName);
        if (!name) return undefined;
        const eligible = configuredLabTests.filter(hasSavedSexRange);
        const exact = eligible.find(item => configuredAliases(item).some(alias => canonical(alias) === name));
        if (exact) return exact;
        // Permit only clear near-matches to a saved test name/alias; never
        // display an unconfigured test or a test without this patient's sex range.
        let best: any;
        let bestScore = 0;
        for (const item of eligible) {
          for (const alias of configuredAliases(item)) {
            const key = canonical(alias);
            if (key.length < 4 || name.length < 4) continue;
            const distance = editDistance(name, key);
            const similarity = 1 - distance / Math.max(name.length, key.length);
            const containsMatch = Math.min(name.length, key.length) >= 5 &&
              (name.includes(key) || key.includes(name)) &&
              Math.min(name.length, key.length) / Math.max(name.length, key.length) >= 0.72;
            const score = containsMatch ? Math.max(similarity, 0.82) : similarity;
            if (score > bestScore) { bestScore = score; best = item; }
          }
        }
        return bestScore >= 0.78 ? best : undefined;
      };
      const parsedRows = parseLabReportRows(extracted, configuredLabTests, p.gender, labWarningThreshold, true)
        .flatMap(row => {
          const saved = findSavedRangeTest(row.test);
          if (!saved) return [];
          const min = Number(String(genderForRange === "male" ? saved.maleMin : saved.femaleMin).replace(",", "."));
          const max = Number(String(genderForRange === "male" ? saved.maleMax : saved.femaleMax).replace(",", "."));
          const value = Number(String(row.result || "").replace(",", ".").replace(/[<>≤≥\s]/g, ""));
          if (!Number.isFinite(value)) return [];
          // Reclassify against the saved sex-specific range here rather than
          // trusting OCR parser severity, which may have used a printed or
          // differently matched range. Mild deviations (>1% through the
          // configured threshold) remain visible as WARNING; larger deviations
          // are ALERT. Never classify when the saved range is invalid.
          const validRange = Number.isFinite(min) && Number.isFinite(max) && max > min;
          const outside = validRange && (value < min || value > max);
          const boundary = value < min ? min : max;
          const excursion = outside
            ? (boundary === 0 ? 100 : Math.abs(value - boundary) / Math.abs(boundary) * 100)
            : 0;
          const severity = outside && excursion > 1
            ? (excursion <= Math.max(1, Math.min(100, labWarningThreshold)) ? "WARNING" : "ALERT")
            : "";
          return [{
            ...row, test: String(saved.name), unit: String(saved.unit || ""),
            reference: String(saved[genderForRange === "male" ? "maleMin" : "femaleMin"]) + "–" + String(saved[genderForRange === "male" ? "maleMax" : "femaleMax"]),
            min, max, severity,
          }];
        });
      const reviewSourcePhotos = cachedExtracted !== null
        ? [...new Set([...extracted.matchAll(/LAB REPORT IMAGE\s+(\d+)/gi)].map(match => photoUris[Number(match[1]) - 1]).filter(Boolean))]
        : [...new Set(recognizedPhotoUris)];
      const matchesConfiguredTest = (item: any, value: string) => configuredAliases(item).some(alias => canonical(alias) === canonical(value));
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
      const genderKind = /^\s*(?:m|male|man|men)\s*$/i.test(p.gender)
        ? "male"
        : /^\s*(?:f|female|woman|women)\s*$/i.test(p.gender) ? "female" : "";
      const configuredCandidates = configuredLabTests.filter(hasSavedSexRange).map(item => ({
        name: String(item.name || "").trim(), unit: String(item.unit || ""),
        min: genderKind === "male" ? item.maleMin : genderKind === "female" ? item.femaleMin : "",
        max: genderKind === "male" ? item.maleMax : genderKind === "female" ? item.femaleMax : ""
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
      const genderIsMale = genderKind === "male";
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
          const configured = configuredLabTests.find(item => matchesConfiguredTest(item, cells[0]) ||
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
      const testCandidates = configuredCandidates.filter((item, index, all) =>
        item.name && all.findIndex(other => canonical(other.name) === canonical(item.name)) === index
      );
      const rawOnly = extracted;
      const rawLines = rawOnly.split(/\r?\n/);
      const missingResultReviews = testCandidates.filter(test => {
        const configured = configuredLabTests.find(item => canonical(item.name) === canonical(test.name));
        const aliases = isHemoglobin(test.name) ? ["hemoglobin", "haemoglobin", "hgb", "hb", ...configuredAliases(configured || {})] : [test.name, ...configuredAliases(configured || {})];
        const aliasSeen = (line: string) => aliases.some(alias => canonical(line).includes(canonical(alias)));
        const matchingParsed = parsedRows.find(row => canonical(row.test) === canonical(test.name) ||
          aliases.some(alias => canonical(row.test) === canonical(alias)) ||
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
          const saved = findSavedRangeTest(cells[0]);
          if (!saved) continue;
          if (!resultLooksNumeric) {
            reason = "Check result (OCR could not read a clear numeric value)";
          } else {
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
      // Automatically tick admin-created screening boxes only for a clearly
      // detected result tied to that exact configured test label.
      const customScreeningStatuses = customScreeningBoxes.map(box => ({
        box,
        status: detectCustomScreeningStatus(extracted, box.label),
        fieldKey: "customScreening_" + box.id,
      }));
      const screeningLabels: Array<[keyof typeof screeningStatuses, string]> = [
        ["hcvPlus", "HCV+"],
        ["hbaSg", "HBsAg"],
        ["hiv", "HIV"],
        ["mp", "MP ICT"],
        ["dengue", "Dengue"],
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
        mp: applyScreeningStatus(screeningStatuses.mp, prev.mp),
        dengue: applyScreeningStatus(screeningStatuses.dengue, prev.dengue),
        customData: {
          ...(prev.customData || {}),
          ...Object.fromEntries(customScreeningStatuses.map(({fieldKey,status}) => [fieldKey, status === "positive" ? "true" : status === "negative" ? "false" : (prev.customData || {})[fieldKey] || "false"])),
          labOcrExtractedText: extracted, labOcrPhotoSignature: photoSignature, labOcrPhotoScanComplete: "true", labOcrPipelineVersion: LAB_OCR_PIPELINE_VERSION, labOcrPossibleFlags: candidates.join("\n"), labOcrNeedsReview: uncertain.join("\n"), labOcrOnlineTestNameHelp: onlineHelp.join("\n")
        },
      }));
      const newlyTicked = [
        screeningStatuses.hcvPlus === "positive" && !p.hcvPlus ? "HCV+" : "",
        screeningStatuses.hbaSg === "positive" && !p.hbaSg ? "HBsAg" : "",
        screeningStatuses.hiv === "positive" && !p.hiv ? "HIV" : "",
        screeningStatuses.mp === "positive" && !p.mp ? "MP ICT" : "",
        screeningStatuses.dengue === "positive" && !p.dengue ? "Dengue" : "",
      ].filter(Boolean);
      const newlyCleared = [
        screeningStatuses.hcvPlus === "negative" && !!p.hcvPlus ? "HCV+" : "",
        screeningStatuses.hbaSg === "negative" && !!p.hbaSg ? "HBsAg" : "",
        screeningStatuses.hiv === "negative" && !!p.hiv ? "HIV" : "",
        screeningStatuses.mp === "negative" && !!p.mp ? "MP ICT" : "",
        screeningStatuses.dengue === "negative" && !!p.dengue ? "Dengue" : "",
      ].filter(Boolean);
      newlyTicked.push(...customScreeningStatuses.filter(({fieldKey,status}) => status === "positive" && !asBooleanFlag(p.customData?.[fieldKey])).map(({box}) => box.label));
      newlyCleared.push(...customScreeningStatuses.filter(({fieldKey,status}) => status === "negative" && asBooleanFlag(p.customData?.[fieldKey])).map(({box}) => box.label));
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
    // Existing patient records must never start OCR just because the user
    // opened the form or changed tabs. Their scans are explicitly started by
    // the Scan/Rescan button. New-patient drafts retain automatic scanning.
    if (isEdit || !labOcrEnabled || labOcrBusy) return;
    const uris = [...new Set(p.photos)].filter(Boolean);
    if (!uris.length) return;
    const signature = LAB_OCR_PIPELINE_VERSION + "|" + uris.join("|");
    if (lastAutoLabScan.current === signature) return;
    const timer = setTimeout(() => {
      lastAutoLabScan.current = signature;
      void analyzeLabPhotos(uris, true);
    }, 500);
    return () => clearTimeout(timer);
  }, [labOcrEnabled, labOcrBusy, p.photos, isEdit]);
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
      mp: readFlag((source as any).mp, customData.mp),
      dengue: readFlag((source as any).dengue, customData.dengue),
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
    if (!sourceUri) return sourceUri;
    let sourceTempUri = "";
    if (/^data:image\//i.test(sourceUri)) {
      const match = sourceUri.match(/^data:image\/([^;]+);base64,([\s\S]+)$/i);
      if (!match?.[2]) throw new Error("The selected image data is invalid.");
      const cacheRoot = String(FileSystem.cacheDirectory || FileSystem.documentDirectory || "");
      if (!cacheRoot) throw new Error("Temporary phone storage is unavailable for image compression.");
      const tempDir = cacheRoot + "ortho-photo-compression/";
      await FileSystem.makeDirectoryAsync(tempDir, { intermediates: true }).catch(() => {});
      sourceTempUri = tempDir + "source-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + "." + (match[1].toLowerCase().includes("png") ? "png" : "jpg");
      await FileSystem.writeAsStringAsync(sourceTempUri, match[2], { encoding: FileSystem.EncodingType.Base64 });
      sourceUri = sourceTempUri;
    }
    const directory = String(FileSystem.documentDirectory || "") + "patient-photos/";
    if (!FileSystem.documentDirectory) {
      if (sourceTempUri) await FileSystem.deleteAsync(sourceTempUri, { idempotent: true }).catch(() => {});
      throw new Error("Private phone storage is unavailable for patient photos.");
    }
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true }).catch(() => {});
    const targetBytes = 1.5 * 1024 * 1024;
    // Preserve diagnostic detail: 1.5 MiB is the preferred target, not a reason
    // to destroy fine text. If that target cannot be met at good quality, allow
    // a modestly larger file rather than downscaling to unreadable dimensions.
    const qualityFallbackBytes = 2.25 * 1024 * 1024;
    let dimensions: { width: number; height: number };
    try {
      dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
        Image.getSize(sourceUri, (width, height) => resolve({ width, height }), reject);
      });
    } catch (error) {
      if (sourceTempUri) await FileSystem.deleteAsync(sourceTempUri, { idempotent: true }).catch(() => {});
      throw error;
    }
    const longest = Math.max(dimensions.width, dimensions.height);
    // Start each attempt from the original image. Preserve original pixel dimensions
    // whenever high-quality JPEG encoding can meet the size target.
    // Try high-quality, full-resolution encodes first. If the photo is still
    // above 1.5 MiB, reduce resolution gradually and then lower JPEG quality
    // in small steps. Every attempt starts from the original source, never from
    // a previously compressed copy, to avoid cumulative quality loss.
    // Bound scan processing time: the old implementation could encode the same
    // multi-megapixel scan dozens of times before saving it, making the scanner
    // appear frozen and increasing memory pressure. Keep a few full-detail quality
    // attempts, then use a small number of progressively smaller document images.
    const candidateEdges = [3200, 2800, 2400, 2100, 1800].filter(edge => edge < longest);
    const attempts: Array<{ edge: number; quality: number }> = [
      ...[0.92, 0.88, 0.84].map(quality => ({ edge: longest, quality })),
      ...candidateEdges.map((edge, index) => ({
        edge,
        quality: [0.92, 0.90, 0.88, 0.86, 0.84][index],
      })),
    ];
    let normalizedUri = "";
    let fallbackUri = "";
    let fallbackSize = Number.POSITIVE_INFINITY;
    let fallbackEdge = 0;
    let fallbackQuality = 0;
    let lastError: unknown = null;
    try {
      for (const attempt of attempts) {
        try {
          const actions: any[] = [];
          if (attempt.edge < longest) actions.push(dimensions.width >= dimensions.height ? { resize: { width: attempt.edge } } : { resize: { height: attempt.edge } });
          const normalized = await ImageManipulator.manipulateAsync(sourceUri, actions, { compress: attempt.quality, format: ImageManipulator.SaveFormat.JPEG });
          const info = await FileSystem.getInfoAsync(normalized.uri);
          if (!info.exists || typeof info.size !== "number" || info.size <= 0) {
            await FileSystem.deleteAsync(normalized.uri, { idempotent: true }).catch(() => {});
            continue;
          }
          if (info.size <= targetBytes) {
            normalizedUri = normalized.uri;
            if (fallbackUri) await FileSystem.deleteAsync(fallbackUri, { idempotent: true }).catch(() => {});
            fallbackUri = "";
            break;
          }
          // Remember the best full-detail candidate up to 2.25 MiB. Rank by
          // retained pixel dimensions first, then JPEG quality, then file size.
          // Never fall back to tiny 900px images or very low JPEG quality.
          if (info.size <= qualityFallbackBytes &&
              (attempt.edge > fallbackEdge ||
               (attempt.edge === fallbackEdge && attempt.quality > fallbackQuality) ||
               (attempt.edge === fallbackEdge && attempt.quality === fallbackQuality && info.size < fallbackSize))) {
            if (fallbackUri) await FileSystem.deleteAsync(fallbackUri, { idempotent: true }).catch(() => {});
            fallbackUri = normalized.uri;
            fallbackSize = info.size;
            fallbackEdge = attempt.edge;
            fallbackQuality = attempt.quality;
          } else {
            await FileSystem.deleteAsync(normalized.uri, { idempotent: true }).catch(() => {});
          }
        } catch (error) { lastError = error; }
      }
      if (!normalizedUri && fallbackUri) normalizedUri = fallbackUri;
      if (!normalizedUri) throw new Error("This image could not be compressed while preserving diagnostic detail. The original has not been changed. Try cropping empty margins or choose a less noisy scan.");
      const filename = "patient-photo-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10) + ".jpg";
      const destination = directory + filename;
      try {
        await FileSystem.copyAsync({ from: normalizedUri, to: destination });
        const savedInfo = await FileSystem.getInfoAsync(destination);
        if (!savedInfo.exists || typeof savedInfo.size !== "number" || savedInfo.size > qualityFallbackBytes) {
          await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => {});
          throw new Error("Saved photo could not be verified within the quality-preserving size limit.");
        }
        return destination;
      } catch (error: any) {
        throw new Error(String(error?.message || lastError || "Could not save the compressed photo."));
      } finally {
        await FileSystem.deleteAsync(normalizedUri, { idempotent: true }).catch(() => {});
      }
    } finally {
      if (sourceTempUri) await FileSystem.deleteAsync(sourceTempUri, { idempotent: true }).catch(() => {});
    }
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
          selectionLimit: 20, quality: 1,
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
          selectionLimit: 20, quality: 1,
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
      let permission = cameraPermission;
      if (!permission?.granted) permission = await requestCameraPermission();
      if (!permission?.granted) {
        const fallback = await ImagePicker.requestCameraPermissionsAsync();
        if (!fallback.granted) throw new Error("Camera permission is required. Enable it in Android Settings and try again.");
      }
      setDocumentScannerMode(true);
      setDocumentScannerTorch(false);
      setDocumentScannerZoom(0.12);
      setDocumentScannerPageCount(0);
      setCameraReady(false);
      setCameraOpen(true);
    } catch (e: any) {
      toast("Could not start the Ortho Logbook document scanner. " + String(e?.message || e || "Please try again."), "error");
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

  const addFromCamera = () => {
    void scanWithCameraDocuments();
  };

  const capturePatientPhoto = async () => {
    if (!cameraRef.current || !cameraReady || cameraTaking) return;
    setCameraTaking(true);
    try {
      const result = await cameraRef.current.takePictureAsync({
        quality: 1,
        skipProcessing: false,
      });
      if (!result?.uri) throw new Error("The camera did not return a photo.");
      const permanentUri = await persistPhoto(result.uri);
      setP(previous => ({ ...previous, photos: [...previous.photos, permanentUri] }));
      if (documentScannerMode) {
        setDocumentScannerPageCount(count => count + 1);
        toast("Page captured at full quality. Continue with another page or tap Done to review and crop.", "success");
      } else {
        toast("Photo added. Take another photo or tap Done.", "success");
      }
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

  const openOrDownloadPatientArchivePdf = async () => {
    if (photoBusy) return;
    const patientId = String(id || p.id || "");
    if (!patientId || patientId === "unsaved-patient") {
      toast("Save this patient record before downloading archived images.", "error");
      return;
    }
    setPhotoBusy(true);
    try {
      const archive = await downloadPatientImageArchiveForPatient({ id: patientId, name: p.name, mrNo: p.mrNo });
      if (archive.imageCount === 0) throw new Error("This patient's Drive PDF contains no images to import.");
      const oldStamp = String(p.customData?.drivePatientImagePdfSourceStamp || "");
      const oldUrisRaw = p.customData?.drivePatientImportedImageUris || "[]";
      let oldImportedUris: string[] = [];
      try { const parsed = JSON.parse(oldUrisRaw); if (Array.isArray(parsed)) oldImportedUris = parsed.filter((x:any)=>typeof x === "string"); } catch {}
      // Only skip when the previously imported image files are still actually
      // attached to this patient. Stale customData alone must never claim that
      // images exist when the patient file is empty or those files are gone.
      if (oldStamp === archive.sourceStamp && oldImportedUris.length > 0) {
        const attached = new Set((p.photos || []).map(uri => String(uri)));
        const stillPresent = oldImportedUris.every(uri => attached.has(uri));
        let readable = stillPresent;
        if (readable) {
          for (const uri of oldImportedUris) {
            if (/^(file|content):\/\//i.test(uri)) {
              const info = await FileSystem.getInfoAsync(uri).catch(() => ({ exists: false } as any));
              if (!info.exists) { readable = false; break; }
            }
          }
        }
        if (readable) {
          toast("These exact Drive images are already saved in this patient's file.", "info");
          return;
        }
      }
      const outputDir = String(FileSystem.cacheDirectory || FileSystem.documentDirectory || "") + "ortho-drive-patient-images/";
      await FileSystem.makeDirectoryAsync(outputDir, { intermediates: true });
      const pages = await convertPdfPagesToImages(archive.localUri, {
        format: "jpeg", scale: 2, quality: 0.96, maxWidth: 2400, outputDir,
        filePrefix: "patient-" + patientId.slice(-16) + "-page",
      });
      if (!Array.isArray(pages) || !pages.length) throw new Error("No readable image pages were found in this patient's Drive PDF.");
      const importedUris: string[] = [];
      for (const page of pages) importedUris.push(await persistPhoto(page.uri));
      const preserved = p.photos.filter(uri => !oldImportedUris.includes(uri));
      const mergedPhotos = [...preserved, ...importedUris];
      const customData = {
        ...(p.customData || {}),
        drivePatientImagePdfSourceStamp: archive.sourceStamp,
        drivePatientImportedImageUris: JSON.stringify(importedUris),
      };
      const payload = { ...p, photos: mergedPhotos, photoUri: mergedPhotos[0] || "", customData };
      await api.put("/patients/" + encodeURIComponent(patientId), payload);
      setP(previous => ({ ...previous, photos: mergedPhotos, photoUri: mergedPhotos[0] || "", customData }));
      qc.invalidateQueries({ queryKey: ["patients"] });
      qc.invalidateQueries({ queryKey: ["patient-detail", patientId] });
      toast("Downloaded " + importedUris.length + " image page(s) from this patient's Drive PDF and saved them into this patient record.", "success");
    } catch (e: any) {
      toast(e?.message || "Could not download this patient's images from Google Drive.", "error");
    } finally {
      setPhotoBusy(false);
    }
  };

  const driveImportAutoRun = useRef("");
  useEffect(() => {
    const patientId = String(id || "");
    if (downloadDriveImages !== "1" || !isEdit || !ready || !patientId) return;
    if (driveImportAutoRun.current === patientId) return;
    driveImportAutoRun.current = patientId;
    void openOrDownloadPatientArchivePdf();
  }, [downloadDriveImages, isEdit, ready, id]);

  const createPatientPdf = async () => {
    if (photoBusy) return;
    if (!p.photos.length) { toast("Add at least one patient image first.", "error"); return; }
    setPhotoBusy(true);
    try {
      const patientId = String(id || p.id || "unsaved-patient");
      const uri = await createPatientImagePdfFile({ id: patientId, name: p.name, mrNo: p.mrNo }, p.photos);
      if (!(await Sharing.isAvailableAsync())) throw new Error("PDF sharing is not available on this device.");
      await Sharing.shareAsync(uri, { mimeType: "application/pdf", UTI: "com.adobe.pdf", dialogTitle: "Save " + String(p.name || "Patient") + " image PDF" });
      toast("Patient image PDF created and verified.", "success");
    } catch (e: any) {
      toast(e?.message || "Could not create the patient image PDF.", "error");
    } finally {
      setPhotoBusy(false);
    }
  };

  const downloadPatientPhotosToDevice = async () => {
    if (photoBusy) return;
    if (!p.photos.length) { toast("This patient has no images to download.", "error"); return; }
    setPhotoBusy(true);
    let saved = 0;
    const temporaryUris: string[] = [];
    try {
      const permission = await requestPermissionsAsync(true, ["photo"]);
      if (!permission.granted) throw new Error("Photo permission is required to save patient images to your device.");
      for (let i = 0; i < p.photos.length; i++) {
        let localUri = p.photos[i];
        if (localUri.startsWith("data:image/")) {
          const match = localUri.match(/^data:image\/[^;]+;base64,([\s\S]+)$/i);
          if (!match?.[1]) throw new Error("Patient image " + (i + 1) + " has invalid embedded data.");
          const root = String(FileSystem.cacheDirectory || FileSystem.documentDirectory || "");
          if (!root) throw new Error("Temporary phone storage is unavailable.");
          const dir = root + "ortho-photo-export/";
          await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
          localUri = dir + "patient-image-" + Date.now() + "-" + i + ".jpg";
          temporaryUris.push(localUri);
          await FileSystem.writeAsStringAsync(localUri, match[1], { encoding: FileSystem.EncodingType.Base64 });
        }
        await Asset.create(localUri);
        saved++;
      }
      toast(saved + " patient image" + (saved === 1 ? "" : "s") + " saved to your device gallery.", "success");
    } catch (e: any) {
      toast(saved ? saved + " image(s) saved; remaining images failed. " + String(e?.message || "") : (e?.message || "Could not download patient images."), "error");
    } finally {
      for (const uri of temporaryUris) await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      setPhotoBusy(false);
    }
  };

  const removePhoto = async (idx: number) => {
    // Persist removals to the patient record immediately. A UI-only setP()
    // left the old photos in storage, so they reappeared when the record was
    // fetched again. The separate Drive PDF remains unchanged until the
    // administrator explicitly approves a PDF update.
    const photos = p.photos.filter((_, i) => i !== idx);
    if (photos.length === p.photos.length) return;
    const updatedPatient = { ...p, photos, photoUri: photos[0] || "" };
    if (isEdit && id) {
      setPhotoBusy(true);
      try {
        const saved = await api.put("/patients/" + encodeURIComponent(String(id)), updatedPatient);
        setP((current) => ({ ...current, photos, photoUri: photos[0] || "" }));
        if (saved && typeof saved === "object") {
          qc.setQueryData(["patient-detail", id], saved);
          qc.setQueryData<Patient[]>(["patients"], (current) =>
            Array.isArray(current) ? current.map((patient) =>
              String(patient.id) === String(id)
                ? { ...patient, photos, photoUri: photos[0] || "" }
                : patient
            ) : current
          );
        }
        await Promise.all([
          qc.invalidateQueries({ queryKey: ["patient-detail", id] }),
          qc.invalidateQueries({ queryKey: ["patients"] }),
        ]);
        toast("Image removed from this patient record.", "success");
      } catch (error: any) {
        toast(error?.message || "Could not remove image. The patient record was not changed.", "error");
      } finally {
        setPhotoBusy(false);
      }
      return;
    }
    setP(updatedPatient);
  };

  const approveAndUpdateDrivePatientPdf = async () => {
    if (photoBusy) return;
    if (user?.role !== "admin") {
      toast("Only an administrator can approve changes to the saved Drive PDF.", "error");
      return;
    }
    const patientId = String(id || p.id || "");
    if (!patientId || patientId === "unsaved-patient") {
      toast("Save this patient before updating the Drive PDF.", "error");
      return;
    }
    Alert.alert(
      "Admin approval: update patient PDF?",
      p.photos.length
        ? "Replace this patient's existing Google Drive PDF with the current patient images? The existing Drive PDF will be updated in place; no extra copy will be created."
        : "This patient currently has no images. Remove the images from this patient's existing Google Drive PDF? The change will happen only after you approve.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Approve PDF update", style: "destructive", onPress: () => { void (async () => {
          setPhotoBusy(true);
          try {
            await archivePatientImagesForPatient(patientId);
            await uploadPatientImageArchivesToDrive();
            const latest = await getPatientImageArchive(patientId);
            setPatientArchiveAvailable(!!latest);
            setPatientArchiveOnDrive(!!latest?.driveFileId);
            toast("Admin-approved patient PDF update completed.", "success");
          } catch (error: any) {
            toast(error?.message || "The patient PDF could not be updated. The current Drive PDF was kept if upload did not complete.", "error");
          } finally {
            setPhotoBusy(false);
          }
        })(); } },
      ],
    );
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
      if (action === "optimize") {
        const optimizedUri = await persistPhoto(editingPhotoUri);
        const info = await FileSystem.getInfoAsync(optimizedUri);
        if (!info.exists || typeof info.size !== "number" || info.size <= 0 || info.size > 1.5 * 1024 * 1024) {
          throw new Error("The compressed photo did not pass the 1.5 MB verification. Your current edit was not replaced.");
        }
        setEditingPhotoUri(optimizedUri);
        loadEditingPhotoDimensions(optimizedUri);
        setCropRect(null);
        cropDragStartRef.current = null;
        cropResizeStartRef.current = null;
        toast("Photo optimized and verified at " + (info.size / (1024 * 1024)).toFixed(2) + " MB.", "success");
        return;
      }
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
        compress: 0.92, format: ImageManipulator.SaveFormat.JPEG,
      });
      setEditingPhotoUri(result.uri);
      loadEditingPhotoDimensions(result.uri);
      setCropRect(null);
      cropDragStartRef.current = null;
      cropResizeStartRef.current = null;
      if (action === "crop") toast("Freeform crop applied. You can adjust again before saving.", "success");
      else if (action === "rotate") toast("Photo rotated.", "success");
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
      const permanentDirectory = String(FileSystem.documentDirectory || "") + "patient-photos/";
      const permanent = editingPhotoUri.startsWith(permanentDirectory)
        ? editingPhotoUri
        : await persistPhoto(editingPhotoUri);
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
        mp: p.mp ? "true" : "false",
        dengue: p.dengue ? "true" : "false",
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
    onSuccess: async () => {
      qc.invalidateQueries({ queryKey: ["patients"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
      try {
        await deletePatientImagePdfFromDrive(String(id));
        toast("Record deleted and its Google Drive image PDF removed.", "success");
      } catch (error: any) {
        toast("Record deleted, but its Drive PDF could not be removed: " + String(error?.message || error), "error");
      }
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
            "This patient and its saved details will be moved to Trash for 30 days. After you confirm, the deletion will sync and the patient's separate Google Drive image PDF will be queued for removal. You can restore the patient from Settings → Trash before it expires; the PDF may need to be recreated or downloaded again.",
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
            <Text style={{ color: colors.brandPrimary, fontFamily: fontFamily.bold, fontSize: fontSize.base }}>DOCUMENT SCANNING</Text>
          </View>
          <Text style={{ color: colors.onSurfaceSecondary, fontSize: fontSize.xs, marginBottom: spacing.sm }}>
            Scan existing patient photos, detect document edges, and correct perspective. Image enhancement AI is disabled to keep the app responsive.
          </Text>
          <Pressable
            style={[styles.secondary, { backgroundColor: colors.brandPrimary, justifyContent: "center" }, photoBusy && { opacity: 0.5 }]}
            onPress={scanDocumentsToPatientPhotos}
            disabled={photoBusy || cameraOpen}
            testID="open-ai-image-tools-button"
            accessibilityRole="button"
            accessibilityLabel="Scan existing patient images"
          >
            <Ionicons name="sparkles" size={19} color={colors.onBrandPrimary} />
            <Text style={[styles.secondaryText, { color: colors.onBrandPrimary, fontFamily: fontFamily.bold }]}> Scan Existing Images</Text>
          </Pressable>
        </View>
        <View style={styles.photoActions}>
          <PrimaryButton title={"Add Multiple Images from Gallery" + (p.photos.length ? " (+)" : "")} onPress={addFromLibrary} disabled={!imagePickerReady || photoBusy} testID="add-photo-library-button" />
          <Pressable style={[styles.secondary, photoBusy && { opacity: 0.5 }]} onPress={() => { void scanWithCameraDocuments(); }} disabled={photoBusy || cameraOpen} testID="scan-patient-document-button">
            <Ionicons name="scan-outline" size={18} color={colors.brandPrimary} />
            <Text style={styles.secondaryText}> {photoBusy ? "Starting scanner…" : (p.photos.length ? "Scan Existing Photo" : "Open Document Scanner")}</Text>
          </Pressable>
          <Pressable style={[styles.secondary, photoBusy && { opacity: 0.5 }]} onPress={addFromCamera} disabled={photoBusy || cameraOpen} testID="add-photo-camera-button">
            <Ionicons name="camera" size={18} color={colors.onSurface} />
            <Text style={styles.secondaryText}> Take & Auto-Scan</Text>
          </Pressable>
        </View>
        {p.photos.length > 0 ? (
          <View style={[styles.photoActions, { marginTop: spacing.sm }]}>
            <Pressable style={[styles.secondary, { justifyContent: "center", flexGrow: 1 }, photoBusy && { opacity: 0.5 }]} onPress={() => { void createPatientPdf(); }} disabled={photoBusy} testID="create-patient-images-pdf-button">
              <Ionicons name="document-text-outline" size={18} color={colors.brandPrimary} />
              <Text style={[styles.secondaryText, { color: colors.brandPrimary }]}>{photoBusy ? "Preparing…" : "Create / Save PDF"}</Text>
            </Pressable>
            <Pressable style={[styles.secondary, { justifyContent: "center", flexGrow: 1 }, photoBusy && { opacity: 0.5 }]} onPress={() => { void downloadPatientPhotosToDevice(); }} disabled={photoBusy} testID="download-all-patient-images-button">
              <Ionicons name="download-outline" size={18} color={colors.brandPrimary} />
              <Text style={[styles.secondaryText, { color: colors.brandPrimary }]}>{photoBusy ? "Saving…" : "Download all images"}</Text>
            </Pressable>
          </View>
        ) : null}
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
                <Pressable
                  onPress={() => { void savePhotoToDevice(uri); }}
                  disabled={photoBusy}
                  hitSlop={8}
                  testID={`download-photo-${idx}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Download patient image ${idx + 1}`}
                  style={{ position: "absolute", right: 6, bottom: 6, width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.72)", opacity: photoBusy ? 0.5 : 1 }}
                >
                  <Ionicons name="download-outline" size={17} color="#FFFFFF" />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        )}
        {isEdit ? (
          <Pressable
            style={[styles.secondary, { marginTop: spacing.sm, justifyContent: "center", borderColor: colors.brandPrimary }, photoBusy && { opacity: 0.5 }]}
            onPress={() => { void openOrDownloadPatientArchivePdf(); }}
            disabled={photoBusy}
            accessibilityRole="button"
            testID="download-patient-archive-from-drive-button"
          >
            <Ionicons name="cloud-download-outline" size={18} color={colors.brandPrimary} />
            <Text style={styles.secondaryText}>{photoBusy ? "Downloading images…" : "Download patient images from Drive"}</Text>
          </Pressable>
        ) : null}
        {isEdit && user?.role === "admin" && (patientArchiveOnDrive || patientArchiveAvailable || p.photos.length > 0) ? (
          <Pressable
            style={[styles.secondary, { marginTop: spacing.sm, justifyContent: "center", borderColor: colors.warning }, photoBusy && { opacity: 0.5 }]}
            onPress={approveAndUpdateDrivePatientPdf}
            disabled={photoBusy}
            accessibilityRole="button"
            testID="admin-approve-update-patient-drive-pdf-button"
          >
            <Ionicons name="shield-checkmark-outline" size={18} color={colors.warning} />
            <Text style={styles.secondaryText}>{photoBusy ? "Updating PDF…" : p.photos.length ? "Admin: approve & update Drive PDF" : "Admin: approve removal of PDF images"}</Text>
          </Pressable>
        ) : null}

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
                      <Text style={styles.photoEditTitle}>DOCUMENT PERSPECTIVE CORRECTION</Text>
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
                      onLoadEnd={() => perspectiveWebViewRef.current?.injectJavaScript('if(window.__orthoAutoDetectPageCorners){try{window.__orthoAutoDetectPageCorners();}catch(e){window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({type:"error",message:String(e&&e.message||e)}));}} true;')}
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
                  <Text style={styles.photoToolText}>Compress Photo</Text>
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
          <Pressable testID="patient-lab-results-toggle" onPress={() => setLabDetailsExpanded(value => !value)} accessibilityRole="button" accessibilityLabel={labDetailsExpanded ? "Hide Add Result form" : "Show Add Result form"} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm, minHeight: 48 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.error || "#B91C1C", fontFamily: fontFamily.bold, fontSize: 22, letterSpacing: 0.4 }}>ADD RESULT</Text>
              <Text style={{ color: colors.onSurfaceSecondary, fontSize: fontSize.xs }}>{savedManualLabResults.length} saved · {labAddedResults.length + labManualReviews.length} pending · Tap to {labDetailsExpanded ? "hide" : "show"}</Text>
            </View>
            <Ionicons name={labDetailsExpanded ? "chevron-up" : "chevron-down"} size={24} color={colors.error || "#B91C1C"} />
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
            {savedManualLabResults.map((item: any, index: number) => {
              const testName = String(item.test || "Test");
              const definition = labTestTemplates.find(template => [template.name, ...(template.aliases || "").split(/[,;\\n]+/)].some(label => label.trim().toLocaleLowerCase() === testName.trim().toLocaleLowerCase()));
              const detailKey = "saved-" + testName + "-" + index;
              const expanded = expandedMedicalTestId === detailKey;
              const infoKey = medicalInfoCacheKey(testName);
              const onlineInfo = definition?.onlineMedicalInfo || medicalInfoCache[infoKey];
              return <View key={detailKey} style={{ marginTop: spacing.xs, borderTopWidth: 1, borderColor: colors.border, paddingTop: spacing.xs }}>
                <Pressable accessibilityRole="button" onPress={() => {
                  if (expanded) setExpandedMedicalTestId("");
                  else {
                    setExpandedMedicalTestId(detailKey);
                    void loadMedicalTestInfo(testName, definition);
                  }
                }} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm, paddingVertical: spacing.xs }}>
                  <Text style={{ color: colors.onSurface, fontSize: fontSize.sm, flex: 1 }}>{testName}: {String(item.result || "")}{item.unit ? " " + String(item.unit) : ""}{item.date ? " · " + String(item.date) : item.reportDate ? " · " + String(item.reportDate) : ""}{item.severity ? " · " + String(item.severity) : ""}</Text>
                  <Ionicons name={expanded ? "chevron-up" : "information-circle-outline"} size={20} color={colors.brandPrimary}/>
                </Pressable>
                {expanded ? <View style={{ marginTop: spacing.xs, padding: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surfaceSecondary }}>
                  <Text style={[styles.label, { marginTop: 0 }]}>About this test</Text>
                  <Text style={{ color: colors.onSurface, fontSize: fontSize.sm }}>{definition?.purpose?.trim() || onlineInfo?.title || "Looking for a verified medical-test explanation…"}</Text>
                  {onlineInfo?.summary ? <View style={{ marginTop: spacing.sm, padding: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md }}>
                    <Text style={[styles.label, { marginTop: 0 }]}>Trusted online information</Text>
                    <Text style={{ color: colors.onSurface, fontSize: fontSize.sm, lineHeight: 20 }}>{onlineInfo.summary}</Text>
                    <Text style={{ color: colors.onSurfaceSecondary, fontSize: fontSize.xs, marginTop: spacing.sm }}>Source: {onlineInfo.sourceName} · Checked {new Date(onlineInfo.fetchedAt).toLocaleDateString()}</Text>
                    {(onlineInfo.sources?.length ? onlineInfo.sources : [{ title: onlineInfo.title, url: onlineInfo.sourceUrl }]).map((source, sourceIndex) => (
                      <Pressable key={source.url + sourceIndex} onPress={() => void Linking.openURL(source.url).catch(() => {})} style={{ alignSelf: "flex-start", paddingVertical: 3 }}>
                        <Text style={{ color: colors.brandPrimary, fontSize: fontSize.xs, textDecorationLine: "underline" }}>{source.title || source.url}</Text>
                      </Pressable>
                    ))}
                    <Pressable disabled={medicalInfoBusyKey === infoKey} onPress={() => void loadMedicalTestInfo(testName, definition, true)} style={{ alignSelf: "flex-start", paddingVertical: spacing.sm }}>
                      <Text style={{ color: colors.brandPrimary, fontFamily: fontFamily.semibold }}>{medicalInfoBusyKey === infoKey ? "Refreshing…" : "Refresh test details"}</Text>
                    </Pressable>
                  </View> : medicalInfoBusyKey === infoKey ? <Text style={{ color: colors.onSurfaceSecondary, fontSize: fontSize.sm, marginTop: spacing.sm }}>Searching the National Library of Medicine for a matching test. No patient details or test result values are sent.</Text> : medicalInfoErrors[infoKey] ? <View style={{ marginTop: spacing.sm }}>
                    <Text style={{ color: colors.onSurfaceSecondary, fontSize: fontSize.sm }}>{medicalInfoErrors[infoKey]}</Text>
                    <Pressable disabled={medicalInfoBusyKey === infoKey} onPress={() => void loadMedicalTestInfo(testName, definition, true)} style={{ alignSelf: "flex-start", paddingVertical: spacing.sm }}><Text style={{ color: colors.brandPrimary, fontFamily: fontFamily.semibold }}>{medicalInfoBusyKey === infoKey ? "Refreshing…" : "Retry online lookup"}</Text></Pressable>
                  </View> : <Text style={{ color: colors.onSurfaceSecondary, fontSize: fontSize.sm, marginTop: spacing.sm }}>Trusted information is not cached yet. The app will look it up when you open this result.</Text>}
                  {definition?.lowMeaning?.trim() ? <><Text style={[styles.label, { marginTop: spacing.sm }]}>What a low result may mean</Text><Text style={{ color: colors.onSurface, fontSize: fontSize.sm }}>{definition.lowMeaning}</Text></> : null}
                  {definition?.highMeaning?.trim() ? <><Text style={[styles.label, { marginTop: spacing.sm }]}>What a high result may mean</Text><Text style={{ color: colors.onSurface, fontSize: fontSize.sm }}>{definition.highMeaning}</Text></> : null}
                  {definition?.possibleEffects?.trim() ? <><Text style={[styles.label, { marginTop: spacing.sm }]}>Possible effects on the body</Text><Text style={{ color: colors.onSurface, fontSize: fontSize.sm }}>{definition.possibleEffects}</Text></> : null}
                  {definition?.seekCare?.trim() ? <><Text style={[styles.label, { marginTop: spacing.sm }]}>When to seek medical review</Text><Text style={{ color: colors.onSurface, fontSize: fontSize.sm }}>{definition.seekCare}</Text></> : null}
                  {(!definition?.lowMeaning?.trim() || !definition?.highMeaning?.trim()) ? <Text style={{ color: colors.onSurfaceSecondary, fontSize: fontSize.xs, marginTop: spacing.sm }}>A source may explain what the test measures but not the meaning of every high or low result. Missing interpretations are not guessed; review the saved reference range and clinical context.</Text> : null}
                  <Text style={{ color: colors.onSurfaceSecondary, fontSize: fontSize.xs, marginTop: spacing.sm }}>Educational information only. Results must be interpreted with symptoms and clinical context; this is not a diagnosis.</Text>
                  {definition?.sourceUrl?.trim() && /^https:\/\//i.test(definition.sourceUrl.trim()) ? <Text style={{ color: colors.onSurfaceSecondary, fontSize: fontSize.xs, marginTop: spacing.sm }}>Additional admin source: {definition.sourceName?.trim() || "Medical reference"} (details stay inside Ortho Logbook).</Text> : null}
                </View> : null}
              </View>;
            })}
          </View> : null}
          </View> : null}
        </View>
        {labOcrEnabled ? (
          <View style={{ marginTop: spacing.md, marginBottom: spacing.md, borderWidth: 1, borderColor: colors.error || "#B91C1C", borderRadius: radius.md, padding: spacing.md }}>
            <Pressable testID="patient-find-labs-toggle" onPress={() => setLabFindingsExpanded(value => !value)} accessibilityRole="button" accessibilityLabel={labFindingsExpanded ? "Hide Find Labs details" : "Show Find Labs details"} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 48, gap: spacing.sm }}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.error || "#B91C1C", fontFamily: fontFamily.bold, fontSize: 24, letterSpacing: 0.5 }}>FIND LABS</Text>
                <Text style={{ color: colors.onSurfaceSecondary, fontSize: fontSize.xs }}>{labOcrBusy ? "Scanning lab photos…" : "Lab scan details are hidden until opened."}</Text>
              </View>
              <Ionicons name={labFindingsExpanded ? "chevron-up" : "chevron-down"} size={26} color={colors.error || "#B91C1C"} />
            </Pressable>
            {labFindingsExpanded ? <View>
            <Text style={styles.hint}>{labOcrBusy ? "Checking pictures for lab reports…" : isEdit ? "Existing patient photos are not scanned when you open this file. Tap Scan lab photos when you want to run OCR; review extracted values against the original report." : "Lab photos in a new patient draft are scanned automatically. Review extracted values against the original report."}</Text>
            {p.photos.length ? <View style={{ marginTop: spacing.sm }}>
              <Text style={[styles.label, { marginBottom: spacing.xs }]}>Review Lab OCR images - Tap any image to open full screen</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm }}>
                {[...new Set(p.photos)].map((uri, index) => <Pressable key={uri + "-" + index} accessibilityRole="button" accessibilityLabel={"Open lab report image " + (index + 1) + " full screen"} onPress={() => { resetPhotoZoom(); setSelectedPhoto(uri); }} style={{ width: 94, height: 120, borderRadius: radius.sm, overflow: "hidden", borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSecondary }}>
                  <Image source={{ uri }} style={{ width: "100%", height: "100%" }} resizeMode="cover" />
                  <View style={{ position: "absolute", right: 4, bottom: 4, borderRadius: radius.pill, paddingHorizontal: 5, paddingVertical: 2, backgroundColor: "rgba(0,0,0,0.7)" }}><Text style={{ color: "#FFFFFF", fontSize: 10 }}>{index + 1}</Text></View>
                </Pressable>)}
              </ScrollView>
            </View> : null}
            <Pressable disabled={labOcrBusy || !p.photos.length} onPress={() => { lastAutoLabScan.current = ""; void analyzeLabPhotos([...new Set(p.photos)], false, true); }} style={{ alignSelf: "flex-start", marginTop: spacing.xs, paddingVertical: spacing.sm, paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md }}>
              <Text style={{ color: colors.brandPrimary, fontFamily: fontFamily.semibold }}>{labOcrBusy ? "Scanning…" : isEdit ? "Scan lab photos" : "Rescan lab photos"}</Text>
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
                    {item.source ? <Text style={{ color: colors.warning || "#B7791F", marginTop: spacing.xs, fontSize: fontSize.sm }}>{item.source}{typeof item.confidence === "number" ? " (" + Math.round(item.confidence * 100) + "% visual confidence)" : ""}. This is not verified and will not be saved until you confirm it below and apply manual review.</Text> : null}
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
          ["hbaSg", "HBsAg"],
          ["hiv", "HIV"],
          ["mp", "MP ICT"],
          ["dengue", "Dengue"],
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
        {customScreeningBoxes.map(box => {
          const fieldKey = "customScreening_" + box.id;
          const checked = asBooleanFlag(p.customData?.[fieldKey]);
          return <Pressable
            key={"custom-screening-" + box.id}
            onPress={() => setP(prev => ({ ...prev, customData: { ...(prev.customData || {}), [fieldKey]: asBooleanFlag(prev.customData?.[fieldKey]) ? "false" : "true" } }))}
            style={styles.screeningRow}
            testID={"patient-screening-custom-" + box.id}
          >
            <Ionicons name={checked ? "checkbox" : "square-outline"} size={22} color={checked ? colors.brandPrimary : colors.muted} />
            <Text style={styles.screeningText}>{box.label}</Text>
          </Pressable>;
        })}


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
        onRequestClose={() => { setCameraOpen(false); setCameraReady(false); setDocumentScannerMode(false); }}
      >
        <View style={styles.cameraScreen}>
          <View style={[styles.cameraHeader, { paddingTop: insets.top + spacing.sm, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }]}>
            <Pressable
              onPress={() => { setCameraOpen(false); setCameraReady(false); setDocumentScannerMode(false); }}
              style={styles.photoEditIconButton}
              disabled={cameraTaking}
              accessibilityLabel="Close scanner"
            >
              <Ionicons name="close" size={24} color="#FFFFFF" />
            </Pressable>
            <View style={{ flex: 1, alignItems: "center" }}>
              <Text style={styles.cameraTitle}>{documentScannerMode ? "ORTHO DOCUMENT SCANNER" : "Take Patient Photo"}</Text>
              {documentScannerMode ? <Text style={{ color: "#D1D5DB", fontSize: 11, marginTop: 3 }}>Page {documentScannerPageCount + 1} · High-quality capture</Text> : null}
            </View>
            <Pressable onPress={() => { setCameraOpen(false); setCameraReady(false); setDocumentScannerMode(false); }} style={styles.photoEditIconButton} disabled={cameraTaking}><Text style={{ color: "#FFFFFF", fontWeight: "700" }}>Done</Text></Pressable>
          </View>
          <View style={[styles.cameraPreviewWrap, { flex: 1, position: "relative" }]}>
            {cameraOpen ? (
              <CameraView
                ref={cameraRef}
                style={styles.cameraPreview}
                facing="back"
                mode="picture"
                enableTorch={documentScannerMode && documentScannerTorch}
                zoom={documentScannerMode ? documentScannerZoom : 0}
                onCameraReady={() => setCameraReady(true)}
              />
            ) : null}
            {documentScannerMode ? <View pointerEvents="none" style={{ position: "absolute", left: "7%", right: "7%", top: "10%", bottom: "10%", borderWidth: 2, borderColor: "#F8FAFC", borderRadius: 14, backgroundColor: "transparent" }}>
              <View style={{ position: "absolute", left: 0, right: 0, top: "50%", borderTopWidth: 1, borderColor: "rgba(255,255,255,0.4)" }} />
              <View style={{ position: "absolute", top: 0, bottom: 0, left: "50%", borderLeftWidth: 1, borderColor: "rgba(255,255,255,0.4)" }} />
              {["top-left", "top-right", "bottom-left", "bottom-right"].map(corner => <View key={corner} style={{ position: "absolute", width: 24, height: 24, borderColor: "#22C55E", borderTopWidth: corner.startsWith("top") ? 4 : 0, borderBottomWidth: corner.startsWith("bottom") ? 4 : 0, borderLeftWidth: corner.endsWith("left") ? 4 : 0, borderRightWidth: corner.endsWith("right") ? 4 : 0, top: corner.startsWith("top") ? -2 : undefined, bottom: corner.startsWith("bottom") ? -2 : undefined, left: corner.endsWith("left") ? -2 : undefined, right: corner.endsWith("right") ? -2 : undefined }} />)}
            </View> : null}
            {!cameraReady ? (
              <View style={styles.cameraLoading}>
                <Text style={styles.cameraLoadingText}>Starting camera…</Text>
              </View>
            ) : null}
          </View>
          <View style={[styles.cameraControls, { paddingBottom: insets.bottom + spacing.md, gap: spacing.sm }]}>
            {documentScannerMode ? <>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", width: "100%", gap: spacing.sm }}>
                <Pressable onPress={() => setDocumentScannerTorch(value => !value)} disabled={!cameraReady} style={{ minWidth: 90, paddingVertical: 9, paddingHorizontal: 12, borderRadius: 20, borderWidth: 1, borderColor: documentScannerTorch ? "#FACC15" : "#6B7280", alignItems: "center" }}>
                  <Ionicons name={documentScannerTorch ? "flash" : "flash-off"} size={18} color={documentScannerTorch ? "#FACC15" : "#FFFFFF"} />
                  <Text style={{ color: "#FFFFFF", fontSize: 11 }}>{documentScannerTorch ? "Flash on" : "Flash off"}</Text>
                </Pressable>
                <View style={{ flex: 1, alignItems: "center" }}>
                  <Text style={styles.cameraHint}>Keep all four page corners inside the frame</Text>
                  <Text style={{ color: "#D1D5DB", fontSize: 11 }}>{documentScannerPageCount} page(s) captured</Text>
                </View>
                <View style={{ minWidth: 90, alignItems: "center" }}>
                  <Text style={{ color: "#FFFFFF", fontSize: 11 }}>Zoom</Text>
                  <View style={{ flexDirection: "row", gap: 5 }}>
                    <Pressable onPress={() => setDocumentScannerZoom(value => Math.max(0, Number((value - 0.1).toFixed(2))))} disabled={!cameraReady} style={{ padding: 5 }}><Ionicons name="remove-circle-outline" size={23} color="#FFFFFF" /></Pressable>
                    <Pressable onPress={() => setDocumentScannerZoom(value => Math.min(1, Number((value + 0.1).toFixed(2))))} disabled={!cameraReady} style={{ padding: 5 }}><Ionicons name="add-circle-outline" size={23} color="#FFFFFF" /></Pressable>
                  </View>
                </View>
              </View>
            </> : <Text style={styles.cameraHint}>Photos are saved privately inside Ortho Logbook.</Text>}
            <Pressable
              style={[styles.cameraShutter, (!cameraReady || cameraTaking) && { opacity: 0.5 }]}
              onPress={capturePatientPhoto}
              disabled={!cameraReady || cameraTaking}
              accessibilityLabel={documentScannerMode ? "Capture document page" : "Capture patient photo"}
            >
              <View style={styles.cameraShutterInner} />
            </Pressable>
            <Text style={styles.cameraLoadingText}>{cameraTaking ? "Saving full-quality page…" : cameraReady ? (documentScannerMode ? "Capture page · repeat for multi-page reports" : "Tap to capture") : "Please wait"}</Text>
            {documentScannerMode ? <Pressable onPress={() => { setCameraOpen(false); setCameraReady(false); setDocumentScannerMode(false); if (documentScannerPageCount > 0) toast("Captured pages are saved. Select each page and use Auto-Scan Page or perspective correction to straighten the report.", "success"); }} disabled={cameraTaking} style={{ paddingVertical: 9, paddingHorizontal: 20, borderRadius: radius.md, borderWidth: 1, borderColor: "#9CA3AF" }}>
              <Text style={{ color: "#FFFFFF", fontFamily: fontFamily.semibold }}>Finish scan ({documentScannerPageCount} pages)</Text>
            </Pressable> : null}
          </View>
        </View>
      </Modal>

      <Modal visible={!!selectedPhoto} transparent animationType="fade" onRequestClose={() => setSelectedPhoto(null)}>
        <View style={styles.photoViewer}>
          <Pressable style={styles.photoViewerClose} onPress={() => setSelectedPhoto(null)} hitSlop={10}>
            <Ionicons name="close" size={30} color="#FFFFFF" />
          </Pressable>
          {!!selectedPhoto && (
            <ScrollView key={selectedPhoto || "none"} horizontal pagingEnabled showsHorizontalScrollIndicator={false} contentOffset={{ x: Math.max(0, allViewerPhotos.indexOf(selectedPhoto)) * screenWidth, y: 0 }} onMomentumScrollEnd={(event) => { const idx = Math.max(0, Math.min(allViewerPhotos.length - 1, Math.round(event.nativeEvent.contentOffset.x / screenWidth))); resetPhotoZoom(); setSelectedPhoto(allViewerPhotos[idx] || null); }} style={{ flex: 1, width: screenWidth }} contentContainerStyle={{ alignItems: "center" }}>
              {allViewerPhotos.map((uri, idx) => <View key={uri + "-" + idx} style={{ width: screenWidth, height: "100%", alignItems: "center", justifyContent: "center" }}>
                <PinchGestureHandler onGestureEvent={onPhotoPinch} onHandlerStateChange={finishPhotoPinch}>
                  <Animated.View style={{ width: "100%", height: "100%", alignItems: "center", justifyContent: "center" }}>
                    <Animated.Image source={{ uri }} style={[styles.photoFull, { transform: [{ scale: combinedPhotoScale }] }]} resizeMode="contain" />
                  </Animated.View>
                </PinchGestureHandler>
              </View>)}
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
