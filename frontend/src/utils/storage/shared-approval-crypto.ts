import nacl from "tweetnacl";

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes).map((value) => value.toString(16).padStart(2, "0")).join("");

const fromHex = (value: string): Uint8Array => {
  const hex = String(value || "").trim();
  if (!hex || hex.length % 2 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error("The shared approval signing key is invalid.");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

export function createSharedApprovalKeyPair(): { publicKey: string; secretKey: string } {
  const pair = nacl.sign.keyPair();
  return { publicKey: toHex(pair.publicKey), secretKey: toHex(pair.secretKey) };
}

export function signSharedApprovalPayload(payload: unknown, secretKey: string): string {
  const message = new TextEncoder().encode(JSON.stringify(payload));
  return toHex(nacl.sign.detached(message, fromHex(secretKey)));
}

export function verifySharedApprovalPayload(payload: unknown, signature: string, publicKey: string): boolean {
  try {
    const message = new TextEncoder().encode(JSON.stringify(payload));
    return nacl.sign.detached.verify(message, fromHex(signature), fromHex(publicKey));
  } catch {
    return false;
  }
}
