// Stateless session tokens: v1.<base64url(payload)>.<base64url(HMAC-SHA256)>.

export interface Session {
  deviceId: string;
  displayName: string;
  exp: number; // epoch ms
}

export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function sessionKeyMaterial(env: Pick<Env, "ACCESS_CODE" | "SESSION_SECRET">): string {
  const k = env.SESSION_SECRET || env.ACCESS_CODE;
  if (!k) throw new Error("ACCESS_CODE (or SESSION_SECRET) is not configured");
  return `pwd-session:${k}`;
}

async function hmacKey(material: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(material), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signSession(env: Pick<Env, "ACCESS_CODE" | "SESSION_SECRET">, s: Session): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({ d: s.deviceId, n: s.displayName, exp: s.exp })));
  const key = await hmacKey(sessionKeyMaterial(env));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`v1.${payload}`)));
  return `v1.${payload}.${b64url(sig)}`;
}

export async function verifySession(env: Pick<Env, "ACCESS_CODE" | "SESSION_SECRET">, token: string | null | undefined): Promise<Session | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  try {
    const key = await hmacKey(sessionKeyMaterial(env));
    // crypto.subtle.verify is constant-time with respect to the signature.
    const ok = await crypto.subtle.verify("HMAC", key, fromB64url(parts[2]), enc.encode(`v1.${parts[1]}`));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(fromB64url(parts[1]))) as { d: string; n: string; exp: number };
    if (typeof p.d !== "string" || !DEVICE_ID_RE.test(p.d) || typeof p.exp !== "number" || p.exp < Date.now()) return null;
    return { deviceId: p.d, displayName: typeof p.n === "string" ? p.n : "Wizard", exp: p.exp };
  } catch {
    return null;
  }
}

/** Constant-time string comparison: hash both sides, then compare the fixed-length digests. */
export async function secretEquals(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (x: ArrayBuffer, y: ArrayBuffer) => boolean };
  if (subtle.timingSafeEqual) return subtle.timingSafeEqual(ha, hb);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export function cleanDisplayName(input: unknown, deviceId: string): string {
  const raw = typeof input === "string" ? input.replace(/[\u0000-\u001f\u007f]/g, "").trim().replace(/\s+/g, " ") : "";
  if (raw.length >= 1) return raw.slice(0, 24);
  return `Wizard-${deviceId.replace(/[^A-Za-z0-9]/g, "").slice(0, 4) || "0000"}`;
}

export function bearer(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}
