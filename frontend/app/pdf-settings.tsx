import { router } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import Ionicons from "@react-native-vector-icons/ionicons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { PrimaryButton } from "@/src/components/PrimaryButton";
import { useToast } from "@/src/components/toast";
import { defaultBranding, fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";

export default function PdfSettingsScreen() {
  const styles = useStyles();
  const { colors, branding, setBranding } = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const [heading, setHeading] = useState(String(branding.pdfImplantHeading || "Implants"));
  const [subheading, setSubheading] = useState(String(branding.pdfImplantSubheading || "Used Implants"));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const nextHeading = heading.trim() || String(defaultBranding.pdfImplantHeading || "Implants");
    const nextSubheading = subheading.trim() || String(defaultBranding.pdfImplantSubheading || "Used Implants");
    setSaving(true);
    try {
      await setBranding({
        ...branding,
        pdfImplantHeading: nextHeading,
        pdfImplantSubheading: nextSubheading,
      });
      toast("PDF settings saved.", "success");
      router.back();
    } catch (e:any) {
      toast(e?.message || "Could not save PDF settings.", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={() => router.back()} style={styles.headerBtn} testID="pdf-settings-back">
          <Ionicons name="arrow-back" size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>PDF Settings</Text>
        <View style={styles.headerBtn} />
      </View>

      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + 120 }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.section}>Patient / Procedure PDF</Text>
        <Text style={styles.hint}>
          The normal Patient / Procedure PDF contains patient and procedure information only. Implant information is not included in this PDF.
        </Text>

        <Text style={[styles.section, { marginTop: spacing.xl }]}>Separate Implant PDF</Text>
        <Text style={styles.hint}>
          Implant records are generated in a separate PDF. Change the heading and sub-heading below; these settings apply only to the Implant PDF.
        </Text>

        <Text style={styles.label}>Implant PDF Heading</Text>
        <TextInput
          testID="pdf-implant-heading"
          value={heading}
          onChangeText={setHeading}
          placeholder="Implants"
          placeholderTextColor={colors.muted}
          style={styles.input}
        />

        <Text style={styles.label}>Implant PDF Sub-heading</Text>
        <TextInput
          testID="pdf-implant-subheading"
          value={subheading}
          onChangeText={setSubheading}
          placeholder="Used Implants"
          placeholderTextColor={colors.muted}
          style={styles.input}
        />

        <PrimaryButton title="Save PDF Settings" onPress={save} loading={saving} testID="pdf-settings-save" />
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
  section: {
    fontFamily: fontFamily.bold,
    fontSize: fontSize.base,
    color: colors.brandPrimary,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: spacing.sm,
  },
  hint: {
    fontFamily: fontFamily.regular,
    fontSize: fontSize.sm,
    color: colors.muted,
    lineHeight: 19,
    marginBottom: spacing.lg,
  },
  label: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSize.sm,
    color: colors.onSurfaceSecondary,
    marginBottom: spacing.xs,
  },
  input: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    fontFamily: fontFamily.regular,
    fontSize: fontSize.lg,
    color: colors.onSurface,
    minHeight: 50,
    marginBottom: spacing.lg,
  },
}));
