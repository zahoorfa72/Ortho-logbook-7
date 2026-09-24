import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { LogBox, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClientProvider } from "@tanstack/react-query";

import { AuthProvider } from "@/src/auth/AuthContext";
import { ErrorBoundary } from "@/src/components/error-boundary";
import { ToastProvider } from "@/src/components/toast";
import { queryClient } from "@/src/query-client";
import { initializeDatabase } from "@/src/db/database";
import { ThemeProvider } from "@/src/theme";

LogBox.ignoreAllLogs(true);

export default function RootLayout() {
  initializeDatabase();

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
                    <Stack.Screen name="join-clinic" />
                  </Stack>

                  </ToastProvider>
                </AuthProvider>
              </KeyboardProvider>
            </QueryClientProvider>
          </ThemeProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  );
}
