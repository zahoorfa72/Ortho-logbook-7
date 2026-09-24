import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import Ionicons from "@react-native-vector-icons/ionicons";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAuth } from "@/src/auth/AuthContext";
import { Field } from "@/src/components/Field";
import { PrimaryButton } from "@/src/components/PrimaryButton";
import { useToast } from "@/src/components/toast";
import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";
import { db, initializeDatabase } from "@/src/db/database";

export default function Signup() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { signup } = useAuth();
  const toast = useToast();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    try {
      initializeDatabase();
      const row = db.getFirstSync<any>("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND disabled=0");
      if (Number(row?.n || 0) > 0) {
        toast("Sign-up is disabled. Ask your administrator for an account.", "error");
        router.replace("/login");
      }
    } catch {}
  }, [toast]);

  const onSubmit = async () => {
    if (!name.trim() || !email.trim() || !password) {
      toast("Please fill in all fields.", "error");
      return;
    }
    if (password.length < 6) {
      toast("Password must be at least 6 characters.", "error");
      return;
    }
    setLoading(true);
    try {
      const recoveryCode = await signup(name, email, password);
      toast(`Account created. Save your recovery code: ${recoveryCode}`, "success");
      router.replace("/(tabs)");
    } catch (e: any) {
      toast(e?.message || "Sign up failed.", "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <KeyboardAwareScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: insets.top + spacing.xxl, paddingBottom: insets.bottom + spacing.xl },
        ]}
        bottomOffset={24}
        keyboardShouldPersistTaps="handled"
      >
        <Pressable
          testID="signup-back-button"
          style={[styles.back, { top: insets.top + spacing.xs }]}
          onPress={() => router.back()}
        >
          <Ionicons name="chevron-back" size={26} color={colors.onSurface} />
        </Pressable>

        <View style={styles.logoWrap}>
          <Ionicons name="person-add" size={36} color={colors.onBrandPrimary} />
        </View>
        <Text style={styles.title}>Create Admin Account</Text>
        <Text style={styles.subtitle}>First-time setup for your logbook</Text>

        <View style={styles.form}>
          <Field
            label="Full Name"
            testID="signup-name-input"
            value={name}
            onChangeText={setName}
            placeholder="Dr. Jane Doe"
            autoCapitalize="words"
          />
          <Field
            label="Email"
            testID="signup-email-input"
            value={email}
            onChangeText={setEmail}
            placeholder="you@hospital.com"
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
          />
          <Field
            label="Password"
            testID="signup-password-input"
            value={password}
            onChangeText={setPassword}
            placeholder="At least 6 characters"
            secureTextEntry
          />
          <PrimaryButton
            title="Create Account"
            testID="signup-submit-button"
            onPress={onSubmit}
            loading={loading}
          />
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerText}>Already have an account?</Text>
          <Pressable testID="go-to-login-button" onPress={() => router.replace("/login")}>
            <Text style={styles.link}>Log in</Text>
          </Pressable>
        </View>
      </KeyboardAwareScrollView>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  container: { flex: 1, backgroundColor: colors.surface },
  scroll: { flexGrow: 1, paddingHorizontal: spacing.xl, justifyContent: "center" },
  back: { position: "absolute", left: spacing.md, padding: spacing.sm, zIndex: 2 },
  logoWrap: {
    width: 76,
    height: 76,
    borderRadius: radius.lg,
    backgroundColor: colors.brandPrimary,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    marginBottom: spacing.lg,
  },
  title: {
    fontFamily: fontFamily.bold,
    fontSize: fontSize.xxl,
    color: colors.onSurface,
    textAlign: "center",
  },
  subtitle: {
    fontFamily: fontFamily.regular,
    fontSize: fontSize.base,
    color: colors.muted,
    textAlign: "center",
    marginTop: spacing.xs,
    marginBottom: spacing.xxl,
  },
  form: { marginBottom: spacing.lg },
  footer: {
    flexDirection: "row",
    justifyContent: "center",
    gap: spacing.xs,
    marginTop: spacing.md,
  },
  footerText: { fontFamily: fontFamily.regular, fontSize: fontSize.base, color: colors.muted },
  link: { fontFamily: fontFamily.bold, fontSize: fontSize.base, color: colors.brandPrimary },
}));
