import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import Ionicons from "@react-native-vector-icons/ionicons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "@/src/auth/AuthContext";
import { useToast } from "@/src/components/toast";
import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";
import { getLowStockReportState, loadLowStockReportConfig, saveLowStockReportConfig, shareLowStockPdfViaWhatsApp, type LowStockReportConfig, type LowStockSchedule } from "@/src/utils/low-stock-auto-report";

const blank = (): LowStockReportConfig => ({ schedule: "weekly", fixedDate: "", autoEmailEnabled: false, emails: "", resendApiKey: "", senderEmail: "", whatsappNumbers: "", whatsappToken: "", whatsappPhoneNumberId: "", whatsappGraphVersion: "", whatsappMode: "manual", savedAt: "" });
export default function LowStockReportsScreen() {
  const { user } = useAuth();
  const { colors } = useTheme();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const [config, setConfig] = useState<LowStockReportConfig>(blank());
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [lastGenerated, setLastGenerated] = useState("");
  useEffect(() => { (async () => { const c = await loadLowStockReportConfig(); if (c) setConfig({ ...blank(), ...c, autoEmailEnabled: false, whatsappMode: "manual" }); const s = await getLowStockReportState(); setStatus(s.lastStatus || ""); setLastGenerated(s.lastGeneratedAt ? new Date(s.lastGeneratedAt).toLocaleString() : ""); })(); }, []);
  const update = (patch: Partial<LowStockReportConfig>) => setConfig(c => ({ ...c, ...patch }));
  const save = async () => {
    if (config.schedule === "fixedDate" && !/^\\d{4}-\\d{2}-\\d{2}$/.test(String(config.fixedDate || "").trim())) { toast("Enter the date as YYYY-MM-DD.", "error"); return false; }
    try { const next = { ...config, autoEmailEnabled: false, resendApiKey: "", senderEmail: "", emails: "", whatsappNumbers: "", whatsappToken: "", whatsappPhoneNumberId: "", whatsappMode: "manual" as const, savedAt: new Date().toISOString() }; await saveLowStockReportConfig(next); setConfig(next); toast("Offline report settings saved on this device.", "success"); return true; }
    catch { toast("Could not save settings on this device.", "error"); return false; }
  };
  const generate = async () => { setBusy(true); try { await save(); await shareLowStockPdfViaWhatsApp(); const s = await getLowStockReportState(); setStatus(s.lastStatus || "Report generated."); setLastGenerated(s.lastGeneratedAt ? new Date(s.lastGeneratedAt).toLocaleString() : ""); toast("PDF created locally. Choose an app from the share sheet if you want to send it.", "success"); } catch (e: any) { Alert.alert("Could not create report", String(e?.message || e)); } finally { setBusy(false); } };
  if (user?.role !== "admin") return <View style={[styles.container, { paddingTop: insets.top, justifyContent: "center", alignItems: "center" }]}><Text style={styles.title}>Administrator only</Text></View>;
  const field = (label: string, value: string, onChangeText: (v: string) => void, placeholder: string) => <View style={styles.field}><Text style={styles.label}>{label}</Text><TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} style={styles.input} /></View>;
  const schedules: { value: LowStockSchedule; label: string }[] = [{ value: "weekly", label: "Weekly" }, { value: "15days", label: "Every 15 days" }, { value: "monthly", label: "Monthly" }, { value: "onOpen", label: "Check on app open" }, { value: "fixedDate", label: "Fixed date" }];
  return <View style={styles.container}>
    <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}><Pressable onPress={() => router.back()} style={styles.back}><Ionicons name="arrow-back" size={22} color={colors.onSurface}/></Pressable><Text style={styles.title}>Offline Low Stock Reports</Text><View style={styles.back}/></View>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + spacing.xxl }}>
      <Text style={styles.help}>This page works locally using the stock data saved on this phone. It does not need Resend, Meta WhatsApp API, OCR.space, an API key, or an online backend. PDFs are generated on this device.</Text>
      <Text style={styles.section}>Local report reminder preference</Text>
      <View style={styles.scheduleRow}>{schedules.map(s => <Pressable key={s.value} onPress={() => update({ schedule: s.value })} style={[styles.schedule, config.schedule === s.value && { borderColor: colors.brandPrimary, backgroundColor: colors.brandTertiary }]}><Text style={[styles.scheduleText, config.schedule === s.value && { color: colors.brandPrimary }]}>{s.label}</Text></Pressable>)}</View>
      {config.schedule === "fixedDate" && field("Reminder date (YYYY-MM-DD)", config.fixedDate || "", v => update({ fixedDate: v }), "2026-12-01")}
      <Text style={styles.help}>The schedule is saved locally as a reminder preference only. This offline version does not silently email or send WhatsApp messages. Generate the report when needed, then choose an installed sharing app. Sending through email or WhatsApp requires internet at the time you send.</Text>
      <Pressable disabled={busy} onPress={generate} style={[styles.primary, busy && { opacity: .55 }]}><Text style={styles.primaryText}>{busy ? "Generating PDF…" : "Generate low-stock PDF and share"}</Text></Pressable>
      <Pressable disabled={busy} onPress={async () => { if (await save()) toast("Settings saved locally.", "success"); }} style={styles.action}><Text style={styles.actionText}>Save offline settings</Text></Pressable>
      {!!status && <View style={styles.status}><Text style={styles.label}>Latest result</Text><Text style={styles.help}>{status}</Text></View>}
      {!!lastGenerated && <View style={styles.status}><Text style={styles.label}>Last generated locally</Text><Text style={styles.help}>{lastGenerated}</Text></View>}
      <Text style={styles.note}>Invoice scanning: the OCR.space online service is no longer used. Attach an invoice image and enter its stock items manually so invoice processing does not send your document to an external OCR provider.</Text>
    </ScrollView>
  </View>;
}
const useStyles = makeStyles(colors => ({
  container: { flex: 1, backgroundColor: colors.surfaceSecondary },
  header: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.md, paddingBottom: spacing.md, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
  back: { width: 36, height: 40, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, fontFamily: fontFamily.bold, fontSize: fontSize.lg, color: colors.onSurface },
  section: { fontFamily: fontFamily.bold, fontSize: fontSize.lg, color: colors.onSurface, marginTop: spacing.lg, marginBottom: spacing.sm },
  help: { fontFamily: fontFamily.regular, fontSize: fontSize.sm, color: colors.muted, lineHeight: 20 },
  field: { marginTop: spacing.md, marginBottom: spacing.md },
  label: { fontFamily: fontFamily.semibold, fontSize: fontSize.sm, color: colors.onSurface, marginBottom: spacing.xs },
  input: { minHeight: 46, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surface, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, color: colors.onSurface, fontFamily: fontFamily.regular, fontSize: fontSize.base },
  scheduleRow: { flexDirection: "row", gap: spacing.xs, flexWrap: "wrap", marginBottom: spacing.md },
  schedule: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.md, backgroundColor: colors.surface },
  scheduleText: { color: colors.onSurface, fontFamily: fontFamily.semibold, fontSize: fontSize.sm },
  action: { alignItems: "center", padding: spacing.md, borderWidth: 1, borderColor: colors.brandPrimary, borderRadius: radius.md, marginTop: spacing.md },
  actionText: { color: colors.brandPrimary, fontFamily: fontFamily.semibold, fontSize: fontSize.base },
  primary: { alignItems: "center", padding: spacing.md, backgroundColor: colors.brandPrimary, borderRadius: radius.md, marginTop: spacing.lg },
  primaryText: { color: colors.onBrandPrimary, fontFamily: fontFamily.bold, fontSize: fontSize.base },
  status: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.surface, marginTop: spacing.md, borderWidth: 1, borderColor: colors.border },
  note: { fontFamily: fontFamily.regular, fontSize: fontSize.xs, color: colors.muted, marginTop: spacing.lg, lineHeight: 18 }
}));
