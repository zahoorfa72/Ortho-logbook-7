import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Modal, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import Ionicons from "@react-native-vector-icons/ionicons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api } from "@/src/api/client";
import { useAuth } from "@/src/auth/AuthContext";
import { Field } from "@/src/components/Field";
import { PrimaryButton } from "@/src/components/PrimaryButton";
import { EmptyState } from "@/src/components/EmptyState";
import { useToast } from "@/src/components/toast";
import { buildImplantRecordsHtml, generateAndSharePdf } from "@/src/utils/pdf";
import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";

type Bill={name:string;uri:string;mimeType?:string};
type ImplantRecord={id:string;name:string;category:string;size:string;manufacturer:string;model:string;lot_number:string;serial_number:string;expiry_date:string;supplier:string;quantity:number;unit:string;purchase_price:number;notes:string;bill_files_json:string;created_at:string;updated_at:string};
type Draft={id?:string;name:string;category:string;size:string;manufacturer:string;model:string;lot_number:string;serial_number:string;expiry_date:string;supplier:string;quantity:number;unit:string;purchase_price:number;notes:string;billFiles:Bill[]};

const emptyDraft=():Draft=>({name:"",category:"",size:"",manufacturer:"",model:"",lot_number:"",serial_number:"",expiry_date:"",supplier:"",quantity:0,unit:"pcs",purchase_price:0,notes:"",billFiles:[]});

export default function ImplantsScreen(){
  const styles=useStyles(); const {colors,branding}=useTheme(); const insets=useSafeAreaInsets(); const {user}=useAuth(); const toast=useToast(); const qc=useQueryClient();
  const [modal,setModal]=useState(false); const [draft,setDraft]=useState<Draft>(emptyDraft); const [selected,setSelected]=useState<string[]>([]); const [selectMode,setSelectMode]=useState(false); const [search,setSearch]=useState(""); const [exporting,setExporting]=useState(false);
  const {data=[],isLoading,isRefetching,refetch}=useQuery<ImplantRecord[]>({queryKey:["implant-records"],queryFn:()=>api.get("/implant-records"),enabled:user?.role==="admin"});
  const list=useMemo(()=>{const q=search.trim().toLowerCase();return data.filter(x=>!q||[x.name,x.category,x.size,x.manufacturer,x.model,x.lot_number,x.serial_number,x.supplier].join(" ").toLowerCase().includes(q));},[data,search]);
  const save=useMutation({mutationFn:()=>draft.id
    ? api.put("/implant-records/"+draft.id,{name:draft.name,category:draft.category,size:draft.size,manufacturer:draft.manufacturer,model:draft.model,lotNumber:draft.lot_number,serialNumber:draft.serial_number,expiryDate:draft.expiry_date,supplier:draft.supplier,quantity:draft.quantity,unit:draft.unit,purchasePrice:draft.purchase_price,notes:draft.notes,billFiles:draft.billFiles})
    : api.post("/implant-records",{name:draft.name,category:draft.category,size:draft.size,manufacturer:draft.manufacturer,model:draft.model,lotNumber:draft.lot_number,serialNumber:draft.serial_number,expiryDate:draft.expiry_date,supplier:draft.supplier,quantity:draft.quantity,unit:draft.unit,purchasePrice:draft.purchase_price,notes:draft.notes,billFiles:draft.billFiles}),
    onSuccess:()=>{qc.invalidateQueries({queryKey:["implant-records"]});setModal(false);setDraft(emptyDraft());toast("Implant record saved.","success");},
    onError:(e:any)=>toast(e?.message||"Could not save implant record.","error")});
  const remove=async(ids:string[])=>{try{const r=await api.post<{deleted:number;success:boolean}>("/implant-records-bulk-delete",{ids});if(r.deleted!==ids.length)throw new Error("Only "+r.deleted+" of "+ids.length+" selected implant record(s) were deleted.");setSelected([]);setSelectMode(false);qc.invalidateQueries({queryKey:["implant-records"]});await refetch();toast("Implant records deleted.","success");}catch(e:any){toast(e?.message||"Could not delete implant records.","error");}};
  const pickBills=async()=>{try{const result=await DocumentPicker.getDocumentAsync({type:["application/pdf","image/*"],multiple:true,copyToCacheDirectory:true});if(result.canceled)return;const dir=FileSystem.documentDirectory+"implant-bills/";await FileSystem.makeDirectoryAsync(dir,{intermediates:true}).catch(()=>{});const next:Bill[]=[];for(const a of result.assets||[]){if(!a.uri)continue;const safe=(a.name||("bill-"+Date.now())).replace(/[^a-zA-Z0-9._-]/g,"_");const dest=dir+Date.now()+"-"+safe;await FileSystem.copyAsync({from:a.uri,to:dest});next.push({name:a.name||safe,uri:dest,mimeType:a.mimeType});}setDraft(d=>({...d,billFiles:d.billFiles.concat(next)}));}catch(e:any){toast(e?.message||"Could not attach bill.","error");}};
  const openAdd=()=>{setDraft(emptyDraft());setModal(true)};
  const openEdit=(r:ImplantRecord)=>{let bills:Bill[]=[];try{const x=JSON.parse(r.bill_files_json||"[]");if(Array.isArray(x))bills=x;}catch{}setDraft({id:r.id,name:r.name||"",category:r.category||"",size:r.size||"",manufacturer:r.manufacturer||"",model:r.model||"",lot_number:r.lot_number||"",serial_number:r.serial_number||"",expiry_date:r.expiry_date||"",supplier:r.supplier||"",quantity:Number(r.quantity)||0,unit:r.unit||"pcs",purchase_price:Number(r.purchase_price)||0,notes:r.notes||"",billFiles:bills});setModal(true)};
  const doExport=useCallback(async()=>{if(!list.length){toast("No implant records to export.","info");return;}setExporting(true);try{await generateAndSharePdf(buildImplantRecordsHtml(branding,list),"Implant Records");}catch(e:any){toast(e?.message||"Could not create PDF.","error");}finally{setExporting(false);}},[branding,list,toast]);
  if(user?.role!=="admin")return <View style={[styles.container,{paddingTop:insets.top}]}><View style={styles.center}><Ionicons name="lock-closed-outline" size={44} color={colors.muted}/><Text style={styles.blocked}>Administrator only</Text></View></View>;
  return <View style={styles.container}>
    <View style={[styles.header,{paddingTop:insets.top+spacing.sm}]}>
      <View><Text style={styles.title}>Implants</Text><Text style={styles.subTitle}>{data.length} detailed record{data.length===1?"":"s"}</Text></View>
      <View style={styles.headerActions}>
        <Pressable onPress={doExport} disabled={exporting} style={styles.iconBtn}>{exporting?<ActivityIndicator size="small" color={colors.brandPrimary}/>:<Ionicons name="document-text-outline" size={21} color={colors.brandPrimary}/>}</Pressable>
        <Pressable onPress={()=>{setSelectMode(v=>!v);setSelected([])}} style={styles.iconBtn}><Ionicons name={selectMode?"close":"checkmark-circle-outline"} size={21} color={colors.brandPrimary}/></Pressable>
        <Pressable onPress={openAdd} style={styles.addBtn}><Ionicons name="add" size={19} color={colors.onBrandPrimary}/><Text style={styles.addText}>Add</Text></Pressable>
      </View>
    </View>
    <View style={styles.search}><Ionicons name="search" size={18} color={colors.muted}/><TextInput value={search} onChangeText={setSearch} placeholder="Search implant, size, lot, supplier..." placeholderTextColor={colors.muted} style={{flex:1,color:colors.onSurface,paddingVertical:spacing.sm}}/></View>
    {selectMode&&selected.length?<Pressable style={styles.deleteBar} onPress={()=>Alert.alert("Delete selected implants?","Delete "+selected.length+" selected record(s)?",[{text:"Cancel",style:"cancel"},{text:"Delete",style:"destructive",onPress:()=>remove(selected)}])}><Ionicons name="trash-outline" size={19} color={colors.error}/><Text style={styles.deleteText}>Delete {selected.length} selected</Text></Pressable>:null}
    {isLoading?<View style={styles.center}><ActivityIndicator size="large" color={colors.brandPrimary}/></View>:<FlatList data={list} keyExtractor={x=>x.id} refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch}/>} contentContainerStyle={{padding:spacing.lg,paddingBottom:insets.bottom+spacing.xxl}} ListEmptyComponent={<EmptyState icon="medkit-outline" title="No detailed implants" subtitle="Add a detailed implant record from this tab."/>} renderItem={({item})=>{
      let billCount=0;try{billCount=JSON.parse(item.bill_files_json||"[]").length}catch{}
      const title=item.name+(item.size?" · "+item.size:"");
      const meta=[item.category,item.manufacturer,item.model].filter(Boolean).join(" · ")||"Detailed implant record";
      const trace=[item.lot_number?"Lot: "+item.lot_number:"",item.serial_number?"SN: "+item.serial_number:"",item.expiry_date?"Expiry: "+item.expiry_date:""].filter(Boolean).join(" · ");
      return <Pressable style={[styles.card,selected.includes(item.id)&&styles.selected]} onPress={()=>selectMode?setSelected(v=>v.includes(item.id)?v.filter(x=>x!==item.id):v.concat(item.id)):openEdit(item)} onLongPress={()=>{setSelectMode(true);setSelected(v=>v.includes(item.id)?v:v.concat(item.id))}}>
        <View style={{flex:1}}><Text style={styles.cardTitle}>{title}</Text><Text style={styles.meta}>{meta}</Text>{trace?<Text style={styles.meta}>{trace}</Text>:null}<Text style={styles.meta}>Qty {item.quantity} {item.unit}{billCount?" · "+billCount+" bill"+(billCount===1?"":"s"):""}</Text></View>
        {!selectMode?<Ionicons name="chevron-forward" size={20} color={colors.muted}/>:<Ionicons name={selected.includes(item.id)?"checkbox":"square-outline"} size={23} color={selected.includes(item.id)?colors.brandPrimary:colors.muted}/>}
      </Pressable>})}/>
    <Modal visible={modal} transparent animationType="slide" onRequestClose={()=>setModal(false)}><View style={styles.overlay}><View style={[styles.sheet,{paddingBottom:insets.bottom+spacing.lg}]}><ScrollView keyboardShouldPersistTaps="handled">
      <View style={styles.sheetHead}><Text style={styles.sheetTitle}>{draft.id?"Edit Implant":"New Implant"}</Text><Pressable onPress={()=>setModal(false)}><Ionicons name="close" size={24} color={colors.onSurface}/></Pressable></View>
      <Field label="Implant name" value={draft.name} onChangeText={v=>setDraft(d=>({...d,name:v}))} placeholder="e.g. Interlocking Nail"/>
      <Field label="Category" value={draft.category} onChangeText={v=>setDraft(d=>({...d,category:v}))} placeholder="e.g. Femur"/>
      <Field label="Size / Length" value={draft.size} onChangeText={v=>setDraft(d=>({...d,size:v}))} placeholder="e.g. 10mm × 280mm"/>
      <Field label="Manufacturer" value={draft.manufacturer} onChangeText={v=>setDraft(d=>({...d,manufacturer:v}))} placeholder="Manufacturer"/>
      <Field label="Model / Reference" value={draft.model} onChangeText={v=>setDraft(d=>({...d,model:v}))} placeholder="Model / reference"/>
      <Field label="Lot number" value={draft.lot_number} onChangeText={v=>setDraft(d=>({...d,lot_number:v}))} placeholder="Lot number"/>
      <Field label="Serial number" value={draft.serial_number} onChangeText={v=>setDraft(d=>({...d,serial_number:v}))} placeholder="Serial number"/>
      <Field label="Expiry date" value={draft.expiry_date} onChangeText={v=>setDraft(d=>({...d,expiry_date:v}))} placeholder="YYYY-MM-DD"/>
      <Field label="Supplier" value={draft.supplier} onChangeText={v=>setDraft(d=>({...d,supplier:v}))} placeholder="Supplier"/>
      <Field label="Quantity" value={String(draft.quantity)} onChangeText={v=>setDraft(d=>({...d,quantity:Number(v.replace(/[^0-9.]/g,""))||0}))} keyboardType="decimal-pad"/>
      <Field label="Unit" value={draft.unit} onChangeText={v=>setDraft(d=>({...d,unit:v}))} placeholder="pcs"/>
      <Field label="Purchase price" value={String(draft.purchase_price)} onChangeText={v=>setDraft(d=>({...d,purchase_price:Number(v.replace(/[^0-9.]/g,""))||0}))} keyboardType="decimal-pad"/>
      <Field label="Notes" value={draft.notes} onChangeText={v=>setDraft(d=>({...d,notes:v}))} placeholder="Additional details"/>
      <Text style={styles.billTitle}>Bills / attachments</Text>
      {draft.billFiles.map((b,i)=><View key={b.uri||String(i)} style={styles.billRow}><Ionicons name="document-attach-outline" size={19} color={colors.brandPrimary}/><Text style={styles.billName} numberOfLines={1}>{b.name}</Text><Pressable onPress={()=>setDraft(d=>({...d,billFiles:d.billFiles.filter((_,ix)=>ix!==i)}))}><Ionicons name="close-circle" size={20} color={colors.error}/></Pressable></View>)}
      <Pressable style={styles.attachBtn} onPress={pickBills}><Ionicons name="attach-outline" size={19} color={colors.brandPrimary}/><Text style={styles.attachText}>Attach bill (PDF or image)</Text></Pressable>
      <PrimaryButton title={draft.id?"Save changes":"Save implant"} onPress={()=>save.mutate()} loading={save.isPending} testID="implant-save"/>
      {draft.id ? <Pressable style={styles.singleDelete} onPress={()=>Alert.alert("Delete implant record?","This detailed implant record will be permanently deleted.",[{text:"Cancel",style:"cancel"},{text:"Delete",style:"destructive",onPress:async()=>{try{await api.del("/implant-records/"+draft.id);qc.invalidateQueries({queryKey:["implant-records"]});setModal(false);setDraft(emptyDraft());toast("Implant record deleted.","success");}catch(e:any){toast(e?.message||"Could not delete implant record.","error");}}])} testID="implant-single-delete"><Ionicons name="trash-outline" size={18} color={colors.error}/><Text style={styles.singleDeleteText}>Delete this implant record</Text></Pressable> : null}
      <Pressable style={styles.cancel} onPress={()=>setModal(false)}><Text style={styles.cancelText}>Cancel</Text></Pressable>
    </ScrollView></View></View></Modal>
  </View>;
}

const useStyles=makeStyles(colors=>({
  container:{flex:1,backgroundColor:colors.surfaceSecondary},header:{flexDirection:"row",alignItems:"center",justifyContent:"space-between",paddingHorizontal:spacing.lg,paddingBottom:spacing.md,backgroundColor:colors.surface,borderBottomWidth:1,borderBottomColor:colors.border},title:{fontFamily:fontFamily.bold,fontSize:fontSize.xxl,color:colors.onSurface},subTitle:{fontSize:fontSize.xs,color:colors.muted,marginTop:2},headerActions:{flexDirection:"row",alignItems:"center",gap:spacing.xs},iconBtn:{width:40,height:40,borderRadius:radius.md,borderWidth:1,borderColor:colors.border,alignItems:"center",justifyContent:"center",backgroundColor:colors.surfaceSecondary},addBtn:{height:40,borderRadius:radius.md,paddingHorizontal:spacing.md,flexDirection:"row",alignItems:"center",gap:spacing.xs,backgroundColor:colors.brandPrimary},addText:{fontFamily:fontFamily.semibold,color:colors.onBrandPrimary},search:{flexDirection:"row",alignItems:"center",gap:spacing.sm,margin:spacing.lg,marginBottom:0,paddingHorizontal:spacing.md,borderWidth:1,borderColor:colors.border,borderRadius:radius.md,backgroundColor:colors.surface},card:{flexDirection:"row",alignItems:"center",gap:spacing.md,padding:spacing.lg,marginBottom:spacing.sm,borderRadius:radius.md,borderWidth:1,borderColor:colors.border,backgroundColor:colors.surface},selected:{borderWidth:2,borderColor:colors.brandPrimary},cardTitle:{fontFamily:fontFamily.semibold,fontSize:fontSize.lg,color:colors.onSurface},meta:{fontSize:fontSize.xs,color:colors.muted,marginTop:3},deleteBar:{flexDirection:"row",alignItems:"center",gap:spacing.xs,margin:spacing.lg,padding:spacing.md,borderRadius:radius.md,borderWidth:1,borderColor:colors.error,backgroundColor:colors.surface},deleteText:{fontFamily:fontFamily.semibold,color:colors.error},overlay:{flex:1,backgroundColor:"rgba(15,23,42,0.4)",justifyContent:"flex-end"},sheet:{backgroundColor:colors.surface,borderTopLeftRadius:radius.lg,borderTopRightRadius:radius.lg,padding:spacing.lg,maxHeight:"92%"},sheetHead:{flexDirection:"row",alignItems:"center",justifyContent:"space-between",marginBottom:spacing.lg},sheetTitle:{fontFamily:fontFamily.bold,fontSize:fontSize.xl,color:colors.onSurface},billTitle:{fontFamily:fontFamily.semibold,fontSize:fontSize.base,color:colors.onSurface,marginTop:spacing.md,marginBottom:spacing.sm},billRow:{flexDirection:"row",alignItems:"center",gap:spacing.sm,padding:spacing.sm,borderRadius:radius.sm,backgroundColor:colors.surfaceTertiary,marginBottom:spacing.xs},billName:{flex:1,fontSize:fontSize.sm,color:colors.onSurface},attachBtn:{flexDirection:"row",alignItems:"center",justifyContent:"center",gap:spacing.xs,padding:spacing.md,borderWidth:1,borderColor:colors.border,borderRadius:radius.md,marginBottom:spacing.md},attachText:{fontFamily:fontFamily.semibold,color:colors.brandPrimary},singleDelete:{flexDirection:"row",alignItems:"center",justifyContent:"center",gap:spacing.xs,padding:spacing.md,borderRadius:radius.md,borderWidth:1,borderColor:colors.error,marginTop:spacing.sm},singleDeleteText:{fontFamily:fontFamily.semibold,color:colors.error},cancel:{alignItems:"center",padding:spacing.md},cancelText:{fontFamily:fontFamily.semibold,color:colors.muted},center:{flex:1,alignItems:"center",justifyContent:"center",gap:spacing.md},blocked:{fontFamily:fontFamily.bold,fontSize:fontSize.lg,color:colors.onSurface}
}));