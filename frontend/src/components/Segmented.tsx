import React from "react";
import { Pressable, Text, View } from "react-native";

import { fontFamily, fontSize, makeStyles, radius, spacing } from "@/src/theme";

type Props = {
  options: string[];
  value: string;
  onChange: (value: string) => void;
  testIDPrefix?: string;
};

export function Segmented({ options, value, onChange, testIDPrefix = "seg" }: Props) {
  const styles = useStyles();
  return (
    <View style={styles.wrap}>
      {options.map((opt) => {
        const active = opt === value;
        return (
          <Pressable
            key={opt}
            testID={`${testIDPrefix}-${opt.toLowerCase().replace(/\s+/g, "-")}`}
            onPress={() => onChange(opt)}
            style={[styles.item, active && styles.itemActive]}
          >
            <Text style={[styles.text, active && styles.textActive]}>{opt}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  wrap: {
    flexDirection: "row",
    backgroundColor: colors.surfaceTertiary,
    borderRadius: radius.md,
    padding: spacing.xs,
    gap: spacing.xs,
  },
  item: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  itemActive: {
    backgroundColor: colors.surface,
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  text: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSize.base,
    color: colors.muted,
  },
  textActive: { color: colors.onSurface },
}));
