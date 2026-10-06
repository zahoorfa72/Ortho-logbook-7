import { useMemo, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import Ionicons from "@react-native-vector-icons/ionicons";

import { api } from "@/src/api/client";
import { PrimaryButton } from "@/src/components/PrimaryButton";
import { useToast } from "@/src/components/toast";
import { useAuth } from "@/src/auth/AuthContext";
import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";
import { buildPatientDetailHtml, generateAndSharePdf } from "@/src/utils/pdf";

type Patient = {
  id:string; mrNo:string; name:string; gender:string; age:string; diagnosis:string;
  procedure:string; implant:string; implantII:string; date:string; address:string;
  fileName:string; photos:string[]; operationCount?:number; totalOperations?:number;
  customData?:Record<string,string>; implants?:any[];
};

type Field = { key:string; label:string };

function occurrenceLabel(n:number) {
  const v=n%100;
  const suffix=v>=11&&v<=13 ? "th" : (n%10===1 ? "st" : n%10===2 ? "nd" : n%10===3 ? "rd" : "th");
  return n+suffix+" time";
}

const baseFields:Field[] = [
  {key:"date",label:"Date"}, {key:"mrNo",label:"MR No"}, {key:"name",label:"Patient Name"},
  {key:"gender",label:"Gender"}, {key:"age",label:"Age"}, {key:"address",label:"Address"},
  {key:"diagnosis",label:"Diagnosis"}, {key:"procedure",label:"Procedure"},
  {key:"implants",label:"Implants"}, {key:"fileName",label:"File Name"},
];

export default function PatientDetailPdfScreen() {
  const styles = useStyles();
  const { colors, branding } = useTheme();
  const { user } = useAuth();
  const toast = useToast();
  const [mode,setMode] = useState<"all"|"selected">("all");
  const [selectedIds,setSelectedIds] = useState<string[]>([]);
  const [photoMode,setPhotoMode] = useState<"none"|"first"|"all">("first");
  const [fields,setFields] = useState<Field[]>(baseFields);
  const [search,setSearch] = useState("");
  const [creating,setCreating] = useState(false);

  const {data:patients=[],isLoading} = useQuery<Patient[]>({queryKey:["patients-detail"],queryFn:()=>api.get("/patients-detail"),enabled:user?.role==="admin"});
  const {data:customFields=[]} = useQuery<any[]>({queryKey:["patient-custom-fields"],queryFn:()=>api.get("/patient-custom-fields"),enabled:user?.role==="admin"});

  const allFields = useMemo<Field[]>(()=>[
    ...baseFields,
    ...customFields.filter((f:any)=>f?.key && f?.label && !baseFields.some(x=>x.key===String(f.key)))
      .map((f:any)=>({key:String(f.key),label:String(f.label)}))
  ],[fields,customFields]);

  const toggleField=(key:string)=>{
    setFields(prev=>prev.some(x=>x.key===key) ? prev.filter(x=>x.key!==key) : [...prev,{key,label:allFields.find(x=>x.key===key)?.label||key}]);
  };
  const togglePatient=(id:string)=>setSelectedIds(prev=>prev.includes(id)?prev.filter(x=>x!==id):[...prev,id]);

  const filteredPatients=useMemo(()=>{
    const q=search.trim().toLowerCase();
    if(!q) return patients;
    return patients.filter(p=>[p.name,p.mrNo,p.date,p.fileName,p.gender,p.age,p.address,p.diagnosis,p.procedure,p.implant,p.implantII,...(p.implants||[]).flatMap((x:any)=>[x.category,x.name,x.size]),...Object.values(p.customData||{})].some(v=>String(v||"").toLowerCase().includes(q)));
  },[patients,search]);

  const selectedPatients=useMemo(
    ()=>mode==="all"?patients:patients.filter(p=>selectedIds.includes(p.id)),
    [mode,patients,selectedIds]
  );


  const create=async()=>{
    if(!fields.length){ toast("Select at least one patient detail field.","error"); return; }
    if(mode==="selected"&&!selectedIds.length){ toast("Select at least one patient.","error"); return; }
    if(!selectedPatients.length){ toast("No patients available.","info"); return; }
    setCreating(true);
    try {
      const html=await buildPatientDetailHtml(branding,selectedPatients,fields,photoMode);
      await generateAndSharePdf(html,"Patient Detail");
    } catch(e:any) {
      Alert.alert("PDF failed",e?.message||"Could not create Patient Detail PDF.");
    } finally { setCreating(false); }
  };

  if(user?.role!=="admin"){
    return <View style={styles.center}>
      <Ionicons name="lock-closed-outline" size={40} color={colors.muted}/>
      <Text style={styles.blockedTitle}>Administrator approval required</Text>
      <Text style={styles.helper}>Only the administrator can create Patient Detail PDFs.</Text>
      <PrimaryButton title="Back" onPress={()=>router.back()} variant="secondary"/>
    </View>;
  }

  if(isLoading) return <View style={styles.center}><ActivityIndicator size="large" color={colors.brandPrimary}/></View>;
  if(isError) return <View style={styles.center}>
    <Text style={styles.helper}>Could not load patient records.</Text>
    <PrimaryButton title="Back" onPress={()=>router.back()} variant="secondary"/>
  </View>;

  return <View style={styles.container}>
    <View style={[styles.header,{paddingTop:spacing.lg}]}>
      <Pressable onPress={()=>router.back()} style={styles.back}><Ionicons name="arrow-back" size={22} color={colors.onSurface}/></Pressable>
      <View style={{flex:1}}>
        <Text style={styles.title}>Patient Detail PDF</Text>
        <Text style={styles.subtitle}>Separate from the main Patient List PDF</Text>
      </View>
    </View>

    <ScrollView contentContainerStyle={{padding:spacing.lg,paddingBottom:spacing.xl*2}}>
      <Text style={styles.section}>Patients</Text>
      <View style={styles.segment}>
        {(["all","selected"] as const).map(x=><Pressable key={x} onPress={()=>setMode(x)} style={[styles.segmentBtn,mode===x&&styles.segmentActive]}>
          <Text style={[styles.segmentText,mode===x&&styles.segmentTextActive]}>{x==="all"?"All Patients":"Selected Patients"}</Text>
        </Pressable>)}
      </View>

      {mode==="selected" && <View style={styles.patientBox}>
        <TextInput
          testID="patient-detail-pdf-search"
          value={search}
          onChangeText={setSearch}
          placeholder="Search patient name, MR No, date or file name"
          placeholderTextColor={colors.muted}
          style={styles.searchInput}
          autoCorrect={false}
        />
        <View style={styles.rowBetween}>
          <Text style={styles.helper}>{selectedIds.length} selected · {filteredPatients.length} shown</Text>
          <Pressable onPress={()=>{
            const shownIds=filteredPatients.map(p=>p.id);
            const allShown=shownIds.length>0 && shownIds.every(id=>selectedIds.includes(id));
            setSelectedIds(prev=>allShown
              ? prev.filter(id=>!shownIds.includes(id))
              : [...new Set([...prev,...shownIds])]
            );
          }}>
            <Text style={styles.link}>
              {filteredPatients.length>0 && filteredPatients.every(p=>selectedIds.includes(p.id)) ? "Clear Shown" : "Select Shown"}
            </Text>
          </Pressable>
        </View>
        <FlatList
          data={filteredPatients}
          scrollEnabled={false}
          keyExtractor={p=>p.id}
          renderItem={({item})=><Pressable onPress={()=>togglePatient(item.id)} style={styles.patientRow}>
            <Ionicons name={selectedIds.includes(item.id)?"checkbox":"square-outline"} size={22} color={selectedIds.includes(item.id)?colors.brandPrimary:colors.muted}/>
            <View style={{flex:1,marginLeft:spacing.sm}}>
              <View style={styles.patientNameRow}>
                <Text style={styles.patientName}>{item.name||"Unnamed patient"}</Text>
                {item.totalOperations && item.totalOperations>1 ? <Text style={styles.occurrenceText}>{occurrenceLabel(item.operationCount||1)}</Text> : null}
              </View>
              <Text style={styles.patientMeta}>{item.mrNo||"—"} · {item.date||"—"}{item.fileName?" · "+item.fileName:""}</Text>
            </View>
          </Pressable>}
          ListEmptyComponent={<Text style={styles.helper}>No matching patients found.</Text>}
        />
      </View>}

      <Text style={styles.section}>Details to include</Text>
      <Text style={styles.helper}>Only checked details will appear. Each patient always gets one separate page.</Text>
      <View style={styles.fieldGrid}>
        {allFields.map(f=><Pressable key={f.key} onPress={()=>toggleField(f.key)} style={styles.fieldRow}>
          <Ionicons name={fields.some(x=>x.key===f.key)?"checkbox":"square-outline"} size={21} color={fields.some(x=>x.key===f.key)?colors.brandPrimary:colors.muted}/>
          <Text style={styles.fieldText}>{f.label}</Text>
        </Pressable>)}
      </View>

      <Text style={styles.section}>Patient pictures</Text>
      <View style={styles.photoChoices}>
        {([
          ["none","No picture"],["first","First picture only"],["all","All pictures"]
        ] as const).map(([value,label])=><Pressable key={value} onPress={()=>setPhotoMode(value)} style={[styles.photoBtn,photoMode===value&&styles.photoActive]}>
          <Text style={[styles.photoText,photoMode===value&&styles.photoTextActive]}>{label}</Text>
        </Pressable>)}
      </View>

      <View style={styles.summary}>
        <Text style={styles.summaryTitle}>PDF summary</Text>
        <Text style={styles.summaryText}>{selectedPatients.length} patient page{selectedPatients.length===1?"":"s"} · {fields.length} detail field{fields.length===1?"":"s"} · {photoMode==="first"?"First picture":photoMode==="all"?"All pictures":"No pictures"}</Text>
      </View>

      <PrimaryButton title="Create Patient Detail PDF" onPress={create} loading={creating} testID="create-patient-detail-pdf"/>
    </ScrollView>
  </View>;
}

const useStyles=makeStyles(colors=>({
  container:{flex:1,backgroundColor:colors.surfaceSecondary},
  center:{flex:1,alignItems:"center",justifyContent:"center",backgroundColor:colors.surfaceSecondary,padding:spacing.xl,gap:spacing.md},
  blockedTitle:{fontFamily:fontFamily.bold,fontSize:fontSize.lg,color:colors.onSurface,textAlign:"center"},
  header:{backgroundColor:colors.surface,paddingHorizontal:spacing.lg,paddingBottom:spacing.md,borderBottomWidth:1,borderBottomColor:colors.border,flexDirection:"row",alignItems:"center",gap:spacing.sm},
  back:{width:40,height:40,borderRadius:radius.md,backgroundColor:colors.surfaceSecondary,alignItems:"center",justifyContent:"center"},
  title:{fontFamily:fontFamily.bold,fontSize:fontSize.xl,color:colors.onSurface},
  subtitle:{fontFamily:fontFamily.regular,fontSize:fontSize.sm,color:colors.muted,marginTop:2},
  section:{fontFamily:fontFamily.bold,fontSize:fontSize.base,color:colors.onSurface,marginTop:spacing.lg,marginBottom:spacing.sm},
  helper:{fontFamily:fontFamily.regular,fontSize:fontSize.sm,color:colors.muted,lineHeight:20},
  searchInput:{backgroundColor:colors.surfaceSecondary,borderRadius:radius.md,borderWidth:1,borderColor:colors.border,paddingHorizontal:spacing.md,paddingVertical:spacing.md,fontFamily:fontFamily.regular,fontSize:fontSize.base,color:colors.onSurface,marginBottom:spacing.sm},
  segment:{flexDirection:"row",backgroundColor:colors.surface,borderRadius:radius.md,borderWidth:1,borderColor:colors.border,padding:3},
  segmentBtn:{flex:1,paddingVertical:spacing.sm,alignItems:"center",borderRadius:radius.sm},
  segmentActive:{backgroundColor:colors.brandPrimary},
  segmentText:{fontFamily:fontFamily.semibold,fontSize:fontSize.sm,color:colors.onSurfaceSecondary},
  segmentTextActive:{color:colors.onBrandPrimary},
  patientBox:{marginTop:spacing.sm,backgroundColor:colors.surface,borderRadius:radius.md,borderWidth:1,borderColor:colors.border,padding:spacing.sm},
  patientNameRow:{flexDirection:"row",alignItems:"center",gap:spacing.xs},
  occurrenceText:{fontFamily:fontFamily.semibold,fontSize:fontSize.xs,color:"#555555"},
  rowBetween:{flexDirection:"row",justifyContent:"space-between",alignItems:"center",padding:spacing.xs},
  link:{fontFamily:fontFamily.semibold,fontSize:fontSize.sm,color:colors.brandPrimary},
  patientRow:{flexDirection:"row",alignItems:"center",paddingVertical:spacing.sm,borderBottomWidth:1,borderBottomColor:colors.border},
  patientName:{fontFamily:fontFamily.semibold,fontSize:fontSize.sm,color:colors.onSurface},
  patientMeta:{fontFamily:fontFamily.regular,fontSize:fontSize.xs,color:colors.muted,marginTop:2},
  fieldGrid:{backgroundColor:colors.surface,borderRadius:radius.md,borderWidth:1,borderColor:colors.border,overflow:"hidden"},
  fieldRow:{flexDirection:"row",alignItems:"center",padding:spacing.md,borderBottomWidth:1,borderBottomColor:colors.border,gap:spacing.sm},
  fieldText:{fontFamily:fontFamily.medium,fontSize:fontSize.sm,color:colors.onSurface},
  photoChoices:{gap:spacing.sm},
  photoBtn:{padding:spacing.md,borderRadius:radius.md,borderWidth:1,borderColor:colors.border,backgroundColor:colors.surface},
  photoActive:{borderColor:colors.brandPrimary,backgroundColor:colors.brandTertiary},
  photoText:{fontFamily:fontFamily.semibold,fontSize:fontSize.sm,color:colors.onSurface},
  photoTextActive:{color:colors.brandPrimary},
  summary:{marginTop:spacing.lg,marginBottom:spacing.md,padding:spacing.md,borderRadius:radius.md,backgroundColor:colors.brandTertiary},
  summaryTitle:{fontFamily:fontFamily.bold,fontSize:fontSize.sm,color:colors.onSurface},
  summaryText:{fontFamily:fontFamily.regular,fontSize:fontSize.sm,color:colors.onSurfaceSecondary,marginTop:4,lineHeight:20},
}));