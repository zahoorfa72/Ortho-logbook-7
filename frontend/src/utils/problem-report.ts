import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { Dimensions, Platform } from "react-native";

const STORAGE_KEY = "ortho_problem_report_recent_errors_v1";
const MAX_ERRORS = 20;

export type DiagnosticError = {
  at: string;
  message: string;
  stack?: string;
  fatal?: boolean;
  context?: string;
};

function safeText(value: unknown, limit = 2400): string {
  return String(value ?? "")
    .replace(/(access[_ -]?token|refresh[_ -]?token|authorization|password|client[_ -]?secret)\s*[:=]\s*[^\s,;]+/ig, "$1=[redacted]")
    .slice(0, limit);
}

export async function recordDiagnosticError(error: unknown, extraStack = "", fatal?: boolean): Promise<void> {
  try {
    const current = await AsyncStorage.getItem(STORAGE_KEY);
    let errors: DiagnosticError[] = [];
    try {
      const parsed = current ? JSON.parse(current) : [];
      if (Array.isArray(parsed)) errors = parsed.filter(item => item && typeof item.message === "string");
    } catch {}
    const candidate = error as any;
    errors.push({
      at: new Date().toISOString(),
      message: safeText(candidate?.message || error || "Unknown JavaScript error", 1000),
      stack: safeText(candidate?.stack || extraStack || "", 2400),
      ...(extraStack ? { context: safeText(extraStack, 500) } : {}),
      ...(typeof fatal === "boolean" ? { fatal } : {}),
    });
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(errors.slice(-MAX_ERRORS)));
  } catch {
    // Diagnostics must never cause or worsen an app failure.
  }
}

export function installGlobalErrorCapture(): void {
  try {
    const errorUtils = (globalThis as any).ErrorUtils;
    if (!errorUtils?.getGlobalHandler || !errorUtils?.setGlobalHandler || errorUtils.__orthoProblemCaptureInstalled) return;
    const previousHandler = errorUtils.getGlobalHandler();
    const wrappedHandler = (error: unknown, isFatal?: boolean) => {
      void recordDiagnosticError(error, "", isFatal);
      try { previousHandler?.(error, isFatal); } catch {}
    };
    errorUtils.__orthoProblemCaptureInstalled = true;
    errorUtils.setGlobalHandler(wrappedHandler);
  } catch {
    // Some runtimes do not expose ErrorUtils; manual problem reports still work.
  }
}

export async function buildProblemReport(description = "", currentError?: unknown): Promise<string> {
  let errors: DiagnosticError[] = [];
  try {
    const saved = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed = saved ? JSON.parse(saved) : [];
    if (Array.isArray(parsed)) errors = parsed.filter(item => item && typeof item.message === "string").slice(-8);
  } catch {}

  if (currentError) {
    const candidate = currentError as any;
    errors.push({
      at: new Date().toISOString(),
      message: safeText(candidate?.message || currentError, 1000),
      stack: safeText(candidate?.stack || "", 2400),
      fatal: true,
    });
  }

  const windowSize = Dimensions.get("window");
  const appVersion = Constants.expoConfig?.version || "unknown";
  const buildNumber = Platform.OS === "android"
    ? String(Constants.expoConfig?.android?.versionCode ?? "unknown")
    : Platform.OS === "ios"
      ? String(Constants.expoConfig?.ios?.buildNumber ?? "unknown")
      : "not applicable";

  const recent = errors.length
    ? errors.map((item, index) =>
        `${index + 1}. [${item.at}]${item.fatal ? " [fatal]" : ""}${item.context ? " [context: " + safeText(item.context, 500) + "]" : ""} ${safeText(item.message, 1000)}${item.stack ? "\n   Stack: " + safeText(item.stack, 1800) : ""}`
      ).join("\n")
    : "No captured JavaScript errors are saved on this device.";

  return [
    "ORTHO LOGBOOK — PROBLEM REPORT",
    `Created: ${new Date().toISOString()}`,
    `App version: ${appVersion}`,
    `Build number: ${buildNumber}`,
    `Platform: ${Platform.OS}`,
    `OS version: ${String(Platform.Version)}`,
    `Screen size: ${Math.round(windowSize.width)} × ${Math.round(windowSize.height)}`,
    "",
    "USER DESCRIPTION",
    safeText(description.trim() || "Not provided", 3000),
    "",
    "RECENT APP ERRORS",
    recent,
    "",
    "PRIVACY NOTE",
    "This report contains technical diagnostics and the description entered by the user. Patient records, patient photos, database contents, and login credentials are not intentionally collected. Review the report before sharing.",
  ].join("\n");
}
