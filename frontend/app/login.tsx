import { Image } from "expo-image";
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

export default function Login() {
  const styles = useStyles();
  const { colors, branding } = useTheme();
  const insets = useSafeAreaInsets();
  const { login } = useAuth();
  const toast = useToast();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [adminExists, setAdminExists] = useState(true);

  useEffect(() => {
    try {
      initializeDatabase();
      const row = db.getFirstSync<any>("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND disabled=0");
      setAdminExists(Number(row?.n || 0) > 0);
    } catch {
      setAdminExists(false);
    }
  }, []);

  const onSubmit = async () => {
    if (!email.trim() || !password) {
      toast("Please enter your email and password.", "error");
      return;
    }
    setLoading(true);
    try {
      await login(email, password);
      router.replace("/(tabs)");
    } catch (e: any) {
      toast(e?.message || "Login failed.", "error");
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
        <View style={styles.logoWrap}>
          {branding.logoBase64 ? (
            <Image source={{ uri: branding.logoBase64 }} style={styles.logoImg} contentFit="cover" />
          ) : (
            <Ionicons name="medkit" size={40} color={colors.onBrandPrimary} />
          )}
        </View>
        <Text style={styles.title}>{branding.title}</Text>
        <Text style={styles.subtitle}>Sign in to access patient records</Text>

        <View style={styles.form}>
          <Field
            label="Email"
            testID="login-email-input"
            value={email}
            onChangeText={setEmail}
            placeholder="you@hospital.com"
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
          />
          <Field
            label="Password"
            testID="login-password-input"
            value={password}
            onChangeText={setPassword}
            placeholder="Your password"
            secureTextEntry
          />
          <PrimaryButton
            title="Log In"
            testID="login-submit-button"
            onPress={onSubmit}
            loading={loading}
          />
          <Pressable testID="forgot-password-button" onPress={() => router.push("/forgot-password")} style={{alignItems:"center",paddingTop:16}}>
            <Text style={{fontFamily:fontFamily.bold,fontSize:fontSize.sm,color:colors.brandPrimary}}>Forgot password?</Text>
          </Pressable>
        </View>

        <View style={styles.footer}>
          {adminExists ? (
            <Text style={styles.footerText}>Ask your administrator for an account.</Text>
          ) : (
            <>
              <Text style={styles.footerText}>First-time setup?</Text>
              <Pressable testID="go-to-signup-button" onPress={() => router.push("/signup")}>
                <Text style={styles.link}>Create admin account</Text>
              </Pressable>
            </>
          )}
        </View>

        {!adminExists ? (
          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>OR</Text>
            <View style={styles.dividerLine} />
          </View>
        ) : null}

        <Pressable
          testID="join-clinic-button"
          onPress={() => router.push("/join-clinic")}
          style={styles.joinBtn}
        >
          <Ionicons name="people-outline" size={18} color={colors.brandPrimary} />
          <Text style={styles.joinText}>Joining a clinic? Load admin&apos;s backup</Text>
        </Pressable>
      </KeyboardAwareScrollView>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  container: { flex: 1, backgroundColor: colors.surface },
  scroll: { flexGrow: 1, paddingHorizontal: spacing.xl, justifyContent: "center" },
  logoWrap: {
    width: 76,
    height: 76,
    borderRadius: radius.lg,
    backgroundColor: colors.brandPrimary,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    marginBottom: spacing.lg,
    overflow: "hidden",
  },
  logoImg: { width: "100%", height: "100%" },
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
  divider: { flexDirection: "row", alignItems: "center", gap: spacing.md, marginTop: spacing.lg },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.border },
  dividerText: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSize.xs,
    color: colors.muted,
    letterSpacing: 1,
  },
  joinBtn: {
    flexDirection: "row",
    gap: spacing.sm,
    alignItems: "center",
    justifyContent: "center",
    marginTop: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.brandPrimary,
    backgroundColor: colors.surface,
  },
  joinText: { fontFamily: fontFamily.bold, fontSize: fontSize.base, color: colors.brandPrimary },
}));
