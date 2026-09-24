import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import Ionicons from "@react-native-vector-icons/ionicons";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";

import { api } from "@/src/api/client";
import { useAuth } from "@/src/auth/AuthContext";
import { Field } from "@/src/components/Field";
import { PrimaryButton } from "@/src/components/PrimaryButton";
import { useToast } from "@/src/components/toast";
import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";

type User = {
  id: string;
  email: string;
  name: string;
  role: string;
  canEditPatients: boolean;
  disabled: number;
  recoveryCode: string;
  created_at?: string;
};

export default function UserManagement() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("doctor");

  const [revealCode, setRevealCode] = useState<Record<string, boolean>>({});
  const [resetTarget, setResetTarget] = useState<User | null>(null);
  const [resetPwd, setResetPwd] = useState("");
  const [resetPwd2, setResetPwd2] = useState("");

  const { data = [] } = useQuery<User[]>({
    queryKey: ["users"],
    queryFn: async () => await api.get<User[]>("/users"),
    enabled: user?.role === "admin",
  });

  const add = useMutation({
    mutationFn: () =>
      api.post("/users", { name, email, password, role, canEditPatients: true }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
      setName("");
      setEmail("");
      setPassword("");
      toast("User created.", "success");
    },
    onError: (e: any) => toast(e?.message || "Could not create user.", "error"),
  });

  const toggleDisabled = useMutation({
    mutationFn: (u: User) => api.put("/users/" + u.id, { ...u, disabled: !u.disabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
    onError: (e: any) => toast(e?.message || "Could not update user.", "error"),
  });

  const resetPassword = useMutation({
    mutationFn: (payload: { id: string; password: string }) =>
      api.post(`/users/${payload.id}/reset-password`, { password: payload.password }),
    onSuccess: () => {
      toast("Password reset. Share the new password with the staff.", "success");
      setResetTarget(null);
      setResetPwd("");
      setResetPwd2("");
    },
    onError: (e: any) => toast(e?.message || "Reset failed.", "error"),
  });

  const regenCode = useMutation({
    mutationFn: (id: string) => api.post(`/users/${id}/regenerate-recovery-code`, {}),
    onSuccess: (res: any, id) => {
      toast("New recovery code generated.", "success");
      qc.invalidateQueries({ queryKey: ["users"] });
      setRevealCode((r) => ({ ...r, [id]: true }));
    },
    onError: (e: any) => toast(e?.message || "Could not regenerate.", "error"),
  });

  const submitReset = () => {
    if (!resetTarget) return;
    if (resetPwd.length < 6) return toast("Password must be at least 6 characters.", "error");
    if (resetPwd !== resetPwd2) return toast("Passwords do not match.", "error");
    resetPassword.mutate({ id: resetTarget.id, password: resetPwd });
  };

  const copyCode = async (code: string) => {
    if (!code) return;
    await Clipboard.setStringAsync(code);
    toast("Recovery code copied.", "success");
  };

  if (user?.role !== "admin") {
    return (
      <View style={styles.container}>
        <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
          <Pressable onPress={() => router.back()} style={styles.headerBtn}>
            <Ionicons name="arrow-back" size={24} color={colors.onSurface} />
          </Pressable>
          <Text style={styles.headerTitle}>User Management</Text>
          <View style={styles.headerBtn} />
        </View>
        <View style={styles.center}>
          <Ionicons name="lock-closed-outline" size={40} color={colors.muted} />
          <Text style={styles.blockedTitle}>Administrator only</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={() => router.back()} style={styles.headerBtn} testID="users-back">
          <Ionicons name="arrow-back" size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>User Management</Text>
        <View style={styles.headerBtn} />
      </View>

      <KeyboardAwareScrollView
        bottomOffset={80}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + spacing.xxxl }}
      >
        <Text style={styles.section}>Add user</Text>
        <Field label="Name" value={name} onChangeText={setName} placeholder="Staff name" testID="add-user-name" />
        <Field
          label="Email"
          value={email}
          onChangeText={setEmail}
          placeholder="staff@hospital.com"
          autoCapitalize="none"
          keyboardType="email-address"
          testID="add-user-email"
        />
        <Field
          label="Temporary password"
          value={password}
          onChangeText={setPassword}
          placeholder="At least 6 characters"
          secureTextEntry
          testID="add-user-password"
        />
        <View style={styles.roleRow}>
          {["doctor", "staff"].map((r) => (
            <Pressable
              key={r}
              testID={`role-${r}`}
              onPress={() => setRole(r)}
              style={[
                styles.role,
                { backgroundColor: role === r ? colors.brandPrimary : colors.surfaceTertiary },
              ]}
            >
              <Text
                style={{
                  color: role === r ? colors.onBrandPrimary : colors.onSurface,
                  fontFamily: fontFamily.semibold,
                }}
              >
                {r}
              </Text>
            </Pressable>
          ))}
        </View>
        <PrimaryButton
          title="Create User"
          testID="create-user-button"
          onPress={() => add.mutate()}
          loading={add.isPending}
        />

        <Text style={[styles.section, { marginTop: spacing.xl }]}>Accounts</Text>
        {data.map((u) => (
          <View key={u.id} style={styles.card} testID={`user-card-${u.id}`}>
            <View style={styles.cardTop}>
              <View style={{ flex: 1 }}>
                <Text style={styles.name} numberOfLines={1}>
                  {u.name}
                </Text>
                <Text style={styles.meta} numberOfLines={1}>
                  {u.email}
                </Text>
                <View style={styles.badges}>
                  <View style={[styles.badge, { backgroundColor: colors.brandTertiary }]}>
                    <Text style={[styles.badgeText, { color: colors.onBrandTertiary }]}>{u.role}</Text>
                  </View>
                  {u.disabled ? (
                    <View style={[styles.badge, { backgroundColor: colors.warning }]}>
                      <Text style={[styles.badgeText, { color: colors.onWarning }]}>Disabled</Text>
                    </View>
                  ) : (
                    <View style={[styles.badge, { backgroundColor: colors.brandPrimary }]}>
                      <Text style={[styles.badgeText, { color: colors.onBrandPrimary }]}>Active</Text>
                    </View>
                  )}
                </View>
              </View>
            </View>

            {/* Recovery code row */}
            <View style={styles.recoveryRow}>
              <Ionicons name="key-outline" size={16} color={colors.muted} />
              <Text style={styles.recoveryLabel}>Recovery code</Text>
              <Text
                style={styles.recoveryValue}
                selectable
                testID={`recovery-code-${u.id}`}
              >
                {revealCode[u.id] ? u.recoveryCode || "—" : "••••••••"}
              </Text>
              <Pressable
                onPress={() => setRevealCode((r) => ({ ...r, [u.id]: !r[u.id] }))}
                style={styles.smallIconBtn}
                hitSlop={6}
                testID={`reveal-code-${u.id}`}
              >
                <Ionicons name={revealCode[u.id] ? "eye-off-outline" : "eye-outline"} size={16} color={colors.brandPrimary} />
              </Pressable>
              {revealCode[u.id] && u.recoveryCode ? (
                <Pressable
                  onPress={() => copyCode(u.recoveryCode)}
                  style={styles.smallIconBtn}
                  hitSlop={6}
                  testID={`copy-code-${u.id}`}
                >
                  <Ionicons name="copy-outline" size={16} color={colors.brandPrimary} />
                </Pressable>
              ) : null}
            </View>

            {/* Actions */}
            <View style={styles.actions}>
              <Pressable
                onPress={() => setResetTarget(u)}
                style={styles.actionBtn}
                testID={`reset-pwd-${u.id}`}
              >
                <Ionicons name="lock-open-outline" size={16} color={colors.brandPrimary} />
                <Text style={styles.actionText}>Reset password</Text>
              </Pressable>
              <Pressable
                onPress={() => regenCode.mutate(u.id)}
                style={styles.actionBtn}
                testID={`regen-code-${u.id}`}
              >
                <Ionicons name="refresh-outline" size={16} color={colors.brandPrimary} />
                <Text style={styles.actionText}>New recovery code</Text>
              </Pressable>
              {u.id !== user.id ? (
                <Pressable
                  onPress={() => toggleDisabled.mutate(u)}
                  style={styles.actionBtn}
                  testID={`toggle-${u.id}`}
                >
                  <Ionicons
                    name={u.disabled ? "checkmark-circle-outline" : "close-circle-outline"}
                    size={16}
                    color={u.disabled ? colors.brandPrimary : colors.error}
                  />
                  <Text style={[styles.actionText, u.disabled ? undefined : { color: colors.error }]}>
                    {u.disabled ? "Enable" : "Disable"}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        ))}
      </KeyboardAwareScrollView>

      {/* Reset password modal */}
      <Modal
        visible={!!resetTarget}
        transparent
        animationType="slide"
        onRequestClose={() => setResetTarget(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { paddingBottom: insets.bottom + spacing.lg }]}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Reset password</Text>
            {resetTarget ? (
              <Text style={styles.modalSub}>
                Set a new password for <Text style={{ fontFamily: fontFamily.bold }}>{resetTarget.name}</Text>.
                Share it with them so they can log in again.
              </Text>
            ) : null}
            <Field
              label="New password"
              value={resetPwd}
              onChangeText={setResetPwd}
              placeholder="At least 6 characters"
              secureTextEntry
              testID="reset-new-password"
            />
            <Field
              label="Confirm password"
              value={resetPwd2}
              onChangeText={setResetPwd2}
              placeholder="Type again"
              secureTextEntry
              testID="reset-confirm-password"
            />
            <PrimaryButton
              title="Reset Password"
              onPress={submitReset}
              loading={resetPassword.isPending}
              testID="reset-submit-button"
            />
            <Pressable
              style={styles.cancel}
              onPress={() => setResetTarget(null)}
              testID="reset-cancel-button"
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  container: { flex: 1, backgroundColor: colors.surfaceSecondary },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  headerBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  headerTitle: { fontFamily: fontFamily.bold, fontSize: fontSize.lg, color: colors.onSurface },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.md, padding: spacing.xl },
  blockedTitle: { fontFamily: fontFamily.bold, fontSize: fontSize.lg, color: colors.onSurface },
  section: {
    fontFamily: fontFamily.bold,
    fontSize: fontSize.sm,
    color: colors.brandPrimary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: spacing.md,
  },
  roleRow: { flexDirection: "row", gap: spacing.sm, marginBottom: spacing.lg },
  role: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    minHeight: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  card: {
    backgroundColor: colors.surface,
    padding: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.md,
  },
  cardTop: { flexDirection: "row", alignItems: "flex-start" },
  name: { fontFamily: fontFamily.bold, fontSize: fontSize.lg, color: colors.onSurface },
  meta: { fontFamily: fontFamily.regular, fontSize: fontSize.sm, color: colors.muted, marginTop: 2 },
  badges: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  badgeText: { fontFamily: fontFamily.bold, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 },
  recoveryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.md,
    padding: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
  },
  recoveryLabel: { fontFamily: fontFamily.semibold, fontSize: fontSize.xs, color: colors.muted, textTransform: "uppercase" },
  recoveryValue: { flex: 1, fontFamily: fontFamily.monoMedium, fontSize: fontSize.base, color: colors.onSurface, textAlign: "right" },
  smallIconBtn: { width: 30, height: 30, borderRadius: radius.sm, alignItems: "center", justifyContent: "center" },
  actions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md, flexWrap: "wrap" },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSecondary,
  },
  actionText: { fontFamily: fontFamily.semibold, fontSize: fontSize.sm, color: colors.brandPrimary },
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
  modalTitle: {
    fontFamily: fontFamily.bold,
    fontSize: fontSize.xl,
    color: colors.onSurface,
    marginBottom: spacing.xs,
  },
  modalSub: {
    fontFamily: fontFamily.regular,
    fontSize: fontSize.sm,
    color: colors.muted,
    marginBottom: spacing.md,
    lineHeight: 20,
  },
  cancel: { alignItems: "center", paddingVertical: spacing.md, marginTop: spacing.sm },
  cancelText: { fontFamily: fontFamily.semibold, fontSize: fontSize.base, color: colors.muted },
}));
