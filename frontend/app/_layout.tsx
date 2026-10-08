import { useEffect, useState } from "react";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { LogBox, Pressable, Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClientProvider } from "@tanstack/react-query";

import { AuthProvider } from "@/src/auth/AuthContext";
import { ErrorBoundary } from "@/src/components/error-boundary";
import { ToastProvider } from "@/src/components/toast";
import { queryClient } from "@/src/query-client";
import { initializeDatabase, repairDatabaseData } from "@/src/db/database";
import { ThemeProvider } from "@/src/theme";
import { startAutomaticDriveBackup } from "@/src/utils/storage/drive-auto-backup";

LogBox.ignoreAllLogs(true);

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
    return startAutomaticDriveBackup();
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
                    <StatusBar style="dark" />

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
                    <Stack.Screen name="branding" />
                    <Stack.Screen name="admin-pin" />
                    <Stack.Screen name="inventory-usage" options={{ headerShown: false }} />
                    <Stack.Screen name="join-clinic" />
                  </Stack>

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
