// Password hashing using PBKDF2 (Web Crypto API, available in the Convex runtime).
// Format: pbkdf2$<iterations>$<saltBase64>$<hashBase64>
// Legacy records are bare hex SHA-256(password + "|navytrack_v1") from the old client-side scheme.

const enc = new TextEncoder();
const PBKDF2_ITERATIONS = 100_000;
const LEGACY_SALT = "|navytrack_v1";

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(str: string): Uint8Array {
  const bin = atob(str);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

// Constant-time comparison of two byte arrays.
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// Constant-time comparison of two hex strings of equal length.
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number, bits: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as unknown as ArrayBuffer, iterations, hash: "SHA-256" },
    key,
    bits,
  );
  return new Uint8Array(derived);
}

async function legacyHash(password: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(password + LEGACY_SALT));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export function isLegacyHash(stored: string): boolean {
  return !stored.startsWith("pbkdf2$");
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS, 256);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toB64(salt)}$${toB64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (stored.startsWith("pbkdf2$")) {
    const parts = stored.split("$");
    if (parts.length !== 4) return false;
    const iterations = parseInt(parts[1], 10);
    const salt = fromB64(parts[2]);
    const expected = fromB64(parts[3]);
    if (!iterations || !salt.length || !expected.length) return false;
    const actual = await pbkdf2(password, salt, iterations, expected.length * 8);
    return timingSafeEqual(actual, expected);
  }
  // Legacy hex SHA-256 scheme.
  const legacy = await legacyHash(password);
  return timingSafeEqualStr(legacy, stored);
}
