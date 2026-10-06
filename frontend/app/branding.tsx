import { router } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import * as FileSystem from "expo-file-system";
import { Image } from "expo-image";
import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import Ionicons from "@react-native-vector-icons/ionicons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAuth } from "@/src/auth/AuthContext";
import { PrimaryButton } from "@/src/components/PrimaryButton";
import { useToast } from "@/src/components/toast";
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
      toast("Branding updated.", "success");
      router.back();
    } finally {
      setSaving(false);
    }
  };

  const onReset = async () => {
    await resetBranding();
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
        <Text style={[styles.label, { marginTop: spacing.md }]}>Patient fields in PDF</Text>
        <Text style={styles.hint}>Select only the patient fields you want in the original compact PDF. The layout remains the same.</Text>
        {[
          ["date","Date"],["mrNo","MR No"],["name","Patient Name"],["gender","Gender"],["age","Age"],["address","Address"],["diagnosis","Diagnosis"],["procedure","Procedure"],["fileName","File Name"]
        ].map(([key,label]) => {
          const active=(draft.pdfPatientFields||defaultBranding.pdfPatientFields||[]).includes(key);
          return <Pressable key={key} onPress={()=>setDraft(d=>({...d,pdfPatientFields:active?(d.pdfPatientFields||[]).filter(x=>x!==key):[...(d.pdfPatientFields||defaultBranding.pdfPatientFields||[]),key]}))} style={styles.fieldToggle}>
            <Ionicons name={active?"checkbox":"square-outline"} size={21} color={active?colors.brandPrimary:colors.muted}/>
            <Text style={styles.fieldToggleText}>{label}</Text>
          </Pressable>;
        })}
        <Text style={[styles.label, { marginTop: spacing.md }]}>PDF field heading setup</Text>
        <Text style={styles.hint}>Every PDF field is shown separately. For each field choose Normal, Main Heading, Sub-heading 1, or Sub-heading 2. You can put multiple fields in either sub-heading level. Implants is a separate selectable field.</Text>
        {[
          ["date","Date"],["mrNo","MR No"],["name","Patient Name"],["gender","Gender"],["age","Age"],["address","Address"],["diagnosis","Diagnosis"],["procedure","Procedure"],["fileName","File Name"]
        ].map(([key,label])=>{
          const defaults=defaultBranding.pdfHeadingLevels||[];
          const groups=Array.isArray(draft.pdfHeadingLevels)&&draft.pdfHeadingLevels.length?draft.pdfHeadingLevels:defaults;
          const current=groups.findIndex((g:any)=>Array.isArray(g?.fields)&&g.fields.includes(key));
          const setLevel=(level:number)=>{
            setDraft(d=>{
              const base=Array.from({length:3},(_,i)=>({...(d.pdfHeadingLevels?.[i]||defaults[i]||{}),fields:[...((d.pdfHeadingLevels?.[i]?.fields||defaults[i]?.fields||[]))]}));
              base.forEach((g:any)=>{g.fields=g.fields.filter((x:string)=>x!==key);});
              if(level>0) base[level-1].fields.push(key);
              base[0].label="Main Heading"; base[1].label="Sub-heading 1"; base[2].label="Sub-heading 2";
              return {...d,pdfHeadingLevels:base};
            });
          };
          return <View key={key} style={styles.subtitleLineCard}>
            <Text style={styles.subtitleLineLabel}>{label}</Text>
            <View style={styles.styleRow}>
              {[["Normal",0],["Main Heading",1],["Sub-heading 1",2],["Sub-heading 2",3]].map(([txt,level])=>{
                const active=(current===Number(level)-1) || (Number(level)===0&&current<0);
                return <Pressable key={String(level)} onPress={()=>setLevel(Number(level))} style={[styles.styleChip,{backgroundColor:active?colors.brandPrimary:colors.surfaceSecondary}]}>
                  <Text style={[styles.styleChipText,{color:active?colors.onBrandPrimary:colors.onSurface}]}>{txt}</Text>
                </Pressable>;
              })}
            </View>
          </View>;
        })}
        <Text style={[styles.label, { marginTop: spacing.md }]}>Implant PDF headings</Text>
        <Text style={styles.hint}>Implants are no longer included inside the patient/procedure PDF. They have their own separate PDF. Edit both headings here.</Text>
        <Text style={styles.colorLabel}>Implant heading</Text>
        <TextInput value={String(draft.pdfImplantHeading || "Implants")} onChangeText={v=>setDraft(d=>({...d,pdfImplantHeading:v}))} placeholder="Implants" placeholderTextColor={colors.muted} style={styles.input} />
        <Text style={styles.colorLabel}>Implant sub-heading</Text>
        <TextInput value={String(draft.pdfImplantSubheading || "Used Implants")} onChangeText={v=>setDraft(d=>({...d,pdfImplantSubheading:v}))} placeholder="Used Implants" placeholderTextColor={colors.muted} style={styles.input} />
        <Text style={styles.colorLabel}>Implant sub-heading colour</Text>
        <TextInput value={String(draft.pdfImplantSubheadingColor||"#8A9690")} onChangeText={v=>setDraft(d=>({...d,pdfImplantSubheadingColor:v}))} placeholder="#8A9690" placeholderTextColor={colors.muted} style={styles.input} />
        <Text style={[styles.label, { marginTop: spacing.md }]}>Patient list layout</Text>
        <Text style={styles.hint}>Control how many patients fit on each PDF list page and how the list text looks. The selected settings apply to the existing PDF design.</Text>
        <Text style={styles.colorLabel}>Patients per page</Text>
        <View style={styles.sizeControls}>
          <Pressable style={styles.sizeButton} onPress={()=>{const n=Math.max(1,Number(draft.pdfPatientsPerPage||20)-1);setDraft(d=>({...d,pdfPatientsPerPage:n}));}}><Ionicons name="remove" size={18} color={colors.onSurface}/></Pressable>
          <TextInput keyboardType="number-pad" value={String(draft.pdfPatientsPerPage||20)} onChangeText={v=>setDraft(d=>({...d,pdfPatientsPerPage:Math.max(1,Math.min(200,Number(v.replace(/[^0-9]/g,""))||1))}))} style={styles.smallSizeInput}/>
          <Pressable style={styles.sizeButton} onPress={()=>{const n=Math.min(200,Number(draft.pdfPatientsPerPage||20)+1);setDraft(d=>({...d,pdfPatientsPerPage:n}));}}><Ionicons name="add" size={18} color={colors.onSurface}/></Pressable>
        </View>
        <Text style={styles.hint}>Example: 20 or 25 patients per page.</Text>
        <Text style={styles.colorLabel}>List text size</Text>
        <View style={styles.styleRow}>{(["small","medium","large"] as const).map(v=><Pressable key={v} onPress={()=>setDraft(d=>({...d,pdfListTextSize:v}))} style={[styles.styleChip,{backgroundColor:draft.pdfListTextSize===v?colors.brandPrimary:colors.surfaceSecondary}]}><Text style={[styles.styleChipText,{color:draft.pdfListTextSize===v?colors.onBrandPrimary:colors.onSurface}]}>{v}</Text></Pressable>)}</View>
        <Text style={styles.colorLabel}>List text weight</Text>
        <View style={styles.styleRow}>{(["normal","bold"] as const).map(v=><Pressable key={v} onPress={()=>setDraft(d=>({...d,pdfListTextWeight:v}))} style={[styles.styleChip,{backgroundColor:draft.pdfListTextWeight===v?colors.brandPrimary:colors.surfaceSecondary}]}><Text style={[styles.styleChipText,{color:draft.pdfListTextWeight===v?colors.onBrandPrimary:colors.onSurface}]}>{v}</Text></Pressable>)}</View>
        <Text style={styles.colorLabel}>List text darkness</Text>
        <View style={styles.styleRow}>{(["light","normal","dark"] as const).map(v=><Pressable key={v} onPress={()=>setDraft(d=>({...d,pdfListTextTone:v}))} style={[styles.styleChip,{backgroundColor:draft.pdfListTextTone===v?colors.brandPrimary:colors.surfaceSecondary}]}><Text style={[styles.styleChipText,{color:activeToneColor(v)}]}>{v}</Text></Pressable>)}</View>
        <Text style={styles.colorLabel}>Row spacing</Text>
        <View style={styles.styleRow}>{(["compact","normal","spacious"] as const).map(v=><Pressable key={v} onPress={()=>setDraft(d=>({...d,pdfListRowSpacing:v}))} style={[styles.styleChip,{backgroundColor:draft.pdfListRowSpacing===v?colors.brandPrimary:colors.surfaceSecondary}]}><Text style={[styles.styleChipText,{color:draft.pdfListRowSpacing===v?colors.onBrandPrimary:colors.onSurface}]}>{v}</Text></Pressable>)}</View>
        <Text style={[styles.label, { marginTop: spacing.md }]}>PDF design</Text>
        <Text style={styles.hint}>These settings change the existing PDF design; they do not create a second PDF setup.</Text>
        <View style={styles.styleRow}>
          {(["portrait","landscape"] as const).map(v=><Pressable key={v} onPress={()=>setDraft(d=>({...d,pdfOrientation:v}))} style={[styles.styleChip,{backgroundColor:draft.pdfOrientation===v?colors.brandPrimary:colors.surfaceSecondary}]}><Text style={[styles.styleChipText,{color:draft.pdfOrientation===v?colors.onBrandPrimary:colors.onSurface}]}>{v}</Text></Pressable>)}
        </View>
<Text style={[styles.label, { marginTop: spacing.md }]}>PDF heading style</Text>
        <View style={styles.styleRow}>
          {(["regular","medium","semibold","bold"] as const).map(v => (
            <Pressable key={v} onPress={() => setDraft(d => ({...d, pdfTitleFont:v}))} style={[styles.styleChip,{backgroundColor:draft.pdfTitleFont===v?colors.brandPrimary:colors.surfaceSecondary}]}>
              <Text style={[styles.styleChipText,{color:draft.pdfTitleFont===v?colors.onBrandPrimary:colors.onSurface}]}>{v}</Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.sizeRow}>
          <Text style={styles.colorLabel}>Heading size</Text>
          <View style={styles.sizeControls}>
            <Pressable style={styles.sizeButton} onPress={() => { const n=Math.max(8, Number(draft.pdfTitleSize||24)-1); setDraft(d=>({...d,pdfTitleSize:n})); setTitleSizeText(String(n)); }}>
              <Ionicons name="remove" size={18} color={colors.onSurface} />
            </Pressable>
            <TextInput keyboardType="number-pad" value={titleSizeText} onChangeText={setTitleSizeText} onBlur={commitTitleSize} onSubmitEditing={commitTitleSize} returnKeyType="done" style={styles.smallSizeInput}/>
            <Pressable style={styles.sizeButton} onPress={() => { const n=Math.min(72, Number(draft.pdfTitleSize||24)+1); setDraft(d=>({...d,pdfTitleSize:n})); setTitleSizeText(String(n)); }}>
              <Ionicons name="add" size={18} color={colors.onSurface} />
            </Pressable>
          </View>
        </View>
        <Text style={styles.hint}>Heading and sub-heading styles affect the PDF header only.</Text>
        <Text style={[styles.section, { marginTop: spacing.xl }]}>PDF Layout & Design</Text>
        <Text style={styles.label}>Table header colour</Text>
        <TextInput value={String(draft.pdfTableHeaderColor)} onChangeText={v=>setDraft(d=>({...d,pdfTableHeaderColor:v}))} placeholder="#DCE5E1" placeholderTextColor={colors.muted} style={styles.input} />
        <Text style={styles.label}>Alternating row colour</Text>
        <TextInput value={String(draft.pdfTableStripeColor)} onChangeText={v=>setDraft(d=>({...d,pdfTableStripeColor:v}))} placeholder="#FAFAF7" placeholderTextColor={colors.muted} style={styles.input} />
        <Text style={styles.label}>PDF footer text</Text>
        <TextInput value={draft.pdfFooterText} onChangeText={v=>setDraft(d=>({...d,pdfFooterText:v}))} placeholder="Offline Report" placeholderTextColor={colors.muted} style={styles.input} />
        <Text style={styles.label}>Page size</Text>
        <View style={styles.styleRow}>{(["A4","Letter"] as const).map(v=><Pressable key={v} onPress={()=>setDraft(d=>({...d,pdfPageSize:v}))} style={[styles.styleChip,{backgroundColor:draft.pdfPageSize===v?colors.brandPrimary:colors.surfaceSecondary}]}><Text style={[styles.styleChipText,{color:draft.pdfPageSize===v?colors.onBrandPrimary:colors.onSurface}]}>{v}</Text></Pressable>)}</View>
        <Text style={styles.label}>Orientation</Text>
        <View style={styles.styleRow}>{(["portrait","landscape"] as const).map(v=><Pressable key={v} onPress={()=>setDraft(d=>({...d,pdfOrientation:v}))} style={[styles.styleChip,{backgroundColor:draft.pdfOrientation===v?colors.brandPrimary:colors.surfaceSecondary}]}><Text style={[styles.styleChipText,{color:draft.pdfOrientation===v?colors.onBrandPrimary:colors.onSurface}]}>{v}</Text></Pressable>)}</View>
        <Text style={styles.label}>Page margin (points)</Text>
        <View style={styles.sizeControls}><Pressable style={styles.sizeButton} onPress={()=>{const n=Math.max(12,Number(draft.pdfMargin||28)-2);setDraft(d=>({...d,pdfMargin:n}));setPdfMarginText(String(n));}}><Ionicons name="remove" size={18} color={colors.onSurface}/></Pressable><TextInput keyboardType="number-pad" value={pdfMarginText} onChangeText={setPdfMarginText} onBlur={()=>{const n=Math.max(12,Math.min(60,Math.round(Number(pdfMarginText)||28)));setPdfMarginText(String(n));setDraft(d=>({...d,pdfMargin:n}));}} style={styles.smallSizeInput}/><Pressable style={styles.sizeButton} onPress={()=>{const n=Math.min(60,Number(draft.pdfMargin||28)+2);setDraft(d=>({...d,pdfMargin:n}));setPdfMarginText(String(n));}}><Ionicons name="add" size={18} color={colors.onSurface}/></Pressable></View>
        <Pressable style={[styles.toggleRow,{backgroundColor:draft.pdfShowGeneratedAt?colors.brandTertiary:colors.surfaceSecondary}]} onPress={()=>setDraft(d=>({...d,pdfShowGeneratedAt:!d.pdfShowGeneratedAt}))}><View style={{flex:1}}><Text style={styles.colorLabel}>Show generated date/time</Text><Text style={styles.colorDesc}>Display report generation time in the PDF header</Text></View><Ionicons name={draft.pdfShowGeneratedAt?"checkmark-circle":"ellipse-outline"} size={24} color={draft.pdfShowGeneratedAt?colors.brandPrimary:colors.muted}/></Pressable>
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
