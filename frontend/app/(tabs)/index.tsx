import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useMemo, useState } from "react";
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

type Patient = {
  id: string;
  mrNo: string;
  name: string;
  gender: string;
  age: string;
  diagnosis: string;
  procedure: string;
  implant: string;
  implantII: string;
  date: string;
  address: string;
  fileName: string;
  photos: string[];
  customData?: Record<string,string>;
  operationCount?: number;
  totalOperations?: number;
  implants?: { id:string; inventoryId:string; name:string; category:string; size:string; quantity:number }[];
};

function ordinalShort(n: number) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
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

  const togglePatient = (id: string) => setSelectedIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  const selectAllPatients = () => setSelectedIds(selectedIds.length === filtered.length ? [] : filtered.map((p) => p.id));
  const deleteSelectedPatients = () => {
    if (!selectedIds.length) {
      Alert.alert("No patients selected", "Select at least one patient first.");
      return;
    }
    Alert.alert(
      "Delete patients?",
      `Delete ${selectedIds.length} selected patient record(s)? Used implants will be returned to inventory. This cannot be undone.`,
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
      [p.mrNo, p.name, p.diagnosis, p.procedure, p.implant, p.implantII, ...(p.implants || []).flatMap(x => [x.category, x.name, x.size])]
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
    let list = [...(data || [])];
    const year = Number(pdfYear); const month = Number(pdfMonth);
    if (year) list = list.filter(p => String(p.date || "").startsWith(String(year) + "-"));
    if (month >= 1 && month <= 12 && year) list = list.filter(p => String(p.date || "").startsWith(String(year) + "-" + String(month).padStart(2,"0") + "-"));
    if (pdfFromDate) list = list.filter(p => String(p.date || "") >= pdfFromDate);
    if (pdfToDate) list = list.filter(p => String(p.date || "") <= pdfToDate);
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
            <Ionicons name="trash-outline" size={19} color={colors.danger || colors.onSurfaceSecondary} />
            <Text style={[styles.deleteSelectionText, { color: colors.danger || colors.onSurfaceSecondary }]}>Delete</Text>
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
              </View>

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
