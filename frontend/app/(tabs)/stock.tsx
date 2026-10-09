import { useMemo, useState } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import Ionicons from "@react-native-vector-icons/ionicons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api } from "@/src/api/client";
import { useAuth } from "@/src/auth/AuthContext";
import { PrimaryButton } from "@/src/components/PrimaryButton";
import { useToast } from "@/src/components/toast";
import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";

type StockRow = {
  id:string; categoryId:string; category:string; size:string; quantity:string;
  minimumStock:string; billImage:string;
};

const newRow=():StockRow=>({
  id:Math.random().toString(36).slice(2),
  categoryId:"",category:"",size:"",quantity:"",minimumStock:"1",billImage:""
});

export default function StockScreen(){
  const styles=useStyles();
  const {colors}=useTheme();
  const insets=useSafeAreaInsets();
  const {user}=useAuth();
  const toast=useToast();
  const qc=useQueryClient();

  const [stockModal,setStockModal]=useState(false);
  const [editingReceipt,setEditingReceipt]=useState<any>(null);
  const [stockRows,setStockRows]=useState<StockRow[]>([]);
  const [stockDate,setStockDate]=useState(new Date().toISOString().slice(0,10));
  const [description,setDescription]=useState("");
  const [stockPicker,setStockPicker]=useState<"category"|"size"|null>(null);
  const [stockPickerRow,setStockPickerRow]=useState("");
  const [stockSearch,setStockSearch]=useState("");

  const {data:stockCategories=[]}=useQuery<any[]>({
    queryKey:["inventory-categories"],
    queryFn:()=>api.get("/inventory-categories"),
  });
  const {data:stockInventory=[]}=useQuery<any[]>({
    queryKey:["inventory","stock-picker"],
    queryFn:()=>api.get("/inventory"),
  });
  const {data:stockReceipts=[],isLoading,isRefetching,refetch}=useQuery<any[]>({
    queryKey:["inventory-purchase-receipts"],
    queryFn:()=>api.get("/stock-receipts"),
  });

  const stockBatches=useMemo(()=>{
    const groups=new Map<string,{batchId:string;createdAt:string;addedDate:string;description:string;items:any[]}>();
    for(const r of (Array.isArray(stockReceipts)?stockReceipts:[])){
      const batchId=String(r.batch_id||r.id);
      let g=groups.get(batchId);
      if(!g){
        g={batchId,createdAt:String(r.created_at||""),addedDate:String(r.added_date||""),description:String(r.description||""),items:[]};
        groups.set(batchId,g);
      }
      g.items.push(r);
      if(!g.description && r.description)g.description=String(r.description);
      if(!g.addedDate && r.added_date)g.addedDate=String(r.added_date);
    }
    return [...groups.values()].sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
  },[stockReceipts]);

  const saveStock=useMutation({
    mutationFn:()=>{
      if(editingReceipt){
        const row=stockRows[0];
        return api.put("/stock-receipts/"+encodeURIComponent(String(editingReceipt.id)),{
          categoryId:row?.categoryId,category:row?.category,size:row?.size,
          quantity:Number(row?.quantity)||0,minimumStock:Number(row?.minimumStock)||0,
          addedDate:stockDate,billImage:row?.billImage||"",description:description.trim(),
        });
      }
      return api.post("/inventory-bulk-add",{
        description:description.trim(),
        items:stockRows.map(row=>({
          categoryId:row.categoryId,category:row.category,size:row.size,
          quantity:Number(row.quantity)||0,minimumStock:Number(row.minimumStock)||0,
          addedDate:stockDate,billImage:row.billImage||"",
        }))
      });
    },
    onSuccess:()=>{
      qc.invalidateQueries({queryKey:["inventory"]});
      qc.invalidateQueries({queryKey:["inventory","stock-picker"]});
      qc.invalidateQueries({queryKey:["inventory-purchase-receipts"]});
      qc.invalidateQueries({queryKey:["inventory-categories"]});
      setStockModal(false);setStockRows([]);setEditingReceipt(null);setDescription("");
      toast(editingReceipt?"Receiving entry updated.":"Stock received successfully.","success");
    },
    onError:(e:any)=>toast(e?.message||"Could not save receiving stock.","error")
  });

  const openStock=()=>{
    setEditingReceipt(null);setStockRows([newRow()]);
    setStockDate(new Date().toISOString().slice(0,10));
    setDescription("");setStockModal(true);
  };

  const editReceipt=(r:any)=>{
    setEditingReceipt(r);
    setStockRows([{
      id:String(r.id),
      categoryId:String(r.category_id||""),
      category:String(r.category||""),
      size:String(r.size||""),
      quantity:String(Number(r.quantity)||0),
      minimumStock:String(Number(r.minimum_stock??r.minimumStock)||0),
      billImage:String(r.bill_image||r.billImage||"")
    }]);
    setStockDate(String(r.added_date||r.addedDate||new Date().toISOString().slice(0,10)));
    setDescription(String(r.description||""));
    setStockModal(true);
  };

  const deleteReceipt=(r:any)=>{
    Alert.alert("Delete received stock","Delete this receiving entry? Its quantity will be removed from available inventory.",[
      {text:"Cancel",style:"cancel"},
      {text:"Delete",style:"destructive",onPress:async()=>{
        try{
          await api.post("/stock-receipts/"+encodeURIComponent(String(r.id))+"/delete",{});
          qc.invalidateQueries({queryKey:["inventory"]});
          qc.invalidateQueries({queryKey:["inventory","stock-picker"]});
          qc.invalidateQueries({queryKey:["inventory-purchase-receipts"]});
          toast("Receiving entry deleted.","success");
        }catch(e:any){toast(e?.message||"Could not delete receiving entry.","error");}
      }}
    ] as any);
  };

  const updateRow=(id:string,patch:Partial<StockRow>)=>setStockRows(rows=>rows.map(r=>r.id===id?{...r,...patch}:r));

  const pickBill=async(id:string)=>{
    const p=await ImagePicker.requestMediaLibraryPermissionsAsync();
    if(!p.granted){toast("Photo permission is required for the bill image.","error");return;}
    const x=await ImagePicker.launchImageLibraryAsync({mediaTypes:["images"],allowsEditing:true,quality:1});
    if(x.canceled)return;
    const a=x.assets[0];
    if(!a?.uri){toast("Could not read bill image.","error");return;}
    try{
      // Compress bills before storing them in the offline database. Keep enough
      // resolution for printed totals, small text and handwritten notes to remain legible.
      const actions:any[]=[];
      const width=Number(a.width||0),height=Number(a.height||0);
      if(width>1600||height>1600){
        actions.push(width>=height?{resize:{width:1600}}:{resize:{height:1600}});
      }
      let result=await ImageManipulator.manipulateAsync(a.uri,actions,{
        compress:0.58,
        format:ImageManipulator.SaveFormat.JPEG,
        base64:true
      });
      // If the bill is still large, use a second quality step rather than rejecting
      // a normal camera photo. Do not repeatedly recompress already-compressed data.
      if(result.base64&&result.base64.length>1900000){
        result=await ImageManipulator.manipulateAsync(result.uri,[],{
          compress:0.42,
          format:ImageManipulator.SaveFormat.JPEG,
          base64:true
        });
      }
      if(!result.base64){toast("Could not compress bill image. Please select it again.","error");return;}
      if(result.base64.length>2000000){toast("This bill image is still too large after compression. Try cropping closer to the bill.","error");return;}
      updateRow(id,{billImage:"data:image/jpeg;base64,"+result.base64});
    }catch{
      toast("Could not compress bill image. Please select it again.","error");
    }
  };

  const pickerValues=stockPicker==="category"
    ? (Array.isArray(stockCategories)?stockCategories:[]).map(x=>({id:String(x?.id||""),label:String(x?.name||"").trim()})).filter(x=>x.id&&x.label)
    : [...new Set((Array.isArray(stockInventory)?stockInventory:[]).map(x=>String(x?.size||"").trim()).filter(Boolean))]
      .sort((a,b)=>a.localeCompare(b,undefined,{numeric:true,sensitivity:"base"}))
      .map(x=>({id:x,label:x}));

  const filteredPicker=pickerValues.filter(x=>x.label.toLowerCase().includes(stockSearch.trim().toLowerCase()));
  const openPicker=(rowId:string,type:"category"|"size")=>{setStockPickerRow(rowId);setStockPicker(type);setStockSearch("");};
  const closePicker=()=>{setStockPicker(null);setStockSearch("");};

  const submit=()=>{
    if(!/^\d{4}-\d{2}-\d{2}$/.test(stockDate)){toast("Use YYYY-MM-DD for the date.","error");return;}
    if(!stockRows.length){toast("Add at least one stock item.","error");return;}
    for(const row of stockRows){
      if(!row.category.trim()){toast("Select a category for every item.","error");return;}
      if(Number(row.quantity)<=0){toast("Enter quantity above 0 for every item.","error");return;}
    }
    saveStock.mutate();
  };

  if(user?.role!=="admin"){
    return <View style={[styles.container,{paddingTop:insets.top}]}>
      <View style={styles.center}><Ionicons name="lock-closed-outline" size={44} color={colors.muted}/><Text style={styles.blocked}>Administrator only</Text></View>
    </View>;
  }

  return <View style={styles.container}>
    <View style={[styles.header,{paddingTop:insets.top+spacing.sm}]}>
      <View style={{flex:1}}>
        <Text style={styles.title}>Stock</Text>
        <Text style={styles.subTitle}>Receive Stock is the only stock-entry option</Text>
      </View>
      <Pressable onPress={openStock} style={styles.stockBtn}>
        <Ionicons name="cube-outline" size={18} color={colors.brandPrimary}/>
        <Text style={styles.stockBtnText}>Receive Stock</Text>
      </Pressable>
    </View>

    <ScrollView refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch}/>} contentContainerStyle={{padding:spacing.lg,paddingBottom:insets.bottom+spacing.xxl}}>
      <Text style={styles.sectionTitle}>Received Stock</Text>
      <Text style={[styles.stockHint,{marginBottom:spacing.md}]}>Each Save in Receive Stock creates a separate transaction. Only items saved together are grouped together.</Text>

      {isLoading?<View style={styles.centerBox}><ActivityIndicator size="large" color={colors.brandPrimary}/></View>:
       stockBatches.length?stockBatches.slice(0,100).map(batch=><View key={batch.batchId} style={styles.receivedCard}>
        <Text style={styles.meta}>Date</Text>
        <Text style={styles.receivedTitle}>{batch.addedDate||"—"}</Text>
        {batch.description?<><Text style={[styles.meta,{marginTop:spacing.sm}]}>Description</Text><Text style={styles.descriptionText}>{batch.description}</Text></>:null}

        {batch.items.map((s:any)=><View key={String(s.id)} style={styles.stockItem}>
          <View style={{flex:1}}>
            <Text style={styles.itemTitle}>{s.category||"Inventory item"}{s.size?" · "+s.size:""}</Text>
            <Text style={styles.meta}>Received {Number(s.quantity)||0} {s.unit||"pcs"}</Text>
          </View>
          <View style={styles.itemActions}>
            <Pressable onPress={()=>editReceipt(s)} hitSlop={8}><Ionicons name="create-outline" size={20} color={colors.brandPrimary}/></Pressable>
            <Pressable onPress={()=>deleteReceipt(s)} hitSlop={8}><Ionicons name="trash-outline" size={20} color={colors.error}/></Pressable>
          </View>
        </View>)}
      </View>):<View style={styles.receivedEmpty}><Text style={styles.meta}>No received stock yet.</Text></View>}
    </ScrollView>

    <Modal visible={stockModal} transparent animationType="slide" onRequestClose={()=>setStockModal(false)}>
      <View style={styles.overlay}><View style={[styles.sheet,{paddingBottom:insets.bottom+spacing.lg}]}>
        <View style={styles.sheetHead}>
          <View style={{flex:1}}>
            <Text style={styles.sheetTitle}>{editingReceipt?"Edit Received Stock":"Receive Stock"}</Text>
            <Text style={styles.stockHint}>Date and Description apply to this entire Receive Stock save.</Text>
          </View>
          <Pressable onPress={()=>setStockModal(false)}><Ionicons name="close" size={24} color={colors.onSurface}/></Pressable>
        </View>

        <ScrollView keyboardShouldPersistTaps="handled">
          <Text style={styles.fieldLabel}>Date</Text>
          <TextInput value={stockDate} onChangeText={setStockDate} placeholder="YYYY-MM-DD" placeholderTextColor={colors.muted} style={styles.stockInput}/>

          <Text style={styles.fieldLabel}>Description</Text>
          <TextInput value={description} onChangeText={setDescription} placeholder="Add description for this receiving transaction" placeholderTextColor={colors.muted} multiline textAlignVertical="top" style={[styles.stockInput,{minHeight:88,paddingTop:spacing.md}]}/>

          {stockRows.map((row,i)=><View key={row.id} style={styles.stockCard}>
            <View style={styles.stockCardHead}>
              <Text style={styles.stockCardTitle}>Stock item {i+1}</Text>
              {stockRows.length>1?<Pressable onPress={()=>setStockRows(v=>v.filter(x=>x.id!==row.id))}><Ionicons name="trash-outline" size={18} color={colors.error}/></Pressable>:null}
            </View>

            <Pressable style={styles.stockDrop} onPress={()=>openPicker(row.id,"category")}>
              <Text style={row.category?styles.stockDropText:styles.stockDropPlaceholder}>{row.category||"Select category"}</Text>
              <Ionicons name="chevron-down" size={18} color={colors.muted}/>
            </Pressable>

            <Pressable style={styles.stockDrop} onPress={()=>openPicker(row.id,"size")}>
              <Text style={row.size?styles.stockDropText:styles.stockDropPlaceholder}>{row.size||"Select size or search/new size"}</Text>
              <Ionicons name="search" size={17} color={colors.muted}/>
            </Pressable>

            <View style={{flexDirection:"row",gap:spacing.sm}}>
              <TextInput value={row.quantity} onChangeText={v=>updateRow(row.id,{quantity:v.replace(/[^0-9.]/g,"")})} placeholder="Quantity" keyboardType="number-pad" placeholderTextColor={colors.muted} style={[styles.stockInput,{flex:1}]}/>
              <TextInput value={row.minimumStock} onChangeText={v=>updateRow(row.id,{minimumStock:v.replace(/[^0-9.]/g,"")})} placeholder="Minimum stock" keyboardType="number-pad" placeholderTextColor={colors.muted} style={[styles.stockInput,{flex:1}]}/>
            </View>

            <Pressable style={styles.attachBtn} onPress={()=>pickBill(row.id)}>
              <Ionicons name={row.billImage?"checkmark-circle":"image-outline"} size={18} color={colors.brandPrimary}/>
              <Text style={styles.attachText}>{row.billImage?"Bill image selected":"Add bill image"}</Text>
            </Pressable>
          </View>)}

          {!editingReceipt?<Pressable style={styles.addAnotherStock} onPress={()=>setStockRows(v=>v.concat(newRow()))}>
            <Ionicons name="add-circle-outline" size={20} color={colors.brandPrimary}/><Text style={styles.attachText}>Add another item</Text>
          </Pressable>:null}

          <PrimaryButton title={editingReceipt?"Update Received Stock":"Save Receive Stock"} onPress={submit} loading={saveStock.isPending}/>
          <Pressable style={styles.cancel} onPress={()=>setStockModal(false)}><Text style={styles.cancelText}>Cancel</Text></Pressable>
        </ScrollView>
      </View></View>
    </Modal>

    <Modal visible={!!stockPicker} transparent animationType="fade" onRequestClose={closePicker}>
      <View style={styles.pickerOverlay}><View style={styles.pickerCard}>
        <View style={styles.sheetHead}>
          <Text style={styles.sheetTitle}>{stockPicker==="category"?"Select Category":"Select Size"}</Text>
          <Pressable onPress={closePicker}><Ionicons name="close" size={22} color={colors.onSurface}/></Pressable>
        </View>
        <View style={styles.pickerSearch}>
          <Ionicons name="search" size={18} color={colors.muted}/>
          <TextInput autoFocus value={stockSearch} onChangeText={setStockSearch} placeholder={stockPicker==="category"?"Search categories":"Search sizes"} placeholderTextColor={colors.muted} style={styles.pickerInput}/>
        </View>
        {stockSearch.trim()?<Pressable style={styles.newOption} onPress={async()=>{
          const term=stockSearch.trim();
          if(stockPicker==="category"){
            try{
              const cat=await api.post<any>("/inventory-categories",{name:term});
              updateRow(stockPickerRow,{categoryId:cat.id,category:cat.name});
              qc.invalidateQueries({queryKey:["inventory-categories"]});closePicker();
            }catch(e:any){toast(e?.message||"Could not create category.","error");}
          }else{updateRow(stockPickerRow,{size:term});closePicker();}
        }}>
          <Ionicons name="add-circle-outline" size={19} color={colors.brandPrimary}/>
          <Text style={styles.newOptionText}>Use “\${stockSearch.trim()}” as new {stockPicker}</Text>
        </Pressable>:null}
        <ScrollView keyboardShouldPersistTaps="handled" style={{maxHeight:360}}>
          {filteredPicker.length?filteredPicker.map(item=><Pressable key={String(item.id)} style={styles.pickerOption} onPress={()=>{
            updateRow(stockPickerRow,stockPicker==="category"?{categoryId:item.id,category:item.label}:{size:item.label});closePicker();
          }}>
            <Text style={styles.pickerOptionText}>{item.label}</Text><Ionicons name="chevron-forward" size={17} color={colors.muted}/>
          </Pressable>):<Text style={styles.pickerEmpty}>No saved {stockPicker} found.</Text>}
        </ScrollView>
      </View></View>
    </Modal>
  </View>;
}

const useStyles=makeStyles(colors=>({
  container:{flex:1,backgroundColor:colors.surfaceSecondary},
  header:{flexDirection:"row",alignItems:"center",justifyContent:"space-between",paddingHorizontal:spacing.lg,paddingBottom:spacing.md,backgroundColor:colors.surface,borderBottomWidth:1,borderBottomColor:colors.border,gap:spacing.sm},
  title:{fontFamily:fontFamily.bold,fontSize:fontSize.xxl,color:colors.onSurface},
  subTitle:{fontSize:fontSize.xs,color:colors.muted,marginTop:2},
  stockBtn:{height:40,borderRadius:radius.md,paddingHorizontal:spacing.sm,borderWidth:1,borderColor:colors.border,backgroundColor:colors.surfaceSecondary,flexDirection:"row",alignItems:"center",gap:spacing.xs},
  stockBtnText:{fontFamily:fontFamily.semibold,color:colors.brandPrimary,fontSize:fontSize.xs},
  sectionTitle:{fontFamily:fontFamily.bold,fontSize:fontSize.lg,color:colors.onSurface},
  receivedCard:{padding:spacing.md,borderWidth:1,borderColor:colors.border,borderRadius:radius.md,backgroundColor:colors.surface,marginBottom:spacing.sm},
  receivedTitle:{fontFamily:fontFamily.semibold,fontSize:fontSize.base,color:colors.onSurface},
  descriptionText:{fontSize:fontSize.sm,color:colors.onSurface,marginTop:3},
  stockItem:{flexDirection:"row",alignItems:"center",gap:spacing.sm,paddingVertical:spacing.sm,borderTopWidth:1,borderTopColor:colors.border,marginTop:spacing.sm},
  itemTitle:{fontFamily:fontFamily.semibold,fontSize:fontSize.base,color:colors.onSurface},
  itemActions:{flexDirection:"row",gap:spacing.md},
  meta:{fontSize:fontSize.xs,color:colors.muted,marginTop:3},
  receivedEmpty:{padding:spacing.md,borderWidth:1,borderColor:colors.border,borderRadius:radius.md,backgroundColor:colors.surface},
  overlay:{flex:1,backgroundColor:"rgba(15,23,42,0.4)",justifyContent:"flex-end"},
  sheet:{backgroundColor:colors.surface,borderTopLeftRadius:radius.lg,borderTopRightRadius:radius.lg,padding:spacing.lg,maxHeight:"92%"},
  sheetHead:{flexDirection:"row",alignItems:"center",justifyContent:"space-between",marginBottom:spacing.lg},
  sheetTitle:{fontFamily:fontFamily.bold,fontSize:fontSize.xl,color:colors.onSurface},
  stockHint:{fontSize:fontSize.xs,color:colors.muted,marginTop:2},
  fieldLabel:{fontFamily:fontFamily.semibold,fontSize:fontSize.sm,color:colors.onSurface,marginBottom:spacing.xs},
  stockCard:{padding:spacing.md,borderWidth:1,borderColor:colors.border,borderRadius:radius.md,backgroundColor:colors.surfaceSecondary,marginBottom:spacing.sm},
  stockCardHead:{flexDirection:"row",justifyContent:"space-between",alignItems:"center",marginBottom:spacing.sm},
  stockCardTitle:{fontFamily:fontFamily.semibold,color:colors.onSurface},
  stockDrop:{minHeight:48,borderWidth:1,borderColor:colors.border,borderRadius:radius.md,backgroundColor:colors.surface,paddingHorizontal:spacing.md,marginBottom:spacing.sm,flexDirection:"row",alignItems:"center",justifyContent:"space-between"},
  stockDropText:{color:colors.onSurface,fontFamily:fontFamily.medium},
  stockDropPlaceholder:{color:colors.muted},
  stockInput:{minHeight:48,borderWidth:1,borderColor:colors.border,borderRadius:radius.md,backgroundColor:colors.surface,paddingHorizontal:spacing.md,color:colors.onSurface,marginBottom:spacing.sm},
  attachBtn:{flexDirection:"row",alignItems:"center",justifyContent:"center",gap:spacing.xs,padding:spacing.md,borderWidth:1,borderColor:colors.border,borderRadius:radius.md,marginBottom:spacing.md},
  attachText:{fontFamily:fontFamily.semibold,color:colors.brandPrimary},
  addAnotherStock:{flexDirection:"row",alignItems:"center",justifyContent:"center",gap:spacing.xs,padding:spacing.md,borderWidth:1,borderColor:colors.border,borderRadius:radius.md,marginBottom:spacing.md},
  pickerOverlay:{flex:1,backgroundColor:"rgba(15,23,42,0.45)",justifyContent:"center",padding:spacing.lg},
  pickerCard:{backgroundColor:colors.surface,borderRadius:radius.lg,padding:spacing.lg,maxHeight:"78%"},
  pickerSearch:{flexDirection:"row",alignItems:"center",gap:spacing.sm,borderWidth:1,borderColor:colors.border,borderRadius:radius.md,paddingHorizontal:spacing.md,backgroundColor:colors.surfaceSecondary,marginBottom:spacing.sm},
  pickerInput:{flex:1,minHeight:44,color:colors.onSurface},
  newOption:{flexDirection:"row",alignItems:"center",gap:spacing.sm,padding:spacing.md,borderRadius:radius.sm,backgroundColor:colors.brandTertiary,marginBottom:spacing.xs},
  newOptionText:{flex:1,color:colors.brandPrimary,fontFamily:fontFamily.semibold},
  pickerOption:{flexDirection:"row",alignItems:"center",justifyContent:"space-between",padding:spacing.md,borderBottomWidth:1,borderBottomColor:colors.border},
  pickerOptionText:{color:colors.onSurface,fontFamily:fontFamily.medium},
  pickerEmpty:{padding:spacing.lg,textAlign:"center",color:colors.muted},
  cancel:{alignItems:"center",padding:spacing.md},
  cancelText:{fontFamily:fontFamily.semibold,color:colors.muted},
  center:{flex:1,alignItems:"center",justifyContent:"center",gap:spacing.md},
  centerBox:{height:260,alignItems:"center",justifyContent:"center"},
  blocked:{fontFamily:fontFamily.bold,fontSize:fontSize.lg,color:colors.onSurface}
}));