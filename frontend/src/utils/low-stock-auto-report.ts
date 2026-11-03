import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";
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
  instantLowStockAlertsEnabled?: boolean;
  instantLowStockGmailEnabled?: boolean;
  instantLowStockWhatsAppEnabled?: boolean;
  lowStockWhatsAppTemplateName?: string;
  lowStockWhatsAppTemplateLanguage?: string;
  savedAt: string;
};
type LowStockAlertItemSnapshot = {
  id: string;
  name: string;
  category: string;
  size: string;
  quantity: number;
  minimumStock: number;
  unit: string;
};
type PendingImmediateAlert = {
  id: string;
  channel: "gmail" | "whatsapp";
  kind: "minimum" | "zero";
  detectedAt: string;
  items: LowStockAlertItemSnapshot[];
  attempts: number;
  nextAttemptAt?: string;
  lastError?: string;
};
type DeliveredImmediateAlert = {
  id: string;
  channel: "gmail" | "whatsapp";
  kind: "minimum" | "zero";
  detectedAt: string;
  sentAt: string;
  itemNames: string[];
  itemIds: string[];
};
type ReportState = {
  lastGeneratedAt?: string;
  lastSentAt?: string;
  lastPeriodKey?: string;
  lastStatus?: string;
  activeLowStockIds?: string[];
  activeLowStockGmailIds?: string[];
  activeLowStockWhatsAppIds?: string[];
  lastImmediateAlertAt?: string;
  pendingImmediateAlerts?: PendingImmediateAlert[];
  deliveredImmediateAlertHistory?: DeliveredImmediateAlert[];
};
type PdfResult = { uri: string; count: number; periodStart: string; periodEnd: string; periodKey: string };
const CONFIG_KEY = "ortho_low_stock_report_config";
const STATE_KEY = "ortho_low_stock_report_state";
let immediateAlertCheckInFlight = false;

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
  try {
    const current = await AsyncStorage.getItem(STATE_KEY);
    if (current) return JSON.parse(current) as ReportState;
    // Migrate existing state (baseline and timestamps) from the previous
    // SecureStore implementation without removing the old value.
    const legacy = await SecureStore.getItemAsync(STATE_KEY);
    if (legacy) {
      await AsyncStorage.setItem(STATE_KEY, legacy);
      return JSON.parse(legacy) as ReportState;
    }
  } catch {
    try {
      const legacy = await SecureStore.getItemAsync(STATE_KEY);
      if (legacy) return JSON.parse(legacy) as ReportState;
    } catch {}
  }
  return {};
}
async function saveState(state: ReportState) {
  // Queue/history may grow while offline; AsyncStorage handles larger local
  // JSON state better than the small-value secure credential store.
  await AsyncStorage.setItem(STATE_KEY, JSON.stringify(state));
}

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
  const parseMovementDate = (raw: unknown): Date | null => {
    const value = String(raw ?? "").trim();
    if (!value) return null;
    if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) {
      const zoned = new Date(value);
      if (Number.isFinite(zoned.getTime())) return zoned;
    }
    const isoMatch = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/.exec(value);
    if (isoMatch) {
      const year = Number(isoMatch[1]), month = Number(isoMatch[2]), day = Number(isoMatch[3]);
      const date = new Date(year, month - 1, day, Number(isoMatch[4] || 0), Number(isoMatch[5] || 0), Number(isoMatch[6] || 0), Number(String(isoMatch[7] || "0").padEnd(3, "0")));
      if (date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day) return date;
    }
    const named = /^(\d{1,2})[-/. ]([A-Za-z0-9|!]{3,9})[-/. ](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(value);
    if (named) {
      const months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
      const token = named[2].toLowerCase().replace(/[|!]/g, "t").replace(/^0(?=ct)/, "o").replace(/[^a-z]/g, "");
      const month = months.indexOf(token.slice(0, 3));
      let year = Number(named[3]);
      if (named[3].length === 2) year += year >= 50 ? 1900 : 2000;
      const day = Number(named[1]);
      if (month >= 0 && year >= 1900 && year <= 2200) {
        const date = new Date(year, month, day, Number(named[4] || 0), Number(named[5] || 0), Number(named[6] || 0));
        if (date.getFullYear() === year && date.getMonth() === month && date.getDate() === day) return date;
      }
    }
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  };

  // Include only movements that newly cross the minimum threshold or reach zero.
  const movementRows = db.getAllSync<any>(
    "SELECT m.inventory_id, m.type, m.amount, m.quantity_after, m.created_at, i.name, i.minimum_stock, i.unit, i.category, i.category_id, i.size, i.low_stock_since FROM inventory_movements m INNER JOIN inventory i ON i.id=m.inventory_id",
  );
  const parsedMovements = movementRows
    .map((row: any) => ({ row, date: parseMovementDate(row.created_at) }))
    .filter((entry: any) => !!entry.date)
    .sort((a: any, b: any) => a.date.getTime() - b.date.getTime());
  const byInventory = new Map<string, any[]>();
  for (const entry of parsedMovements) {
    const id = String(entry.row.inventory_id || "");
    if (!id) continue;
    const list = byInventory.get(id) || [];
    list.push(entry);
    byInventory.set(id, list);
  }
  const latestById = new Map<string, any>();
  for (const [id, entries] of byInventory) {
    let previousQuantity: number | null = null;
    for (const entry of entries) {
      const row = entry.row;
      const quantity = Number(row.quantity_after);
      const minimum = Number(row.minimum_stock);
      if (!Number.isFinite(quantity) || !Number.isFinite(minimum)) {
        previousQuantity = Number.isFinite(quantity) ? quantity : previousQuantity;
        continue;
      }
      const crossedMinimum = quantity <= minimum && (previousQuantity === null || previousQuantity > minimum);
      const newlyZero = quantity <= 0 && (previousQuantity === null || previousQuantity > 0);
      const inPeriod = entry.date.getTime() >= period.start.getTime() && entry.date.getTime() <= period.end.getTime();
      if (inPeriod && (crossedMinimum || newlyZero)) {
        const base = all.find((item: any) => String(item.id) === id) || {};
        latestById.set(id, {
          ...base, id,
          name: String(row.name || base.name || "Inventory item"),
          quantity, minimumStock: minimum, minimum_stock: minimum,
          unit: row.unit || base.unit, category: row.category || base.category,
          category_id: row.category_id || base.category_id, size: row.size || base.size,
          lowStockEventAt: row.created_at,
          lowStockEventType: newlyZero ? "OUT OF STOCK" : "LOW STOCK",
        });
      }
      previousQuantity = quantity;
    }
  }
  // Legacy installations may have low_stock_since but no movement history.
  // Include them only when the saved low-stock date falls inside the window.
  for (const item of all) {
    const id = String(item?.id || "");
    if (!id || latestById.has(id)) continue;
    const quantity = Number(item.quantity);
    const minimum = Number(item.minimumStock ?? item.minimum_stock);
    const since = parseMovementDate(item.lowStockSince ?? item.low_stock_since);
    if (Number.isFinite(quantity) && Number.isFinite(minimum) && quantity <= minimum &&
        since && since.getTime() >= period.start.getTime() && since.getTime() <= period.end.getTime()) {
      latestById.set(id, {
        ...item, id, quantity, minimumStock: minimum, minimum_stock: minimum,
        lowStockEventAt: item.lowStockSince ?? item.low_stock_since,
        lowStockEventType: quantity <= 0 ? "OUT OF STOCK" : "LOW STOCK",
      });
    }
  }
  const low = [...latestById.values()];
  if (!low.length) throw new Error(`No new low-stock events were recorded from ${period.start.toLocaleDateString()} to ${period.end.toLocaleDateString()}.`);
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


async function sendLowStockAlertEmail(subject: string, message: string, config: LowStockReportConfig, htmlMessage?: string) {
  const recipients = config.emails.split(/[;,\n]/).map(x => x.trim()).filter(Boolean);
  if (!recipients.length) throw new Error("Add a recipient email for immediate low-stock alerts.");
  const invalid = recipients.filter(address => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address));
  if (invalid.length) throw new Error("Invalid low-stock alert email recipient(s): " + invalid.join(", "));
  const token = await getGoogleGmailAccessToken();
  // Keep the subject ASCII-only to prevent Gmail showing mojibake such as Ã¢Â€Â”.
  const safeSubject = subject.replace(/[–—]/g, "-").replace(/[^\x20-\x7E]/g, "");
  const body = htmlMessage || message;
  const contentType = htmlMessage ? "text/html" : "text/plain";
  const raw = "To: " + recipients.join(", ") + "\r\nSubject: " + safeSubject +
    "\r\nMIME-Version: 1.0\r\nContent-Type: " + contentType + "; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" +
    btoa(unescape(encodeURIComponent(body)));
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
  if (immediateAlertCheckInFlight) return "Immediate low-stock alert check is already running.";
  immediateAlertCheckInFlight = true;
  try {
    const config = await loadLowStockReportConfig();
    if (!config) return "Immediate low-stock alerts are not configured.";
    const masterOn = config.instantLowStockAlertsEnabled !== false;
    const gmailOn = masterOn && !!config.instantLowStockGmailEnabled;
    const whatsappOn = masterOn && !!config.instantLowStockWhatsAppEnabled;
    if (!gmailOn && !whatsappOn) return "Immediate low-stock alerts are disabled.";

    // The API is backed by the local SQLite database, so this event check also
    // runs with no internet connection. Delivery is queued locally until online.
    const inventory = await api.get<any[]>("/inventory");
    const low = (Array.isArray(inventory) ? inventory : []).filter((item: any) => {
      const quantity = Number(item?.quantity);
      const minimum = Number(item?.minimumStock ?? item?.minimum_stock);
      return !!item?.id && Number.isFinite(quantity) && Number.isFinite(minimum) && quantity <= minimum;
    });
    const state = await getLowStockReportState();
    const thresholdKeys = (item: any): string[] => {
      const itemId = String(item?.id || "");
      const quantity = Number(item?.quantity);
      const minimum = Number(item?.minimumStock ?? item?.minimum_stock);
      if (!itemId || !Number.isFinite(quantity) || !Number.isFinite(minimum) || quantity > minimum) return [];
      const keys = [itemId + ":minimum"];
      if (quantity <= 0) keys.push(itemId + ":zero");
      return keys;
    };
    const currentKeys = [...new Set(low.flatMap(thresholdKeys))];
    const normalizeSavedKeys = (values: string[] | undefined) => (values || []).flatMap(value =>
      String(value).endsWith(":minimum") || String(value).endsWith(":zero")
        ? [String(value)]
        : [String(value) + ":minimum"]
    );
    const gmailActive = new Set(normalizeSavedKeys(state.activeLowStockGmailIds));
    const whatsappActive = new Set(normalizeSavedKeys(state.activeLowStockWhatsAppIds));
    const hasGmailBaseline = Array.isArray(state.activeLowStockGmailIds);
    const hasWhatsAppBaseline = Array.isArray(state.activeLowStockWhatsAppIds);

    const gmailNew = gmailOn && hasGmailBaseline
      ? low.filter((item: any) => Number(item.quantity) > 0 && !gmailActive.has(String(item.id) + ":minimum"))
      : [];
    const whatsappNew = whatsappOn && hasWhatsAppBaseline
      ? low.filter((item: any) => Number(item.quantity) > 0 && !whatsappActive.has(String(item.id) + ":minimum"))
      : [];
    const gmailZeroNew = gmailOn && hasGmailBaseline
      ? low.filter((item: any) => Number(item.quantity) <= 0 && !gmailActive.has(String(item.id) + ":zero"))
      : [];
    const whatsappZeroNew = whatsappOn && hasWhatsAppBaseline
      ? low.filter((item: any) => Number(item.quantity) <= 0 && !whatsappActive.has(String(item.id) + ":zero"))
      : [];

    const detectedAt = new Date().toISOString();
    const snapshotItems = (items: any[]): LowStockAlertItemSnapshot[] => items.map((item: any) => ({
      id: String(item.id),
      name: String(item.name || item.category || "Inventory item"),
      category: String(item.category || ""),
      size: String(item.size || ""),
      quantity: Number(item.quantity),
      minimumStock: Number(item.minimumStock ?? item.minimum_stock),
      unit: String(item.unit || "pcs"),
    }));
    const pending: PendingImmediateAlert[] = Array.isArray(state.pendingImmediateAlerts)
      ? [...state.pendingImmediateAlerts]
      : [];
    const queue = (channel: "gmail" | "whatsapp", kind: "minimum" | "zero", items: any[]) => {
      if (!items.length) return;
      pending.push({
        id: channel + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9),
        channel,
        kind,
        detectedAt,
        items: snapshotItems(items),
        attempts: 0,
      });
    };

    if (gmailOn) {
      if (hasGmailBaseline) {
        queue("gmail", "minimum", gmailNew);
        queue("gmail", "zero", gmailZeroNew);
      }
    }
    if (whatsappOn) {
      if (hasWhatsAppBaseline) {
        queue("whatsapp", "minimum", whatsappNew);
        queue("whatsapp", "zero", whatsappZeroNew);
      }
    }

    // Commit the event snapshots and active-threshold state BEFORE attempting
    // network delivery. This prevents missed alerts if the app closes offline.
    const queuedState: ReportState = {
      ...state,
      ...(gmailOn ? { activeLowStockGmailIds: currentKeys } : {}),
      ...(whatsappOn ? { activeLowStockWhatsAppIds: currentKeys } : {}),
      activeLowStockIds: currentKeys,
      pendingImmediateAlerts: pending,
    };
    await saveState(queuedState);

    const escapeEmailHtml = (value: string) => String(value).replace(/[&<>"']/g, char => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[char] || char));
    const formatQueuedMessage = (alert: PendingImmediateAlert) => {
      const detail = alert.items.map((item, index) => [
        (index + 1) + ". " + item.name,
        ...(item.category && item.category.toLowerCase() !== item.name.toLowerCase() ? ["Category: " + item.category] : []),
        ...(item.size ? ["Size: " + item.size] : []),
        "Stock at detection: " + item.quantity + " " + item.unit,
        "Minimum stock at detection: " + item.minimumStock + " " + item.unit,
        "Status: " + (alert.kind === "zero" ? "OUT OF STOCK" : "LOW STOCK"),
      ].join("\n")).join("\n\n");
      return [
        "ORTHO LOGBOOK",
        alert.kind === "zero" ? "OUT OF STOCK ALERT" : "IMMEDIATE LOW STOCK ALERT",
        "NEWLY AFFECTED ITEMS: " + alert.items.length,
        "",
        detail,
        "",
        alert.kind === "zero"
          ? "URGENT: Replenish these items. Stock was zero when detected."
          : "ACTION REQUIRED: Arrange replenishment for the items listed above.",
        "Detected at: " + new Date(alert.detectedAt).toLocaleString(),
      ].join("\n");
    };
    const formatQueuedHtml = (alert: PendingImmediateAlert) => {
      const zero = alert.kind === "zero";
      const cards = alert.items.map((item, index) => {
        const name = escapeEmailHtml(item.name);
        const details = [
          item.category && item.category.toLowerCase() !== item.name.toLowerCase() ? "Category: " + escapeEmailHtml(item.category) : "",
          item.size ? "Size: " + escapeEmailHtml(item.size) : "",
        ].filter(Boolean).join(" &nbsp; | &nbsp; ");
        return '<div style="border:2px solid ' + (zero ? '#b91c1c' : '#d97706') + ';border-radius:12px;padding:18px;margin:14px 0;background:#fff7ed">' +
          '<div style="font-size:12px;font-weight:700;color:#7c2d12;margin-bottom:8px">LOW STOCK ITEM ' + (index + 1) + '</div>' +
          '<div style="font-size:22px;line-height:1.3;font-weight:800;color:#111827;margin-bottom:12px">' + name + '</div>' +
          (details ? '<div style="font-size:13px;color:#4b5563;margin-bottom:12px">' + details + '</div>' : '') +
          '<table role="presentation" style="width:100%;border-collapse:collapse"><tr>' +
          '<td style="background:#ffedd5;border-radius:8px;padding:12px;width:50%"><div style="font-size:11px;color:#7c2d12;font-weight:700">CURRENT STOCK</div><div style="font-size:24px;font-weight:800;color:#9a3412">' + item.quantity + ' ' + escapeEmailHtml(item.unit) + '</div></td>' +
          '<td style="width:10px"></td><td style="background:#f3f4f6;border-radius:8px;padding:12px;width:50%"><div style="font-size:11px;color:#374151;font-weight:700">MINIMUM STOCK</div><div style="font-size:24px;font-weight:800;color:#111827">' + item.minimumStock + ' ' + escapeEmailHtml(item.unit) + '</div></td>' +
          '</tr></table><div style="margin-top:12px;font-size:13px;font-weight:800;color:' + (zero ? '#b91c1c' : '#9a3412') + '">' + (zero ? 'OUT OF STOCK - URGENT' : 'BELOW OR AT MINIMUM STOCK') + '</div></div>';
      }).join("");
      return '<!doctype html><html><body style="margin:0;padding:20px;background:#f3f4f6;font-family:Arial,sans-serif;color:#111827">' +
        '<div style="max-width:620px;margin:0 auto;background:#fff;border-radius:16px;padding:22px">' +
        '<div style="font-size:13px;font-weight:800;letter-spacing:1px;color:#6b7280">ORTHO LOGBOOK</div>' +
        '<div style="font-size:24px;font-weight:800;margin:8px 0 4px;color:' + (zero ? '#b91c1c' : '#9a3412') + '">' + (zero ? 'OUT OF STOCK ALERT' : 'LOW STOCK ALERT') + '</div>' +
        '<div style="font-size:14px;color:#4b5563;margin-bottom:18px">Immediate attention required - ' + alert.items.length + ' newly affected item(s)</div>' +
        cards +
        '<div style="font-size:14px;font-weight:700;margin-top:18px">' + (zero ? 'Urgent: replenish these items immediately.' : 'Please arrange replenishment for the highlighted item(s).') + '</div>' +
        '<div style="font-size:12px;color:#6b7280;margin-top:12px">Detected at: ' + escapeEmailHtml(new Date(alert.detectedAt).toLocaleString()) + '</div>' +
        '</div></body></html>';
    };

    const results: string[] = [];
    const remaining: PendingImmediateAlert[] = [];
    const delivered: DeliveredImmediateAlert[] = [];
    const now = Date.now();
    for (const alert of pending) {
      const channelEnabled = alert.channel === "gmail" ? gmailOn : whatsappOn;
      if (!channelEnabled) {
        remaining.push(alert);
        continue;
      }
      const retryAt = alert.nextAttemptAt ? new Date(alert.nextAttemptAt).getTime() : 0;
      if (Number.isFinite(retryAt) && retryAt > now) {
        remaining.push(alert);
        continue;
      }
      try {
        const message = formatQueuedMessage(alert);
        const names = alert.items.map(item => item.name).join(", ");
        if (alert.channel === "gmail") {
          const subject = (alert.kind === "zero" ? "OUT OF STOCK ALERT - " : "LOW STOCK ALERT - ") +
            names + " - " + alert.detectedAt.slice(0, 10);
          await sendLowStockAlertEmail(subject, message, config, formatQueuedHtml(alert));
        } else {
          await sendLowStockAlertWhatsApp(message, config);
        }
        const sentAt = new Date().toISOString();
        delivered.push({
          id: alert.id,
          channel: alert.channel,
          kind: alert.kind,
          detectedAt: alert.detectedAt,
          sentAt,
          itemNames: alert.items.map(item => item.name),
          itemIds: alert.items.map(item => item.id),
        });
        results.push((alert.channel === "gmail" ? "Gmail" : "WhatsApp") +
          (alert.kind === "zero" ? " out-of-stock" : " immediate low-stock") + " alert sent successfully");
      } catch (error: any) {
        const attempts = (Number(alert.attempts) || 0) + 1;
        const retryMinutes = [1, 5, 15, 30, 60][Math.min(attempts - 1, 4)];
        const message = String(error?.message || error || "Delivery failed");
        remaining.push({
          ...alert,
          attempts,
          nextAttemptAt: new Date(Date.now() + retryMinutes * 60 * 1000).toISOString(),
          lastError: message.slice(0, 300),
        });
        results.push((alert.channel === "gmail" ? "Gmail" : "WhatsApp") +
          " FAILED (retry " + attempts + " in " + retryMinutes + " min): " + message);
      }
    }

    const history = [
      ...(Array.isArray(state.deliveredImmediateAlertHistory) ? state.deliveredImmediateAlertHistory : []),
      ...delivered,
    ].slice(-50);
    const status = results.length
      ? "Immediate low-stock alert: " + results.join("; ")
      : remaining.length
        ? remaining.length + " immediate low-stock alert(s) are queued and will retry automatically."
        : "No newly low-stock items.";
    await saveState({
      ...queuedState,
      pendingImmediateAlerts: remaining,
      deliveredImmediateAlertHistory: history,
      ...(delivered.length ? { lastImmediateAlertAt: new Date().toISOString() } : {}),
      lastStatus: status,
    });
    return status;
  } finally {
    immediateAlertCheckInFlight = false;
  }
}

/** Manually send a plain-text alert for every item currently at/below minimum stock.
 * This intentionally ignores the automatic-channel switches; manual sending remains available when automation is off.
 */
export async function sendManualLowStockTextAlertNow(): Promise<string> {
  const config = await loadLowStockReportConfig();
  if (!config) throw new Error("Save low-stock delivery settings first.");
  const inventory = await api.get<any[]>("/inventory");
  const low = (Array.isArray(inventory) ? inventory : []).filter((item: any) => {
    const qty = Number(item?.quantity);
    const min = Number(item?.minimumStock ?? item?.minimum_stock);
    return !!item?.id && Number.isFinite(qty) && Number.isFinite(min) && qty <= min;
  });
  if (!low.length) throw new Error("There are no items currently at or below minimum stock.");
  const message = "ORTHO LOGBOOK — LOW STOCK ALERT (MANUAL)\n" + low.length +
    " item(s) currently at or below minimum stock:\n" +
    low.map((item: any) => {
      const name = String(item.name || item.category || "Implant");
      const category = String(item.category || "");
      const size = String(item.size || "");
      const qty = Number(item.quantity);
      const min = Number(item.minimumStock ?? item.minimum_stock);
      return "- " + name + (category && category.toLowerCase() !== name.toLowerCase() ? " (" + category + ")" : "") +
        (size ? ", size " + size : "") + ": remaining " + qty + " " + String(item.unit || "pcs") + ", minimum " + min;
    }).join("\n") + "\n\nAlert time: " + new Date().toLocaleString();
  const outcomes: string[] = [];
  // Manual delivery is based on configured credentials, not the automatic ON/OFF switches.
  if (config.emails?.trim()) {
    try { await sendLowStockAlertEmail("Ortho Logbook — low-stock alert (manual)", message, config); outcomes.push("Gmail: sent successfully"); }
    catch (e: any) { outcomes.push("Gmail: FAILED — " + String(e?.message || e)); }
  }
  if (config.whatsappNumbers?.trim() && config.whatsappToken?.trim() && config.whatsappPhoneNumberId?.trim()) {
    try { await sendLowStockAlertWhatsApp(message, config); outcomes.push("WhatsApp: API accepted successfully"); }
    catch (e: any) { outcomes.push("WhatsApp: FAILED — " + String(e?.message || e)); }
  }
  if (!outcomes.length) throw new Error("Configure recipient email(s) and/or WhatsApp recipient number(s) with Cloud API credentials first.");
  const result = "Manual low-stock text alert (" + low.length + " item(s)): " + outcomes.join("; ");
  const state = await getLowStockReportState();
  await saveState({ ...state, lastImmediateAlertAt: new Date().toISOString(), lastStatus: result });
  if (outcomes.some(x => x.includes("FAILED"))) throw new Error(result);
  return result;
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
  const deliveredChannels: string[] = [];
  try {
    if (channels.includes("email")) {
      await sendEmail(pdf, config);
      deliveredChannels.push("Gmail");
    }
    if (channels.includes("WhatsApp")) {
      await sendWhatsApp(pdf, config);
      deliveredChannels.push("WhatsApp");
    }
  } catch (error: any) {
    // Compact failure feedback is shown by the app toast.
    throw error;
  }
  const nextState = {
    ...state, lastGeneratedAt: new Date().toISOString(), lastSentAt: new Date().toISOString(),
    lastPeriodKey: config.schedule === "fixedDate" ? "fixedDate:" + String(config.fixedDate || "") + ":" + String(config.reportFromDate || "") + ":" + String(config.reportToDate || "") : pdf.periodKey,
    lastStatus: `Automatically sent ${pdf.count} low-stock item(s) for ${pdf.periodStart.slice(0,10)} to ${pdf.periodEnd.slice(0,10)} via ${deliveredChannels.join(" and ")}.`,
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
