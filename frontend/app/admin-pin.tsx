import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import Ionicons from "@react-native-vector-icons/ionicons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAuth } from "@/src/auth/AuthContext";
import { PrimaryButton } from "@/src/components/PrimaryButton";
import { useToast } from "@/src/components/toast";
import { clearAdminPin, hasAdminPin, setAdminPin, verifyAdminPin } from "@/src/utils/admin-pin";
import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";

export default function AdminPinScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const { user } = useAuth();

  const [existing, setExisting] = useState(false);
  const [currentPin, setCurrentPin] = useState("");
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    hasAdminPin().then(setExisting);
  }, []);

  if (user?.role !== "admin") {
    return (
      <View style={styles.container}>
        <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
          <Pressable onPress={() => router.back()} style={styles.headerBtn}>
            <Ionicons name="arrow-back" size={24} color={colors.onSurface} />
          </Pressable>
          <Text style={styles.headerTitle}>Admin PIN</Text>
          <View style={styles.headerBtn} />
        </View>
        <View style={styles.center}>
          <Ionicons name="lock-closed-outline" size={40} color={colors.muted} />
          <Text style={styles.blockedTitle}>Administrator only</Text>
        </View>
      </View>
    );
  }

  const save = async () => {
    if (existing) {
      if (!(await verifyAdminPin(currentPin))) {
        toast("Current PIN is incorrect.", "error");
        return;
      }
    }
    if (!/^\d{4,6}$/.test(pin)) {
      toast("PIN must be 4 to 6 digits.", "error");
      return;
    }
    if (pin !== confirm) {
      toast("PINs do not match.", "error");
      return;
    }
    setLoading(true);
    try {
      await setAdminPin(pin);
      toast(existing ? "Admin PIN updated." : "Admin PIN set.", "success");
      router.back();
    } catch (e: any) {
      toast(e?.message || "Could not save PIN.", "error");
    } finally {
      setLoading(false);
    }
  };

  const remove = async () => {
    if (!(await verifyAdminPin(currentPin))) {
      toast("Current PIN is incorrect.", "error");
      return;
    }
    await clearAdminPin();
    toast("Admin PIN removed.", "success");
    router.back();
  };

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={() => router.back()} style={styles.headerBtn} testID="pin-back">
          <Ionicons name="arrow-back" size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>{existing ? "Change Admin PIN" : "Set Admin PIN"}</Text>
        <View style={styles.headerBtn} />
      </View>

      <View style={styles.body}>
        <View style={styles.iconWrap}>
          <Ionicons name="keypad" size={36} color={colors.brandPrimary} />
        </View>
        <Text style={styles.title}>{existing ? "Update your PIN" : "Protect admin actions"}</Text>
        <Text style={styles.subtitle}>
          The PIN protects Branding, PDF exports, Sync and User Management from being changed
          accidentally.
        </Text>

        {existing ? (
          <>
            <Text style={styles.label}>Current PIN</Text>
            <TextInput
              testID="pin-current-input"
              value={currentPin}
              onChangeText={(v) => setCurrentPin(v.replace(/\D/g, ""))}
              keyboardType="number-pad"
              maxLength={6}
              secureTextEntry
              style={styles.input}
              placeholderTextColor={colors.muted}
            />
          </>
        ) : null}

        <Text style={styles.label}>New PIN (4–6 digits)</Text>
        <TextInput
          testID="pin-new-input"
          value={pin}
          onChangeText={(v) => setPin(v.replace(/\D/g, ""))}
          keyboardType="number-pad"
          maxLength={6}
          secureTextEntry
          style={styles.input}
          placeholderTextColor={colors.muted}
        />

        <Text style={styles.label}>Confirm PIN</Text>
        <TextInput
          testID="pin-confirm-input"
          value={confirm}
          onChangeText={(v) => setConfirm(v.replace(/\D/g, ""))}
          keyboardType="number-pad"
          maxLength={6}
          secureTextEntry
          style={styles.input}
          placeholderTextColor={colors.muted}
        />

        <PrimaryButton
          title={existing ? "Update PIN" : "Set PIN"}
          onPress={save}
          loading={loading}
          testID="pin-save"
        />

        {existing ? (
          <Pressable onPress={remove} style={styles.removeBtn} testID="pin-remove">
            <Text style={styles.removeText}>Remove PIN protection</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  container: { flex: 1, backgroundColor: colors.surface },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  headerTitle: { fontFamily: fontFamily.bold, fontSize: fontSize.lg, color: colors.onSurface },
  body: { padding: spacing.xl, gap: spacing.md },
  iconWrap: {
    alignSelf: "center",
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: colors.brandTertiary,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.md,
  },
  title: {
    fontFamily: fontFamily.bold,
    fontSize: fontSize.xl,
    color: colors.onSurface,
    textAlign: "center",
  },
  subtitle: {
    fontFamily: fontFamily.regular,
    fontSize: fontSize.base,
    color: colors.muted,
    textAlign: "center",
    marginBottom: spacing.md,
  },
  label: { fontFamily: fontFamily.semibold, fontSize: fontSize.sm, color: colors.onSurfaceSecondary },
  input: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    fontFamily: fontFamily.monoBold,
    fontSize: fontSize.xl,
    color: colors.onSurface,
    minHeight: 54,
    letterSpacing: 8,
    textAlign: "center",
  },
  removeBtn: { padding: spacing.md, alignItems: "center" },
  removeText: { fontFamily: fontFamily.semibold, color: colors.error, fontSize: fontSize.base },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.md },
  blockedTitle: { fontFamily: fontFamily.bold, fontSize: fontSize.lg, color: colors.onSurface, marginTop: spacing.sm },
}));
