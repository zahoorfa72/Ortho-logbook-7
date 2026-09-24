import * as Crypto from "expo-crypto";
import { storage } from "@/src/utils/storage";

const PIN_KEY = "ortho_admin_pin_hash";

async function hashPin(pin: string) {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `ortho-admin-pin:${pin}`);
}

export async function hasAdminPin(): Promise<boolean> {
  const raw = await storage.secureGet<string>(PIN_KEY, "");
  return typeof raw === "string" && raw.length > 0;
}

export async function setAdminPin(pin: string): Promise<void> {
  if (!/^\d{4,6}$/.test(pin)) throw new Error("PIN must be 4 to 6 digits.");
  const hash = await hashPin(pin);
  await storage.secureSet(PIN_KEY, hash);
}

export async function verifyAdminPin(pin: string): Promise<boolean> {
  const stored = await storage.secureGet<string>(PIN_KEY, "");
  if (!stored) return false;
  const hash = await hashPin(pin);
  return hash === stored;
}

export async function clearAdminPin(): Promise<void> {
  await storage.secureRemove(PIN_KEY);
}
