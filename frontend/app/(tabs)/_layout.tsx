import { Redirect, Tabs } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/src/api/client";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import Ionicons from "@react-native-vector-icons/ionicons";
import { Platform } from "react-native";

import { useAuth } from "@/src/auth/AuthContext";
import { usesNativeTabs } from "@/src/navigation";
import { fontFamily, useTheme } from "@/src/theme";

export default function TabsLayout() {
  const { user, initializing } = useAuth();
  const { colors } = useTheme();
  const { data: patients = [] } = useQuery<Array<{ procedure?: string }>>({
    queryKey: ["patients"],
    queryFn: () => api.get("/patients"),
  });
  // A blank first procedure means it needs review; the optional second procedure is not required.
  const hasMissingProcedure = patients.some((patient) => !String(patient.procedure || "").trim());

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
        <NativeTabs.Trigger name="stock">
          <NativeTabs.Trigger.Icon sf="shippingbox.fill" />
          <NativeTabs.Trigger.Label>Stock</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="procedures">
          <NativeTabs.Trigger.Icon sf="cross.case.fill" />
          <NativeTabs.Trigger.Label>Procedures</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="procedure-check">
          <NativeTabs.Trigger.Icon sf="checklist" />
          <NativeTabs.Trigger.Label>Procedure Check</NativeTabs.Trigger.Label>
          {hasMissingProcedure ? <NativeTabs.Trigger.Badge>•</NativeTabs.Trigger.Badge> : null}
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="stats">
          <NativeTabs.Trigger.Icon sf="chart.bar.fill" />
          <NativeTabs.Trigger.Label>Stats</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="lab-trends">
          <NativeTabs.Trigger.Icon sf="chart.xyaxis.line" />
          <NativeTabs.Trigger.Label>Lab Trends</NativeTabs.Trigger.Label>
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
        name="stock"
        options={{
          title: "Stock",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? "cube" : "cube-outline"} size={size} color={color} />
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
        name="procedure-check"
        options={{
          title: "Procedure Check",
          tabBarBadge: hasMissingProcedure ? " " : undefined,
          tabBarBadgeStyle: hasMissingProcedure ? { backgroundColor: "#DC2626", color: "#DC2626", minWidth: 8, height: 8, borderRadius: 4, padding: 0, fontSize: 0, lineHeight: 8 } : undefined,
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? "clipboard" : "clipboard-outline"} size={size} color={color} />
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
      <Tabs.Screen
        name="lab-trends"
        options={{
          title: "Lab Trends",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? "analytics" : "analytics-outline"} size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
