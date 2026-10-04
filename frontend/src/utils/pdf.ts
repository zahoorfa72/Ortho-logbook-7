import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { formatInventoryLabel } from "./inventory-label";
import { Platform } from "react-native";
import * as FileSystem from "expo-file-system/legacy";

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
  address?: string; fileName?: string; photos?: string[]; customData?: Record<string,string>;
  implants?: any[];
};

type PatientPdfField = { key:string; label:string };

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

function richSubtitleHtml(text: string, baseWeight: string) {
  const parts = String(text || "").split("**");
  return parts.map((part, i) => {
    const safe = escapeHtml(part);
    const weight = i % 2 === 1 ? "800" : baseWeight;
    return `<span style="font-weight:${weight}">${safe}</span>`;
  }).join("");
}

function subtitleLinesHtml(branding: BrandingConfig) {
  const configured = Array.isArray(branding.pdfSubtitleLines) ? branding.pdfSubtitleLines : [];
  const lines = configured.length ? configured : String(branding.pdfSubtitle || "").split("\n").map(text => ({ text, size: Number(branding.pdfSubtitleSize || 12), font: branding.pdfSubtitleFont || "regular", bold: false }));
  return lines.slice(0, 4).filter((line: any) => String(line?.text || "").trim()).map((line: any) => {
    const font = line.font === "regular" ? "400" : line.font === "medium" ? "500" : line.font === "semibold" ? "600" : "800";
    const weight = line.bold ? "800" : font;
    const size = Math.max(8, Math.min(48, Number(line.size) || 12));
    return `<div style="font-size:${size}px;font-weight:${weight};line-height:1.35">${richSubtitleHtml(String(line.text), weight)}</div>`;
  }).join("");
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
  const titleWeight = branding.pdfTitleFont === "regular" ? "400" : branding.pdfTitleFont === "medium" ? "500" : branding.pdfTitleFont === "semibold" ? "600" : "800";
  const subtitleWeight = branding.pdfSubtitleFont === "regular" ? "400" : branding.pdfSubtitleFont === "medium" ? "500" : branding.pdfSubtitleFont === "semibold" ? "600" : "800";
  const titleSize = Number(branding.pdfTitleSize || 24);
  const subtitleSize = Number(branding.pdfSubtitleSize || 12);
  const customBlock = subtitleLinesHtml(branding);
  const layout = branding.pdfLogoLayout || "center";
  if (layout === "left") {
    return `
      <div class="header headerLeft">
        <div class="logoSide">${leftLogo}</div>
        <div class="titleBlock titleBlockLeft">
          <div class="title" style="font-size:${titleSize}px;font-weight:${titleWeight}">${escapeHtml(branding.title)}</div>
          ${customBlock}
          <div class="subtitle" style="font-size:${subtitleSize}px;font-weight:${subtitleWeight}">${escapeHtml(subtitle)}</div>
          ${branding.pdfShowGeneratedAt === false ? "" : `<div class="printed">Generated on ${escapeHtml(new Date().toLocaleString())}</div>`}
        </div>
      </div>
    `;
  }
  return `
    <div class="header">
      <div class="logoSide">${leftLogo}</div>
      <div class="titleBlock">
        <div class="title" style="font-size:${titleSize}px;font-weight:${titleWeight}">${escapeHtml(branding.title)}</div>
        ${customBlock}
        <div class="subtitle" style="font-size:${subtitleSize}px;font-weight:${subtitleWeight}">${escapeHtml(subtitle)}</div>
        ${branding.pdfShowGeneratedAt === false ? "" : `<div class="printed">Generated on ${escapeHtml(new Date().toLocaleString())}</div>`}
      </div>
      <div class="logoSide">${rightLogo}</div>
    </div>
  `;
}

function styles(branding: BrandingConfig) {
  return `
    <style>
      * { box-sizing: border-box; }
      body { font-family: -apple-system, Helvetica, Arial, sans-serif; color: #1C1C1E; margin: 0; padding: ${Number(branding.pdfMargin || 28)}px; }
      @page { size: ${branding.pdfPageSize || "A4"} ${branding.pdfOrientation || "portrait"}; margin: ${Number(branding.pdfMargin || 28)}px; }
      .header { display: flex; align-items: center; gap: 18px; border-bottom: 3px solid ${branding.primary}; padding-bottom: 10px; margin-bottom: 12px; }
      .logoSide { flex: 0 0 auto; }
      .logo { width: 62px; height: 62px; border-radius: 12px; object-fit: contain; background: ${branding.tertiary}; display: block; }
      .logoPlaceholder { width: 62px; height: 62px; border-radius: 12px; background: ${branding.primary}; color: ${branding.onPrimary}; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 26px; }
      .titleBlock { flex: 1; text-align: center; }
      .titleBlockLeft { text-align: left; padding-left: 4px; }
      .headerLeft .logoSide { flex: 0 0 auto; }
      .title { font-size: 24px; font-weight: 800; color: ${branding.primary}; margin: 0; letter-spacing: 0.5px; }
      .pdfCustom { margin-top: 4px; font-size: 12px; color: #3A3A3C; line-height: 1.5; font-weight: 500; }
      .subtitle { font-size: 12px; color: #3A3A3C; margin-top: 8px; font-weight: 600; }
      .printed { font-size: 10px; color: #7C7872; margin-top: 4px; }
      table { width: 100%; border-collapse: collapse; margin-bottom: 6px; font-size: 9.5px; }
      th { text-align: left; padding: 5px 5px; background: ${branding.pdfTableHeaderColor || branding.tertiary}; color: ${branding.onTertiary}; font-weight: 700; border-bottom: 2px solid ${branding.primary}; }
      td { padding: 4px 5px; border-bottom: 1px solid #E2DFD8; vertical-align: top; }
      tr:nth-child(even) td { background: ${branding.pdfTableStripeColor || "#FAFAF7"}; }
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
      .listPage { page-break-after: always; break-inside: avoid; }\n      .listPage:last-child { page-break-after: auto; }\n      .listPage table { page-break-inside: avoid; }\n      .empty { padding: 30px; text-align: center; color: #7C7872; font-style: italic; }
    </style>
  `;
}

function footer(branding: BrandingConfig) {
  const suffix = String(branding.pdfFooterText || "Offline Report").trim();
  return `<div class="footer">${escapeHtml(branding.title)} — ${escapeHtml(suffix)}</div>`;
}

export function buildPatientListHtml(branding: BrandingConfig, patients: Patient[], fromDate?: string, toDate?: string): string {
  const fields = Array.isArray(branding.pdfPatientFields) && branding.pdfPatientFields.length
    ? branding.pdfPatientFields
    : ["date","mrNo","name","gender","age","diagnosis","procedure"];
  const labels: Record<string,string> = {date:"Date",mrNo:"MR No",name:"Patient",gender:"Gender",age:"Age",address:"Address",diagnosis:"Diagnosis",procedure:"Procedure / Implant",fileName:"File Name"};
  const value = (p: Patient, key: string) => {
    if(key === "procedure"){
      const implants = p.implants?.length
        ? p.implants.map((x:any)=>formatInventoryLabel(x.category,x.name,x.size)+(Number(x.quantity)>1?" × "+x.quantity:"")).join(" • ")
        : [p.implant,p.implantII].filter(Boolean).join(" • ");
      return [p.procedure, implants ? "Implant: "+implants : ""].filter(Boolean).join(" — ");
    }
    if(key === "gender") return p.gender || "";
    if(key === "age") return p.age || "";
    if(key === "address") return p.address || "";
    if(key === "fileName") return p.fileName || "";
    if(key === "date") return p.date || "";
    if(key === "mrNo") return p.mrNo || "";
    if(key === "name") return p.name || "";
    if(key === "diagnosis") return p.diagnosis || "";
    return String((p.customData||{})[key] || "");
  };
  const groups = new Map<string, Patient[]>();
  const keyOf = (p: Patient) => (p.name||"").trim().toLowerCase()+"|"+(p.mrNo||"").trim().toLowerCase();
  for(const p of patients){ const key=keyOf(p); const list=groups.get(key)||[]; list.push(p); groups.set(key,list); }
  const counts = new Map<string,number>();
  for(const list of groups.values()){ const sorted=[...list].sort((a,b)=>String(a.date||"").localeCompare(String(b.date||""))||String(a.id||"").localeCompare(String(b.id||""))); sorted.forEach((p,i)=>counts.set(p.id,i+1)); }
  const pageTables:string[]=[]; const pageSize=14;
  for(let start=0; start<patients.length || (patients.length===0&&start===0); start+=pageSize){
    const page=patients.slice(start,start+pageSize);
    let rows="";
    page.forEach((p,idx)=>{
      const badge=(counts.get(p.id)||p.operationCount||1)>1 ? '<span class="badge">'+escapeHtml(ordinalSuffix(counts.get(p.id)||p.operationCount||1))+' time</span>' : "";
      rows += "<tr><td>"+(start+idx+1)+"</td>"+fields.map(k=>"<td>"+(k==="name"?"<strong>":"")+escapeHtml(value(p,k)||"—")+(k==="name"?"</strong>":"")+(k==="name"?badge:"")+"</td>").join("")+"</tr>";
    });
    if(!rows) rows='<tr><td colspan="'+(fields.length+1)+'"><div class="empty">No patients recorded.</div></td></tr>';
    const heads=fields.map(k=>"<th>"+escapeHtml(labels[k]||k)+"</th>").join("");
    pageTables.push('<section class="listPage"><table><thead><tr><th style="width:26px">#</th>'+heads+'</tr></thead><tbody>'+rows+'</tbody></table></section>');
  }
  return '<html><head><meta charset="utf-8"/>'+styles(branding)+'<style>table{font-size:'+ (fields.length>6?'8px':'9.5px') +';} th,td{padding:'+(fields.length>6?'3px 4px':'4px 5px')+';}</style></head><body>'+
    header(branding,'Patient List — '+patients.length+' record'+(patients.length===1?'':'s')+(fromDate||toDate?' — '+(fromDate||'Start')+' to '+(toDate||'End'):'') )+
    pageTables.join("")+footer(branding)+'</body></html>';
}
export async function buildPatientDetailHtml(
  branding: BrandingConfig,
  patients: Patient[],
  fields: PatientPdfField[],
  photoMode: "none" | "first" | "all" = "first",
): Promise<string> {
  const photoToData = async (uri:string) => {
    if(!uri) return "";
    if(uri.startsWith("data:")) return uri;
    try {
      const base64=await FileSystem.readAsStringAsync(uri,{encoding:FileSystem.EncodingType.Base64});
      return "data:image/jpeg;base64,"+base64;
    } catch { return ""; }
  };
  const pages=await Promise.all(patients.map(async (p,idx)=>{
    const rows=fields.filter(f=>f.key!=="photos" && f.key!=="implants").map(f=>{
      let value="";
      if(f.key==="date") value=p.date;
      else if(f.key==="mrNo") value=p.mrNo;
      else if(f.key==="name") value=p.name;
      else if(f.key==="gender") value=p.gender;
      else if(f.key==="age") value=p.age;
      else if(f.key==="address") value=p.address||"";
      else if(f.key==="diagnosis") value=p.diagnosis;
      else if(f.key==="procedure") {
        const implantText=(p.implants&&p.implants.length
          ? p.implants.map((x:any)=>formatInventoryLabel(x.category,x.name,x.size)+(Number(x.quantity)>1?" × "+x.quantity:"")).join(" • ")
          : [p.implant,p.implantII].filter(Boolean).join(" • "));
        value=p.procedure || "";
        if(implantText) value += (value ? "\n" : "") + "Implant: " + implantText;
      }
      else if(f.key==="fileName") value=p.fileName||"";
      else value=String((p.customData||{})[f.key]||"");
      return "<tr><th>"+escapeHtml(f.label)+"</th><td class='detailValue'>"+escapeHtml(value||"—")+"</td></tr>";
    }).join("");
    const rawPhotos=Array.isArray(p.photos)?p.photos.filter(Boolean):[];
    const selectedPhotos=photoMode==="all"?rawPhotos:(photoMode==="first"?rawPhotos.slice(0,1):[]);
    const photos=[];
    for(const uri of selectedPhotos){const src=await photoToData(uri);if(src)photos.push("<img src='"+src+"' class='patientPhoto' />");}
    return "<section class='patientPage'>"+
      "<div class='patientNumber'>Patient "+(idx+1)+" of "+patients.length+"</div>"+
      "<div class='patientName'>"+escapeHtml(p.name||"Unnamed patient")+"</div>"+
      (p.mrNo?"<div class='patientMr'>MR No: "+escapeHtml(p.mrNo)+"</div>":"")+
      "<table class='detailTable'><tbody>"+rows+"</tbody></table>"+
      (photos.length?"<div class='photoGrid'>"+photos.join("")+"</div>":"")+
      "</section>";
  }));
  return "<html><head><meta charset='utf-8'/>"+styles(branding)+"<style>.patientPage{page-break-after:always;border:1px solid #E2DFD8;border-radius:14px;padding:20px;margin-bottom:18px}.patientPage:last-child{page-break-after:auto}.patientNumber{font-size:10px;color:#7C7872;text-transform:uppercase;letter-spacing:1px;margin-bottom:5px}.patientName{font-size:22px;font-weight:800;color:"+branding.primary+"}.patientMr{font-size:12px;color:#3A3A3C;margin-top:4px;margin-bottom:16px}.detailTable th{width:28%;background:"+branding.tertiary+"}.photoGrid{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}.patientPhoto{width:220px;height:220px;object-fit:cover;border-radius:10px;border:1px solid #E2DFD8}</style></head><body>"+header(branding,"Detailed Patient Report — "+patients.length+" record"+(patients.length===1?"":"s"))+pages.join("")+footer(branding)+"</body></html>";
}

export function buildImplantRecordsHtml(branding: BrandingConfig, records:any[]): string {
  const rows=records.map((r:any,i:number)=>{
    let bills:any[]=[];try{const x=JSON.parse(r.bill_files_json||"[]");if(Array.isArray(x))bills=x;}catch{}
    const detail=[r.category,r.size,r.manufacturer,r.model].filter(Boolean).join(" · ");
    const trace=[r.lot_number&&"Lot: "+r.lot_number,r.serial_number&&"SN: "+r.serial_number,r.expiry_date&&"Expiry: "+r.expiry_date].filter(Boolean).join(" · ");
    return "<tr><td>"+(i+1)+"</td><td><strong>"+escapeHtml(r.name)+"</strong><br/><span style='color:#7C7872;font-size:10px'>"+escapeHtml(detail)+"</span></td><td>"+escapeHtml(trace||"—")+"</td><td style='text-align:right'>"+Number(r.quantity||0)+" "+escapeHtml(r.unit||"pcs")+"</td><td>"+escapeHtml(r.supplier||"—")+"</td><td>"+(bills.length?escapeHtml(bills.map((b:any)=>b.name||"Bill").join(", ")):"—")+"</td></tr>";
  }).join("");
  return "<html><head><meta charset='utf-8'/>"+styles(branding)+"</head><body>"+header(branding,"Detailed Implant Records — "+records.length+" record"+(records.length===1?"":"s"))+"<table><thead><tr><th>#</th><th>Implant / Details</th><th>Traceability</th><th style='text-align:right'>Quantity</th><th>Supplier</th><th>Attached Bills</th></tr></thead><tbody>"+(rows||"<tr><td colspan='6'><div class='empty'>No implant records.</div></td></tr>")+"</tbody></table>"+footer(branding)+"</body></html>";
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
          <td>
            <strong>${escapeHtml(formatInventoryLabel(i.category, i.name, i.size))}</strong>
            ${low ? '<div style="color:#A24B00;font-size:10px;font-weight:800;margin-top:3px">THIS ITEM IS LOW STOCK</div>' : ""}
          </td>
          <td style="text-align:right">${i.quantity} ${escapeHtml(i.unit || "pcs")}</td>
          <td style="text-align:right">${i.minimumStock}</td>
          <td>${low ? `<span class="badge badgeWarn">LOW — ${i.quantity} / ${i.minimumStock}</span>` : '<span class="badge">OK</span>'}</td>
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
              <th>Category / Item / Size</th>
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
