import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import Animated, { FadeInUp, FadeOutUp } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { fontFamily, fontSize, makeStyles, radius, spacing } from "@/src/theme";

type ToastType = "success" | "error" | "info";
type ToastItem = { id: number; message: string; type: ToastType };

const ToastContext = createContext<(message: string, type?: ToastType) => void>(() => {});

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<ToastItem | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const insets = useSafeAreaInsets();
  const styles = useStyles();

  const show = useCallback((message: string, type: ToastType = "info") => {
    if (timer.current) clearTimeout(timer.current);
    setToast({ id: Date.now(), message, type });
    timer.current = setTimeout(() => setToast(null), 3000);
  }, []);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && (
        <Animated.View
          key={toast.id}
          entering={FadeInUp.springify()}
          exiting={FadeOutUp}
          style={[styles.wrap, { top: insets.top + spacing.sm }]}
          pointerEvents="none"
        >
          <View style={[styles.toast, styles[toast.type]]} testID="app-toast">
            <Text style={styles.text} testID="app-toast-text">{toast.message}</Text>
          </View>
        </Animated.View>
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

const useStyles = makeStyles((colors) => ({
  wrap: {
    position: "absolute",
    left: spacing.lg,
    right: spacing.lg,
    alignItems: "center",
    zIndex: 9999,
  },
  toast: {
    width: "100%",
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  success: { backgroundColor: colors.success },
  error: { backgroundColor: colors.error },
  info: { backgroundColor: colors.surfaceInverse },
  text: {
    color: colors.onSurfaceInverse,
    fontFamily: fontFamily.semibold,
    fontSize: fontSize.base,
    textAlign: "center",
  },
}));
