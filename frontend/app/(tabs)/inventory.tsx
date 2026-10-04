import { formatInventoryLabel } from "@/src/utils/inventory-label";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import * as ImagePicker from "expo-image-picker";
import * as FileSystem from "expo-file-system";
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
import { SortMenu } from "@/src/components/SortMenu";
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
  addedDate?: string;
  billImage?: string;
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
  type AddRow = { id:string; categoryId:string; category:string; size:string; quantity:string; minimumStock:string; addedDate:string; billImage:string };
  const blankRow = (): AddRow => ({id:Math.random().toString(36).slice(2),categoryId:selectedCategoryId,category:selectedCategoryName,size:"",quantity:"",minimumStock:"1",addedDate:new Date().toISOString().slice(0,10),billImage:""});
  const [addRows, setAddRows] = useState<AddRow[]>([blankRow()]);
  const [picker, setPicker] = useState<"category"|"size"|null>(null);
  const [newCategory, setNewCategory] = useState("");
  const [search, setSearch] = useState("");
  const [inventorySort, setInventorySort] = useState<"name-asc" | "name-desc" | "size-asc" | "size-desc" | "qty-desc" | "qty-asc" | "low-first">("name-asc");
  const [historyItem, setHistoryItem] = useState<InventoryItem | null>(null);
  const [pinPromptOpen, setPinPromptOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const { data, isLoading, isError, refetch, isRefetching } = useQuery<InventoryItem[]>({
    queryKey: ["inventory", selectedCategoryId],
    queryFn: async () => await api.get<InventoryItem[]>(selectedCategoryId ? "/inventory?categoryId=" + encodeURIComponent(selectedCategoryId) : "/inventory"),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["inventory"] });
  };

  const { data: categories = [] } = useQuery<any[]>({
    queryKey:["inventory-categories"],
    queryFn:()=>api.get<any[]>("/inventory-categories"),
    enabled:isAdmin,
  });
  const allSizes = useMemo(()=>[...new Set((data||[]).map(x=>String(x.size||"").trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:"base"})),[data]);

  const addStock = useMutation({
    mutationFn: (rows:AddRow[]) => api.post("/inventory-bulk-add", {items:rows.map(r=>({
      categoryId:r.categoryId, category:r.category, size:r.size, quantity:Number(r.quantity)||0,
      minimumStock:Number(r.minimumStock)||0, addedDate:r.addedDate, billImage:r.billImage
    }))}),
    onSuccess: (result:any) => {
      invalidate(); queryClient.invalidateQueries({queryKey:["inventory-categories"]});
      queryClient.invalidateQueries({queryKey:["inventory-details"]});
      toast((result?.added||addRows.length)+" inventory item(s) saved.","success");
      setAddModal(false); setAddRows([blankRow()]);
    },
    onError:(e:any)=>toast(e?.message||"Could not add inventory items.","error"),
  });

  const updateItem = useMutation({
    mutationFn: (item: InventoryItem) =>
      api.put(`/inventory/${item.id}`, {
        name: item.name,
        categoryId: item.categoryId,
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
    mutationFn: (id: string) => api.del<{ success: boolean; deleted: number }>(`/inventory/${id}`),
    onSuccess: async () => {
      setEditItem(null);
      queryClient.invalidateQueries({ queryKey: ["inventory"] });
      await refetch();
      queryClient.invalidateQueries({ queryKey: ["inventory-categories"] });
      toast("Item deleted.", "success");
    },
    onError: (e: any) => toast(e?.message || "Delete failed.", "error"),
  });

  const adjust = useMutation({
    mutationFn: (item: InventoryItem) =>
      api.put(`/inventory/${item.id}`, {
        name: item.name,
        categoryId: item.categoryId,
        category: item.category,
        quantity: item.quantity,
        unit: item.unit,
        minimumStock: item.minimumStock,
      }),
    onSuccess: invalidate,
    onError: (e: any) => toast(e?.message || "Update failed.", "error"),
  });

  const list = useMemo(() => {
    let items = (data || []).filter((i) => {
      const s = search.trim().toLowerCase();
      return !s || i.name.toLowerCase().includes(s) || i.size.toLowerCase().includes(s) || i.category.toLowerCase().includes(s);
    });
    if (tab === "Low Stock") items = items.filter((i) => i.quantity <= i.minimumStock);
    items = [...items].sort((a, b) => {
      if (inventorySort === "name-desc") return formatInventoryLabel(b.category, b.name, b.size).localeCompare(formatInventoryLabel(a.category, a.name, a.size), undefined, { numeric: true, sensitivity: "base" });
      if (inventorySort === "size-asc" || inventorySort === "size-desc") {
        const sizeNumber = (value: string) => {
          const match = String(value || "").match(/-?\d+(?:\.\d+)?/);
          return match ? Number(match[0]) : Number.POSITIVE_INFINITY;
        };
        const an = sizeNumber(a.size);
        const bn = sizeNumber(b.size);
        if (an !== bn) return inventorySort === "size-asc" ? an - bn : bn - an;
        const ac = (a.size || "").localeCompare(b.size || "", undefined, { numeric: true, sensitivity: "base" });
        return inventorySort === "size-asc" ? ac : -ac;
      }
      if (inventorySort === "qty-desc") return Number(b.quantity) - Number(a.quantity);
      if (inventorySort === "qty-asc") return Number(a.quantity) - Number(b.quantity);
      if (inventorySort === "low-first") {
        const al = a.quantity <= a.minimumStock;
        const bl = b.quantity <= b.minimumStock;
        if (al !== bl) return al ? -1 : 1;
        return Number(a.quantity) - Number(b.quantity);
      }
      return formatInventoryLabel(a.category, a.name, a.size).localeCompare(formatInventoryLabel(b.category, b.name, b.size), undefined, { numeric: true, sensitivity: "base" });
    });
    return items;
  }, [data, tab, search, inventorySort]);

  const onSubmit = () => {
    for(const row of addRows){
      if(!row.category.trim()) { toast("Select a category for every item.","error"); return; }
      if(Number(row.quantity)<=0) { toast("Enter quantity above 0 for every item.","error"); return; }
      if(!row.addedDate.match(/^\\d{4}-\\d{2}-\\d{2}$/)) { toast("Use YYYY-MM-DD for the date.","error"); return; }
    }
    addStock.mutate(addRows);
  };
  const updateAddRow=(id:string,patch:Partial<AddRow>)=>setAddRows(rows=>rows.map(r=>r.id===id?{...r,...patch}:r));
  const pickBill=async(id:string)=>{
    const perm=await ImagePicker.requestMediaLibraryPermissionsAsync(); if(!perm.granted){toast("Photo permission is required for the bill image.","error");return;}
    const result=await ImagePicker.launchImageLibraryAsync({mediaTypes:["images"],allowsEditing:true,quality:0.55,base64:true});
    if(result.canceled) return;
    const asset=result.assets[0]; let b64=asset?.base64;
    if(!b64 && asset?.uri){try{b64=await FileSystem.readAsStringAsync(asset.uri,{encoding:FileSystem.EncodingType.Base64});}catch{}}
    if(!b64){toast("Could not read bill image.","error");return;}
    if(b64.length>2_000_000){toast("Bill image is too large. Choose a smaller image.","error");return;}
    updateAddRow(id,{billImage:"data:"+(asset?.mimeType||"image/jpeg")+";base64,"+b64});
  };
  const createCategory=async()=>{
    const name=newCategory.trim(); if(!name)return;
    try{
      const cat=await api.post<any>("/inventory-categories",{name});
      updateAddRow(addRows[0].id,{categoryId:cat.id,category:cat.name});
      setNewCategory(""); setPicker(null); queryClient.invalidateQueries({queryKey:["inventory-categories"]});
    }catch(e:any){toast(e?.message||"Could not create category.","error");}
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

  const toggleInventory = (id: string) => setSelectedIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  const selectAllInventory = () => setSelectedIds(selectedIds.length === list.length ? [] : list.map((x) => x.id));
  const deleteSelectedInventory = () => {
    if (!selectedIds.length) return;
    Alert.alert("Delete inventory items?", `Delete ${selectedIds.length} selected item(s)? This cannot be undone.`, [
      { text:"Cancel", style:"cancel" },
      { text:"Delete", style:"destructive", onPress: async () => {
        const idsToDelete = [...selectedIds];
        try {
          const result = await api.post<{ success: boolean; deleted: number }>("/inventory-bulk-delete", { ids: idsToDelete });
          if (result.deleted !== idsToDelete.length) {
            throw new Error(`Only ${result.deleted} of ${idsToDelete.length} selected inventory item(s) were deleted.`);
          }
          setSelectedIds([]);
          setSelectMode(false);
          queryClient.invalidateQueries({ queryKey: ["inventory"] });
          await refetch();
          queryClient.invalidateQueries({ queryKey: ["inventory-categories"] });
          toast("Selected inventory items deleted.", "success");
        }
        catch(e:any) { toast(e?.message || "Could not delete selected items.", "error"); }
      }}
    ]);
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
          {isAdmin && selectMode ? <View style={{flexDirection:"row",alignItems:"center",gap:spacing.xs,marginLeft:spacing.sm}}><Pressable testID="inventory-select-all" onPress={selectAllInventory} style={styles.iconBtn}><Text style={styles.headerActionText}>{selectedIds.length===list.length && list.length ? "Clear" : "All"}</Text></Pressable>{selectedIds.length ? <Pressable testID="inventory-bulk-delete" onPress={deleteSelectedInventory} style={styles.iconBtn}><Ionicons name="trash-outline" size={20} color={colors.error}/></Pressable>:null}</View>:null}
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
              <Pressable testID="inventory-usage-button" style={styles.iconBtn} onPress={() => router.push("/inventory-usage")}>
                <Ionicons name="analytics-outline" size={20} color={colors.brandPrimary} />
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
        <View style={{ marginTop: spacing.sm }}>
          <SortMenu
            value={inventorySort}
            onChange={setInventorySort}
            testID="inventory-sort"
            options={[
              { value: "name-asc", label: "Item — A to Z" },
              { value: "name-desc", label: "Item — Z to A" },
              { value: "size-asc", label: "Size / holes — Low to high" },
              { value: "size-desc", label: "Size / holes — High to low" },
              { value: "qty-desc", label: "Quantity — High to low" },
              { value: "qty-asc", label: "Quantity — Low to high" },
              { value: "low-first", label: "Low stock — First" },
            ]}
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
              <Pressable style={[styles.row, selectedIds.includes(item.id) && styles.selectedRow]} testID={`inventory-row-${item.id}`} onPress={() => selectMode ? toggleInventory(item.id) : openEdit(item)} onLongPress={() => { if(isAdmin){setSelectMode(true);toggleInventory(item.id);}}}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.itemName} numberOfLines={2}>
                    {formatInventoryLabel(item.category, item.name, item.size)}
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
              </Pressable>
            );
          }}
        />
      )}

      {/* Add inventory modal */}
      <Modal visible={addModal} transparent animationType="slide" onRequestClose={()=>setAddModal(false)}>
        <View style={styles.modalOverlay}><View style={[styles.modalCard,{paddingBottom:insets.bottom+spacing.lg}]}>
          <View style={styles.modalHandle}/><Text style={styles.modalTitle}>Add Inventory</Text>
          <Text style={styles.modalHint}>Add multiple items together. Only category, size, minimum stock, quantity, date and bill image are required.</Text>
          <KeyboardAwareScrollView bottomOffset={40} keyboardShouldPersistTaps="handled">
            {addRows.map((row,index)=><View key={row.id} style={styles.addRowCard}>
              <View style={styles.addRowHeader}><Text style={styles.addRowTitle}>Item {index+1}</Text>{addRows.length>1?<Pressable onPress={()=>setAddRows(x=>x.filter(r=>r.id!==row.id))}><Ionicons name="trash-outline" size={19} color={colors.error}/></Pressable>:null}</View>
              <Pressable style={styles.dropdown} onPress={()=>setPicker("category")}><Text style={row.category?styles.dropdownText:styles.dropdownPlaceholder}>{row.category||"Select saved category or create new"}</Text><Ionicons name="chevron-down" size={18} color={colors.muted}/></Pressable>
              <Pressable style={styles.dropdown} onPress={()=>setPicker("size")}><Text style={row.size?styles.dropdownText:styles.dropdownPlaceholder}>{row.size||"Select saved size or enter new"}</Text><Ionicons name="chevron-down" size={18} color={colors.muted}/></Pressable>
              {!row.size?<TextInput value={row.size} onChangeText={v=>updateAddRow(row.id,{size:v})} placeholder="New size" placeholderTextColor={colors.muted} style={styles.input}/>:null}
              <View style={styles.twoCol}><TextInput value={row.quantity} onChangeText={v=>updateAddRow(row.id,{quantity:v.replace(/[^0-9.]/g,"")})} placeholder="Quantity" keyboardType="number-pad" placeholderTextColor={colors.muted} style={[styles.input,{flex:1}]}/><TextInput value={row.minimumStock} onChangeText={v=>updateAddRow(row.id,{minimumStock:v.replace(/[^0-9.]/g,"")})} placeholder="Minimum stock" keyboardType="number-pad" placeholderTextColor={colors.muted} style={[styles.input,{flex:1}]}/></View>
              <TextInput value={row.addedDate} onChangeText={v=>updateAddRow(row.id,{addedDate:v})} placeholder="YYYY-MM-DD" placeholderTextColor={colors.muted} style={styles.input}/>
              <Pressable style={styles.billButton} onPress={()=>pickBill(row.id)}><Ionicons name={row.billImage?"checkmark-circle":"image-outline"} size={19} color={colors.brandPrimary}/><Text style={styles.billText}>{row.billImage?"Bill image selected":"Add bill image"}</Text></Pressable>
            </View>)}
            <Pressable style={styles.addAnother} onPress={()=>setAddRows(x=>[...x,blankRow()])}><Ionicons name="add-circle-outline" size={20} color={colors.brandPrimary}/><Text style={styles.addAnotherText}>Add another item</Text></Pressable>
            <PrimaryButton title="Save All Items" testID="stock-save-button" onPress={onSubmit} loading={addStock.isPending}/>
            <Pressable style={styles.cancel} onPress={()=>setAddModal(false)}><Text style={styles.cancelText}>Cancel</Text></Pressable>
          </KeyboardAwareScrollView>
        </View></View>
      </Modal>

      <Modal visible={picker!==null} transparent animationType="fade" onRequestClose={()=>setPicker(null)}>
        <View style={styles.modalOverlay}><View style={styles.pickerCard}>
          <View style={styles.addRowHeader}><Text style={styles.modalTitle}>{picker==="category"?"Select Category":"Select Size"}</Text><Pressable onPress={()=>setPicker(null)}><Ionicons name="close" size={22} color={colors.onSurface}/></Pressable></View>
          {picker==="category"?<><TextInput value={newCategory} onChangeText={setNewCategory} placeholder="New category" placeholderTextColor={colors.muted} style={styles.input}/>{categories.map((cat:any)=><Pressable key={cat.id} style={styles.pickerItem} onPress={()=>{setAddRows(rows=>rows.map((r,i)=>i===0?{...r,categoryId:cat.id,category:cat.name}:r));setPicker(null);}}><Text style={styles.dropdownText}>{cat.name}</Text></Pressable>)}<Pressable style={styles.addAnother} onPress={createCategory}><Text style={styles.addAnotherText}>+ Create new category</Text></Pressable></>:<><TextInput placeholder="Type new size" placeholderTextColor={colors.muted} style={styles.input} onChangeText={v=>setAddRows(rows=>rows.map((r,i)=>i===0?{...r,size:v}:r))}/>{allSizes.map(s=><Pressable key={s} style={styles.pickerItem} onPress={()=>{setAddRows(rows=>rows.map((r,i)=>i===0?{...r,size:s}:r));setPicker(null);}}><Text style={styles.dropdownText}>{s}</Text></Pressable>)}</>}
        </View></View>
      </Modal>

      {/* Edit modal */}
      <Modal visible={!!editItem} transparent animationType="slide" onRequestClose={() => setEditItem(null)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { paddingBottom: insets.bottom + spacing.lg }]}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Edit Inventory Item</Text>
            {editItem ? (
              <KeyboardAwareScrollView bottomOffset={40} keyboardShouldPersistTaps="handled">
                <Field
                  label="Category"
                  testID="edit-category-input"
                  value={editItem.category}
                  onChangeText={(v) => setEditItem({ ...editItem, category: v })}
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
  headerActionText: { fontFamily:fontFamily.semibold, fontSize:fontSize.sm, color:colors.brandPrimary },
  selectedRow: { borderWidth:2, borderColor:colors.brandPrimary },
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
