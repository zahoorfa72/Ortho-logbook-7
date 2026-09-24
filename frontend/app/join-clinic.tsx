import { router } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import Ionicons from "@react-native-vector-icons/ionicons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { queryClient } from "@/src/query-client";
import { storage } from "@/src/utils/storage";
import { decryptBackup, restoreBackup } from "@/src/utils/storage/backup";
import { pickBackupFile } from "@/src/utils/storage/backup-file";
import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";

// Public restore screen — no admin login required. Used by staff phones to
// join a clinic that was set up on the admin phone: install the app, pick
// the admin's shared backup, and their doctor account becomes available on
// this device. This is only meaningful on a fresh install (no local admin
// yet); if the phone already has data, the user must use Settings → Sync.
export default function JoinClinic() {
  const styles = useStyles();
  const { colors, branding } = useTheme();
  const insets = useSafeAreaInsets();

  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<{
    name: string;
    backupText: string;
    info: { createdAt: string; encrypted: boolean };
  } | null>(null);

  const pick = async () => {
    try {
      setLoading(true);
      const result = await pickBackupFile();
      if (!result) return;
      setSelected({ name: result.name, backupText: result.backupText, info: result.info });
      setPassword("");
    } catch (error) {
      Alert.alert("Invalid backup", error instanceof Error ? error.message : "The selected file is not a valid backup.");
    } finally {
      setLoading(false);
    }
  };

  const runRestore = async () => {
    if (!selected) return;
    if (password.length < 8) {
      Alert.alert("Password required", "Enter the password shared by your administrator.");
      return;
    }
    Alert.alert(
      "Join this clinic?",
      "This will replace anything on this phone with the clinic backup so your account can be created here. If this is a fresh install, that's exactly what you want.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Join",
          onPress: async () => {
            try {
              setLoading(true);
              const backup = await decryptBackup(selected.backupText, password);
              const result = restoreBackup(backup);
              await storage.secureRemove("ortho_current_user");
              queryClient.clear();
              Alert.alert(
                "Ready!",
                `Clinic loaded on this phone:\nUsers: ${result.users}\nPatients: ${result.patients}\nInventory: ${result.inventory}\n\nAsk your administrator for your email and password, then log in.`,
                [{ text: "OK", onPress: () => router.replace("/login") }],
              );
            } catch (error) {
              Alert.alert("Restore failed", error instanceof Error ? error.message : "Unable to restore the backup.");
            } finally {
              setLoading(false);
            }
          },
        },
      ],
    );
  };

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={() => router.back()} style={styles.headerBtn} testID="join-back">
          <Ionicons name="arrow-back" size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>Join Clinic</Text>
        <View style={styles.headerBtn} />
      </View>

      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + spacing.xl }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.hero}>
          <View style={styles.heroIcon}>
            <Ionicons name="people-outline" size={30} color={colors.onBrandPrimary} />
          </View>
          <Text style={styles.heroTitle}>Join {branding.title}</Text>
          <Text style={styles.heroSub}>
            Ask your administrator to share the clinic backup file with you (via WhatsApp,
            Bluetooth, Drive — anything). Then pick it below.
          </Text>
        </View>

        <View style={styles.stepCard}>
          <View style={styles.stepDot}><Text style={styles.stepDotText}>1</Text></View>
          <View style={{ flex: 1 }}>
            <Text style={styles.stepTitle}>Get the clinic backup</Text>
            <Text style={styles.stepSub}>
              Admin creates it from Settings → Sync & Backup, and shares the file with you.
            </Text>
          </View>
        </View>

        <View style={styles.stepCard}>
          <View style={styles.stepDot}><Text style={styles.stepDotText}>2</Text></View>
          <View style={{ flex: 1 }}>
            <Text style={styles.stepTitle}>Pick the file</Text>
            <Pressable
              style={styles.pickBtn}
              onPress={pick}
              disabled={loading}
              testID="join-select-button"
            >
              <Ionicons name="folder-open-outline" size={18} color={colors.onSurface} />
              <Text style={styles.pickText}>
                {selected ? "Change file" : "Select backup file"}
              </Text>
            </Pressable>
            {selected ? (
              <View style={styles.selectedBox}>
                <Text style={styles.fileName}>{selected.name}</Text>
                <Text style={styles.fileMeta}>
                  Created: {new Date(selected.info.createdAt).toLocaleString()}
                </Text>
              </View>
            ) : null}
          </View>
        </View>

        {selected ? (
          <View style={styles.stepCard}>
            <View style={styles.stepDot}><Text style={styles.stepDotText}>3</Text></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.stepTitle}>Enter the backup password</Text>
              <Text style={styles.stepSub}>Same password the admin used when creating the backup.</Text>
              <TextInput
                testID="join-password-input"
                value={password}
                onChangeText={setPassword}
                placeholder="Backup password"
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                placeholderTextColor={colors.muted}
                style={styles.input}
              />
              <Pressable
                style={[styles.primaryBtn, loading && { opacity: 0.6 }]}
                onPress={runRestore}
                disabled={loading}
                testID="join-run-button"
              >
                {loading ? (
                  <ActivityIndicator color={colors.onBrandPrimary} />
                ) : (
                  <>
                    <Ionicons name="download-outline" size={18} color={colors.onBrandPrimary} />
                    <Text style={styles.primaryText}>Load Clinic Data</Text>
                  </>
                )}
              </Pressable>
            </View>
          </View>
        ) : null}

        <Text style={styles.footerHint}>
          After joining, log in with the email and password your administrator gave you.
        </Text>
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  container: { flex: 1, backgroundColor: colors.surface },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  headerTitle: { fontFamily: fontFamily.bold, fontSize: fontSize.lg, color: colors.onSurface },
  hero: { alignItems: "center", paddingVertical: spacing.lg, gap: spacing.sm, marginBottom: spacing.md },
  heroIcon: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: colors.brandPrimary,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.sm,
  },
  heroTitle: { fontFamily: fontFamily.bold, fontSize: fontSize.xl, color: colors.onSurface, textAlign: "center" },
  heroSub: {
    fontFamily: fontFamily.regular,
    fontSize: fontSize.sm,
    color: colors.muted,
    textAlign: "center",
    lineHeight: 20,
  },
  stepCard: {
    flexDirection: "row",
    gap: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.md,
  },
  stepDot: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.brandTertiary,
    alignItems: "center",
    justifyContent: "center",
  },
  stepDotText: { fontFamily: fontFamily.bold, color: colors.onBrandTertiary },
  stepTitle: { fontFamily: fontFamily.bold, fontSize: fontSize.base, color: colors.onSurface, marginBottom: 4 },
  stepSub: { fontFamily: fontFamily.regular, fontSize: fontSize.sm, color: colors.muted, lineHeight: 18, marginBottom: spacing.sm },
  pickBtn: {
    minHeight: 44,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surface,
  },
  pickText: { fontFamily: fontFamily.semibold, color: colors.onSurface },
  selectedBox: {
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginTop: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  fileName: { fontFamily: fontFamily.semibold, color: colors.onSurface, fontSize: fontSize.sm },
  fileMeta: { fontFamily: fontFamily.regular, color: colors.muted, fontSize: fontSize.xs, marginTop: 2 },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    fontFamily: fontFamily.regular,
    fontSize: fontSize.base,
    color: colors.onSurface,
    marginTop: spacing.sm,
    marginBottom: spacing.md,
    backgroundColor: colors.surface,
  },
  primaryBtn: {
    minHeight: 48,
    borderRadius: radius.md,
    backgroundColor: colors.brandPrimary,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  primaryText: { color: colors.onBrandPrimary, fontFamily: fontFamily.bold, fontSize: fontSize.base },
  footerHint: {
    fontFamily: fontFamily.regular,
    fontSize: fontSize.xs,
    color: colors.muted,
    textAlign: "center",
    marginTop: spacing.md,
  },
}));
