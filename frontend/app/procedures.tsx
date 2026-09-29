import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { Alert, FlatList, Pressable, Text, TextInput, View } from "react-native";
import Ionicons from "@react-native-vector-icons/ionicons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "@/src/api/client";
import { useAuth } from "@/src/auth/AuthContext";
import { PrimaryButton } from "@/src/components/PrimaryButton";
import { useToast } from "@/src/components/toast";
import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";

type Procedure={id:string;name:string};

export default function ProceduresScreen(){
 const styles=useStyles(); const {colors}=useTheme(); const insets=useSafeAreaInsets(); const {user}=useAuth(); const toast=useToast(); const qc=useQueryClient();
 const [draft,setDraft]=useState(""); const [editing,setEditing]=useState<Procedure|null>(null);
 const {data=[],isLoading}=useQuery<Procedure[]>({queryKey:["procedures"],queryFn:()=>api.get("/procedures"),staleTime:30000});
 const add=useMutation({mutationFn:(name:string)=>api.post("/procedures",{name}),onSuccess:()=>{qc.invalidateQueries({queryKey:["procedures"]});setDraft("");toast("Procedure added.","success")},onError:(e:any)=>toast(e?.message||"Could not add procedure.","error")});
 const update=useMutation({mutationFn:(x:Procedure)=>api.put("/procedures/"+x.id,{name:x.name}),onSuccess:()=>{qc.invalidateQueries({queryKey:["procedures"]});setEditing(null);toast("Procedure updated.","success")},onError:(e:any)=>toast(e?.message||"Could not update procedure.","error")});
 const del=useMutation({mutationFn:(id:string)=>api.del("/procedures/"+id),onSuccess:()=>{qc.invalidateQueries({queryKey:["procedures"]});toast("Procedure deleted.","success")},onError:(e:any)=>toast(e?.message||"Could not delete procedure.","error")});
 if(user?.role!=="admin") return <View style={styles.center}><Text style={styles.blocked}>Administrator only</Text></View>;
 const save=()=>{const name=(editing?.name??draft).trim();if(!name){toast("Enter a procedure name.","error");return;}editing?update.mutate({...editing,name}):add.mutate(name)};
 return <View style={styles.container}>
  <View style={[styles.header,{paddingTop:insets.top+spacing.sm}]}><Pressable onPress={()=>router.back()} style={styles.headerBtn}><Ionicons name="arrow-back" size={24} color={colors.onSurface}/></Pressable><Text style={styles.headerTitle}>Procedures</Text><View style={styles.headerBtn}/></View>
  <View style={{padding:spacing.lg}}><Text style={styles.label}>{editing?"Edit Procedure":"Add Procedure"}</Text><TextInput value={editing?editing.name:draft} onChangeText={v=>editing?setEditing({...editing,name:v}):setDraft(v)} placeholder="Procedure name" placeholderTextColor={colors.muted} style={styles.input}/><View style={{flexDirection:"row",gap:spacing.sm}}><View style={{flex:1}}><PrimaryButton title={editing?"Save Changes":"Add Procedure"} onPress={save}/></View>{editing?<Pressable style={styles.cancel} onPress={()=>setEditing(null)}><Text style={styles.cancelText}>Cancel</Text></Pressable>:null}</View></View>
  <FlatList data={data} keyExtractor={x=>x.id} contentContainerStyle={{padding:spacing.lg,paddingTop:0}} ListEmptyComponent={!isLoading?<Text style={styles.empty}>No procedures yet.</Text>:null} renderItem={({item})=><View style={styles.row}><Text style={styles.name}>{item.name}</Text><Pressable style={styles.iconBtn} onPress={()=>setEditing(item)}><Ionicons name="create-outline" size={20} color={colors.brandPrimary}/></Pressable><Pressable style={styles.iconBtn} onPress={()=>Alert.alert("Delete procedure?",item.name,[{text:"Cancel",style:"cancel"},{text:"Delete",style:"destructive",onPress:()=>del.mutate(item.id)}])}><Ionicons name="trash-outline" size={20} color={colors.error}/></Pressable></View>)}/>
 </View>
}
const useStyles=makeStyles(colors=>({container:{flex:1,backgroundColor:colors.surfaceSecondary},header:{flexDirection:"row",alignItems:"center",justifyContent:"space-between",paddingHorizontal:spacing.md,paddingBottom:spacing.md,borderBottomWidth:1,borderBottomColor:colors.border,backgroundColor:colors.surface},headerBtn:{width:40,height:40,alignItems:"center",justifyContent:"center"},headerTitle:{fontFamily:fontFamily.bold,fontSize:fontSize.lg,color:colors.onSurface},label:{fontFamily:fontFamily.semibold,fontSize:fontSize.sm,color:colors.onSurfaceSecondary,marginBottom:spacing.xs},input:{backgroundColor:colors.surface,borderWidth:1,borderColor:colors.border,borderRadius:radius.md,paddingHorizontal:spacing.md,paddingVertical:spacing.md,fontFamily:fontFamily.regular,fontSize:fontSize.base,color:colors.onSurface,marginBottom:spacing.md},cancel:{minHeight:48,paddingHorizontal:spacing.lg,alignItems:"center",justifyContent:"center",borderWidth:1,borderColor:colors.border,borderRadius:radius.md},cancelText:{fontFamily:fontFamily.semibold,color:colors.onSurface},row:{flexDirection:"row",alignItems:"center",gap:spacing.sm,padding:spacing.md,marginBottom:spacing.sm,borderWidth:1,borderColor:colors.border,borderRadius:radius.md,backgroundColor:colors.surface},name:{flex:1,fontFamily:fontFamily.medium,fontSize:fontSize.base,color:colors.onSurface},iconBtn:{width:40,height:40,alignItems:"center",justifyContent:"center"},empty:{fontFamily:fontFamily.regular,color:colors.muted},center:{flex:1,alignItems:"center",justifyContent:"center"},blocked:{fontFamily:fontFamily.bold,fontSize:fontSize.lg,color:colors.onSurface}}));