import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import Ionicons from "@react-native-vector-icons/ionicons";
import { router } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/src/api/client";
import { useAuth } from "@/src/auth/AuthContext";
import { useToast } from "@/src/components/toast";
import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";

type ImportedPatient = {
  mrNo?: string; mr_no?: string; name?: string; patientName?: string;
  gender?: string; age?: string; diagnosis?: string; procedure?: string; procedures?: string;
  procedureII?: string; procedure_ii?: string; implant?: string; implantII?: string; implant_ii?: string;
  address?: string; fileName?: string; file_name?: string; date?: string; entryDate?: string;
  sourceSerialNumber?: string; sNo?: string; serialNumber?: string;
};
type ImportResult = { imported: number; skippedDuplicates: number; skippedInvalid: number };

export default function PatientImportScreen() {
  const { user } = useAuth();
  const { colors } = useTheme();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [fileName, setFileName] = useState("");
  const [patients, setPatients] = useState<ImportedPatient[]>([]);
  const [importing, setImporting] = useState(false);
  const [summary, setSummary] = useState<ImportResult | null>(null);

  const chooseFile = async () => {
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        type: ["application/json", "text/json", "text/plain"],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (picked.canceled || !picked.assets?.[0]) return;
      const asset = picked.assets[0];
      if (!/\\.(json|txt)$/i.test(asset.name || "")) {
        toast("Choose the prepared .json patient-import file. Do not select the source PDF here.", "error");
        return;
      }
      const raw = await FileSystem.readAsStringAsync(asset.uri);
      if (raw.length > 30_000_000) throw new Error("Import file is too large for this screen.");
      const payload = JSON.parse(raw);
      const list = Array.isArray(payload) ? payload : payload?.patients;
      if (!Array.isArray(list) || !list.length) throw new Error("This file has no patients array.");
      if (list.length > 10000) throw new Error("Import files may contain at most 10,000 rows.");
      setFileName(asset.name || "patient-import.json");
      setPatients(list as ImportedPatient[]);
      setSummary(null);
      toast(`Loaded ${list.length} historical patient rows. Review the count, then import.`, "success");
    } catch (error: any) {
      toast(String(error?.message || "Could not read this JSON file.").slice(0, 220), "error");
    }
  };

  const importPatients = async () => {
    if (!patients.length || importing) return;
    setImporting(true);
    try {
      const result = await api.post<ImportResult>("/patients/import-bulk", { patients });
      setSummary(result);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["patients"] }),
        queryClient.invalidateQueries({ queryKey: ["stats"] }),
        queryClient.invalidateQueries({ queryKey: ["patients-detail"] }),
      ]);
      toast(`Import complete: ${result.imported} added, ${result.skippedDuplicates} duplicates skipped, ${result.skippedInvalid} invalid rows skipped. Inventory was not changed.`, "success");
    } catch (error: any) {
      toast(String(error?.message || "Patient import failed. Existing data was not intentionally changed.").slice(0, 220), "error");
    } finally {
      setImporting(false);
    }
  };

  if (user?.role !== "admin") {
    return <View style={[styles.container, { justifyContent: "center", padding: spacing.xl }]}><Text style={styles.title}>Administrator only</Text></View>;
  }

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={() => router.back()} style={styles.back}>
          <Ionicons name="arrow-back" size={22} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.title}>Import Historical Patients</Text>
        <View style={styles.back} />
      </View>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + spacing.xxl }}>
        <View style={styles.note}>
          <Ionicons name="shield-checkmark-outline" size={23} color={colors.brandPrimary} />
          <Text style={styles.noteText}>This import only adds patient records and patient-history entries. It does not deduct implants, create stock, or change inventory. Exact matching rows are skipped, so running the same file again will not create duplicates or overwrite existing patients.</Text>
        </View>
        <Text style={styles.section}>Prepare the file</Text>
        <Text style={styles.help}>Select the prepared JSON export made from your 2026 PDF. Its original dates are read as DD/MM/YYYY during conversion and saved in the app's ISO date format only after strict calendar validation. This screen deliberately imports JSON, not the PDF itself, so table columns and dates are not guessed on your phone.</Text>
        <Pressable onPress={chooseFile} disabled={importing} style={styles.button}>
          <Ionicons name="document-attach-outline" size={21} color={colors.brandPrimary} />
          <Text style={styles.buttonText}>Choose patient JSON file</Text>
        </Pressable>
        {fileName ? (
          <View style={styles.fileCard}>
            <Ionicons name="document-text-outline" size={25} color={colors.brandPrimary} />
            <View style={{ flex: 1 }}>
              <Text style={styles.fileName}>{fileName}</Text>
              <Text style={styles.help}>{patients.length} rows ready for review</Text>
            </View>
            <Pressable onPress={() => { setFileName(""); setPatients([]); setSummary(null); }} disabled={importing}>
              <Ionicons name="close-circle-outline" size={23} color={colors.muted} />
            </Pressable>
          </View>
        ) : null}
        {patients.length ? <>
          <Text style={styles.section}>Before importing</Text>
          <Text style={styles.help}>The prepared file contains {patients.length} rows. Historical procedure, implant text, address, file name, age, gender and entry date are kept in the patient record. No photos, patient identities outside the file, or inventory records are added.</Text>
          <Pressable onPress={importPatients} disabled={importing} style={[styles.primary, importing && { opacity: 0.65 }]}>
            {importing ? <ActivityIndicator color={colors.onBrandPrimary} /> : <Ionicons name="cloud-download-outline" size={21} color={colors.onBrandPrimary} />}
            <Text style={styles.primaryText}>{importing ? "Importing safely…" : `Import ${patients.length} patient rows`}</Text>
          </Pressable>
        </> : null}
        {summary ? (
          <View style={styles.resultCard}>
            <Text style={styles.resultTitle}>Import finished</Text>
            <Text style={styles.resultText}>Added: {summary.imported}</Text>
            <Text style={styles.resultText}>Existing / repeated rows skipped: {summary.skippedDuplicates}</Text>
            <Text style={styles.resultText}>Invalid rows skipped: {summary.skippedInvalid}</Text>
            <Text style={styles.help}>The source file is not auto-imported on a future install. Keep the JSON as your separate source backup. If the same rows already exist, they are skipped.</Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles(colors => ({
  container: { flex: 1, backgroundColor: colors.surfaceSecondary },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.md, paddingBottom: spacing.md, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
  back: { width: 36, height: 40, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, textAlign: "center", fontFamily: fontFamily.bold, fontSize: fontSize.lg, color: colors.onSurface },
  note: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm, padding: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surface, marginBottom: spacing.lg },
  noteText: { flex: 1, color: colors.onSurface, fontFamily: fontFamily.regular, fontSize: fontSize.sm, lineHeight: 20 },
  section: { fontFamily: fontFamily.semibold, fontSize: fontSize.base, color: colors.onSurface, marginTop: spacing.md, marginBottom: spacing.sm },
  help: { fontFamily: fontFamily.regular, fontSize: fontSize.sm, color: colors.muted, marginBottom: spacing.md, lineHeight: 20 },
  button: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: spacing.sm, padding: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surface },
  buttonText: { color: colors.brandPrimary, fontFamily: fontFamily.semibold, fontSize: fontSize.base },
  fileCard: { flexDirection: "row", alignItems: "center", gap: spacing.md, padding: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surface, marginTop: spacing.md },
  fileName: { color: colors.onSurface, fontFamily: fontFamily.semibold, fontSize: fontSize.base },
  primary: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: spacing.sm, padding: spacing.md, backgroundColor: colors.brandPrimary, borderRadius: radius.md, marginTop: spacing.sm },
  primaryText: { color: colors.onBrandPrimary, fontFamily: fontFamily.semibold, fontSize: fontSize.base },
  resultCard: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, backgroundColor: colors.surface, marginTop: spacing.lg },
  resultTitle: { color: colors.onSurface, fontFamily: fontFamily.bold, fontSize: fontSize.lg, marginBottom: spacing.sm },
  resultText: { color: colors.onSurface, fontFamily: fontFamily.medium, fontSize: fontSize.base, marginBottom: spacing.xs },
}));
