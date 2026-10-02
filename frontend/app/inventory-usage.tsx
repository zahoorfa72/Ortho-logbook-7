import { useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import Ionicons from "@react-native-vector-icons/ionicons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api } from "@/src/api/client";
import { useAuth } from "@/src/auth/AuthContext";
import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";

type Period = "month" | "year" | "all";
type UsageRow = {
  id: string;
  category: string;
  name: string;
  size: string;
  quantity: number;
  usageLevel: "high" | "medium" | "low";
  rank: number;
};

const now = new Date();
const YEARS = Array.from({ length: 8 }, (_, i) => now.getFullYear() - i);
const MONTHS = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

export default function InventoryUsage() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [period, setPeriod] = useState<Period>("month");
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  const path = useMemo(() => {
    const params = new URLSearchParams({ period });
    if (period !== "all") params.set("year", String(year));
    if (period === "month") params.set("month", String(month));
    return "/inventory-usage?" + params.toString();
  }, [period, year, month]);

  const q = useQuery<UsageRow[]>({
    queryKey: ["inventory-usage", period, year, month, user?.id],
    queryFn: () => api.get<UsageRow[]>(path),
  });

  const summary = useMemo(() => {
    const rows = q.data || [];
    return {
      total: rows.reduce((n, x) => n + Number(x.quantity || 0), 0),
      high: rows.filter(x => x.usageLevel === "high").length,
      medium: rows.filter(x => x.usageLevel === "medium").length,
      low: rows.filter(x => x.usageLevel === "low").length,
    };
  }, [q.data]);

  const periodLabel = period === "all"
    ? "All time"
    : period === "year"
      ? String(year)
      : `${MONTHS[month - 1]} ${year}`;

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
            <Text style={styles.subtitle}>Most and least used items</Text>
          </View>
          <View style={styles.periodBadge}><Text style={styles.periodBadgeText}>{periodLabel}</Text></View>
        </View>

        <View style={styles.segment}>
          {(["month", "year", "all"] as Period[]).map(p => (
            <Pressable key={p} onPress={() => setPeriod(p)} style={[styles.segmentBtn, period === p && styles.segmentBtnActive]} testID={`usage-period-${p}`}>
              <Text style={[styles.segmentText, period === p && styles.segmentTextActive]}>
                {p === "month" ? "Month" : p === "year" ? "Year" : "All time"}
              </Text>
            </Pressable>
          ))}
        </View>

        {period !== "all" ? (
          <View style={styles.selectorRow}>
            <View style={styles.selector}>
              <Pressable onPress={() => setYear(y => Math.max(YEARS[YEARS.length - 1], y - 1))}>
                <Ionicons name="chevron-back" size={18} color={colors.onSurfaceSecondary} />
              </Pressable>
              <Text style={styles.selectorText}>{year}</Text>
              <Pressable onPress={() => setYear(y => Math.min(YEARS[0], y + 1))}>
                <Ionicons name="chevron-forward" size={18} color={colors.onSurfaceSecondary} />
              </Pressable>
            </View>
            {period === "month" ? (
              <View style={styles.monthWrap}>
                <Pressable onPress={() => setMonth(m => m === 1 ? 12 : m - 1)}><Ionicons name="chevron-back" size={18} color={colors.onSurfaceSecondary} /></Pressable>
                <Text style={styles.selectorText}>{MONTHS[month - 1]}</Text>
                <Pressable onPress={() => setMonth(m => m === 12 ? 1 : m + 1)}><Ionicons name="chevron-forward" size={18} color={colors.onSurfaceSecondary} /></Pressable>
              </View>
            ) : null}
          </View>
        ) : null}
      </View>

      <View style={styles.summary}>
        <View style={styles.summaryCard}><Text style={styles.summaryValue}>{summary.total}</Text><Text style={styles.summaryLabel}>Units used</Text></View>
        <View style={styles.summaryCard}><Text style={styles.summaryValue}>{summary.high}</Text><Text style={styles.summaryLabel}>High usage</Text></View>
        <View style={styles.summaryCard}><Text style={styles.summaryValue}>{summary.medium}</Text><Text style={styles.summaryLabel}>Medium</Text></View>
        <View style={styles.summaryCard}><Text style={styles.summaryValue}>{summary.low}</Text><Text style={styles.summaryLabel}>Low</Text></View>
      </View>

      {q.isLoading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={colors.brandPrimary} /></View>
      ) : q.isError ? (
        <View style={styles.center}><Text style={styles.title}>Could not load usage data.</Text></View>
      ) : (
        <FlatList
          data={q.data || []}
          keyExtractor={x => x.id}
          refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={q.refetch} />}
          contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + spacing.xl, flexGrow: 1 }}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="analytics-outline" size={48} color={colors.muted} />
              <Text style={styles.emptyTitle}>No usage in this period</Text>
              <Text style={styles.emptyText}>Inventory usage will appear here after items are used in patient records.</Text>
            </View>
          }
          renderItem={({ item, index }) => (
            <View style={styles.row}>
              <View style={styles.rank}><Text style={styles.rankText}>{index + 1}</Text></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.itemName} numberOfLines={2}>{[item.category, item.name, item.size].filter(Boolean).join(" · ")}</Text>
                <Text style={styles.itemMeta}>Used {item.quantity} {item.quantity === 1 ? "unit" : "units"}</Text>
              </View>
              <View style={[styles.level, item.usageLevel === "high" ? styles.high : item.usageLevel === "medium" ? styles.medium : styles.low]}>
                <Text style={styles.levelText}>{item.usageLevel.toUpperCase()}</Text>
              </View>
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
  title: { fontFamily: fontFamily.bold, fontSize: fontSize.xl, color: colors.onSurface },
  subtitle: { fontFamily: fontFamily.regular, fontSize: fontSize.sm, color: colors.muted, marginTop: 2 },
  periodBadge: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, borderRadius: radius.md, backgroundColor: colors.brandTertiary, maxWidth: 115 },
  periodBadgeText: { fontFamily: fontFamily.semibold, fontSize: fontSize.xs, color: colors.brandPrimary },
  segment: { flexDirection: "row", backgroundColor: colors.surfaceSecondary, borderRadius: radius.md, padding: 3, marginTop: spacing.md },
  segmentBtn: { flex: 1, alignItems: "center", paddingVertical: spacing.sm, borderRadius: radius.sm },
  segmentBtnActive: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  segmentText: { fontFamily: fontFamily.semibold, fontSize: fontSize.sm, color: colors.muted },
  segmentTextActive: { color: colors.brandPrimary },
  selectorRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm },
  selector: { flex: 1, minHeight: 42, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surfaceSecondary, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.sm },
  monthWrap: { flex: 1, minHeight: 42, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surfaceSecondary, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.sm },
  selectorText: { fontFamily: fontFamily.semibold, color: colors.onSurface, fontSize: fontSize.sm },
  summary: { flexDirection: "row", gap: spacing.xs, padding: spacing.sm },
  summaryCard: { flex: 1, backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingVertical: spacing.sm, alignItems: "center" },
  summaryValue: { fontFamily: fontFamily.bold, fontSize: fontSize.lg, color: colors.onSurface },
  summaryLabel: { fontFamily: fontFamily.regular, fontSize: 10, color: colors.muted, marginTop: 2, textAlign: "center" },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm, backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: spacing.md, marginBottom: spacing.sm },
  rank: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.surfaceSecondary, alignItems: "center", justifyContent: "center" },
  rankText: { fontFamily: fontFamily.bold, color: colors.onSurface },
  itemName: { fontFamily: fontFamily.semibold, fontSize: fontSize.sm, color: colors.onSurface },
  itemMeta: { fontFamily: fontFamily.regular, fontSize: fontSize.xs, color: colors.muted, marginTop: 3 },
  level: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, borderRadius: radius.md },
  high: { backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.border },
  medium: { backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.border },
  low: { backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.border },
  levelText: { fontFamily: fontFamily.bold, fontSize: 10, color: colors.onSurface },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.lg },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl },
  emptyTitle: { fontFamily: fontFamily.bold, fontSize: fontSize.lg, color: colors.onSurface, textAlign: "center", marginTop: spacing.md },
  emptyText: { fontFamily: fontFamily.regular, fontSize: fontSize.sm, color: colors.muted, textAlign: "center", marginTop: spacing.xs, lineHeight: 20 },
}));
