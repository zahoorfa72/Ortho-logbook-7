import * as Print from "expo-print";
import * as FileSystem from "expo-file-system/legacy";
import { AppState, type AppStateStatus } from "react-native";
import { api } from "@/src/api/client";
import { storage } from "@/src/utils/storage";
import { buildInventoryHtml } from "@/src/utils/pdf";

export type ReportFrequency = "weekly" | "15days" | "monthly";
export type LowStockReportConfig = {
  enabled: boolean;
  frequency: ReportFrequency;
  emailEnabled: boolean;
  emailRecipients: string;
  whatsappEnabled: boolean;
  whatsappRecipients: string;
  nextEmailAt: string;
  nextWhatsAppAt: string;
  lastStatus: string;
  lastAttemptAt: string;
};
export type LowStockCredentials = {
  resendApiKey: string;
  resendFrom: string;
  whatsappAccessToken: string;
  whatsappPhoneNumberId: string;
  whatsappApiVersion: string;
  whatsappTemplateName: string;
  whatsappTemplateLanguage: string;
};
export const REPORT_CONFIG_KEY = "ortho_low_stock_report_config";
const SECRET_KEYS = {
  resendApiKey: "ortho_low_stock_resend_api_key",
  resendFrom: "ortho_low_stock_resend_from",
  whatsappAccessToken: "ortho_low_stock_whatsapp_access_token",
  whatsappPhoneNumberId: "ortho_low_stock_whatsapp_phone_id",
  whatsappApiVersion: "ortho_low_stock_whatsapp_api_version",
  whatsappTemplateName: "ortho_low_stock_whatsapp_template",
  whatsappTemplateLanguage: "ortho_low_stock_whatsapp_template_language",
} as const;

export const DEFAULT_REPORT_CONFIG: LowStockReportConfig = {
  enabled: false, frequency: "weekly", emailEnabled: false, emailRecipients: "",
  whatsappEnabled: false, whatsappRecipients: "", nextEmailAt: "", nextWhatsAppAt: "",
  lastStatus: "Not configured", lastAttemptAt: "",
};
export const DEFAULT_REPORT_CREDENTIALS: LowStockCredentials = {
  resendApiKey: "", resendFrom: "", whatsappAccessToken: "", whatsappPhoneNumberId: "",
  whatsappApiVersion: "v23.0", whatsappTemplateName: "", whatsappTemplateLanguage: "en_US",
};

export async function loadLowStockReportConfig(): Promise<LowStockReportConfig> {
  const value = await storage.getItem(REPORT_CONFIG_KEY, DEFAULT_REPORT_CONFIG as any);
  return { ...DEFAULT_REPORT_CONFIG, ...(value && typeof value === "object" ? value as any : {}) };
}
export async function loadLowStockCredentials(): Promise<LowStockCredentials> {
  const values = await Promise.all(Object.entries(SECRET_KEYS).map(async ([field, key]) => [field, await storage.secureGet(key, field === "whatsappApiVersion" ? "v23.0" : field === "whatsappTemplateLanguage" ? "en_US" : "")] as const));
  return { ...DEFAULT_REPORT_CREDENTIALS, ...Object.fromEntries(values) } as LowStockCredentials;
}
export async function saveLowStockCredentials(credentials: LowStockCredentials): Promise<boolean> {
  const results = await Promise.all(Object.entries(SECRET_KEYS).map(([field, key]) => storage.secureSet(key, String(credentials[field as keyof LowStockCredentials] || ""))));
  return results.every(Boolean);
}
export async function saveLowStockReportConfig(config: LowStockReportConfig): Promise<boolean> {
  return storage.setItem(REPORT_CONFIG_KEY, config as any);
}

function recipients(raw: string): string[] {
  return [...new Set(String(raw || "").split(/[\n,;]+/).map(v => v.trim()).filter(Boolean))];
}
function nextRun(from: Date, frequency: ReportFrequency): Date {
  const next = new Date(from);
  if (frequency === "weekly") next.setDate(next.getDate() + 7);
  else if (frequency === "15days") next.setDate(next.getDate() + 15);
  else next.setMonth(next.getMonth() + 1);
  return next;
}
function safeDate(raw: string): number {
  const value = raw ? new Date(raw).getTime() : 0;
  return Number.isFinite(value) ? value : 0;
}
function parseResponse(text: string): any {
  try { return JSON.parse(text); } catch { return { message: text.slice(0, 400) }; }
}
async function requestJson(url: string, init: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  const text = await response.text();
  const data = parseResponse(text);
  if (!response.ok) throw new Error(String(data?.message || data?.error?.message || data?.error || `Request failed (HTTP ${response.status})`));
  return data;
}

async function createLowStockPdf(): Promise<{ uri: string; base64: string; count: number }> {
  const [itemsRaw, savedBranding] = await Promise.all([
    api.get<any[]>("/inventory"),
    storage.getItem("ortho_branding", null as any),
  ]);
  const items = (Array.isArray(itemsRaw) ? itemsRaw : []).filter(item => Number(item.quantity) <= Number(item.minimumStock));
  const branding: any = savedBranding && typeof savedBranding === "object" ? savedBranding : {
    title: "Ortho Logbook", primary: "#1F5F78", secondary: "#FFFFFF", tertiary: "#E8F0F4",
    onPrimary: "#FFFFFF", onTertiary: "#18313B", pdfMargin: 28, pdfPageSize: "A4",
    pdfOrientation: "portrait", pdfFooterText: "Low Stock Report",
  };
  const html = buildInventoryHtml(branding, items, true, `Scheduled Low Stock Report — ${items.length} item${items.length === 1 ? "" : "s"}`);
  const file = await Print.printToFileAsync({ html, base64: false });
  const base64 = await FileSystem.readAsStringAsync(file.uri, { encoding: FileSystem.EncodingType.Base64 });
  if (!base64) throw new Error("Could not read the generated PDF attachment.");
  return { uri: file.uri, base64, count: items.length };
}

async function sendEmail(pdfBase64: string, config: LowStockReportConfig, credentials: LowStockCredentials): Promise<void> {
  const to = recipients(config.emailRecipients);
  if (!credentials.resendApiKey.trim()) throw new Error("Email is enabled, but the admin has not entered a Resend API key.");
  if (!credentials.resendFrom.trim()) throw new Error("Enter a verified sender email address in report settings.");
  if (!to.length || to.some(v => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))) throw new Error("Enter valid email recipient addresses.");
  await requestJson("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${credentials.resendApiKey.trim()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: credentials.resendFrom.trim(), to,
      subject: "Ortho Logbook — Low Stock Report",
      html: "<p>Your scheduled Ortho Logbook low-stock PDF report is attached.</p>",
      attachments: [{ filename: "Ortho-Logbook-Low-Stock-Report.pdf", content: pdfBase64, content_type: "application/pdf" }],
    }),
  });
}

async function sendWhatsApp(pdfUri: string, config: LowStockReportConfig, credentials: LowStockCredentials): Promise<void> {
  const to = recipients(config.whatsappRecipients).map(v => v.replace(/[^\d]/g, ""));
  if (!credentials.whatsappAccessToken.trim()) throw new Error("WhatsApp is enabled, but the admin has not entered an access token.");
  if (!credentials.whatsappPhoneNumberId.trim()) throw new Error("Enter the WhatsApp Business Phone Number ID.");
  if (!to.length || to.some(v => v.length < 8)) throw new Error("Enter recipient WhatsApp numbers with country codes.");
  const version = (credentials.whatsappApiVersion.trim() || "v23.0").replace(/^\/?/, "");
  const base = `https://graph.facebook.com/${version}/${credentials.whatsappPhoneNumberId.trim()}`;
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", "application/pdf");
  form.append("file", { uri: pdfUri, name: "Ortho-Logbook-Low-Stock-Report.pdf", type: "application/pdf" } as any);
  const media = await requestJson(`${base}/media`, {
    method: "POST", headers: { Authorization: `Bearer ${credentials.whatsappAccessToken.trim()}` }, body: form,
  });
  const mediaId = String(media?.id || "");
  if (!mediaId) throw new Error("WhatsApp did not return a PDF media ID.");
  for (const recipient of to) {
    let body: any;
    if (credentials.whatsappTemplateName.trim()) {
      body = {
        messaging_product: "whatsapp", to: recipient, type: "template",
        template: {
          name: credentials.whatsappTemplateName.trim(),
          language: { code: credentials.whatsappTemplateLanguage.trim() || "en_US" },
          components: [{ type: "header", parameters: [{ type: "document", document: { id: mediaId, filename: "Ortho-Logbook-Low-Stock-Report.pdf" } }] }],
        },
      };
    } else {
      body = {
        messaging_product: "whatsapp", to: recipient, type: "document",
        document: { id: mediaId, filename: "Ortho-Logbook-Low-Stock-Report.pdf", caption: "Scheduled Ortho Logbook low-stock report" },
      };
    }
    await requestJson(`https://graph.facebook.com/${version}/${credentials.whatsappPhoneNumberId.trim()}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${credentials.whatsappAccessToken.trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
}

async function sendConfiguredChannels(config: LowStockReportConfig, credentials: LowStockCredentials): Promise<string[]> {
  if (!config.emailEnabled && !config.whatsappEnabled) throw new Error("Enable at least one delivery channel.");
  const pdf = await createLowStockPdf();
  const successes: string[] = [];
  const errors: string[] = [];
  if (config.emailEnabled) {
    try { await sendEmail(pdf.base64, config, credentials); successes.push("Email sent"); }
    catch (e: any) { errors.push(`Email: ${e?.message || "send failed"}`); }
  }
  if (config.whatsappEnabled) {
    try { await sendWhatsApp(pdf.uri, config, credentials); successes.push("WhatsApp PDF sent"); }
    catch (e: any) { errors.push(`WhatsApp: ${e?.message || "send failed"}`); }
  }
  if (errors.length) throw new Error([...successes, ...errors].join(" • "));
  return [...successes, `${pdf.count} low-stock item(s) included`];
}

export async function testLowStockReportDelivery(): Promise<string> {
  const [config, credentials] = await Promise.all([loadLowStockReportConfig(), loadLowStockCredentials()]);
  const results = await sendConfiguredChannels(config, credentials);
  return results.join(" • ");
}

let schedulerStarted = false;
let busy = false;
async function checkDueReport(): Promise<void> {
  if (busy || AppState.currentState !== "active") return;
  busy = true;
  try {
    let config = await loadLowStockReportConfig();
    if (!config.enabled) return;
    const credentials = await loadLowStockCredentials();
    const now = new Date();
    const dueEmail = config.emailEnabled && safeDate(config.nextEmailAt) > 0 && safeDate(config.nextEmailAt) <= now.getTime();
    const dueWhatsApp = config.whatsappEnabled && safeDate(config.nextWhatsAppAt) > 0 && safeDate(config.nextWhatsAppAt) <= now.getTime();
    if (!dueEmail && !dueWhatsApp) return;
    const pdf = await createLowStockPdf();
    const outcomes: string[] = [];
    if (dueEmail) {
      try {
        await sendEmail(pdf.base64, config, credentials);
        config = { ...config, nextEmailAt: nextRun(now, config.frequency).toISOString() };
        outcomes.push("Email sent");
      } catch (e: any) { outcomes.push(`Email failed: ${e?.message || "unknown error"}`); }
      await saveLowStockReportConfig({ ...config, lastStatus: outcomes.join(" • "), lastAttemptAt: now.toISOString() });
    }
    if (dueWhatsApp) {
      try {
        await sendWhatsApp(pdf.uri, config, credentials);
        config = { ...config, nextWhatsAppAt: nextRun(now, config.frequency).toISOString() };
        outcomes.push("WhatsApp PDF sent");
      } catch (e: any) { outcomes.push(`WhatsApp failed: ${e?.message || "unknown error"}`); }
      await saveLowStockReportConfig({ ...config, lastStatus: outcomes.join(" • "), lastAttemptAt: now.toISOString() });
    }
    if (!outcomes.length) await saveLowStockReportConfig({ ...config, lastStatus: "No report channel was due", lastAttemptAt: now.toISOString() });
  } catch (e: any) {
    const config = await loadLowStockReportConfig();
    await saveLowStockReportConfig({ ...config, lastStatus: `Report attempt failed: ${e?.message || "unknown error"}`, lastAttemptAt: new Date().toISOString() });
  } finally { busy = false; }
}
export function startLowStockReportScheduler(): () => void {
  if (schedulerStarted) return () => undefined;
  schedulerStarted = true;
  void checkDueReport();
  const timer = setInterval(() => { void checkDueReport(); }, 60_000);
  const subscription = AppState.addEventListener("change", (state: AppStateStatus) => {
    if (state === "active") void checkDueReport();
  });
  return () => {
    clearInterval(timer);
    subscription.remove();
    schedulerStarted = false;
  };
}
