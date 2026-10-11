import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import Ionicons from "@react-native-vector-icons/ionicons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "@/src/auth/AuthContext";
import { useToast } from "@/src/components/toast";
import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";
import { attemptDueLowStockReport, getLowStockReportState, loadLowStockReportConfig, saveLowStockReportConfig, sendLowStockTestEmail, sendLowStockTestWhatsApp, shareLowStockPdfViaWhatsApp, type LowStockReportConfig, type LowStockSchedule } from "@/src/utils/low-stock-auto-report";
import { storage } from "@/src/utils/storage";

const blank = (): LowStockReportConfig => ({ schedule: "weekly", fixedDate: "", autoEmailEnabled: false, emails: "", resendApiKey: "", senderEmail: "", whatsappNumbers: "", whatsappToken: "", whatsappPhoneNumberId: "", whatsappGraphVersion: "v23.0", whatsappTemplateName: "", whatsappTemplateLanguage: "en_US", whatsappMode: "manual", savedAt: "" });
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
  useEffect(() => { (async () => { const c = await loadLowStockReportConfig(); if (c) setConfig({ ...c, autoEmailEnabled: c.autoEmailEnabled ?? true, whatsappMode: c.whatsappMode || "manual" }); const s = await getLowStockReportState(); setStatus(s.lastStatus || ""); setLastSent([s.emailLastSentAt ? "Email: " + new Date(s.emailLastSentAt).toLocaleString() : "", s.whatsappLastSentAt ? "WhatsApp: " + new Date(s.whatsappLastSentAt).toLocaleString() : ""].filter(Boolean).join("\n")); setOcrApiKey(String(await storage.secureGet("ortho_stock_ocr_space_api_key", "") || "")); })(); }, []);
  const update = (patch: Partial<LowStockReportConfig>) => setConfig(c => ({ ...c, ...patch }));
  const save = async () => {
    if (config.schedule === "fixedDate" && !/^\d{4}-\d{2}-\d{2}$/.test(String(config.fixedDate || "").trim())) { toast("Enter the fixed date as YYYY-MM-DD.", "error"); return false; }
    if (!config.emails.trim() && !config.whatsappNumbers.trim()) { toast("Enter at least one email or WhatsApp recipient.", "error"); return false; }
    if (config.emails.trim() && (!config.resendApiKey.trim() || !config.senderEmail.trim())) { toast("Email recipients require a Resend API key and verified sender email.", "error"); return false; }
    if (config.whatsappMode !== "manual" && config.whatsappNumbers.trim() && (!config.whatsappToken.trim() || !config.whatsappPhoneNumberId.trim())) { toast("Meta API delivery requires a Business access token and phone-number ID.", "error"); return false; }
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
  const schedules: { value: LowStockSchedule; label: string }[] = [{ value: "weekly", label: "Weekly" }, { value: "15days", label: "Every 15 days" }, { value: "monthly", label: "Monthly" }, { value: "onOpen", label: "Every app open" }, { value: "fixedDate", label: "Fixed date (once)" }];
  return <View style={styles.container}>
    <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}><Pressable onPress={() => router.back()} style={styles.back}><Ionicons name="arrow-back" size={22} color={colors.onSurface}/></Pressable><Text style={styles.title}>Automatic Low Stock Reports</Text><View style={styles.back}/></View>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + spacing.xxl }}>
      <Text style={styles.help}>Reports are checked automatically while Ortho Logbook is open and internet is available. Credentials are stored in the device's secure storage. Keep this app open for scheduled delivery.</Text>
      <Text style={styles.section}>Schedule</Text>
      <View style={styles.scheduleRow}>{schedules.map(s => <Pressable key={s.value} onPress={() => update({ schedule: s.value })} style={[styles.schedule, config.schedule === s.value && { borderColor: colors.brandPrimary, backgroundColor: colors.brandTertiary }]}><Text style={[styles.scheduleText, config.schedule === s.value && { color: colors.brandPrimary }]}>{s.label}</Text></Pressable>)}</View>
      {config.schedule === "fixedDate" && <>{field("Send on this date (YYYY-MM-DD)", config.fixedDate || "", v => update({ fixedDate: v }), "2026-12-01")}<Text style={styles.help}>This is a one-time date. The report sends on or after that date the next time the app is open and online. For recurring delivery, choose Weekly, Every 15 days, or Monthly.</Text></>}
      {config.schedule === "onOpen" && <Text style={styles.help}>The report is checked each time the admin opens or returns to the app. Keep the app online; no delivery can happen while it is closed. Repeated sending can occur on each new app opening if low-stock items remain.</Text>}
      <Text style={styles.section}>Invoice OCR setup</Text>
      {field("OCR.space API key (for scanning stock invoice images and PDFs)", ocrApiKey, setOcrApiKey, "Enter your OCR.space API key", true)}
      <Text style={styles.help}>The scanner uses this key to read an invoice image or PDF, suggest stock items and split sizes into editable rows. OCR output is never saved to stock until an admin reviews and confirms it.</Text>
      <Text style={styles.section}>Automatic email sending</Text>
      <Pressable onPress={() => update({ autoEmailEnabled: !config.autoEmailEnabled })} style={[styles.schedule, { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.md }, config.autoEmailEnabled && { borderColor: colors.brandPrimary, backgroundColor: colors.brandTertiary }]}><Text style={[styles.scheduleText, config.autoEmailEnabled && { color: colors.brandPrimary }]}>{config.autoEmailEnabled ? "Automatic email: ON" : "Automatic email: OFF"}</Text><Ionicons name={config.autoEmailEnabled ? "checkmark-circle" : "ellipse-outline"} size={22} color={config.autoEmailEnabled ? colors.brandPrimary : colors.muted} /></Pressable>
      <Text style={styles.help}>When ON, the app sends scheduled PDF reports automatically while it is open and connected to the internet. When OFF, no scheduled email is sent; you can still use the manual “check report now” action.</Text>
      <Text style={styles.section}>Email delivery (Resend)</Text>
      {field("Resend API key", config.resendApiKey, v => update({ resendApiKey: v }), "re_...", true)}
      {field("Verified sender email", config.senderEmail, v => update({ senderEmail: v }), "reports@your-verified-domain.com")}
      {field("Recipient email addresses", config.emails, v => update({ emails: v }), "one@example.com, two@example.com", false, true)}
      <Pressable disabled={busy} onPress={() => test("email")} style={[styles.action, busy && { opacity: .55 }]}><Text style={styles.actionText}>Save and send test email</Text></Pressable>
      <Text style={styles.section}>WhatsApp delivery options</Text>
      <Text style={styles.help}>Choose one of two modes: no-server sharing using normal WhatsApp or WhatsApp Business, or automatic delivery through the Meta API. This app has no online backend/server. No-server mode requires you to select the contact and tap Send; API mode runs only while this app is open and online.</Text>
      <View style={styles.scheduleRow}>
        <Pressable onPress={() => update({ whatsappMode: "manual" })} style={[styles.schedule, (config.whatsappMode || "meta") === "manual" && { borderColor: colors.brandPrimary, backgroundColor: colors.brandTertiary }]}><Text style={[styles.scheduleText, (config.whatsappMode || "meta") === "manual" && { color: colors.brandPrimary }]}>No-server WhatsApp share</Text></Pressable>
        <Pressable onPress={() => update({ whatsappMode: "meta" })} style={[styles.schedule, config.whatsappMode === "meta" && { borderColor: colors.brandPrimary, backgroundColor: colors.brandTertiary }]}><Text style={[styles.scheduleText, config.whatsappMode === "meta" && { color: colors.brandPrimary }]}>Meta API auto-send</Text></Pressable>
      </View>
      <Pressable disabled={busy} onPress={async () => { setBusy(true); try { await shareLowStockPdfViaWhatsApp(); toast("Choose WhatsApp or WhatsApp Business, select the recipient, and tap Send.", "info"); } catch (e: any) { Alert.alert("Could not share PDF", String(e?.message || e)); } finally { setBusy(false); } }} style={[styles.action, busy && { opacity: .55 }]}><Text style={styles.actionText}>Generate PDF and share with WhatsApp / WhatsApp Business</Text></Pressable>
      <Text style={styles.help}>No-server mode never sends a WhatsApp message silently: the app opens the share sheet for you to choose WhatsApp or WhatsApp Business and confirm Send. Use the “Meta API auto-send” option only if you have Meta API credentials and want the app to send automatically while open and online.</Text>
      <Text style={styles.section}>Meta WhatsApp Business Platform credentials (only for API auto-send)</Text>
      {config.whatsappMode !== "manual" && field("WhatsApp Business access token", config.whatsappToken, v => update({ whatsappToken: v }), "Meta system-user access token", true)}
      {config.whatsappMode !== "manual" && field("Phone-number ID", config.whatsappPhoneNumberId, v => update({ whatsappPhoneNumberId: v }), "Meta WhatsApp phone-number ID")}
      {config.whatsappMode !== "manual" && field("Graph API version", config.whatsappGraphVersion, v => update({ whatsappGraphVersion: v }), "v23.0")}
      {config.whatsappMode !== "manual" && field("Approved WhatsApp template name (required outside the 24-hour service window)", config.whatsappTemplateName || "", v => update({ whatsappTemplateName: v }), "approved_template_with_document_header")}
      {config.whatsappMode !== "manual" && field("Template language code", config.whatsappTemplateLanguage || "en_US", v => update({ whatsappTemplateLanguage: v }), "en_US")}
      {field("Recipient numbers (with country code)", config.whatsappNumbers, v => update({ whatsappNumbers: v }), "923001234567, 923009876543", false, true)}
      {config.whatsappMode !== "manual" && <Pressable disabled={busy} onPress={() => test("whatsapp")} style={[styles.action, busy && { opacity: .55 }]}><Text style={styles.actionText}>Save and send test WhatsApp API message</Text></Pressable>}
      <Pressable disabled={busy} onPress={runNow} style={[styles.primary, busy && { opacity: .55 }]}><Text style={styles.primaryText}>{busy ? "Working…" : "Save settings and check report now"}</Text></Pressable>
      <Pressable onPress={async () => { await saveLowStockReportConfig(blank()); await storage.secureRemove("ortho_stock_ocr_space_api_key"); setOcrApiKey(""); setConfig(blank()); toast("Report and OCR credentials removed from this device.", "success"); }} style={styles.remove}><Text style={styles.removeText}>Remove saved credentials</Text></Pressable>
      {!!status && <View style={styles.status}><Text style={styles.label}>Latest result</Text><Text style={styles.help}>{status}</Text></View>}
      {!!lastSent && <View style={styles.status}><Text style={styles.label}>Last successful sends</Text><Text style={styles.help}>{lastSent}</Text></View>}
      <Text style={styles.note}>Important: email sending requires a Resend account and verified sender domain. No-server WhatsApp sharing opens the phone share sheet; you must choose normal WhatsApp or WhatsApp Business, select the contact and tap Send. Meta API auto-send requires a Meta WhatsApp Business account, active token, registered phone number and, outside the 24-hour customer-service window, an approved document template. Email auto-send has its own ON/OFF switch. Both email and Meta API scheduled delivery require the app to be open and online because this app has no online backend/server.</Text>
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
