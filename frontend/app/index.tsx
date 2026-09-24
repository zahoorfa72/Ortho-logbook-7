import { Redirect } from "expo-router";
import { ActivityIndicator, View } from "react-native";

import { useAuth } from "@/src/auth/AuthContext";
import { useTheme } from "@/src/theme";

export default function Index() {
  const { user, initializing } = useAuth();
  const { colors } = useTheme();

  if (initializing) {
    return (
      <View
        testID="app-loading"
        style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface }}
      >
        <ActivityIndicator size="large" color={colors.brandPrimary} />
      </View>
    );
  }

  return <Redirect href={user ? "/(tabs)" : "/login"} />;
}
