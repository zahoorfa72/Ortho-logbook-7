import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Animated, PanResponder, Text, View, useWindowDimensions } from "react-native";

export type DriveSyncState =
  | { phase: "idle"; updates: 0; message: "" }
  | { phase: "waiting"; updates: number; message: string }
  | { phase: "uploading"; updates: number; message: string }
  | { phase: "success"; updates: 0; message: string }
  | { phase: "error"; updates: number; message: string };

let current: DriveSyncState = { phase: "idle", updates: 0, message: "" };
const listeners = new Set<(state: DriveSyncState) => void>();

export function setDriveSyncState(next: DriveSyncState) {
  if (current.phase === next.phase && current.updates === next.updates && current.message === next.message) return;
  current = next;
  listeners.forEach((listener) => listener(current));
}

export function subscribeDriveSync(listener: (state: DriveSyncState) => void) {
  listeners.add(listener);
  listener(current);
  return () => { listeners.delete(listener); };
}

export function DriveSyncIndicator() {
  const [state, setState] = useState<DriveSyncState>(current);
  const { width, height } = useWindowDimensions();
  const position = useRef(new Animated.ValueXY({ x: Math.max(8, width - 260), y: 48 })).current;
  const panResponder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > 3 || Math.abs(gesture.dy) > 3,
    onPanResponderGrant: () => {
      position.setOffset({ x: position.x.__getValue(), y: position.y.__getValue() });
      position.setValue({ x: 0, y: 0 });
    },
    onPanResponderMove: Animated.event([null, { dx: position.x, dy: position.y }], { useNativeDriver: false }),
    onPanResponderRelease: () => position.flattenOffset(),
    onPanResponderTerminate: () => position.flattenOffset(),
  })).current;
  useEffect(() => subscribeDriveSync(setState), []);

  // Keep a clear confirmation long enough to read; errors remain visible until resolved.
  useEffect(() => {
    if (state.phase !== "success") return;
    const timer = setTimeout(() => setDriveSyncState({ phase: "idle", updates: 0, message: "" }), 7000);
    return () => clearTimeout(timer);
  }, [state.phase, state.message]);

  if (state.phase === "idle") return null;
  const active = state.phase === "waiting" || state.phase === "uploading";
  const backgroundColor = state.phase === "error" ? "#FEE2E2" : state.phase === "success" ? "#DCFCE7" : "#DBEAFE";
  const color = state.phase === "error" ? "#991B1B" : state.phase === "success" ? "#166534" : "#1D4ED8";
  const label = state.phase === "waiting"
    ? "Changes waiting to sync"
    : state.message || (state.phase === "success" ? "Backup uploaded" : "Uploading backup…");

  return (
    <Animated.View {...panResponder.panHandlers} style={{ position: "absolute", left: 0, top: 0, zIndex: 9999, elevation: 12, maxWidth: Math.min(state.phase === "error" ? 300 : 260, width - 16), flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 7, paddingVertical: 4, borderRadius: 14, backgroundColor, opacity: 0.94, transform: position.getTranslateTransform() }}>
      {active ? <ActivityIndicator size="small" color={color} /> : null}
      <Text numberOfLines={state.phase === "error" ? 3 : 2} style={{ color, fontSize: 10, fontWeight: "700", flexShrink: 1 }}>{label}</Text>
    </Animated.View>
  );
}
