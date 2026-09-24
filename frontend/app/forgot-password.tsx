import { router } from "expo-router";
import { useState } from "react";
import { Text, View, Pressable } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useAuth } from "@/src/auth/AuthContext";
import { Field } from "@/src/components/Field";
import { PrimaryButton } from "@/src/components/PrimaryButton";
import { useToast } from "@/src/components/toast";
import { fontFamily,fontSize,makeStyles,spacing,useTheme } from "@/src/theme";

export default function ForgotPassword(){
 const styles=useStyles(),{colors}=useTheme(),insets=useSafeAreaInsets(),{resetPassword}=useAuth(),toast=useToast();
 const [email,setEmail]=useState(""),[code,setCode]=useState(""),[password,setPassword]=useState(""),[loading,setLoading]=useState(false);
 const submit=async()=>{if(password.length<6){toast("Password must be at least 6 characters.","error");return;}setLoading(true);try{await resetPassword(email,code,password);toast("Password reset successfully.","success");router.replace("/login");}catch(e:any){toast(e?.message||"Could not reset password.","error");}finally{setLoading(false);}};
 return <View style={styles.container}><KeyboardAwareScrollView contentContainerStyle={[styles.scroll,{paddingTop:insets.top+spacing.xxl,paddingBottom:insets.bottom+spacing.xl}]} keyboardShouldPersistTaps="handled">
 <Text style={styles.title}>Forgot Password</Text><Text style={styles.subtitle}>Use the recovery code provided when your account was created.</Text>
 <Field label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" placeholder="you@hospital.com"/>
 <Field label="Recovery Code" value={code} onChangeText={setCode} keyboardType="number-pad" placeholder="8-digit code"/>
 <Field label="New Password" value={password} onChangeText={setPassword} secureTextEntry placeholder="At least 6 characters"/>
 <PrimaryButton title="Reset Password" onPress={submit} loading={loading}/>
 <Pressable onPress={()=>router.replace("/login")} style={styles.back}><Text style={styles.link}>Back to login</Text></Pressable>
 </KeyboardAwareScrollView></View>;
}
const useStyles=makeStyles(colors=>({container:{flex:1,backgroundColor:colors.surface},scroll:{flexGrow:1,justifyContent:"center",paddingHorizontal:spacing.xl},title:{fontFamily:fontFamily.bold,fontSize:fontSize.xxl,color:colors.onSurface,textAlign:"center"},subtitle:{fontFamily:fontFamily.regular,fontSize:fontSize.base,color:colors.muted,textAlign:"center",marginVertical:spacing.xl},back:{alignItems:"center",padding:spacing.lg},link:{fontFamily:fontFamily.bold,color:colors.brandPrimary,fontSize:fontSize.base}}));
