import { useQuery } from "@tanstack/react-query";
import { useFocusEffect } from "expo-router";
import { useCallback } from "react";
import { ActivityIndicator, FlatList, RefreshControl, Text, View } from "react-native";
import Ionicons from "@react-native-vector-icons/ionicons";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api } from "@/src/api/client";
import { useAuth } from "@/src/auth/AuthContext";
import { EmptyState } from "@/src/components/EmptyState";
import { formatInventoryLabel } from "@/src/utils/inventory-label";
import { fontFamily, fontSize, makeStyles, radius, spacing, useTheme } from "@/src/theme";

type Detail = {
  id:string; inventoryId:string; type:string; amount:number; quantityAfter:number; note:string;
  createdAt:string; name:string; category:string; size:string; unit:string; userName:string;
};

export default function NewInventory() {
  const styles=useStyles();
  const {colors}=useTheme();
  const insets=useSafeAreaInsets();
  const {user}=useAuth();
  const query=useQuery<Detail[]>({
    queryKey:["inventory-details"],
    queryFn:()=>api.get<Detail[]>("/inventory-details"),
    enabled:user?.role==="admin",
  });
  useFocusEffect(useCallback(()=>{ if(user?.role==="admin") query.refetch(); },[user?.role]));

  if(user?.role!=="admin") return <View style={styles.container}><View style={[styles.header,{paddingTop:insets.top+spacing.sm}]}><Text style={styles.title}>New Inventory</Text></View><View style={styles.center}><Ionicons name="lock-closed-outline" size={44} color={colors.muted}/><Text style={styles.blocked}>Administrator only</Text></View></View>;

  return <View style={styles.container}>
    <View style={[styles.header,{paddingTop:insets.top+spacing.sm}]}>
      <Text style={styles.title}>New Inventory</Text>
      <Text style={styles.subtitle}>Details linked directly to new and increased stock in Inventory</Text>
    </View>
    {query.isLoading ? <View style={styles.center}><ActivityIndicator size="large" color={colors.brandPrimary}/></View> :
      query.isError ? <View style={styles.center}><EmptyState icon="alert-circle-outline" title="Could not load inventory details" subtitle="Pull to retry."/></View> :
      <FlatList data={query.data||[]} keyExtractor={x=>x.id}
        refreshControl={<RefreshControl refreshing={query.isRefetching} onRefresh={()=>query.refetch()} tintColor={colors.brandPrimary}/>}
        contentContainerStyle={{padding:spacing.lg,paddingBottom:insets.bottom+spacing.xxl,flexGrow:1}}
        ListEmptyComponent={<EmptyState icon="cube-outline" title="No new inventory activity" subtitle="Add a new item or increase stock in the Inventory tab. Its detail will appear here automatically."/>}
        renderItem={({item})=><View style={styles.card}>
          <View style={styles.icon}><Ionicons name={item.type==="purchase"?"add-circle-outline":"trending-up-outline"} size={23} color={colors.brandPrimary}/></View>
          <View style={{flex:1}}>
            <Text style={styles.name}>{formatInventoryLabel(item.category,item.name,item.size)}</Text>
            <Text style={styles.meta}>{item.type==="purchase"?"New item / stock received":"Stock increased"} · +{item.amount} {item.unit}</Text>
            <Text style={styles.meta}>Available after: {item.quantityAfter} {item.unit}</Text>
            <Text style={styles.meta}>{new Date(item.createdAt).toLocaleString()} · {item.userName}</Text>
            {item.note ? <Text style={styles.note}>{item.note}</Text> : null}
          </View>
        </View>}
      />}
  </View>;
}
const useStyles=makeStyles(colors=>({
  container:{flex:1,backgroundColor:colors.surfaceSecondary},
  header:{paddingHorizontal:spacing.lg,paddingBottom:spacing.md,backgroundColor:colors.surface,borderBottomWidth:1,borderBottomColor:colors.border},
  title:{fontFamily:fontFamily.bold,fontSize:fontSize.xxl,color:colors.onSurface},
  subtitle:{fontFamily:fontFamily.regular,fontSize:fontSize.sm,color:colors.muted,marginTop:3},
  card:{flexDirection:"row",gap:spacing.md,padding:spacing.lg,marginBottom:spacing.sm,borderRadius:radius.md,borderWidth:1,borderColor:colors.border,backgroundColor:colors.surface},
  icon:{width:42,height:42,borderRadius:21,backgroundColor:colors.brandTertiary,alignItems:"center",justifyContent:"center"},
  name:{fontFamily:fontFamily.semibold,fontSize:fontSize.base,color:colors.onSurface},
  meta:{fontFamily:fontFamily.regular,fontSize:fontSize.sm,color:colors.muted,marginTop:3},
  note:{fontFamily:fontFamily.medium,fontSize:fontSize.sm,color:colors.onSurface,marginTop:5},
  center:{flex:1,alignItems:"center",justifyContent:"center",padding:spacing.xl,gap:spacing.md},
  blocked:{fontFamily:fontFamily.bold,fontSize:fontSize.lg,color:colors.onSurface},
}));