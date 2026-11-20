import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { AppState, Dimensions, Platform } from "react-native";

const STORAGE_KEY = "ortho_problem_report_recent_errors_v1";
const EVENT_KEY = "ortho_problem_report_breadcrumbs_v1";
const CONTEXT_KEY = "ortho_problem_report_context_v1";
const MAX_ERRORS = 40;
const MAX_EVENTS = 100;
const MAX_STACK = 3600;

export type DiagnosticError = {
  at: string;
  message: string;
  stack?: string;
  componentStack?: string;
  fatal?: boolean;
  context?: string;
};

type DiagnosticEvent = { at: string; kind: string; message: string };

function safeText(value: unknown, limit = 2400): string {
  return String(value ?? "")
    .replace(/(access[_ -]?token|refresh[_ -]?token|authorization|password|client[_ -]?secret|api[_ -]?key)\\s*[:=]\\s*[^\\s,;]+/ig, "$1=[redacted]")
    .replace(/Bearer\\s+[A-Za-z0-9._~+/-]+=*/ig, "Bearer [redacted]")
    .replace(/(email|phone|mr\\s*no|patient\\s*name)\\s*[:=]\\s*[^\\n,;]+/ig, "$1=[redacted]")
    .slice(0, limit);
}

async function appendStored<T>(key: string, item: T, max: number): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(key);
    let values: T[] = [];
    try {
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) values = parsed.filter(value => value && typeof value === "object");
    } catch {}
    values.push(item);
    await AsyncStorage.setItem(key, JSON.stringify(values.slice(-max)));
  } catch {
    // Diagnostics must never cause or worsen an app failure.
  }
}

export async function recordDiagnosticEvent(kind: string, message: string): Promise<void> {
  const safeKind = safeText(kind, 60);
  const safeMessage = safeText(message, 240);
  if (!safeMessage.trim()) return;
  await appendStored<DiagnosticEvent>(EVENT_KEY, {
    at: new Date().toISOString(),
    kind: safeKind,
    message: safeMessage,
  }, MAX_EVENTS);
}

export async function recordDiagnosticError(error: unknown, context = "", fatal?: boolean, componentStack = ""): Promise<void> {
  const candidate = error && typeof error === "object" ? error as any : {};
  await appendStored<DiagnosticError>(STORAGE_KEY, {
    at: new Date().toISOString(),
    message: safeText(candidate?.message || error || "Unknown JavaScript error", 1000),
    stack: safeText(candidate?.stack || "", MAX_STACK),
    ...(componentStack ? { componentStack: safeText(componentStack, MAX_STACK) } : {}),
    ...(context ? { context: safeText(context, 500) } : {}),
    ...(typeof fatal === "boolean" ? { fatal } : {}),
  }, MAX_ERRORS);
}

export function installGlobalErrorCapture(): void {
  try {
    const errorUtils = (globalThis as any).ErrorUtils;
    if (errorUtils?.getGlobalHandler && errorUtils?.setGlobalHandler && !errorUtils.__orthoProblemCaptureInstalled) {
      const previousHandler = errorUtils.getGlobalHandler();
      const wrappedHandler = (error: unknown, isFatal?: boolean) => {
        void recordDiagnosticError(error, "Global JavaScript exception", isFatal);
        try { previousHandler?.(error, isFatal); } catch {}
      };
      errorUtils.__orthoProblemCaptureInstalled = true;
      errorUtils.setGlobalHandler(wrappedHandler);
    }
  } catch {}

  try {
    const consoleObject = (globalThis as any).console;
    if (consoleObject && !consoleObject.__orthoProblemCaptureInstalled) {
      for (const method of ["warn", "error"] as const) {
        const original = consoleObject[method];
        if (typeof original !== "function") continue;
        consoleObject[method] = (...args: unknown[]) => {
          const message = args.filter(value => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
            .map(value => safeText(value, 180)).join(" ").slice(0, 400);
          if (message) void recordDiagnosticEvent("console." + method, message);
          return original.apply(consoleObject, args);
        };
      }
      consoleObject.__orthoProblemCaptureInstalled = true;
    }
  } catch {}

  // Persist only coarse screen/route lifecycle context; never record route params.
  try {
    const appStateSubscription = AppState.addEventListener("change", state => {
      void recordDiagnosticEvent("app-state", state);
    });
    void appStateSubscription;
  } catch {}
}

export async function recordDiagnosticContext(kind: string, value: string): Promise<void> {
  await appendStored<DiagnosticEvent>(CONTEXT_KEY, {
    at: new Date().toISOString(),
    kind: safeText(kind, 80),
    message: safeText(value, 160),
  }, 30);
}

export async function buildProblemReport(description = "", currentError?: unknown): Promise<string> {
  let errors: DiagnosticError[] = [];
  let events: DiagnosticEvent[] = [];
  let context: DiagnosticEvent[] = [];
  try {
    const saved = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed = saved ? JSON.parse(saved) : [];
    if (Array.isArray(parsed)) errors = parsed.filter(item => item && typeof item.message === "string").slice(-15);
  } catch {}
  try {
    const saved = await AsyncStorage.getItem(EVENT_KEY);
    const parsed = saved ? JSON.parse(saved) : [];
    if (Array.isArray(parsed)) events = parsed.filter(item => item && typeof item.message === "string").slice(-40);
  } catch {}
  try {
    const saved = await AsyncStorage.getItem(CONTEXT_KEY);
    const parsed = saved ? JSON.parse(saved) : [];
    if (Array.isArray(parsed)) context = parsed.filter(item => item && typeof item.message === "string").slice(-15);
  } catch {}

  if (currentError) {
    const candidate = currentError && typeof currentError === "object" ? currentError as any : {};
    errors.push({
      at: new Date().toISOString(),
      message: safeText(candidate?.message || currentError, 1000),
      stack: safeText(candidate?.stack || "", MAX_STACK),
      fatal: true,
      context: "Current error screen",
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
        `${index + 1}. [${safeText(item.at, 80)}]${item.fatal ? " [fatal]" : ""}${item.context ? " [context: " + safeText(item.context, 300) + "]" : ""} ${safeText(item.message, 1000)}${item.stack ? "\\n   Stack: " + safeText(item.stack, MAX_STACK) : ""}${item.componentStack ? "\\n   Component stack: " + safeText(item.componentStack, MAX_STACK) : ""}`
      ).join("\\n")
    : "No captured JavaScript errors are saved on this device.";
  const eventText = events.length
    ? events.map((item, index) => `${index + 1}. [${safeText(item.at, 80)}] [${safeText(item.kind, 60)}] ${safeText(item.message, 300)}`).join("\\n")
    : "No recent app-action breadcrumbs are saved.";
  const contextText = context.length
    ? context.map(item => `[${safeText(item.at, 80)}] [${safeText(item.kind, 80)}] ${safeText(item.message, 160)}`).join("\\n")
    : "No screen lifecycle context recorded.";

  return [
    "ORTHO LOGBOOK — PROBLEM REPORT",
    `Created: ${new Date().toISOString()}`,
    `App version: ${appVersion}`,
    `Build number: ${buildNumber}`,
    `Platform: ${Platform.OS}`,
    `OS version: ${String(Platform.Version)}`,
    `Screen size: ${Math.round(windowSize.width)} × ${Math.round(windowSize.height)}`,
    `Device: ${safeText(Constants.deviceName || "unknown", 100)}`,
    `Runtime: ${safeText(Constants.executionEnvironment || "unknown", 80)}`,
    "",
    "USER DESCRIPTION",
    safeText(description.trim() || "Not provided", 3000),
    "",
    "RECENT APP ERRORS (up to 15)",
    recent,
    "",
    "RECENT TECHNICAL EVENTS (up to 40; warnings/errors and safe breadcrumbs)",
    eventText,
    "",
    "RECENT APP CONTEXT",
    contextText,
    "",
    "PRIVACY NOTE",
    "Technical diagnostics only. Access tokens, passwords, API keys, email/phone-like values, MR numbers and patient-name fields are redacted where recognizable. Patient records, patient photos, database contents and arbitrary object values are not collected. Review before sharing.",
  ].join("\\n");
}
