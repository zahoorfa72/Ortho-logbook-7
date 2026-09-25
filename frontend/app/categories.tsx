import { useMemo, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import Ionicons from "@react-native-vector-icons/ionicons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api } from "@/src/api/client";
import { useAuth } from "@/src/auth/AuthContext";
import { useToast } from "@/src/components/toast";
import { Field } from "@/src/components/Field";
import { PrimaryButton } from "@/src/components/PrimaryButton";
import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";

type Category = { id: string; name: string; itemCount: number };

export default function InventoryCategories() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const qc = useQueryClient();
  const { user } = useAuth();
  const [search, setSearch] = useState("");
  const [name, setName] = useState("");
  const [showAdd, setShowAdd] = useState(false);

  const q = useQuery<Category[]>({
    queryKey: ["inventory-categories"],
    queryFn: () => api.get<Category[]>("/inventory-categories"),
  });

  const add = useMutation({
    mutationFn: () => api.post<Category>("/inventory-categories", { name: name.trim() }),
    onSuccess: (category) => {
      qc.invalidateQueries({ queryKey: ["inventory-categories"] });
      setName("");
      setShowAdd(false);
      toast("Category added.", "success");
      router.push({ pathname: "/(tabs)/inventory", params: { categoryId: category.id, categoryName: category.name } } as any);
    },
    onError: (e: any) => toast(e?.message || "Could not add category.", "error"),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del("/inventory-categories/" + id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory-categories"] });
      toast("Category deleted.", "success");
    },
    onError: (e: any) => toast(e?.message || "Could not delete category.", "error"),
  });

  const list = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data || []).filter(c => !s || c.name.toLowerCase().includes(s));
  }, [q.data, search]);

  const create = () => {
    if (!name.trim()) {
      toast("Enter a category name.", "error");
      return;
    }
    add.mutate();
  };

  if (user?.role !== "admin") {
    return <View style={styles.center}><Text style={styles.emptyTitle}>Administrator permission required.</Text></View>;
  }

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <View style={styles.headerTop}>
          <Pressable testID="categories-back" onPress={() => router.back()} style={styles.iconBtn}>
            <Ionicons name="arrow-back" size={21} color={colors.onSurface} />
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Inventory Categories</Text>
            <Text style={styles.subtitle}>Create categories first, then keep all sizes/items inside them.</Text>
          </View>
          <Pressable testID="add-category-button" onPress={() => setShowAdd(v => !v)} style={styles.addBtn}>
            <Ionicons name="add" size={20} color={colors.onBrandPrimary} />
            <Text style={styles.addText}>Add</Text>
          </Pressable>
        </View>

        {showAdd ? (
          <View style={styles.addCard}>
            <Field
              label="Category name"
              testID="category-name-input"
              value={name}
              onChangeText={setName}
              placeholder="e.g. Interlocking Nail 10mm"
              autoCapitalize="words"
            />
            <PrimaryButton title="Save Category" testID="save-category-button" onPress={create} loading={add.isPending} />
          </View>
        ) : null}

        <View style={styles.search}>
          <Ionicons name="search" size={18} color={colors.muted} />
          <TextInput
            testID="category-search-input"
            value={search}
            onChangeText={setSearch}
            placeholder="Search categories..."
            placeholderTextColor={colors.muted}
            style={styles.searchInput}
          />
        </View>
      </View>

      {q.isLoading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={colors.brandPrimary} /></View>
      ) : q.isError ? (
        <View style={styles.center}><Text style={styles.emptyTitle}>Could not load categories.</Text></View>
      ) : (
        <FlatList
          data={list}
          keyExtractor={x => x.id}
          contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + spacing.xl, flexGrow: 1 }}
          refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={q.refetch} />}
          ListEmptyComponent={<View style={styles.empty}><Ionicons name="layers-outline" size={42} color={colors.muted} /><Text style={styles.emptyTitle}>No categories</Text><Text style={styles.emptySub}>Add a category such as Interlocking Nail 10mm, DCP Broad, or another implant group.</Text></View>}
          renderItem={({ item }) => (
            <View style={styles.row}>
              <View style={styles.categoryIcon}><Ionicons name="layers" size={22} color={colors.brandPrimary} /></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.itemName}>{item.name}</Text>
                <Text style={styles.meta}>{item.itemCount} {item.itemCount === 1 ? "item" : "items"}</Text>
              </View>
              <Pressable
                testID={`open-category-${item.id}`}
                onPress={() => router.push({ pathname: "/(tabs)/inventory", params: { categoryId: item.id, categoryName: item.name } } as any)}
                style={styles.openBtn}
              >
                <Ionicons name="chevron-forward" size={20} color={colors.brandPrimary} />
              </Pressable>
              <Pressable
                testID={`delete-category-${item.id}`}
                onPress={() => Alert.alert("Delete category?", `Delete "${item.name}"? The category must be empty first.`, [
                  { text: "Cancel", style: "cancel" },
                  { text: "Delete", style: "destructive", onPress: () => remove.mutate(item.id) },
                ])}
                style={styles.deleteBtn}
              >
                <Ionicons name="trash-outline" size={18} color={colors.danger} />
              </Pressable>
            </View>
          )}
        />
      )}
    </View>
  );
}

const useStyles = makeStyles(colors => ({
  container: { flex: 1, backgroundColor: colors.surfaceSecondary },
  header: { backgroundColor: colors.surface, paddingHorizontal: spacing.lg, paddingBottom: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border },
  headerTop: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  iconBtn: { width: 40, height: 40, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center", backgroundColor: colors.surfaceSecondary },
  title: { fontFamily: fontFamily.bold, fontSize: fontSize.xxl, color: colors.onSurface },
  subtitle: { fontFamily: fontFamily.regular, fontSize: fontSize.sm, color: colors.muted, marginTop: 2 },
  addBtn: { minHeight: 40, paddingHorizontal: spacing.md, borderRadius: radius.md, backgroundColor: colors.brandPrimary, flexDirection: "row", alignItems: "center", gap: spacing.xs },
  addText: { fontFamily: fontFamily.semibold, color: colors.onBrandPrimary },
  addCard: { marginTop: spacing.md, padding: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surface },
  search: { marginTop: spacing.md, minHeight: 46, flexDirection: "row", alignItems: "center", gap: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: spacing.md, backgroundColor: colors.surfaceSecondary },
  searchInput: { flex: 1, color: colors.onSurface, paddingVertical: spacing.sm },
  row: { flexDirection: "row", alignItems: "center", backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm, borderWidth: 1, borderColor: colors.border },
  categoryIcon: { width: 44, height: 44, borderRadius: 12, backgroundColor: colors.surfaceSecondary, alignItems: "center", justifyContent: "center", marginRight: spacing.md },
  itemName: { fontFamily: fontFamily.semibold, fontSize: fontSize.lg, color: colors.onSurface },
  meta: { fontFamily: fontFamily.regular, fontSize: fontSize.sm, color: colors.muted, marginTop: 3 },
  openBtn: { width: 40, height: 40, borderRadius: radius.md, alignItems: "center", justifyContent: "center", backgroundColor: colors.brandTertiary },
  deleteBtn: { width: 40, height: 40, borderRadius: radius.md, alignItems: "center", justifyContent: "center", marginLeft: spacing.xs, backgroundColor: colors.surfaceSecondary },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.lg },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl },
  emptyTitle: { fontFamily: fontFamily.bold, fontSize: fontSize.lg, color: colors.onSurface, marginTop: spacing.md, textAlign: "center" },
  emptySub: { fontFamily: fontFamily.regular, fontSize: fontSize.sm, color: colors.muted, textAlign: "center", marginTop: spacing.xs, lineHeight: 20 },
}));
