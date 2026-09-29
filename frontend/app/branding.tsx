import { router } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import * as FileSystem from "expo-file-system";
import { Image } from "expo-image";
import { useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import Ionicons from "@react-native-vector-icons/ionicons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAuth } from "@/src/auth/AuthContext";
import { PrimaryButton } from "@/src/components/PrimaryButton";
import { useToast } from "@/src/components/toast";
import {
  BRANDING_PRESETS,
  BrandingConfig,
  defaultBranding,
  fontFamily,
  fontSize,
  makeStyles,
  radius,
  spacing,
  useTheme,
} from "@/src/theme";

const COLOR_FIELDS: {
  key: keyof BrandingConfig;
  label: string;
  desc: string;
}[] = [
  { key: "primary", label: "Primary", desc: "Buttons, links, FAB, headings" },
  { key: "onPrimary", label: "On Primary", desc: "Text on the primary colour" },
  { key: "secondary", label: "Secondary", desc: "Chart bars, accents" },
  { key: "tertiary", label: "Tertiary", desc: "Chip and badge backgrounds" },
  { key: "onTertiary", label: "On Tertiary", desc: "Text on chip/badge" },
  { key: "background", label: "Background", desc: "Screen backgrounds" },
  { key: "surface", label: "Surface", desc: "Cards, inputs" },
  { key: "text", label: "Text", desc: "Body text colour" },
  { key: "mutedText", label: "Muted Text", desc: "Labels, hints" },
];

function isHex(v: string) {
  return /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(v);
}

export default function BrandingScreen() {
  const styles = useStyles();
  const { colors, branding, setBranding, resetBranding } = useTheme();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const toast = useToast();

  const [draft, setDraft] = useState<BrandingConfig>(branding);
  const [saving, setSaving] = useState(false);
  const [subtitleSelection, setSubtitleSelection] = useState({ start: 0, end: 0 });
  const [subtitleSizeText, setSubtitleSizeText] = useState(String(branding.pdfSubtitleSize));
  const [titleSizeText, setTitleSizeText] = useState(String(branding.pdfTitleSize));
  const subtitleInputRef = useRef<TextInput>(null);

  const set = (k: keyof BrandingConfig) => (v: string) =>
    setDraft((d) => ({ ...d, [k]: v }));

  if (user?.role !== "admin") {
    return (
      <View style={styles.container}>
        <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
          <Pressable onPress={() => router.back()} style={styles.headerBtn}>
            <Ionicons name="arrow-back" size={24} color={colors.onSurface} />
          </Pressable>
          <Text style={styles.headerTitle}>Branding</Text>
          <View style={styles.headerBtn} />
        </View>
        <View style={styles.center}>
          <Ionicons name="lock-closed-outline" size={40} color={colors.muted} />
          <Text style={styles.blockedTitle}>Administrator only</Text>
        </View>
      </View>
    );
  }

  const ensureLibraryPermission = async () => {
    const perm = await ImagePicker.getMediaLibraryPermissionsAsync();
    if (perm.granted) return true;
    if (!perm.canAskAgain) {
      toast("Photo permission is blocked. Enable it from Settings.", "error");
      return false;
    }
    const req = await ImagePicker.requestMediaLibraryPermissionsAsync();
    return req.granted;
  };

  const pickLogoFor = async (slot: "logoBase64" | "logoBase64Right") => {
    if (!(await ensureLibraryPermission())) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
      base64: true,
    });
    if (result.canceled) return;
    let base64 = result.assets[0]?.base64;
    const uri = result.assets[0]?.uri;
    if (!base64 && uri) {
      try {
        base64 = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
      } catch {
        toast("Could not read the selected image.", "error");
        return;
      }
    }
    if (!base64) return;
    if (base64.length > 1_500_000) {
      toast("Logo is too large. Please pick a smaller image (< 1MB).", "error");
      return;
    }
    const mime = result.assets[0]?.mimeType || "image/png";
    setDraft((d) => ({ ...d, [slot]: `data:${mime};base64,${base64}` }));
  };

  const clearLogo = (slot: "logoBase64" | "logoBase64Right") =>
    setDraft((d) => ({ ...d, [slot]: "" }));

  const applyPreset = (palette: Partial<BrandingConfig>) => {
    setDraft((d) => ({
      ...d,
      ...palette,
      onTertiary: palette.onTertiary || d.onTertiary,
      onPrimary: palette.onPrimary || d.onPrimary,
    }));
  };

  const updateSelectedBold = () => {
    const { start, end } = subtitleSelection;
    if (start === end) {
      toast("Select the letters or words to make bold.", "info");
      return;
    }
    const value = draft.pdfSubtitle;
    const selected = value.slice(start, end);
    const before = value.slice(0, start);
    const after = value.slice(end);
    const wrapped = before.endsWith("**") && after.startsWith("**");
    const next = wrapped
      ? before.slice(0, -2) + selected + after.slice(2)
      : before + "**" + selected + "**" + after;
    const nextSelection = wrapped ? { start: Math.max(0, start - 2), end: Math.max(0, end - 2) } : { start: start + 2, end: end + 2 };
    setDraft(d => ({ ...d, pdfSubtitle: next }));
    requestAnimationFrame(() => {
      subtitleInputRef.current?.focus();
      setSubtitleSelection(nextSelection);
    });
  };

  const commitSubtitleSize = () => {
    const n = Number(subtitleSizeText);
    const value = Number.isFinite(n) ? Math.max(8, Math.min(48, Math.round(n))) : branding.pdfSubtitleSize;
    setSubtitleSizeText(String(value));
    setDraft(d => ({ ...d, pdfSubtitleSize: value }));
  };

  const commitTitleSize = () => {
    const n = Number(titleSizeText);
    const value = Number.isFinite(n) ? Math.max(8, Math.min(72, Math.round(n))) : branding.pdfTitleSize;
    setTitleSizeText(String(value));
    setDraft(d => ({ ...d, pdfTitleSize: value }));
  };

  const onSave = async () => {
    if (!draft.title.trim()) {
      toast("App title is required.", "error");
      return;
    }
    for (const f of COLOR_FIELDS) {
      if (!isHex(String(draft[f.key]))) {
        toast(`Invalid colour for ${f.label}. Use hex format like #4A6B5D.`, "error");
        return;
      }
    }
    setSaving(true);
    try {
      await setBranding(draft);
      toast("Branding updated.", "success");
      router.back();
    } finally {
      setSaving(false);
    }
  };

  const onReset = async () => {
    await resetBranding();
    setDraft(defaultBranding);
    toast("Reset to default branding.", "success");
  };

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={() => router.back()} style={styles.headerBtn} testID="branding-back">
          <Ionicons name="arrow-back" size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>Branding</Text>
        <Pressable onPress={onReset} style={styles.headerBtn} testID="branding-reset">
          <Ionicons name="refresh" size={22} color={colors.brandPrimary} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={{
          padding: spacing.lg,
          paddingBottom: insets.bottom + 120,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.section}>App Identity</Text>

        <Text style={styles.label}>App Title</Text>
        <TextInput
          testID="branding-title-input"
          value={draft.title}
          onChangeText={set("title")}
          placeholder="Ortho Logbook"
          placeholderTextColor={colors.muted}
          style={styles.input}
        />

        <Text style={styles.label}>Logos (both sides of PDF title)</Text>
        <View style={styles.twinLogos}>
          <LogoSlot
            label="Left logo"
            slot="logoBase64"
            uri={draft.logoBase64}
            onPick={() => pickLogoFor("logoBase64")}
            onClear={() => clearLogo("logoBase64")}
          />
          <LogoSlot
            label="Right logo"
            slot="logoBase64Right"
            uri={draft.logoBase64Right}
            onPick={() => pickLogoFor("logoBase64Right")}
            onClear={() => clearLogo("logoBase64Right")}
          />
        </View>
        <Text style={styles.hint}>
          Both logos appear on each side of the title in the PDF header. The left logo is also used
          on the app login screen. If you upload only one, it is used on both sides.
        </Text>

        <Text style={[styles.label, { marginTop: spacing.md }]}>PDF sub-heading</Text>
        <TextInput
          ref={subtitleInputRef}
          testID="branding-pdf-subtitle-input"
          value={draft.pdfSubtitle}
          onChangeText={set("pdfSubtitle")}
          onSelectionChange={e => setSubtitleSelection(e.nativeEvent.selection)}
          placeholder="Write 2–3 lines. Select words, then tap Bold."
          placeholderTextColor={colors.muted}
          multiline
          numberOfLines={4}
          maxLength={220}
          style={[styles.input, styles.multilineInput]}
        />
        <View style={styles.styleRow}>
          <Pressable style={styles.styleChip} onPress={updateSelectedBold}>
            <Text style={[styles.styleChipText,{fontFamily:fontFamily.bold}]}>Bold selected</Text>
          </Pressable>
          <Text style={styles.hint}>Only the selected words become bold.</Text>
        </View>
        <View style={styles.styleRow}>
          {(["regular","medium","semibold","bold"] as const).map(v => (
            <Pressable key={v} onPress={() => setDraft(d => ({...d, pdfSubtitleFont:v}))} style={[styles.styleChip,{backgroundColor:draft.pdfSubtitleFont===v?colors.brandPrimary:colors.surfaceSecondary}]}>
              <Text style={[styles.styleChipText,{color:draft.pdfSubtitleFont===v?colors.onBrandPrimary:colors.onSurface}]}>{v}</Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.sizeRow}>
          <Text style={styles.colorLabel}>Sub-heading size</Text>
          <View style={styles.sizeControls}>
            <Pressable style={styles.sizeButton} onPress={() => { const n=Math.max(8, Number(draft.pdfSubtitleSize||12)-1); setDraft(d=>({...d,pdfSubtitleSize:n})); setSubtitleSizeText(String(n)); }}>
              <Ionicons name="remove" size={18} color={colors.onSurface} />
            </Pressable>
            <TextInput keyboardType="number-pad" value={subtitleSizeText} onChangeText={setSubtitleSizeText} onBlur={commitSubtitleSize} onSubmitEditing={commitSubtitleSize} returnKeyType="done" style={styles.smallSizeInput}/>
            <Pressable style={styles.sizeButton} onPress={() => { const n=Math.min(48, Number(draft.pdfSubtitleSize||12)+1); setDraft(d=>({...d,pdfSubtitleSize:n})); setSubtitleSizeText(String(n)); }}>
              <Ionicons name="add" size={18} color={colors.onSurface} />
            </Pressable>
          </View>
        </View>

        <Text style={[styles.label, { marginTop: spacing.md }]}>PDF heading style</Text>
        <View style={styles.styleRow}>
          {(["regular","medium","semibold","bold"] as const).map(v => (
            <Pressable key={v} onPress={() => setDraft(d => ({...d, pdfTitleFont:v}))} style={[styles.styleChip,{backgroundColor:draft.pdfTitleFont===v?colors.brandPrimary:colors.surfaceSecondary}]}>
              <Text style={[styles.styleChipText,{color:draft.pdfTitleFont===v?colors.onBrandPrimary:colors.onSurface}]}>{v}</Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.sizeRow}>
          <Text style={styles.colorLabel}>Heading size</Text>
          <View style={styles.sizeControls}>
            <Pressable style={styles.sizeButton} onPress={() => { const n=Math.max(8, Number(draft.pdfTitleSize||24)-1); setDraft(d=>({...d,pdfTitleSize:n})); setTitleSizeText(String(n)); }}>
              <Ionicons name="remove" size={18} color={colors.onSurface} />
            </Pressable>
            <TextInput keyboardType="number-pad" value={titleSizeText} onChangeText={setTitleSizeText} onBlur={commitTitleSize} onSubmitEditing={commitTitleSize} returnKeyType="done" style={styles.smallSizeInput}/>
            <Pressable style={styles.sizeButton} onPress={() => { const n=Math.min(72, Number(draft.pdfTitleSize||24)+1); setDraft(d=>({...d,pdfTitleSize:n})); setTitleSizeText(String(n)); }}>
              <Ionicons name="add" size={18} color={colors.onSurface} />
            </Pressable>
          </View>
        </View>
        <Text style={styles.hint}>Heading and sub-heading styles affect the PDF header only.</Text>
        <Text style={[styles.section, { marginTop: spacing.xl }]}>Colour Presets</Text>
        <View style={styles.presets}>
          {BRANDING_PRESETS.map((p) => (
            <Pressable
              key={p.name}
              testID={`preset-${p.name}`}
              style={styles.preset}
              onPress={() => applyPreset(p.palette)}
            >
              <View style={styles.presetSwatches}>
                <View style={[styles.pSwatch, { backgroundColor: p.palette.primary }]} />
                <View style={[styles.pSwatch, { backgroundColor: p.palette.secondary }]} />
                <View style={[styles.pSwatch, { backgroundColor: p.palette.tertiary }]} />
              </View>
              <Text style={styles.presetName}>{p.name}</Text>
            </Pressable>
          ))}
        </View>

        <Text style={[styles.section, { marginTop: spacing.xl }]}>Custom Colours</Text>

        {COLOR_FIELDS.map((f) => (
          <View key={f.key} style={styles.colorRow}>
            <View style={[styles.colorSwatch, { backgroundColor: String(draft[f.key]) }]} />
            <View style={{ flex: 1 }}>
              <Text style={styles.colorLabel}>{f.label}</Text>
              <Text style={styles.colorDesc}>{f.desc}</Text>
              <TextInput
                testID={`branding-color-${f.key}`}
                value={String(draft[f.key])}
                onChangeText={set(f.key)}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="#4A6B5D"
                placeholderTextColor={colors.muted}
                style={[
                  styles.colorInput,
                  !isHex(String(draft[f.key])) && { borderColor: colors.error },
                ]}
              />
            </View>
          </View>
        ))}
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}>
        <PrimaryButton title="Save Branding" onPress={onSave} loading={saving} testID="branding-save" />
      </View>
    </View>
  );
}

function LogoSlot({
  label,
  slot,
  uri,
  onPick,
  onClear,
}: {
  label: string;
  slot: "logoBase64" | "logoBase64Right";
  uri: string;
  onPick: () => void;
  onClear: () => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <View style={styles.logoSlot} testID={`logo-slot-${slot}`}>
      <Text style={styles.slotLabel}>{label}</Text>
      <Pressable
        onPress={onPick}
        style={styles.logoPreview}
        testID={`pick-logo-${slot}`}
      >
        {uri ? (
          <Image source={{ uri }} style={styles.logoImg} contentFit="cover" />
        ) : (
          <Ionicons name="add" size={26} color={colors.muted} />
        )}
      </Pressable>
      <View style={{ flexDirection: "row", gap: spacing.xs }}>
        <Pressable onPress={onPick} style={styles.slotBtn} testID={`upload-logo-${slot}`}>
          <Ionicons name="cloud-upload-outline" size={14} color={colors.onSurface} />
          <Text style={styles.slotBtnText}>{uri ? "Change" : "Upload"}</Text>
        </Pressable>
        {uri ? (
          <Pressable onPress={onClear} style={styles.slotBtn} testID={`clear-logo-${slot}`}>
            <Ionicons name="trash-outline" size={14} color={colors.error} />
          </Pressable>
        ) : null}
      </View>
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
  section: {
    fontFamily: fontFamily.bold,
    fontSize: fontSize.sm,
    color: colors.brandPrimary,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: spacing.md,
  },
  label: { fontFamily: fontFamily.semibold, fontSize: fontSize.sm, color: colors.onSurfaceSecondary, marginBottom: spacing.xs },
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
  multilineInput: {
    minHeight: 96,
    textAlignVertical: "top",
    fontSize: fontSize.base,
    lineHeight: 20,
  },
  styleRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, alignItems: "center", marginBottom: spacing.sm },
  styleChip: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border },
  styleChipText: { fontFamily: fontFamily.medium, fontSize: fontSize.sm },
  sizeRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.md },
  sizeControls: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  sizeButton: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSecondary, alignItems: "center", justifyContent: "center" },
  smallSizeInput: { width: 72, textAlign: "center", backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingVertical: spacing.sm, color: colors.onSurface, fontFamily: fontFamily.medium },
  twinLogos: { flexDirection: "row", gap: spacing.md, marginBottom: spacing.sm },
  layoutRow: { flexDirection: "row", gap: spacing.sm, marginBottom: spacing.sm },
  layoutOption: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  logoSlot: {
    flex: 1,
    alignItems: "center",
    gap: spacing.xs,
    padding: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSecondary,
  },
  slotLabel: { fontFamily: fontFamily.semibold, fontSize: fontSize.xs, color: colors.muted, textTransform: "uppercase", letterSpacing: 0.6 },
  slotBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  slotBtnText: { fontFamily: fontFamily.semibold, fontSize: fontSize.xs, color: colors.onSurface },
  logoRow: { flexDirection: "row", gap: spacing.md, alignItems: "flex-start", marginBottom: spacing.sm },
  logoPreview: {
    width: 88,
    height: 88,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSecondary,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  logoImg: { width: "100%", height: "100%" },
  actionBtn: {
    flexDirection: "row",
    gap: spacing.sm,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSecondary,
  },
  actionBtnGhost: {
    flexDirection: "row",
    gap: spacing.sm,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 40,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
  },
  actionText: { fontFamily: fontFamily.semibold, color: colors.onSurface },
  hint: { fontFamily: fontFamily.regular, fontSize: fontSize.sm, color: colors.muted, marginTop: spacing.xs, marginBottom: spacing.md },
  presets: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  preset: {
    width: "48%",
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSecondary,
  },
  presetSwatches: { flexDirection: "row", gap: spacing.xs, marginBottom: spacing.xs },
  pSwatch: { width: 22, height: 22, borderRadius: 11, borderWidth: 1, borderColor: colors.border },
  presetName: { fontFamily: fontFamily.semibold, fontSize: fontSize.sm, color: colors.onSurface },
  colorRow: {
    flexDirection: "row",
    gap: spacing.md,
    alignItems: "flex-start",
    marginBottom: spacing.md,
  },
  colorSwatch: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: colors.border,
    marginTop: 22,
  },
  colorLabel: { fontFamily: fontFamily.semibold, fontSize: fontSize.base, color: colors.onSurface },
  colorDesc: { fontFamily: fontFamily.regular, fontSize: fontSize.xs, color: colors.muted, marginBottom: 6 },
  colorInput: {
    fontFamily: fontFamily.monoMedium,
    fontSize: fontSize.base,
    color: colors.onSurface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 40,
    backgroundColor: colors.surfaceSecondary,
  },
  footer: {
    padding: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.sm },
  blockedTitle: { fontFamily: fontFamily.bold, fontSize: fontSize.lg, color: colors.onSurface, marginTop: spacing.sm },
}));
