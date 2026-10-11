import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import Ionicons from "@react-native-vector-icons/ionicons";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "@/src/auth/AuthContext";
import { useToast } from "@/src/components/toast";
import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";
import {
  DEFAULT_REPORT_CONFIG, DEFAULT_REPORT_CREDENTIALS, loadLowStockCredentials,
  loadLowStockReportConfig, saveLowStockCredentials, saveLowStockReportConfig,
  testLowStockReportDelivery, type LowStockCredentials, type LowStockReportConfig,
} from "@/src/utils/low-stock-report";

function Field({ label, value, onChangeText, placeholder, secureTextEntry, multiline }: {
  label: string; value: string; onChangeText: (value: string) => void; placeholder?: string;
  secureTextEntry?: boolean; multiline?: boolean;
}) {
  const { colors } = useTheme();
  return <View style={{ marginBottom: spacing.md }}>
    <Text style={{ color: colors.onSurface, fontFamily: fontFamily.semibold, fontSize: fontSize.sm, marginBottom: spacing.xs }}>{label}</Text>
    <TextInput value={value} onChangeText={onChangeText} placeholder={placeholder || label} placeholderTextColor={colors.muted}
      secureTextEntry={secureTextEntry} multiline={multiline} autoCapitalize="none" autoCorrect={false}
      style={{ borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surface, color: colors.onSurface, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, minHeight: multiline ? 88 : 46, textAlignVertical: multiline ? "top" : "center" }} />
  </View>;
}
function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  const { colors } = useTheme();
  return <Pressable onPress={() => onChange(!value)} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: spacing.sm }}>
    <Text style={{ color: colors.onSurface, fontFamily: fontFamily.semibold, fontSize: fontSize.base, flex: 1 }}>{label}</Text>
    <View style={{ width: 48, height: 28, borderRadius: 14, padding: 3, backgroundColor: value ? colors.brandPrimary : colors.border, justifyContent: "center" }}>
      <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: "#FFFFFF", alignSelf: value ? "flex-end" : "flex-start" }} />
    </View>
  </Pressable>;
}

export default function LowStockReportsScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const toast = useToast();
  const [config, setConfig] = useState<LowStockReportConfig>(DEFAULT_REPORT_CONFIG);
  const [credentials, setCredentials] = useState<LowStockCredentials>(DEFAULT_REPORT_CREDENTIALS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    let mounted = true;
    Promise.all([loadLowStockReportConfig(), loadLowStockCredentials()]).then(([c, s]) => {
      if (mounted) { setConfig(c); setCredentials(s); }
    }).catch(() => undefined).finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, []);

  if (user?.role !== "admin") {
    return <View style={[styles.container, { paddingTop: insets.top + spacing.lg, paddingHorizontal: spacing.lg }]}>
      <Text style={styles.title}>Low-stock report delivery</Text>
      <Text style={styles.muted}>Administrator access is required.</Text>
    </View>;
  }
  const updateSecret = (key: keyof LowStockCredentials, value: string) => setCredentials(v => ({ ...v, [key]: value }));
  const save = async () => {
    setSaving(true);
    try {
      const secretsSaved = await saveLowStockCredentials(credentials);
      const now = new Date();
      const next = new Date(now);
      if (config.frequency === "weekly") next.setDate(next.getDate() + 7);
      else if (config.frequency === "15days") next.setDate(next.getDate() + 15);
      else next.setMonth(next.getMonth() + 1);
      const nextIso = next.toISOString();
      const updated = {
        ...config,
        nextEmailAt: config.emailEnabled ? (config.nextEmailAt || nextIso) : "",
        nextWhatsAppAt: config.whatsappEnabled ? (config.nextWhatsAppAt || nextIso) : "",
      };
      const configSaved = await saveLowStockReportConfig(updated);
      setConfig(updated);
      if (!secretsSaved || !configSaved) throw new Error("One or more settings could not be saved securely. Check device storage and try again.");
      toast("Report settings saved. Automatic delivery runs while the app is open.", "success");
    } catch (e: any) { toast(e?.message || "Could not save report settings.", "error"); }
    finally { setSaving(false); }
  };
  const test = async () => {
    setTesting(true);
    try {
      await saveLowStockCredentials(credentials);
      await saveLowStockReportConfig(config);
      const result = await testLowStockReportDelivery();
      toast(result, "success");
      const latest = await loadLowStockReportConfig();
      setConfig({ ...latest, lastStatus: "Test succeeded: " + result, lastAttemptAt: new Date().toISOString() });
    } catch (e: any) {
      const message = e?.message || "Delivery test failed.";
      toast(message, "error");
      setConfig(v => ({ ...v, lastStatus: "Test failed: " + message, lastAttemptAt: new Date().toISOString() }));
    } finally { setTesting(false); }
  };
  const frequencyOptions = [
    { value: "weekly", label: "Weekly" },
    { value: "15days", label: "Every 15 days" },
    { value: "monthly", label: "Monthly" },
  ] as const;

  return <View style={styles.container}>
    <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
      <Pressable onPress={() => router.back()} style={styles.back}><Ionicons name="arrow-back" size={22} color={colors.onSurface} /></Pressable>
      <Text style={styles.title}>Low-stock report delivery</Text>
      <View style={{ width: 40 }} />
    </View>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + spacing.xxl }}>
      <View style={styles.info}>
        <Ionicons name="shield-checkmark-outline" size={22} color={colors.brandPrimary} />
        <Text style={styles.infoText}>Credentials are saved in this device's secure storage. Delivery is checked automatically while the app is open and the device has internet. Keep the app open for scheduled sends.</Text>
      </View>
      <Toggle label="Enable scheduled delivery" value={config.enabled} onChange={v => setConfig(c => ({ ...c, enabled: v }))} />
      <Text style={styles.section}>Schedule</Text>
      {frequencyOptions.map(option => <Pressable key={option.value} onPress={() => setConfig(c => ({ ...c, frequency: option.value, nextEmailAt: "", nextWhatsAppAt: "" }))} style={[styles.option, config.frequency === option.value && styles.optionSelected]}>
        <View style={[styles.radio, config.frequency === option.value && { borderColor: colors.brandPrimary }]}>{config.frequency === option.value ? <View style={[styles.radioDot, { backgroundColor: colors.brandPrimary }]} /> : null}</View>
        <Text style={styles.optionText}>{option.label}</Text>
      </Pressable>)}

      <Text style={styles.section}>Email delivery (Resend)</Text>
      <Toggle label="Send report by email" value={config.emailEnabled} onChange={v => setConfig(c => ({ ...c, emailEnabled: v }))} />
      <Field label="Resend API key" value={credentials.resendApiKey} onChangeText={v => updateSecret("resendApiKey", v)} placeholder="re_..." secureTextEntry />
      <Field label="Verified sender address" value={credentials.resendFrom} onChangeText={v => updateSecret("resendFrom", v)} placeholder="Ortho Logbook <reports@your-verified-domain.com>" />
      <Field label="Email recipients (one per line or comma-separated)" value={config.emailRecipients} onChangeText={v => setConfig(c => ({ ...c, emailRecipients: v }))} placeholder="admin@example.com, stock@example.com" multiline />

      <Text style={styles.section}>WhatsApp Business Cloud API</Text>
      <Toggle label="Send report by WhatsApp" value={config.whatsappEnabled} onChange={v => setConfig(c => ({ ...c, whatsappEnabled: v }))} />
      <Field label="WhatsApp access token" value={credentials.whatsappAccessToken} onChangeText={v => updateSecret("whatsappAccessToken", v)} placeholder="Meta WhatsApp Cloud API token" secureTextEntry />
      <Field label="Phone Number ID (from Meta)" value={credentials.whatsappPhoneNumberId} onChangeText={v => updateSecret("whatsappPhoneNumberId", v)} placeholder="WhatsApp Business Phone Number ID" />
      <Field label="Graph API version" value={credentials.whatsappApiVersion} onChangeText={v => updateSecret("whatsappApiVersion", v)} placeholder="v23.0" />
      <Field label="Approved template name (recommended for scheduled reports)" value={credentials.whatsappTemplateName} onChangeText={v => updateSecret("whatsappTemplateName", v)} placeholder="Approved template with a document header (optional)" />
      <Field label="Template language code" value={credentials.whatsappTemplateLanguage} onChangeText={v => updateSecret("whatsappTemplateLanguage", v)} placeholder="en_US" />
      <Field label="WhatsApp recipient numbers (country code, one per line)" value={config.whatsappRecipients} onChangeText={v => setConfig(c => ({ ...c, whatsappRecipients: v }))} placeholder="+923001234567" multiline />

      <View style={styles.warning}>
        <Text style={styles.warningText}>Email needs a Resend account and verified sender domain. WhatsApp needs a Meta WhatsApp Business Cloud setup and a valid token/Phone Number ID. For messages outside WhatsApp's customer-service window, use an approved template with a document header. A normal WhatsApp number alone cannot send automated PDFs.</Text>
      </View>
      <Text style={styles.statusLabel}>Last status</Text>
      <Text selectable style={styles.statusText}>{config.lastStatus || "Not run yet"}</Text>
      {config.lastAttemptAt ? <Text style={styles.muted}>Last attempt: {new Date(config.lastAttemptAt).toLocaleString()}</Text> : null}
      {config.nextEmailAt && config.emailEnabled ? <Text style={styles.muted}>Next email check: {new Date(config.nextEmailAt).toLocaleString()}</Text> : null}
      {config.nextWhatsAppAt && config.whatsappEnabled ? <Text style={styles.muted}>Next WhatsApp check: {new Date(config.nextWhatsAppAt).toLocaleString()}</Text> : null}
      <Pressable disabled={saving} onPress={save} style={[styles.primaryButton, saving && { opacity: 0.6 }]}>{saving ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryButtonText}>Save settings</Text>}</Pressable>
      <Pressable disabled={testing || saving} onPress={test} style={[styles.secondaryButton, (testing || saving) && { opacity: 0.6 }]}>{testing ? <ActivityIndicator color={colors.brandPrimary} /> : <Text style={styles.secondaryButtonText}>Send test report now</Text>}</Pressable>
      <Text style={styles.muted}>Test delivery sends a real low-stock PDF to the configured recipients. Use your own address/number first.</Text>
    </ScrollView>
  </View>;
}
const useStyles = makeStyles(colors => ({
  container: { flex: 1, backgroundColor: colors.surfaceSecondary },
  header: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.md, paddingBottom: spacing.md, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
  back: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, fontFamily: fontFamily.bold, fontSize: fontSize.lg, color: colors.onSurface },
  section: { fontFamily: fontFamily.bold, fontSize: fontSize.lg, color: colors.onSurface, marginTop: spacing.lg, marginBottom: spacing.sm },
  info: { flexDirection: "row", gap: spacing.sm, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, marginBottom: spacing.md },
  infoText: { flex: 1, color: colors.onSurface, fontFamily: fontFamily.regular, fontSize: fontSize.sm, lineHeight: 20 },
  option: { flexDirection: "row", alignItems: "center", gap: spacing.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm },
  optionSelected: { borderColor: colors.brandPrimary, borderWidth: 2 },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: colors.muted, alignItems: "center", justifyContent: "center" },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
  optionText: { color: colors.onSurface, fontFamily: fontFamily.semibold, fontSize: fontSize.base },
  warning: { padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.warning, marginTop: spacing.lg },
  warningText: { color: colors.onSurface, fontSize: fontSize.sm, lineHeight: 20 },
  statusLabel: { marginTop: spacing.lg, color: colors.onSurface, fontFamily: fontFamily.bold, fontSize: fontSize.base },
  statusText: { color: colors.onSurface, fontSize: fontSize.sm, marginTop: spacing.xs, marginBottom: spacing.sm },
  muted: { color: colors.muted, fontSize: fontSize.sm, marginTop: spacing.xs, lineHeight: 19 },
  primaryButton: { minHeight: 48, borderRadius: radius.md, backgroundColor: colors.brandPrimary, alignItems: "center", justifyContent: "center", marginTop: spacing.lg, padding: spacing.md },
  primaryButtonText: { color: "#FFFFFF", fontFamily: fontFamily.bold, fontSize: fontSize.base },
  secondaryButton: { minHeight: 48, borderRadius: radius.md, borderWidth: 1, borderColor: colors.brandPrimary, alignItems: "center", justifyContent: "center", marginTop: spacing.md, padding: spacing.md },
  secondaryButtonText: { color: colors.brandPrimary, fontFamily: fontFamily.bold, fontSize: fontSize.base },
}));
