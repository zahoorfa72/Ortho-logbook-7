import { router } from "expo-router";
import { useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import Ionicons from "@react-native-vector-icons/ionicons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api } from "@/src/api/client";
import { useAuth } from "@/src/auth/AuthContext";
import { Field } from "@/src/components/Field";
import { PrimaryButton } from "@/src/components/PrimaryButton";
import { useToast } from "@/src/components/toast";
import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";

type CustomField={id:string;key:string;label:string;type:string;sort_order:number;enabled:number};

export default function PatientFieldsScreen(){
  const styles=useStyles(); const {colors}=useTheme(); const insets=useSafeAreaInsets(); const {user}=useAuth(); const toast=useToast(); const qc=useQueryClient();
  const [label,setLabel]=useState(""); const [type,setType]=useState("text"); const [editing,setEditing]=useState<CustomField|null>(null);
  const {data=[],isLoading}=useQuery<CustomField[]>({queryKey:["patient-custom-fields"],queryFn:()=>api.get("/patient-custom-fields"),enabled:user?.role==="admin"});
  const mutation=useMutation({
    mutationFn:async()=>{
      if(editing) return api.put("/patient-custom-fields/"+editing.id,{label,type,sort_order:editing.sort_order});
      return api.post("/patient-custom-fields",{label,type});
    },
    onSuccess:()=>{setLabel("");setType("text");setEditing(null);qc.invalidateQueries({queryKey:["patient-custom-fields"]});toast("Patient field saved.","success");},
    onError:(e:any)=>toast(e?.message||"Could not save field.","error"),
  });
  const remove=async(id:string)=>{
    try{await api.del("/patient-custom-fields/"+id);qc.invalidateQueries({queryKey:["patient-custom-fields"]});toast("Patient field removed.","success");}
    catch(e:any){toast(e?.message||"Could not remove field.","error");}
  };
  const beginEdit=(f:CustomField)=>{setEditing(f);setLabel(f.label);setType(f.type);};
  const types=useMemo(()=>[["text","Text"],["number","Number"],["date","Date"],["multiline","Long text"]],[]);
  if(user?.role!=="admin") return <View style={[styles.container,{paddingTop:insets.top}]}><View style={styles.center}><Ionicons name="lock-closed-outline" size={44} color={colors.muted}/><Text style={styles.blocked}>Administrator only</Text></View></View>;
  return <View style={styles.container}>
    <View style={[styles.header,{paddingTop:insets.top+spacing.sm}]}>
      <Pressable onPress={()=>router.back()} style={styles.headerBtn}><Ionicons name="arrow-back" size={24} color={colors.onSurface}/></Pressable>
      <Text style={styles.headerTitle}>Patient Fields</Text><View style={styles.headerBtn}/>
    </View>
    <ScrollView contentContainerStyle={{padding:spacing.lg,paddingBottom:insets.bottom+spacing.xxl}} keyboardShouldPersistTaps="handled">
      <View style={styles.info}><Ionicons name="information-circle-outline" size={22} color={colors.brandPrimary}/><Text style={styles.infoText}>Create extra fields for the New Patient form. They are saved in local SQLite and can be used in patient PDFs.</Text></View>
      <Text style={styles.section}>{editing?"Edit field":"Create a new patient field"}</Text>
      <Field label="Field name" value={label} onChangeText={setLabel} placeholder="e.g. Phone, Blood Group, Follow-up Date"/>
      <Text style={styles.label}>Field type</Text>
      <View style={styles.typeRow}>{types.map(([v,t])=><Pressable key={v} onPress={()=>setType(v)} style={[styles.typeBtn,type===v&&styles.typeBtnActive]}><Text style={[styles.typeText,type===v&&styles.typeTextActive]}>{t}</Text></Pressable>)}</View>
      <PrimaryButton title={editing?"Save changes":"Add patient field"} onPress={()=>mutation.mutate()} loading={mutation.isPending} testID="patient-field-save"/>
      {editing?<Pressable style={styles.cancel} onPress={()=>{setEditing(null);setLabel("");setType("text");}}><Text style={styles.cancelText}>Cancel edit</Text></Pressable>:null}
      <Text style={styles.section}>Existing fields</Text>
      {isLoading?<Text style={styles.muted}>Loading…</Text>:data.length===0?<Text style={styles.muted}>No custom fields yet.</Text>:data.map((f)=><View key={f.id} style={styles.card}>
        <View style={{flex:1}}><Text style={styles.cardTitle}>{f.label}</Text><Text style={styles.cardMeta}>{f.type} · #{f.sort_order}</Text></View>
        <Pressable style={styles.action} onPress={()=>beginEdit(f)}><Ionicons name="create-outline" size={20} color={colors.brandPrimary}/></Pressable>
        <Pressable style={styles.action} onPress={()=>Alert.alert("Delete field?",`Remove “${f.label}” from the patient form? Existing saved values are kept in patient records.`,[{text:"Cancel",style:"cancel"},{text:"Delete",style:"destructive",onPress:()=>remove(f.id)}])}><Ionicons name="trash-outline" size={20} color={colors.error}/></Pressable>
      </View>)}
    </ScrollView>
  </View>;
}

const useStyles=makeStyles(colors=>({
  container:{flex:1,backgroundColor:colors.surfaceSecondary},header:{flexDirection:"row",alignItems:"center",justifyContent:"space-between",paddingHorizontal:spacing.md,paddingBottom:spacing.md,backgroundColor:colors.surface,borderBottomWidth:1,borderBottomColor:colors.border},
  headerBtn:{width:40,height:40,alignItems:"center",justifyContent:"center"},headerTitle:{fontFamily:fontFamily.bold,fontSize:fontSize.lg,color:colors.onSurface},
  section:{fontFamily:fontFamily.bold,fontSize:fontSize.lg,color:colors.onSurface,marginTop:spacing.xl,marginBottom:spacing.md},label:{fontFamily:fontFamily.semibold,fontSize:fontSize.sm,color:colors.onSurfaceSecondary,marginBottom:spacing.sm},
  typeRow:{flexDirection:"row",flexWrap:"wrap",gap:spacing.sm,marginBottom:spacing.md},typeBtn:{paddingHorizontal:spacing.md,paddingVertical:spacing.sm,borderRadius:radius.pill,borderWidth:1,borderColor:colors.border,backgroundColor:colors.surface},
  typeBtnActive:{backgroundColor:colors.brandPrimary,borderColor:colors.brandPrimary},typeText:{fontFamily:fontFamily.semibold,fontSize:fontSize.sm,color:colors.muted},typeTextActive:{color:colors.onBrandPrimary},
  info:{flexDirection:"row",gap:spacing.sm,padding:spacing.md,borderRadius:radius.md,backgroundColor:colors.brandTertiary,borderWidth:1,borderColor:colors.border},infoText:{flex:1,fontSize:fontSize.sm,color:colors.onBrandTertiary,lineHeight:18},
  card:{flexDirection:"row",alignItems:"center",gap:spacing.sm,padding:spacing.md,backgroundColor:colors.surface,borderRadius:radius.md,borderWidth:1,borderColor:colors.border,marginBottom:spacing.sm},cardTitle:{fontFamily:fontFamily.semibold,fontSize:fontSize.base,color:colors.onSurface},cardMeta:{fontSize:fontSize.xs,color:colors.muted,marginTop:2},action:{width:40,height:40,borderRadius:radius.sm,backgroundColor:colors.surfaceTertiary,alignItems:"center",justifyContent:"center"},cancel:{alignItems:"center",padding:spacing.md},cancelText:{fontFamily:fontFamily.semibold,color:colors.muted},muted:{color:colors.muted},center:{flex:1,alignItems:"center",justifyContent:"center",gap:spacing.md},blocked:{fontFamily:fontFamily.bold,fontSize:fontSize.lg,color:colors.onSurface}
}));