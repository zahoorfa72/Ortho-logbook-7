import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { useMemo } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  Text,
  View,
} from "react-native";
import Ionicons from "@react-native-vector-icons/ionicons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api } from "@/src/api/client";
import { EmptyState } from "@/src/components/EmptyState";
import { usesNativeTabs } from "@/src/navigation";
import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";

type Patient = {
  id: string;
  mrNo?: string;
  name?: string;
  diagnosis?: string;
  procedure?: string;
  procedureII?: string;
  date?: string;
};

export default function ProcedureCheckScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const bottomChrome = usesNativeTabs ? insets.bottom : 0;
  const { data = [], isLoading, isError, refetch, isRefetching } = useQuery<Patient[]>({
    queryKey: ["patients"],
    queryFn: () => api.get("/patients"),
  });

  // A blank primary procedure means the record needs review. Do not assume
  // that a blank optional second procedure means surgery was not performed.
  const missing = useMemo(
    () => data.filter((patient) => !String(patient.procedure || "").trim())
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))),
    [data],
  );

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <View style={styles.titleRow}>
          <View style={styles.titleIcon}>
            <Ionicons name="clipboard-outline" size={22} color={colors.onSurface} />
          </View>
          <View style={styles.titleBlock}>
            <Text style={styles.title}>Procedure Check</Text>
            <Text style={styles.subtitle}>Patients needing procedure-record review</Text>
          </View>
        </View>
        <View style={styles.countPill} testID="missing-procedure-count">
          <View style={styles.redDot} />
          <Text style={styles.countText}>{missing.length} pending</Text>
        </View>
      </View>

      {missing.length > 0 && !isLoading && !isError ? (
        <View style={styles.alertBanner} accessibilityRole="alert" testID="missing-procedure-alert">
          <Ionicons name="alert-circle" size={22} color="#B91C1C" />
          <View style={styles.alertCopy}>
            <Text style={styles.alertTitle}>Procedure not recorded</Text>
            <Text style={styles.alertText}>
              {missing.length} patient record{missing.length === 1 ? " has" : "s have"} a blank first-procedure field. Open each record and confirm the information.
            </Text>
          </View>
        </View>
      ) : null}

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.brandPrimary} />
        </View>
      ) : isError ? (
        <View style={styles.center}>
          <EmptyState icon="cloud-offline-outline" title="Could not load patients" subtitle="Pull down to retry." />
        </View>
      ) : (
        <FlatList
          data={missing}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: spacing.lg, paddingBottom: bottomChrome + spacing.xl, flexGrow: 1 }}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.brandPrimary} />}
          ListEmptyComponent={
            <EmptyState
              icon="checkmark-circle-outline"
              title="All first procedures are recorded"
              subtitle="No patient currently has a blank first-procedure field."
            />
          }
          renderItem={({ item }) => (
            <Pressable
              style={styles.patientRow}
              testID={`missing-procedure-${item.id}`}
              accessibilityRole="button"
              onPress={() => router.push({ pathname: "/patient-form", params: { id: item.id } })}
            >
              <View style={styles.patientIcon}>
                <Ionicons name="person-outline" size={21} color="#B91C1C" />
              </View>
              <View style={styles.patientInfo}>
                <Text style={styles.patientName} numberOfLines={1}>{item.name?.trim() || "Unnamed patient"}</Text>
                <Text style={styles.patientMeta} numberOfLines={1}>
                  MRNo: {item.mrNo?.trim() || "Not recorded"}{item.date ? "  •  " + item.date : ""}
                </Text>
                {item.diagnosis?.trim() ? <Text style={styles.diagnosis} numberOfLines={1}>{item.diagnosis}</Text> : null}
                {item.procedureII?.trim() ? <Text style={styles.secondProcedure} numberOfLines={1}>Second procedure: {item.procedureII}</Text> : null}
                <Text style={styles.missingLabel}>First procedure missing</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.muted} />
            </Pressable>
          )}
        />
      )}
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
    gap: spacing.md,
  },
  titleRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  titleIcon: { width: 42, height: 42, borderRadius: radius.md, alignItems: "center", justifyContent: "center", backgroundColor: colors.surfaceSecondary },
  titleBlock: { flex: 1 },
  title: { fontFamily: fontFamily.bold, fontSize: fontSize.xxl, color: colors.onSurface },
  subtitle: { fontFamily: fontFamily.regular, fontSize: fontSize.sm, color: colors.muted, marginTop: 2 },
  countPill: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: radius.pill, backgroundColor: "#FEE2E2" },
  redDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#DC2626" },
  countText: { fontFamily: fontFamily.bold, fontSize: fontSize.sm, color: "#991B1B" },
  alertBanner: { marginHorizontal: spacing.lg, marginTop: spacing.md, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: "#FCA5A5", backgroundColor: "#FEF2F2", flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  alertCopy: { flex: 1, gap: 3 },
  alertTitle: { fontFamily: fontFamily.bold, fontSize: fontSize.base, color: "#991B1B" },
  alertText: { fontFamily: fontFamily.regular, fontSize: fontSize.sm, color: "#7F1D1D", lineHeight: 19 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.lg },
  patientRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, backgroundColor: colors.surface, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.md, marginBottom: spacing.sm, borderWidth: 1, borderColor: "#FCA5A5" },
  patientIcon: { width: 40, height: 40, borderRadius: radius.md, backgroundColor: "#FEE2E2", alignItems: "center", justifyContent: "center" },
  patientInfo: { flex: 1, gap: 3 },
  patientName: { fontFamily: fontFamily.bold, fontSize: fontSize.base, color: colors.onSurface },
  patientMeta: { fontFamily: fontFamily.regular, fontSize: fontSize.sm, color: colors.muted },
  diagnosis: { fontFamily: fontFamily.regular, fontSize: fontSize.sm, color: colors.onSurface },
  secondProcedure: { fontFamily: fontFamily.regular, fontSize: fontSize.sm, color: colors.onSurface },
  missingLabel: { alignSelf: "flex-start", marginTop: 2, fontFamily: fontFamily.bold, fontSize: fontSize.xs, color: "#B91C1C", backgroundColor: "#FEE2E2", paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.sm },
}));
