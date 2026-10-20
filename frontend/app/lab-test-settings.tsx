import AsyncStorage from "@react-native-async-storage/async-storage";
import Ionicons from "@react-native-vector-icons/ionicons";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View, Switch } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "@/src/auth/AuthContext";
import { useToast } from "@/src/components/toast";
import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";
import { triggerAutomaticDriveBackup } from "@/src/utils/storage/drive-auto-backup";
import * as SecureStore from "expo-secure-store";
import { LAB_VISION_CLIENT_TOKEN_KEY, LAB_VISION_CONSENT_KEY, LAB_VISION_ENDPOINT_KEY, LAB_VISION_TEMPLATES_KEY, type LabVisionTemplate, validateLabVisionEndpoint } from "@/src/utils/lab-vision";

export type LabTestDefinition = {
  id: string;
  name: string;
  maleMin: string;
  maleMax: string;
  femaleMin: string;
  femaleMax: string;
  unit: string;
  aliases?: string;
  category?: string;
};

const STORAGE_KEY = "ortho_lab_test_definitions_v1";
const BRANCHES_KEY = "ortho_lab_test_branches_v1";
const WARNING_THRESHOLD_KEY = "ortho_lab_warning_threshold_percent_v1";
const OLD_RESULT_DAYS_KEY = "ortho_lab_old_result_days_v1";
const ONLINE_OCR_KEY = "ortho_lab_online_ocr_api_key_v1";
const ONLINE_OCR_CONSENT_KEY = "ortho_lab_online_ocr_consent_v1";
const CUSTOM_SCREENING_BOXES_KEY = "ortho_custom_screening_boxes_v1";
type CustomScreeningBox = { id: string; label: string };
const blank = (): LabTestDefinition => ({ id: "", name: "", maleMin: "", maleMax: "", femaleMin: "", femaleMax: "", unit: "", aliases: "", category: "" });

export default function LabTestSettingsScreen() {
  const { user } = useAuth();
  const { colors } = useTheme();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const [tests, setTests] = useState<LabTestDefinition[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [newBranch, setNewBranch] = useState("");
  const [form, setForm] = useState<LabTestDefinition>(blank());
  const [editingId, setEditingId] = useState("");
  const [busy, setBusy] = useState(false);
  const [warningPercent, setWarningPercent] = useState("10");
  const [oldResultDays, setOldResultDays] = useState("10");
  const [oldDaysBusy, setOldDaysBusy] = useState(false);
  const [thresholdBusy, setThresholdBusy] = useState(false);
  const [onlineOcrKey, setOnlineOcrKey] = useState("");
  const [onlineOcrConsent, setOnlineOcrConsent] = useState(false);
  const [onlineKeyBusy, setOnlineKeyBusy] = useState(false);
  const [visionEndpoint, setVisionEndpoint] = useState("");
  const [visionToken, setVisionToken] = useState("");
  const [visionConsent, setVisionConsent] = useState(false);
  const [visionTemplates, setVisionTemplates] = useState<LabVisionTemplate[]>([]);
  const [templateName, setTemplateName] = useState("");
  const [templateMarkers, setTemplateMarkers] = useState("");
  const [templateColumns, setTemplateColumns] = useState("");
  const [customScreeningBoxes, setCustomScreeningBoxes] = useState<CustomScreeningBox[]>([]);
  const [customScreeningLabel, setCustomScreeningLabel] = useState("");
  const [editingCustomScreeningId, setEditingCustomScreeningId] = useState("");

  useEffect(() => {
    AsyncStorage.getItem(CUSTOM_SCREENING_BOXES_KEY).then(raw => { try { const parsed = raw ? JSON.parse(raw) : []; if (Array.isArray(parsed)) setCustomScreeningBoxes(parsed.filter(item => item && typeof item.id === "string" && typeof item.label === "string")); } catch {} }).catch(() => {});
    Promise.all([AsyncStorage.getItem(STORAGE_KEY), AsyncStorage.getItem(BRANCHES_KEY)]).then(([rawTests, rawBranches]) => {
      let loadedTests: LabTestDefinition[] = [];
      let loadedBranches: string[] = [];
      try { if (rawTests) loadedTests = JSON.parse(rawTests); } catch {}
      try { if (rawBranches) loadedBranches = JSON.parse(rawBranches); } catch {}
      const unique = new Map<string, string>();
      for (const name of [...loadedBranches, ...loadedTests.map(item => item.category || "")]) {
        const clean = String(name || "").trim();
        if (clean) unique.set(clean.toLocaleLowerCase(), clean);
      }
      setTests(loadedTests);
      setBranches(Array.from(unique.values()).sort((a, b) => a.localeCompare(b)));
    }).catch(() => {});
    AsyncStorage.getItem(WARNING_THRESHOLD_KEY).then(raw => { if (raw && Number.isFinite(Number(raw))) setWarningPercent(String(Math.max(1, Math.min(100, Math.round(Number(raw)))))); }).catch(() => {});
    AsyncStorage.getItem(ONLINE_OCR_KEY).then(raw => setOnlineOcrKey(raw || "")).catch(() => {});
    AsyncStorage.getItem(ONLINE_OCR_CONSENT_KEY).then(raw => setOnlineOcrConsent(raw === "true")).catch(() => setOnlineOcrConsent(false));
    Promise.all([
      AsyncStorage.getItem(LAB_VISION_ENDPOINT_KEY),
      AsyncStorage.getItem(LAB_VISION_CONSENT_KEY),
      AsyncStorage.getItem(LAB_VISION_TEMPLATES_KEY),
      SecureStore.getItemAsync(LAB_VISION_CLIENT_TOKEN_KEY),
    ]).then(([endpoint, consent, rawTemplates, token]) => {
      setVisionEndpoint(endpoint || "");
      setVisionConsent(consent === "true");
      setVisionToken(token || "");
      try {
        const parsed = rawTemplates ? JSON.parse(rawTemplates) : [];
        if (Array.isArray(parsed)) setVisionTemplates(parsed.filter(item => item && item.id && item.name && Array.isArray(item.markers)));
      } catch {}
    }).catch(() => {});
    AsyncStorage.getItem(OLD_RESULT_DAYS_KEY).then(raw => { if (raw && Number.isFinite(Number(raw))) setOldResultDays(String(Math.max(1, Math.min(3650, Math.round(Number(raw)))))); }).catch(() => {});
  }, []);
  const update = (patch: Partial<LabTestDefinition>) => setForm(current => ({ ...current, ...patch }));
  const addBranch = async () => {
    const name = newBranch.trim().replace(/\s+/g, " ");
    if (!name) { toast("Enter a branch name, for example CBC or LFT.", "error"); return; }
    if (branches.some(branch => branch.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      setForm(current => ({ ...current, category: branches.find(branch => branch.toLocaleLowerCase() === name.toLocaleLowerCase()) || name }));
      setNewBranch("");
      toast("That branch already exists; it is selected.", "success");
      return;
    }
    const next = [...branches, name].sort((a, b) => a.localeCompare(b));
    try {
      await AsyncStorage.setItem(BRANCHES_KEY, JSON.stringify(next));
      triggerAutomaticDriveBackup("appSettings");
      setBranches(next);
      setForm(current => ({ ...current, category: name }));
      setNewBranch("");
      toast("Branch created. You can assign tests to it now.", "success");
    } catch { toast("Could not save the branch.", "error"); }
  };
  const save = async () => {
    const name = form.name.trim();
    if (!name) { toast("Enter a test name.", "error"); return; }
    const numbers = [form.maleMin, form.maleMax, form.femaleMin, form.femaleMax].map(v => Number(v));
    if (numbers.some((n, i) => !String([form.maleMin, form.maleMax, form.femaleMin, form.femaleMax][i]).trim() || !Number.isFinite(n)) ||
      numbers[0] > numbers[1] || numbers[2] > numbers[3]) {
      toast("Enter valid minimum and maximum ranges for both male and female.", "error"); return;
    }
    const id = editingId || String(Date.now());
    const nextItem = { ...form, id, name };
    const next = editingId ? tests.map(item => item.id === editingId ? nextItem : item) : [...tests, nextItem];
    setBusy(true);
    try {
      const category = String(nextItem.category || "").trim();
      const nextBranches = category && !branches.some(branch => branch.toLocaleLowerCase() === category.toLocaleLowerCase())
        ? [...branches, category].sort((a, b) => a.localeCompare(b)) : branches;
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)); triggerAutomaticDriveBackup("appSettings");
      await AsyncStorage.setItem(BRANCHES_KEY, JSON.stringify(nextBranches));
      triggerAutomaticDriveBackup("appSettings");
      setBranches(nextBranches);
      setTests(next); setForm(blank()); setEditingId("");
      toast("Lab test and reference ranges saved on this device.", "success");
    } catch { toast("Could not save the lab test settings.", "error"); }
    finally { setBusy(false); }
  };
  const saveWarningThreshold = async () => {
    const value = Number(warningPercent);
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      toast("Enter a whole percentage from 1 to 100.", "error"); return;
    }
    setThresholdBusy(true);
    try {
      await AsyncStorage.setItem(WARNING_THRESHOLD_KEY, String(value));
      triggerAutomaticDriveBackup("appSettings");
      setWarningPercent(String(value));
      toast("Lab warning threshold saved: " + value + "%.", "success");
    } catch { toast("Could not save the warning threshold.", "error"); }
    finally { setThresholdBusy(false); }
  };
  const saveOldResultDays = async () => {
    const value = Number(oldResultDays);
    if (!Number.isInteger(value) || value < 1 || value > 3650) { toast("Enter a whole number of days from 1 to 3650.", "error"); return; }
    setOldDaysBusy(true);
    try {
      await AsyncStorage.setItem(OLD_RESULT_DAYS_KEY, String(value));
      triggerAutomaticDriveBackup("appSettings");
      setOldResultDays(String(value));
      toast("Old lab-result alert saved: " + value + " days before patient was added.", "success");
    } catch { toast("Could not save the old-result alert setting.", "error"); }
    finally { setOldDaysBusy(false); }
  };


  const saveVisionEndpoint = async () => {
    try {
      const endpoint = validateLabVisionEndpoint(visionEndpoint);
      await AsyncStorage.setItem(LAB_VISION_ENDPOINT_KEY, endpoint);
      if (visionToken.trim()) await SecureStore.setItemAsync(LAB_VISION_CLIENT_TOKEN_KEY, visionToken.trim());
      else await SecureStore.deleteItemAsync(LAB_VISION_CLIENT_TOKEN_KEY);
      if (!endpoint || !visionToken.trim()) {
        await AsyncStorage.setItem(LAB_VISION_CONSENT_KEY, "false");
        setVisionConsent(false);
      }
      triggerAutomaticDriveBackup("appSettings");
      setVisionEndpoint(endpoint);
      toast(endpoint ? "HTTPS AI-vision endpoint saved. External processing remains off until separately enabled." : "AI-vision endpoint cleared and external processing disabled.", "success");
    } catch (error: any) { toast(error?.message || "Could not save the AI-vision endpoint.", "error"); }
  };
  const setVisionPermission = async (value: boolean) => {
    try {
      const endpoint = validateLabVisionEndpoint(visionEndpoint);
      if (value && (!endpoint || !visionToken.trim())) { toast("Save a valid HTTPS endpoint and client token before enabling external processing.", "error"); return; }
      await AsyncStorage.setItem(LAB_VISION_CONSENT_KEY, value ? "true" : "false");
      setVisionConsent(value);
      triggerAutomaticDriveBackup("appSettings");
      toast(value ? "AI-vision external processing enabled. Lab images may leave this device." : "AI-vision external processing disabled; offline OCR remains available.", value ? "info" : "success");
    } catch (error: any) { toast(error?.message || "Could not change AI-vision permission.", "error"); }
  };
  const saveTemplate = async () => {
    const name = templateName.trim();
    const markers = templateMarkers.split(/[,;\n]+/).map(value => value.trim()).filter(Boolean);
    const columnHints = templateColumns.split(/[,;\n]+/).map(value => value.trim()).filter(Boolean);
    if (!name || !markers.length) { toast("Enter a template name and at least one distinctive report phrase.", "error"); return; }
    const next = [...visionTemplates.filter(item => item.name.toLowerCase() !== name.toLowerCase()), { id: String(Date.now()), name, markers, columnHints }];
    try {
      await AsyncStorage.setItem(LAB_VISION_TEMPLATES_KEY, JSON.stringify(next));
      triggerAutomaticDriveBackup("appSettings");
      setVisionTemplates(next);
      setTemplateName(""); setTemplateMarkers(""); setTemplateColumns("");
      toast("Lab report template saved. Matching phrases will guide AI vision.", "success");
    } catch { toast("Could not save the lab report template.", "error"); }
  };
  const deleteTemplate = async (template: LabVisionTemplate) => {
    const next = visionTemplates.filter(item => item.id !== template.id);
    try {
      await AsyncStorage.setItem(LAB_VISION_TEMPLATES_KEY, JSON.stringify(next));
      triggerAutomaticDriveBackup("appSettings");
      setVisionTemplates(next);
      toast("Lab report template deleted.", "success");
    } catch { toast("Could not delete the lab report template.", "error"); }
  };

  const saveCustomScreeningBox = async () => {
    const label = customScreeningLabel.trim().replace(/\s+/g, " ");
    if (!label) { toast("Enter a label for the patient checkbox.", "error"); return; }
    if (label.length > 40) { toast("Use a label of 40 characters or fewer.", "error"); return; }
    const duplicate = customScreeningBoxes.some(item => item.label.toLocaleLowerCase() === label.toLocaleLowerCase() && item.id !== editingCustomScreeningId);
    if (duplicate) { toast("A checkbox with that label already exists.", "error"); return; }
    const id = editingCustomScreeningId || String(Date.now());
    const next = editingCustomScreeningId
      ? customScreeningBoxes.map(item => item.id === editingCustomScreeningId ? { ...item, label } : item)
      : [...customScreeningBoxes, { id, label }];
    try {
      await AsyncStorage.setItem(CUSTOM_SCREENING_BOXES_KEY, JSON.stringify(next));
      triggerAutomaticDriveBackup("appSettings");
      setCustomScreeningBoxes(next);
      setCustomScreeningLabel("");
      setEditingCustomScreeningId("");
      toast(editingCustomScreeningId ? "Patient checkbox updated." : "Patient checkbox added.", "success");
    } catch { toast("Could not save the patient checkbox.", "error"); }
  };
  const editCustomScreeningBox = (item: CustomScreeningBox) => { setCustomScreeningLabel(item.label); setEditingCustomScreeningId(item.id); };
  const deleteCustomScreeningBox = (item: CustomScreeningBox) => Alert.alert("Delete checkbox?", "Remove " + item.label + " from the patient form? Existing patient values will be retained in their records.", [
    { text: "Cancel", style: "cancel" },
    { text: "Delete", style: "destructive", onPress: async () => {
      const next = customScreeningBoxes.filter(box => box.id !== item.id);
      try {
        await AsyncStorage.setItem(CUSTOM_SCREENING_BOXES_KEY, JSON.stringify(next));
        triggerAutomaticDriveBackup("appSettings");
        setCustomScreeningBoxes(next);
        if (editingCustomScreeningId === item.id) { setEditingCustomScreeningId(""); setCustomScreeningLabel(""); }
        toast("Checkbox removed from the patient form.", "success");
      } catch { toast("Could not delete the checkbox.", "error"); }
    } },
  ]);

  const saveOnlineOcrKey = async () => {
    setOnlineKeyBusy(true);
    try {
      const key = onlineOcrKey.trim();
      if (key) await AsyncStorage.setItem(ONLINE_OCR_KEY, key);
      else await AsyncStorage.removeItem(ONLINE_OCR_KEY);
      triggerAutomaticDriveBackup("appSettings");
      toast(key ? "Online OCR key saved on this device." : "Online OCR disabled; offline OCR remains available.", "success");
    } catch { toast("Could not save the online OCR key.", "error"); }
    finally { setOnlineKeyBusy(false); }
  };
  const edit = (item: LabTestDefinition) => { setForm({ ...item }); setEditingId(item.id); };
  const remove = (item: LabTestDefinition) => Alert.alert("Delete test?", "Remove " + item.name + " and its configured reference ranges?", [
    { text: "Cancel", style: "cancel" },
    { text: "Delete", style: "destructive", onPress: async () => {
      const next = tests.filter(test => test.id !== item.id);
      try { await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)); triggerAutomaticDriveBackup("appSettings"); setTests(next); if (editingId === item.id) { setEditingId(""); setForm(blank()); } }
      catch { toast("Could not delete this test.", "error"); }
    } },
  ]);
  const field = (label: string, key: keyof LabTestDefinition, placeholder: string) => <View style={styles.field}><Text style={styles.label}>{label}</Text><TextInput value={String(form[key] || "")} onChangeText={value => update({ [key]: value } as Partial<LabTestDefinition>)} placeholder={placeholder} placeholderTextColor={colors.muted} autoCapitalize={key === "name" || key === "unit" ? "words" : "none"} keyboardType={["maleMin","maleMax","femaleMin","femaleMax"].includes(key) ? "decimal-pad" : "default"} style={styles.input}/></View>;
  if (user?.role !== "admin") return <View style={styles.container}><Text style={styles.title}>Administrator only</Text></View>;
  return <View style={styles.container}>
    <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
      <Pressable onPress={() => router.replace("/settings" as any)} style={styles.back}><Ionicons name="arrow-back" size={22} color={colors.onSurface}/></Pressable>
      <Text style={styles.title}>Lab Test Reference Ranges</Text><View style={styles.back}/>
    </View>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + spacing.xxl }}>
      <Text style={styles.help}>For strongest automatic results, add each test your lab reports, enter its alternate labels/abbreviations, assign its branch, and save the correct male/female limits and unit. These admin definitions are used first when matching OCR labels and deciding abnormal results. The scanner will leave uncertain results unclassified rather than invent a value.</Text>

      <Text style={styles.section}>Patient form checkboxes</Text>
      <Text style={styles.help}>Add or edit extra patient checkboxes here. They appear alongside HCV+, HBsAg, HIV, MP ICT and Dengue. Existing standard checkboxes are unchanged.</Text>
      <View style={styles.field}><Text style={styles.label}>{editingCustomScreeningId ? "Edit checkbox label" : "New checkbox label"}</Text><TextInput value={customScreeningLabel} onChangeText={setCustomScreeningLabel} placeholder="e.g. MRSA" placeholderTextColor={colors.muted} maxLength={40} style={styles.input}/></View>
      <Pressable onPress={saveCustomScreeningBox} style={styles.action}><Text style={styles.actionText}>{editingCustomScreeningId ? "Save checkbox changes" : "Add patient checkbox"}</Text></Pressable>
      {editingCustomScreeningId ? <Pressable onPress={() => { setEditingCustomScreeningId(""); setCustomScreeningLabel(""); }} style={styles.action}><Text style={styles.actionText}>Cancel edit</Text></Pressable> : null}
      {customScreeningBoxes.map(item => <View key={item.id} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        <Text style={{ flex: 1, color: colors.onSurface, fontFamily: fontFamily.semibold }}>{item.label}</Text>
        <Pressable onPress={() => editCustomScreeningBox(item)} style={styles.iconBtn}><Ionicons name="create-outline" size={21} color={colors.brandPrimary}/></Pressable>
        <Pressable onPress={() => deleteCustomScreeningBox(item)} style={styles.iconBtn}><Ionicons name="trash-outline" size={21} color={colors.error}/></Pressable>
      </View>)}

      <Text style={styles.section}>AI vision + lab report templates</Text>
      <Text style={styles.help}>Configure an HTTPS endpoint approved by your organization. Keep provider API keys on the server, not in this app. The endpoint must have suitable healthcare privacy terms, no-training and no-retention controls. The image itself can contain patient identifiers, so do not enable this unless your organization has approved sending lab images. AI results are suggestions only and must be checked by an administrator against the original image before they are saved.</Text>
      <View style={styles.field}><Text style={styles.label}>Secure AI-vision HTTPS endpoint</Text><TextInput value={visionEndpoint} onChangeText={setVisionEndpoint} placeholder="https://your-approved-service.example/api/lab-vision" placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} keyboardType="url" style={styles.input}/></View>
      <View style={styles.field}><Text style={styles.label}>AI-vision client token (from server administrator)</Text><TextInput value={visionToken} onChangeText={setVisionToken} placeholder="Paste client token" placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} secureTextEntry style={styles.input}/></View>
      <Pressable onPress={saveVisionEndpoint} style={styles.action}><Text style={styles.actionText}>Save AI-vision endpoint and token</Text></Pressable>
      <View style={styles.field}>
        <Text style={styles.label}>Allow sending lab images to this AI service</Text>
        <Switch value={visionConsent} onValueChange={setVisionPermission} trackColor={{ false: colors.border, true: colors.brandPrimary }} thumbColor={visionConsent ? colors.onBrandPrimary : colors.muted} accessibilityLabel="Allow sending lab images to configured AI vision endpoint" />
        <Text style={styles.help}>{visionConsent ? "Enabled: lab images may be sent to the configured HTTPS endpoint. Disable any time." : "Disabled by default. AI vision will not send images until you enable this switch."}</Text>
      </View>
      <Text style={styles.section}>Lab report layout templates</Text>
      <Text style={styles.help}>Create a template for a recurring laboratory layout. Add distinctive printed phrases such as the lab name or report heading, and optional column headings. The app chooses a template only when its phrases match; templates never define medical ranges.</Text>
      <View style={styles.field}><Text style={styles.label}>Template name / laboratory</Text><TextInput value={templateName} onChangeText={setTemplateName} placeholder="e.g. City Lab CBC format" placeholderTextColor={colors.muted} style={styles.input}/></View>
      <View style={styles.field}><Text style={styles.label}>Distinctive phrases (comma separated)</Text><TextInput value={templateMarkers} onChangeText={setTemplateMarkers} placeholder="e.g. City Diagnostic, Complete Blood Count" placeholderTextColor={colors.muted} style={styles.input}/></View>
      <View style={styles.field}><Text style={styles.label}>Column headings (comma separated, optional)</Text><TextInput value={templateColumns} onChangeText={setTemplateColumns} placeholder="e.g. Test Name, Result, Unit, Reference Range" placeholderTextColor={colors.muted} style={styles.input}/></View>
      <Pressable onPress={saveTemplate} style={styles.action}><Text style={styles.actionText}>Save lab report template</Text></Pressable>
      {visionTemplates.map(template => <View key={template.id} style={[styles.field, { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.sm }]}>
        <Text style={styles.label}>{template.name}</Text><Text style={styles.help}>Matches: {template.markers.join(", ")}</Text>
        {template.columnHints?.length ? <Text style={styles.help}>Columns: {template.columnHints.join(", ")}</Text> : null}
        <Pressable onPress={() => deleteTemplate(template)}><Text style={[styles.actionText, { color: colors.error || "#B91C1C" }]}>Delete template</Text></Pressable>
      </View>)}
      <Text style={styles.help}>Service contract: POST multipart/form-data with a file and metadata; return JSON rows containing test, result, optional unit, confidence (0 to 1), and optional reason. See docs/lab-vision-endpoint.md.</Text>
      <Text style={styles.section}>Optional third-party OCR (not AI vision)</Text>
      <Text style={styles.help}>OCR.space is a third-party OCR service, not the proposed AI-vision system. Do not enable it for identifiable patient reports unless your organization has reviewed and approved the service and its data handling. When enabled, the lab image is sent to OCR.space. Until the combined secure AI-vision service is configured, offline processing remains the default.</Text>
      <View style={styles.field}>
        <Text style={styles.label}>Allow sending lab images to OCR.space</Text>
        <Switch value={onlineOcrConsent} onValueChange={async value => {
          setOnlineOcrConsent(value);
          try {
            await AsyncStorage.setItem(ONLINE_OCR_CONSENT_KEY, value ? "true" : "false");
            triggerAutomaticDriveBackup("appSettings");
            toast(value ? "Third-party image processing enabled. Lab images may leave this device." : "Third-party image processing disabled. Offline OCR remains available.", value ? "info" : "success");
          } catch { setOnlineOcrConsent(!value); toast("Could not save the external-processing permission.", "error"); }
        }} trackColor={{ false: colors.border, true: colors.brandPrimary }} thumbColor={onlineOcrConsent ? colors.onBrandPrimary : colors.muted} accessibilityLabel="Allow sending lab images to OCR.space" />
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>OCR.space API key</Text>
        <TextInput value={onlineOcrKey} onChangeText={setOnlineOcrKey} placeholder="Enter API key (optional)" placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} secureTextEntry style={styles.input}/>
      </View>
      <Pressable disabled={onlineKeyBusy} onPress={saveOnlineOcrKey} style={styles.action}><Text style={styles.actionText}>{onlineKeyBusy ? "Saving…" : "Save online OCR key"}</Text></Pressable>
      <Text style={styles.section}>Warning threshold (%)</Text>
      <Text style={styles.help}>If a result is outside the selected reference limit by this percentage or less, show WARNING. A larger difference shows ALERT. Example: at 10%, a result 5% above the upper limit is WARNING; 15% above is ALERT. Results inside the range are not flagged.</Text>
      <View style={styles.field}>
        <Text style={styles.label}>Threshold from 1% to 100%</Text>
        <TextInput value={warningPercent} onChangeText={setWarningPercent} keyboardType="number-pad" placeholder="10" placeholderTextColor={colors.muted} style={styles.input}/>
      </View>
      <Pressable disabled={thresholdBusy} onPress={saveWarningThreshold} style={styles.action}><Text style={styles.actionText}>{thresholdBusy ? "Saving…" : "Save warning threshold"}</Text></Pressable>
      <Text style={styles.section}>Old lab-result alert</Text>
      <Text style={styles.help}>Show an OLD LAB RESULT alert outside the Patient Form when a report date is this many days or more before the patient was first added to this app. Example: 10 days. The report date and patient-added date are required.</Text>
      <View style={styles.field}>
        <Text style={styles.label}>Days before patient was added</Text>
        <TextInput value={oldResultDays} onChangeText={setOldResultDays} keyboardType="number-pad" selectTextOnFocus style={styles.input} placeholder="10" />
      </View>
      <Pressable disabled={oldDaysBusy} onPress={saveOldResultDays} style={styles.action}><Text style={styles.actionText}>{oldDaysBusy ? "Saving…" : "Save old-result alert"}</Text></Pressable>

      <Text style={styles.section}>Test branches</Text>
      <Text style={styles.help}>Create clear groups such as CBC, LFT, RFT, Viral Markers, or any custom branch used by your laboratory. Select a branch before saving each test. Branches only organize tests; they do not replace or change the saved sex-specific reference ranges used by automatic lab scanning.</Text>
      <View style={styles.branchCreate}>
        <TextInput value={newBranch} onChangeText={setNewBranch} placeholder="New branch name (e.g. CBC)" placeholderTextColor={colors.muted} autoCapitalize="words" style={[styles.input, { flex: 1 }]} />
        <Pressable onPress={addBranch} style={styles.branchAdd}><Text style={styles.primaryText}>Add</Text></Pressable>
      </View>
      <View style={styles.branchList}>
        {branches.map(branch => <Pressable key={branch} onPress={() => update({ category: branch })} style={[styles.branchChip, (form.category || "").toLocaleLowerCase() === branch.toLocaleLowerCase() ? styles.branchChipSelected : null]}>
          <Text style={[styles.branchChipText, (form.category || "").toLocaleLowerCase() === branch.toLocaleLowerCase() ? styles.branchChipTextSelected : null]}>{branch}</Text>
        </Pressable>)}
      </View>
      {field("Test name", "name", "e.g. Hemoglobin")}
      {field("Assigned branch", "category", "Choose a branch above or type a new one")}
      <Text style={styles.help}>Each test belongs to the branch shown here. The scanner still matches test names/aliases and uses the saved male/female range first, regardless of branch.</Text>
      {field("Other report labels / OCR aliases", "aliases", "e.g. Hb, HGB, Haemoglobin (comma-separated)") }
      <Text style={styles.help}>Enter all labels this laboratory may print for the same test (abbreviations, alternate spellings, and common OCR misspellings). Exact admin labels are preferred; the scanner can cautiously recover small spelling errors in longer configured names. Saved male/female ranges and the saved unit take priority over ranges read from the image. Do not add a different test as an alias.</Text>
      <Text style={styles.section}>Male reference range</Text>
      <View style={styles.two}>{field("From (minimum)", "maleMin", "12")}{field("To (maximum)", "maleMax", "16")}</View>
      <Text style={styles.section}>Female reference range</Text>
      <View style={styles.two}>{field("From (minimum)", "femaleMin", "11")}{field("To (maximum)", "femaleMax", "15")}</View>
      {field("Unit", "unit", "g/dL")}
      <Pressable disabled={busy} onPress={save} style={styles.primary}><Text style={styles.primaryText}>{busy ? "Saving…" : editingId ? "Save changes" : "Add test"}</Text></Pressable>
      {editingId ? <Pressable onPress={() => { setEditingId(""); setForm(blank()); }} style={styles.action}><Text style={styles.actionText}>Cancel editing</Text></Pressable> : null}
      <Text style={styles.section}>Saved tests ({tests.length})</Text>
      {tests.map(item => <View key={item.id} style={styles.item}>
        <View style={{ flex: 1 }}>
          <Text style={styles.itemTitle}>{item.name}</Text>
          {item.category?.trim() ? <Text style={styles.branchLabel}>Branch: {item.category}</Text> : <Text style={styles.branchLabel}>Branch: Not assigned</Text>}
          <Text style={styles.help}>Male: {item.maleMin}–{item.maleMax} {item.unit} · Female: {item.femaleMin}–{item.femaleMax} {item.unit}</Text>
          {item.aliases?.trim() ? <Text style={styles.help}>Recognized labels: {item.aliases}</Text> : null}
        </View>
        <Pressable onPress={() => edit(item)} style={styles.iconBtn}><Ionicons name="create-outline" size={21} color={colors.brandPrimary}/></Pressable>
        <Pressable onPress={() => remove(item)} style={styles.iconBtn}><Ionicons name="trash-outline" size={21} color={colors.error}/></Pressable>
      </View>)}
    </ScrollView>
  </View>;
}

const useStyles = makeStyles(colors => ({
  container: { flex: 1, backgroundColor: colors.surfaceSecondary },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.md, paddingBottom: spacing.md, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
  back: { width: 36, height: 40, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, textAlign: "center", fontFamily: fontFamily.bold, fontSize: fontSize.lg, color: colors.onSurface },
  help: { fontFamily: fontFamily.regular, fontSize: fontSize.sm, color: colors.muted, marginBottom: spacing.md },
  section: { fontFamily: fontFamily.semibold, fontSize: fontSize.base, color: colors.onSurface, marginTop: spacing.md, marginBottom: spacing.sm },
  field: { flex: 1, marginBottom: spacing.md },
  label: { fontFamily: fontFamily.medium, fontSize: fontSize.sm, color: colors.onSurface, marginBottom: spacing.xs },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surface, color: colors.onSurface, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, minHeight: 46, fontFamily: fontFamily.regular, fontSize: fontSize.base },
  two: { flexDirection: "row", gap: spacing.sm },
  branchCreate: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.sm },
  branchAdd: { backgroundColor: colors.brandPrimary, paddingHorizontal: spacing.lg, minHeight: 46, borderRadius: radius.md, alignItems: "center", justifyContent: "center" },
  branchList: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginBottom: spacing.md },
  branchChip: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  branchChipSelected: { backgroundColor: colors.brandPrimary, borderColor: colors.brandPrimary },
  branchChipText: { color: colors.onSurface, fontFamily: fontFamily.medium, fontSize: fontSize.sm },
  branchChipTextSelected: { color: colors.onBrandPrimary },
  branchLabel: { color: colors.brandPrimary, fontFamily: fontFamily.semibold, fontSize: fontSize.sm, marginTop: spacing.xs },
  primary: { backgroundColor: colors.brandPrimary, padding: spacing.md, borderRadius: radius.md, alignItems: "center", marginTop: spacing.sm },
  primaryText: { color: colors.onBrandPrimary, fontFamily: fontFamily.semibold, fontSize: fontSize.base },
  action: { borderWidth: 1, borderColor: colors.border, padding: spacing.md, borderRadius: radius.md, alignItems: "center", marginTop: spacing.sm },
  actionText: { color: colors.onSurface, fontFamily: fontFamily.medium, fontSize: fontSize.base },
  item: { flexDirection: "row", alignItems: "center", gap: spacing.xs, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm },
  itemTitle: { fontFamily: fontFamily.semibold, color: colors.onSurface, fontSize: fontSize.base },
  iconBtn: { padding: spacing.xs },
}));
