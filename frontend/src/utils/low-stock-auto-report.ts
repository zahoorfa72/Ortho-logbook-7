import * as SecureStore from "expo-secure-store";
import * as Print from "expo-print";
import * as FileSystem from "expo-file-system/legacy";
import { api } from "@/src/api/client";
import { defaultBranding } from "@/src/theme";
import { storage } from "@/src/utils/storage";
import { buildInventoryHtml } from "@/src/utils/pdf";

export type LowStockSchedule = "weekly" | "15days" | "monthly";
export type LowStockReportConfig = {
  schedule: LowStockSchedule;
  emails: string;
  resendApiKey: string;
  senderEmail: string;
  whatsappNumbers: string;
  whatsappToken: string;
  whatsappPhoneNumberId: string;
  whatsappGraphVersion: string;
  savedAt: string;
};
type ReportState = { emailLastSentAt?: string; whatsappLastSentAt?: string; lastError?: string; lastStatus?: string };
const CONFIG_KEY = "ortho_low_stock_report_config";
const STATE_KEY = "ortho_low_stock_report_state";
const isoNow = () => new Date().toISOString();
const parseList = (value: string) => [...new Set(value.split(/[\n,;]+/).map(x => x.trim()).filter(Boolean))];
const dueMs = (schedule: LowStockSchedule) => schedule === "weekly" ? 7 * 86400000 : schedule === "15days" ? 15 * 86400000 : 30 * 86400000;

export async function loadLowStockReportConfig(): Promise<LowStockReportConfig | null> {
  try {
    const raw = await SecureStore.getItemAsync(CONFIG_KEY);
    return raw ? JSON.parse(raw) as LowStockReportConfig : null;
  } catch { return null; }
}
export async function saveLowStockReportConfig(config: LowStockReportConfig): Promise<void> {
  await SecureStore.setItemAsync(CONFIG_KEY, JSON.stringify(config));
}
export async function getLowStockReportState(): Promise<ReportState> {
  try { return JSON.parse((await SecureStore.getItemAsync(STATE_KEY)) || "{}") as ReportState; } catch { return {}; }
}
async function saveState(state: ReportState) {
  await SecureStore.setItemAsync(STATE_KEY, JSON.stringify(state));
}
function assertOk(response: Response, body: any, provider: string) {
  if (!response.ok) throw new Error(body?.message || body?.error?.message || body?.error || provider + " returned HTTP " + response.status);
}
async function makePdf(): Promise<{ uri: string; base64: string; count: number }> {
  const inventory = await api.get<any[]>("/inventory");
  const low = (Array.isArray(inventory) ? inventory : []).filter(i => Number(i.quantity) <= Number(i.minimumStock));
  if (!low.length) throw new Error("No low-stock items are currently due for a report.");
  const saved = await storage.getItem<string>("ortho_branding", "");
  let branding: any = defaultBranding;
  if (saved) { try { branding = { ...defaultBranding, ...(typeof saved === "string" ? JSON.parse(saved) : saved) }; } catch {} }
  const html = buildInventoryHtml(branding, low, true, "Scheduled Low Stock Report");
  const file = await Print.printToFileAsync({ html, base64: false });
  const base64 = await FileSystem.readAsStringAsync(file.uri, { encoding: FileSystem.EncodingType.Base64 });
  if (!base64) throw new Error("Could not read the generated low-stock PDF.");
  return { uri: file.uri, base64, count: low.length };
}
export async function sendLowStockTestEmail(config: LowStockReportConfig, recipient?: string) {
  if (!config.resendApiKey.trim() || !config.senderEmail.trim()) throw new Error("Enter the Resend API key and verified sender email first.");
  const to = recipient?.trim() || parseList(config.emails)[0];
  if (!to || !/^\S+@\S+\.\S+$/.test(to)) throw new Error("Enter at least one valid email recipient.");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + config.resendApiKey.trim(), "Content-Type": "application/json" },
    body: JSON.stringify({ from: config.senderEmail.trim(), to: [to], subject: "Ortho Logbook email test", text: "Email sending is configured for Ortho Logbook low-stock reports." })
  });
  const body = await response.json().catch(() => ({}));
  assertOk(response, body, "Email provider");
  return body;
}
export async function sendLowStockTestWhatsApp(config: LowStockReportConfig, recipient?: string) {
  const number = (recipient || parseList(config.whatsappNumbers)[0] || "").replace(/[^\d]/g, "");
  if (!config.whatsappToken.trim() || !config.whatsappPhoneNumberId.trim()) throw new Error("Enter the WhatsApp Business access token and phone-number ID first.");
  if (!number) throw new Error("Enter a WhatsApp recipient with country code.");
  const version = (config.whatsappGraphVersion || "v23.0").trim();
  const response = await fetch("https://graph.facebook.com/" + version + "/" + config.whatsappPhoneNumberId.trim() + "/messages", {
    method: "POST",
    headers: { Authorization: "Bearer " + config.whatsappToken.trim(), "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: number, type: "text", text: { body: "Ortho Logbook WhatsApp connection test. If you received this, WhatsApp Business sending is configured." } })
  });
  const body = await response.json().catch(() => ({}));
  assertOk(response, body, "WhatsApp Business");
  return body;
}
async function sendEmailPdf(config: LowStockReportConfig, pdf: string, count: number) {
  const recipients = parseList(config.emails);
  if (!recipients.length) throw new Error("No email recipients are configured.");
  if (!config.resendApiKey.trim() || !config.senderEmail.trim()) throw new Error("Email provider credentials are missing.");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + config.resendApiKey.trim(), "Content-Type": "application/json" },
    body: JSON.stringify({
      from: config.senderEmail.trim(), to: recipients,
      subject: "Ortho Logbook — Low Stock Report (" + count + " items)",
      text: "Attached is the scheduled low-stock report. It contains " + count + " low-stock items.",
      attachments: [{ filename: "ortho-logbook-low-stock.pdf", content: pdf, content_type: "application/pdf" }]
    })
  });
  const body = await response.json().catch(() => ({}));
  assertOk(response, body, "Email provider");
}
async function sendWhatsAppPdf(config: LowStockReportConfig, uri: string, count: number) {
  const recipients = parseList(config.whatsappNumbers).map(x => x.replace(/[^\d]/g, "")).filter(Boolean);
  if (!recipients.length) throw new Error("No WhatsApp recipients are configured.");
  if (!config.whatsappToken.trim() || !config.whatsappPhoneNumberId.trim()) throw new Error("WhatsApp Business credentials are missing.");
  const version = (config.whatsappGraphVersion || "v23.0").trim();
  const root = "https://graph.facebook.com/" + version + "/";
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", "application/pdf");
  form.append("file", { uri, name: "ortho-logbook-low-stock.pdf", type: "application/pdf" } as any);
  const upload = await fetch(root + config.whatsappPhoneNumberId.trim() + "/media", {
    method: "POST", headers: { Authorization: "Bearer " + config.whatsappToken.trim() }, body: form
  });
  const media = await upload.json().catch(() => ({}));
  assertOk(upload, media, "WhatsApp media upload");
  if (!media.id) throw new Error("WhatsApp did not return a PDF media ID.");
  for (const to of recipients) {
    const response = await fetch(root + config.whatsappPhoneNumberId.trim() + "/messages", {
      method: "POST",
      headers: { Authorization: "Bearer " + config.whatsappToken.trim(), "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "document", document: { id: media.id, filename: "ortho-logbook-low-stock.pdf", caption: "Scheduled low-stock report — " + count + " items" } })
    });
    const body = await response.json().catch(() => ({}));
    assertOk(response, body, "WhatsApp document delivery");
  }
}
export async function attemptDueLowStockReport(): Promise<string> {
  const config = await loadLowStockReportConfig();
  if (!config) return "Report delivery is not configured.";
  const state = await getLowStockReportState();
  const now = Date.now();
  const due = (last?: string) => !last || now - new Date(last).getTime() >= dueMs(config.schedule);
  const emailDue = parseList(config.emails).length > 0 && Boolean(config.resendApiKey && config.senderEmail) && due(state.emailLastSentAt);
  const whatsappDue = parseList(config.whatsappNumbers).length > 0 && Boolean(config.whatsappToken && config.whatsappPhoneNumberId) && due(state.whatsappLastSentAt);
  if (!emailDue && !whatsappDue) return "No scheduled low-stock report is due.";
  try {
    const pdf = await makePdf();
    const next: ReportState = { ...state };
    const successes: string[] = [];
    if (emailDue) {
      try { await sendEmailPdf(config, pdf.base64, pdf.count); next.emailLastSentAt = isoNow(); successes.push("email"); }
      catch (e: any) { next.lastError = "Email: " + String(e?.message || e); }
    }
    if (whatsappDue) {
      try { await sendWhatsAppPdf(config, pdf.uri, pdf.count); next.whatsappLastSentAt = isoNow(); successes.push("WhatsApp"); }
      catch (e: any) { next.lastError = "WhatsApp: " + String(e?.message || e); }
    }
    next.lastStatus = successes.length ? "Sent low-stock PDF by " + successes.join(" and ") + "." : "Low-stock report delivery failed.";
    await saveState(next);
    return next.lastStatus + (next.lastError ? " " + next.lastError : "");
  } catch (e: any) {
    const message = String(e?.message || e || "Report generation failed.");
    await saveState({ ...state, lastError: message, lastStatus: "Waiting to retry: " + message });
    return "Waiting to retry: " + message;
  }
}
