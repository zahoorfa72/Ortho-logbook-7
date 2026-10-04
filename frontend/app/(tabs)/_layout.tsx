import { Redirect, Tabs } from "expo-router";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import Ionicons from "@react-native-vector-icons/ionicons";
import { Platform } from "react-native";

import { useAuth } from "@/src/auth/AuthContext";
import { usesNativeTabs } from "@/src/navigation";
import { fontFamily, useTheme } from "@/src/theme";

export default function TabsLayout() {
  const { user, initializing } = useAuth();
  const { colors } = useTheme();

  if (!initializing && !user) return <Redirect href="/login" />;

  if (usesNativeTabs) {
    return (
      <NativeTabs>
        <NativeTabs.Trigger name="index">
          <NativeTabs.Trigger.Icon sf="list.bullet.rectangle" />
          <NativeTabs.Trigger.Label>Logbook</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="inventory">
          <NativeTabs.Trigger.Icon sf="shippingbox.fill" />
          <NativeTabs.Trigger.Label>Inventory</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="implants">
          <NativeTabs.Trigger.Icon sf="cross.case.fill" />
          <NativeTabs.Trigger.Label>Implants</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="procedures">
          <NativeTabs.Trigger.Icon sf="cross.case.fill" />
          <NativeTabs.Trigger.Label>Procedures</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="stats">
          <NativeTabs.Trigger.Icon sf="chart.bar.fill" />
          <NativeTabs.Trigger.Label>Stats</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
      </NativeTabs>
    );
  }

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.brandPrimary,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          ...(Platform.OS === "web" ? { height: 64 } : {}),
        },
        tabBarItemStyle: { alignSelf: "center" },
        tabBarLabelStyle: { fontFamily: fontFamily.semibold, fontSize: 11 },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Logbook",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? "reader" : "reader-outline"} size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="inventory"
        options={{
          title: "Inventory",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? "cube" : "cube-outline"} size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="implants"
        options={{
          title: "Implants",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? "medkit" : "medkit-outline"} size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="procedures"
        options={{
          title: "Procedures",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? "medkit" : "medkit-outline"} size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="stats"
        options={{
          title: "Stats",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? "stats-chart" : "stats-chart-outline"} size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
