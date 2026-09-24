import { useState } from "react";
import { Modal, Pressable, Text, TextInput, View } from "react-native";
import Ionicons from "@react-native-vector-icons/ionicons";

import { PrimaryButton } from "@/src/components/PrimaryButton";
import { hasAdminPin, verifyAdminPin } from "@/src/utils/admin-pin";
import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";

type Props = {
  visible: boolean;
  title: string;
  description?: string;
  onSuccess: () => void;
  onCancel: () => void;
};

export function PinPromptModal({ visible, title, description, onSuccess, onCancel }: Props) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);

  const submit = async () => {
    setChecking(true);
    setError("");
    try {
      const ok = await verifyAdminPin(pin);
      if (ok) {
        setPin("");
        onSuccess();
      } else {
        setError("Incorrect PIN. Try again.");
      }
    } finally {
      setChecking(false);
    }
  };

  const close = () => {
    setPin("");
    setError("");
    onCancel();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.iconWrap}>
            <Ionicons name="lock-closed" size={28} color={colors.brandPrimary} />
          </View>
          <Text style={styles.title}>{title}</Text>
          {description ? <Text style={styles.desc}>{description}</Text> : null}
          <TextInput
            testID="pin-prompt-input"
            value={pin}
            onChangeText={(v) => setPin(v.replace(/\D/g, ""))}
            keyboardType="number-pad"
            maxLength={6}
            secureTextEntry
            autoFocus
            style={styles.input}
            placeholderTextColor={colors.muted}
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <View style={{ height: spacing.md }} />
          <PrimaryButton title="Unlock" onPress={submit} loading={checking} testID="pin-prompt-submit" />
          <Pressable onPress={close} style={styles.cancel} testID="pin-prompt-cancel">
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

// Small helper: if a PIN is set, prompt; otherwise run immediately.
export async function runIfAdminUnlocked(
  showPrompt: () => Promise<boolean>,
  action: () => void | Promise<void>,
) {
  const need = await hasAdminPin();
  if (!need) {
    await action();
    return;
  }
  const ok = await showPrompt();
  if (ok) await action();
}

const useStyles = makeStyles((colors) => ({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(15,23,42,0.5)",
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.lg,
  },
  card: {
    width: "100%",
    maxWidth: 380,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.xl,
  },
  iconWrap: {
    alignSelf: "center",
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: colors.brandTertiary,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.md,
  },
  title: {
    fontFamily: fontFamily.bold,
    fontSize: fontSize.lg,
    color: colors.onSurface,
    textAlign: "center",
    marginBottom: spacing.xs,
  },
  desc: {
    fontFamily: fontFamily.regular,
    fontSize: fontSize.sm,
    color: colors.muted,
    textAlign: "center",
    marginBottom: spacing.md,
  },
  input: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    fontFamily: fontFamily.monoBold,
    fontSize: fontSize.xl,
    color: colors.onSurface,
    minHeight: 54,
    letterSpacing: 8,
    textAlign: "center",
  },
  error: { color: colors.error, fontFamily: fontFamily.semibold, textAlign: "center", marginTop: spacing.sm },
  cancel: { alignItems: "center", padding: spacing.md, marginTop: spacing.sm },
  cancelText: { fontFamily: fontFamily.semibold, color: colors.muted, fontSize: fontSize.base },
}));
