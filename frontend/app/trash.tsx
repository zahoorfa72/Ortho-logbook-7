import { router } from "expo-router";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import Ionicons from "@react-native-vector-icons/ionicons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api } from "@/src/api/client";
import { useAuth } from "@/src/auth/AuthContext";
import { useToast } from "@/src/components/toast";
import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";

type TrashEntry = { id: string; kind: string; title: string; deleted_at: string; expires_at: string; deleted_by?: string | null };

export default function TrashScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const { data = [], isLoading, refetch } = useQuery<TrashEntry[]>({
    queryKey: ["trash"],
    queryFn: () => api.get("/trash"),
    enabled: user?.role === "admin",
  });
  const restore = useMutation({
    mutationFn: (id: string) => api.post("/trash/restore", { id }),
    onSuccess: () => {
      qc.invalidateQueries();
      toast("Item restored from Trash.", "success");
      void refetch();
    },
    onError: (e: any) => toast(e?.message || "Could not restore this item.", "error"),
  });
  const permanentlyDelete = useMutation({
    mutationFn: (id: string) => api.del("/trash/" + encodeURIComponent(id)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["trash"] });
      toast("Item permanently deleted.", "success");
    },
    onError: (e: any) => toast(e?.message || "Could not permanently delete this item.", "error"),
  });
  const askPermanentDelete = (item: TrashEntry) => Alert.alert(
    "Permanently delete?",
    `“${item.title}” will be removed from Trash and cannot be restored. This action cannot be undone.`,
    [{ text: "Cancel", style: "cancel" }, { text: "Delete permanently", style: "destructive", onPress: () => permanentlyDelete.mutate(item.id) }],
  );

  if (user?.role !== "admin") return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.center}><Ionicons name="lock-closed-outline" size={44} color={colors.muted}/><Text style={styles.title}>Administrator only</Text><Text style={styles.muted}>Only an administrator can restore or permanently delete app data.</Text></View>
    </View>
  );

  return <View style={styles.container}>
    <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
      <Pressable onPress={() => router.back()} style={styles.headerBtn}><Ionicons name="arrow-back" size={24} color={colors.onSurface}/></Pressable>
      <Text style={styles.headerTitle}>Trash</Text>
      <Pressable onPress={() => void refetch()} style={styles.headerBtn}><Ionicons name="refresh-outline" size={21} color={colors.onSurface}/></Pressable>
    </View>
    <View style={styles.info}>
      <Ionicons name="time-outline" size={21} color={colors.brandPrimary}/>
      <Text style={styles.infoText}>Deleted app data stays here for 30 days. Restore items before expiry. Expired items are removed automatically and Trash is included in Google Drive master backup.</Text>
    </View>
    <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + spacing.xxl }}>
      {isLoading ? <Text style={styles.muted}>Loading Trash…</Text> : data.length === 0 ? (
        <View style={styles.empty}><Ionicons name="trash-outline" size={42} color={colors.muted}/><Text style={styles.title}>Trash is empty</Text><Text style={styles.muted}>Deleted records and settings will appear here.</Text></View>
      ) : data.map((item) => {
        const days = Math.max(0, Math.ceil((Date.parse(item.expires_at) - Date.now()) / 86400000));
        return <View key={item.id} style={styles.card}>
          <View style={styles.itemIcon}><Ionicons name="document-outline" size={22} color={colors.brandPrimary}/></View>
          <View style={{ flex: 1 }}>
            <Text style={styles.itemTitle}>{item.title || "Deleted item"}</Text>
            <Text style={styles.meta}>{String(item.kind || "record").replace(/-/g, " ")} · Deleted {new Date(item.deleted_at).toLocaleDateString()}</Text>
            <Text style={[styles.expiry, days <= 3 && { color: colors.error }]}>{days === 0 ? "Expires today" : `${days} day${days === 1 ? "" : "s"} left`}</Text>
            <View style={styles.actions}>
              <Pressable disabled={restore.isPending} onPress={() => restore.mutate(item.id)} style={styles.restoreBtn}>
                <Ionicons name="arrow-undo-outline" size={17} color={colors.onBrandPrimary}/><Text style={styles.restoreText}>Restore</Text>
              </Pressable>
              <Pressable disabled={permanentlyDelete.isPending} onPress={() => askPermanentDelete(item)} style={styles.deleteBtn}>
                <Ionicons name="trash-outline" size={17} color={colors.error}/><Text style={styles.deleteText}>Delete forever</Text>
              </Pressable>
            </View>
          </View>
        </View>;
      })}
    </ScrollView>
  </View>;
}

const useStyles = makeStyles(colors => ({
  container: { flex: 1, backgroundColor: colors.surfaceSecondary },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.md, paddingBottom: spacing.md, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
  headerBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  headerTitle: { fontFamily: fontFamily.bold, fontSize: fontSize.lg, color: colors.onSurface },
  info: { flexDirection: "row", gap: spacing.sm, margin: spacing.lg, marginBottom: 0, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.brandTertiary, borderWidth: 1, borderColor: colors.border },
  infoText: { flex: 1, fontSize: fontSize.sm, color: colors.onBrandTertiary, lineHeight: 19 },
  card: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md, padding: spacing.md, backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, marginBottom: spacing.sm },
  itemIcon: { width: 40, height: 40, borderRadius: radius.sm, backgroundColor: colors.surfaceTertiary, alignItems: "center", justifyContent: "center" },
  itemTitle: { fontFamily: fontFamily.semibold, fontSize: fontSize.base, color: colors.onSurface },
  meta: { fontSize: fontSize.xs, color: colors.muted, marginTop: 4 },
  expiry: { fontFamily: fontFamily.semibold, fontSize: fontSize.xs, color: colors.brandPrimary, marginTop: 5 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.md },
  restoreBtn: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.brandPrimary, borderRadius: radius.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  restoreText: { fontFamily: fontFamily.semibold, fontSize: fontSize.sm, color: colors.onBrandPrimary },
  deleteBtn: { flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  deleteText: { fontFamily: fontFamily.semibold, fontSize: fontSize.sm, color: colors.error },
  empty: { alignItems: "center", justifyContent: "center", paddingVertical: spacing.xxxl, gap: spacing.sm },
  title: { fontFamily: fontFamily.bold, fontSize: fontSize.lg, color: colors.onSurface },
  muted: { color: colors.muted, fontSize: fontSize.sm, textAlign: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl, gap: spacing.md },
}));
