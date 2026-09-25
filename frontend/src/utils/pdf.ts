import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { Platform } from "react-native";

import type { BrandingConfig } from "@/src/theme";

type Patient = {
  id: string;
  mrNo: string;
  name: string;
  gender: string;
  age: string;
  diagnosis: string;
  procedure: string;
  implant: string;
  implantII: string;
  date: string;
  operationCount?: number; // Nth-time operated (1 = first, 2 = 2nd time, ...)
};

type InventoryItem = {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  minimumStock: number;
  category?: string;
  size?: string;
};

type StatsData = {
  total_patients: number;
  procedures: { name: string; count: number }[];
};

const escapeHtml = (v: any) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

function ordinalSuffix(n: number) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function header(branding: BrandingConfig, subtitle: string) {
  const leftLogo = branding.logoBase64
    ? `<img src="${branding.logoBase64}" class="logo" alt="left logo" />`
    : `<div class="logoPlaceholder">${escapeHtml(branding.title.slice(0, 2).toUpperCase())}</div>`;
  const rightLogo = branding.logoBase64Right
    ? `<img src="${branding.logoBase64Right}" class="logo" alt="right logo" />`
    : branding.logoBase64
    ? `<img src="${branding.logoBase64}" class="logo" alt="right logo" />`
    : `<div class="logoPlaceholder">${escapeHtml(branding.title.slice(0, 2).toUpperCase())}</div>`;
  const customLines = (branding.pdfSubtitle || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 4);
  const customBlock = customLines.length
    ? `<div class="pdfCustom">${customLines.map((l) => `<div>${escapeHtml(l)}</div>`).join("")}</div>`
    : "";
  const layout = branding.pdfLogoLayout || "center";
  if (layout === "left") {
    return `
      <div class="header headerLeft">
        <div class="logoSide">${leftLogo}</div>
        <div class="titleBlock titleBlockLeft">
          <div class="title">${escapeHtml(branding.title)}</div>
          ${customBlock}
          <div class="subtitle">${escapeHtml(subtitle)}</div>
          <div class="printed">Generated on ${escapeHtml(new Date().toLocaleString())}</div>
        </div>
      </div>
    `;
  }
  return `
    <div class="header">
      <div class="logoSide">${leftLogo}</div>
      <div class="titleBlock">
        <div class="title">${escapeHtml(branding.title)}</div>
        ${customBlock}
        <div class="subtitle">${escapeHtml(subtitle)}</div>
        <div class="printed">Generated on ${escapeHtml(new Date().toLocaleString())}</div>
      </div>
      <div class="logoSide">${rightLogo}</div>
    </div>
  `;
}

function styles(branding: BrandingConfig) {
  return `
    <style>
      * { box-sizing: border-box; }
      body { font-family: -apple-system, Helvetica, Arial, sans-serif; color: #1C1C1E; margin: 0; padding: 28px; }
      .header { display: flex; align-items: center; gap: 18px; border-bottom: 3px solid ${branding.primary}; padding-bottom: 16px; margin-bottom: 24px; }
      .logoSide { flex: 0 0 auto; }
      .logo { width: 78px; height: 78px; border-radius: 12px; object-fit: contain; background: ${branding.tertiary}; display: block; }
      .logoPlaceholder { width: 78px; height: 78px; border-radius: 12px; background: ${branding.primary}; color: ${branding.onPrimary}; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 26px; }
      .titleBlock { flex: 1; text-align: center; }
      .titleBlockLeft { text-align: left; padding-left: 4px; }
      .headerLeft .logoSide { flex: 0 0 auto; }
      .title { font-size: 28px; font-weight: 800; color: ${branding.primary}; margin: 0; letter-spacing: 0.5px; }
      .pdfCustom { margin-top: 4px; font-size: 12px; color: #3A3A3C; line-height: 1.5; font-weight: 500; }
      .subtitle { font-size: 14px; color: #3A3A3C; margin-top: 8px; font-weight: 600; }
      .printed { font-size: 10px; color: #7C7872; margin-top: 4px; }
      table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 12px; }
      th { text-align: left; padding: 10px 8px; background: ${branding.tertiary}; color: ${branding.onTertiary}; font-weight: 700; border-bottom: 2px solid ${branding.primary}; }
      td { padding: 9px 8px; border-bottom: 1px solid #E2DFD8; vertical-align: top; }
      tr:nth-child(even) td { background: #FAFAF7; }
      .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; background: ${branding.primary}; color: ${branding.onPrimary}; font-size: 10px; font-weight: 700; margin-left: 6px; }
      .badgeWarn { background: #C27803; color: #FFF; }
      .kpiRow { display: flex; gap: 12px; margin-bottom: 24px; }
      .kpi { flex: 1; padding: 16px; border-radius: 12px; background: ${branding.tertiary}; color: ${branding.onTertiary}; }
      .kpiValue { font-size: 30px; font-weight: 800; color: ${branding.primary}; }
      .kpiLabel { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; }
      .bar { height: 10px; background: #EFECE6; border-radius: 5px; overflow: hidden; margin-top: 4px; }
      .barFill { height: 100%; background: ${branding.primary}; }
      .section { margin-top: 20px; font-size: 14px; font-weight: 800; color: ${branding.primary}; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px; }
      .footer { margin-top: 30px; padding-top: 12px; border-top: 1px solid #E2DFD8; font-size: 10px; color: #7C7872; text-align: center; }
      .empty { padding: 30px; text-align: center; color: #7C7872; font-style: italic; }
    </style>
  `;
}

function footer(branding: BrandingConfig) {
  return `<div class="footer">${escapeHtml(branding.title)} — Offline Report</div>`;
}

export function buildPatientListHtml(branding: BrandingConfig, patients: Patient[]): string {
  const rows =
    patients.length === 0
      ? `<tr><td colspan="7"><div class="empty">No patients recorded.</div></td></tr>`
      : patients
          .map((p, idx) => {
            const badge =
              p.operationCount && p.operationCount > 1
                ? `<span class="badge">${escapeHtml(ordinalSuffix(p.operationCount))} time</span>`
                : "";
            return `
              <tr>
                <td>${idx + 1}</td>
                <td>${escapeHtml(p.date)}</td>
                <td><strong>${escapeHtml(p.mrNo || "—")}</strong></td>
                <td>${escapeHtml(p.name || "—")}${badge}</td>
                <td>${escapeHtml([p.gender, p.age].filter(Boolean).join(" • "))}</td>
                <td>${escapeHtml(p.diagnosis)}</td>
                <td>${escapeHtml(p.procedure)}<br/><span style="color:#7C7872;font-size:10px">${escapeHtml(
                  [p.implant, p.implantII].filter(Boolean).join(" • "),
                )}</span></td>
              </tr>
            `;
          })
          .join("");
  return `
    <html>
      <head><meta charset="utf-8"/>${styles(branding)}</head>
      <body>
        ${header(branding, `Patient List — ${patients.length} record${patients.length === 1 ? "" : "s"}`)}
        <table>
          <thead>
            <tr>
              <th style="width:32px">#</th>
              <th style="width:80px">Date</th>
              <th style="width:70px">MR No</th>
              <th>Patient</th>
              <th style="width:100px">Gender/Age</th>
              <th>Diagnosis</th>
              <th>Procedure / Implant</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        ${footer(branding)}
      </body>
    </html>
  `;
}

export function buildStatsHtml(
  branding: BrandingConfig,
  stats: StatsData,
  periodLabel: string,
): string {
  const max = Math.max(1, ...stats.procedures.map((p) => p.count));
  const rows = stats.procedures.length
    ? stats.procedures
        .map(
          (p) => `
        <tr>
          <td>${escapeHtml(p.name)}</td>
          <td style="width:80px;text-align:right"><strong>${p.count}</strong></td>
          <td style="width:200px"><div class="bar"><div class="barFill" style="width:${
            (p.count / max) * 100
          }%"></div></div></td>
        </tr>
      `,
        )
        .join("")
    : `<tr><td colspan="3"><div class="empty">No procedure data.</div></td></tr>`;
  return `
    <html>
      <head><meta charset="utf-8"/>${styles(branding)}</head>
      <body>
        ${header(branding, `Statistics — ${periodLabel}`)}
        <div class="kpiRow">
          <div class="kpi">
            <div class="kpiLabel">Total Surgeries</div>
            <div class="kpiValue">${stats.total_patients}</div>
          </div>
          <div class="kpi">
            <div class="kpiLabel">Distinct Procedures</div>
            <div class="kpiValue">${stats.procedures.length}</div>
          </div>
        </div>
        <div class="section">Procedure Breakdown</div>
        <table>
          <thead>
            <tr>
              <th>Procedure</th>
              <th style="text-align:right">Count</th>
              <th>Share</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        ${footer(branding)}
      </body>
    </html>
  `;
}

export function buildInventoryHtml(
  branding: BrandingConfig,
  items: InventoryItem[],
  lowOnly: boolean,
): string {
  const list = lowOnly ? items.filter((i) => i.quantity <= i.minimumStock) : items;
  const rows = list.length
    ? list
        .map((i, idx) => {
          const low = i.quantity <= i.minimumStock;
          return `
        <tr>
          <td>${idx + 1}</td>
          <td><strong>${escapeHtml(i.name)}</strong></td>
          <td style="text-align:right">${i.quantity} ${escapeHtml(i.unit || "pcs")}</td>
          <td style="text-align:right">${i.minimumStock}</td>
          <td>${low ? '<span class="badge badgeWarn">LOW</span>' : '<span class="badge">OK</span>'}</td>
        </tr>
      `;
        })
        .join("")
    : `<tr><td colspan="5"><div class="empty">No ${lowOnly ? "low-stock" : ""} items.</div></td></tr>`;
  return `
    <html>
      <head><meta charset="utf-8"/>${styles(branding)}</head>
      <body>
        ${header(branding, lowOnly ? `Low Stock Report — ${list.length} item${list.length === 1 ? "" : "s"}` : `Inventory — ${list.length} items`)}
        <table>
          <thead>
            <tr>
              <th style="width:32px">#</th>
              <th>Item / Implant</th>
              <th style="width:100px;text-align:right">Quantity</th>
              <th style="width:80px;text-align:right">Minimum</th>
              <th style="width:70px">Status</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        ${footer(branding)}
      </body>
    </html>
  `;
}

export async function generateAndSharePdf(html: string, fileNameHint: string): Promise<void> {
  const { uri } = await Print.printToFileAsync({ html, base64: false });
  if (Platform.OS === "web") {
    // Open in a new tab on web
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).window?.open?.(uri, "_blank");
    return;
  }
  const canShare = await Sharing.isAvailableAsync();
  if (canShare) {
    await Sharing.shareAsync(uri, { mimeType: "application/pdf", dialogTitle: fileNameHint, UTI: "com.adobe.pdf" });
  }
}
