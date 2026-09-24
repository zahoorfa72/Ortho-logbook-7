import React from "react";
import { ActivityIndicator, Pressable, Text, ViewStyle } from "react-native";

import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";

type Props = {
  title: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "danger";
  testID?: string;
  style?: ViewStyle;
};

export function PrimaryButton({
  title,
  onPress,
  loading,
  disabled,
  variant = "primary",
  testID,
  style,
}: Props) {
  const styles = useStyles();
  const { colors } = useTheme();
  const isDisabled = disabled || loading;
  const onColor =
    variant === "secondary" ? colors.onBrandTertiary : colors.onBrandPrimary;
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.base,
        styles[variant],
        pressed && styles.pressed,
        isDisabled && styles.disabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={onColor} />
      ) : (
        <Text style={[styles.text, { color: onColor }]}>{title}</Text>
      )}
    </Pressable>
  );
}

const useStyles = makeStyles((colors) => ({
  base: {
    minHeight: 52,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
    flexDirection: "row",
  },
  primary: { backgroundColor: colors.brandPrimary },
  secondary: { backgroundColor: colors.brandTertiary },
  danger: { backgroundColor: colors.error },
  pressed: { opacity: 0.85 },
  disabled: { opacity: 0.5 },
  text: {
    fontFamily: fontFamily.bold,
    fontSize: fontSize.lg,
  },
}));
