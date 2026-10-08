import React, { useEffect, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";

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
  useEffect(() => subscribeDriveSync(setState), []);

  // Successful sync is briefly confirmed, then the chip disappears so it never
  // covers app controls. Errors remain visible as a compact tag.
  useEffect(() => {
    if (state.phase !== "success") return;
    const timer = setTimeout(() => setDriveSyncState({ phase: "idle", updates: 0, message: "" }), 2500);
    return () => clearTimeout(timer);
  }, [state.phase, state.message]);

  if (state.phase === "idle") return null;
  const active = state.phase === "waiting" || state.phase === "uploading";
  const backgroundColor = state.phase === "error" ? "#FEE2E2" : state.phase === "success" ? "#DCFCE7" : "#DBEAFE";
  const color = state.phase === "error" ? "#991B1B" : state.phase === "success" ? "#166534" : "#1D4ED8";
  const label = state.phase === "error"
    ? "Drive error"
    : state.phase === "success"
      ? "Synced"
      : state.phase === "waiting"
        ? `Sync ${state.updates || 1}…`
        : `Upload ${state.updates || 1}…`;

  return (
    <View pointerEvents="none" style={{ position: "absolute", top: 48, right: 8, zIndex: 9999, elevation: 12, maxWidth: 112, flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 7, paddingVertical: 4, borderRadius: 14, backgroundColor, opacity: 0.94 }}>
      {active ? <ActivityIndicator size="small" color={color} /> : null}
      <Text numberOfLines={1} style={{ color, fontSize: 10, fontWeight: "700" }}>{label}</Text>
    </View>
  );
}
