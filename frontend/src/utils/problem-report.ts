import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { Dimensions, Platform } from "react-native";

const STORAGE_KEY = "ortho_problem_report_recent_errors_v1";
const EVENT_KEY = "ortho_problem_report_breadcrumbs_v1";
const MAX_ERRORS = 30;
const MAX_EVENTS = 60;

export type DiagnosticError = {
  at: string;
  message: string;
  stack?: string;
  fatal?: boolean;
  context?: string;
};

type DiagnosticEvent = { at: string; kind: string; message: string };

function safeText(value: unknown, limit = 2400): string {
  return String(value ?? "")
    .replace(/(access[_ -]?token|refresh[_ -]?token|authorization|password|client[_ -]?secret)\s*[:=]\s*[^\s,;]+/ig, "$1=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/ig, "Bearer [redacted]")
    .slice(0, limit);
}

async function appendStored<T>(key: string, item: T, max: number): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(key);
    let values: T[] = [];
    try {
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) values = parsed;
    } catch {}
    values.push(item);
    await AsyncStorage.setItem(key, JSON.stringify(values.slice(-max)));
  } catch {
    // Diagnostics must never cause or worsen an app failure.
  }
}

/** Add a small, privacy-filtered breadcrumb for navigation/action context. */
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

export async function recordDiagnosticError(error: unknown, context = "", fatal?: boolean): Promise<void> {
  const candidate = error as any;
  await appendStored<DiagnosticError>(STORAGE_KEY, {
    at: new Date().toISOString(),
    message: safeText(candidate?.message || error || "Unknown JavaScript error", 1000),
    stack: safeText(candidate?.stack || "", 2400),
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
  } catch {
    // Some runtimes do not expose ErrorUtils; manual problem reports still work.
  }

  // Capture console warnings/errors as breadcrumbs, but never stringify arbitrary
  // objects (which could contain patient data). Keep only short string values.
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
  } catch {
    // Console capture is optional; explicit errors and breadcrumbs remain.
  }
}

export async function buildProblemReport(description = "", currentError?: unknown): Promise<string> {
  let errors: DiagnosticError[] = [];
  let events: DiagnosticEvent[] = [];
  try {
    const saved = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed = saved ? JSON.parse(saved) : [];
    if (Array.isArray(parsed)) errors = parsed.filter(item => item && typeof item.message === "string").slice(-10);
  } catch {}
  try {
    const saved = await AsyncStorage.getItem(EVENT_KEY);
    const parsed = saved ? JSON.parse(saved) : [];
    if (Array.isArray(parsed)) events = parsed.filter(item => item && typeof item.message === "string").slice(-25);
  } catch {}

  if (currentError) {
    const candidate = currentError as any;
    errors.push({
      at: new Date().toISOString(),
      message: safeText(candidate?.message || currentError, 1000),
      stack: safeText(candidate?.stack || "", 2400),
      fatal: true,
      context: "Problem report screen",
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

  const eventText = events.length
    ? events.map((item, index) => `${index + 1}. [${item.at}] [${safeText(item.kind, 60)}] ${safeText(item.message, 300)}`).join("\n")
    : "No recent app-action breadcrumbs are saved.";

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
    "RECENT TECHNICAL EVENTS (warnings/errors only)",
    eventText,
    "",
    "PRIVACY NOTE",
    "This report contains technical diagnostics and the description entered by the user. Patient records, patient photos, database contents, and arbitrary object values are not intentionally collected. Review the report before sharing.",
  ].join("\n");
}
