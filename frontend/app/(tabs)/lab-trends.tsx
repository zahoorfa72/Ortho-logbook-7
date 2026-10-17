import AsyncStorage from "@react-native-async-storage/async-storage";
import Ionicons from "@react-native-vector-icons/ionicons";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "@/src/api/client";
import { useToast } from "@/src/components/toast";
import { fontFamily, fontSize, radius, spacing, useTheme } from "@/src/theme";
import { triggerAutomaticDriveBackup } from "@/src/utils/storage/drive-auto-backup";

type Patient = {
  id: string;
  mrNo: string;
  name: string;
  gender?: string;
  date?: string;
  createdAt?: string;
  customData?: Record<string, string>;
};
type TrendEntry = {
  id: string;
  patientId: string;
  patientName: string;
  mrNo: string;
  test: string;
  result: string;
  unit: string;
  date: string;
  reference: string;
  severity: string;
  source: "manual" | "imported";
};
const KEY = "ortho_lab_trend_history_v1";
const today = () => {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
};
const norm = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
const numeric = (value: string) => {
  const match = String(value || "").replace(/,/g, ".").match(/[-+]?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : NaN;
};
const normalizeDate = (value: unknown) => {
  const text = String(value || "").trim();
  let match = /^(\\d{4})-(\\d{1,2})-(\\d{1,2})/.exec(text);
  if (match) return match[1] + "-" + String(Number(match[2])).padStart(2, "0") + "-" + String(Number(match[3])).padStart(2, "0");
  match = /^(\\d{1,2})[-/. ]([A-Za-z]{3})[-/. ](\\d{4})$/.exec(text);
  if (match) {
    const months: Record<string, string> = { jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12" };
    const month = months[match[2].toLowerCase()];
    if (month) return match[3] + "-" + month + "-" + String(Number(match[1])).padStart(2, "0");
  }
  match = /^(\\d{1,2})[-/. ](\\d{1,2})[-/. ](\\d{4})$/.exec(text);
  if (match) return match[3] + "-" + String(Number(match[2])).padStart(2, "0") + "-" + String(Number(match[1])).padStart(2, "0");
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : today();
};
const sortDate = (s: string) => {
  const t = Date.parse(normalizeDate(s) + "T12:00:00");
  return Number.isFinite(t) ? t : 0;
};

export default function LabTrendsScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const [entries, setEntries] = useState<TrendEntry[]>([]);
  const [selectedPatientId, setSelectedPatientId] = useState("");
  const [patientSearch, setPatientSearch] = useState("");
  const [testFilter, setTestFilter] = useState("");
  const [test, setTest] = useState("");
  const [result, setResult] = useState("");
  const [unit, setUnit] = useState("");
  const [date, setDate] = useState(today());
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const { data: patients = [], isLoading, refetch } = useQuery<Patient[]>({
    queryKey: ["patients"],
    queryFn: () => api.get("/patients"),
  });

  useEffect(() => {
    AsyncStorage.getItem(KEY).then(raw => {
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setEntries(parsed.filter(item => item && item.patientId && item.test && item.result));
      } catch {}
    }).catch(() => {});
  }, []);

  const selectedPatient = patients.find(p => p.id === selectedPatientId) || null;
  const visiblePatients = useMemo(() => {
    const q = patientSearch.trim().toLowerCase();
    return patients.filter(p => !q || String(p.name || "").toLowerCase().includes(q) || String(p.mrNo || "").toLowerCase().includes(q));
  }, [patients, patientSearch]);

  const patientEntries = useMemo(() => entries
    .filter(e => e.patientId === selectedPatientId)
    .filter(e => !testFilter.trim() || e.test.toLowerCase().includes(testFilter.trim().toLowerCase()))
    .sort((a, b) => sortDate(a.date) - sortDate(b.date)), [entries, selectedPatientId, testFilter]);

  const chartTestName = testFilter.trim() || patientEntries[patientEntries.length - 1]?.test || "";
  const selectedTestEntries = useMemo(() => {
    if (!chartTestName) return [];
    return patientEntries.filter(e => norm(e.test) === norm(chartTestName));
  }, [patientEntries, chartTestName]);

  const saveEntries = async (next: TrendEntry[]) => {
    setEntries(next);
    await AsyncStorage.setItem(KEY, JSON.stringify(next));
    triggerAutomaticDriveBackup("appSettings");
  };

  const importVerifiedResults = async () => {
    if (!patients.length) {
      toast("No patients are available to import.", "error");
      return;
    }
    setBusy(true);
    try {
      const next = [...entries];
      let imported = 0;
      for (const patient of patients) {
        let saved: any[] = [];
        try {
          const raw = patient.customData?.labOcrManualResults;
          const parsed = raw ? JSON.parse(raw) : [];
          if (Array.isArray(parsed)) saved = parsed;
        } catch {}
        for (const item of saved) {
          const testName = String(item?.test || "").trim();
          const value = String(item?.result ?? "").trim();
          if (!testName || !value) continue;
          const resultDate = normalizeDate(item.date || patient.date || patient.createdAt || today());
          const duplicate = next.some(e => e.patientId === patient.id && norm(e.test) === norm(testName) &&
            e.date === resultDate && String(e.result).trim() === value);
          if (duplicate) continue;
          next.push({
            id: "import-" + patient.id + "-" + norm(testName) + "-" + resultDate + "-" + next.length,
            patientId: patient.id,
            patientName: patient.name || "Unnamed patient",
            mrNo: patient.mrNo || "",
            test: testName,
            result: value,
            unit: String(item.unit || ""),
            date: resultDate,
            reference: String(item.reference || ""),
            severity: String(item.severity || ""),
            source: "imported",
          });
          imported++;
        }
      }
      await saveEntries(next);
      toast(imported ? "Imported " + imported + " verified result snapshot(s)." : "No new verified results to import.", imported ? "success" : "info");
    } catch {
      toast("Could not import lab results. Your existing lab records were not changed.", "error");
    } finally {
      setBusy(false);
    }
  };

  const addEntry = async () => {
    if (!selectedPatient) {
      toast("Select a patient first.", "error");
      return;
    }
    if (!test.trim() || !result.trim()) {
      toast("Enter the test name and result.", "error");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date + "T12:00:00"))) {
      toast("Enter the date in YYYY-MM-DD format.", "error");
      return;
    }
    const entry: TrendEntry = {
      id: "manual-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
      patientId: selectedPatient.id,
      patientName: selectedPatient.name || "Unnamed patient",
      mrNo: selectedPatient.mrNo || "",
      test: test.trim(),
      result: result.trim(),
      unit: unit.trim(),
      date,
      reference: reference.trim(),
      severity: "",
      source: "manual",
    };
    try {
      await saveEntries([...entries, entry]);
      setTestFilter(entry.test);
      setTest("");
      setResult("");
      setUnit("");
      setReference("");
      setDate(today());
      toast("Trend entry saved separately from the existing lab feature.", "success");
    } catch {
      toast("Could not save this trend entry.", "error");
    }
  };

  const removeEntry = (entry: TrendEntry) => Alert.alert("Delete trend entry?", "This only deletes the separate trend snapshot; it does not change the patient record or existing lab feature.", [
    { text: "Cancel", style: "cancel" },
    { text: "Delete", style: "destructive", onPress: () => {
      const next = entries.filter(e => e.id !== entry.id);
      saveEntries(next).then(() => toast("Trend entry deleted.", "success")).catch(() => toast("Could not delete trend entry.", "error"));
    } },
  ]);

  const chartEntries = selectedTestEntries.filter(e => Number.isFinite(numeric(e.result)));
  const numbers = chartEntries.map(e => numeric(e.result));
  const min = numbers.length ? Math.min(...numbers) : 0;
  const max = numbers.length ? Math.max(...numbers) : 0;
  const range = max - min || Math.max(Math.abs(max) * 0.15, 1);
  const first = numbers[0];
  const last = numbers[numbers.length - 1];
  const trendLabel = numbers.length < 2 ? "Need at least two numeric results" :
    last > first ? "Increasing" : last < first ? "Decreasing" : "Stable";
  const trendColor = numbers.length < 2 ? colors.muted : last > first ? (colors.error || "#B91C1C") : last < first ? (colors.success || "#15803D") : colors.muted;

  const field = (label: string, value: string, setValue: (value: string) => void, placeholder: string, keyboardType: "default" | "decimal-pad" = "default") => (
    <View style={{ marginTop: spacing.sm }}>
      <Text style={{ color: colors.muted, fontFamily: fontFamily.medium, fontSize: fontSize.xs, marginBottom: 5 }}>{label}</Text>
      <TextInput value={value} onChangeText={setValue} placeholder={placeholder} placeholderTextColor={colors.muted}
        keyboardType={keyboardType} autoCapitalize="none"
        style={{ borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10, color: colors.onSurface, backgroundColor: colors.surface, fontFamily: fontFamily.regular }} />
    </View>
  );

  const button = (label: string, onPress: () => void, icon: string, disabled = false) => (
    <Pressable onPress={onPress} disabled={disabled} style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 12, backgroundColor: disabled ? colors.border : colors.brandPrimary, opacity: disabled ? 0.65 : 1 }}>
      <Ionicons name={icon as any} size={18} color="#FFFFFF" />
      <Text style={{ color: "#FFFFFF", fontFamily: fontFamily.semibold, fontSize: fontSize.sm }}>{label}</Text>
    </Pressable>
  );

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.surfaceSecondary }} contentContainerStyle={{ padding: spacing.md, paddingTop: Math.max(insets.top, spacing.md), paddingBottom: Math.max(insets.bottom, spacing.xl) + 24 }}>
      <View style={{ flexDirection: "row", alignItems: "center", marginBottom: spacing.md }}>
        <View style={{ width: 42, height: 42, borderRadius: 13, backgroundColor: colors.brandPrimary, alignItems: "center", justifyContent: "center", marginRight: 12 }}>
          <Ionicons name="analytics-outline" size={22} color="#FFFFFF" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: colors.onSurface, fontFamily: fontFamily.bold, fontSize: fontSize.xl }}>Patient Lab Trends</Text>
          <Text style={{ color: colors.muted, fontFamily: fontFamily.regular, fontSize: fontSize.sm }}>Track results over time. Trends stay out of PDFs.</Text>
        </View>
        <Pressable onPress={() => { void refetch(); }} style={{ padding: 8 }}>
          <Ionicons name="refresh" size={21} color={colors.brandPrimary} />
        </Pressable>
      </View>

      <View style={{ borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, padding: spacing.md, marginBottom: spacing.md }}>
        <Text style={{ color: colors.onSurface, fontFamily: fontFamily.bold, fontSize: fontSize.lg, marginBottom: 4 }}>1. Choose patient</Text>
        {field("Search by patient name or MR number", patientSearch, setPatientSearch, "Search patients")}
        {isLoading ? <Text style={{ color: colors.muted, marginTop: 10 }}>Loading patients…</Text> : (
          <View style={{ marginTop: 10, gap: 7 }}>
            {visiblePatients.slice(0, 30).map(patient => {
              const active = selectedPatientId === patient.id;
              return <Pressable key={patient.id} onPress={() => { setSelectedPatientId(patient.id); setTestFilter(""); }}
                style={{ padding: 11, borderRadius: radius.md, borderWidth: 1, borderColor: active ? colors.brandPrimary : colors.border, backgroundColor: active ? colors.brandPrimary + "18" : colors.surfaceSecondary }}>
                <Text style={{ color: colors.onSurface, fontFamily: fontFamily.semibold }}>{patient.name || "Unnamed patient"}{patient.mrNo ? " · MR " + patient.mrNo : ""}</Text>
                {patient.gender ? <Text style={{ color: colors.muted, fontSize: fontSize.xs }}>{patient.gender}</Text> : null}
              </Pressable>;
            })}
            {!visiblePatients.length ? <Text style={{ color: colors.muted, paddingVertical: 8 }}>No matching patients.</Text> : null}
            {visiblePatients.length > 30 ? <Text style={{ color: colors.muted, fontSize: fontSize.xs }}>Showing first 30 matches. Refine the search to find another patient.</Text> : null}
          </View>
        )}
      </View>

      <View style={{ borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, padding: spacing.md, marginBottom: spacing.md }}>
        <Text style={{ color: colors.onSurface, fontFamily: fontFamily.bold, fontSize: fontSize.lg }}>2. Add a dated result</Text>
        <Text style={{ color: colors.muted, fontSize: fontSize.sm, marginTop: 4 }}>This separate history lets you preserve multiple values for the same test without changing the existing OCR/manual lab workflow.</Text>
        {field("Test name", test, setTest, "e.g. Hemoglobin")}
        <View style={{ flexDirection: "row", gap: 8 }}>
          <View style={{ flex: 1 }}>{field("Result", result, setResult, "e.g. 11.2", "decimal-pad")}</View>
          <View style={{ flex: 1 }}>{field("Unit", unit, setUnit, "e.g. g/dL")}</View>
        </View>
        {field("Date (YYYY-MM-DD)", date, setDate, "2026-10-17")}
        {field("Reference range (optional)", reference, setReference, "e.g. 12–16 g/dL")}
        <View style={{ marginTop: spacing.md }}>{button("Save trend entry", () => { void addEntry(); }, "save-outline", busy || !selectedPatient)}</View>
      </View>

      <View style={{ borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, padding: spacing.md, marginBottom: spacing.md }}>
        <Text style={{ color: colors.onSurface, fontFamily: fontFamily.bold, fontSize: fontSize.lg }}>3. Trend chart</Text>
        <Text style={{ color: colors.muted, fontSize: fontSize.sm, marginTop: 4 }}>{selectedPatient ? selectedPatient.name : "Select a patient above"} · choose a test to focus the chart.</Text>
        {field("Filter test name", testFilter, setTestFilter, "e.g. Hemoglobin")}
        {selectedTestEntries.length ? (
          <>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: spacing.md, marginBottom: spacing.sm }}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.onSurface, fontFamily: fontFamily.semibold }}>{selectedTestEntries[selectedTestEntries.length - 1].test}</Text>
                <Text style={{ color: colors.muted, fontSize: fontSize.xs }}>{chartEntries.length} numeric point(s)</Text>
              </View>
              <Text style={{ color: trendColor, fontFamily: fontFamily.bold }}>{trendLabel}</Text>
            </View>
            {chartEntries.length ? (
              <View style={{ height: 155, flexDirection: "row", alignItems: "flex-end", gap: 7, paddingTop: 8, borderBottomWidth: 1, borderColor: colors.border }}>
                {chartEntries.slice(-12).map((entry, index, shown) => {
                  const n = numeric(entry.result);
                  const height = 26 + ((n - min) / range) * 92;
                  return <View key={entry.id} style={{ flex: 1, alignItems: "center", justifyContent: "flex-end", height: "100%" }}>
                    <Text numberOfLines={1} style={{ color: colors.onSurface, fontSize: 9, marginBottom: 4 }}>{entry.result}</Text>
                    <View style={{ width: "72%", height, minHeight: 8, borderTopLeftRadius: 4, borderTopRightRadius: 4, backgroundColor: colors.brandPrimary }} />
                    <Text numberOfLines={1} style={{ color: colors.muted, fontSize: 8, marginTop: 4 }}>{entry.date.slice(5)}</Text>
                  </View>;
                })}
              </View>
            ) : <Text style={{ color: colors.muted, marginTop: 10 }}>No numeric values yet. Add numeric result entries to display the chart.</Text>}
            <Text style={{ color: colors.muted, fontSize: fontSize.xs, marginTop: spacing.sm }}>The chart shows saved trend snapshots only; it does not diagnose a condition. Review results with a clinician.</Text>
          </>
        ) : <Text style={{ color: colors.muted, marginTop: spacing.md }}>No trend entries for this patient and filter yet. Add a dated result or import verified results below.</Text>}
      </View>

      <View style={{ borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, padding: spacing.md, marginBottom: spacing.md }}>
        <Text style={{ color: colors.onSurface, fontFamily: fontFamily.bold, fontSize: fontSize.lg }}>4. Import existing verified results</Text>
        <Text style={{ color: colors.muted, fontSize: fontSize.sm, marginVertical: spacing.sm }}>Reads the existing saved verified results without editing them. Import skips duplicate patient/test/date/value snapshots.</Text>
        {button(busy ? "Importing…" : "Import verified results", () => { void importVerifiedResults(); }, "download-outline", busy)}
      </View>

      <View style={{ borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, padding: spacing.md }}>
        <Text style={{ color: colors.onSurface, fontFamily: fontFamily.bold, fontSize: fontSize.lg }}>Saved snapshots ({patientEntries.length})</Text>
        {patientEntries.slice().reverse().map(entry => (
          <View key={entry.id} style={{ flexDirection: "row", alignItems: "center", borderTopWidth: 1, borderColor: colors.border, paddingVertical: 11, gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.onSurface, fontFamily: fontFamily.semibold }}>{entry.test}: {entry.result}{entry.unit ? " " + entry.unit : ""}</Text>
              <Text style={{ color: colors.muted, fontSize: fontSize.xs }}>{entry.date}{entry.reference ? " · Ref: " + entry.reference : ""}{entry.source === "imported" ? " · imported" : " · manual"}</Text>
            </View>
            <Pressable onPress={() => removeEntry(entry)} hitSlop={8} style={{ padding: 7 }}>
              <Ionicons name="trash-outline" size={18} color={colors.error || "#B91C1C"} />
            </Pressable>
          </View>
        ))}
        {!patientEntries.length ? <Text style={{ color: colors.muted, marginTop: 10 }}>No snapshots saved for the selected patient.</Text> : null}
      </View>
    </ScrollView>
  );
}
