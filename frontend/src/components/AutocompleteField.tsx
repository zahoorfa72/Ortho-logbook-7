import React, { useMemo, useState } from "react";
import { Pressable, Text, TextInput, TextInputProps, View } from "react-native";
import Ionicons from "@react-native-vector-icons/ionicons";

import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";

export type Suggestion = { key: string; label: string; detail?: string };

type Props = Omit<TextInputProps, "value" | "onChangeText"> & {
  label: string;
  testID?: string;
  value: string;
  onChangeText: (v: string) => void;
  suggestions: Suggestion[];
  maxResults?: number;
  onSelect?: (suggestion: Suggestion) => void;
};

// Text input with type-ahead suggestions: typing 1+ letters shows near matches
// (prefix matches first, then partial matches) that can be tapped to autofill.
// NOTE: the list renders INLINE below the input, never as an absolute overlay.
// An overlay with a conditional zIndex made Android re-layout the scroll view
// mid-typing, which jumped focus/scroll away from the field being typed in.
export function AutocompleteField({
  label,
  testID,
  value,
  onChangeText,
  suggestions,
  maxResults = 6,
  onSelect,
  ...rest
}: Props) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);

  const matches = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!open || !q) return [];
    const starts: Suggestion[] = [];
    const near: Suggestion[] = [];
    for (const s of suggestions) {
      const l = s.label.toLowerCase();
      if (l === q) continue; // exact value already entered
      if (l.startsWith(q)) starts.push(s);
      else if (l.includes(q)) near.push(s);
    }
    return [...starts, ...near].slice(0, maxResults);
  }, [open, value, suggestions, maxResults]);

  const showList = matches.length > 0;

  const pick = (s: Suggestion) => {
    onChangeText(s.label);
    onSelect?.(s);
    setOpen(false);
  };

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
      <View>
        <TextInput
          testID={testID}
          placeholderTextColor={colors.muted}
          style={[styles.input, !!value && styles.inputWithClear]}
          value={value}
          onChangeText={(t) => {
            onChangeText(t);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          autoCorrect={false}
          {...rest}
        />
        {!!value && (
          <Pressable
            testID={testID ? `${testID}-clear` : undefined}
            onPress={() => {
              onChangeText("");
              setOpen(false);
            }}
            style={styles.clear}
            hitSlop={8}
          >
            <Ionicons name="close-circle" size={20} color={colors.muted} />
          </Pressable>
        )}
      </View>
      {showList && (
        <View style={styles.dropdown} testID={testID ? `${testID}-suggestions` : undefined}>
          {matches.map((s, i) => (
            <Pressable
              key={s.key}
              testID={testID ? `${testID}-suggestion-${i}` : undefined}
              onPress={() => pick(s)}
              style={({ pressed }) => [
                styles.option,
                i > 0 && styles.optionBorder,
                pressed && { backgroundColor: colors.surfaceTertiary },
              ]}
            >
              <Text style={styles.optionText} numberOfLines={1}>
                {s.label}
              </Text>
              {!!s.detail && <Text style={styles.optionDetail}>{s.detail}</Text>}
            </Pressable>
          ))}
        </View>
      )}
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
  inputWithClear: { paddingRight: 44 },
  clear: {
    position: "absolute",
    right: spacing.md,
    top: 0,
    bottom: 0,
    justifyContent: "center",
  },
  dropdown: {
    marginTop: spacing.xs,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
  },
  option: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  optionBorder: { borderTopWidth: 1, borderTopColor: colors.divider },
  optionText: {
    fontFamily: fontFamily.medium,
    fontSize: fontSize.base,
    color: colors.onSurface,
  },
  optionDetail: {
    fontFamily: fontFamily.regular,
    fontSize: fontSize.sm,
    color: colors.muted,
    marginTop: 2,
  },
}));
