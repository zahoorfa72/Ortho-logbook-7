import * as SecureStore from "expo-secure-store";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { api } from "@/src/api/client";
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
type ReportState = { lastGeneratedAt?: string; lastStatus?: string };
const CONFIG_KEY = "ortho_low_stock_report_config";
const STATE_KEY = "ortho_low_stock_report_state";
export async function loadLowStockReportConfig(): Promise<LowStockReportConfig | null> {
  try { const raw = await SecureStore.getItemAsync(CONFIG_KEY); return raw ? JSON.parse(raw) as LowStockReportConfig : null; } catch { return null; }
}
export async function saveLowStockReportConfig(config: LowStockReportConfig): Promise<void> {
  const localOnly = { ...config, autoEmailEnabled: false, resendApiKey: "", senderEmail: "", whatsappToken: "", whatsappPhoneNumberId: "", whatsappNumbers: "", whatsappMode: "manual" as const };
  await SecureStore.setItemAsync(CONFIG_KEY, JSON.stringify(localOnly));
}
export async function getLowStockReportState(): Promise<ReportState> {
  try { return JSON.parse((await SecureStore.getItemAsync(STATE_KEY)) || "{}") as ReportState; } catch { return {}; }
}
async function saveState(state: ReportState) { await SecureStore.setItemAsync(STATE_KEY, JSON.stringify(state)); }
async function makePdf(): Promise<{ uri: string; count: number }> {
  // The app's API client reads from its local SQLite database; this does not call an online server.
  const inventory = await api.get<any[]>("/inventory");
  const low = (Array.isArray(inventory) ? inventory : []).filter(i => Number(i.quantity) <= Number(i.minimumStock));
  if (!low.length) throw new Error("No low-stock items were found.");
  const saved = await storage.getItem<string>("ortho_branding", "");
  let branding: any = defaultBranding;
  if (saved) { try { branding = { ...defaultBranding, ...(typeof saved === "string" ? JSON.parse(saved) : saved) }; } catch {} }
  const html = buildInventoryHtml(branding, low, true, "Low Stock Report");
  const file = await Print.printToFileAsync({ html, base64: false });
  return { uri: file.uri, count: low.length };
}
export async function shareLowStockPdfViaWhatsApp(): Promise<void> {
  const pdf = await makePdf();
  const available = await Sharing.isAvailableAsync();
  if (!available) throw new Error("File sharing is not available on this device.");
  await Sharing.shareAsync(pdf.uri, { mimeType: "application/pdf", dialogTitle: "Share low-stock PDF", UTI: "com.adobe.pdf" });
  const state = await getLowStockReportState();
  await saveState({ ...state, lastGeneratedAt: new Date().toISOString(), lastStatus: "Low-stock PDF generated locally. Choose a sharing app if you want to send it." });
}
export async function attemptDueLowStockReport(): Promise<string> {
  return "Offline mode: no email or WhatsApp API is used. Generate the report and share it manually when you choose.";
}
