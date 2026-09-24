import { Platform } from "react-native";

// Native tabs are production-ready but only render correctly on iOS 26+.
// Everywhere else falls back to the classic JS <Tabs>.
export const usesNativeTabs =
  Platform.OS === "ios" && parseInt(String(Platform.Version), 10) >= 26;
