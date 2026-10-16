import { router } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Share, Text, TextInput, View, Alert, Platform } from "react-native";
import * as Clipboard from "expo-clipboard";
import Ionicons from "@react-native-vector-icons/ionicons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useToast } from "@/src/components/toast";
import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";
import { buildProblemReport } from "@/src/utils/problem-report";

export default function ReportProblemScreen() {
  const { colors } = useTheme();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const [description, setDescription] = useState("");
  const [report, setReport] = useState("");
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);

  const refreshReport = async (text = description) => {
    setLoading(true);
    try { setReport(await buildProblemReport(text)); }
    catch { setReport("Could not collect all diagnostics. Please describe the issue below and try again."); }
    finally { setLoading(false); }
  };

  useEffect(() => { void refreshReport(""); }, []);

  const copyReport = async () => {
    setWorking(true);
    try {
      const latest = await buildProblemReport(description);
      setReport(latest);
      await Clipboard.setStringAsync(latest);
      toast("Problem report copied. Paste it into your ChatGPT message.", "success");
    } catch {
      toast("Could not copy the report. Please try again.", "error");
    } finally { setWorking(false); }
  };

  const shareReport = async () => {
    setWorking(true);
    try {
      const latest = await buildProblemReport(description);
      setReport(latest);
      await Share.share({ title: "Ortho Logbook problem report", message: latest });
    } catch {
      Alert.alert("Sharing failed", "Please try Copy report and paste it into your message.");
    } finally { setWorking(false); }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.headerBtn} accessibilityLabel="Go back">
          <Ionicons name="arrow-back" size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>Report a Problem</Text>
        <View style={styles.headerBtn} />
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + spacing.xxl }}>
        <View style={styles.intro}>
          <Ionicons name="bug-outline" size={30} color={colors.brandPrimary} />
          <Text style={styles.introTitle}>Help us fix the issue</Text>
          <Text style={styles.body}>Describe what happened and when. The report includes app/build details, recent errors with stack traces, and the screen/action where a handled error occurred. Nothing is sent automatically—you choose when to copy or share it.</Text>
        </View>

        <Text style={styles.label}>What happened?</Text>
        <TextInput
          value={description}
          onChangeText={value => {
            setDescription(value);
            void buildProblemReport(value).then(setReport).catch(() => {});
          }}
          placeholder="Example: Auto-Scan freezes after I tap the button..."
          placeholderTextColor={colors.muted}
          multiline
          textAlignVertical="top"
          accessibilityLabel="Describe the problem"
          style={styles.input}
        />

        <Text style={styles.sectionTitle}>Technical report preview</Text>
        {loading ? (
          <View style={styles.loading}><ActivityIndicator color={colors.brandPrimary} /><Text style={styles.body}>Collecting diagnostics…</Text></View>
        ) : (
          <Text selectable style={styles.preview}>{report || "Technical diagnostics will appear here."}</Text>
        )}

        <Pressable onPress={copyReport} disabled={working || loading} style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed, (working || loading) && styles.disabled]} accessibilityRole="button" testID="report-problem-copy">
          <Ionicons name="copy-outline" size={20} color={colors.onBrandPrimary} />
          <Text style={styles.primaryText}>{working ? "Preparing…" : "Copy report"}</Text>
        </Pressable>
        <Pressable onPress={shareReport} disabled={working || loading} style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed, (working || loading) && styles.disabled]} accessibilityRole="button" testID="report-problem-share">
          <Ionicons name="share-social-outline" size={20} color={colors.brandPrimary} />
          <Text style={styles.secondaryText}>Share report</Text>
        </Pressable>
        <Pressable onPress={() => void refreshReport()} disabled={working} style={styles.refreshButton} accessibilityRole="button">
          <Ionicons name="refresh-outline" size={18} color={colors.muted} />
          <Text style={styles.refreshText}>Refresh diagnostics</Text>
        </Pressable>
        <Text style={styles.privacy}>Privacy: the report does not include patient records, photos, or database contents. Review the generated report before sharing it.</Text>
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles(colors => ({
  container: { flex: 1, backgroundColor: colors.surfaceSecondary },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.md, paddingBottom: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.surface },
  headerBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  headerTitle: { fontFamily: fontFamily.bold, fontSize: fontSize.lg, color: colors.onSurface },
  intro: { alignItems: "center", gap: spacing.sm, backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.lg, marginBottom: spacing.lg },
  introTitle: { fontFamily: fontFamily.bold, fontSize: fontSize.lg, color: colors.onSurface },
  body: { fontFamily: fontFamily.regular, fontSize: fontSize.sm, color: colors.muted, lineHeight: 20, textAlign: "center" },
  label: { fontFamily: fontFamily.semibold, fontSize: fontSize.base, color: colors.onSurface, marginBottom: spacing.sm },
  input: { minHeight: 120, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, color: colors.onSurface, backgroundColor: colors.surface, fontFamily: fontFamily.regular, fontSize: fontSize.base, marginBottom: spacing.lg },
  sectionTitle: { fontFamily: fontFamily.semibold, fontSize: fontSize.base, color: colors.onSurface, marginBottom: spacing.sm },
  preview: { fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }), fontSize: 12, lineHeight: 17, color: colors.onSurfaceSecondary, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md },
  loading: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: spacing.sm, padding: spacing.lg },
  primaryButton: { minHeight: 50, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm, backgroundColor: colors.brandPrimary, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.sm },
  primaryText: { color: colors.onBrandPrimary, fontFamily: fontFamily.semibold, fontSize: fontSize.base },
  secondaryButton: { minHeight: 50, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.brandPrimary, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.sm },
  secondaryText: { color: colors.brandPrimary, fontFamily: fontFamily.semibold, fontSize: fontSize.base },
  refreshButton: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.xs, padding: spacing.md, marginTop: spacing.xs },
  refreshText: { color: colors.muted, fontFamily: fontFamily.medium, fontSize: fontSize.sm },
  privacy: { fontFamily: fontFamily.regular, fontSize: fontSize.xs, lineHeight: 18, color: colors.muted, marginTop: spacing.md, textAlign: "center" },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.5 },
}));
