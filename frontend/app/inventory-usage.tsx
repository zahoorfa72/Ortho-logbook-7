import { useMemo, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, Text, TextInput, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import Ionicons from "@react-native-vector-icons/ionicons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";

import { api } from "@/src/api/client";
import { useAuth } from "@/src/auth/AuthContext";
import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";

type Period = "month" | "year" | "all";
type ScreenMode = "usage" | "requirements";
type UsageRow = {
  id: string; category: string; name: string; size: string;
  quantity: number; usageLevel: "high" | "medium" | "low"; rank: number;
};
type RequirementRow = {
  id: string; category: string; name: string; size: string; unit: string;
  currentStock: number; usedQuantity: number; requirementQuantity: number; isEdited: boolean;
};

const now = new Date();
const YEARS = Array.from({ length: 8 }, (_, i) => now.getFullYear() - i);
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch] || ch));

export default function InventoryUsage() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<ScreenMode>("usage");
  const [period, setPeriod] = useState<Period>("month");
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [drafts, setDrafts] = useState<Record<string,string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  const path = useMemo(() => {
    const params = new URLSearchParams({ period });
    if (period !== "all") params.set("year", String(year));
    if (period === "month") params.set("month", String(month));
    return "/inventory-usage?" + params.toString();
  }, [period, year, month]);

  const usageQuery = useQuery<UsageRow[]>({
    queryKey: ["inventory-usage", period, year, month, user?.id],
    queryFn: () => api.get<UsageRow[]>(path),
    enabled: mode === "usage",
  });
  const requirementsQuery = useQuery<RequirementRow[]>({
    queryKey: ["inventory-yearly-requirements", year, user?.id],
    queryFn: () => api.get<RequirementRow[]>(`/inventory-yearly-requirements?year=${year}`),
    enabled: mode === "requirements",
  });

  const summary = useMemo(() => {
    const rows = usageQuery.data || [];
    return {
      total: rows.reduce((n, x) => n + Number(x.quantity || 0), 0),
      high: rows.filter(x => x.usageLevel === "high").length,
      medium: rows.filter(x => x.usageLevel === "medium").length,
      low: rows.filter(x => x.usageLevel === "low").length,
    };
  }, [usageQuery.data]);

  const periodLabel = period === "all" ? "All time" : period === "year" ? String(year) : `${MONTHS[month - 1]} ${year}`;

  const saveRequirement = async (item: RequirementRow) => {
    const raw = drafts[item.id] ?? String(item.requirementQuantity);
    const quantity = Math.ceil(Number(raw));
    if (!Number.isFinite(quantity) || quantity < 3) {
      Alert.alert("Invalid requirement", "Requirement quantity cannot be below 3.");
      return;
    }
    setSavingId(item.id);
    try {
      await api.post("/inventory-yearly-requirements", { year, inventoryId:item.id, requiredQuantity:quantity });
      setDrafts(current => { const next = { ...current }; delete next[item.id]; return next; });
      await queryClient.invalidateQueries({ queryKey:["inventory-yearly-requirements", year] });
      Alert.alert("Saved", "Annual requirement updated.");
    } catch (error:any) {
      Alert.alert("Could not save", error?.message || "Please try again.");
    } finally {
      setSavingId(null);
    }
  };

  const exportPdf = async () => {
    const rows = requirementsQuery.data || [];
    if (!rows.length) {
      Alert.alert("No inventory", "There are no inventory items to export.");
      return;
    }
    const body = rows.map(item => `<tr><td>${escapeHtml(item.category)}</td><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.size || "—")}</td><td>${escapeHtml(item.unit)}</td><td class="qty">${Math.max(3, Math.ceil(Number(item.requirementQuantity) || 3))}</td></tr>`).join("");
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      body{font-family:Arial,sans-serif;padding:24px;color:#171717}h1{font-size:20px;margin:0 0 6px}
      p{color:#555;margin:0 0 18px;font-size:12px}table{width:100%;border-collapse:collapse;font-size:11px}
      th{background:#222;color:#fff;text-align:left}th,td{padding:9px 7px;border:1px solid #ddd}
      tr:nth-child(even){background:#f5f5f5}.qty{text-align:right;font-weight:bold}
      </style></head><body><h1>Yearly Inventory Requirements — ${year}</h1>
      <p>Annual requirement by item and size. Requirement quantities are editable and never below 3.</p>
      <table><thead><tr><th>Category</th><th>Item name</th><th>Size</th><th>Unit</th><th>Requirement quantity</th></tr></thead><tbody>${body}</tbody></table>
      </body></html>`;
    try {
      const file = await Print.printToFileAsync({ html });
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri, { mimeType:"application/pdf", dialogTitle:`Yearly Inventory Requirements ${year}` });
      else Alert.alert("PDF created", file.uri);
    } catch (error:any) {
      Alert.alert("PDF export failed", error?.message || "Unable to create PDF.");
    }
  };

  if (user?.role !== "admin") {
    return <View style={styles.center}><Text style={styles.title}>Administrator permission required.</Text></View>;
  }

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <View style={styles.headerTop}>
          <Pressable onPress={() => router.back()} style={styles.iconBtn} testID="inventory-usage-back">
            <Ionicons name="arrow-back" size={22} color={colors.onSurface} />
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Inventory Usage</Text>
            <Text style={styles.subtitle}>Usage history and annual item requirements</Text>
          </View>
        </View>
        <View style={styles.segment}>
          <Pressable onPress={() => setMode("usage")} style={[styles.segmentBtn, mode === "usage" && styles.segmentBtnActive]}><Text style={[styles.segmentText, mode === "usage" && styles.segmentTextActive]}>Usage</Text></Pressable>
          <Pressable onPress={() => setMode("requirements")} style={[styles.segmentBtn, mode === "requirements" && styles.segmentBtnActive]}><Text style={[styles.segmentText, mode === "requirements" && styles.segmentTextActive]}>Yearly Requirements</Text></Pressable>
        </View>
        {mode === "usage" ? <>
          <View style={styles.periodBadge}><Text style={styles.periodBadgeText}>{periodLabel}</Text></View>
          <View style={styles.segment}>
            {(["month", "year", "all"] as Period[]).map(p => (
              <Pressable key={p} onPress={() => setPeriod(p)} style={[styles.segmentBtn, period === p && styles.segmentBtnActive]} testID={`usage-period-${p}`}>
                <Text style={[styles.segmentText, period === p && styles.segmentTextActive]}>{p === "month" ? "Month" : p === "year" ? "Year" : "All time"}</Text>
              </Pressable>
            ))}
          </View>
        </> : (
          <View style={styles.requirementHeader}>
            <View style={styles.selector}>
              <Pressable onPress={() => setYear(y => Math.max(YEARS[YEARS.length - 1], y - 1))}><Ionicons name="chevron-back" size={18} color={colors.onSurfaceSecondary} /></Pressable>
              <Text style={styles.selectorText}>{year}</Text>
              <Pressable onPress={() => setYear(y => Math.min(YEARS[0], y + 1))}><Ionicons name="chevron-forward" size={18} color={colors.onSurfaceSecondary} /></Pressable>
            </View>
            <Pressable onPress={exportPdf} style={styles.exportBtn} disabled={requirementsQuery.isLoading}>
              <Ionicons name="download-outline" size={18} color={colors.onSurface} />
              <Text style={styles.exportText}>Download PDF</Text>
            </Pressable>
          </View>
        )}
        {mode === "usage" && period !== "all" ? (
          <View style={styles.selectorRow}>
            <View style={styles.selector}>
              <Pressable onPress={() => setYear(y => Math.max(YEARS[YEARS.length - 1], y - 1))}><Ionicons name="chevron-back" size={18} color={colors.onSurfaceSecondary} /></Pressable>
              <Text style={styles.selectorText}>{year}</Text>
              <Pressable onPress={() => setYear(y => Math.min(YEARS[0], y + 1))}><Ionicons name="chevron-forward" size={18} color={colors.onSurfaceSecondary} /></Pressable>
            </View>
            {period === "month" ? <View style={styles.monthWrap}>
              <Pressable onPress={() => setMonth(m => m === 1 ? 12 : m - 1)}><Ionicons name="chevron-back" size={18} color={colors.onSurfaceSecondary} /></Pressable>
              <Text style={styles.selectorText}>{MONTHS[month - 1]}</Text>
              <Pressable onPress={() => setMonth(m => m === 12 ? 1 : m + 1)}><Ionicons name="chevron-forward" size={18} color={colors.onSurfaceSecondary} /></Pressable>
            </View> : null}
          </View>
        ) : null}
      </View>

      {mode === "usage" ? <>
        <View style={styles.summary}>
          <View style={styles.summaryCard}><Text style={styles.summaryValue}>{summary.total}</Text><Text style={styles.summaryLabel}>Units used</Text></View>
          <View style={styles.summaryCard}><Text style={styles.summaryValue}>{summary.high}</Text><Text style={styles.summaryLabel}>High usage</Text></View>
          <View style={styles.summaryCard}><Text style={styles.summaryValue}>{summary.medium}</Text><Text style={styles.summaryLabel}>Medium</Text></View>
          <View style={styles.summaryCard}><Text style={styles.summaryValue}>{summary.low}</Text><Text style={styles.summaryLabel}>Low</Text></View>
        </View>
        {usageQuery.isLoading ? <View style={styles.center}><ActivityIndicator size="large" color={colors.brandPrimary} /></View> : usageQuery.isError ? <View style={styles.center}><Text style={styles.title}>Could not load usage data.</Text></View> : (
          <FlatList data={usageQuery.data || []} keyExtractor={x => x.id} refreshControl={<RefreshControl refreshing={usageQuery.isRefetching} onRefresh={usageQuery.refetch} />}
            contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + spacing.xl, flexGrow: 1 }}
            ListEmptyComponent={<View style={styles.empty}><Ionicons name="analytics-outline" size={48} color={colors.muted} /><Text style={styles.emptyTitle}>No usage in this period</Text><Text style={styles.emptyText}>Inventory usage will appear here after items are used in patient records.</Text></View>}
            renderItem={({item,index}) => <View style={styles.row}>
              <View style={styles.rank}><Text style={styles.rankText}>{index+1}</Text></View>
              <View style={{flex:1}}><Text style={styles.itemName} numberOfLines={2}>{[item.category,item.name,item.size].filter(Boolean).join(" · ")}</Text><Text style={styles.itemMeta}>Used {item.quantity} {item.quantity===1?"unit":"units"}</Text></View>
              <View style={styles.level}><Text style={styles.levelText}>{item.usageLevel.toUpperCase()}</Text></View>
            </View>}
          />
        )}
      </> : (
        <>
          <View style={styles.requirementNote}><Text style={styles.noteText}>Calculated from patient implant usage for the selected calendar year, with a 10% buffer. Every size is listed separately. You can edit each quantity; minimum is 3.</Text></View>
          {requirementsQuery.isLoading ? <View style={styles.center}><ActivityIndicator size="large" color={colors.brandPrimary} /></View> : requirementsQuery.isError ? <View style={styles.center}><Text style={styles.title}>Could not load yearly requirements.</Text></View> : (
            <FlatList data={requirementsQuery.data || []} keyExtractor={x=>x.id} refreshControl={<RefreshControl refreshing={requirementsQuery.isRefetching} onRefresh={requirementsQuery.refetch}/>}
              contentContainerStyle={{padding:spacing.lg,paddingBottom:insets.bottom+spacing.xl,flexGrow:1}}
              ListEmptyComponent={<View style={styles.empty}><Ionicons name="clipboard-outline" size={48} color={colors.muted}/><Text style={styles.emptyTitle}>No inventory items found</Text></View>}
              renderItem={({item}) => {
                const value=drafts[item.id] ?? String(item.requirementQuantity);
                return <View style={styles.requirementCard}>
                  <View style={{flex:1}}>
                    <Text style={styles.itemName}>{item.name}</Text>
                    <Text style={styles.itemMeta}>{[item.category,item.size ? `Size: ${item.size}` : "Size: —",item.unit].filter(Boolean).join(" · ")}</Text>
                    <Text style={styles.itemMeta}>Used this year: {item.usedQuantity} · Current stock: {item.currentStock}</Text>
                  </View>
                  <View style={styles.editColumn}>
                    <Text style={styles.editLabel}>Annual qty</Text>
                    <TextInput value={value} onChangeText={v=>setDrafts(current=>({...current,[item.id]:v}))} keyboardType="number-pad" selectTextOnFocus style={styles.quantityInput} />
                    <Pressable onPress={()=>saveRequirement(item)} disabled={savingId===item.id} style={[styles.saveBtn,savingId===item.id&&styles.disabledBtn]}>
                      {savingId===item.id?<ActivityIndicator size="small" color={colors.onSurface}/>:<Text style={styles.saveText}>Save</Text>}
                    </Pressable>
                  </View>
                </View>;
              }}
            />
          )}
        </>
      )}
    </View>
  );
}

const useStyles = makeStyles(colors => ({
  container:{flex:1,backgroundColor:colors.surfaceSecondary},
  header:{backgroundColor:colors.surface,paddingHorizontal:spacing.lg,paddingBottom:spacing.md,borderBottomWidth:1,borderBottomColor:colors.border},
  headerTop:{flexDirection:"row",alignItems:"center",gap:spacing.sm},
  iconBtn:{width:40,height:40,borderRadius:radius.md,borderWidth:1,borderColor:colors.border,alignItems:"center",justifyContent:"center",backgroundColor:colors.surfaceSecondary},
  title:{fontFamily:fontFamily.bold,fontSize:fontSize.xl,color:colors.onSurface},
  subtitle:{fontFamily:fontFamily.regular,fontSize:fontSize.sm,color:colors.muted,marginTop:2},
  segment:{flexDirection:"row",backgroundColor:colors.surfaceSecondary,borderRadius:radius.md,padding:3,marginTop:spacing.md},
  segmentBtn:{flex:1,alignItems:"center",paddingVertical:spacing.sm,borderRadius:radius.sm},
  segmentBtnActive:{backgroundColor:colors.surface,borderWidth:1,borderColor:colors.border},
  segmentText:{fontFamily:fontFamily.semibold,fontSize:fontSize.sm,color:colors.muted},
  segmentTextActive:{color:colors.brandPrimary},
  periodBadge:{alignSelf:"flex-end",paddingHorizontal:spacing.sm,paddingVertical:spacing.xs,borderRadius:radius.md,backgroundColor:colors.brandTertiary,marginTop:spacing.sm},
  periodBadgeText:{fontFamily:fontFamily.semibold,fontSize:fontSize.xs,color:colors.brandPrimary},
  selectorRow:{flexDirection:"row",gap:spacing.sm,marginTop:spacing.sm},
  selector:{flex:1,minHeight:42,borderWidth:1,borderColor:colors.border,borderRadius:radius.md,backgroundColor:colors.surfaceSecondary,flexDirection:"row",alignItems:"center",justifyContent:"space-between",paddingHorizontal:spacing.sm},
  monthWrap:{flex:1,minHeight:42,borderWidth:1,borderColor:colors.border,borderRadius:radius.md,backgroundColor:colors.surfaceSecondary,flexDirection:"row",alignItems:"center",justifyContent:"space-between",paddingHorizontal:spacing.sm},
  selectorText:{fontFamily:fontFamily.semibold,color:colors.onSurface,fontSize:fontSize.sm},
  summary:{flexDirection:"row",gap:spacing.xs,padding:spacing.sm},
  summaryCard:{flex:1,backgroundColor:colors.surface,borderRadius:radius.md,borderWidth:1,borderColor:colors.border,paddingVertical:spacing.sm,alignItems:"center"},
  summaryValue:{fontFamily:fontFamily.bold,fontSize:fontSize.lg,color:colors.onSurface},
  summaryLabel:{fontFamily:fontFamily.regular,fontSize:10,color:colors.muted,marginTop:2,textAlign:"center"},
  row:{flexDirection:"row",alignItems:"center",gap:spacing.sm,backgroundColor:colors.surface,borderRadius:radius.md,borderWidth:1,borderColor:colors.border,padding:spacing.md,marginBottom:spacing.sm},
  rank:{width:34,height:34,borderRadius:17,backgroundColor:colors.surfaceSecondary,alignItems:"center",justifyContent:"center"},
  rankText:{fontFamily:fontFamily.bold,color:colors.onSurface},
  itemName:{fontFamily:fontFamily.semibold,fontSize:fontSize.sm,color:colors.onSurface},
  itemMeta:{fontFamily:fontFamily.regular,fontSize:fontSize.xs,color:colors.muted,marginTop:3},
  level:{paddingHorizontal:spacing.sm,paddingVertical:spacing.xs,borderRadius:radius.md,backgroundColor:colors.surfaceSecondary,borderWidth:1,borderColor:colors.border},
  levelText:{fontFamily:fontFamily.bold,fontSize:10,color:colors.onSurface},
  requirementHeader:{flexDirection:"row",alignItems:"center",gap:spacing.sm,marginTop:spacing.md},
  exportBtn:{minHeight:42,paddingHorizontal:spacing.md,borderRadius:radius.md,borderWidth:1,borderColor:colors.border,backgroundColor:colors.surfaceSecondary,flexDirection:"row",alignItems:"center",gap:spacing.xs},
  exportText:{fontFamily:fontFamily.semibold,fontSize:fontSize.sm,color:colors.onSurface},
  requirementNote:{paddingHorizontal:spacing.lg,paddingTop:spacing.sm},
  noteText:{fontFamily:fontFamily.regular,fontSize:fontSize.xs,color:colors.muted,lineHeight:18},
  requirementCard:{flexDirection:"row",alignItems:"center",gap:spacing.sm,backgroundColor:colors.surface,borderRadius:radius.md,borderWidth:1,borderColor:colors.border,padding:spacing.md,marginBottom:spacing.sm},
  editColumn:{width:92,alignItems:"stretch"},
  editLabel:{fontFamily:fontFamily.semibold,fontSize:10,color:colors.muted,textAlign:"center",marginBottom:3},
  quantityInput:{height:38,borderWidth:1,borderColor:colors.border,borderRadius:radius.sm,paddingHorizontal:spacing.xs,textAlign:"center",fontFamily:fontFamily.bold,fontSize:fontSize.base,color:colors.onSurface,backgroundColor:colors.surfaceSecondary},
  saveBtn:{marginTop:5,minHeight:30,alignItems:"center",justifyContent:"center",borderRadius:radius.sm,backgroundColor:colors.surfaceSecondary,borderWidth:1,borderColor:colors.border},
  saveText:{fontFamily:fontFamily.semibold,fontSize:fontSize.xs,color:colors.brandPrimary},
  disabledBtn:{opacity:0.5},
  center:{flex:1,alignItems:"center",justifyContent:"center",padding:spacing.lg},
  empty:{flex:1,alignItems:"center",justifyContent:"center",padding:spacing.xl},
  emptyTitle:{fontFamily:fontFamily.bold,fontSize:fontSize.lg,color:colors.onSurface,textAlign:"center",marginTop:spacing.md},
  emptyText:{fontFamily:fontFamily.regular,fontSize:fontSize.sm,color:colors.muted,textAlign:"center",marginTop:spacing.xs,lineHeight:20},
}));
