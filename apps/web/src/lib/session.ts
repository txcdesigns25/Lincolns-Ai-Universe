// Runs in both Edge (middleware) and Node. Uses Web Crypto only.
const enc = new TextEncoder();
export const SESSION_COOKIE = "au_session";
const MAX_AGE_S = 60 * 60 * 24 * 14;

async function hmac(data: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET must be set (32+ chars)");
  return s;
}

export async function createSessionToken() {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE_S;
  const payload = `owner.${exp}`;
  return `${payload}.${await hmac(payload, secret())}`;
}

export async function verifySessionToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const [who, exp, sig] = token.split(".");
  if (who !== "owner" || !exp || !sig) return false;
  if (Number(exp) < Date.now() / 1000) return false;
  const expected = await hmac(`${who}.${exp}`, secret());
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export const SESSION_MAX_AGE = MAX_AGE_S;
