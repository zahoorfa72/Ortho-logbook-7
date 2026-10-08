import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { formatInventoryLabel } from "./inventory-label";
import { Platform } from "react-native";
import * as ImageManipulator from "expo-image-manipulator";
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
  totalOperations?: number;
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
  const titleColor = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(String(branding.pdfTitleColor || "")) ? String(branding.pdfTitleColor) : "#1C1C1E";
  const subtitleSize = Number(branding.pdfSubtitleSize || 12);
  const customBlock = subtitleLinesHtml(branding);
  const layout = branding.pdfLogoLayout || "center";
  if (layout === "left") {
    return `
      <div class="header headerLeft">
        <div class="logoSide">${leftLogo}</div>
        <div class="titleBlock titleBlockLeft">
          <div class="title" style="font-size:${titleSize}px;font-weight:${titleWeight};color:${titleColor}">${escapeHtml(branding.title)}</div>
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
        <div class="title" style="font-size:${titleSize}px;font-weight:${titleWeight};color:${titleColor}">${escapeHtml(branding.title)}</div>
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
      .listPage { page-break-after: always; break-inside: avoid; }
      .listPage:last-child { page-break-after: auto; }
      .listPage table { page-break-inside: avoid; }
      .empty { padding: 30px; text-align: center; color: #7C7872; font-style: italic; }
    </style>
  `;
}

function footer(branding: BrandingConfig) {
  const suffix = String(branding.pdfFooterText || "Offline Report").trim();
  return `<div class="footer">${escapeHtml(branding.title)} — ${escapeHtml(suffix)}</div>`;
}

export function buildPatientListHtml(branding: BrandingConfig, patients: Patient[], fromDate?: string, toDate?: string): string {
  const parseDate = (v:string) => {
    const raw=String(v||"").trim();
    if(!raw) return "";
    const iso=raw.match(/^(\\d{4})[-\\/](\\d{1,2})[-\\/](\\d{1,2})$/);
    if(iso) return iso[1]+iso[2].padStart(2,"0")+iso[3].padStart(2,"0");
    const dmy=raw.match(/^(\\d{1,2})[-\\/](\\d{1,2})[-\\/](\\d{4})$/);
    if(dmy) return dmy[3]+dmy[2].padStart(2,"0")+dmy[1].padStart(2,"0");
    const parsed=new Date(raw);
    return Number.isNaN(parsed.getTime()) ? raw : parsed.getFullYear()+String(parsed.getMonth()+1).padStart(2,"0")+String(parsed.getDate()).padStart(2,"0");
  };
  const fromKey=parseDate(fromDate||"");
  const toKey=parseDate(toDate||"");
  const filteredPatients=patients.filter(p=>{
    const d=parseDate(String(p.date||""));
    if(fromKey && (!d || d<fromKey)) return false;
    if(toKey && (!d || d>toKey)) return false;
    return true;
  });
  patients=filteredPatients;
  const fields = Array.isArray(branding.pdfPatientFields) && branding.pdfPatientFields.length
    ? branding.pdfPatientFields
    : ["date","mrNo","name","gender","age","diagnosis","procedure"];
  const labels: Record<string,string> = {date:"Date",mrNo:"MR No",name:"Patient",gender:"Gender",age:"Age",address:"Address",diagnosis:"Diagnosis",procedure:"Procedure",implants:"Implants",fileName:"File Name"};
  const legacyHierarchy = [
    { fields: [branding.pdfMainHeadingField || "name"], label: "Main Heading" },
    { fields: [branding.pdfSubHeadingField || "procedure"], label: "Sub-heading 1" },
  ];
  const hierarchy = Array.isArray(branding.pdfHeadingLevels) && branding.pdfHeadingLevels.length
    ? branding.pdfHeadingLevels.map((x:any) => ({ fields: Array.isArray(x?.fields) ? x.fields.filter(Boolean).map(String) : [], label: String(x?.label || "") })).filter((x:any) => x.fields.length)
    : legacyHierarchy;
  const headingMap:any = branding.pdfHeadingMap && typeof branding.pdfHeadingMap==="object" ? branding.pdfHeadingMap : {};
  const hierarchyChildFields = new Set<string>();
  Object.values(headingMap).forEach((cfg:any) => {
    (Array.isArray(cfg?.heading) ? cfg.heading : []).forEach((k:any) => hierarchyChildFields.add(String(k)));
    (Array.isArray(cfg?.subHeading) ? cfg.subHeading : []).forEach((k:any) => hierarchyChildFields.add(String(k)));
  });
  // A field used as a Heading/Sub-heading belongs under its parent Main Entry,
  // so it must not also appear as a separate Main Entry column.
  const mainFields = fields.filter((k:string) => !hierarchyChildFields.has(String(k)));
  const levelFor = (key:string) => {
    const index = hierarchy.findIndex((x:any) => x.fields.includes(key));
    return index >= 0 ? index + 1 : 0;
  };
  const value = (p: Patient, key: string) => {
    if(key === "gender") return p.gender || "";
    if(key === "age") return p.age || "";
    if(key === "address") return p.address || "";
    if(key === "fileName") return p.fileName || "";
    if(key === "date") return p.date || "";
    if(key === "mrNo") return p.mrNo || "";
    if(key === "name") return p.name || "";
    if(key === "diagnosis") return p.diagnosis || "";
    if(key === "procedure") return p.procedure || "";
    if(key === "implants") {
      const items = Array.isArray(p.implants) && p.implants.length
        ? p.implants.map((x:any)=>formatInventoryLabel(x.category,x.name,x.size)+(Number(x.quantity)>1?" × "+x.quantity:""))
        : [p.implant,p.implantII].filter(Boolean);
      return items.join(" • ");
    }
    return String((p.customData||{})[key] || "");
  };
  const groups = new Map<string, Patient[]>();
  const keyOf = (p: Patient) => (p.name||"").trim().toLowerCase()+"|"+(p.mrNo||"").trim().toLowerCase();
  for(const p of patients){ const key=keyOf(p); const list=groups.get(key)||[]; list.push(p); groups.set(key,list); }
  const counts = new Map<string,number>();
  for(const list of groups.values()){ const sorted=[...list].sort((a,b)=>String(a.date||"").localeCompare(String(b.date||""))||String(a.id||"").localeCompare(String(b.id||""))); sorted.forEach((p,i)=>counts.set(p.id,i+1)); }
  const pageTables:string[]=[]; const pageSize=Math.max(1, Math.min(200, Number(branding.pdfPatientsPerPage || 20)));
  for(let start=0; start<patients.length || (patients.length===0&&start===0); start+=pageSize){
    const page=patients.slice(start,start+pageSize);
    let rows="";
    page.forEach((p,idx)=>{
      const occurrence=Number(counts.get(p.id) || p.operationCount || 1);
      const total=Number(groups.get(keyOf(p))?.length || p.totalOperations || 0);
      const badge=branding.pdfShowOccurrenceBadge!==false && occurrence>1
        ? '<span class="occurrence occurrence-'+occurrence+'">'+escapeHtml(ordinalSuffix(occurrence))+' time</span>'
        : "";
      rows += "<tr><td class='indexCell'>"+(start+idx+1)+"</td>"+mainFields.map(k=>{
        const raw=escapeHtml(value(p,k)||"—");
        const cfg:any=headingMap[String(k)] || {};
        const headingKeys:string[]=Array.isArray(cfg.heading)?cfg.heading.map(String):[];
        const subKeys:string[]=Array.isArray(cfg.subHeading)?cfg.subHeading.map(String):[];
        const headingLines=headingKeys.map(h=>"<div class='pdfHeadingLine pdfHierarchyText'><b>"+escapeHtml(labels[h]||h)+"</b> — "+escapeHtml(value(p,h)||"—")+"</div>").join("");
        const subLines=subKeys.map(h=>"<div class='pdfSubHeadingLine pdfHierarchyText'><b>"+escapeHtml(labels[h]||h)+"</b> — "+escapeHtml(value(p,h)||"—")+"</div>").join("");
        const level=levelFor(k);
        const headingClass=level ? " headingLevel"+level : "";
        const styled=level ? "<span class='headingText"+headingClass+"'>"+raw+"</span>" : raw;
        return "<td>"+styled+headingLines+subLines+(k===mainFields[0]?badge:"")+"</td>";
      }).join("")+"</tr>";
    });
    if(!rows) rows='<tr><td colspan="'+(mainFields.length+1)+'"><div class="empty">No patients recorded.</div></td></tr>';
    const heads=mainFields.map(k=>"<th>"+escapeHtml(labels[k]||k)+"</th>").join("");
    pageTables.push('<section class="listPage"><table><thead><tr><th class="indexHead">#</th>'+heads+'</tr></thead><tbody>'+rows+'</tbody></table></section>');
  }
  const mainSize = branding.pdfMainEntryTextSize==="small" ? 7.2 : branding.pdfMainEntryTextSize==="large" ? 9.4 : 8.2;
  const mainWeight = ({normal:400,medium:500,semibold:600,bold:700} as any)[branding.pdfMainEntryTextWeight || "bold"] || 700;
  const mainTone = branding.pdfMainEntryTextTone==="light" ? "#7C7872" : branding.pdfMainEntryTextTone==="dark" ? "#1C1C1E" : "#3A3A3C";
  const headingSize = branding.pdfHeadingTextSize==="small" ? 0.92 : branding.pdfHeadingTextSize==="large" ? 1.12 : 1;
  const subHeadingSize = branding.pdfSubHeadingTextSize==="small" ? 0.88 : branding.pdfSubHeadingTextSize==="large" ? 1.08 : 0.96;
  const headingWeight = ({normal:400,medium:500,semibold:600,bold:700} as any)[branding.pdfHeadingTextWeight || "normal"] || 400;
  const subHeadingWeight = ({normal:400,medium:500,semibold:600,bold:700} as any)[branding.pdfSubHeadingTextWeight || "normal"] || 400;
  const tone = (v:any) => v==="light" ? "#7C7872" : v==="dark" ? "#1C1C1E" : "#3A3A3C";
  const headingTone = tone(branding.pdfHeadingTextTone);
  const subHeadingTone = tone(branding.pdfSubHeadingTextTone);
  return '<html><head><meta charset="utf-8"/>'+styles(branding)+'<style>'+
    '.header{page-break-inside:avoid;break-inside:avoid;page-break-after:avoid;break-after:avoid}.titleBlock,.logoSide{page-break-inside:avoid;break-inside:avoid}table{page-break-inside:auto;break-inside:auto;font-size:'+mainSize+'px;table-layout:fixed;width:100%;border-collapse:collapse}.listPage{display:block;page-break-after:always;break-after:page;page-break-inside:avoid;break-inside:avoid;height:calc(100vh - '+(Number(branding.pdfMargin||28)*2)+'px);overflow:hidden}.listPage:last-child{page-break-after:auto;break-after:auto}th,td{padding:2.5px 3.5px;line-height:1.08;vertical-align:middle}td{color:'+mainTone+';font-weight:'+mainWeight+'}.indexHead,.indexCell{width:22px;text-align:center}.headingText{display:block}.headingLevel1,.headingLevel2,.headingLevel3,.headingLevel4{font-size:'+headingSize+'em;font-weight:'+headingWeight+';color:'+headingTone+'}.pdfHeadingLine{margin-top:3px;padding:0;color:'+headingTone+';font-weight:'+headingWeight+';font-size:'+headingSize+'em;line-height:1.15}.pdfSubHeadingLine{margin-top:2px;padding:0;color:'+subHeadingTone+';font-weight:'+subHeadingWeight+';font-size:'+subHeadingSize+'em;line-height:1.12}.pdfHeadingLine b,.pdfSubHeadingLine b{color:inherit;font-weight:inherit}.pdfSubHeadingLine{margin-left:0}.occurrence{display:inline-block;font-size:.76em;font-weight:700;margin-left:5px;white-space:nowrap;padding:2px 7px;border-radius:999px;line-height:1.2}.occurrence-2{background:#B8860B;color:#fff}.occurrence-3{background:#3F6B8A;color:#fff}.occurrence-4{background:#6B4C8A;color:#fff}.occurrence-5{background:#2F7D5B;color:#fff}.occurrence-6{background:#A64B2A;color:#fff}.occurrence-7{background:#8A5A2B;color:#fff}.occurrence-8{background:#4C566A;color:#fff}.occurrence-9{background:#9A3E5E;color:#fff}.occurrence-10{background:#356B73;color:#fff}.badge{font-size:.78em;margin-left:3px;white-space:nowrap}tbody tr{page-break-inside:avoid}'+
    '</style></head><body>'+
    header(branding,'Patient List — '+patients.length+' record'+(patients.length===1?'':'s')+(fromDate||toDate?' — '+(fromDate||'Start')+' to '+(toDate||'End'):''))+
    pageTables.join("")+footer(branding)+'</body></html>';
}

export async function buildPatientDetailHtml(
  branding: BrandingConfig,
  patients: Patient[],
  fields: PatientPdfField[],
  photoMode: "none" | "first" | "all" = "first",
): Promise<string> {
  // Keep occurrence numbering identical to the Patient List: same patient means
  // the same trimmed, case-insensitive Name + MR No identity.
  const identity = (p: Patient) =>
    `${(p.name || "").trim().toLowerCase()}|${(p.mrNo || "").trim().toLowerCase()}`;
  const groups = new Map<string, Patient[]>();
  for (const p of patients) {
    if (!(p.name || "").trim() && !(p.mrNo || "").trim()) continue;
    const key = identity(p);
    const list = groups.get(key) || [];
    list.push(p);
    groups.set(key, list);
  }
  const occurrenceMap = new Map<string, { occurrence:number; total:number }>();
  for (const list of groups.values()) {
    const sorted = [...list].sort(
      (a,b) => String(a.date || "").localeCompare(String(b.date || "")) ||
        String(a.id || "").localeCompare(String(b.id || "")),
    );
    sorted.forEach((p,i) => occurrenceMap.set(p.id,{ occurrence:i+1,total:sorted.length }));
  }

  const mainWeight = ({normal:400,medium:500,semibold:600,bold:700} as any)[branding.pdfMainEntryTextWeight || "bold"] || 700;
  const mainTone = branding.pdfMainEntryTextTone==="light" ? "#7C7872" : branding.pdfMainEntryTextTone==="dark" ? "#1C1C1E" : "#3A3A3C";
  const headingSize = branding.pdfHeadingTextSize==="small" ? 0.92 : branding.pdfHeadingTextSize==="large" ? 1.12 : 1;
  const subHeadingSize = branding.pdfSubHeadingTextSize==="small" ? 0.88 : branding.pdfSubHeadingTextSize==="large" ? 1.08 : 0.96;
  const headingWeight = ({normal:400,medium:500,semibold:600,bold:700} as any)[branding.pdfHeadingTextWeight || "normal"] || 400;
  const subHeadingWeight = ({normal:400,medium:500,semibold:600,bold:700} as any)[branding.pdfSubHeadingTextWeight || "normal"] || 400;
  const tone = (v:any) => v==="light" ? "#7C7872" : v==="dark" ? "#1C1C1E" : "#3A3A3C";
  const headingTone = tone(branding.pdfHeadingTextTone);
  const subHeadingTone = tone(branding.pdfSubHeadingTextTone);

  const photoCache = new Map<string,string>();
  const photoToData = async (uri:string) => {
    if (!uri) return "";
    if (uri.startsWith("data:image/")) return uri;
    const cached = photoCache.get(uri);
    if (cached !== undefined) return cached;
    try {
      // Print on Android is much more reliable with small embedded JPEGs than
      // full-resolution gallery/document images. Resize before embedding so
      // multiple patient photos cannot make the print renderer fail.
      const result = await ImageManipulator.manipulateAsync(
        uri,
        [{ resize: { width: 900 } }],
        { compress: 0.62, format: ImageManipulator.SaveFormat.JPEG, base64: true },
      );
      const base64 = result.base64 || "";
      if (!base64) return "";
      const data = "data:image/jpeg;base64," + base64;
      photoCache.set(uri,data);
      return data;
    } catch {
      try {
        const base64=await FileSystem.readAsStringAsync(uri,{encoding:FileSystem.EncodingType.Base64});
        if (!base64) return "";
        const data="data:image/jpeg;base64,"+base64;
        photoCache.set(uri,data);
        return data;
      } catch {
        return "";
      }
    }
  };

  const pages:string[]=[];
  for(let idx=0; idx<patients.length; idx++){
    const p=patients[idx];
    const fieldValues = new Map<string,string>();
    const getValue = (key:string) => {
      if(fieldValues.has(key)) return fieldValues.get(key) || "";
      let value="";
      if(key==="date") value=p.date;
      else if(key==="mrNo") value=p.mrNo;
      else if(key==="name") value=p.name;
      else if(key==="gender") value=p.gender;
      else if(key==="age") value=p.age;
      else if(key==="address") value=p.address||"";
      else if(key==="diagnosis") value=p.diagnosis;
      else if(key==="procedure") value=p.procedure || "";
      else if(key==="implants") {
        const items = Array.isArray(p.implants) && p.implants.length
          ? p.implants.map((x:any)=>formatInventoryLabel(x.category,x.name,x.size)+(Number(x.quantity)>1?" × "+x.quantity:""))
          : [p.implant,p.implantII].filter(Boolean);
        value = items.join(" • ");
      }
      else if(key==="fileName") value=p.fileName||"";
      else value=String((p.customData||{})[key]||"");
      fieldValues.set(key,value);
      return value;
    };
    const availableFields = fields.filter(f=>f.key!=="photos" && f.key!=="name" && f.key!=="mrNo");
    const labels = new Map(availableFields.map(f=>[String(f.key),String(f.label)]));
    const map:any = branding.pdfHeadingMap && typeof branding.pdfHeadingMap==="object" ? branding.pdfHeadingMap : {};
    const legacySub = Array.isArray(branding.pdfHeadingLevels) ? branding.pdfHeadingLevels.filter((g:any)=>["Sub-heading","Sub-heading 1"].includes(String(g?.label||""))).flatMap((g:any)=>Array.isArray(g?.fields)?g.fields.map(String):[]) : [];
    const legacySubSub = Array.isArray(branding.pdfHeadingLevels) ? branding.pdfHeadingLevels.filter((g:any)=>["Sub-sub-heading","Sub-sub-heading 1"].includes(String(g?.label||""))).flatMap((g:any)=>Array.isArray(g?.fields)?g.fields.map(String):[]) : [];
    const rows=availableFields.map(f=>{
      const raw:any=map[String(f.key)];
      const headingKeys:string[]=raw && Array.isArray(raw.heading) ? raw.heading.map(String) : legacySub;
      const subHeadingKeys:string[]=raw && Array.isArray(raw.subHeading) ? raw.subHeading.map(String) : legacySubSub;
      const headingRows=headingKeys.filter(k=>labels.has(k)).map(k=>"<div class=\"nestedEntry headingEntry\"><span class=\"nestedLabel\">"+escapeHtml(labels.get(k)||k)+"</span><span class=\"nestedValue\">"+escapeHtml(getValue(k)||"—")+"</span></div>").join("");
      const subRows=subHeadingKeys.filter(k=>labels.has(k)).map(k=>"<div class=\"nestedEntry subHeadingEntry\"><span class=\"nestedLabel\">"+escapeHtml(labels.get(k)||k)+"</span><span class=\"nestedValue\">"+escapeHtml(getValue(k)||"—")+"</span></div>").join("");
      return "<tr><th>"+escapeHtml(f.label)+"</th><td class=\"detailValue\"><div class=\"mainEntryValue\">"+escapeHtml(getValue(String(f.key))||"—")+"</div>"+headingRows+subRows+"</td></tr>";
    }).join("");

    const rawPhotos=Array.isArray(p.photos)&&p.photos.length
      ? p.photos.filter(Boolean)
      : ((p as any).photoUri ? [String((p as any).photoUri)] : []);
    const selectedPhotos=photoMode==="all"
      ? rawPhotos
      : (photoMode==="first" ? rawPhotos.slice(0,1) : []);
    const photos:string[]=[];
    for(const uri of selectedPhotos){
      const src=await photoToData(uri);
      if(src) photos.push("<img src=\"" + src + "\" class=\"patientPhoto\" />");
    }

    const derived=occurrenceMap.get(p.id);
    const occurrence=Number(derived?.occurrence || p.operationCount || 1);
    const total=Number(derived?.total || p.totalOperations || 0);
    const occurrenceTag=branding.pdfShowOccurrenceBadge!==false && occurrence>1
      ? "<span class='occurrenceTag occurrence-"+occurrence+"'>"+escapeHtml(ordinalSuffix(occurrence))+" time</span>"
      : "";

    pages.push(
      "<section class='patientPage'>"+
      "<div class='patientNumber'>Patient "+(idx+1)+" of "+patients.length+"</div>"+
      "<div class='patientName'>"+escapeHtml(p.name||"Unnamed patient")+occurrenceTag+"</div>"+
      (p.mrNo?"<div class='patientMr'>MR No: "+escapeHtml(p.mrNo)+"</div>":"")+
      "<table class='detailTable'><tbody>"+rows+"</tbody></table>"+
      (photos.length?"<div class='photoGrid'>"+photos.join("")+"</div>":"")+
      "</section>"
    );
  }

  return "<html><head><meta charset='utf-8'/>"+styles(branding)+
    "<style>"+
    ".detailHeaderPage{page-break-after:always;break-after:page;min-height:250mm}"+
    ".patientPage{page-break-after:always;page-break-inside:avoid;break-inside:avoid;border:1px solid #E2DFD8;border-radius:14px;padding:16px;margin-bottom:8px}"+
    ".patientPage:last-child{page-break-after:auto}"+
    ".patientNumber{font-size:10px;color:#7C7872;text-transform:uppercase;letter-spacing:1px;margin-bottom:5px}"+
    ".patientName{font-size:22px;font-weight:800;color:"+branding.primary+";display:flex;align-items:center;gap:8px;flex-wrap:wrap}"+
    ".occurrenceTag{display:inline-block;font-size:12px;font-weight:700;margin-left:6px;white-space:nowrap;padding:3px 9px;border-radius:999px;line-height:1.2}.occurrenceTag.occurrence-2{background:#B8860B;color:#fff}.occurrenceTag.occurrence-3{background:#3F6B8A;color:#fff}.occurrenceTag.occurrence-4{background:#6B4C8A;color:#fff}.occurrenceTag.occurrence-5{background:#2F7D5B;color:#fff}.occurrenceTag.occurrence-6{background:#A64B2A;color:#fff}.occurrenceTag.occurrence-7{background:#8A5A2B;color:#fff}.occurrenceTag.occurrence-8{background:#4C566A;color:#fff}.occurrenceTag.occurrence-9{background:#9A3E5E;color:#fff}.occurrenceTag.occurrence-10{background:#356B73;color:#fff}"+
    ".patientMr{font-size:12px;color:#3A3A3C;margin-top:4px;margin-bottom:12px}"+
    ".detailTable th{width:28%;background:"+branding.tertiary+"}"+
    ".detailTable td{padding:5px 6px;vertical-align:top;line-height:1.25}.mainEntryValue{font-size:"+(branding.pdfMainEntryTextSize==="small"?"0.92":branding.pdfMainEntryTextSize==="large"?"1.08":"1")+"em;font-weight:"+mainWeight+";color:"+mainTone+";margin-bottom:5px}.nestedEntry{display:flex;gap:8px;padding:3px 0 3px 10px;border-left:3px solid #555555;line-height:1.2}.nestedLabel{font-weight:"+headingWeight+";font-size:"+headingSize+"em;color:"+headingTone+"}.nestedValue{font-weight:"+headingWeight+";font-size:"+headingSize+"em;color:"+headingTone+"}.subHeadingEntry{margin-left:12px;border-left-color:#5B5145;font-weight:"+subHeadingWeight+";font-size:"+subHeadingSize+"em;color:"+subHeadingTone+"}.subHeadingEntry .nestedLabel,.subHeadingEntry .nestedValue{font-weight:"+subHeadingWeight+";color:"+subHeadingTone+"}"+
    ".photoGrid{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;align-items:flex-start;page-break-inside:avoid}"+
    ".patientPhoto{width:110px;height:110px;object-fit:cover;border-radius:8px;border:1px solid #E2DFD8}"+
    "</style></head><body>"+
    "<section class='detailHeaderPage'>"+header(branding,"Detailed Patient Report — "+patients.length+" record"+(patients.length===1?"":"s"))+"</section>"+
    pages.join("")+
    footer(branding)+
    "</body></html>";
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
