import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  Text,
  View,
} from "react-native";
import Ionicons from "@react-native-vector-icons/ionicons";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api } from "@/src/api/client";
import { EmptyState } from "@/src/components/EmptyState";
import { Field } from "@/src/components/Field";
import { PrimaryButton } from "@/src/components/PrimaryButton";
import { useToast } from "@/src/components/toast";
import { usesNativeTabs } from "@/src/navigation";
import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";

type Procedure = { id: string; name: string };

export default function Procedures() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const queryClient = useQueryClient();
  const bottomChrome = usesNativeTabs ? insets.bottom : 0;

  const [modal, setModal] = useState(false);
  const [name, setName] = useState("");

  const { data, isLoading, isError, refetch, isRefetching } = useQuery<Procedure[]>({
    queryKey: ["procedures"],
    queryFn: () => api.get("/procedures"),
  });

  const add = useMutation({
    mutationFn: (n: string) => api.post("/procedures", { name: n }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["procedures"] });
      toast("Procedure added.", "success");
      setModal(false);
      setName("");
    },
    onError: (e: any) => toast(e?.message || "Could not add procedure.", "error"),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.del(`/procedures/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["procedures"] });
      toast("Procedure removed.", "success");
    },
    onError: (e: any) => toast(e?.message || "Could not remove.", "error"),
  });

  const onSubmit = () => {
    if (!name.trim()) {
      toast("Enter a procedure name.", "error");
      return;
    }
    add.mutate(name.trim());
  };

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Text style={styles.title}>Procedures</Text>
        <Pressable testID="add-procedure-button" style={styles.addBtn} onPress={() => setModal(true)}>
          <Ionicons name="add" size={20} color={colors.onBrandPrimary} />
          <Text style={styles.addBtnText}>Add</Text>
        </Pressable>
      </View>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.brandPrimary} />
        </View>
      ) : isError ? (
        <View style={styles.center}>
          <EmptyState icon="cloud-offline-outline" title="Failed to load" subtitle="Pull to retry." />
        </View>
      ) : (
        <FlatList
          data={data}
          keyExtractor={(i) => i.id}
          contentContainerStyle={{ padding: spacing.lg, paddingBottom: bottomChrome + spacing.xl, flexGrow: 1 }}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.brandPrimary} />
          }
          ListEmptyComponent={
            <EmptyState icon="medkit-outline" title="No procedures added" subtitle="Tap Add to create one." />
          }
          renderItem={({ item }) => (
            <View style={styles.row} testID={`procedure-row-${item.id}`}>
              <View style={styles.dot} />
              <Text style={styles.name}>{item.name}</Text>
              <Pressable testID={`procedure-delete-${item.id}`} hitSlop={8} onPress={() => del.mutate(item.id)}>
                <Ionicons name="trash-outline" size={18} color={colors.muted} />
              </Pressable>
            </View>
          )}
        />
      )}

      <Modal visible={modal} transparent animationType="slide" onRequestClose={() => setModal(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { paddingBottom: insets.bottom + spacing.lg }]}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Add Procedure</Text>
            <KeyboardAwareScrollView bottomOffset={40} keyboardShouldPersistTaps="handled">
              <Field
                label="Procedure Name"
                testID="procedure-name-input"
                value={name}
                onChangeText={setName}
                placeholder="e.g. Total Hip Replacement"
                autoCapitalize="words"
              />
              <PrimaryButton title="Save Procedure" testID="procedure-save-button" onPress={onSubmit} loading={add.isPending} />
              <Pressable style={styles.cancel} onPress={() => setModal(false)} testID="procedure-cancel-button">
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
            </KeyboardAwareScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  container: { flex: 1, backgroundColor: colors.surfaceSecondary },
  header: {
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: { fontFamily: fontFamily.bold, fontSize: fontSize.xxl, color: colors.onSurface },
  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    backgroundColor: colors.brandPrimary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
  },
  addBtnText: { fontFamily: fontFamily.semibold, fontSize: fontSize.base, color: colors.onBrandPrimary },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.brandPrimary },
  name: { flex: 1, fontFamily: fontFamily.semibold, fontSize: fontSize.lg, color: colors.onSurface },
  modalOverlay: { flex: 1, backgroundColor: "rgba(15,23,42,0.4)", justifyContent: "flex-end" },
  modalCard: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
  },
  modalHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderStrong,
    alignSelf: "center",
    marginBottom: spacing.md,
  },
  modalTitle: { fontFamily: fontFamily.bold, fontSize: fontSize.xl, color: colors.onSurface, marginBottom: spacing.lg },
  cancel: { alignItems: "center", paddingVertical: spacing.md, marginTop: spacing.sm },
  cancelText: { fontFamily: fontFamily.semibold, fontSize: fontSize.base, color: colors.muted },
}));
