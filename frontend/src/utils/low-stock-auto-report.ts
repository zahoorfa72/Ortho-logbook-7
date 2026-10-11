import * as SecureStore from "expo-secure-store";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import * as FileSystem from "expo-file-system/legacy";
import { api } from "@/src/api/client";
import { db } from "@/src/db/database";
import { defaultBranding } from "@/src/theme";
import { storage } from "@/src/utils/storage";
import { buildInventoryHtml } from "@/src/utils/pdf";
import { getGoogleGmailAccessToken } from "@/src/utils/storage/google-drive";

export type LowStockSchedule = "weekly" | "15days" | "monthly" | "onOpen" | "fixedDate";
export type LowStockReportConfig = {
  schedule: LowStockSchedule;
  fixedDate?: string;
  reportFromDate?: string;
  reportToDate?: string;
  autoEmailEnabled?: boolean;
  emailEnabled?: boolean;
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
  instantLowStockGmailEnabled?: boolean;
  instantLowStockWhatsAppEnabled?: boolean;
  lowStockWhatsAppTemplateName?: string;
  lowStockWhatsAppTemplateLanguage?: string;
  savedAt: string;
};
type ReportState = { lastGeneratedAt?: string; lastSentAt?: string; lastPeriodKey?: string; lastStatus?: string; activeLowStockIds?: string[]; activeLowStockGmailIds?: string[]; activeLowStockWhatsAppIds?: string[]; lastImmediateAlertAt?: string };
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

function getPeriod(schedule: LowStockSchedule, now = new Date(), fromDate?: string, toDate?: string) {
  if (schedule === "fixedDate") {
    const from = String(fromDate || "").trim();
    const to = String(toDate || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw new Error("For a fixed-date report, enter both From date and To date as YYYY-MM-DD.");
    }
    const start = new Date(from + "T00:00:00");
    const end = new Date(to + "T23:59:59.999");
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) {
      throw new Error("Report From date must be on or before the To date.");
    }
    return { start, end, key: "fixedDate:" + from + ":" + to };
  }
  const end = new Date(now);
  const start = new Date(now);
  if (schedule === "weekly") start.setDate(start.getDate() - 7);
  else if (schedule === "15days") start.setDate(start.getDate() - 15);
  else if (schedule === "monthly") start.setDate(start.getDate() - 30);
  else start.setDate(start.getDate() - 7);
  return { start, end, key: schedule + ":" + start.toISOString().slice(0,10) + ":" + end.toISOString().slice(0,10) };
}
function iso(v: Date) { return v.toISOString(); }

async function makePdf(schedule: LowStockSchedule = "weekly", fromDate?: string, toDate?: string): Promise<PdfResult> {
  const now = new Date();
  const period = getPeriod(schedule, now, fromDate, toDate);
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
  if (!config.emails?.trim()) throw new Error("Connect Gmail and enter at least one recipient email address.");
  const token = await getGoogleGmailAccessToken();
  const content = await readPdfBase64(pdf.uri);
  const recipients = config.emails.split(/[;,\n]/).map(x => x.trim()).filter(Boolean);
  if (!recipients.length) throw new Error("Enter at least one recipient email address.");
  const invalid = recipients.filter(address => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address));
  if (invalid.length) throw new Error("Invalid recipient email address(es): " + invalid.join(", ") + ". Use plain email addresses separated by commas or semicolons.");
  const boundary = "ortho_logbook_" + Date.now().toString(36);
  const subject = `Low Stock Report - ${pdf.periodStart.slice(0,10)} to ${pdf.periodEnd.slice(0,10)}`;
  const pdfLines = content.match(/.{1,76}/g)?.join("\r\n") || content;
  const rawMessage = [
    `To: ${recipients.join(", ")}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    `Attached is the low-stock report for ${pdf.periodStart.slice(0,10)} to ${pdf.periodEnd.slice(0,10)}. It contains ${pdf.count} low-stock item(s).`,
    `--${boundary}`,
    'Content-Type: application/pdf; name="low-stock-report.pdf"',
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="low-stock-report.pdf"',
    "",
    pdfLines,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  let encoded: string;
  try { encoded = btoa(rawMessage).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
  catch { throw new Error("Could not encode the Gmail message on this device."); }
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: encoded }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String((body as any)?.error?.message || `Gmail send failed (HTTP ${response.status})`));
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
  const recipients = [...new Set(config.whatsappNumbers.split(/[;,\n]/).map(x => x.trim().replace(/^\+/, "").replace(/[\s().-]/g, "")).filter(Boolean))];
  if (!recipients.length || recipients.some(x => !/^\d{8,15}$/.test(x))) throw new Error("Enter WhatsApp recipient numbers with country code, digits only (for example 923001234567).");
  for (const to of recipients) {
    const templateName = String(config.whatsappTemplateName || "").trim();
    const message = templateName
      ? { messaging_product: "whatsapp", to, type: "template", template: { name: templateName, language: { code: String(config.whatsappTemplateLanguage || "en_US").trim() }, components: [{ type: "header", parameters: [{ type: "document", document: { id: (media as any).id, filename: "low-stock-report.pdf" } }] }] } }
      : { messaging_product: "whatsapp", to, type: "document", document: { id: (media as any).id, filename: "low-stock-report.pdf", caption: "Low-stock report " + pdf.periodStart.slice(0,10) + " to " + pdf.periodEnd.slice(0,10) } };
    const response = await fetch(base + "/messages", {
      method: "POST",
      headers: { Authorization: "Bearer " + config.whatsappToken.trim(), "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String((body as any)?.error?.message || `WhatsApp send failed (HTTP ${response.status})`));
  }
}


async function sendLowStockAlertEmail(subject: string, message: string, config: LowStockReportConfig) {
  const recipients = config.emails.split(/[;,\n]/).map(x => x.trim()).filter(Boolean);
  if (!recipients.length) throw new Error("Add a recipient email for immediate low-stock alerts.");
  const invalid = recipients.filter(address => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address));
  if (invalid.length) throw new Error("Invalid low-stock alert email recipient(s): " + invalid.join(", "));
  const token = await getGoogleGmailAccessToken();
  const raw = "To: " + recipients.join(", ") + "\r\nSubject: " + subject +
    "\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" +
    btoa(unescape(encodeURIComponent(message)));
  const encoded = btoa(unescape(encodeURIComponent(raw))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: encoded }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String((body as any)?.error?.message || "Gmail low-stock alert failed (HTTP " + response.status + ")"));
}

async function sendLowStockAlertWhatsApp(message: string, config: LowStockReportConfig) {
  if (!config.whatsappToken?.trim() || !config.whatsappPhoneNumberId?.trim()) {
    throw new Error("Enter the WhatsApp Cloud API token and phone-number ID for immediate alerts.");
  }
  const recipients = [...new Set(config.whatsappNumbers.split(/[;,\n]/).map(x => x.trim().replace(/^\+/, "").replace(/[\s().-]/g, "")).filter(Boolean))];
  if (!recipients.length || recipients.some(x => !/^\d{8,15}$/.test(x))) {
    throw new Error("Enter WhatsApp alert recipient numbers with country code, for example 923001234567.");
  }
  const version = (config.whatsappGraphVersion || "v23.0").trim();
  const base = "https://graph.facebook.com/" + version + "/" + config.whatsappPhoneNumberId.trim();
  for (const to of recipients) {
    const templateName = String(config.lowStockWhatsAppTemplateName || "").trim();
    const body = templateName
      ? { messaging_product: "whatsapp", to, type: "template", template: { name: templateName, language: { code: String(config.lowStockWhatsAppTemplateLanguage || "en_US").trim() }, components: [{ type: "body", parameters: [{ type: "text", text: message.slice(0, 1024) }] }] } }
      : { messaging_product: "whatsapp", to, type: "text", text: { preview_url: false, body: message.slice(0, 4096) } };
    const response = await fetch(base + "/messages", {
      method: "POST", headers: { Authorization: "Bearer " + config.whatsappToken.trim(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String((result as any)?.error?.message || "WhatsApp low-stock alert failed (HTTP " + response.status + ")"));
  }
}

/**
 * Call after any inventory-changing action and when the app opens.
 * Sends a plain-text alert only for items newly at/below their configured minimum,
 * then remembers the active low-stock set to avoid repeated messages for the same low-stock condition.
 */
export async function checkAndSendImmediateLowStockAlerts(): Promise<string> {
  const config = await loadLowStockReportConfig();
  if (!config) return "Immediate low-stock alerts are not configured.";
  const gmailOn = !!config.instantLowStockGmailEnabled;
  const whatsappOn = !!config.instantLowStockWhatsAppEnabled;
  if (!gmailOn && !whatsappOn) return "Immediate low-stock alerts are disabled.";
  const inventory = await api.get<any[]>("/inventory");
  const low = (Array.isArray(inventory) ? inventory : []).filter((item: any) => {
    const qty = Number(item?.quantity);
    const min = Number(item?.minimumStock ?? item?.minimum_stock);
    return !!item?.id && Number.isFinite(qty) && Number.isFinite(min) && qty <= min;
  });
  const state = await getLowStockReportState();
  const currentIds = low.map((item: any) => String(item.id));
  const gmailActive = new Set((state.activeLowStockGmailIds || []).map(String));
  const whatsappActive = new Set((state.activeLowStockWhatsAppIds || []).map(String));
  const gmailNew = gmailOn ? low.filter((item: any) => !gmailActive.has(String(item.id))) : [];
  const whatsappNew = whatsappOn ? low.filter((item: any) => !whatsappActive.has(String(item.id))) : [];
  const formatMessage = (items: any[]) => "ORTHO LOGBOOK — LOW STOCK ALERT\n" + items.length +
    " implant/item(s) just reached or fell below minimum stock:\n" +
    items.map((item: any) => {
      const name = String(item.name || item.category || "Implant");
      const category = String(item.category || "");
      const size = String(item.size || "");
      const qty = Number(item.quantity);
      const min = Number(item.minimumStock ?? item.minimum_stock);
      return "- " + name + (category && category.toLowerCase() !== name.toLowerCase() ? " (" + category + ")" : "") +
        (size ? ", size " + size : "") + ": remaining " + qty + " " + String(item.unit || "pcs") + ", minimum " + min;
    }).join("\n") + "\n\nPlease arrange replenishment. Alert time: " + new Date().toLocaleString();
  const results: string[] = [];
  let gmailActiveIds = [...(state.activeLowStockGmailIds || [])];
  let whatsappActiveIds = [...(state.activeLowStockWhatsAppIds || [])];
  if (gmailOn) {
    if (!gmailNew.length) gmailActiveIds = currentIds;
    else {
      try {
        await sendLowStockAlertEmail("URGENT: Implant low-stock alert (" + gmailNew.length + " item(s))", formatMessage(gmailNew), config);
        gmailActiveIds = currentIds;
        results.push("Gmail text alert sent");
      } catch (e: any) { results.push("Gmail FAILED: " + String(e?.message || e)); }
    }
  }
  if (whatsappOn) {
    if (!whatsappNew.length) whatsappActiveIds = currentIds;
    else {
      try {
        await sendLowStockAlertWhatsApp(formatMessage(whatsappNew), config);
        whatsappActiveIds = currentIds;
        results.push("WhatsApp text alert sent");
      } catch (e: any) { results.push("WhatsApp FAILED: " + String(e?.message || e)); }
    }
  }
  await saveState({
    ...state,
    ...(gmailOn ? { activeLowStockGmailIds: gmailActiveIds } : {}),
    ...(whatsappOn ? { activeLowStockWhatsAppIds: whatsappActiveIds } : {}),
    activeLowStockIds: currentIds,
    ...(results.length ? { lastImmediateAlertAt: new Date().toISOString() } : {}),
    ...(results.length ? { lastStatus: "Immediate low-stock text alert: " + results.join("; ") } : {}),
  });
  return results.length ? results.join("; ") : "No newly low-stock items.";
}


export async function testImmediateLowStockAlertDeliveryNow(): Promise<string> {
  const config = await loadLowStockReportConfig();
  if (!config) throw new Error("Save the low-stock report settings first.");
  const gmailOn = !!config.instantLowStockGmailEnabled;
  const whatsappOn = !!config.instantLowStockWhatsAppEnabled;
  if (!gmailOn && !whatsappOn) throw new Error("Turn on immediate Gmail and/or WhatsApp text alerts first.");
  const message = "ORTHO LOGBOOK — LOW STOCK ALERT TEST\nThis is a test text message. When an implant reaches or falls below its configured minimum stock, its name, size, remaining quantity, and minimum quantity will be sent here.\nTest time: " + new Date().toLocaleString();
  const results: string[] = [];
  if (gmailOn) {
    try { await sendLowStockAlertEmail("Ortho Logbook — Low-stock alert test", message, config); results.push("Gmail: sent successfully"); }
    catch (e: any) { results.push("Gmail: FAILED — " + String(e?.message || e)); }
  }
  if (whatsappOn) {
    try { await sendLowStockAlertWhatsApp(message, config); results.push("WhatsApp: API accepted successfully"); }
    catch (e: any) { results.push("WhatsApp: FAILED — " + String(e?.message || e)); }
  }
  const result = results.join("; ");
  const state = await getLowStockReportState();
  await saveState({ ...state, lastStatus: "Immediate alert test: " + result });
  if (results.some(x => x.includes("FAILED"))) throw new Error(result);
  return result;
}

export async function shareLowStockPdfViaWhatsApp(): Promise<void> {
  const config = (await loadLowStockReportConfig()) || {
    schedule: "weekly" as const, emails: "", resendApiKey: "", senderEmail: "",
    whatsappNumbers: "", whatsappToken: "", whatsappPhoneNumberId: "", whatsappGraphVersion: "v23.0", savedAt: "",
  };
  const pdf = await makePdf(config.schedule, config.reportFromDate, config.reportToDate);
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
    const today = String(now.getFullYear()) + "-" + String(now.getMonth()+1).padStart(2,"0") + "-" + String(now.getDate()).padStart(2,"0");
    const from = String(config.reportFromDate || "").trim(); const to = String(config.reportToDate || "").trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to && today >= date && state.lastPeriodKey !== ("fixedDate:" + date + ":" + from + ":" + to);
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
    config.emailEnabled && config.emails?.trim() ? "email" : "",
    config.whatsappMode === "meta" && config.whatsappNumbers?.trim() ? "WhatsApp" : "",
  ].filter(Boolean);
  if (!channels.length) return "Automatic report is enabled, but no delivery channel and recipient are configured.";
  const pdf = await makePdf(config.schedule, config.reportFromDate, config.reportToDate);
  if (state.lastPeriodKey === pdf.periodKey) return "This reporting period has already been sent.";
  if (channels.includes("email")) await sendEmail(pdf, config);
  if (channels.includes("WhatsApp")) await sendWhatsApp(pdf, config);
  const nextState = {
    ...state, lastGeneratedAt: new Date().toISOString(), lastSentAt: new Date().toISOString(),
    lastPeriodKey: config.schedule === "fixedDate" ? "fixedDate:" + String(config.fixedDate || "") + ":" + String(config.reportFromDate || "") + ":" + String(config.reportToDate || "") : pdf.periodKey,
    lastStatus: `Automatically sent ${pdf.count} low-stock item(s) for ${pdf.periodStart.slice(0,10)} to ${pdf.periodEnd.slice(0,10)} via ${channels.join(" and ")}.`,
  };
  await saveState(nextState);
  return nextState.lastStatus!;
}


/** Force a real delivery attempt now, without waiting for the configured schedule. */
export async function testLowStockReportDeliveryNow(): Promise<string> {
  const config = await loadLowStockReportConfig();
  if (!config) throw new Error("Save the low-stock report settings first.");
  const emailEnabled = !!config.emailEnabled;
  const whatsappEnabled = config.whatsappMode === "meta";
  if (!emailEnabled && !whatsappEnabled) throw new Error("Enable Gmail and/or WhatsApp Cloud API automatic sending before testing.");
  const pdf = await makePdf(config.schedule, config.reportFromDate, config.reportToDate);
  const outcomes: string[] = [];
  if (emailEnabled) {
    try { await sendEmail(pdf, config); outcomes.push("Gmail: sent successfully"); }
    catch (e: any) { outcomes.push("Gmail: FAILED — " + String(e?.message || e)); }
  }
  if (whatsappEnabled) {
    try { await sendWhatsApp(pdf, config); outcomes.push("WhatsApp Cloud API: accepted successfully"); }
    catch (e: any) { outcomes.push("WhatsApp Cloud API: FAILED — " + String(e?.message || e)); }
  }
  const state = await getLowStockReportState();
  const result = "Manual delivery test (" + pdf.count + " low-stock item(s), " + pdf.periodStart.slice(0,10) + " to " + pdf.periodEnd.slice(0,10) + "): " + outcomes.join("; ");
  await saveState({ ...state, lastGeneratedAt: new Date().toISOString(), lastStatus: result });
  if (outcomes.some(x => x.includes("FAILED"))) throw new Error(result);
  return result;
}
