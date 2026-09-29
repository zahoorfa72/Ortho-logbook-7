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
  diagnosis: string; procedure: string; implant: string; implantII: string; implants?: SelectedImplant[];
  address: string; fileName: string; photoUri: string; photos: string[]; date: string;
  operationCount?: number; totalOperations?: number;
};
type Procedure = { id: string; name: string };
type InventoryItem = { id: string; name: string; category: string; categoryId?: string; size: string; quantity: number };
type SelectedImplant = { id: string; inventoryId: string; name: string; category: string; size: string; quantity: number };

const today = () => new Date().toISOString().slice(0, 10);
const empty = (): Patient => ({
  id: "", mrNo: "", name: "", gender: "", age: "", diagnosis: "",
  procedure: "", implant: "", implantII: "", address: "", fileName: "",
  photoUri: "", photos: [], date: today(), implants: [],
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
  const [implantSearch, setImplantSearch] = useState("");

  const { data: patients } = useQuery<Patient[]>({ queryKey: ["patients"], queryFn: () => api.get("/patients") });
  const { data: procedures } = useQuery<Procedure[]>({ queryKey: ["procedures"], queryFn: () => api.get("/procedures") });
  const { data: inventory = [] } = useQuery<InventoryItem[]>({
    queryKey: ["inventory", "patient-search", implantSearch.trim().toLowerCase()],
    queryFn: () => api.get("/inventory?q=" + encodeURIComponent(implantSearch.trim())),
    enabled: implantSearch.trim().length > 0,
    staleTime: 10000,
  });
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

  const [selectedPhoto, setSelectedPhoto] = useState<string | null>(null);
  const [editingPhotoIndex, setEditingPhotoIndex] = useState<number | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [implantSearch, setImplantSearch] = useState("");
  const [p, setP] = useState<Patient>(empty);
  const selectedImplants = p.implants || [];
  const addImplant = (item: InventoryItem) => {
    setP(prev => {
      const current = prev.implants || [];
      const existingIndex = current.findIndex(x => x.inventoryId === item.id);
      if (existingIndex >= 0) {
        const next = [...current];
        next[existingIndex] = { ...next[existingIndex], quantity: next[existingIndex].quantity + 1 };
        return { ...prev, implants: next };
      }
      return {
        ...prev,
        implants: [...current, { id: `pi-${Date.now()}-${Math.random().toString(36).slice(2,7)}`, inventoryId:item.id, name:item.name, category:item.category, size:item.size, quantity:1 }],
        implant: "",
        implantId: undefined as any,
      };
    });
    setImplantSearch("");
  };
  const removeImplant = (id: string) => setP(prev => ({ ...prev, implants:(prev.implants || []).filter(x => x.id !== id) }));
  const changeImplantQty = (id: string, delta: number) => setP(prev => ({
    ...prev,
    implants:(prev.implants || []).map(x => x.id === id ? { ...x, quantity:Math.max(1,x.quantity + delta) } : x),
  }));
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
      if (uri) {
        const permanentUri = await persistPhoto(uri);
        setP((x) => ({ ...x, photos: [...x.photos, permanentUri] }));
      }
    } catch (e: any) {
      toast(e?.message || "Could not save the camera photo.", "error");
    }
  };

  const removePhoto = (idx: number) => {
    setP((x) => ({ ...x, photos: x.photos.filter((_, i) => i !== idx) }));
  };
  const editPhoto = async (idx: number, action: "rotate" | "crop") => {
    const uri = p.photos[idx];
    if (!uri) return;
    setPhotoBusy(true);
    try {
      let actions: ImageManipulator.Action[] = [];
      if (action === "rotate") {
        actions = [{ rotate: 90 }];
      } else {
        const size = await new Promise<{ width: number; height: number }>((resolve, reject) =>
          Image.getSize(uri, (width, height) => resolve({ width, height }), reject),
        );
        const side = Math.min(size.width, size.height);
        actions = [{
          crop: {
            originX: Math.max(0, Math.round((size.width - side) / 2)),
            originY: Math.max(0, Math.round((size.height - side) / 2)),
            width: side,
            height: side,
          },
        }];
      }
      const result = await ImageManipulator.manipulateAsync(uri, actions, {
        compress: 0.9,
        format: ImageManipulator.SaveFormat.JPEG,
      });
      const permanent = await persistPhoto(result.uri);
      setP((x) => ({ ...x, photos: x.photos.map((v, i) => i === idx ? permanent : v) }));
      setEditingPhotoIndex(null);
      setSelectedPhoto(null);
      toast(action === "rotate" ? "Photo rotated." : "Photo cropped.", "success");
    } catch (e: any) {
      toast(e?.message || "Could not edit photo.", "error");
    } finally {
      setPhotoBusy(false);
    }
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
                <Pressable style={{ flex: 1 }} onPress={() => { setSelectedPhoto(uri); setEditingPhotoIndex(idx); }} testID={`open-patient-photo-${idx}`}>
                  <Image source={{ uri }} style={styles.photoThumb} resizeMode="cover" />
                </Pressable>
                <Pressable style={styles.photoRemove} onPress={() => removePhoto(idx)} hitSlop={8} testID={`remove-photo-${idx}`}>
                  <Ionicons name="close" size={16} color="#FFFFFF" />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        )}

        <Modal visible={editingPhotoIndex !== null} transparent animationType="slide" onRequestClose={() => setEditingPhotoIndex(null)}>
          <View style={styles.photoEditOverlay}>
            <View style={styles.photoEditCard}>
              <Text style={styles.section}>Edit Patient Photo</Text>
              {editingPhotoIndex !== null && p.photos[editingPhotoIndex] ? (
                <Image source={{ uri: p.photos[editingPhotoIndex] }} style={styles.photoEditPreview} resizeMode="contain" />
              ) : null}
              <View style={styles.photoEditActions}>
                <Pressable style={styles.secondary} disabled={photoBusy} onPress={() => editingPhotoIndex !== null && editPhoto(editingPhotoIndex, "rotate")}>
                  <Ionicons name="refresh-outline" size={19} color={colors.onSurface} />
                  <Text style={styles.secondaryText}>Rotate 90°</Text>
                </Pressable>
                <Pressable style={styles.secondary} disabled={photoBusy} onPress={() => editingPhotoIndex !== null && editPhoto(editingPhotoIndex, "crop")}>
                  <Ionicons name="crop-outline" size={19} color={colors.onSurface} />
                  <Text style={styles.secondaryText}>Crop Square</Text>
                </Pressable>
              </View>
              <Pressable style={styles.photoEditClose} onPress={() => setEditingPhotoIndex(null)}>
                <Text style={styles.secondaryText}>Close</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
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
        <Text style={styles.section}>Inventory Items Used</Text>
        <Field
          label="Search inventory"
          testID="patient-inventory-search"
          value={implantSearch}
          onChangeText={setImplantSearch}
          placeholder="Search category, item or size"
        />
        {!!implantSearch.trim() && (
          <View style={styles.inventoryPicker}>
            {(inventory ?? [])
              .filter(x => {
                const q = implantSearch.trim().toLowerCase();
                return [x.category,x.name,x.size].some(v => String(v || "").toLowerCase().includes(q));
              })
              .slice(0, 20)
              .map(x => (
                <Pressable key={x.id} style={styles.inventoryOption} onPress={() => addImplant(x)}>
                  <Text style={styles.inventoryOptionTitle} numberOfLines={2}>
                    {[x.category, x.name, x.size].filter(Boolean).join(" · ")}
                  </Text>
                  <Text style={styles.inventoryOptionDetail}>{x.quantity} {x.quantity === 1 ? "available" : "available"}</Text>
                </Pressable>
              ))}
          </View>
        )}
        {selectedImplants.length > 0 ? (
          <View style={styles.selectedInventory}>
            {selectedImplants.map((x) => (
              <View key={x.id} style={styles.selectedInventoryRow}>
                <View style={{flex:1}}>
                  <Text style={styles.selectedInventoryTitle} numberOfLines={2}>
                    {[x.category, x.name, x.size].filter(Boolean).join(" · ")}
                  </Text>
                  <Text style={styles.selectedInventoryDetail}>Selected separately · Qty {x.quantity}</Text>
                </View>
                <Pressable style={styles.qtyButton} onPress={() => changeImplantQty(x.id,-1)}>
                  <Ionicons name="remove" size={17} color={colors.onSurface} />
                </Pressable>
                <Text style={styles.selectedQty}>{x.quantity}</Text>
                <Pressable style={styles.qtyButton} onPress={() => changeImplantQty(x.id,1)}>
                  <Ionicons name="add" size={17} color={colors.onSurface} />
                </Pressable>
                <Pressable style={styles.removeSelected} onPress={() => removeImplant(x.id)}>
                  <Ionicons name="trash-outline" size={18} color={colors.error} />
                </Pressable>
              </View>
            ))}
          </View>
        ) : (
          <Text style={styles.hint}>Select one or more inventory items. Each category, item and size is kept separately.</Text>
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
  photoEditOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.72)", justifyContent: "center", padding: spacing.lg },
  photoEditCard: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.lg, maxHeight: "90%" },
  photoEditPreview: { width: "100%", height: 300, borderRadius: radius.md, backgroundColor: colors.surfaceSecondary, marginBottom: spacing.md },
  photoEditActions: { flexDirection: "row", gap: spacing.sm },
  photoEditClose: { alignItems: "center", paddingVertical: spacing.md, marginTop: spacing.sm },
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
  inventoryPicker: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surfaceSecondary, marginTop: -spacing.md, marginBottom: spacing.md, overflow: "hidden" },
  inventoryOption: { paddingHorizontal: spacing.md, paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.divider },
  inventoryOptionTitle: { fontFamily: fontFamily.semibold, fontSize: fontSize.base, color: colors.onSurface },
  inventoryOptionDetail: { fontFamily: fontFamily.regular, fontSize: fontSize.sm, color: colors.muted, marginTop: 3 },
  selectedInventory: { gap: spacing.sm, marginBottom: spacing.md },
  selectedInventoryRow: { flexDirection:"row", alignItems:"center", gap:spacing.xs, padding:spacing.md, borderWidth:1, borderColor:colors.border, borderRadius:radius.md, backgroundColor:colors.surfaceSecondary },
  selectedInventoryTitle: { fontFamily:fontFamily.semibold, fontSize:fontSize.sm, color:colors.onSurface },
  selectedInventoryDetail: { fontFamily:fontFamily.regular, fontSize:fontSize.xs, color:colors.muted, marginTop:3 },
  qtyButton: { width:32, height:32, borderRadius:16, borderWidth:1, borderColor:colors.border, alignItems:"center", justifyContent:"center" },
  selectedQty: { minWidth:22, textAlign:"center", fontFamily:fontFamily.bold, color:colors.onSurface },
  removeSelected: { width:32, height:32, alignItems:"center", justifyContent:"center" },
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
