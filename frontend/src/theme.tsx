// Shared design tokens and persisted clinic branding for the offline app.

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Appearance, StyleSheet, useColorScheme } from "react-native";

import { storage } from "@/src/utils/storage";

export type ColorScheme = "light" | "dark";

const light = {
  surface: "#F9F8F6",
  onSurface: "#1C1C1E",
  surfaceSecondary: "#FFFFFF",
  onSurfaceSecondary: "#2C2C2E",
  surfaceTertiary: "#EFECE6",
  onSurfaceTertiary: "#3A3A3C",
  surfaceInverse: "#1C1C1E",
  onSurfaceInverse: "#F9F8F6",
  muted: "#7C7872",
  brand: "#4A6B5D",
  onBrand: "#FFFFFF",
  brandPrimary: "#4A6B5D",
  onBrandPrimary: "#FFFFFF",
  brandSecondary: "#385347",
  onBrandSecondary: "#FFFFFF",
  brandTertiary: "#DCE5E1",
  onBrandTertiary: "#293D34",
  success: "#3B7A57",
  onSuccess: "#FFFFFF",
  warning: "#C27803",
  warningSurface: "#FEF3C7",
  onWarning: "#FFFFFF",
  error: "#A83232",
  onError: "#FFFFFF",
  info: "#3A6073",
  onInfo: "#FFFFFF",
  border: "#E2DFD8",
  borderStrong: "#C7C2B6",
  divider: "#EFECE6",
};

export type ThemeColors = typeof light;
export const defaultScheme = "light" satisfies ColorScheme;
export const themes: { light: ThemeColors; dark?: ThemeColors } = { light };

export type BrandingConfig = {
  title: string;
  logoBase64: string;      // Left logo (used in-app + on PDF left)
  logoBase64Right: string; // Right logo (PDF only)
  pdfSubtitle: string;     // 2-3 lines shown below the title in PDF header
  pdfLogoLayout: "center" | "left"; // Header layout: centered title with side logos, or left-aligned
  pdfTitleFont: "regular" | "medium" | "semibold" | "bold";
  pdfTitleSize: number;
  pdfSubtitleFont: "regular" | "medium" | "semibold" | "bold";
  pdfSubtitleSize: number;
  pdfSubtitleLines?: { text: string; size: number; font: "regular" | "medium" | "semibold" | "bold"; bold: boolean }[];
  pdfTableHeaderColor: string;
  pdfTableStripeColor: string;
  pdfFooterText: string;
  pdfMargin: number;
  pdfShowGeneratedAt: boolean;
  pdfPageSize: "A4" | "Letter";
  pdfOrientation: "portrait" | "landscape";
  pdfPatientFields?: string[];
  pdfMainHeadingField?: string;
  pdfSubHeadingField?: string;
  pdfHeadingLevels?: { fields: string[]; label?: string }[];
  pdfHeadingMap?: Record<string, { heading: string[]; subHeading: string[] }>;
  pdfImplantSubheadingColor?: string;
  pdfImplantHeading?: string;
  pdfImplantSubheading?: string;
  pdfPatientsPerPage?: number;
  pdfShowOccurrenceBadge?: boolean;
  pdfListTextSize?: "small" | "medium" | "large";
  pdfListTextWeight?: "normal" | "bold";
  pdfListTextTone?: "light" | "normal" | "dark";
  pdfListRowSpacing?: "compact" | "normal" | "spacious";
  // Full theme colors
  primary: string;
  onPrimary: string;
  secondary: string;
  tertiary: string;
  onTertiary: string;
  background: string;
  surface: string;
  text: string;
  mutedText: string;
};

const BRANDING_KEY = "ortho_branding";
export const defaultBranding: BrandingConfig = {
  title: "Ortho Logbook",
  logoBase64: "",
  logoBase64Right: "",
  pdfSubtitle: "",
  pdfLogoLayout: "center",
  pdfTitleFont: "bold",
  pdfTitleSize: 24,
  pdfSubtitleFont: "regular",
  pdfSubtitleSize: 12,
  pdfSubtitleLines: [
    { text: "", size: 12, font: "regular", bold: false },
    { text: "", size: 12, font: "regular", bold: false },
    { text: "", size: 12, font: "regular", bold: false },
    { text: "", size: 12, font: "regular", bold: false },
  ],
  pdfTableHeaderColor: light.brandTertiary,
  pdfTableStripeColor: "#FAFAF7",
  pdfFooterText: "Offline Report",
  pdfMargin: 28,
  pdfShowGeneratedAt: true,
  pdfPageSize: "A4",
  pdfOrientation: "portrait",
  pdfPatientFields: ["date","mrNo","name","gender","age","address","diagnosis","procedure"],
  pdfMainHeadingField: "name",
  pdfSubHeadingField: "procedure",
  pdfHeadingLevels: [
    { fields: ["name"], label: "Main Heading" },
    { fields: ["procedure"], label: "Sub-heading 1" },
  ],
  pdfImplantSubheadingColor: "#8A9690",
  pdfImplantHeading: "Implants",
  pdfImplantSubheading: "Used Implants",
  pdfPatientsPerPage: 20,
  pdfShowOccurrenceBadge: true,
  pdfListTextSize: "medium",
  pdfListTextWeight: "normal",
  pdfListTextTone: "normal",
  pdfListRowSpacing: "compact",
  primary: light.brandPrimary,
  onPrimary: light.onBrandPrimary,
  secondary: light.brandSecondary,
  tertiary: light.brandTertiary,
  onTertiary: light.onBrandTertiary,
  background: light.surface,
  surface: light.surfaceSecondary,
  text: light.onSurface,
  mutedText: light.muted,
};

export const BRANDING_PRESETS: { name: string; palette: Partial<BrandingConfig> }[] = [
  { name: "Forest (default)", palette: { primary: "#4A6B5D", secondary: "#385347", tertiary: "#DCE5E1", onTertiary: "#293D34" } },
  { name: "Ocean", palette: { primary: "#0F52BA", secondary: "#083D8F", tertiary: "#DDEBFB", onTertiary: "#0A3573" } },
  { name: "Rose", palette: { primary: "#B03052", secondary: "#872341", tertiary: "#FBE1E8", onTertiary: "#6B1A32" } },
  { name: "Charcoal", palette: { primary: "#2C2C2E", secondary: "#000000", tertiary: "#E5E5EA", onTertiary: "#1C1C1E" } },
  { name: "Amber", palette: { primary: "#C97B15", secondary: "#8A5410", tertiary: "#FFEEC7", onTertiary: "#5C3B0B" } },
];

type ThemeContextValue = {
  branding: BrandingConfig;
  setBranding: (next: BrandingConfig) => Promise<void>;
  resetBranding: () => Promise<void>;
};

const ThemeContext = createContext<ThemeContextValue>({
  branding: defaultBranding,
  setBranding: async () => undefined,
  resetBranding: async () => undefined,
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [branding, setBrandingState] = useState(defaultBranding);

  useEffect(() => {
    storage.getItem<string>(BRANDING_KEY, "").then((saved) => {
      if (typeof saved === "string" && saved) {
        try {
          const parsed = JSON.parse(saved) as BrandingConfig;
          if (parsed && typeof parsed === "object") setBrandingState({ ...defaultBranding, ...parsed, pdfPatientFields: (Array.isArray(parsed.pdfPatientFields) ? parsed.pdfPatientFields : defaultBranding.pdfPatientFields), pdfHeadingLevels: (Array.isArray(parsed.pdfHeadingLevels) ? parsed.pdfHeadingLevels : defaultBranding.pdfHeadingLevels).map((g:any) => ({ ...g, fields: Array.isArray(g?.fields) ? g.fields : [] })) });
        } catch {}
      }
    });
  }, []);

  const setBranding = async (next: BrandingConfig) => {
    setBrandingState(next);
    await storage.setItem(BRANDING_KEY, JSON.stringify(next));
  };

  const resetBranding = async () => {
    setBrandingState(defaultBranding);
    await storage.setItem(BRANDING_KEY, JSON.stringify(defaultBranding));
  };

  return <ThemeContext.Provider value={{ branding, setBranding, resetBranding }}>{children}</ThemeContext.Provider>;
}

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 };
export const radius = { sm: 6, md: 12, lg: 20, pill: 999 };
export const fontSize = { xs: 11, sm: 12, base: 14, lg: 16, xl: 20, xxl: 24, huge: 40 };
export const fontFamily = {
  regular: "PlusJakartaSans-Regular",
  medium: "PlusJakartaSans-Medium",
  semibold: "PlusJakartaSans-SemiBold",
  bold: "PlusJakartaSans-Bold",
  monoRegular: "JetBrainsMono-Regular",
  monoMedium: "JetBrainsMono-Medium",
  monoBold: "JetBrainsMono-Bold",
};

export function setColorScheme(scheme: ColorScheme | null) {
  // Appearance.setColorScheme expects ColorSchemeName; cast to satisfy TS.
  Appearance.setColorScheme?.(scheme as any);
}

setColorScheme(themes.dark ? null : defaultScheme);

export function useTheme() {
  const system = useColorScheme();
  const scheme: ColorScheme = system === "dark" && themes.dark ? "dark" : "light";
  const { branding, setBranding, resetBranding } = useContext(ThemeContext);
  const colors = useMemo(() => ({
    ...(themes[scheme] ?? themes.light),
    // apply branded overrides
    surface: branding.background,
    surfaceSecondary: branding.surface,
    onSurface: branding.text,
    muted: branding.mutedText,
    brand: branding.primary,
    brandPrimary: branding.primary,
    onBrandPrimary: branding.onPrimary,
    brandSecondary: branding.secondary,
    brandTertiary: branding.tertiary,
    onBrandTertiary: branding.onTertiary,
  }), [branding, scheme]);
  return { scheme, colors, branding, setBranding, resetBranding };
}

export function makeStyles<T extends StyleSheet.NamedStyles<T> | StyleSheet.NamedStyles<any>>(
  factory: (colors: ThemeColors) => T & StyleSheet.NamedStyles<any>,
): () => T {
  return function useStyles(): T {
    const { colors } = useTheme();
    return useMemo(() => StyleSheet.create(factory(colors)), [colors]);
  };
}
