import { p256 } from "@noble/curves/nist.js";
import { bytesToHex, hexToBytes } from "@noble/curves/utils.js";

/**
 * Deterministic JSON serialization - ensures same object always produces same string
 */
function canonicalJSON(obj: unknown): string {
  if (obj === null || obj === undefined) {
    return JSON.stringify(obj);
  }
  
  if (typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  
  if (Array.isArray(obj)) {
    return "[" + obj.map(canonicalJSON).join(",") + "]";
  }
  
  // Sort keys to ensure deterministic order
  const sortedKeys = Object.keys(obj).sort();
  const sortedObj: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    sortedObj[key] = (obj as Record<string, unknown>)[key];
  }
  
  return "{" + sortedKeys.map(key => `${JSON.stringify(key)}:${canonicalJSON(sortedObj[key])}`).join(",") + "}";
}

/**
 * Convert base64url to hex
 */
function base64UrlToHex(base64url: string): string {
  let base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytesToHex(bytes);
}

/**
 * Convert hex to base64url
 */
function hexToBase64Url(hex: string): string {
  const bytes = hexToBytes(hex);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * Convert SPKI (SubjectPublicKeyInfo) format to noble curves format
 * SPKI format: 0x30 [total length] 0x30 [algorithm length] 0x06 [OID length] [OID] 0x07 [key type] 0x03 [bitstring length] 0x00 [unused bits] [key data]
 * For P-256, the key data is 65 bytes: 0x04 [x (32 bytes)] [y (32 bytes)]
 */
function spkiToPublicKey(spkiBytes: Uint8Array): { x: bigint; y: bigint } {
  // SPKI structure for P-256:
  // 30 59 30 13 06 07 2a 86 48 ce 3d 02 01 06 08 2a 86 48 ce 3d 03 01 07 03 42 00 04 [65 bytes of key]
  // The last 65 bytes contain: 0x04 (uncompressed point marker) + 32 bytes X + 32 bytes Y
  
  if (spkiBytes.length < 91) {
    throw new Error("Invalid SPKI format: too short");
  }
  
  // Find the key data (last 65 bytes)
  const keyData = spkiBytes.slice(-65);
  if (keyData[0] !== 0x04) {
    throw new Error("Invalid SPKI format: expected uncompressed point");
  }
  
  const xBytes = keyData.slice(1, 33);
  const yBytes = keyData.slice(33, 65);
  
  const x = BigInt("0x" + bytesToHex(xBytes));
  const y = BigInt("0x" + bytesToHex(yBytes));
  
  return { x, y };
}

/**
 * Convert private key from PKCS#8 format to noble curves format
 * PKCS#8 format: 0x30 [total length] 0x02 0x01 [version] 0x04 [octet string length] [private key bytes]
 * For P-256, the private key is 32 bytes
 */
function pkcs8ToPrivateKey(pkcs8Bytes: Uint8Array): bigint {
  // Find the private key octet string
  // Skip: 30 [total] 02 01 00 04 [octet length]
  let offset = 0;
  if (pkcs8Bytes[offset++] !== 0x30) throw new Error("Invalid PKCS#8 format");
  offset++; // skip total length
  if (pkcs8Bytes[offset++] !== 0x02) throw new Error("Invalid PKCS#8 format");
  if (pkcs8Bytes[offset++] !== 0x01) throw new Error("Invalid PKCS#8 format");
  offset++; // skip version
  if (pkcs8Bytes[offset++] !== 0x04) throw new Error("Invalid PKCS#8 format");
  const keyLength = pkcs8Bytes[offset++];
  
  const keyBytes = pkcs8Bytes.slice(offset, offset + keyLength);
  return BigInt("0x" + bytesToHex(keyBytes));
}

/**
 * Convert public key point to SPKI format
 */
function publicKeyToSpki(x: bigint, y: bigint): Uint8Array {
  // P-256 OID: 1.2.840.10045.3.1.7 = 2a 86 48 ce 3d 03 01 07
  // Algorithm OID: 1.2.840.10045.2.1 = 2a 86 48 ce 3d 02 01
  // SPKI structure:
  // 30 59 - SEQUENCE (89 bytes total)
  //   30 13 - SEQUENCE (19 bytes algorithm)
  //     06 07 - OID (7 bytes) 2a 86 48 ce 3d 02 01
  //     06 08 - OID (8 bytes) 2a 86 48 ce 3d 03 01 07
  //   03 42 - BIT STRING (66 bytes)
  //     00 - unused bits
  //     04 [x (32 bytes)] [y (32 bytes)] - uncompressed point
  
  const xHex = x.toString(16).padStart(64, "0");
  const yHex = y.toString(16).padStart(64, "0");
  const xBytes = hexToBytes(xHex);
  const yBytes = hexToBytes(yHex);
  
  const pointBytes = new Uint8Array(65);
  pointBytes[0] = 0x04; // uncompressed point marker
  pointBytes.set(xBytes, 1);
  pointBytes.set(yBytes, 33);
  
  // Build SPKI
  const spki = new Uint8Array(91);
  let offset = 0;
  
  // Outer sequence (89 bytes)
  spki[offset++] = 0x30;
  spki[offset++] = 0x59;
  
  // Algorithm sequence (19 bytes)
  spki[offset++] = 0x30;
  spki[offset++] = 0x13;
  
  // Algorithm OID (7 bytes)
  spki[offset++] = 0x06;
  spki[offset++] = 0x07;
  spki.set([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01], offset);
  offset += 7;
  
  // Curve OID (8 bytes)
  spki[offset++] = 0x06;
  spki[offset++] = 0x08;
  spki.set([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07], offset);
  offset += 8;
  
  // Bit string (66 bytes)
  spki[offset++] = 0x03;
  spki[offset++] = 0x42;
  spki[offset++] = 0x00; // unused bits
  spki.set(pointBytes, offset);
  
  return spki;
}

export type HostKeyPair = {
  privateKey: Uint8Array;
  publicKey: { x: bigint; y: bigint };
  publicKeyString: string;
};

/**
 * Generate a new ECDSA P-256 key pair
 */
export async function generateHostKeyPair(): Promise<HostKeyPair> {
  const privateKey = p256.utils.randomSecretKey();
  const publicKey = p256.getPublicKey(privateKey, false); // false = uncompressed
  
  // Extract x and y from public key (first byte is 0x04, then 32 bytes x, 32 bytes y)
  const pubKeyHex = bytesToHex(publicKey);
  const x = BigInt("0x" + pubKeyHex.slice(2, 66));
  const y = BigInt("0x" + pubKeyHex.slice(66, 130));
  
  const spki = publicKeyToSpki(x, y);
  
  // Convert to base64url
  let binary = "";
  for (let i = 0; i < spki.length; i++) {
    binary += String.fromCharCode(spki[i]!);
  }
  const publicKeyString = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  
  console.log("[DEBUG ECDSA] Generated key pair", { 
    privateKeyLength: privateKey.length,
    publicKeyString: publicKeyString.substring(0, 50) + "...",
    x: x.toString(16).substring(0, 20) + "...",
    y: y.toString(16).substring(0, 20) + "..."
  });
  
  return {
    privateKey,
    publicKey: { x, y },
    publicKeyString,
  };
}

/**
 * Import a public key from base64url SPKI format
 */
export function importHostPublicKey(publicKeyString: string): { x: bigint; y: bigint } {
  // Convert base64url to bytes
  let base64 = publicKeyString.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  
  return spkiToPublicKey(bytes);
}

/**
 * Hash a message using SHA-256
 */
async function sha256(message: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", message));
}

/**
 * Sign a payload with a private key
 */
export async function signPayload(privateKey: Uint8Array, payload: object): Promise<string> {
  const message = canonicalJSON(payload);
  console.log("[DEBUG ECDSA] Signing payload", { message, payload });
  const messageBytes = new TextEncoder().encode(message);
  const messageHash = await sha256(messageBytes);
  console.log("[DEBUG ECDSA] Message hash", { hashHex: bytesToHex(messageHash).substring(0, 20) + "..." });
  
  const signature = p256.sign(messageHash, privateKey);
  console.log("[DEBUG ECDSA] Signature object", { 
    type: typeof signature,
    isUint8Array: signature instanceof Uint8Array,
    hasToCompactRawBytes: typeof (signature as any).toCompactRawBytes,
    length: signature.length
  });
  // Signature is already a Uint8Array in compact format (64 bytes)
  const signatureBytes = signature;
  console.log("[DEBUG ECDSA] Signature created", { 
    signatureLength: signatureBytes.length,
    signatureHex: bytesToHex(signatureBytes).substring(0, 20) + "..." 
  });
  
  const signatureBase64 = hexToBase64Url(bytesToHex(signatureBytes));
  console.log("[DEBUG ECDSA] Signature base64url", { signatureBase64: signatureBase64.substring(0, 30) + "..." });
  return signatureBase64;
}

/**
 * Verify a signature with a public key
 */
export async function verifyHostSignature(
  publicKey: { x: bigint; y: bigint },
  payload: object,
  signature: string
): Promise<boolean> {
  try {
    const message = canonicalJSON(payload);
    console.log("[DEBUG ECDSA] Verifying signature", { message, payload, signature: signature.substring(0, 30) + "..." });
    const messageBytes = new TextEncoder().encode(message);
    const messageHash = await sha256(messageBytes);
    console.log("[DEBUG ECDSA] Message hash for verification", { hashHex: bytesToHex(messageHash).substring(0, 20) + "..." });
    
    const signatureBytes = hexToBytes(base64UrlToHex(signature));
    console.log("[DEBUG ECDSA] Signature bytes", { 
      signatureLength: signatureBytes.length,
      signatureHex: bytesToHex(signatureBytes).substring(0, 20) + "..." 
    });
    
    // Reconstruct public key bytes from x and y coordinates
    // Format: 0x04 (uncompressed marker) + 32 bytes x + 32 bytes y
    const xHex = publicKey.x.toString(16).padStart(64, "0");
    const yHex = publicKey.y.toString(16).padStart(64, "0");
    const xBytes = hexToBytes(xHex);
    const yBytes = hexToBytes(yHex);
    
    const publicKeyBytes = new Uint8Array(65);
    publicKeyBytes[0] = 0x04; // uncompressed point marker
    publicKeyBytes.set(xBytes, 1);
    publicKeyBytes.set(yBytes, 33);
    
    console.log("[DEBUG ECDSA] Public key bytes reconstructed", { 
      x: publicKey.x.toString(16).substring(0, 20) + "...",
      y: publicKey.y.toString(16).substring(0, 20) + "...",
      publicKeyLength: publicKeyBytes.length
    });
    
    const isValid = p256.verify(signatureBytes, messageHash, publicKeyBytes);
    console.log("[DEBUG ECDSA] Verification result", { isValid });
    return isValid;
  } catch (error) {
    console.error("[DEBUG ECDSA] Signature verification error", error);
    return false;
  }
}

