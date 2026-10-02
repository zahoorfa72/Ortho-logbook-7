import { useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import Ionicons from "@react-native-vector-icons/ionicons";
import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";

export type SortOption<T extends string> = {
  value: T;
  label: string;
};

type SortMenuProps<T extends string> = {
  value: T;
  options: SortOption<T>[];
  onChange: (value: T) => void;
  testID: string;
  label?: string;
};

export function SortMenu<T extends string>({
  value,
  options,
  onChange,
  testID,
  label = "Sort by",
}: SortMenuProps<T>) {
  const { colors } = useTheme();
  const styles = useStyles();
  const [visible, setVisible] = useState(false);
  const current = options.find((x) => x.value === value) || options[0];

  return (
    <>
      <Pressable
        testID={`${testID}-button`}
        onPress={() => setVisible(true)}
        style={styles.button}
      >
        <Ionicons name="swap-vertical-outline" size={17} color={colors.brandPrimary} />
        <View style={{ flex: 1 }}>
          <Text style={styles.buttonLabel}>{label}</Text>
          <Text style={styles.buttonValue} numberOfLines={1}>{current?.label || ""}</Text>
        </View>
        <Ionicons name="chevron-down" size={16} color={colors.muted} />
      </Pressable>

      <Modal visible={visible} transparent animationType="fade" onRequestClose={() => setVisible(false)}>
        <Pressable style={styles.overlay} onPress={() => setVisible(false)}>
          <Pressable style={styles.card} onPress={() => {}}>
            <View style={styles.handle} />
            <Text style={styles.title}>{label}</Text>
            {options.map((option) => {
              const selected = option.value === value;
              return (
                <Pressable
                  key={option.value}
                  testID={`${testID}-option-${option.value}`}
                  onPress={() => {
                    onChange(option.value);
                    setVisible(false);
                  }}
                  style={[styles.option, selected && styles.optionSelected]}
                >
                  <Text style={[styles.optionText, selected && styles.optionTextSelected]}>
                    {option.label}
                  </Text>
                  <Ionicons
                    name={selected ? "checkmark-circle" : "ellipse-outline"}
                    size={21}
                    color={selected ? colors.brandPrimary : colors.muted}
                  />
                </Pressable>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const useStyles = makeStyles((colors) => ({
  button: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  buttonLabel: {
    fontFamily: fontFamily.medium,
    fontSize: fontSize.xs,
    color: colors.muted,
  },
  buttonValue: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSize.sm,
    color: colors.onSurface,
    marginTop: 1,
  },
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "flex-end",
  },
  card: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
    paddingBottom: spacing.xl,
  },
  handle: {
    width: 42,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.border,
    alignSelf: "center",
    marginBottom: spacing.lg,
  },
  title: {
    fontFamily: fontFamily.bold,
    fontSize: fontSize.xl,
    color: colors.onSurface,
    marginBottom: spacing.sm,
  },
  option: {
    minHeight: 50,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    marginTop: spacing.xs,
  },
  optionSelected: {
    backgroundColor: colors.surfaceSecondary,
  },
  optionText: {
    fontFamily: fontFamily.medium,
    fontSize: fontSize.base,
    color: colors.onSurface,
  },
  optionTextSelected: {
    fontFamily: fontFamily.bold,
    color: colors.brandPrimary,
  },
}));
