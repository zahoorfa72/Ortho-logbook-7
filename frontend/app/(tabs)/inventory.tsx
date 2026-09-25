import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  Text,
  TextInput,
  View,
} from "react-native";
import Ionicons from "@react-native-vector-icons/ionicons";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";

import { api } from "@/src/api/client";
import { useAuth } from "@/src/auth/AuthContext";
import { EmptyState } from "@/src/components/EmptyState";
import { Field } from "@/src/components/Field";
import { PinPromptModal } from "@/src/components/PinPromptModal";
import { PrimaryButton } from "@/src/components/PrimaryButton";
import { Segmented } from "@/src/components/Segmented";
import { useToast } from "@/src/components/toast";
import { usesNativeTabs } from "@/src/navigation";
import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";
import { hasAdminPin } from "@/src/utils/admin-pin";
import { buildInventoryHtml, generateAndSharePdf } from "@/src/utils/pdf";

type InventoryItem = {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  minimumStock: number;
  categoryId: string;
  category: string;
  size: string;
};

export default function Inventory() {
  const styles = useStyles();
  const { colors, branding } = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const bottomChrome = usesNativeTabs ? insets.bottom : 0;
  const isAdmin = user?.role === "admin";
  const params = useLocalSearchParams<{ categoryId?: string; categoryName?: string }>();
  const selectedCategoryId = typeof params.categoryId === "string" ? params.categoryId : "";
  const selectedCategoryName = typeof params.categoryName === "string" ? params.categoryName : "";

  const [tab, setTab] = useState("All");
  const [addModal, setAddModal] = useState(false);
  const [editItem, setEditItem] = useState<InventoryItem | null>(null);
  const [name, setName] = useState("");
  const [category, setCategory] = useState(selectedCategoryName);
  const [size, setSize] = useState("");
  const [qty, setQty] = useState("");
  const [min, setMin] = useState("1");
  const [unit, setUnit] = useState("pcs");
  const [search, setSearch] = useState("");
  const [historyItem, setHistoryItem] = useState<InventoryItem | null>(null);
  const [pinPromptOpen, setPinPromptOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const { data, isLoading, isError, refetch, isRefetching } = useQuery<InventoryItem[]>({
    queryKey: ["inventory", selectedCategoryId],
    queryFn: async () => await api.get<InventoryItem[]>(selectedCategoryId ? "/inventory?categoryId=" + encodeURIComponent(selectedCategoryId) : "/inventory"),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["inventory"] });
  };

  const addStock = useMutation({
    mutationFn: (body: { name: string; categoryId: string; category: string; size: string; quantity: number; minimumStock: number; unit: string }) =>
      api.post("/inventory", body),
    onSuccess: () => {
      invalidate();
      toast("Stock added.", "success");
      setAddModal(false);
      setName(""); setCategory(""); setSize(""); setQty(""); setMin("1"); setUnit("pcs");
    },
    onError: (e: any) => toast(e?.message || "Could not add stock.", "error"),
  });

  const updateItem = useMutation({
    mutationFn: (item: InventoryItem) =>
      api.put(`/inventory/${item.id}`, {
        name: item.name,
        category: item.category,
        size: item.size,
        quantity: item.quantity,
        unit: item.unit,
        minimumStock: item.minimumStock,
      }),
    onSuccess: () => {
      invalidate();
      toast("Item updated.", "success");
      setEditItem(null);
    },
    onError: (e: any) => toast(e?.message || "Update failed.", "error"),
  });

  const removeItem = useMutation({
    mutationFn: (id: string) => api.del(`/inventory/${id}`),
    onSuccess: () => {
      invalidate();
      toast("Item deleted.", "success");
      setEditItem(null);
    },
    onError: (e: any) => toast(e?.message || "Delete failed.", "error"),
  });

  const adjust = useMutation({
    mutationFn: (item: InventoryItem) =>
      api.put(`/inventory/${item.id}`, {
        name: item.name,
        quantity: item.quantity,
        unit: item.unit,
        minimumStock: item.minimumStock,
      }),
    onSuccess: invalidate,
    onError: (e: any) => toast(e?.message || "Update failed.", "error"),
  });

  const list = useMemo(() => {
    let items = data || [];
    if (search.trim()) {
      const s = search.trim().toLowerCase();
      items = items.filter(i => i.name.toLowerCase().includes(s) || i.size.toLowerCase().includes(s) || i.category.toLowerCase().includes(s));
    }
    if (tab === "Low Stock") items = items.filter((i) => i.quantity <= i.minimumStock);
    return items;
  }, [data, tab, search]);

  const onSubmit = () => {
    const q = parseInt(qty, 10);
    if (!name.trim() || isNaN(q) || q <= 0) {
      toast("Enter an item name and a quantity above 0.", "error");
      return;
    }
    if (!selectedCategoryId && !category.trim()) { toast("Select an inventory category first.", "error"); return; }
    addStock.mutate({ name: name.trim(), categoryId: selectedCategoryId, category: category.trim(), size: size.trim(), quantity: q, minimumStock: parseInt(min, 10) || 1, unit: unit.trim() || "pcs" });
  };

  const changeQty = (item: InventoryItem, delta: number) => {
    const next = Math.max(0, item.quantity + delta);
    adjust.mutate({ ...item, quantity: next });
  };

  const openEdit = (item: InventoryItem) => {
    setEditItem(item);
  };

  const saveEdit = () => {
    if (!editItem) return;
    if (!editItem.name.trim()) {
      toast("Name is required.", "error");
      return;
    }
    if (editItem.quantity < 0) {
      toast("Quantity cannot be negative.", "error");
      return;
    }
    updateItem.mutate(editItem);
  };

  const confirmDelete = () => {
    if (!editItem) return;
    const target = editItem;
    Alert.alert(
      "Delete item?",
      `Delete "${target.name}"? This also removes its stock history. This cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => removeItem.mutate(target.id),
        },
      ],
    );
  };

  const doExport = useCallback(async () => {
    const items = data || [];
    if (!items.length) {
      toast("Inventory is empty.", "info");
      return;
    }
    setExporting(true);
    try {
      const html = buildInventoryHtml(branding, items, tab === "Low Stock");
      await generateAndSharePdf(html, tab === "Low Stock" ? "Low Stock Report" : "Inventory");
    } catch (e: any) {
      toast(e?.message || "Could not create PDF.", "error");
    } finally {
      setExporting(false);
    }
  }, [branding, data, tab, toast]);

  const requestExport = useCallback(async () => {
    if (await hasAdminPin()) setPinPromptOpen(true);
    else doExport();
  }, [doExport]);

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <View style={styles.headerTop}>
          <Text style={styles.title}>Inventory</Text>
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            {isAdmin ? (
              <Pressable
                testID="inventory-export-pdf"
                onPress={requestExport}
                style={styles.iconBtn}
                disabled={exporting}
              >
                {exporting ? (
                  <ActivityIndicator size="small" color={colors.brandPrimary} />
                ) : (
                  <Ionicons name="document-text-outline" size={20} color={colors.brandPrimary} />
                )}
              </Pressable>
            ) : null}
            {isAdmin ? (
              <Pressable testID="categories-button" style={styles.iconBtn} onPress={() => router.push("/categories" as any)}>
                <Ionicons name="layers-outline" size={20} color={colors.brandPrimary} />
              </Pressable>
            ) : null}
            {isAdmin ? (
              <Pressable testID="add-stock-button" style={styles.addBtn} onPress={() => { setCategory(selectedCategoryName); setAddModal(true); }}>
                <Ionicons name="add" size={20} color={colors.onBrandPrimary} />
                <Text style={styles.addBtnText}>Add Stock</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
        <Segmented options={["All", "Low Stock"]} value={tab} onChange={setTab} testIDPrefix="inv-tab" />
        <View style={styles.searchWrap}>
          <Ionicons name="search" size={18} color={colors.muted} />
          <TextInput
            testID="inventory-search-input"
            value={search}
            onChangeText={setSearch}
            placeholder="Search inventory..."
            placeholderTextColor={colors.muted}
            style={styles.searchInput}
          />
        </View>
      </View>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.brandPrimary} />
        </View>
      ) : isError ? (
        <View style={styles.center}>
          <EmptyState icon="cloud-offline-outline" title="Local database error" subtitle="Pull to reload the local inventory." />
        </View>
      ) : (
        <FlatList
          data={list}
          keyExtractor={(i) => i.id}
          contentContainerStyle={{ padding: spacing.lg, paddingBottom: bottomChrome + spacing.xl, flexGrow: 1 }}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.brandPrimary} />
          }
          ListEmptyComponent={
            <EmptyState
              icon="cube-outline"
              title={tab === "Low Stock" ? "No low-stock items" : "Inventory is empty"}
              subtitle={tab === "Low Stock" ? "All implants are well stocked." : "Tap Add Stock to get started."}
            />
          }
          renderItem={({ item }) => {
            const low = item.quantity <= item.minimumStock;
            return (
              <View style={styles.row} testID={`inventory-row-${item.id}`}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.itemName} numberOfLines={2}>
                    {item.category ? item.category + " · " : ""}{item.name}{item.size ? " · " + item.size : ""}
                  </Text>
                  <View style={styles.metaRow}>
                    <Text style={[styles.qty, low && styles.qtyLow]}>
                      {item.quantity} {item.unit}
                    </Text>
                    <Text style={styles.meta}>· Min {item.minimumStock}</Text>
                    {low && (
                      <View style={styles.lowBadge}>
                        <Ionicons name="alert-circle" size={12} color={colors.onWarning} />
                        <Text style={styles.lowText}>LOW</Text>
                      </View>
                    )}
                  </View>
                </View>
                <View style={styles.stepper}>
                  <Pressable
                    onPress={() => setHistoryItem(item)}
                    style={styles.smallBtn}
                    testID={`inv-history-${item.id}`}
                  >
                    <Ionicons name="time-outline" size={18} color={colors.brandPrimary} />
                  </Pressable>
                  {isAdmin ? (
                    <Pressable
                      onPress={() => openEdit(item)}
                      style={styles.smallBtn}
                      testID={`inv-edit-${item.id}`}
                    >
                      <Ionicons name="create-outline" size={18} color={colors.brandPrimary} />
                    </Pressable>
                  ) : null}
                  <Pressable
                    testID={`inv-dec-${item.id}`}
                    style={styles.stepBtn}
                    onPress={() => changeQty(item, -1)}
                  >
                    <Ionicons name="remove" size={20} color={colors.onSurface} />
                  </Pressable>
                  <Pressable
                    testID={`inv-inc-${item.id}`}
                    style={styles.stepBtn}
                    onPress={() => changeQty(item, 1)}
                  >
                    <Ionicons name="add" size={20} color={colors.onSurface} />
                  </Pressable>
                </View>
              </View>
            );
          }}
        />
      )}

      {/* Add stock modal */}
      <Modal visible={addModal} transparent animationType="slide" onRequestClose={() => setAddModal(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { paddingBottom: insets.bottom + spacing.lg }]}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Add Stock</Text>
            <KeyboardAwareScrollView bottomOffset={40} keyboardShouldPersistTaps="handled">
              <Field label="Category" testID="stock-category-input" value={category} onChangeText={setCategory} placeholder="Select a category" autoCapitalize="words" editable={!selectedCategoryId} />
              <Field label="Item / Implant Name" testID="stock-name-input" value={name} onChangeText={setName} placeholder="e.g. Interlocking Nail" autoCapitalize="words" />
              <Field label="Size / Length" testID="stock-size-input" value={size} onChangeText={setSize} placeholder="e.g. 280mm" />
              <Field label="Quantity Received" testID="stock-qty-input" value={qty} onChangeText={setQty} placeholder="e.g. 20" keyboardType="number-pad" />
              <Field label="Unit" testID="stock-unit-input" value={unit} onChangeText={setUnit} placeholder="pcs" />
              <Field label="Minimum Stock Alert" testID="stock-min-input" value={min} onChangeText={setMin} placeholder="1" keyboardType="number-pad" />
              <PrimaryButton title="Save Stock" testID="stock-save-button" onPress={onSubmit} loading={addStock.isPending} />
              <Pressable style={styles.cancel} onPress={() => setAddModal(false)} testID="stock-cancel-button">
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
            </KeyboardAwareScrollView>
          </View>
        </View>
      </Modal>

      {/* Edit modal */}
      <Modal visible={!!editItem} transparent animationType="slide" onRequestClose={() => setEditItem(null)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { paddingBottom: insets.bottom + spacing.lg }]}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Edit Item</Text>
            {editItem ? (
              <KeyboardAwareScrollView bottomOffset={40} keyboardShouldPersistTaps="handled">
                <Field
                  label="Category"
                  testID="edit-category-input"
                  value={editItem.category}
                  onChangeText={(v) => setEditItem({ ...editItem, category: v })}
                />
                <Field
                  label="Name"
                  testID="edit-name-input"
                  value={editItem.name}
                  onChangeText={(v) => setEditItem({ ...editItem, name: v })}
                  autoCapitalize="words"
                />
                <Field
                  label="Size / Length"
                  testID="edit-size-input"
                  value={editItem.size}
                  onChangeText={(v) => setEditItem({ ...editItem, size: v })}
                />
                <Field
                  label="Quantity"
                  testID="edit-qty-input"
                  value={String(editItem.quantity)}
                  onChangeText={(v) =>
                    setEditItem({ ...editItem, quantity: parseFloat(v.replace(/[^0-9.]/g, "")) || 0 })
                  }
                  keyboardType="decimal-pad"
                />
                <Field
                  label="Unit"
                  testID="edit-unit-input"
                  value={editItem.unit}
                  onChangeText={(v) => setEditItem({ ...editItem, unit: v })}
                />
                <Field
                  label="Minimum Stock"
                  testID="edit-min-input"
                  value={String(editItem.minimumStock)}
                  onChangeText={(v) =>
                    setEditItem({ ...editItem, minimumStock: parseFloat(v.replace(/[^0-9.]/g, "")) || 0 })
                  }
                  keyboardType="decimal-pad"
                />
                <PrimaryButton
                  title="Save Changes"
                  testID="edit-save-button"
                  onPress={saveEdit}
                  loading={updateItem.isPending}
                />
                <View style={{ height: spacing.md }} />
                <PrimaryButton
                  title="Delete Item"
                  testID="edit-delete-button"
                  variant="danger"
                  onPress={confirmDelete}
                  loading={removeItem.isPending}
                />
                <Pressable style={styles.cancel} onPress={() => setEditItem(null)} testID="edit-cancel-button">
                  <Text style={styles.cancelText}>Cancel</Text>
                </Pressable>
              </KeyboardAwareScrollView>
            ) : null}
          </View>
        </View>
      </Modal>

      <HistoryModal item={historyItem} onClose={() => setHistoryItem(null)} />

      <PinPromptModal
        visible={pinPromptOpen}
        title="Admin PIN required"
        description={
          tab === "Low Stock"
            ? "Enter admin PIN to export the low stock report."
            : "Enter admin PIN to export inventory."
        }
        onSuccess={() => {
          setPinPromptOpen(false);
          doExport();
        }}
        onCancel={() => setPinPromptOpen(false)}
      />
    </View>
  );
}

function HistoryModal({ item, onClose }: { item: InventoryItem | null; onClose: () => void }) {
  const { colors } = useTheme();
  const styles = useStyles();
  const { data = [] } = useQuery<any[]>({
    queryKey: ["inventory-history", item?.id],
    queryFn: async () => await api.get<any[]>("/inventory-history/" + item!.id),
    enabled: !!item,
  });
  if (!item) return null;
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>Movement History</Text>
          <Text style={styles.historyName}>{item.name}</Text>
          <FlatList
            data={data}
            keyExtractor={(x: any) => x.id}
            renderItem={({ item: h }: any) => (
              <View style={styles.historyRow}>
                <Text style={styles.historyType}>{h.type}</Text>
                <Text style={styles.historyMeta}>
                  {h.amount > 0 ? "+" : ""}
                  {h.amount} → {h.quantity_after} · {h.user_name || "Unknown"}
                </Text>
                <Text style={styles.historyMeta}>{new Date(h.created_at).toLocaleString()}</Text>
              </View>
            )}
            ListEmptyComponent={<Text style={styles.historyMeta}>No movements recorded.</Text>}
          />
          <Pressable onPress={onClose} style={styles.cancel}>
            <Text style={[styles.cancelText, { color: colors.muted }]}>Close</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
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
  },
  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    marginTop: spacing.md,
  },
  searchInput: { flex: 1, paddingVertical: spacing.sm, color: colors.onSurface },
  smallBtn: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    backgroundColor: colors.brandTertiary,
    alignItems: "center",
    justifyContent: "center",
  },
  historyName: {
    fontFamily: fontFamily.bold,
    fontSize: fontSize.lg,
    color: colors.onSurface,
    marginBottom: spacing.md,
  },
  historyRow: { paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  historyType: { fontFamily: fontFamily.semibold, color: colors.onSurface },
  historyMeta: { fontSize: fontSize.sm, color: colors.muted, marginTop: spacing.xs },
  headerTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.md,
    gap: spacing.sm,
  },
  title: { fontFamily: fontFamily.bold, fontSize: fontSize.xxl, color: colors.onSurface },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSecondary,
    alignItems: "center",
    justifyContent: "center",
  },
  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    backgroundColor: colors.brandPrimary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    minHeight: 40,
  },
  addBtnText: { fontFamily: fontFamily.semibold, fontSize: fontSize.base, color: colors.onBrandPrimary },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  itemName: { fontFamily: fontFamily.semibold, fontSize: fontSize.lg, color: colors.onSurface },
  meta: { fontFamily: fontFamily.regular, fontSize: fontSize.sm, color: colors.muted },
  metaRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.xs, flexWrap: "wrap" },
  qty: { fontFamily: fontFamily.monoMedium, fontSize: fontSize.base, color: colors.onSurfaceSecondary },
  qtyLow: { color: colors.warning },
  lowBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    backgroundColor: colors.warning,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  lowText: { fontFamily: fontFamily.bold, fontSize: 10, color: colors.onWarning },
  stepper: { flexDirection: "row", gap: spacing.sm, alignItems: "center" },
  stepBtn: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceTertiary,
    alignItems: "center",
    justifyContent: "center",
  },
  modalOverlay: { flex: 1, backgroundColor: "rgba(15,23,42,0.4)", justifyContent: "flex-end" },
  modalCard: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
    maxHeight: "85%",
  },
  modalHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderStrong,
    alignSelf: "center",
    marginBottom: spacing.md,
  },
  modalTitle: {
    fontFamily: fontFamily.bold,
    fontSize: fontSize.xl,
    color: colors.onSurface,
    marginBottom: spacing.lg,
  },
  cancel: { alignItems: "center", paddingVertical: spacing.md, marginTop: spacing.sm },
  cancelText: { fontFamily: fontFamily.semibold, fontSize: fontSize.base, color: colors.muted },
}));
