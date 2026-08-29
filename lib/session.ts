// NOT real authentication. One shared password lives in APP_PASSWORD and every
// signed-in visitor is the same session; nothing here stores or checks a
// per-user credential. It exists so the console is gated and the login screen
// is honest about doing something. Replace with a real provider (the empty
// neon_auth schema is already provisioned for it) before this is more than a
// demo.
//
// Web Crypto rather than node:crypto so the same module works in middleware,
// which runs on the Edge runtime.

export const COOKIE_NAME = "helicon_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();

function hmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(process.env.SESSION_SECRET ?? ""),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

const toHex = (buf: ArrayBuffer) =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

const fromHex = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));

export async function issue(userId: string): Promise<string> {
  const payload = `${userId}.${Date.now() + SESSION_TTL_MS}`;
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(), encoder.encode(payload));
  return `${payload}.${toHex(mac)}`;
}

export async function verify(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  const [userId, expiry, mac] = token.split(".");
  if (!userId || !expiry || !mac || !/^[0-9a-f]+$/.test(mac)) return null;
  // subtle.verify does the comparison in constant time.
  const ok = await crypto.subtle.verify(
    "HMAC", await hmacKey(), fromHex(mac), encoder.encode(`${userId}.${expiry}`)
  );
  if (!ok || Number(expiry) < Date.now()) return null;
  return userId;
}
