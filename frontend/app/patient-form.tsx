import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import { Asset, requestPermissionsAsync } from "expo-media-library";
import * as FileSystem from "expo-file-system/legacy";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Image, InteractionManager, Modal, Pressable, ScrollView, Text, View } from "react-native";
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
import { formatInventoryLabel } from "@/src/utils/inventory-label";
import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";

type Patient = {
  id: string; mrNo: string; name: string; gender: string; age: string;
  diagnosis: string; procedure: string; implant: string; implantII: string; implants?: SelectedImplant[];
  address: string; fileName: string; photoUri: string; photos: string[]; date: string;
  operationCount?: number; totalOperations?: number; customData?: Record<string,string>;
  hcvPlus?: boolean; hbaSg?: boolean; hiv?: boolean;
};
type Procedure = { id: string; name: string };
type InventoryItem = { id: string; name: string; category: string; categoryId?: string; size: string; quantity: number };
type SelectedImplant = { id: string; inventoryId: string; name: string; category: string; size: string; quantity: number };

const today = () => new Date().toISOString().slice(0, 10);
const empty = (): Patient => ({
  id: "", mrNo: "", name: "", gender: "", age: "", diagnosis: "",
  procedure: "", implant: "", implantII: "", address: "", fileName: "",
  photoUri: "", photos: [], date: today(), implants: [], customData: {},
  hcvPlus: false, hbaSg: false, hiv: false,
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
  const { data: customFields = [] } = useQuery<any[]>({
    queryKey: ["patient-custom-fields"],
    queryFn: () => api.get("/patient-custom-fields"),
  });
  const { data: inventory = [] } = useQuery<InventoryItem[]>({
    queryKey: ["inventory", "patient-search", implantSearch.trim().toLowerCase()],
    queryFn: () => api.get("/inventory?q=" + encodeURIComponent(implantSearch.trim())),
    enabled: implantSearch.trim().length > 0,
    staleTime: 10000,
  });
  const existing = useMemo(() => (id ? patients?.find((p) => p.id === id) : undefined), [id, patients]);
  const { data: detailedExisting } = useQuery<Patient | null>({
    queryKey: ["patient-detail", id],
    queryFn: () => api.get("/patients/" + encodeURIComponent(String(id))),
    enabled: isEdit && !!id,
  });

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
  const [editingPhotoOriginal, setEditingPhotoOriginal] = useState<string | null>(null);
  const [editingPhotoUri, setEditingPhotoUri] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [imagePickerReady, setImagePickerReady] = useState(false);
  const imagePickerOpening = useRef(false);
  const imagePickerReadyRef = useRef(false);
  const appStateRef = useRef(AppState.currentState);
  const [cropScale, setCropScale] = useState(0.78);
  const [cropX, setCropX] = useState(0.5);
  const [cropY, setCropY] = useState(0.5);
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
  useEffect(() => {
    const source = isEdit ? detailedExisting : existing;
    if (!source) return;
    // Normalise legacy records that only had photoUri.
    const photos = Array.isArray(source.photos) && source.photos.length
      ? source.photos
      : source.photoUri ? [source.photoUri] : [];
    setP({ ...source, photos, customData: source.customData || {} });
    setReady(true);
  }, [isEdit, detailedExisting, existing]);

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

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      appStateRef.current = nextState;
      if (nextState !== "active") {
        imagePickerReadyRef.current = false;
        setImagePickerReady(false);
        return;
      }
      // Wait until Android has resumed the host Activity before allowing a
      // native picker launch after a permission dialog or app switch.
      setTimeout(() => {
        if (appStateRef.current === "active") {
          imagePickerReadyRef.current = true;
          setImagePickerReady(true);
        }
      }, 800);
    });
    return () => subscription.remove();
  }, []);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      imagePickerReadyRef.current = false;
      setImagePickerReady(false);

      const timer = setTimeout(() => {
        if (!cancelled && appStateRef.current === "active") {
          imagePickerReadyRef.current = true;
          setImagePickerReady(true);
        }
      }, 800);
      return () => {
        cancelled = true;
        clearTimeout(timer);
        imagePickerOpening.current = false;
        imagePickerReadyRef.current = false;
        setImagePickerReady(false);
      };
    }, []),
  );

  async function waitForImagePickerActivity() {
    // Read refs, not React state captured by an old async closure. The old
    // implementation could retry immediately or wait forever after a state
    // update because it read a stale imagePickerReady value.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (appStateRef.current === "active" && imagePickerReadyRef.current) return true;
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
    }
    return false;
  }

  async function rearmImagePickerAfterLauncherError() {
    imagePickerReadyRef.current = false;
    setImagePickerReady(false);
    // Let Android finish ActivityResultRegistry lifecycle restoration before
    // retrying. Only re-arm when the app is genuinely active again.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (appStateRef.current === "active") {
        await new Promise<void>((resolve) => setTimeout(resolve, 900));
        if (appStateRef.current === "active") {
          imagePickerReadyRef.current = true;
          setImagePickerReady(true);
          return true;
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
    }
    return false;
  }

  const isUnregisteredLauncherError = (error: any) => {
    const message = String(error?.message || error || "").toLowerCase();
    return message.includes("unregistered activityresult launcher") ||
      message.includes("must ensure the activityresult launcher is registered");
  };

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
    if (req.granted) {
      // Permission prompts can pause/recreate the Android Activity and leave
      // the camera launcher unregistered for the remainder of that tap.
      // Ask the user to tap Camera again after the permission flow has ended.
      toast("Camera permission granted. Tap Camera again to take the photo.", "info");
    }
    return false;
  }

  // Keep a private, permanent copy inside the app. Gallery/camera URIs can
  // point to temporary cache/content-provider locations that stop working later.
  // We copy/normalize every newly added photo immediately so the saved patient
  // record never depends on the gallery app or a temporary URI.
  const persistPhoto = async (sourceUri: string) => {
    if (!sourceUri || sourceUri.startsWith("data:")) return sourceUri;
    const directory = `${FileSystem.documentDirectory}patient-photos/`;
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true }).catch(() => {});
    // Keep patient photos sharp enough for clinical reference, while avoiding
    // full-resolution camera files bloating the offline database and Drive backups.
    const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
      Image.getSize(sourceUri, (width, height) => resolve({ width, height }), reject);
    });
    const actions: any[] = [];
    if (dimensions.width > 1600 || dimensions.height > 1600) {
      actions.push(dimensions.width >= dimensions.height
        ? { resize: { width: 1600 } }
        : { resize: { height: 1600 } });
    }
    const normalized = await ImageManipulator.manipulateAsync(
      sourceUri,
      actions,
      { compress: 0.68, format: ImageManipulator.SaveFormat.JPEG },
    );
    const filename = `patient-photo-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.jpg`;
    const destination = `${directory}${filename}`;
    await FileSystem.copyAsync({ from: normalized.uri, to: destination });
    return destination;
  };

  // No cropping (allowsEditing:false). Library allows multi-select.
  const addFromLibrary = async () => {
    if (!imagePickerReady || imagePickerOpening.current) return;
    imagePickerOpening.current = true;
    try {
      await new Promise<void>((resolve) => InteractionManager.runAfterInteractions(() => setTimeout(resolve, 120)));
      if (!(await waitForImagePickerActivity())) {
        toast("Photo picker is still starting. Please try again in a moment.", "error");
        return;
      }

      let result: ImagePicker.ImagePickerResult;
      try {
        result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ["images"], allowsEditing: false, allowsMultipleSelection: true,
          selectionLimit: 20, quality: 0.9,
        });
      } catch (firstError: any) {
        // Android can recreate the Activity while the JS screen is still
        // mounted. In that narrow window Expo's launcher is temporarily
        // unregistered. Re-arm the screen and retry once after the Activity
        // has had time to register the launcher again.
        if (!isUnregisteredLauncherError(firstError)) throw firstError;
        if (!(await rearmImagePickerAfterLauncherError())) {
          throw firstError;
        }
        result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ["images"], allowsEditing: false, allowsMultipleSelection: true,
          selectionLimit: 20, quality: 0.9,
        });
      }
      if (result.canceled) return;
      const permanentUris: string[] = [];
      for (const uri of result.assets.map((x) => x.uri).filter(Boolean)) permanentUris.push(await persistPhoto(uri));
      setP((x) => ({ ...x, photos: [...x.photos, ...permanentUris] }));
    } catch (e: any) { toast(e?.message || "Could not save the selected photo.", "error"); }
    finally { imagePickerOpening.current = false; }
  };

  const addFromCamera = async () => {
    if (!imagePickerReady || imagePickerOpening.current) return;
    if (!(await ensureCameraPermission())) return;
    imagePickerOpening.current = true;
    try {
      if (!(await waitForImagePickerActivity())) {
        toast("Camera is still starting. Please try again in a moment.", "error");
        return;
      }
      let result: ImagePicker.ImagePickerResult;
      try {
        result = await ImagePicker.launchCameraAsync({
          allowsEditing: false,
          quality: 0.9,
        });
      } catch (firstError: any) {
        if (!isUnregisteredLauncherError(firstError)) throw firstError;
        if (!(await rearmImagePickerAfterLauncherError())) throw firstError;
        result = await ImagePicker.launchCameraAsync({
          allowsEditing: false,
          quality: 0.9,
        });
      }
      if (result.canceled) return;
      const uri = result.assets[0]?.uri;
      if (uri) {
        const permanentUri = await persistPhoto(uri);
        setP((x) => ({ ...x, photos: [...x.photos, permanentUri] }));
      }
    } catch (e: any) {
      toast(e?.message || "Could not save the camera photo.", "error");
    } finally {
      imagePickerOpening.current = false;
    }
  };

  const savePhotoToDevice = async (uri: string) => {
    if (!uri) return;
    setPhotoBusy(true);
    try {
      let localUri = uri;
      if (uri.startsWith("data:image/")) {
        const match = uri.match(/^data:image\/[^;]+;base64,(.+)$/);
        if (!match?.[1]) throw new Error("Invalid patient photo.");
        const directory = `${FileSystem.cacheDirectory}patient-photo-export/`;
        await FileSystem.makeDirectoryAsync(directory, { intermediates: true }).catch(() => {});
        localUri = `${directory}patient-photo-${Date.now()}.jpg`;
        await FileSystem.writeAsStringAsync(localUri, match[1], { encoding: FileSystem.EncodingType.Base64 });
      }
      const permission = await requestPermissionsAsync(true, ["photo"]);
      if (!permission.granted) {
        toast("Photo permission is required to save the picture to your device.", "error");
        return;
      }
      await Asset.create(localUri);
      toast("Patient photo saved to your device.", "success");
    } catch (e: any) {
      toast(e?.message || "Could not save the patient photo.", "error");
    } finally {
      setPhotoBusy(false);
    }
  };

  const removePhoto = (idx: number) => {
    setP((x) => ({ ...x, photos: x.photos.filter((_, i) => i !== idx) }));
  };
  const openPhotoEditor = (idx: number) => {
    const uri = p.photos[idx];
    if (!uri) return;
    setSelectedPhoto(null);
    setEditingPhotoIndex(idx);
    setEditingPhotoOriginal(uri);
    setEditingPhotoUri(uri);
    setCropScale(0.78);
    setCropX(0.5);
    setCropY(0.5);
  };

  const closePhotoEditor = () => {
    if (photoBusy) return;
    setEditingPhotoIndex(null);
    setEditingPhotoOriginal(null);
    setEditingPhotoUri(null);
    setCropScale(0.78);
    setCropX(0.5);
    setCropY(0.5);
  };

  const editPhoto = async (action: "rotate" | "crop") => {
    if (!editingPhotoUri) return;
    setPhotoBusy(true);
    try {
      let actions: any[] = [];
      if (action === "rotate") {
        actions = [{ rotate: 90 }];
      } else {
        const size = await new Promise<{ width: number; height: number }>((resolve, reject) =>
          Image.getSize(editingPhotoUri, (width, height) => resolve({ width, height }), reject),
        );
        const side = Math.max(1, Math.round(Math.min(size.width, size.height) * cropScale));
        const maxX = Math.max(0, size.width - side);
        const maxY = Math.max(0, size.height - side);
        actions = [{
          crop: {
            originX: Math.max(0, Math.min(maxX, Math.round(maxX * cropX))),
            originY: Math.max(0, Math.min(maxY, Math.round(maxY * cropY))),
            width: side,
            height: side,
          },
        }];
      }
      const result = await ImageManipulator.manipulateAsync(editingPhotoUri, actions, {
        compress: 0.9,
        format: ImageManipulator.SaveFormat.JPEG,
      });
      setEditingPhotoUri(result.uri);
      if (action === "crop") {
        setCropScale(0.78);
        setCropX(0.5);
        setCropY(0.5);
      }
    } catch (e: any) {
      toast(e?.message || "Could not edit photo.", "error");
    } finally {
      setPhotoBusy(false);
    }
  };

  const resetPhotoEdits = () => {
    if (photoBusy || !editingPhotoOriginal) return;
    setEditingPhotoUri(editingPhotoOriginal);
    setCropScale(0.78);
    setCropX(0.5);
    setCropY(0.5);
  };

  const savePhotoEdits = async () => {
    if (editingPhotoIndex === null || !editingPhotoUri) return;
    setPhotoBusy(true);
    try {
      const permanent = await persistPhoto(editingPhotoUri);
      setP((x) => ({
        ...x,
        photos: x.photos.map((v, i) => i === editingPhotoIndex ? permanent : v),
      }));
      toast("Photo changes saved.", "success");
      closePhotoEditor();
    } catch (e: any) {
      toast(e?.message || "Could not save photo changes.", "error");
    } finally {
      setPhotoBusy(false);
    }
  };

  const save = useMutation({
    mutationFn: () => {
      const customData = {
        ...(p.customData || {}),
        hcvPlus: p.hcvPlus ? "true" : "false",
        hbaSg: p.hbaSg ? "true" : "false",
        hiv: p.hiv ? "true" : "false",
      };
      const payload = { ...p, customData };
      return isEdit ? api.put("/patients/" + id, payload) : api.post("/patients", payload);
    },
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
          <PrimaryButton title={`Add from Gallery${p.photos.length ? " (+)" : ""}`} onPress={addFromLibrary} disabled={!imagePickerReady || photoBusy} testID="add-photo-library-button" />
          <Pressable style={[styles.secondary, (!imagePickerReady || photoBusy) && { opacity: 0.5 }]} onPress={addFromCamera} disabled={!imagePickerReady || photoBusy} testID="add-photo-camera-button">
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

        <Modal visible={editingPhotoIndex !== null} transparent animationType="fade" onRequestClose={closePhotoEditor}>
          <View style={styles.photoEditOverlay}>
            <View style={styles.photoEditCard}>
              <View style={styles.photoEditHeader}>
                <View>
                  <Text style={styles.photoEditTitle}>Edit Patient Photo</Text>
                  <Text style={styles.photoEditHint}>Rotate or crop, then save when you are satisfied.</Text>
                </View>
                <Pressable onPress={closePhotoEditor} disabled={photoBusy} style={styles.photoEditIconButton}>
                  <Ionicons name="close" size={22} color={colors.onSurface} />
                </Pressable>
              </View>

              <View style={styles.photoEditPreviewWrap}>
                {editingPhotoUri ? (
                  <Image source={{ uri: editingPhotoUri }} style={styles.photoEditPreview} resizeMode="contain" />
                ) : null}
              </View>

              <View style={styles.cropControls}>
                <View style={styles.cropControlHeader}>
                  <View>
                    <Text style={styles.cropTitle}>Crop area</Text>
                    <Text style={styles.cropHint}>Adjust the frame, position it, then apply crop.</Text>
                  </View>
                  <Text style={styles.cropValue}>{Math.round(cropScale * 100)}%</Text>
                </View>
                <View style={styles.cropSizeRow}>
                  <Pressable style={styles.cropCircleButton} disabled={photoBusy} onPress={() => setCropScale(v => Math.max(0.45, Number((v - 0.08).toFixed(2))))}>
                    <Ionicons name="remove" size={20} color={colors.onSurface} />
                  </Pressable>
                  <View style={styles.cropTrack}><View style={[styles.cropTrackFill, { width: `${Math.round(((cropScale - 0.45) / 0.45) * 100)}%` }]} /></View>
                  <Pressable style={styles.cropCircleButton} disabled={photoBusy} onPress={() => setCropScale(v => Math.min(0.9, Number((v + 0.08).toFixed(2))))}>
                    <Ionicons name="add" size={20} color={colors.onSurface} />
                  </Pressable>
                </View>
                <View style={styles.cropPosition}>
                  <Pressable style={styles.cropArrow} disabled={photoBusy} onPress={() => setCropY(v => Math.max(0, Number((v - 0.08).toFixed(2))))}><Ionicons name="chevron-up" size={20} color={colors.onSurface} /></Pressable>
                  <View style={styles.cropMiddle}>
                    <Pressable style={styles.cropArrow} disabled={photoBusy} onPress={() => setCropX(v => Math.max(0, Number((v - 0.08).toFixed(2))))}><Ionicons name="chevron-back" size={20} color={colors.onSurface} /></Pressable>
                    <View style={styles.cropCenter}><Ionicons name="scan-outline" size={18} color={colors.muted} /></View>
                    <Pressable style={styles.cropArrow} disabled={photoBusy} onPress={() => setCropX(v => Math.min(1, Number((v + 0.08).toFixed(2))))}><Ionicons name="chevron-forward" size={20} color={colors.onSurface} /></Pressable>
                  </View>
                  <Pressable style={styles.cropArrow} disabled={photoBusy} onPress={() => setCropY(v => Math.min(1, Number((v + 0.08).toFixed(2))))}><Ionicons name="chevron-down" size={20} color={colors.onSurface} /></Pressable>
                </View>
              </View>

              <View style={styles.photoEditActions}>
                <Pressable style={styles.photoTool} disabled={photoBusy} onPress={() => editPhoto("rotate")}>
                  <Ionicons name="refresh-outline" size={20} color={colors.onSurface} />
                  <Text style={styles.photoToolText}>Rotate 90°</Text>
                </Pressable>
                <Pressable style={styles.photoTool} disabled={photoBusy} onPress={() => editPhoto("crop")}>
                  <Ionicons name="crop-outline" size={20} color={colors.onSurface} />
                  <Text style={styles.photoToolText}>Apply Crop</Text>
                </Pressable>
                <Pressable style={styles.photoTool} disabled={photoBusy} onPress={resetPhotoEdits}>
                  <Ionicons name="refresh-circle-outline" size={20} color={colors.onSurface} />
                  <Text style={styles.photoToolText}>Reset</Text>
                </Pressable>
              </View>

              <View style={styles.photoEditFooter}>
                <Pressable style={styles.photoCancelButton} disabled={photoBusy} onPress={closePhotoEditor}>
                  <Text style={styles.photoCancelText}>Cancel</Text>
                </Pressable>
                <Pressable style={styles.photoSaveButton} disabled={photoBusy} onPress={savePhotoEdits}>
                  <Ionicons name="checkmark" size={19} color={colors.onBrandPrimary} />
                  <Text style={styles.photoSaveText}>{photoBusy ? "Working…" : "Save changes"}</Text>
                </Pressable>
              </View>
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

        <Text style={styles.section}>Infection Screening</Text>
        {([
          ["hcvPlus", "HCV+"],
          ["hbaSg", "HbAsg"],
          ["hiv", "HIV"],
        ] as const).map(([key, label]) => (
          <Pressable
            key={key}
            onPress={() => setP(prev => ({ ...prev, [key]: !prev[key] }))}
            style={styles.screeningRow}
            testID={"patient-screening-" + key}
          >
            <Ionicons
              name={p[key] ? "checkbox" : "square-outline"}
              size={22}
              color={p[key] ? colors.brandPrimary : colors.muted}
            />
            <Text style={styles.screeningText}>{label}</Text>
          </Pressable>
        ))}

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
                    {formatInventoryLabel(x.category, x.name, x.size)}
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
        {!!customFields.length && (
          <>
            <Text style={styles.section}>Additional Patient Fields</Text>
            {customFields.map((f:any) => {
              const value=String((p.customData || {})[f.key] || "");
              const update=(v:string)=>setP(prev=>({ ...prev, customData:{ ...(prev.customData || {}), [f.key]:v } }));
              return (
                <Field
                  key={f.id}
                  label={f.label}
                  value={value}
                  onChangeText={update}
                  placeholder={f.type === "date" ? "YYYY-MM-DD" : f.label}
                  keyboardType={f.type === "number" ? "numeric" : "default"}
                  multiline={f.type === "multiline"}
                  textAlignVertical={f.type === "multiline" ? "top" : "center"}
                  style={f.type === "multiline" ? { minHeight: 100 } : undefined}
                  testID={"patient-custom-field-" + f.id}
                />
              );
            })}
          </>
        )}
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
          {!!selectedPhoto && (
            <View style={styles.photoViewerToolbar}>
              <Pressable style={styles.photoViewerAction} onPress={() => selectedPhoto && savePhotoToDevice(selectedPhoto)} disabled={photoBusy}>
                <Ionicons name="download-outline" size={19} color="#FFFFFF" />
                <Text style={styles.photoViewerActionText}>{photoBusy ? "Saving..." : "Save to device"}</Text>
              </Pressable>
              <Pressable style={styles.photoViewerAction} onPress={() => {
                const idx = p.photos.indexOf(selectedPhoto);
                if (idx >= 0) { setSelectedPhoto(null); openPhotoEditor(idx); }
              }}>
                <Ionicons name="create-outline" size={19} color="#FFFFFF" />
                <Text style={styles.photoViewerActionText}>Edit photo</Text>
              </Pressable>
              <Pressable style={styles.photoViewerAction} onPress={() => setSelectedPhoto(null)}>
                <Ionicons name="checkmark" size={19} color="#FFFFFF" />
                <Text style={styles.photoViewerActionText}>Done</Text>
              </Pressable>
            </View>
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
  screeningRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: spacing.sm, marginBottom: spacing.xs },
  screeningText: { fontFamily: fontFamily.medium, fontSize: fontSize.base, color: colors.onSurface },
  photoActions: { flexDirection: "row", gap: spacing.md, marginBottom: spacing.md, alignItems: "center", flexWrap: "wrap" },
  secondary: { flexDirection: "row", alignItems: "center", height: 48, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: spacing.md, justifyContent: "center" },
  secondaryText: { fontFamily: fontFamily.semibold, color: colors.onSurface },
  cropControls: { backgroundColor: colors.surfaceSecondary, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: spacing.md, marginBottom: spacing.md },
  cropControlHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.sm },
  cropTitle: { fontFamily: fontFamily.semibold, fontSize: fontSize.sm, color: colors.onSurface },
  cropHint: { fontFamily: fontFamily.regular, fontSize: fontSize.xs, color: colors.muted, marginTop: 2 },
  cropValue: { fontFamily: fontFamily.bold, fontSize: fontSize.sm, color: colors.brandPrimary },
  cropSizeRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  cropCircleButton: { width: 38, height: 38, borderRadius: 19, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" },
  cropTrack: { flex: 1, height: 6, borderRadius: 3, backgroundColor: colors.border, overflow: "hidden" },
  cropTrackFill: { height: "100%", backgroundColor: colors.brandPrimary, borderRadius: 3 },
  cropPosition: { alignItems: "center", marginTop: spacing.sm },
  cropMiddle: { flexDirection: "row", alignItems: "center", gap: spacing.lg },
  cropArrow: { width: 38, height: 38, borderRadius: 19, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" },
  cropCenter: { width: 44, height: 44, borderRadius: 10, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface },
  photoViewerToolbar: { position: "absolute", bottom: 32, left: 20, right: 20, flexDirection: "row", justifyContent: "center", gap: spacing.sm },
  photoViewerAction: { minWidth: 120, height: 46, borderRadius: 23, paddingHorizontal: spacing.md, backgroundColor: "rgba(0,0,0,0.68)", borderWidth: 1, borderColor: "rgba(255,255,255,0.25)", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.xs },
  photoViewerActionText: { fontFamily: fontFamily.semibold, color: "#FFFFFF", fontSize: fontSize.sm },
  photoEditOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.72)", justifyContent: "center", padding: spacing.lg },
  photoEditCard: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.lg, width: "100%", maxWidth: 520, maxHeight: "92%" },
  photoEditHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.md },
  photoEditTitle: { fontFamily: fontFamily.bold, fontSize: fontSize.lg, color: colors.onSurface },
  photoEditHint: { fontFamily: fontFamily.regular, fontSize: fontSize.xs, color: colors.muted, marginTop: 3, paddingRight: spacing.md },
  photoEditIconButton: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  photoEditPreviewWrap: { width: "100%", height: 360, borderRadius: radius.md, backgroundColor: "#111111", overflow: "hidden", marginBottom: spacing.md, alignItems: "center", justifyContent: "center" },
  photoEditPreview: { width: "100%", height: "100%" },
  photoEditActions: { flexDirection: "row", gap: spacing.sm, marginBottom: spacing.md },
  photoTool: { flex: 1, minHeight: 72, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSecondary, alignItems: "center", justifyContent: "center", gap: 5 },
  photoToolText: { fontFamily: fontFamily.semibold, fontSize: fontSize.xs, color: colors.onSurface },
  photoEditFooter: { flexDirection: "row", gap: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.md },
  photoCancelButton: { flex: 1, minHeight: 48, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  photoCancelText: { fontFamily: fontFamily.semibold, color: colors.onSurface },
  photoSaveButton: { flex: 1.5, minHeight: 48, borderRadius: radius.md, backgroundColor: colors.brandPrimary, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.xs },
  photoSaveText: { fontFamily: fontFamily.bold, color: colors.onBrandPrimary },
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
