import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import * as FileSystem from "expo-file-system/legacy";
import { useMemo, useState } from "react";
import { Image, Modal, Pressable, ScrollView, Text, View } from "react-native";
import Ionicons from "@react-native-vector-icons/ionicons";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api } from "@/src/api/client";
import { useAuth } from "@/src/auth/AuthContext";
import { AutocompleteField, type Suggestion } from "@/src/components/AutocompleteField";
import { Field } from "@/src/components/Field";
import { PrimaryButton } from "@/src/components/PrimaryButton";
import { Segmented } from "@/src/components/Segmented";
import { useToast } from "@/src/components/toast";
import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";

type Patient = {
  id: string; mrNo: string; name: string; gender: string; age: string;
  diagnosis: string; procedure: string; implant: string; implantII: string;
  address: string; fileName: string; photoUri: string; photos: string[]; date: string;
  operationCount?: number; totalOperations?: number;
};
type Procedure = { id: string; name: string };
type InventoryItem = { id: string; name: string; category: string; categoryId?: string; size: string; quantity: number };

const today = () => new Date().toISOString().slice(0, 10);
const empty = (): Patient => ({
  id: "", mrNo: "", name: "", gender: "", age: "", diagnosis: "",
  procedure: "", implant: "", implantII: "", address: "", fileName: "",
  photoUri: "", photos: [], date: today(),
});

export default function PatientForm() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const qc = useQueryClient();
  const { user } = useAuth();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const isEdit = !!id;

  const { data: patients } = useQuery<Patient[]>({ queryKey: ["patients"], queryFn: () => api.get("/patients") });
  const { data: procedures } = useQuery<Procedure[]>({ queryKey: ["procedures"], queryFn: () => api.get("/procedures") });
  const { data: inventory } = useQuery<InventoryItem[]>({ queryKey: ["inventory"], queryFn: () => api.get("/inventory") });
  const existing = useMemo(() => (id ? patients?.find((p) => p.id === id) : undefined), [id, patients]);

  // Type-ahead sources: procedure catalogue + any procedure names used on past
  // records; implants come from inventory only (saving validates stock).
  const procedureSuggestions = useMemo<Suggestion[]>(() => {
    const byLower = new Map<string, string>();
    for (const x of procedures ?? []) {
      const n = x.name?.trim();
      if (n) byLower.set(n.toLowerCase(), n);
    }
    for (const pt of patients ?? []) {
      const n = pt.procedure?.trim();
      if (n && !byLower.has(n.toLowerCase())) byLower.set(n.toLowerCase(), n);
    }
    return [...byLower.values()]
      .sort((a, b) => a.localeCompare(b))
      .map((n) => ({ key: n.toLowerCase(), label: n }));
  }, [procedures, patients]);

  const implantSuggestions = useMemo<Suggestion[]>(
    () =>
      (inventory ?? [])
        .filter((x) => x.name?.trim())
        .map((x) => {
          const label = [x.category, x.name, x.size].filter(Boolean).join(" · ");
          return { key: x.id, label, detail: `${x.quantity} ${x.size ? "" : "pcs"} in stock` };
        })
        .sort((a, b) => a.label.localeCompare(b.label)),
    [inventory],
  );

  const [selectedPhoto, setSelectedPhoto] = useState<string | null>(null);
  const [p, setP] = useState<Patient>(empty);
  const setImplant = (field: "implant" | "implantII", item: InventoryItem) => {
    setP(prev => ({ ...prev, [field]: item.name, [field === "implant" ? "implantId" : "implantIIId"]: item.id }));
  };
  const [ready, setReady] = useState(false);
  if (existing && !ready) {
    // Normalise legacy records that only had photoUri.
    const photos = Array.isArray(existing.photos) && existing.photos.length
      ? existing.photos
      : existing.photoUri ? [existing.photoUri] : [];
    setP({ ...existing, photos });
    setReady(true);
  }

  // Duplicate-tracking: for the current draft, how many earlier records share
  // the same trimmed lowercased name + MR number? This is only for the header
  // badge preview so users know they're about to log a repeat operation.
  const duplicate = useMemo(() => {
    const rawName = p.name.trim().toLowerCase();
    const rawMr = p.mrNo.trim().toLowerCase();
    if (!rawName || !rawMr || !patients?.length) return null;
    const matches = patients.filter(
      (x) =>
        x.id !== p.id &&
        x.name.trim().toLowerCase() === rawName &&
        x.mrNo.trim().toLowerCase() === rawMr,
    );
    if (!matches.length) return null;
    // If editing an existing record we prefer the computed operation count on the list.
    if (isEdit && existing?.operationCount && (existing.totalOperations || 0) > 1) {
      return { current: existing.operationCount, total: existing.totalOperations || matches.length + 1 };
    }
    return { current: matches.length + 1, total: matches.length + 1 };
  }, [p.name, p.mrNo, p.id, patients, isEdit, existing]);

  const ordinal = (n: number) => {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };

  const set = (key: keyof Patient) => (v: any) => setP((x) => ({ ...x, [key]: v }));

  async function ensureLibraryPermission() {
    const perm = await ImagePicker.getMediaLibraryPermissionsAsync();
    if (perm.granted) return true;
    if (!perm.canAskAgain) {
      toast("Photo permission is blocked. Enable it from Settings.", "error");
      return false;
    }
    const req = await ImagePicker.requestMediaLibraryPermissionsAsync();
    return req.granted;
  }

  async function ensureCameraPermission() {
    const perm = await ImagePicker.getCameraPermissionsAsync();
    if (perm.granted) return true;
    if (!perm.canAskAgain) {
      toast("Camera permission is blocked. Enable it from Settings.", "error");
      return false;
    }
    const req = await ImagePicker.requestCameraPermissionsAsync();
    return req.granted;
  }

  // Keep a private, permanent copy inside the app. Gallery/camera URIs can
  // point to temporary cache/content-provider locations that stop working later.
  // We copy/normalize every newly added photo immediately so the saved patient
  // record never depends on the gallery app or a temporary URI.
  const persistPhoto = async (sourceUri: string) => {
    if (!sourceUri || sourceUri.startsWith("data:")) return sourceUri;
    const directory = `${FileSystem.documentDirectory}patient-photos/`;
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true }).catch(() => {});
    const normalized = await ImageManipulator.manipulateAsync(
      sourceUri,
      [],
      { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG },
    );
    const filename = `patient-photo-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.jpg`;
    const destination = `${directory}${filename}`;
    await FileSystem.copyAsync({ from: normalized.uri, to: destination });
    return destination;
  };

  // No cropping (allowsEditing:false). Library allows multi-select.
  const addFromLibrary = async () => {
    if (!(await ensureLibraryPermission())) return;
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: false,
        allowsMultipleSelection: true,
        selectionLimit: 20,
        quality: 0.9,
      });
      if (result.canceled) return;
      const uris = result.assets.map((a) => a.uri).filter(Boolean);
      const permanentUris: string[] = [];
      for (const uri of uris) permanentUris.push(await persistPhoto(uri));
      setP((x) => ({ ...x, photos: [...x.photos, ...permanentUris] }));
    } catch (e: any) {
      toast(e?.message || "Could not save the selected photo.", "error");
    }
  };

  const addFromCamera = async () => {
    if (!(await ensureCameraPermission())) return;
    try {
      const result = await ImagePicker.launchCameraAsync({
        allowsEditing: false,
        quality: 0.9,
      });
      if (result.canceled) return;
      const uri = result.assets[0]?.uri;
      if (uri) setP((x) => ({ ...x, photos: [...x.photos, await persistPhoto(uri)] }));
    } catch (e: any) {
      toast(e?.message || "Could not save the camera photo.", "error");
    }
  };

  const removePhoto = (idx: number) => {
    setP((x) => ({ ...x, photos: x.photos.filter((_, i) => i !== idx) }));
  };

  const save = useMutation({
    mutationFn: () => (isEdit ? api.put("/patients/" + id, p) : api.post("/patients", p)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["patients"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
      toast(isEdit ? "Record updated." : "Patient saved.", "success");
      router.back();
    },
    onError: (e: any) => toast(e?.message || "Could not save record.", "error"),
  });

  const del = useMutation({
    mutationFn: () => api.del("/patients/" + id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["patients"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
      toast("Record deleted.", "success");
      router.back();
    },
    onError: (e: any) => toast(e?.message || "Could not delete.", "error"),
  });

  const canEdit = !!user?.canEditPatients || user?.role === "admin";
  const onSave = () => {
    if (!canEdit && isEdit) { toast("You do not have permission to edit patient records.", "error"); return; }
    if (!p.name.trim() && !p.mrNo.trim()) { toast("Enter at least an MRNo or patient name.", "error"); return; }
    save.mutate();
  };

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={() => router.back()} style={styles.headerBtn}>
          <Ionicons name="close" size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>{isEdit ? "Edit Patient" : "New Patient"}</Text>
        {isEdit && canEdit ? (
          <Pressable testID="delete-patient-button" onPress={() => del.mutate()} style={styles.headerBtn}>
            <Ionicons name="trash-outline" size={22} color={colors.error} />
          </Pressable>
        ) : (
          <View style={styles.headerBtn} />
        )}
      </View>

      <KeyboardAwareScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxxl }}
        bottomOffset={100}
        keyboardShouldPersistTaps="handled"
      >
        {duplicate ? (
          <View style={styles.duplicateBanner} testID="duplicate-banner">
            <Ionicons name="repeat" size={20} color={colors.onWarning} />
            <Text style={styles.duplicateText}>
              {isEdit ? "This is the " : "Will be logged as the "}
              <Text style={styles.duplicateStrong}>{ordinal(duplicate.current)} time</Text>
              {" operated for "}
              <Text style={styles.duplicateStrong} numberOfLines={1}>{p.name.trim()}</Text>
              {" (MR "}
              <Text style={styles.duplicateStrong}>{p.mrNo.trim()}</Text>
              {")."}
            </Text>
          </View>
        ) : null}
        <Text style={styles.section}>Patient photos</Text>
        <View style={styles.photoActions}>
          <PrimaryButton title={`Add from Gallery${p.photos.length ? " (+)" : ""}`} onPress={addFromLibrary} testID="add-photo-library-button" />
          <Pressable style={styles.secondary} onPress={addFromCamera} testID="add-photo-camera-button">
            <Ionicons name="camera" size={18} color={colors.onSurface} />
            <Text style={styles.secondaryText}> Take Photo</Text>
          </Pressable>
        </View>
        {p.photos.length === 0 ? (
          <View style={styles.photoPlaceholder}>
            <Ionicons name="images-outline" size={38} color={colors.muted} />
            <Text style={styles.hint}>No photos yet. Add uncropped full-size photos.</Text>
          </View>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.photoStrip}>
            {p.photos.map((uri, idx) => (
              <View key={`${uri}-${idx}`} style={styles.photoBox} testID={`patient-photo-${idx}`}>
                <Pressable style={{ flex: 1 }} onPress={() => setSelectedPhoto(uri)} testID={`open-patient-photo-${idx}`}>
                  <Image source={{ uri }} style={styles.photoThumb} resizeMode="cover" />
                </Pressable>
                <Pressable style={styles.photoRemove} onPress={() => removePhoto(idx)} hitSlop={8} testID={`remove-photo-${idx}`}>
                  <Ionicons name="close" size={16} color="#FFFFFF" />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        )}

        <Text style={styles.section}>Patient Details</Text>
        <Field label="MRNo" testID="patient-mrno-input" value={p.mrNo} onChangeText={set("mrNo")} placeholder="e.g. 10234" />
        <Field label="Patient Name" testID="patient-name-input" value={p.name} onChangeText={set("name")} placeholder="Full name" autoCapitalize="words" />
        <Text style={styles.label}>Gender</Text>
        <View style={{ marginBottom: spacing.lg }}>
          <Segmented options={["Male", "Female", "Other"]} value={p.gender} onChange={set("gender")} />
        </View>
        <Field label="Age" testID="patient-age-input" value={p.age} onChangeText={set("age")} keyboardType="number-pad" placeholder="e.g. 45" />
        <Field label="Address" testID="patient-address-input" value={p.address} onChangeText={set("address")} placeholder="Patient address" />

        <Text style={styles.section}>Clinical Details</Text>
        <Field label="Diagnosis" testID="patient-diagnosis-input" value={p.diagnosis} onChangeText={set("diagnosis")} placeholder="Diagnosis" />
        <AutocompleteField label="Procedure" testID="patient-procedure-input" value={p.procedure} onChangeText={set("procedure")} placeholder="Type to search procedures" suggestions={procedureSuggestions} />
        {!!procedures?.length && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.quickScroller} contentContainerStyle={styles.quickRow}>
            {procedures.map((x) => (
              <Pressable key={x.id} style={styles.quickChip} onPress={() => set("procedure")(x.name)}>
                <Text style={styles.quickChipText}>{x.name}</Text>
              </Pressable>
            ))}
          </ScrollView>
        )}
        <AutocompleteField label="Implant" testID="patient-implant-input" value={p.implant} onChangeText={(v) => setP(prev => ({ ...prev, implant: v, implantId: undefined }))} placeholder="Type to search implants" suggestions={implantSuggestions} onSelect={(s) => { const item = (inventory ?? []).find(x => x.id === s.key); if (item) setImplant("implant", item); }} />
        <AutocompleteField label="Implant II" testID="patient-implant2-input" value={p.implantII} onChangeText={(v) => setP(prev => ({ ...prev, implantII: v, implantIIId: undefined }))} placeholder="Second implant (optional)" suggestions={implantSuggestions} onSelect={(s) => { const item = (inventory ?? []).find(x => x.id === s.key); if (item) setImplant("implantII", item); }} />
        {!!inventory?.length && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.quickScroller} contentContainerStyle={styles.quickRow}>
            {inventory.map((x) => (
              <Pressable key={x.id} style={styles.quickChip} onPress={() => setImplant("implant", x)}>
                <Text style={styles.quickChipText}>{[x.category, x.name, x.size].filter(Boolean).join(" · ")} · {x.quantity}</Text>
              </Pressable>
            ))}
          </ScrollView>
        )}
        <Field label="File / Reference" testID="patient-file-input" value={p.fileName} onChangeText={set("fileName")} placeholder="File reference" />
        <Field label="Date" testID="patient-date-input" value={p.date} onChangeText={set("date")} placeholder="YYYY-MM-DD" />
        {isEdit && (
          <Pressable style={styles.history} onPress={() => router.push({ pathname: "/patient-history", params: { id } })}>
            <Ionicons name="time-outline" size={20} color={colors.brandPrimary} />
            <Text style={styles.historyText}>View edit history</Text>
          </Pressable>
        )}
      </KeyboardAwareScrollView>

      <Modal visible={!!selectedPhoto} transparent animationType="fade" onRequestClose={() => setSelectedPhoto(null)}>
        <View style={styles.photoViewer}>
          <Pressable style={styles.photoViewerClose} onPress={() => setSelectedPhoto(null)} hitSlop={10}>
            <Ionicons name="close" size={30} color="#FFFFFF" />
          </Pressable>
          {!!selectedPhoto && (
            <Image source={{ uri: selectedPhoto }} style={styles.photoFull} resizeMode="contain" />
          )}
        </View>
      </Modal>

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}>
        {canEdit || !isEdit ? (
          <PrimaryButton title={isEdit ? "Update Record" : "Save Record"} onPress={onSave} testID="save-patient-button" loading={save.isPending} />
        ) : (
          <Text style={styles.permission}>This record is read-only for your account.</Text>
        )}
      </View>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  container: { flex: 1, backgroundColor: colors.surface },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.md, paddingBottom: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  headerBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  headerTitle: { fontFamily: fontFamily.bold, fontSize: fontSize.lg, color: colors.onSurface },
  section: { fontFamily: fontFamily.bold, fontSize: fontSize.sm, color: colors.brandPrimary, textTransform: "uppercase", letterSpacing: 0.6, marginTop: spacing.md, marginBottom: spacing.md },
  label: { fontFamily: fontFamily.semibold, fontSize: fontSize.sm, color: colors.onSurfaceSecondary, marginBottom: spacing.xs },
  photoActions: { flexDirection: "row", gap: spacing.md, marginBottom: spacing.md, alignItems: "center", flexWrap: "wrap" },
  secondary: { flexDirection: "row", alignItems: "center", height: 48, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: spacing.md, justifyContent: "center" },
  secondaryText: { fontFamily: fontFamily.semibold, color: colors.onSurface },
  photoPlaceholder: { height: 140, borderRadius: radius.lg, backgroundColor: colors.surfaceTertiary, alignItems: "center", justifyContent: "center", marginBottom: spacing.md, gap: spacing.sm },
  hint: { fontFamily: fontFamily.regular, fontSize: fontSize.sm, color: colors.muted },
  photoStrip: { gap: spacing.md, paddingVertical: spacing.sm, paddingRight: spacing.md },
  photoViewer: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.96)",
    alignItems: "center",
    justifyContent: "center",
  },
  photoFull: { width: "100%", height: "100%" },
  photoViewerClose: {
    position: "absolute",
    zIndex: 10,
    top: 52,
    right: 18,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center",
    justifyContent: "center",
  },
  photoBox: { width: 140, height: 180, borderRadius: radius.md, overflow: "hidden", backgroundColor: colors.surfaceTertiary },
  photoThumb: { width: "100%", height: "100%" },
  photoRemove: { position: "absolute", top: 6, right: 6, backgroundColor: "rgba(0,0,0,0.65)", width: 26, height: 26, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  quickScroller: { marginTop: -spacing.sm, marginBottom: spacing.lg },
  quickRow: { gap: spacing.sm, paddingRight: spacing.lg },
  quickChip: { height: 36, justifyContent: "center", backgroundColor: colors.surfaceTertiary, borderRadius: radius.pill, paddingHorizontal: spacing.md },
  quickChipText: { fontFamily: fontFamily.medium, fontSize: fontSize.sm, color: colors.onSurfaceTertiary },
  history: { flexDirection: "row", alignItems: "center", gap: spacing.sm, padding: spacing.lg, backgroundColor: colors.surfaceTertiary, borderRadius: radius.md, marginTop: spacing.md },
  historyText: { fontFamily: fontFamily.semibold, color: colors.brandPrimary },
  duplicateBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    backgroundColor: colors.warning,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  duplicateText: {
    flex: 1,
    fontFamily: fontFamily.medium,
    fontSize: fontSize.sm,
    color: colors.onWarning,
    lineHeight: 20,
  },
  duplicateStrong: { fontFamily: fontFamily.bold, color: colors.onWarning },
  footer: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface },
  permission: { textAlign: "center", color: colors.muted, fontFamily: fontFamily.semibold, padding: spacing.md },
}));
