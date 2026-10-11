import * as SecureStore from "expo-secure-store";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import * as FileSystem from "expo-file-system/legacy";
import { api } from "@/src/api/client";
import { db } from "@/src/db/database";
import { defaultBranding } from "@/src/theme";
import { storage } from "@/src/utils/storage";
import { buildInventoryHtml } from "@/src/utils/pdf";

export type LowStockSchedule = "weekly" | "15days" | "monthly" | "onOpen" | "fixedDate";
export type LowStockReportConfig = {
  schedule: LowStockSchedule;
  fixedDate?: string;
  autoEmailEnabled?: boolean;
  emails: string;
  resendApiKey: string;
  senderEmail: string;
  whatsappNumbers: string;
  whatsappToken: string;
  whatsappPhoneNumberId: string;
  whatsappGraphVersion: string;
  whatsappTemplateName?: string;
  whatsappTemplateLanguage?: string;
  whatsappMode?: "manual" | "meta";
  savedAt: string;
};
type ReportState = { lastGeneratedAt?: string; lastSentAt?: string; lastPeriodKey?: string; lastStatus?: string };
type PdfResult = { uri: string; count: number; periodStart: string; periodEnd: string; periodKey: string };
const CONFIG_KEY = "ortho_low_stock_report_config";
const STATE_KEY = "ortho_low_stock_report_state";

export async function loadLowStockReportConfig(): Promise<LowStockReportConfig | null> {
  try {
    const raw = await SecureStore.getItemAsync(CONFIG_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as LowStockReportConfig;
  } catch { return null; }
}
export async function saveLowStockReportConfig(config: LowStockReportConfig): Promise<void> {
  await SecureStore.setItemAsync(CONFIG_KEY, JSON.stringify(config));
}
export async function getLowStockReportState(): Promise<ReportState> {
  try { return JSON.parse((await SecureStore.getItemAsync(STATE_KEY)) || "{}") as ReportState; } catch { return {}; }
}
async function saveState(state: ReportState) { await SecureStore.setItemAsync(STATE_KEY, JSON.stringify(state)); }

function getPeriod(schedule: LowStockSchedule, now = new Date()) {
  const end = new Date(now);
  const start = new Date(now);
  if (schedule === "weekly") start.setDate(start.getDate() - 7);
  else if (schedule === "15days") start.setDate(start.getDate() - 15);
  else if (schedule === "monthly") start.setDate(start.getDate() - 30);
  else start.setDate(start.getDate() - 7);
  return { start, end, key: `${schedule}:${start.toISOString().slice(0,10)}:${end.toISOString().slice(0,10)}` };
}
function iso(v: Date) { return v.toISOString(); }

async function makePdf(schedule: LowStockSchedule = "weekly"): Promise<PdfResult> {
  const now = new Date();
  const period = getPeriod(schedule, now);
  const inventory = await api.get<any[]>("/inventory");
  const all = Array.isArray(inventory) ? inventory : [];
  const rows = db.getAllSync<any>(
    "SELECT m.inventory_id, m.quantity_after, m.created_at, i.name, i.quantity, i.minimum_stock, i.unit, i.category, i.category_id, i.size, i.low_stock_since FROM inventory_movements m INNER JOIN inventory i ON i.id=m.inventory_id WHERE m.created_at>=? AND m.created_at<=? AND m.quantity_after<=i.minimum_stock ORDER BY m.created_at DESC",
    [iso(period.start), iso(period.end)],
  );
  // Only include low-stock events inside the selected reporting window; do not
  // accidentally turn a weekly report into a lifetime/current-stock report.
  const latestById = new Map<string, any>();
  for (const row of rows) {
    const id = String(row.inventory_id || "");
    if (!id || latestById.has(id)) continue;
    const base = all.find((item:any) => String(item.id) === id) || {};
    latestById.set(id, {
      ...base, id, name: String(row.name || base.name || "Inventory item"),
      quantity: Number(row.quantity_after), minimumStock: Number(row.minimum_stock),
      minimum_stock: Number(row.minimum_stock), unit: row.unit || base.unit,
      category: row.category || base.category, category_id: row.category_id || base.category_id,
      size: row.size || base.size, lowStockEventAt: row.created_at,
    });
  }
  const low = [...latestById.values()];
  if (!low.length) throw new Error(`No low-stock events were recorded from ${period.start.toLocaleDateString()} to ${period.end.toLocaleDateString()}.`);
  const saved = await storage.getItem<string>("ortho_branding", "");
  let branding: any = defaultBranding;
  if (saved) { try { branding = { ...defaultBranding, ...(typeof saved === "string" ? JSON.parse(saved) : saved) }; } catch {} }
  const title = `Low Stock Report (${period.start.toLocaleDateString()} – ${period.end.toLocaleDateString()})`;
  const html = buildInventoryHtml(branding, low, true, title);
  const file = await Print.printToFileAsync({ html, base64: false });
  return { uri: file.uri, count: low.length, periodStart: iso(period.start), periodEnd: iso(period.end), periodKey: period.key };
}

async function readPdfBase64(uri: string): Promise<string> {
  return FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
}
async function sendEmail(pdf: PdfResult, config: LowStockReportConfig) {
  if (!config.resendApiKey?.trim() || !config.senderEmail?.trim() || !config.emails?.trim()) {
    throw new Error("Email sending is enabled but sender email, recipient email, or Resend API key is missing.");
  }
  const content = await readPdfBase64(pdf.uri);
  const recipients = config.emails.split(/[;,\n]/).map(x => x.trim()).filter(Boolean);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.resendApiKey.trim()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: config.senderEmail.trim(), to: recipients,
      subject: `Low Stock Report — ${pdf.periodStart.slice(0,10)} to ${pdf.periodEnd.slice(0,10)}`,
      text: `Attached is the low-stock report for the selected reporting period. It contains ${pdf.count} item(s) with low-stock events during this period.`,
      attachments: [{ filename: `low-stock-${pdf.periodStart.slice(0,10)}-to-${pdf.periodEnd.slice(0,10)}.pdf`, content }],
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String((body as any)?.message || (body as any)?.name || `Email provider returned HTTP ${response.status}`));
}
async function sendWhatsApp(pdf: PdfResult, config: LowStockReportConfig) {
  if (!config.whatsappToken?.trim() || !config.whatsappPhoneNumberId?.trim() || !config.whatsappNumbers?.trim()) {
    throw new Error("WhatsApp sending is enabled but recipient number, access token, or phone-number ID is missing.");
  }
  const version = (config.whatsappGraphVersion || "v23.0").trim();
  const base = `https://graph.facebook.com/${version}/${config.whatsappPhoneNumberId.trim()}`;
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", "application/pdf");
  form.append("file", { uri: pdf.uri, name: "low-stock-report.pdf", type: "application/pdf" } as any);
  const upload = await fetch(`${base}/media`, { method: "POST", headers: { Authorization: `Bearer ${config.whatsappToken.trim()}` }, body: form });
  const media = await upload.json().catch(() => ({}));
  if (!upload.ok || !(media as any).id) throw new Error(String((media as any)?.error?.message || `WhatsApp PDF upload failed (HTTP ${upload.status})`));
  const recipients = config.whatsappNumbers.split(/[;,\n]/).map(x => x.replace(/[^0-9]/g, "")).filter(Boolean);
  for (const to of recipients) {
    const response = await fetch(`${base}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.whatsappToken.trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "document", document: { id: (media as any).id, filename: "low-stock-report.pdf", caption: `Low-stock report ${pdf.periodStart.slice(0,10)} to ${pdf.periodEnd.slice(0,10)}` } }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String((body as any)?.error?.message || `WhatsApp send failed (HTTP ${response.status})`));
  }
}

export async function shareLowStockPdfViaWhatsApp(): Promise<void> {
  const config = (await loadLowStockReportConfig()) || {
    schedule: "weekly" as const, emails: "", resendApiKey: "", senderEmail: "",
    whatsappNumbers: "", whatsappToken: "", whatsappPhoneNumberId: "", whatsappGraphVersion: "v23.0", savedAt: "",
  };
  const pdf = await makePdf(config.schedule);
  const available = await Sharing.isAvailableAsync();
  if (!available) throw new Error("File sharing is not available on this device.");
  await Sharing.shareAsync(pdf.uri, { mimeType: "application/pdf", dialogTitle: "Share low-stock PDF", UTI: "com.adobe.pdf" });
  const state = await getLowStockReportState();
  await saveState({ ...state, lastGeneratedAt: new Date().toISOString(), lastStatus: `Generated ${pdf.count} low-stock item(s) for ${pdf.periodStart.slice(0,10)} to ${pdf.periodEnd.slice(0,10)}. Choose an app to share manually.` });
}

function dueNow(config: LowStockReportConfig, state: ReportState, now = new Date()) {
  if (!config.autoEmailEnabled) return false;
  if (config.schedule === "fixedDate") {
    const date = String(config.fixedDate || "").trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(date) && now.toISOString().slice(0,10) >= date && state.lastPeriodKey !== `fixedDate:${date}`;
  }
  if (config.schedule === "onOpen") return !state.lastSentAt || new Date(state.lastSentAt).toDateString() !== now.toDateString();
  if (!state.lastSentAt) return true;
  const elapsed = now.getTime() - new Date(state.lastSentAt).getTime();
  const interval = config.schedule === "weekly" ? 7 : config.schedule === "15days" ? 15 : 30;
  return elapsed >= interval * 24 * 60 * 60 * 1000;
}

export async function attemptDueLowStockReport(): Promise<string> {
  const config = await loadLowStockReportConfig();
  if (!config) return "Automatic low-stock reporting is not configured.";
  const state = await getLowStockReportState();
  if (!dueNow(config, state)) return "Automatic report is not due yet.";
  const channels = [
    config.emails?.trim() ? "email" : "",
    config.whatsappMode === "meta" && config.whatsappNumbers?.trim() ? "WhatsApp" : "",
  ].filter(Boolean);
  if (!channels.length) return "Automatic report is enabled, but no delivery channel and recipient are configured.";
  const pdf = await makePdf(config.schedule);
  if (state.lastPeriodKey === pdf.periodKey) return "This reporting period has already been sent.";
  if (channels.includes("email")) await sendEmail(pdf, config);
  if (channels.includes("WhatsApp")) await sendWhatsApp(pdf, config);
  const nextState = {
    ...state, lastGeneratedAt: new Date().toISOString(), lastSentAt: new Date().toISOString(),
    lastPeriodKey: config.schedule === "fixedDate" ? `fixedDate:${String(config.fixedDate || "")}` : pdf.periodKey,
    lastStatus: `Automatically sent ${pdf.count} low-stock item(s) for ${pdf.periodStart.slice(0,10)} to ${pdf.periodEnd.slice(0,10)} via ${channels.join(" and ")}.`,
  };
  await saveState(nextState);
  return nextState.lastStatus!;
}
