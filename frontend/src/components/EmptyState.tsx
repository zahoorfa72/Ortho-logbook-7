import React from "react";
import { Text, View } from "react-native";
import Ionicons from "@react-native-vector-icons/ionicons";

import { fontFamily, fontSize, makeStyles, spacing, useTheme } from "@/src/theme";

type Props = {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  title: string;
  subtitle?: string;
};

export function EmptyState({ icon, title, subtitle }: Props) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <View style={styles.wrap} testID="empty-state">
      <View style={styles.iconWrap}>
        <Ionicons name={icon} size={40} color={colors.brandPrimary} />
      </View>
      <Text style={styles.title}>{title}</Text>
      {!!subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  wrap: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacing.xxxl,
    paddingHorizontal: spacing.xl,
  },
  iconWrap: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: colors.brandTertiary,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.lg,
  },
  title: {
    fontFamily: fontFamily.bold,
    fontSize: fontSize.xl,
    color: colors.onSurface,
    textAlign: "center",
    marginBottom: spacing.xs,
  },
  subtitle: {
    fontFamily: fontFamily.regular,
    fontSize: fontSize.base,
    color: colors.muted,
    textAlign: "center",
  },
}));
