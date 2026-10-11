import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import Ionicons from "@react-native-vector-icons/ionicons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "@/src/auth/AuthContext";
import { useToast } from "@/src/components/toast";
import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";
import { attemptDueLowStockReport, getLowStockReportState, loadLowStockReportConfig, saveLowStockReportConfig, sendLowStockTestEmail, sendLowStockTestWhatsApp, type LowStockReportConfig, type LowStockSchedule } from "@/src/utils/low-stock-auto-report";
import { storage } from "@/src/utils/storage";

const blank = (): LowStockReportConfig => ({ schedule: "weekly", emails: "", resendApiKey: "", senderEmail: "", whatsappNumbers: "", whatsappToken: "", whatsappPhoneNumberId: "", whatsappGraphVersion: "v23.0", savedAt: "" });
export default function LowStockReportsScreen() {
  const { user } = useAuth();
  const { colors } = useTheme();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const [config, setConfig] = useState<LowStockReportConfig>(blank());
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [lastSent, setLastSent] = useState("");
  const [ocrApiKey, setOcrApiKey] = useState("");
  useEffect(() => { (async () => { const c = await loadLowStockReportConfig(); if (c) setConfig(c); const s = await getLowStockReportState(); setStatus(s.lastStatus || ""); setLastSent([s.emailLastSentAt ? "Email: " + new Date(s.emailLastSentAt).toLocaleString() : "", s.whatsappLastSentAt ? "WhatsApp: " + new Date(s.whatsappLastSentAt).toLocaleString() : ""].filter(Boolean).join("\n")); setOcrApiKey(String(await storage.secureGet("ortho_stock_ocr_space_api_key", "") || "")); })(); }, []);
  const update = (patch: Partial<LowStockReportConfig>) => setConfig(c => ({ ...c, ...patch }));
  const save = async () => {
    if (!config.emails.trim() && !config.whatsappNumbers.trim()) { toast("Enter at least one email or WhatsApp recipient.", "error"); return false; }
    if (config.emails.trim() && (!config.resendApiKey.trim() || !config.senderEmail.trim())) { toast("Email recipients require a Resend API key and verified sender email.", "error"); return false; }
    if (config.whatsappNumbers.trim() && (!config.whatsappToken.trim() || !config.whatsappPhoneNumberId.trim())) { toast("WhatsApp recipients require a Business access token and phone-number ID.", "error"); return false; }
    const next = { ...config, savedAt: new Date().toISOString() };
    try { await saveLowStockReportConfig(next); await storage.secureSet("ortho_stock_ocr_space_api_key", ocrApiKey.trim()); setConfig(next); toast("Report settings and invoice OCR key saved securely on this device.", "success"); return true; }
    catch { toast("Could not save credentials securely. Check device security settings.", "error"); return false; }
  };
  const test = async (kind: "email" | "whatsapp") => {
    if (!await save()) return;
    setBusy(true);
    try { if (kind === "email") await sendLowStockTestEmail(config); else await sendLowStockTestWhatsApp(config); toast("Test " + (kind === "email" ? "email" : "WhatsApp message") + " accepted by provider.", "success"); }
    catch (e: any) { Alert.alert("Test delivery failed", String(e?.message || e)); }
    finally { setBusy(false); }
  };
  const runNow = async () => { if (!await save()) return; setBusy(true); try { const result = await attemptDueLowStockReport(); setStatus(result); toast(result, result.startsWith("Sent") ? "success" : "info"); } finally { setBusy(false); } };
  if (user?.role !== "admin") return <View style={[styles.container, { paddingTop: insets.top, justifyContent: "center", alignItems: "center" }]}><Text style={styles.title}>Administrator only</Text></View>;
  const field = (label: string, value: string, onChangeText: (v: string) => void, placeholder: string, secure = false, multiline = false) => <View style={styles.field}><Text style={styles.label}>{label}</Text><TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={colors.muted} secureTextEntry={secure} autoCapitalize="none" autoCorrect={false} multiline={multiline} style={[styles.input, multiline && { minHeight: 76, textAlignVertical: "top" }]} /></View>;
  const schedules: { value: LowStockSchedule; label: string }[] = [{ value: "weekly", label: "Weekly" }, { value: "15days", label: "Every 15 days" }, { value: "monthly", label: "Monthly" }];
  return <View style={styles.container}>
    <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}><Pressable onPress={() => router.back()} style={styles.back}><Ionicons name="arrow-back" size={22} color={colors.onSurface}/></Pressable><Text style={styles.title}>Automatic Low Stock Reports</Text><View style={styles.back}/></View>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + spacing.xxl }}>
      <Text style={styles.help}>Reports are checked automatically while Ortho Logbook is open and internet is available. Credentials are stored in the device's secure storage. Keep this app open for scheduled delivery.</Text>
      <Text style={styles.section}>Schedule</Text>
      <View style={styles.scheduleRow}>{schedules.map(s => <Pressable key={s.value} onPress={() => update({ schedule: s.value })} style={[styles.schedule, config.schedule === s.value && { borderColor: colors.brandPrimary, backgroundColor: colors.brandTertiary }]}><Text style={[styles.scheduleText, config.schedule === s.value && { color: colors.brandPrimary }]}>{s.label}</Text></Pressable>)}</View>
      <Text style={styles.section}>Invoice OCR setup</Text>
      {field("OCR.space API key (for scanning stock invoice images and PDFs)", ocrApiKey, setOcrApiKey, "Enter your OCR.space API key", true)}
      <Text style={styles.help}>The scanner uses this key to read an invoice image or PDF, suggest stock items and split sizes into editable rows. OCR output is never saved to stock until an admin reviews and confirms it.</Text>
      <Text style={styles.section}>Email delivery (Resend)</Text>
      {field("Resend API key", config.resendApiKey, v => update({ resendApiKey: v }), "re_...", true)}
      {field("Verified sender email", config.senderEmail, v => update({ senderEmail: v }), "reports@your-verified-domain.com")}
      {field("Recipient email addresses", config.emails, v => update({ emails: v }), "one@example.com, two@example.com", false, true)}
      <Pressable disabled={busy} onPress={() => test("email")} style={[styles.action, busy && { opacity: .55 }]}><Text style={styles.actionText}>Save and send test email</Text></Pressable>
      <Text style={styles.section}>WhatsApp Business delivery</Text>
      {field("WhatsApp Business access token", config.whatsappToken, v => update({ whatsappToken: v }), "Meta system-user access token", true)}
      {field("Phone-number ID", config.whatsappPhoneNumberId, v => update({ whatsappPhoneNumberId: v }), "Meta WhatsApp phone-number ID")}
      {field("Graph API version", config.whatsappGraphVersion, v => update({ whatsappGraphVersion: v }), "v23.0")}
      {field("Recipient numbers (with country code)", config.whatsappNumbers, v => update({ whatsappNumbers: v }), "923001234567, 923009876543", false, true)}
      <Pressable disabled={busy} onPress={() => test("whatsapp")} style={[styles.action, busy && { opacity: .55 }]}><Text style={styles.actionText}>Save and send test WhatsApp</Text></Pressable>
      <Pressable disabled={busy} onPress={runNow} style={[styles.primary, busy && { opacity: .55 }]}><Text style={styles.primaryText}>{busy ? "Working…" : "Save settings and check report now"}</Text></Pressable>
      <Pressable onPress={async () => { await saveLowStockReportConfig(blank()); await storage.secureRemove("ortho_stock_ocr_space_api_key"); setOcrApiKey(""); setConfig(blank()); toast("Report and OCR credentials removed from this device.", "success"); }} style={styles.remove}><Text style={styles.removeText}>Remove saved credentials</Text></Pressable>
      {!!status && <View style={styles.status}><Text style={styles.label}>Latest result</Text><Text style={styles.help}>{status}</Text></View>}
      {!!lastSent && <View style={styles.status}><Text style={styles.label}>Last successful sends</Text><Text style={styles.help}>{lastSent}</Text></View>}
      <Text style={styles.note}>Important: email sending requires a Resend account and verified sender domain. WhatsApp sending requires a Meta WhatsApp Business account, active token and registered phone number. Meta may reject business-initiated documents outside its customer-service window unless your setup complies with its template rules. A successful API response confirms acceptance, not that a recipient has read the report.</Text>
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
  field: { marginBottom: spacing.md },
  label: { fontFamily: fontFamily.semibold, fontSize: fontSize.sm, color: colors.onSurface, marginBottom: spacing.xs },
  input: { minHeight: 46, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surface, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, color: colors.onSurface, fontFamily: fontFamily.regular, fontSize: fontSize.base },
  scheduleRow: { flexDirection: "row", gap: spacing.xs, flexWrap: "wrap" },
  schedule: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.md, backgroundColor: colors.surface },
  scheduleText: { color: colors.onSurface, fontFamily: fontFamily.semibold, fontSize: fontSize.sm },
  action: { alignItems: "center", padding: spacing.md, borderWidth: 1, borderColor: colors.brandPrimary, borderRadius: radius.md, marginBottom: spacing.md },
  actionText: { color: colors.brandPrimary, fontFamily: fontFamily.semibold, fontSize: fontSize.base },
  primary: { alignItems: "center", padding: spacing.md, backgroundColor: colors.brandPrimary, borderRadius: radius.md, marginTop: spacing.md },
  primaryText: { color: colors.onBrandPrimary, fontFamily: fontFamily.bold, fontSize: fontSize.base },
  remove: { alignItems: "center", padding: spacing.md, marginTop: spacing.sm },
  removeText: { color: colors.error, fontFamily: fontFamily.semibold, fontSize: fontSize.sm },
  status: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.surface, marginTop: spacing.md, borderWidth: 1, borderColor: colors.border },
  note: { fontFamily: fontFamily.regular, fontSize: fontSize.xs, color: colors.muted, marginTop: spacing.lg, lineHeight: 18 }
}));
