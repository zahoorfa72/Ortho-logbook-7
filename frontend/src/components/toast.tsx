import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import Ionicons from "@react-native-vector-icons/ionicons";
import Animated, { FadeInDown, FadeOutDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";

type ToastType = "success" | "error" | "info";
type ToastItem = { id: number; message: string; type: ToastType };
const ToastContext = createContext<(message: string, type?: ToastType) => void>(() => {});

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [queue, setQueue] = useState<ToastItem[]>([]);
  const nextId = useRef(0);
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useStyles();
  const current = queue[0];
  const currentId = current?.id;
  const currentType = current?.type;

  useEffect(() => {
    if (currentId === undefined || !currentType) return;
    const timer = setTimeout(() => setQueue(items => items[0]?.id === currentId ? items.slice(1) : items), currentType === "error" ? 5200 : 3600);
    return () => clearTimeout(timer);
  }, [currentId, currentType]);

  const show = useCallback((message: string, type: ToastType = "info") => {
    const cleanMessage = String(message || "").trim();
    if (!cleanMessage) return;
    const item: ToastItem = { id: ++nextId.current, message: cleanMessage, type };
    setQueue(items => items.length >= 4 ? [...items.slice(0, 3), item] : [...items, item]);
  }, []);

  const icon = current?.type === "success" ? "checkmark-circle" : current?.type === "error" ? "alert-circle" : "information-circle";
  const iconColor = current?.type === "success" ? colors.success : current?.type === "error" ? colors.error : colors.brandPrimary;

  return (
    <ToastContext.Provider value={show}>
      {children}
      {current && (
        <Animated.View key={current.id} entering={FadeInDown.duration(180)} exiting={FadeOutDown.duration(150)}
          style={[styles.wrap, { bottom: insets.bottom + spacing.md }]} pointerEvents="none" accessibilityLiveRegion="polite">
          <View style={[styles.toast, styles[current.type]]} testID="app-toast">
            <Ionicons name={icon as any} size={22} color={iconColor} />
            <Text style={styles.text} numberOfLines={2} ellipsizeMode="tail" testID="app-toast-text">{current.message}</Text>
          </View>
        </Animated.View>
      )}
    </ToastContext.Provider>
  );
}
export function useToast() { return useContext(ToastContext); }

const useStyles = makeStyles((colors) => ({
  wrap: { position: "absolute", left: 0, right: 0, alignItems: "center", paddingHorizontal: spacing.md, zIndex: 9999 },
  toast: {
    alignSelf: "center", width: "100%", maxWidth: 430, minHeight: 48, flexDirection: "row", alignItems: "center",
    gap: spacing.sm, paddingVertical: spacing.sm, paddingHorizontal: spacing.md, borderRadius: radius.lg, borderWidth: 1,
    backgroundColor: colors.surface, shadowColor: "#000000", shadowOpacity: 0.16, shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 }, elevation: 7,
  },
  success: { borderColor: colors.success },
  error: { borderColor: colors.error },
  info: { borderColor: colors.border },
  text: { flex: 1, color: colors.onSurface, fontFamily: fontFamily.semibold, fontSize: fontSize.sm, lineHeight: 18, textAlign: "left" },
}));
