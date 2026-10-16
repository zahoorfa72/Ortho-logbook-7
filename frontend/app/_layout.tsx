import { useEffect, useState } from "react";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { KeyboardAvoidingView, LogBox, Platform, Pressable, Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClientProvider } from "@tanstack/react-query";

import { AuthProvider } from "@/src/auth/AuthContext";
import { ErrorBoundary } from "@/src/components/error-boundary";
import { ToastProvider, useToast } from "@/src/components/toast";
import { queryClient } from "@/src/query-client";
import { initializeDatabase, repairDatabaseData } from "@/src/db/database";
import { ThemeProvider } from "@/src/theme";
import { startAutomaticDriveBackup } from "@/src/utils/storage/drive-auto-backup";
import { attemptDueLowStockReport, checkAndSendImmediateLowStockAlerts } from "@/src/utils/low-stock-auto-report";
import { DriveSyncIndicator } from "@/src/utils/storage/drive-sync-status";
import { installGlobalErrorCapture } from "@/src/utils/problem-report";

LogBox.ignoreAllLogs(true);

function LowStockAlertBootstrap() {
  const toast = useToast();
  useEffect(() => {
    let active = true;
    const run = async () => {
      try {
        const result = await attemptDueLowStockReport();
        if (active && /automatically sent|successfully/i.test(result) && !/not due yet|already been sent/i.test(result)) {
          const channels = ["Gmail", "WhatsApp"].filter(channel => new RegExp("\\b" + channel + "\\b", "i").test(result));
          toast("Scheduled low-stock report sent successfully" + (channels.length ? " via " + channels.join(" and ") : "") + ".", "success");
        }
      } catch (error: any) {
        if (active) {
          const detail = String(error?.message || error || "Unknown delivery error");
          toast("Scheduled low-stock report failed. " + detail.slice(0, 105), "error");
        }
      }
      try {
        const result = await checkAndSendImmediateLowStockAlerts();
        if (!active) return;
        if (/FAILED|failed|error|could not|missing/i.test(result) && !/disabled/i.test(result)) {
          toast("Immediate low-stock delivery failed. " + result.slice(0, 100) + ". Admin can retry in Automatic Low Stock Reports.", "error");
        } else if (result.includes("sent")) {
          const channels = ["Gmail", "WhatsApp"].filter(channel => new RegExp("\\b" + channel + "\\b", "i").test(result));
          toast("Immediate low-stock alert sent successfully" + (channels.length ? " via " + channels.join(" and ") : "") + ".", "success");
        }
      } catch {
        if (active) toast("Immediate low-stock alert failed. Admin can retry it in Automatic Low Stock Reports.", "error");
      }
    };
    void run();
    return () => { active = false; };
  }, [toast]);
  return null;
}

function DatabaseBootstrap({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const repair = () => {
    try {
      initializeDatabase();
      repairDatabaseData();
      setError(null);
      setReady(true);
    } catch (e:any) {
      setError(String(e?.message || e || "Local database could not be opened."));
    }
  };

  useEffect(() => { repair(); }, []);

  useEffect(() => {
    if (!ready) return;
    const stopBackup = startAutomaticDriveBackup();
    return stopBackup;
  }, [ready]);

  if (error) {
    return (
      <View style={{ flex: 1, backgroundColor: "#FFFFFF", justifyContent: "center", padding: 24 }}>
        <Text style={{ fontSize: 22, fontWeight: "700", textAlign: "center", marginBottom: 12 }}>Database recovery required</Text>
        <Text selectable style={{ fontSize: 14, textAlign: "center", marginBottom: 20 }}>{error}</Text>
        <Pressable onPress={repair} style={{ alignSelf: "center", paddingHorizontal: 24, paddingVertical: 14, borderRadius: 12, backgroundColor: "#111827" }}>
          <Text style={{ color: "#FFFFFF", fontWeight: "700" }}>Repair and continue</Text>
        </Pressable>
      </View>
    );
  }
  if (!ready) return <View style={{ flex: 1, backgroundColor: "#FFFFFF" }} />;
  return <>{children}</>;
}

export default function RootLayout() {
  useEffect(() => { installGlobalErrorCapture(); }, []);

  const [loaded] = useFonts({
    "PlusJakartaSans-Regular": require("../assets/fonts/PlusJakartaSans-Regular.ttf"),
    "PlusJakartaSans-Medium": require("../assets/fonts/PlusJakartaSans-Medium.ttf"),
    "PlusJakartaSans-SemiBold": require("../assets/fonts/PlusJakartaSans-SemiBold.ttf"),
    "PlusJakartaSans-Bold": require("../assets/fonts/PlusJakartaSans-Bold.ttf"),
    "JetBrainsMono-Regular": require("../assets/fonts/JetBrainsMono-Regular.ttf"),
    "JetBrainsMono-Medium": require("../assets/fonts/JetBrainsMono-Medium.ttf"),
    "JetBrainsMono-Bold": require("../assets/fonts/JetBrainsMono-Bold.ttf"),
  });

  if (!loaded) {
    return <View style={{ flex: 1, backgroundColor: "#FFFFFF" }} />;
  }

  return (
    <ErrorBoundary>
      <DatabaseBootstrap>
        <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <KeyboardProvider>
                <AuthProvider>
                  <ToastProvider>
                    <LowStockAlertBootstrap />
                    <StatusBar style="dark" />
                    <DriveSyncIndicator />

                  <KeyboardAvoidingView
                    style={{ flex: 1 }}
                    behavior={Platform.OS === "ios" ? "padding" : "height"}
                    keyboardVerticalOffset={0}
                  >
                  <Stack screenOptions={{ headerShown: false }}>
                    <Stack.Screen name="index" />
                    <Stack.Screen name="login" />
                    <Stack.Screen name="signup" />
                    <Stack.Screen name="forgot-password" />
                    <Stack.Screen name="user-management" />
                    <Stack.Screen name="patient-history" />
                    <Stack.Screen name="(tabs)" />

                    <Stack.Screen
                      name="patient-form"
                      options={{ presentation: "modal" }}
                    />

                    <Stack.Screen
                      name="backup-restore"
                      options={{ headerShown: false }}
                    />
                    <Stack.Screen name="settings" />
                    <Stack.Screen name="report-problem" />
                    <Stack.Screen name="low-stock-reports" />
                    <Stack.Screen name="trash" options={{ headerShown: false }} />
                    <Stack.Screen name="branding" />
                    <Stack.Screen name="admin-pin" />
                    <Stack.Screen name="inventory-usage" options={{ headerShown: false }} />
                    <Stack.Screen name="join-clinic" />
                  </Stack>
                  </KeyboardAvoidingView>

                  </ToastProvider>
                </AuthProvider>
              </KeyboardProvider>
            </QueryClientProvider>
          </ThemeProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
      </DatabaseBootstrap>
    </ErrorBoundary>
  );
}
