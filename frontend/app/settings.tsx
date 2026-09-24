import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import Ionicons from "@react-native-vector-icons/ionicons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAuth } from "@/src/auth/AuthContext";
import { useToast } from "@/src/components/toast";
import { hasAdminPin } from "@/src/utils/admin-pin";
import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";

type Row = { icon: string; label: string; sub: string; to: string; testID: string };

export default function SettingsScreen() {
  const styles = useStyles();
  const { colors, branding } = useTheme();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const toast = useToast();
  const [pinSet, setPinSet] = useState(false);

  useEffect(() => {
    hasAdminPin().then(setPinSet);
  }, []);

  if (user?.role !== "admin") {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.headerBtn} testID="settings-back">
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
    { icon: "color-palette-outline", label: "Branding", sub: "App title, logo, colours", to: "/branding", testID: "settings-branding" },
    { icon: "keypad-outline", label: pinSet ? "Change Admin PIN" : "Set Admin PIN", sub: "Protect exports & settings", to: "/admin-pin", testID: "settings-pin" },
    { icon: "sync-outline", label: "Sync & Backup", sub: "Share data between phones (offline)", to: "/backup-restore", testID: "settings-sync" },
    { icon: "people-outline", label: "User Management", sub: "Add or restrict doctors & staff", to: "/user-management", testID: "settings-users" },
  ];

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={() => router.back()} style={styles.headerBtn} testID="settings-back">
          <Ionicons name="arrow-back" size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>Settings</Text>
        <View style={styles.headerBtn} />
      </View>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + spacing.xxl }}>
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
