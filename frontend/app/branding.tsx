import { router } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import * as FileSystem from "expo-file-system";
import { Image } from "expo-image";
import { useCallback, useEffect, useState } from "react";
import { useFocusEffect } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import Ionicons from "@react-native-vector-icons/ionicons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api } from "@/src/api/client";
import { useAuth } from "@/src/auth/AuthContext";
import { PrimaryButton } from "@/src/components/PrimaryButton";
import { useToast } from "@/src/components/toast";
import { triggerAutomaticDriveBackup } from "@/src/utils/storage/drive-auto-backup";
import {
  BRANDING_PRESETS,
  BrandingConfig,
  defaultBranding,
  fontFamily,
  fontSize,
  makeStyles,
  radius,
  spacing,
  useTheme,
} from "@/src/theme";

const COLOR_FIELDS: {
  key: keyof BrandingConfig;
  label: string;
  desc: string;
}[] = [
  { key: "primary", label: "Primary", desc: "Buttons, links, FAB, headings" },
  { key: "onPrimary", label: "On Primary", desc: "Text on the primary colour" },
  { key: "secondary", label: "Secondary", desc: "Chart bars, accents" },
  { key: "tertiary", label: "Tertiary", desc: "Chip and badge backgrounds" },
  { key: "onTertiary", label: "On Tertiary", desc: "Text on chip/badge" },
  { key: "background", label: "Background", desc: "Screen backgrounds" },
  { key: "surface", label: "Surface", desc: "Cards, inputs" },
  { key: "text", label: "Text", desc: "Body text colour" },
  { key: "mutedText", label: "Muted Text", desc: "Labels, hints" },
  { key: "pdfTableHeaderColor", label: "PDF Header", desc: "Table heading background" },
  { key: "pdfTableStripeColor", label: "PDF Stripe", desc: "Alternating table rows" },
];

function activeToneColor(v: string) { return v === "light" ? "#7C7872" : v === "dark" ? "#1C1C1E" : "#3A3A3C"; }

function isHex(v: string) {
  return /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(v);
}

export default function BrandingScreen() {
  const styles = useStyles();
  const { colors, branding, setBranding, resetBranding } = useTheme();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const toast = useToast();

  const [draft, setDraft] = useState<BrandingConfig>(branding);
  const [saving, setSaving] = useState(false);
  const [subtitleSelection, setSubtitleSelection] = useState({ start: 0, end: 0 });
  const [subtitleSizeText, setSubtitleSizeText] = useState(String(branding.pdfSubtitleSize));
  const [titleSizeText, setTitleSizeText] = useState(String(branding.pdfTitleSize));
  const [pdfMarginText, setPdfMarginText] = useState(String(branding.pdfMargin));
  // Branding is loaded asynchronously from local storage. Keep the editor in
  // sync with the saved values so font/colour controls don't open on defaults.
  useEffect(() => {
    setDraft(branding);
    setSubtitleSizeText(String(branding.pdfSubtitleSize));
    setTitleSizeText(String(branding.pdfTitleSize));
    setPdfMarginText(String(branding.pdfMargin));
  }, [branding]);
  const { data: customFields = [], refetch: refetchCustomFields } = useQuery<any[]>({ queryKey: ["patient-custom-fields"], queryFn: () => api.get("/patient-custom-fields"), enabled: user?.role === "admin", refetchOnMount: "always", refetchOnReconnect: true, staleTime: 0 });
  // Branding can remain mounted while the admin opens Patient Fields. Refetch on
  // returning so newly created custom fields immediately appear in the order list.
  useFocusEffect(useCallback(() => { if (user?.role === "admin") void refetchCustomFields(); }, [user?.role, refetchCustomFields]));
  const patientPdfOptions = (() => {
    const base: [string,string][] = [["date","Date"],["mrNo","MR No"],["name","Patient Name"],["gender","Gender"],["age","Age"],["address","Address"],["diagnosis","Diagnosis"],["procedure","Procedure"],["procedureII",draft.procedureSecondLabel?.trim() || "Procedure 2"],["implants","Implants"],["fileName","File Name"],["hcvPlus","HCV+"],["hbaSg","HbAsg"],["hiv","HIV"]];
    const custom: [string,string][] = customFields.filter((f:any)=>f?.key && f?.label).map((f:any)=>[String(f.key),String(f.label)]);
    const savedKeys = [
      ...(Array.isArray(draft.pdfPatientFields) ? draft.pdfPatientFields : []),
      ...(Array.isArray(draft.pdfHeadingLevels) ? draft.pdfHeadingLevels.flatMap((g:any)=>Array.isArray(g?.fields) ? g.fields : []) : []),
    ].map(String);
    const saved: [string,string][] = savedKeys.map(key => [key,key]);
    const seen = new Set<string>();
    return [...base,...custom,...saved].filter(([key]) => {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  })();

  const set = (k: keyof BrandingConfig) => (v: string) =>
    setDraft((d) => ({ ...d, [k]: v }));

  if (user?.role !== "admin") {
    return (
      <View style={styles.container}>
        <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
          <Pressable onPress={() => router.back()} style={styles.headerBtn}>
            <Ionicons name="arrow-back" size={24} color={colors.onSurface} />
          </Pressable>
          <Text style={styles.headerTitle}>Branding</Text>
          <View style={styles.headerBtn} />
        </View>
        <View style={styles.center}>
          <Ionicons name="lock-closed-outline" size={40} color={colors.muted} />
          <Text style={styles.blockedTitle}>Administrator only</Text>
        </View>
      </View>
    );
  }

  const ensureLibraryPermission = async () => {
    const perm = await ImagePicker.getMediaLibraryPermissionsAsync();
    if (perm.granted) return true;
    if (!perm.canAskAgain) {
      toast("Photo permission is blocked. Enable it from Settings.", "error");
      return false;
    }
    const req = await ImagePicker.requestMediaLibraryPermissionsAsync();
    return req.granted;
  };

  const pickLogoFor = async (slot: "logoBase64" | "logoBase64Right") => {
    if (!(await ensureLibraryPermission())) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
      base64: true,
    });
    if (result.canceled) return;
    let base64 = result.assets[0]?.base64;
    const uri = result.assets[0]?.uri;
    if (!base64 && uri) {
      try {
        base64 = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
      } catch {
        toast("Could not read the selected image.", "error");
        return;
      }
    }
    if (!base64) return;
    if (base64.length > 1_500_000) {
      toast("Logo is too large. Please pick a smaller image (< 1MB).", "error");
      return;
    }
    const mime = result.assets[0]?.mimeType || "image/png";
    setDraft((d) => ({ ...d, [slot]: `data:${mime};base64,${base64}` }));
  };

  const clearLogo = (slot: "logoBase64" | "logoBase64Right") =>
    setDraft((d) => ({ ...d, [slot]: "" }));

  const applyPreset = (palette: Partial<BrandingConfig>) => {
    setDraft((d) => ({
      ...d,
      ...palette,
      onTertiary: palette.onTertiary || d.onTertiary,
      onPrimary: palette.onPrimary || d.onPrimary,
    }));
  };

  const commitSubtitleSize = () => {
    const n = Number(subtitleSizeText);
    const value = Number.isFinite(n) ? Math.max(8, Math.min(48, Math.round(n))) : branding.pdfSubtitleSize;
    setSubtitleSizeText(String(value));
    setDraft(d => ({ ...d, pdfSubtitleSize: value }));
  };

  const commitTitleSize = () => {
    const n = Number(titleSizeText);
    const value = Number.isFinite(n) ? Math.max(8, Math.min(72, Math.round(n))) : branding.pdfTitleSize;
    setTitleSizeText(String(value));
    setDraft(d => ({ ...d, pdfTitleSize: value }));
  };

  const onSave = async () => {
    if (!draft.title.trim()) {
      toast("App title is required.", "error");
      return;
    }
    for (const f of COLOR_FIELDS) {
      if (!isHex(String(draft[f.key]))) {
        toast(`Invalid colour for ${f.label}. Use hex format like #4A6B5D.`, "error");
        return;
      }
    }
    const margin=Math.max(12,Math.min(60,Math.round(Number(pdfMarginText)||28)));
    const legacyLines = String(draft.pdfSubtitle || "").split("\n").map(text => text.trim()).filter(Boolean).slice(0,4);
    const hasLineText = Array.isArray(draft.pdfSubtitleLines) && draft.pdfSubtitleLines.some(x => String(x.text || "").trim());
    const lines = hasLineText ? draft.pdfSubtitleLines : legacyLines.map(text => ({ text, size: draft.pdfSubtitleSize || 12, font: draft.pdfSubtitleFont || "regular", bold: false }));
    const nextDraft={...draft,pdfMargin:margin,pdfSubtitleLines:lines};
    setPdfMarginText(String(margin));
    setSaving(true);
    try {
      await setBranding(nextDraft);
      triggerAutomaticDriveBackup("branding");
      toast("Branding updated.", "success");
      router.back();
    } finally {
      setSaving(false);
    }
  };

  const onReset = async () => {
    await resetBranding();
    triggerAutomaticDriveBackup("branding");
    setDraft(defaultBranding);
    toast("Reset to default branding.", "success");
  };

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={() => router.back()} style={styles.headerBtn} testID="branding-back">
          <Ionicons name="arrow-back" size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>Branding</Text>
        <Pressable onPress={onReset} style={styles.headerBtn} testID="branding-reset">
          <Ionicons name="refresh" size={22} color={colors.brandPrimary} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={{
          padding: spacing.lg,
          paddingBottom: insets.bottom + 120,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.section}>App Identity</Text>

        <Text style={styles.label}>App Title</Text>
        <TextInput
          testID="branding-title-input"
          value={draft.title}
          onChangeText={set("title")}
          placeholder="Ortho Logbook"
          placeholderTextColor={colors.muted}
          style={styles.input}
        />

        <View style={styles.patientPdfEntryBox}>
          <Text style={styles.mainEntryTitle}>PDF Title — Professional Editing</Text>
          <Text style={styles.headingBoxHint}>Controls for the main title at the top of the Patient List and Patient Detail PDFs.</Text>
          <Text style={styles.colorLabel}>Font weight</Text>
          <View style={styles.styleRow}>{(["regular","medium","semibold","bold"] as const).map(v=><Pressable key={v} onPress={()=>setDraft(d=>({...d,pdfTitleFont:v}))} style={[styles.styleChip,{backgroundColor:draft.pdfTitleFont===v?colors.brandPrimary:colors.surfaceSecondary}]}><Text style={[styles.styleChipText,{color:draft.pdfTitleFont===v?colors.onBrandPrimary:colors.onSurface}]}>{v}</Text></Pressable>)}</View>
          <Text style={styles.colorLabel}>Text size (pt)</Text>
          <View style={styles.sizeControls}><Pressable style={styles.sizeButton} onPress={()=>{const n=Math.max(8,Math.round(Number(draft.pdfTitleSize||24)-1));setDraft(d=>({...d,pdfTitleSize:n}));setTitleSizeText(String(n));}}><Ionicons name="remove" size={18} color={colors.onSurface}/></Pressable><TextInput keyboardType="number-pad" value={titleSizeText} onChangeText={setTitleSizeText} onBlur={commitTitleSize} style={styles.smallSizeInput}/><Pressable style={styles.sizeButton} onPress={()=>{const n=Math.min(72,Math.round(Number(draft.pdfTitleSize||24)+1));setDraft(d=>({...d,pdfTitleSize:n}));setTitleSizeText(String(n));}}><Ionicons name="add" size={18} color={colors.onSurface}/></Pressable></View>
          <Text style={styles.colorLabel}>Text color</Text>
          <View style={{flexDirection:"row",alignItems:"center",gap:spacing.sm}}><View style={{width:30,height:30,borderRadius:15,backgroundColor:String(draft.pdfTitleColor||"#1C1C1E"),borderWidth:1,borderColor:colors.border}}/><TextInput value={String(draft.pdfTitleColor||"#1C1C1E")} onChangeText={v=>setDraft(d=>({...d,pdfTitleColor:v}))} placeholder="#1C1C1E" placeholderTextColor={colors.muted} autoCapitalize="none" style={[styles.input,{flex:1,marginBottom:0}]}/></View>
        </View>
        <Text style={[styles.label, { marginTop: spacing.md }]}>Individual PDF titles and subtitles</Text>
        <Text style={styles.hint}>Set a separate title and subtitle for each report. Leave a title blank to use the main app title. These settings are saved with Branding and included in backups.</Text>
        {([
          ["patientList", "Patient PDF"],
          ["patientDetail", "Individual Patient PDF"],
          ["implantRecords", "Implant Records PDF"],
          ["statistics", "Statistics PDF"],
          ["stock", "Stock / Inventory PDF"],
          ["lowStock", "Low Stock PDF"],
        ] as const).map(([key, label]) => {
          const config = draft.pdfReportHeaders?.[key] || {};
          const updateReportHeader = (field: "title" | "subtitle", value: string) =>
            setDraft(d => ({
              ...d,
              pdfReportHeaders: {
                ...(d.pdfReportHeaders || {}),
                [key]: {
                  ...(d.pdfReportHeaders?.[key] || {}),
                  [field]: value,
                },
              },
            }));
          return <View key={key} style={styles.subtitleLineCard}>
            <Text style={styles.subtitleLineLabel}>{label}</Text>
            <Text style={styles.label}>PDF title (optional)</Text>
            <TextInput
              value={config.title || ""}
              onChangeText={value => updateReportHeader("title", value)}
              placeholder={draft.title || "Ortho Logbook"}
              placeholderTextColor={colors.muted}
              style={styles.input}
              accessibilityLabel={label + " title"}
            />
            <Text style={styles.label}>PDF subtitle</Text>
            <TextInput
              value={config.subtitle || ""}
              onChangeText={value => updateReportHeader("subtitle", value)}
              placeholder="Enter report-specific subtitle"
              placeholderTextColor={colors.muted}
              style={styles.input}
              accessibilityLabel={label + " subtitle"}
            />
          </View>;
        })}

        <Text style={styles.label}>Logos (both sides of PDF title)</Text>
        <View style={styles.twinLogos}>
          <LogoSlot
            label="Left logo"
            slot="logoBase64"
            uri={draft.logoBase64}
            onPick={() => pickLogoFor("logoBase64")}
            onClear={() => clearLogo("logoBase64")}
          />
          <LogoSlot
            label="Right logo"
            slot="logoBase64Right"
            uri={draft.logoBase64Right}
            onPick={() => pickLogoFor("logoBase64Right")}
            onClear={() => clearLogo("logoBase64Right")}
          />
        </View>
        <Text style={styles.hint}>
          Both logos appear on each side of the title in the PDF header. The left logo is also used
          on the app login screen. If you upload only one, it is used on both sides.
        </Text>

        <Text style={[styles.label, { marginTop: spacing.md }]}>PDF sub-heading — each line independently editable</Text>
        <Text style={styles.hint}>Each line has its own text, size, font and bold setting. The old PDF properties remain in the same Branding setup.</Text>
        {[0,1,2,3].map((index) => {
          const defaults = [0,1,2,3].map(() => ({text:"",size:12,font:"regular" as const,bold:false}));
          const line = (draft.pdfSubtitleLines || defaults)[index] || defaults[index];
          const updateLine = (patch: Partial<typeof line>) => setDraft(d => {
            const lines = [...(d.pdfSubtitleLines || defaults)];
            lines[index] = { ...lines[index], ...patch };
            return { ...d, pdfSubtitleLines: lines };
          });
          return <View key={index} style={styles.subtitleLineCard}>
            <Text style={styles.subtitleLineLabel}>Line {index + 1}</Text>
            <TextInput value={line.text} onChangeText={text=>updateLine({text})} placeholder={"Sub-header line "+(index+1)} placeholderTextColor={colors.muted} style={styles.input}/>
            <View style={styles.styleRow}>{(["regular","medium","semibold","bold"] as const).map(v=><Pressable key={v} onPress={()=>updateLine({font:v})} style={[styles.styleChip,{backgroundColor:line.font===v?colors.brandPrimary:colors.surfaceSecondary}]}><Text style={[styles.styleChipText,{color:line.font===v?colors.onBrandPrimary:colors.onSurface}]}>{v}</Text></Pressable>)}<Pressable onPress={()=>updateLine({bold:!line.bold})} style={[styles.styleChip,{backgroundColor:line.bold?colors.brandPrimary:colors.surfaceSecondary}]}><Text style={[styles.styleChipText,{fontFamily:fontFamily.bold,color:line.bold?colors.onBrandPrimary:colors.onSurface}]}>Bold</Text></Pressable></View>
            <View style={styles.sizeRow}><Text style={styles.colorLabel}>Line size</Text><View style={styles.sizeControls}><Pressable style={styles.sizeButton} onPress={()=>updateLine({size:Math.max(8,Number(line.size||12)-1)})}><Ionicons name="remove" size={18} color={colors.onSurface}/></Pressable><TextInput keyboardType="number-pad" value={String(line.size||12)} onChangeText={v=>updateLine({size:Math.max(8,Math.min(48,Number(v.replace(/[^0-9]/g,""))||12))})} style={styles.smallSizeInput}/><Pressable style={styles.sizeButton} onPress={()=>updateLine({size:Math.min(48,Number(line.size||12)+1)})}><Ionicons name="add" size={18} color={colors.onSurface}/></Pressable></View></View>
          </View>;
        })}
        <Text style={[styles.label, { marginTop: spacing.md }]}>Second procedure field name</Text>
        <Text style={styles.hint}>Change the label shown above the second independent procedure search field. Its value is saved separately from the first procedure.</Text>
        <TextInput value={draft.procedureSecondLabel ?? "Procedure 2"} onChangeText={v=>setDraft(d=>({...d,procedureSecondLabel:v}))} placeholder="Procedure 2" placeholderTextColor={colors.muted} style={styles.input}/>
        <Text style={[styles.label, { marginTop: spacing.md }]}>Patient Add/Edit Form — field order</Text>
        <Text style={styles.hint}>Use the arrows to arrange built-in fields and every custom field created by the administrator. New custom fields appear here automatically. This changes the entry form layout only, not saved patient data.</Text>
        {(() => {
          const builtIn = ["mrNo","name","gender","age","address","diagnosis","procedure","procedureII","fileName","date"];
          const labels:Record<string,string> = {mrNo:"MR No",name:"Patient Name",gender:"Gender",age:"Age",address:"Address",diagnosis:"Diagnosis",procedure:"Procedure",procedureII:draft.procedureSecondLabel?.trim() || "Procedure 2",fileName:"File / Reference",date:"Date"};
          const customKeys = customFields.filter((f:any)=>f?.key && f?.label).map((f:any)=>String(f.key));
          const allowed = [...builtIn,...customKeys.filter((k:string)=>!builtIn.includes(k))];
          const current = Array.isArray(draft.patientFormFieldOrder) ? draft.patientFormFieldOrder.filter((k:string)=>allowed.includes(k)) : [];
          const order = [...current];
          allowed.forEach(k=>{if(!order.includes(k))order.push(k)});
          customFields.forEach((f:any)=>{if(f?.key && f?.label) labels[String(f.key)] = String(f.label)});
          const move=(key:string,delta:number)=>setDraft(d=>{
            const saved = Array.isArray(d.patientFormFieldOrder) ? d.patientFormFieldOrder.filter((k:string)=>allowed.includes(k)) : [];
            allowed.forEach(k=>{if(!saved.includes(k))saved.push(k)});
            const i=saved.indexOf(key), j=i+delta;
            if(j<0||j>=saved.length)return d;
            [saved[i],saved[j]]=[saved[j],saved[i]];
            return {...d,patientFormFieldOrder:saved};
          });
          return order.map((key,i)=><View key={"form-order-"+key} style={{flexDirection:"row",alignItems:"center",gap:spacing.sm,marginBottom:spacing.xs}}>
            <View style={{flex:1,padding:spacing.sm,borderWidth:1,borderColor:colors.border,borderRadius:radius.sm,backgroundColor:colors.surfaceSecondary}}><Text style={styles.fieldToggleText}>{i+1}. {labels[key] || key}</Text></View>
            <Pressable accessibilityLabel={"Move "+(labels[key]||key)+" up"} disabled={i===0} style={[styles.sizeButton,{opacity:i===0?0.35:1}]} onPress={()=>move(key,-1)}><Ionicons name="chevron-up" size={18} color={colors.onSurface}/></Pressable>
            <Pressable accessibilityLabel={"Move "+(labels[key]||key)+" down"} disabled={i===order.length-1} style={[styles.sizeButton,{opacity:i===order.length-1?0.35:1}]} onPress={()=>move(key,1)}><Ionicons name="chevron-down" size={18} color={colors.onSurface}/></Pressable>
          </View>);
        })()}
        <Text style={[styles.label, { marginTop: spacing.md }]}>Patient fields in PDF</Text>
        <Text style={styles.hint}>Every available patient section is listed here. Check marks decide exactly which sections the admin wants in the Patient PDF. Custom fields created in Patient Fields also appear here.</Text>
        {patientPdfOptions.map(([key,label]) => {
          const current = [...(draft.pdfPatientFields||defaultBranding.pdfPatientFields||[])];
          const active=current.includes(key);
          const move=(delta:number)=>setDraft(d=>{
            const order=[...(d.pdfPatientFields||defaultBranding.pdfPatientFields||[])];
            const i=order.indexOf(String(key)), j=i+delta;
            if(i<0||j<0||j>=order.length)return d;
            [order[i],order[j]]=[order[j],order[i]];
            return {...d,pdfPatientFields:order};
          });
          return <View key={key} style={{flexDirection:"row",alignItems:"center",gap:spacing.xs}}>
            <Pressable onPress={()=>setDraft(d=>{
              const fields=d.pdfPatientFields||defaultBranding.pdfPatientFields||[];
              const next=active?fields.filter(x=>x!==key):[...fields,key];
              const levels=(d.pdfHeadingLevels||defaultBranding.pdfHeadingLevels||[]).map((g:any)=>({...g,fields:(g.fields||[]).filter((x:string)=>next.includes(x))}));
              return {...d,pdfPatientFields:next,pdfHeadingLevels:levels};
            })} style={[styles.fieldToggle,{flex:1}]}>
              <Ionicons name={active?"checkbox":"square-outline"} size={21} color={active?colors.brandPrimary:colors.muted}/>
              <Text style={styles.fieldToggleText}>{active?(current.indexOf(key)+1)+". ":""}{label}</Text>
            </Pressable>
            {active?<>
              <Pressable accessibilityLabel={"Move "+label+" up in PDF"} disabled={current.indexOf(key)===0} style={[styles.sizeButton,{opacity:current.indexOf(key)===0?0.35:1}]} onPress={()=>move(-1)}><Ionicons name="chevron-up" size={18} color={colors.onSurface}/></Pressable>
              <Pressable accessibilityLabel={"Move "+label+" down in PDF"} disabled={current.indexOf(key)===current.length-1} style={[styles.sizeButton,{opacity:current.indexOf(key)===current.length-1?0.35:1}]} onPress={()=>move(1)}><Ionicons name="chevron-down" size={18} color={colors.onSurface}/></Pressable>
            </>:<View style={{width:76}}/>}
          </View>;
        })}
        {(() => {
          type HeadingMap = { heading:string[]; subHeading:string[] };
          const savedMap = (draft.pdfHeadingMap && typeof draft.pdfHeadingMap === "object") ? draft.pdfHeadingMap : {};
          const legacyGroups = Array.isArray(draft.pdfHeadingLevels) ? draft.pdfHeadingLevels : [];
          const legacySub = legacyGroups.filter((g:any)=>["Sub-heading","Sub-heading 1"].includes(String(g?.label||""))).flatMap((g:any)=>Array.isArray(g?.fields)?g.fields.map(String):[]);
          const legacySubSub = legacyGroups.filter((g:any)=>["Sub-sub-heading","Sub-sub-heading 1"].includes(String(g?.label||""))).flatMap((g:any)=>Array.isArray(g?.fields)?g.fields.map(String):[]);
          const getMap = (mainKey:string):HeadingMap => {
            const raw:any = (savedMap as any)[mainKey];
            if(raw && typeof raw === "object") return { heading:Array.isArray(raw.heading)?raw.heading.map(String):[], subHeading:Array.isArray(raw.subHeading)?raw.subHeading.map(String):[] };
            return { heading:[...legacySub], subHeading:[...legacySubSub] };
          };
          const toggle = (mainKey:string, level:"heading"|"subHeading", fieldKey:string) => {
            setDraft(d => {
              const current:any = (d.pdfHeadingMap && typeof d.pdfHeadingMap === "object") ? d.pdfHeadingMap : {};
              const raw:any = current[mainKey] || { heading:[], subHeading:[] };
              const next:HeadingMap = { heading:Array.isArray(raw.heading)?[...raw.heading.map(String)]:[], subHeading:Array.isArray(raw.subHeading)?[...raw.subHeading.map(String)]:[] };
              const target = next[level];
              const i=target.indexOf(fieldKey);
              if(i>=0) target.splice(i,1); else target.push(fieldKey);
              const enabled=Array.isArray(d.pdfPatientFields)?[...d.pdfPatientFields]:[...(defaultBranding.pdfPatientFields||[])];
              if(!enabled.includes(fieldKey)) enabled.push(fieldKey);
              return {...d,pdfPatientFields:enabled,pdfHeadingMap:{...current,[mainKey]:next}};
            });
          };
          const fieldRow = (id:string,label:string,checked:boolean,onPress:()=>void) => (
            <Pressable key={id} onPress={onPress} style={styles.headingEntry}>
              <Ionicons name={checked?"checkbox":"square-outline"} size={19} color={checked?colors.brandPrimary:colors.muted}/>
              <Text style={styles.headingEntryText}>{label}</Text>
            </Pressable>
          );
          return <View>
            <Text style={[styles.label,{marginTop:spacing.md}]}>Patient PDF heading structure — per main entry</Text>
            <Text style={styles.hint}>Every main entry has its own Heading and Sub-heading boxes. Each box contains the complete list of all patient fields and custom fields. These choices are independent for every main entry.</Text>
            {patientPdfOptions.map(([mainKey,mainLabel]) => {
              const cfg=getMap(String(mainKey));
              return <View key={"main-"+String(mainKey)} style={styles.patientPdfEntryBox}>
                <Text style={styles.mainEntryTitle}>Main entry: {String(mainLabel)}</Text>
                <View style={styles.headingChoiceRow}>
                  <View style={styles.headingChoiceBox}>
                    <Text style={styles.headingBoxTitle}>Heading</Text>
                    <Text style={styles.headingBoxHint}>Choose any fields to appear under this main entry.</Text>
                    <View style={styles.headingEntryGrid}>
                      {patientPdfOptions.map(([key,label])=>fieldRow("h-"+mainKey+"-"+key,String(label),cfg.heading.includes(String(key)),()=>toggle(String(mainKey),"heading",String(key))))}
                    </View>
                  </View>
                  <View style={styles.headingChoiceBox}>
                    <Text style={styles.headingBoxTitle}>Sub-heading</Text>
                    <Text style={styles.headingBoxHint}>Choose any fields to appear under this main entry’s heading.</Text>
                    <View style={styles.headingEntryGrid}>
                      {patientPdfOptions.map(([key,label])=>fieldRow("s-"+mainKey+"-"+key,String(label),cfg.subHeading.includes(String(key)),()=>toggle(String(mainKey),"subHeading",String(key))))}
                    </View>
                  </View>
                </View>
              </View>;
            })}
          </View>;
        })()}
        <Text style={[styles.label, { marginTop: spacing.md }]}>Patient List PDF settings</Text>
        <Text style={styles.hint}>Patients per page applies only to the Patient List PDF. It does not affect the separate Patient PDF.</Text>
        <Text style={styles.colorLabel}>Patients per page</Text>
        <View style={styles.sizeControls}>
          <Pressable style={styles.sizeButton} onPress={()=>setDraft(d=>({...d,pdfPatientsPerPage:Math.max(1,Number(d.pdfPatientsPerPage||20)-1)}))}><Ionicons name="remove" size={18} color={colors.onSurface}/></Pressable>
          <TextInput keyboardType="number-pad" value={String(draft.pdfPatientsPerPage||20)} onChangeText={v=>setDraft(d=>({...d,pdfPatientsPerPage:Math.max(1,Math.min(200,Number(v.replace(/[^0-9]/g,""))||1))}))} style={styles.smallSizeInput}/>
          <Pressable style={styles.sizeButton} onPress={()=>setDraft(d=>({...d,pdfPatientsPerPage:Math.min(200,Number(d.pdfPatientsPerPage||20)+1)}))}><Ionicons name="add" size={18} color={colors.onSurface}/></Pressable>
        </View>
        <Text style={styles.hint}>The selected number is kept as a complete page chunk in the Patient List PDF.</Text>
        <Text style={styles.colorLabel}>Main Entry — text size</Text>
        <View style={styles.styleRow}>{(["small","medium","large"] as const).map(v=><Pressable key={v} onPress={()=>setDraft(d=>({...d,pdfMainEntryTextSize:v}))} style={[styles.styleChip,{backgroundColor:draft.pdfMainEntryTextSize===v?colors.brandPrimary:colors.surfaceSecondary}]}><Text style={[styles.styleChipText,{color:draft.pdfMainEntryTextSize===v?colors.onBrandPrimary:colors.onSurface}]}>{v}</Text></Pressable>)}</View>
        <Text style={styles.colorLabel}>Main Entry — font weight</Text>
        <View style={styles.styleRow}>{(["normal","medium","semibold","bold"] as const).map(v=><Pressable key={v} onPress={()=>setDraft(d=>({...d,pdfMainEntryTextWeight:v}))} style={[styles.styleChip,{backgroundColor:draft.pdfMainEntryTextWeight===v?colors.brandPrimary:colors.surfaceSecondary}]}><Text style={[styles.styleChipText,{color:draft.pdfMainEntryTextWeight===v?colors.onBrandPrimary:colors.onSurface}]}>{v}</Text></Pressable>)}</View>
        <Text style={styles.colorLabel}>Main Entry — darkness</Text>
        <View style={styles.styleRow}>{(["light","normal","dark"] as const).map(v=><Pressable key={v} onPress={()=>setDraft(d=>({...d,pdfMainEntryTextTone:v}))} style={[styles.styleChip,{backgroundColor:draft.pdfMainEntryTextTone===v?colors.brandPrimary:colors.surfaceSecondary}]}><Text style={[styles.styleChipText,{color:activeToneColor(v)}]}>{v}</Text></Pressable>)}</View>
        <Text style={styles.colorLabel}>Heading — text size</Text>
        <View style={styles.styleRow}>{(["small","medium","large"] as const).map(v=><Pressable key={v} onPress={()=>setDraft(d=>({...d,pdfHeadingTextSize:v}))} style={[styles.styleChip,{backgroundColor:draft.pdfHeadingTextSize===v?colors.brandPrimary:colors.surfaceSecondary}]}><Text style={[styles.styleChipText,{color:draft.pdfHeadingTextSize===v?colors.onBrandPrimary:colors.onSurface}]}>{v}</Text></Pressable>)}</View>
        <Text style={styles.colorLabel}>Heading — font weight</Text>
        <View style={styles.styleRow}>{(["normal","medium","semibold","bold"] as const).map(v=><Pressable key={v} onPress={()=>setDraft(d=>({...d,pdfHeadingTextWeight:v}))} style={[styles.styleChip,{backgroundColor:draft.pdfHeadingTextWeight===v?colors.brandPrimary:colors.surfaceSecondary}]}><Text style={[styles.styleChipText,{color:draft.pdfHeadingTextWeight===v?colors.onBrandPrimary:colors.onSurface}]}>{v}</Text></Pressable>)}</View>
        <Text style={styles.colorLabel}>Heading — darkness</Text>
        <View style={styles.styleRow}>{(["light","normal","dark"] as const).map(v=><Pressable key={v} onPress={()=>setDraft(d=>({...d,pdfHeadingTextTone:v}))} style={[styles.styleChip,{backgroundColor:draft.pdfHeadingTextTone===v?colors.brandPrimary:colors.surfaceSecondary}]}><Text style={[styles.styleChipText,{color:activeToneColor(v)}]}>{v}</Text></Pressable>)}</View>
        <Text style={styles.colorLabel}>Sub-heading — text size</Text>
        <View style={styles.styleRow}>{(["small","medium","large"] as const).map(v=><Pressable key={v} onPress={()=>setDraft(d=>({...d,pdfSubHeadingTextSize:v}))} style={[styles.styleChip,{backgroundColor:draft.pdfSubHeadingTextSize===v?colors.brandPrimary:colors.surfaceSecondary}]}><Text style={[styles.styleChipText,{color:draft.pdfSubHeadingTextSize===v?colors.onBrandPrimary:colors.onSurface}]}>{v}</Text></Pressable>)}</View>
        <Text style={styles.colorLabel}>Sub-heading — font weight</Text>
        <View style={styles.styleRow}>{(["normal","medium","semibold","bold"] as const).map(v=><Pressable key={v} onPress={()=>setDraft(d=>({...d,pdfSubHeadingTextWeight:v}))} style={[styles.styleChip,{backgroundColor:draft.pdfSubHeadingTextWeight===v?colors.brandPrimary:colors.surfaceSecondary}]}><Text style={[styles.styleChipText,{color:draft.pdfSubHeadingTextWeight===v?colors.onBrandPrimary:colors.onSurface}]}>{v}</Text></Pressable>)}</View>
        <Text style={styles.colorLabel}>Sub-heading — darkness</Text>
        <View style={styles.styleRow}>{(["light","normal","dark"] as const).map(v=><Pressable key={v} onPress={()=>setDraft(d=>({...d,pdfSubHeadingTextTone:v}))} style={[styles.styleChip,{backgroundColor:draft.pdfSubHeadingTextTone===v?colors.brandPrimary:colors.surfaceSecondary}]}><Text style={[styles.styleChipText,{color:activeToneColor(v)}]}>{v}</Text></Pressable>)}</View>
        <Text style={[styles.section, { marginTop: spacing.xl }]}>Colour Presets</Text>
        <View style={styles.presets}>
          {BRANDING_PRESETS.map((p) => (
            <Pressable
              key={p.name}
              testID={`preset-${p.name}`}
              style={styles.preset}
              onPress={() => applyPreset(p.palette)}
            >
              <View style={styles.presetSwatches}>
                <View style={[styles.pSwatch, { backgroundColor: p.palette.primary }]} />
                <View style={[styles.pSwatch, { backgroundColor: p.palette.secondary }]} />
                <View style={[styles.pSwatch, { backgroundColor: p.palette.tertiary }]} />
              </View>
              <Text style={styles.presetName}>{p.name}</Text>
            </Pressable>
          ))}
        </View>

        <Text style={[styles.section, { marginTop: spacing.xl }]}>Custom Colours</Text>

        {COLOR_FIELDS.map((f) => (
          <View key={f.key} style={styles.colorRow}>
            <View style={[styles.colorSwatch, { backgroundColor: String(draft[f.key]) }]} />
            <View style={{ flex: 1 }}>
              <Text style={styles.colorLabel}>{f.label}</Text>
              <Text style={styles.colorDesc}>{f.desc}</Text>
              <TextInput
                testID={`branding-color-${f.key}`}
                value={String(draft[f.key])}
                onChangeText={set(f.key)}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="#4A6B5D"
                placeholderTextColor={colors.muted}
                style={[
                  styles.colorInput,
                  !isHex(String(draft[f.key])) && { borderColor: colors.error },
                ]}
              />
            </View>
          </View>
        ))}
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}>
        <PrimaryButton title="Save Branding" onPress={onSave} loading={saving} testID="branding-save" />
      </View>
    </View>
  );
}

function LogoSlot({
  label,
  slot,
  uri,
  onPick,
  onClear,
}: {
  label: string;
  slot: "logoBase64" | "logoBase64Right";
  uri: string;
  onPick: () => void;
  onClear: () => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <View style={styles.logoSlot} testID={`logo-slot-${slot}`}>
      <Text style={styles.slotLabel}>{label}</Text>
      <Pressable
        onPress={onPick}
        style={styles.logoPreview}
        testID={`pick-logo-${slot}`}
      >
        {uri ? (
          <Image source={{ uri }} style={styles.logoImg} contentFit="cover" />
        ) : (
          <Ionicons name="add" size={26} color={colors.muted} />
        )}
      </Pressable>
      <View style={{ flexDirection: "row", gap: spacing.xs }}>
        <Pressable onPress={onPick} style={styles.slotBtn} testID={`upload-logo-${slot}`}>
          <Ionicons name="cloud-upload-outline" size={14} color={colors.onSurface} />
          <Text style={styles.slotBtnText}>{uri ? "Change" : "Upload"}</Text>
        </Pressable>
        {uri ? (
          <Pressable onPress={onClear} style={styles.slotBtn} testID={`clear-logo-${slot}`}>
            <Ionicons name="trash-outline" size={14} color={colors.error} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}


const useStyles = makeStyles((colors) => ({
  container: { flex: 1, backgroundColor: colors.surface },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  headerTitle: { fontFamily: fontFamily.bold, fontSize: fontSize.lg, color: colors.onSurface },
  section: {
    fontFamily: fontFamily.bold,
    fontSize: fontSize.sm,
    color: colors.brandPrimary,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: spacing.md,
  },
  label: { fontFamily: fontFamily.semibold, fontSize: fontSize.sm, color: colors.onSurfaceSecondary, marginBottom: spacing.xs },
  input: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    fontFamily: fontFamily.regular,
    fontSize: fontSize.lg,
    color: colors.onSurface,
    minHeight: 50,
    marginBottom: spacing.lg,
  },
  multilineInput: {
    minHeight: 96,
    textAlignVertical: "top",
    fontSize: fontSize.base,
    lineHeight: 20,
  },
  styleRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, alignItems: "center", marginBottom: spacing.sm },
  styleChip: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border },
  styleChipText: { fontFamily: fontFamily.medium, fontSize: fontSize.sm },
  sizeRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.md },
  fieldToggle:{flexDirection:"row",alignItems:"center",gap:spacing.sm,paddingVertical:spacing.sm},
  fieldToggleText:{fontFamily:fontFamily.medium,fontSize:fontSize.base,color:colors.onSurface},
  subtitleLineCard:{padding:spacing.md,borderWidth:1,borderColor:colors.border,borderRadius:radius.md,backgroundColor:colors.surfaceSecondary,marginTop:spacing.sm},
  patientPdfEntryBox:{padding:spacing.md,borderWidth:1,borderColor:colors.borderStrong,borderRadius:radius.md,backgroundColor:colors.surfaceSecondary,marginTop:spacing.sm},
  headingChoiceRow:{flexDirection:"row",gap:spacing.sm},
  headingChoiceBox:{flex:1,padding:spacing.sm,borderWidth:1,borderColor:colors.border,borderRadius:radius.sm,backgroundColor:colors.surface},
  headingChoiceTitle:{fontFamily:fontFamily.bold,fontSize:fontSize.xs,color:colors.onSurface,marginBottom:spacing.xs},
  headingChoiceOption:{flexDirection:"row",alignItems:"center",gap:spacing.xs,paddingVertical:6,paddingHorizontal:4,borderRadius:radius.sm},
  headingChoiceOptionActive:{backgroundColor:colors.brandTertiary},
  headingChoiceText:{fontFamily:fontFamily.medium,fontSize:fontSize.sm,color:colors.onSurface},
  headingEntryText:{fontFamily:fontFamily.medium,fontSize:fontSize.base,color:colors.onSurface},
  mainEntryTitle:{fontFamily:fontFamily.bold,fontSize:fontSize.lg,color:colors.brandPrimary,marginBottom:spacing.sm},
  headingBoxTitle:{fontFamily:fontFamily.bold,fontSize:fontSize.base,color:colors.onSurface,marginBottom:spacing.xs},
  headingBoxHint:{fontFamily:fontFamily.regular,fontSize:fontSize.xs,color:colors.muted,marginBottom:spacing.sm},
  headingEntryGrid:{flexDirection:"row",flexWrap:"wrap",gap:spacing.sm},
  headingEntry:{flexDirection:"row",alignItems:"center",gap:spacing.xs,paddingHorizontal:spacing.xs,paddingVertical:spacing.xs},
  subtitleLineLabel:{fontFamily:fontFamily.semibold,fontSize:fontSize.sm,color:colors.onSurface,marginBottom:spacing.xs},
  sizeControls: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  sizeButton: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSecondary, alignItems: "center", justifyContent: "center" },
  smallSizeInput: { width: 72, textAlign: "center", backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingVertical: spacing.sm, color: colors.onSurface, fontFamily: fontFamily.medium },
  twinLogos: { flexDirection: "row", gap: spacing.md, marginBottom: spacing.sm },
  layoutRow: { flexDirection: "row", gap: spacing.sm, marginBottom: spacing.sm },
  layoutOption: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  logoSlot: {
    flex: 1,
    alignItems: "center",
    gap: spacing.xs,
    padding: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSecondary,
  },
  slotLabel: { fontFamily: fontFamily.semibold, fontSize: fontSize.xs, color: colors.muted, textTransform: "uppercase", letterSpacing: 0.6 },
  slotBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  toggleRow:{flexDirection:"row",alignItems:"center",gap:spacing.md,padding:spacing.md,borderRadius:radius.md,borderWidth:1,borderColor:colors.border,marginBottom:spacing.md},
  slotBtnText: { fontFamily: fontFamily.semibold, fontSize: fontSize.xs, color: colors.onSurface },
  logoRow: { flexDirection: "row", gap: spacing.md, alignItems: "flex-start", marginBottom: spacing.sm },
  logoPreview: {
    width: 88,
    height: 88,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSecondary,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  logoImg: { width: "100%", height: "100%" },
  actionBtn: {
    flexDirection: "row",
    gap: spacing.sm,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSecondary,
  },
  actionBtnGhost: {
    flexDirection: "row",
    gap: spacing.sm,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 40,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
  },
  actionText: { fontFamily: fontFamily.semibold, color: colors.onSurface },
  hint: { fontFamily: fontFamily.regular, fontSize: fontSize.sm, color: colors.muted, marginTop: spacing.xs, marginBottom: spacing.md },
  presets: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  preset: {
    width: "48%",
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSecondary,
  },
  presetSwatches: { flexDirection: "row", gap: spacing.xs, marginBottom: spacing.xs },
  pSwatch: { width: 22, height: 22, borderRadius: 11, borderWidth: 1, borderColor: colors.border },
  presetName: { fontFamily: fontFamily.semibold, fontSize: fontSize.sm, color: colors.onSurface },
  colorRow: {
    flexDirection: "row",
    gap: spacing.md,
    alignItems: "flex-start",
    marginBottom: spacing.md,
  },
  colorSwatch: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: colors.border,
    marginTop: 22,
  },
  colorLabel: { fontFamily: fontFamily.semibold, fontSize: fontSize.base, color: colors.onSurface },
  colorDesc: { fontFamily: fontFamily.regular, fontSize: fontSize.xs, color: colors.muted, marginBottom: 6 },
  colorInput: {
    fontFamily: fontFamily.monoMedium,
    fontSize: fontSize.base,
    color: colors.onSurface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 40,
    backgroundColor: colors.surfaceSecondary,
  },
  footer: {
    padding: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.sm },
  blockedTitle: { fontFamily: fontFamily.bold, fontSize: fontSize.lg, color: colors.onSurface, marginTop: spacing.sm },
}));
