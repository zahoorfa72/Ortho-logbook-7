import { router } from "expo-router";
import { useEffect, useState } from "react";
import { DeviceEventEmitter, Pressable, ScrollView, Text, View, Switch } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Ionicons from "@react-native-vector-icons/ionicons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAuth } from "@/src/auth/AuthContext";
import { useToast } from "@/src/components/toast";
import { hasAdminPin } from "@/src/utils/admin-pin";
import { triggerAutomaticDriveBackup } from "@/src/utils/storage/drive-auto-backup";
import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";

type Row = { icon: string; label: string; sub: string; to: string; testID: string };

export default function SettingsScreen() {
  const styles = useStyles();
  const { colors, branding } = useTheme();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const toast = useToast();
  const [pinSet, setPinSet] = useState(false);
  const [labOcrEnabled, setLabOcrEnabled] = useState(false);
  const [labWarningsEnabled, setLabWarningsEnabled] = useState(true);

  useEffect(() => {
    hasAdminPin().then(setPinSet);
    AsyncStorage.getItem("ortho_lab_ocr_enabled").then(value => setLabOcrEnabled(value === "true")).catch(() => setLabOcrEnabled(false));
    AsyncStorage.getItem("ortho_lab_warnings_enabled").then(value => setLabWarningsEnabled(value !== "false")).catch(() => setLabWarningsEnabled(true));
  }, []);

  if (user?.role !== "admin") {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Pressable onPress={() => { if (router.canGoBack()) router.back(); else router.replace("/(tabs)" as any); }} style={styles.headerBtn} testID="settings-back">
            <Ionicons name="arrow-back" size={24} color={colors.onSurface} />
          </Pressable>
          <Text style={styles.headerTitle}>Settings</Text>
          <View style={styles.headerBtn} />
        </View>
        <View style={styles.center}>
          <Ionicons name="lock-closed-outline" size={48} color={colors.muted} />
          <Text style={styles.blockedTitle}>Administrator only</Text>
          <Text style={styles.blockedSub}>Only administrators can access settings.</Text>
        </View>
      </View>
    );
  }

  const rows: Row[] = [
    { icon: "color-palette-outline", label: "Branding", sub: "App title, logo, colours and text styling", to: "/branding", testID: "settings-branding" },
    { icon: "list-outline", label: "Procedures", sub: "Add, edit or remove procedure names", to: "/procedures", testID: "settings-procedures" },
    { icon: "options-outline", label: "Patient Fields", sub: "Create extra fields for the patient form", to: "/patient-fields", testID: "settings-patient-fields" },
    { icon: "keypad-outline", label: pinSet ? "Change Admin PIN" : "Set Admin PIN", sub: "Protect exports & settings", to: "/admin-pin", testID: "settings-pin" },
    { icon: "trash-outline", label: "Trash", sub: "Restore deleted app data within 30 days", to: "/trash", testID: "settings-trash" },
    { icon: "sync-outline", label: "Sync & Backup", sub: "Share data between phones (offline)", to: "/backup-restore", testID: "settings-sync" },
    { icon: "flask-outline", label: "Lab Test Reference Ranges", sub: "Add, edit or delete male/female ranges for offline OCR checks", to: "/lab-test-settings", testID: "settings-lab-test-ranges" },
    { icon: "mail-outline", label: "Automatic Low Stock Reports", sub: "Scheduled PDF delivery by email and WhatsApp", to: "/low-stock-reports", testID: "settings-low-stock-reports" },
    { icon: "people-outline", label: "User Management", sub: "Add or restrict doctors & staff", to: "/user-management", testID: "settings-users" },
    { icon: "bug-outline", label: "Report a Problem", sub: "Copy or share app errors and technical diagnostics", to: "/report-problem", testID: "settings-report-problem" },
  ];

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={() => { if (router.canGoBack()) router.back(); else router.replace("/(tabs)" as any); }} style={styles.headerBtn} testID="settings-back">
          <Ionicons name="arrow-back" size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>Settings</Text>
        <View style={styles.headerBtn} />
      </View>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + spacing.xxl }}>
        <View style={[styles.row, { marginBottom: spacing.md }]}>
          <View style={styles.rowIcon}><Ionicons name="flask-outline" size={22} color={colors.brandPrimary} /></View>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowLabel}>Offline Lab Report Reader</Text>
            <Text style={styles.rowSub}>Read saved lab-report photos locally on this device. Patient details, report text and results are not uploaded. Only clearly identified test rows are checked; uncertain rows are for manual review. Always verify against the original report and clinician guidance.</Text>
          </View>
          <Switch
            value={labOcrEnabled}
            onValueChange={async value => {
              setLabOcrEnabled(value);
              try {
                await AsyncStorage.setItem("ortho_lab_ocr_enabled", value ? "true" : "false");
                DeviceEventEmitter.emit("ortho_lab_ocr_enabled_changed", value);
                triggerAutomaticDriveBackup("appSettings");
              } catch { setLabOcrEnabled(!value); toast("Could not save the lab reader setting.", "error"); }
            }}
            trackColor={{ false: colors.border, true: colors.brandPrimary }}
            thumbColor={labOcrEnabled ? colors.onBrandPrimary : colors.muted}
            accessibilityLabel="Enable offline lab report reader"
          />
        </View>
        <View style={[styles.row, { marginBottom: spacing.md }]}>
          <View style={styles.rowIcon}><Ionicons name="warning-outline" size={22} color={colors.warning || colors.brandPrimary} /></View>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowLabel}>Show mild lab-result warnings</Text>
            <Text style={styles.rowSub}>Yellow warnings are for small differences from the printed reference range. Turning this off hides warnings only; larger deviations remain flagged. Always verify the original report.</Text>
          </View>
          <Switch
            value={labWarningsEnabled}
            onValueChange={async value => {
              setLabWarningsEnabled(value);
              try { await AsyncStorage.setItem("ortho_lab_warnings_enabled", value ? "true" : "false"); triggerAutomaticDriveBackup("appSettings"); }
              catch { setLabWarningsEnabled(!value); toast("Could not save the lab warning setting.", "error"); }
            }}
            trackColor={{ false: colors.border, true: colors.brandPrimary }}
            thumbColor={labWarningsEnabled ? colors.onBrandPrimary : colors.muted}
            accessibilityLabel="Show mild lab-result warnings"
          />
        </View>
        <View style={styles.brandingHero}>
          {branding.logoBase64 ? (
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            <Text />
          ) : null}
          <View style={styles.heroInner}>
            <Text style={styles.heroLabel}>Currently branded as</Text>
            <Text style={styles.heroTitle} numberOfLines={1}>
              {branding.title}
            </Text>
            <View style={styles.swatchRow}>
              <View style={[styles.swatch, { backgroundColor: branding.primary }]} />
              <View style={[styles.swatch, { backgroundColor: branding.secondary }]} />
              <View style={[styles.swatch, { backgroundColor: branding.tertiary }]} />
            </View>
          </View>
        </View>

        {rows.map((r) => (
          <Pressable
            key={r.to}
            testID={r.testID}
            style={styles.row}
            onPress={() => {
              if (!r.to) {
                toast("Coming soon", "info");
                return;
              }
              router.push(r.to as any);
            }}
          >
            <View style={styles.rowIcon}>
              <Ionicons name={r.icon as any} size={22} color={colors.brandPrimary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowLabel}>{r.label}</Text>
              <Text style={styles.rowSub}>{r.sub}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.muted} />
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  container: { flex: 1, backgroundColor: colors.surfaceSecondary },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  headerBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  headerTitle: { fontFamily: fontFamily.bold, fontSize: fontSize.lg, color: colors.onSurface },
  brandingHero: {
    backgroundColor: colors.brandPrimary,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.lg,
  },
  heroInner: {},
  heroLabel: { fontFamily: fontFamily.semibold, fontSize: fontSize.xs, color: colors.onBrandPrimary, opacity: 0.8, textTransform: "uppercase", letterSpacing: 1 },
  heroTitle: { fontFamily: fontFamily.bold, fontSize: fontSize.xxl, color: colors.onBrandPrimary, marginTop: spacing.xs },
  swatchRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md },
  swatch: { width: 32, height: 32, borderRadius: 16, borderWidth: 2, borderColor: colors.onBrandPrimary },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  rowIcon: { width: 40, height: 40, borderRadius: radius.md, backgroundColor: colors.brandTertiary, alignItems: "center", justifyContent: "center" },
  rowLabel: { fontFamily: fontFamily.semibold, fontSize: fontSize.base, color: colors.onSurface },
  rowSub: { fontFamily: fontFamily.regular, fontSize: fontSize.sm, color: colors.muted, marginTop: 2 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl, gap: spacing.md },
  blockedTitle: { fontFamily: fontFamily.bold, fontSize: fontSize.lg, color: colors.onSurface, marginTop: spacing.sm },
  blockedSub: { fontFamily: fontFamily.regular, fontSize: fontSize.base, color: colors.muted, textAlign: "center" },
}));
