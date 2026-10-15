import AsyncStorage from "@react-native-async-storage/async-storage";
import Ionicons from "@react-native-vector-icons/ionicons";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "@/src/auth/AuthContext";
import { useToast } from "@/src/components/toast";
import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";
import { triggerAutomaticDriveBackup } from "@/src/utils/storage/drive-auto-backup";

export type LabTestDefinition = {
  id: string;
  name: string;
  maleMin: string;
  maleMax: string;
  femaleMin: string;
  femaleMax: string;
  unit: string;
};

const STORAGE_KEY = "ortho_lab_test_definitions_v1";
const WARNING_THRESHOLD_KEY = "ortho_lab_warning_threshold_percent_v1";
const OLD_RESULT_DAYS_KEY = "ortho_lab_old_result_days_v1";
const ONLINE_OCR_KEY = "ortho_lab_online_ocr_api_key_v1";
const blank = (): LabTestDefinition => ({ id: "", name: "", maleMin: "", maleMax: "", femaleMin: "", femaleMax: "", unit: "" });

export default function LabTestSettingsScreen() {
  const { user } = useAuth();
  const { colors } = useTheme();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const [tests, setTests] = useState<LabTestDefinition[]>([]);
  const [form, setForm] = useState<LabTestDefinition>(blank());
  const [editingId, setEditingId] = useState("");
  const [busy, setBusy] = useState(false);
  const [warningPercent, setWarningPercent] = useState("10");
  const [oldResultDays, setOldResultDays] = useState("10");
  const [oldDaysBusy, setOldDaysBusy] = useState(false);
  const [thresholdBusy, setThresholdBusy] = useState(false);
  const [onlineOcrKey, setOnlineOcrKey] = useState("");
  const [onlineKeyBusy, setOnlineKeyBusy] = useState(false);

  useEffect(() => { AsyncStorage.getItem(STORAGE_KEY).then(raw => { if (raw) { try { setTests(JSON.parse(raw)); } catch {} } }).catch(() => {}); AsyncStorage.getItem(WARNING_THRESHOLD_KEY).then(raw => { if (raw && Number.isFinite(Number(raw))) setWarningPercent(String(Math.max(1, Math.min(100, Math.round(Number(raw)))))); }).catch(() => {}); AsyncStorage.getItem(ONLINE_OCR_KEY).then(raw => setOnlineOcrKey(raw || "")).catch(() => {}); AsyncStorage.getItem(OLD_RESULT_DAYS_KEY).then(raw => { if (raw && Number.isFinite(Number(raw))) setOldResultDays(String(Math.max(1, Math.min(3650, Math.round(Number(raw)))))); }).catch(() => {}); }, []);
  const update = (patch: Partial<LabTestDefinition>) => setForm(current => ({ ...current, ...patch }));
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
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      triggerAutomaticDriveBackup("appSettings");
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
      toast("Old lab-result alert saved: " + value + " days before patient date.", "success");
    } catch { toast("Could not save the old-result alert setting.", "error"); }
    finally { setOldDaysBusy(false); }
  };

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
      <Pressable onPress={() => router.back()} style={styles.back}><Ionicons name="arrow-back" size={22} color={colors.onSurface}/></Pressable>
      <Text style={styles.title}>Lab Test Reference Ranges</Text><View style={styles.back}/>
    </View>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + spacing.xxl }}>
      <Text style={styles.help}>Add the exact test names used by your laboratory and the reference interval printed by that lab. These settings are saved locally on this phone. OCR must not guess a test name or treat dates and report headers as tests.</Text>
      <Text style={styles.section}>Online OCR (optional)</Text>
      <Text style={styles.help}>When a key is saved, the app tries OCR.space online and uses its text only if it appears more complete than offline OCR. If internet or the service fails, offline OCR continues. Lab images are sent to OCR.space while online OCR is enabled. Obtain an API key from ocr.space; do not paste a Google/GitHub key here.</Text>
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
      {field("Test name", "name", "e.g. Hemoglobin")}
      <Text style={styles.section}>Old lab-result alert</Text>
      <Text style={styles.help}>Show an OLD LAB RESULT alert outside the Patient Form when a report date is this many days or more before the patient record date. Example: 10 days. A readable report date and patient date are required.</Text>
      <View style={styles.field}>
        <Text style={styles.label}>Days before patient date</Text>
        <TextInput value={oldResultDays} onChangeText={setOldResultDays} keyboardType="number-pad" selectTextOnFocus style={styles.input} placeholder="10" />
      </View>
      <Pressable disabled={oldDaysBusy} onPress={saveOldResultDays} style={styles.action}><Text style={styles.actionText}>{oldDaysBusy ? "Saving…" : "Save old-result alert"}</Text></Pressable>

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
          <Text style={styles.help}>Male: {item.maleMin}–{item.maleMax} {item.unit} · Female: {item.femaleMin}–{item.femaleMax} {item.unit}</Text>
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
  primary: { backgroundColor: colors.brandPrimary, padding: spacing.md, borderRadius: radius.md, alignItems: "center", marginTop: spacing.sm },
  primaryText: { color: colors.onBrandPrimary, fontFamily: fontFamily.semibold, fontSize: fontSize.base },
  action: { borderWidth: 1, borderColor: colors.border, padding: spacing.md, borderRadius: radius.md, alignItems: "center", marginTop: spacing.sm },
  actionText: { color: colors.onSurface, fontFamily: fontFamily.medium, fontSize: fontSize.base },
  item: { flexDirection: "row", alignItems: "center", gap: spacing.xs, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm },
  itemTitle: { fontFamily: fontFamily.semibold, color: colors.onSurface, fontSize: fontSize.base },
  iconBtn: { padding: spacing.xs },
}));
