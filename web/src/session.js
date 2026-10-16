// Encrypted, stateless cookie sessions. The cookie holds the student's GitHub
// user token, sealed with AES-GCM under a key derived from SESSION_SECRET, so
// the Worker needs no database.

const COOKIE = "booker_session";
const STATE_COOKIE = "booker_oauth_state";
const SESSION_MAX_AGE = 60 * 60 * 24 * 180; // GitHub refresh tokens last ~6 months.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function b64urlEncode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(text) {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function sessionKey(secret) {
  if (!secret || secret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters.");
  }
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(data, secret) {
  const key = await sessionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(data))),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64urlEncode(out);
}

export async function unseal(token, secret) {
  try {
    const raw = b64urlDecode(token);
    const key = await sessionKey(secret);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, key, raw.slice(12));
    return JSON.parse(decoder.decode(pt));
  } catch {
    return null;
  }
}

export function readCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

function cookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export async function loadSession(request, env) {
  const token = readCookie(request, COOKIE);
  return token ? unseal(token, env.SESSION_SECRET) : null;
}

export async function sessionCookie(session, env) {
  return cookie(COOKIE, await seal(session, env.SESSION_SECRET), SESSION_MAX_AGE);
}

export function clearSessionCookie() {
  return cookie(COOKIE, "", 0);
}

export function stateCookie(state) {
  return cookie(STATE_COOKIE, state, 600);
}

export function clearStateCookie() {
  return cookie(STATE_COOKIE, "", 0);
}

export function readState(request) {
  return readCookie(request, STATE_COOKIE);
}
