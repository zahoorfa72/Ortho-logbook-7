import React, { createContext, useContext, useEffect, useState } from "react";
import * as Crypto from "expo-crypto";
import { queryClient } from "@/src/query-client";
import { storage } from "@/src/utils/storage";
import { db, initializeDatabase } from "@/src/db/database";

export type User = { id: string; email: string; name: string; role: "admin" | "doctor" | "staff"; canEditPatients: boolean };
type AuthState = {
  user: User | null; initializing: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (name: string, email: string, password: string) => Promise<string>;
  resetPassword: (email: string, recoveryCode: string, newPassword: string) => Promise<void>;
  logout: () => Promise<void>;
};
const AuthContext = createContext<AuthState | undefined>(undefined);
export const CURRENT_USER_KEY = "ortho_current_user";

const id = () => Crypto.randomUUID();
async function hashPassword(password: string, salt: string) {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${salt}:${password}`);
}
const toUser = (r: any): User => ({
  id: r.id, email: r.email, name: r.name,
  role: (r.role || "doctor") as User["role"],
  canEditPatients: Number(r.can_edit_patients ?? 1) === 1,
});
function getUserById(userId: string) {
  return db.getFirstSync<any>(`SELECT id,email,name,role,can_edit_patients FROM users WHERE id=? AND disabled=0 LIMIT 1`, [userId]) ? toUser(db.getFirstSync<any>(`SELECT id,email,name,role,can_edit_patients FROM users WHERE id=? AND disabled=0 LIMIT 1`, [userId])) : null;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [initializing, setInitializing] = useState(true);
  useEffect(() => {
    (async () => {
      try {
        initializeDatabase();
        const saved = await storage.secureGet(CURRENT_USER_KEY, null);
        if (typeof saved === "string" && saved) {
          const restored = getUserById(saved);
          if (restored) setUser(restored);
          else await storage.secureRemove(CURRENT_USER_KEY);
        }
      } catch (e) {
        console.error("[auth] startup restore failed:", e);
        setUser(null);
        try { await storage.secureRemove(CURRENT_USER_KEY); } catch {}
      } finally {
        setInitializing(false);
      }
    })();
  }, []);

  const signup = async (name: string, email: string, password: string) => {
    initializeDatabase();
    const cleanName=name.trim(), cleanEmail=email.trim().toLowerCase();
    if (!cleanName || !cleanEmail || !password) throw new Error("Please fill in all fields.");
    // Public signup is only allowed for the very first account (bootstrap admin).
    // Once an admin exists, further accounts can only be created by an admin from User Management.
    const adminExists = Number(db.getFirstSync<any>("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND disabled=0")?.n || 0) > 0;
    if (adminExists) throw new Error("Sign-up is disabled. Ask your administrator to create an account for you.");
    if (db.getFirstSync<any>("SELECT id FROM users WHERE email=? LIMIT 1",[cleanEmail])) throw new Error("An account with this email already exists.");
    const userId=id(), salt=id(), recoveryCode=String(Math.floor(10000000+Math.random()*90000000));
    const passwordHash=await hashPassword(password,salt);
    db.runSync(`INSERT INTO users (id,email,name,password_hash,recovery_code,role,can_edit_patients,created_at) VALUES (?,?,?,?,?,?,?,?)`,
      [userId,cleanEmail,cleanName,`${salt}:${passwordHash}`,recoveryCode,"admin",1,new Date().toISOString()]);
    await storage.secureSet(CURRENT_USER_KEY,userId);
    setUser({id:userId,email:cleanEmail,name:cleanName,role:"admin",canEditPatients:true});
    return recoveryCode;
  };

  const login = async (email:string,password:string) => {
    initializeDatabase();
    const r=db.getFirstSync<any>("SELECT id,email,name,password_hash,role,can_edit_patients FROM users WHERE email=? AND disabled=0 LIMIT 1",[email.trim().toLowerCase()]);
    if(!r) throw new Error("Invalid email or password.");
    const s=r.password_hash.indexOf(":");
    if(s<=0) throw new Error("Invalid account password data.");
    const hash=await hashPassword(password,r.password_hash.slice(0,s));
    if(hash!==r.password_hash.slice(s+1)) throw new Error("Invalid email or password.");
    const u=toUser(r); await storage.secureSet(CURRENT_USER_KEY,u.id); setUser(u);
  };

  const resetPassword = async (email:string, recoveryCode:string, newPassword:string) => {
    initializeDatabase();
    if(newPassword.length<6) throw new Error("Password must be at least 6 characters.");
    const r=db.getFirstSync<any>("SELECT id,recovery_code FROM users WHERE email=? AND disabled=0 LIMIT 1",[email.trim().toLowerCase()]);
    if(!r || !r.recovery_code || String(r.recovery_code)!==recoveryCode.trim()) throw new Error("Invalid email or recovery code.");
    const salt=id(), hash=await hashPassword(newPassword,salt);
    db.runSync("UPDATE users SET password_hash=? WHERE id=?",[salt+":"+hash,r.id]);
  };

  const logout = async () => { await storage.secureRemove(CURRENT_USER_KEY); setUser(null); queryClient.clear(); };
  return <AuthContext.Provider value={{user,initializing,login,signup,resetPassword,logout}}>{children}</AuthContext.Provider>;
}
export function useAuth(){ const ctx=useContext(AuthContext); if(!ctx) throw new Error("useAuth must be used within AuthProvider"); return ctx; }
