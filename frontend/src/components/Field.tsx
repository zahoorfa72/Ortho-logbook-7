import React from "react";
import { TextInput, TextInputProps, View, Text } from "react-native";

import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";

type Props = TextInputProps & {
  label: string;
  error?: string;
  testID?: string;
};

export function Field({ label, error, testID, style, ...rest }: Props) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        testID={testID}
        placeholderTextColor={colors.muted}
        style={[styles.input, !!error && styles.inputError, style]}
        {...rest}
      />
      {!!error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  wrap: { marginBottom: spacing.lg },
  label: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSize.sm,
    color: colors.onSurfaceSecondary,
    marginBottom: spacing.xs,
  },
  input: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    fontFamily: fontFamily.regular,
    fontSize: fontSize.lg,
    color: colors.onSurface,
    minHeight: 50,
  },
  inputError: { borderColor: colors.error },
  error: {
    fontFamily: fontFamily.medium,
    fontSize: fontSize.sm,
    color: colors.error,
    marginTop: spacing.xs,
  },
}));
