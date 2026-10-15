import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import Ionicons from "@react-native-vector-icons/ionicons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "@/src/auth/AuthContext";
import { useToast } from "@/src/components/toast";
import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";
import { getLowStockReportState, loadLowStockReportConfig, saveLowStockReportConfig, shareLowStockPdfViaWhatsApp, testLowStockReportDeliveryNow, testImmediateLowStockAlertDeliveryNow, checkAndSendImmediateLowStockAlerts, sendManualLowStockTextAlertNow, attemptDueLowStockReport, type LowStockReportConfig, type LowStockSchedule } from "@/src/utils/low-stock-auto-report";
import { connectGoogleGmailAccount, getConnectedGoogleAccount } from "@/src/utils/storage/google-drive";

const blank = (): LowStockReportConfig => ({ schedule: "weekly", fixedDate: "", reportFromDate: "", reportToDate: "", autoEmailEnabled: false, emailEnabled: false, emails: "", resendApiKey: "", senderEmail: "", whatsappNumbers: "", whatsappToken: "", whatsappPhoneNumberId: "", whatsappGraphVersion: "v23.0", whatsappMode: "manual", instantLowStockAlertsEnabled: false, instantLowStockGmailEnabled: false, instantLowStockWhatsAppEnabled: false, lowStockWhatsAppTemplateName: "", lowStockWhatsAppTemplateLanguage: "en_US", savedAt: "" });
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
  const [gmailAccount, setGmailAccount] = useState<string | null>(null);
  useEffect(() => { (async () => {
    setGmailAccount(getConnectedGoogleAccount());
    const c = await loadLowStockReportConfig();
    if (c) setConfig({ ...blank(), ...c, instantLowStockAlertsEnabled: c.instantLowStockAlertsEnabled ?? (!!c.instantLowStockGmailEnabled || !!c.instantLowStockWhatsAppEnabled) });
    const s = await getLowStockReportState();
    setStatus(s.lastStatus || "");
    setLastGenerated(s.lastGeneratedAt ? new Date(s.lastGeneratedAt).toLocaleString() : "");
  })(); }, []);
  const update = (patch: Partial<LowStockReportConfig>) => setConfig(c => ({ ...c, ...patch }));
  const save = async () => {
    if (config.schedule === "fixedDate" && !/^\d{4}-\d{2}-\d{2}$/.test(String(config.fixedDate || "").trim())) { toast("Enter the trigger date as YYYY-MM-DD.", "error"); return false; }
    if (config.schedule === "fixedDate") { const from = String(config.reportFromDate || "").trim(); const to = String(config.reportToDate || "").trim(); if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) { toast("Enter both report From date and To date as YYYY-MM-DD.", "error"); return false; } if (from > to) { toast("Report From date must be on or before To date.", "error"); return false; } }
    if (config.autoEmailEnabled && !config.emails.trim() && !(config.whatsappMode === "meta" && config.whatsappNumbers.trim())) { toast("Add at least one email or WhatsApp recipient before enabling automatic sending.", "error"); return false; }
    if (config.instantLowStockGmailEnabled && !config.emails.trim()) { toast("Enter recipient email(s) for immediate Gmail low-stock alerts.", "error"); return false; }
    if (config.instantLowStockWhatsAppEnabled && (!config.whatsappNumbers.trim() || !config.whatsappToken.trim() || !config.whatsappPhoneNumberId.trim())) { toast("For immediate WhatsApp alerts, enter recipient number(s), Cloud API token, and phone-number ID.", "error"); return false; }
    try { const next = { ...config, savedAt: new Date().toISOString() }; await saveLowStockReportConfig(next); setConfig(next); toast("Low-stock delivery settings saved securely on this device.", "success"); return true; }
    catch { toast("Could not save settings on this device.", "error"); return false; }
  };
  const generate = async () => { setBusy(true); try { await save(); await shareLowStockPdfViaWhatsApp(); const s = await getLowStockReportState(); setStatus(s.lastStatus || "Report generated."); setLastGenerated(s.lastGeneratedAt ? new Date(s.lastGeneratedAt).toLocaleString() : ""); toast("Period-filtered PDF created. Choose an app to share it.", "success"); } catch (e: any) { Alert.alert("Could not create report", String(e?.message || e)); } finally { setBusy(false); } };
  const testAutomatic = async () => { setBusy(true); try { if (!(await save())) return; const result = await testLowStockReportDeliveryNow(); setStatus(result); toast(result, "success"); } catch (e:any) { const message = String(e?.message || e); setStatus(message); Alert.alert("Delivery test result", message); } finally { setBusy(false); } };
  const testImmediateAlerts = async () => { setBusy(true); try { if (!(await save())) return; const result = await testImmediateLowStockAlertDeliveryNow(); setStatus(result); toast(result, "success"); } catch (e:any) { const message = String(e?.message || e); setStatus(message); Alert.alert("Immediate alert test result", message); } finally { setBusy(false); } };
  const retryFailedAlert = async () => {
    setBusy(true);
    try {
      if (!(await save())) return;
      const outcomes: string[] = [];
      try {
        const result = await attemptDueLowStockReport();
        if (!/not due yet|not configured|disabled/i.test(result)) outcomes.push(result);
      } catch (e: any) { outcomes.push("Scheduled report FAILED: " + String(e?.message || e)); }
      try {
        const result = await checkAndSendImmediateLowStockAlerts();
        if (!/not configured|disabled|No newly low-stock/i.test(result)) outcomes.push(result);
      } catch (e: any) { outcomes.push("Immediate alert FAILED: " + String(e?.message || e)); }
      const result = outcomes.join("; ") || "No pending alert was sent. Check internet, Gmail connection, recipients, and delivery settings.";
      setStatus(result);
      const failed = /FAILED|failed|could not|error/i.test(result);
      toast(failed ? "Low-stock delivery failed. Check details and retry." : "Low-stock delivery check completed.", failed ? "error" : "success");
      const state = await getLowStockReportState();
      setLastGenerated(state.lastGeneratedAt ? new Date(state.lastGeneratedAt).toLocaleString() : "");
    } catch (e: any) {
      const message = String(e?.message || e);
      setStatus(message);
      toast("Retry failed: " + message, "error");
    } finally { setBusy(false); }
  };
  const sendManualAlert = async () => { setBusy(true); try { if (!(await save())) return; const result = await sendManualLowStockTextAlertNow(); setStatus(result); toast(result, "success"); } catch (e:any) { const message = String(e?.message || e); setStatus(message); Alert.alert("Manual low-stock alert result", message); } finally { setBusy(false); } };

  if (user?.role !== "admin") return <View style={[styles.container, { paddingTop: insets.top, justifyContent: "center", alignItems: "center" }]}><Text style={styles.title}>Administrator only</Text></View>;
  const field = (label: string, value: string, onChangeText: (v: string) => void, placeholder: string, secret = false) => <View style={styles.field}><Text style={styles.label}>{label}</Text><TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} secureTextEntry={secret} style={styles.input} /></View>;
  const toggle = (label: string, active: boolean, onPress: () => void) => <Pressable onPress={onPress} style={[styles.toggle, active && { borderColor: colors.brandPrimary, backgroundColor: colors.brandTertiary }]}><View style={[styles.check, active && { backgroundColor: colors.brandPrimary }]}>{active ? <Ionicons name="checkmark" size={15} color={colors.onBrandPrimary} /> : null}</View><Text style={styles.scheduleText}>{label}</Text></Pressable>;
  const schedules: { value: LowStockSchedule; label: string }[] = [{ value: "weekly", label: "Weekly (last 7 days)" }, { value: "15days", label: "Every 15 days" }, { value: "monthly", label: "Monthly (last 30 days)" }, { value: "onOpen", label: "Once per day when opened" }, { value: "fixedDate", label: "Fixed date" }];
  return <View style={styles.container}>
    <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}><Pressable onPress={() => router.back()} style={styles.back}><Ionicons name="arrow-back" size={22} color={colors.onSurface}/></Pressable><Text style={styles.title}>Automatic Low Stock Reports</Text><View style={styles.back}/></View>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + spacing.xxl }}>
      <Text style={styles.help}>This is separate from invoice scanning and stock receiving. Reports only read inventory and stock-movement history; they never change stock quantities. Weekly, 15-day and monthly reports include low-stock movement records from that period, not the lifetime list. Immediate alerts are independent of this schedule: each item is alerted when its quantity first reaches or falls below its configured minimum, and it is not repeatedly sent while it stays low.</Text>
      <Text style={styles.section}>Automatic trigger</Text>
      {toggle("Enable automatic report delivery", !!config.autoEmailEnabled, () => update({ autoEmailEnabled: !config.autoEmailEnabled }))}
      <View style={styles.scheduleRow}>{schedules.map(s => <Pressable key={s.value} onPress={() => update({ schedule: s.value })} style={[styles.schedule, config.schedule === s.value && { borderColor: colors.brandPrimary, backgroundColor: colors.brandTertiary }]}><Text style={[styles.scheduleText, config.schedule === s.value && { color: colors.brandPrimary }]}>{s.label}</Text></Pressable>)}</View>
      {config.schedule === "fixedDate" && <><Text style={styles.help}>The trigger date decides when the report is sent. The From/To dates decide which stock-movement dates are included in its PDF.</Text>{field("Automatic trigger date (YYYY-MM-DD)", config.fixedDate || "", v => update({ fixedDate: v }), "2026-12-01")}{field("Report From date (YYYY-MM-DD)", config.reportFromDate || "", v => update({ reportFromDate: v }), "2026-10-01")}{field("Report To date (YYYY-MM-DD)", config.reportToDate || "", v => update({ reportToDate: v }), "2026-10-12")}</>}
      <Text style={styles.help}>Automatic checks run when the app starts/opens. Android may delay background work; this version cannot guarantee a send at an exact time while the app is closed.</Text>
      <Text style={styles.section}>Immediate low-stock alert controls</Text>
      {toggle("Enable automatic low-stock alerts", !!config.instantLowStockAlertsEnabled, () => update({ instantLowStockAlertsEnabled: !config.instantLowStockAlertsEnabled }))}
      <Text style={styles.help}>Turn this master switch OFF to stop all automatic immediate low-stock alerts. Gmail and WhatsApp also have their own channel switches below. The manual “Send low-stock text alert now” button remains available when automatic alerts are OFF.</Text>
      <Text style={styles.section}>Gmail connection</Text>
      <Text style={styles.help}>{gmailAccount ? `Connected Google account: ${gmailAccount}` : "Connect your Google account to send report PDFs directly from Gmail. No Resend API key or custom domain is needed."}</Text>
      <Pressable disabled={busy} onPress={async () => { setBusy(true); try { const email = await connectGoogleGmailAccount(); setGmailAccount(email); toast(`Gmail connected: ${email}`, "success"); } catch (e:any) { Alert.alert("Gmail connection failed", String(e?.message || e)); } finally { setBusy(false); } }} style={styles.action}><Text style={styles.actionText}>{gmailAccount ? "Reconnect Gmail / approve sending" : "Connect Gmail"}</Text></Pressable>
      {toggle("Send PDF by Gmail automatically", !!config.emailEnabled, () => update({ emailEnabled: !config.emailEnabled }))}
      {toggle("Send immediate low-stock text alerts by Gmail", !!config.instantLowStockGmailEnabled, () => update({ instantLowStockGmailEnabled: !config.instantLowStockGmailEnabled }))}
      <Text style={styles.help}>When an implant newly reaches or drops below its Minimum Stock, Gmail sends a short text email immediately. This is separate from scheduled PDF reports and does not wait for a report schedule.</Text>
      {field("Recipient email(s)", config.emails, v => update({ emails: v }), "recipient@gmail.com; another@gmail.com")}
      <Text style={styles.help}>The Google account you connect is the sender. Google may require the Gmail API to be enabled and the OAuth consent screen configured for your app.</Text>
      <Text style={styles.section}>WhatsApp delivery (manual and automatic)</Text>
      {toggle("Enable automatic WhatsApp PDF delivery (Meta Cloud API)", config.whatsappMode === "meta", () => update({ whatsappMode: config.whatsappMode === "meta" ? "manual" : "meta" }))}
      {toggle("Send immediate low-stock text alerts by WhatsApp", !!config.instantLowStockWhatsAppEnabled, () => update({ instantLowStockWhatsAppEnabled: !config.instantLowStockWhatsAppEnabled }))}
      {field("Recipient WhatsApp number(s)", config.whatsappNumbers, v => update({ whatsappNumbers: v }), "923001234567; 923331234567")}
      {(config.whatsappMode === "meta" || config.instantLowStockWhatsAppEnabled) && <>
        {field("Meta WhatsApp Cloud API access token", config.whatsappToken, v => update({ whatsappToken: v }), "Paste access token", true)}
        {field("WhatsApp Phone Number ID", config.whatsappPhoneNumberId, v => update({ whatsappPhoneNumberId: v }), "Phone Number ID")}
        {field("Graph API version", config.whatsappGraphVersion || "v23.0", v => update({ whatsappGraphVersion: v }), "v23.0")}
        {field("Approved WhatsApp document template name (optional)", config.whatsappTemplateName || "", v => update({ whatsappTemplateName: v }), "low_stock_report")}
        {field("Template language code", config.whatsappTemplateLanguage || "en_US", v => update({ whatsappTemplateLanguage: v }), "en_US")}
        {field("Approved low-stock TEXT template name (optional)", config.lowStockWhatsAppTemplateName || "", v => update({ lowStockWhatsAppTemplateName: v }), "low_stock_alert")}
        {field("Low-stock text template language", config.lowStockWhatsAppTemplateLanguage || "en_US", v => update({ lowStockWhatsAppTemplateLanguage: v }), "en_US")}
        <Text style={styles.help}>Automatic sending uses Meta's official Cloud API and requires a Meta business portfolio, WhatsApp Business Account, registered business phone number, and token with whatsapp_business_messaging permission. The token is saved in this phone's secure storage, but a token stored in a mobile app can still be extracted; a server-side secret is safer. API delivery needs internet access. For scheduled PDF messages outside WhatsApp's 24-hour customer-service window, configure an approved document-header template. For immediate plain-text alerts outside that window, configure an approved TEXT template with one body placeholder ({'{{1}}'}); otherwise Meta may reject the free-form text.</Text>
      </>}
      <Text style={styles.help}>Manual sharing is always available from the Share PDF button below. It opens Android's share menu; select WhatsApp, choose the recipient, and press Send. Automatic sending works when Cloud API mode is selected and credentials are configured.</Text>
      <Pressable disabled={busy} onPress={async () => { if (await save()) toast("Settings saved.", "success"); }} style={styles.action}><Text style={styles.actionText}>Save delivery settings</Text></Pressable>
      <Pressable disabled={busy} onPress={testAutomatic} style={[styles.primary, busy && { opacity: .55 }]}><Text style={styles.primaryText}>{busy ? "Working…" : "Test automatic delivery now"}</Text></Pressable>
      <Pressable disabled={busy} onPress={testImmediateAlerts} style={styles.action}><Text style={styles.actionText}>{busy ? "Working…" : "Test immediate low-stock text alerts"}</Text></Pressable>
      <Pressable disabled={busy} onPress={sendManualAlert} style={styles.primary}><Text style={styles.primaryText}>{busy ? "Working…" : "Send low-stock text alert now (manual)"}</Text></Pressable>
      <Pressable disabled={busy} onPress={retryFailedAlert} style={styles.action}><Text style={styles.actionText}>{busy ? "Retrying…" : "Retry failed delivery"}</Text></Pressable>
      <Pressable disabled={busy} onPress={generate} style={styles.action}><Text style={styles.actionText}>{busy ? "Please wait…" : "Share report using WhatsApp or another app"}</Text></Pressable>
      {!!status && <View style={styles.status}><Text style={styles.label}>Latest result</Text><Text style={styles.help}>{status}</Text></View>}
      {!!lastGenerated && <View style={styles.status}><Text style={styles.label}>Last generated/sent</Text><Text style={styles.help}>{lastGenerated}</Text></View>}
      <Text style={styles.note}>Automatic schedule checks run when the app opens; Android may delay background work while the app is closed. The test button sends immediately through enabled Gmail and/or WhatsApp Cloud API channels, regardless of whether the scheduled date is due. Manual WhatsApp sharing still requires selecting the recipient and confirming Send.</Text>
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
  toggle: { flexDirection: "row", alignItems: "center", gap: spacing.sm, padding: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surface, marginBottom: spacing.md },
  check: { width: 20, height: 20, borderRadius: 5, borderWidth: 1, borderColor: colors.brandPrimary, alignItems: "center", justifyContent: "center" },
  action: { alignItems: "center", padding: spacing.md, borderWidth: 1, borderColor: colors.brandPrimary, borderRadius: radius.md, marginTop: spacing.md },
  actionText: { color: colors.brandPrimary, fontFamily: fontFamily.semibold, fontSize: fontSize.base },
  primary: { alignItems: "center", padding: spacing.md, backgroundColor: colors.brandPrimary, borderRadius: radius.md, marginTop: spacing.lg },
  primaryText: { color: colors.onBrandPrimary, fontFamily: fontFamily.bold, fontSize: fontSize.base },
  status: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.surface, marginTop: spacing.md, borderWidth: 1, borderColor: colors.border },
  note: { fontFamily: fontFamily.regular, fontSize: fontSize.xs, color: colors.muted, marginTop: spacing.lg, lineHeight: 18 }
}));
