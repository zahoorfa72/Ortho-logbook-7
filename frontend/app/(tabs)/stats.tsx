import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import Ionicons from "@react-native-vector-icons/ionicons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api } from "@/src/api/client";
import { useAuth } from "@/src/auth/AuthContext";
import { EmptyState } from "@/src/components/EmptyState";
import { PinPromptModal } from "@/src/components/PinPromptModal";
import { Segmented } from "@/src/components/Segmented";
import { useToast } from "@/src/components/toast";
import { usesNativeTabs } from "@/src/navigation";
import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";
import { hasAdminPin } from "@/src/utils/admin-pin";
import { buildStatsHtml, generateAndSharePdf } from "@/src/utils/pdf";

type Stats = { total_patients: number; procedures: { name: string; count: number }[] };

const HERO = require("../../assets/images/icon.png");

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export default function StatsScreen() {
  const styles = useStyles();
  const { colors, branding } = useTheme();
  const insets = useSafeAreaInsets();
  const bottomChrome = usesNativeTabs ? insets.bottom : 0;
  const now = new Date();
  const { user } = useAuth();
  const toast = useToast();

  const [scope, setScope] = useState("Monthly");
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [pinPromptOpen, setPinPromptOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const isMonthly = scope === "Monthly";

  const { data, isLoading } = useQuery<Stats>({
    queryKey: ["stats", scope, year, month],
    queryFn: () =>
      api.get<Stats>(
        `/stats?scope=${isMonthly ? "monthly" : "yearly"}&year=${year}${isMonthly ? `&month=${month}` : ""}`,
      ),
  });

  const maxCount = Math.max(1, ...(data?.procedures || []).map((p) => p.count));
  const periodLabel = isMonthly ? `${MONTHS[month - 1]} ${year}` : `Year ${year}`;

  const doExport = useCallback(async () => {
    if (!data) return;
    setExporting(true);
    try {
      const html = buildStatsHtml(branding, data, periodLabel);
      await generateAndSharePdf(html, `Statistics ${periodLabel}`);
    } catch (e: any) {
      toast(e?.message || "Could not create PDF.", "error");
    } finally {
      setExporting(false);
    }
  }, [branding, data, periodLabel, toast]);

  const requestExport = useCallback(async () => {
    if (await hasAdminPin()) setPinPromptOpen(true);
    else doExport();
  }, [doExport]);

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: bottomChrome + spacing.xl }}
        showsVerticalScrollIndicator={false}
      >
        {/* Hero */}
        <View style={styles.hero}>
          <Image source={HERO} style={styles.heroImg} contentFit="cover" />
          <LinearGradient
            colors={["rgba(15,23,42,0.55)", "rgba(15,23,42,0.92)"]}
            style={styles.heroScrim}
          />
          <View style={[styles.heroContent, { paddingTop: insets.top + spacing.lg }]}>
            <View style={styles.heroTopRow}>
              <Text style={styles.heroLabel}>Statistics</Text>
              {user?.role === "admin" ? (
                <Pressable
                  testID="stats-export-pdf"
                  onPress={requestExport}
                  style={styles.heroExport}
                  disabled={exporting}
                >
                  {exporting ? (
                    <ActivityIndicator size="small" color="#FFF" />
                  ) : (
                    <Ionicons name="download-outline" size={18} color="#FFF" />
                  )}
                  <Text style={styles.heroExportText}>Export PDF</Text>
                </Pressable>
              ) : null}
            </View>
            <Text style={styles.heroPeriod}>{periodLabel}</Text>
            {isLoading ? (
              <ActivityIndicator color={colors.onSurfaceInverse} style={{ marginTop: spacing.lg }} />
            ) : (
              <>
                <Text style={styles.bigNumber} testID="stats-total">
                  {data?.total_patients ?? 0}
                </Text>
                <Text style={styles.bigLabel}>Total Surgeries</Text>
              </>
            )}
          </View>
        </View>

        <View style={styles.body}>
          <Segmented options={["Monthly", "Yearly"]} value={scope} onChange={setScope} testIDPrefix="stats-scope" />

          <View style={styles.selectors}>
            {isMonthly && (
              <Stepper
                testID="stats-month"
                label={MONTHS[month - 1]}
                onPrev={() => setMonth((m) => (m === 1 ? 12 : m - 1))}
                onNext={() => setMonth((m) => (m === 12 ? 1 : m + 1))}
              />
            )}
            <Stepper
              testID="stats-year"
              label={String(year)}
              mono
              onPrev={() => setYear((y) => y - 1)}
              onNext={() => setYear((y) => y + 1)}
            />
          </View>

          <Text style={styles.section}>Procedure Breakdown</Text>
          {isLoading ? (
            <ActivityIndicator color={colors.brandPrimary} style={{ marginTop: spacing.xl }} />
          ) : !data?.procedures.length ? (
            <EmptyState icon="stats-chart-outline" title="Not enough data yet" subtitle="Log patients to see stats." />
          ) : (
            data.procedures.map((proc) => (
              <View key={proc.name} style={styles.statRow} testID={`stat-row-${proc.name}`}>
                <View style={styles.statTop}>
                  <Text style={styles.statName} numberOfLines={1}>
                    {proc.name}
                  </Text>
                  <Text style={styles.statCount}>{proc.count}</Text>
                </View>
                <View style={styles.barTrack}>
                  <View style={[styles.barFill, { width: `${(proc.count / maxCount) * 100}%` }]} />
                </View>
              </View>
            ))
          )}
        </View>
      </ScrollView>

      <PinPromptModal
        visible={pinPromptOpen}
        title="Admin PIN required"
        description="Enter admin PIN to export statistics."
        onSuccess={() => {
          setPinPromptOpen(false);
          doExport();
        }}
        onCancel={() => setPinPromptOpen(false)}
      />
    </View>
  );
}

function Stepper({
  label,
  onPrev,
  onNext,
  mono,
  testID,
}: {
  label: string;
  onPrev: () => void;
  onNext: () => void;
  mono?: boolean;
  testID: string;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <View style={styles.stepper}>
      <Pressable testID={`${testID}-prev`} onPress={onPrev} style={styles.stepBtn} hitSlop={6}>
        <Ionicons name="chevron-back" size={18} color={colors.onSurface} />
      </Pressable>
      <Text style={[styles.stepLabel, mono && styles.stepLabelMono]} testID={`${testID}-value`}>
        {label}
      </Text>
      <Pressable testID={`${testID}-next`} onPress={onNext} style={styles.stepBtn} hitSlop={6}>
        <Ionicons name="chevron-forward" size={18} color={colors.onSurface} />
      </Pressable>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  container: { flex: 1, backgroundColor: colors.surfaceSecondary },
  hero: { height: 260, backgroundColor: colors.surfaceInverse },
  heroImg: { ...({ position: "absolute" } as const), top: 0, left: 0, right: 0, bottom: 0 },
  heroScrim: { ...({ position: "absolute" } as const), top: 0, left: 0, right: 0, bottom: 0 },
  heroContent: { flex: 1, paddingHorizontal: spacing.xl, justifyContent: "center" },
  heroTopRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  heroExport: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: "rgba(255,255,255,0.18)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.35)",
  },
  heroExportText: { color: "#FFF", fontFamily: fontFamily.semibold, fontSize: fontSize.sm },
  heroLabel: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSize.sm,
    color: colors.onSurfaceInverse,
    opacity: 0.8,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  heroPeriod: { fontFamily: fontFamily.medium, fontSize: fontSize.base, color: colors.onSurfaceInverse, opacity: 0.9 },
  bigNumber: {
    fontFamily: fontFamily.monoBold,
    fontSize: fontSize.huge,
    color: colors.onSurfaceInverse,
    marginTop: spacing.sm,
  },
  bigLabel: { fontFamily: fontFamily.medium, fontSize: fontSize.lg, color: colors.onSurfaceInverse, opacity: 0.9 },
  body: { padding: spacing.lg },
  selectors: { flexDirection: "row", gap: spacing.md, marginTop: spacing.lg },
  stepper: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  stepBtn: {
    width: 34,
    height: 34,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceTertiary,
    alignItems: "center",
    justifyContent: "center",
  },
  stepLabel: { flex: 1, textAlign: "center", fontFamily: fontFamily.semibold, fontSize: fontSize.base, color: colors.onSurface },
  stepLabelMono: { fontFamily: fontFamily.monoMedium },
  section: {
    fontFamily: fontFamily.bold,
    fontSize: fontSize.sm,
    color: colors.brandPrimary,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginTop: spacing.xl,
    marginBottom: spacing.md,
  },
  statRow: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  statTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.sm },
  statName: { flex: 1, fontFamily: fontFamily.semibold, fontSize: fontSize.base, color: colors.onSurface },
  statCount: { fontFamily: fontFamily.monoBold, fontSize: fontSize.lg, color: colors.brandPrimary, marginLeft: spacing.md },
  barTrack: { height: 8, borderRadius: 4, backgroundColor: colors.surfaceTertiary, overflow: "hidden" },
  barFill: { height: 8, borderRadius: 4, backgroundColor: colors.brandSecondary },
}));
