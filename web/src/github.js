// Minimal GitHub REST client: user OAuth tokens, GitHub App JWTs, and the
// handful of endpoints the booker site needs.

import { b64urlEncode } from "./session.js";

const API = "https://api.github.com";
const encoder = new TextEncoder();

export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function gh(token, path, { method = "GET", body, scheme = "Bearer" } = {}) {
  const res = await fetch(path.startsWith("http") ? path : API + path, {
    method,
    headers: {
      Authorization: `${scheme} ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "hku-room-booker-web",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new GitHubError(res.status, data?.message || `GitHub API ${res.status}`);
  return data;
}

// ---- User OAuth (GitHub App user-to-server tokens) ----

async function tokenRequest(env, params) {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "hku-room-booker-web" },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, ...params }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new GitHubError(401, data.error_description || data.error || "OAuth failed");
  return {
    t: data.access_token,
    r: data.refresh_token || null,
    // Apps with token expiry disabled return no expires_in; those tokens never expire.
    e: data.expires_in ? Date.now() + data.expires_in * 1000 : null,
  };
}

export function exchangeCode(env, code, redirectUri) {
  return tokenRequest(env, { code, redirect_uri: redirectUri });
}

export function refreshUserToken(env, refreshToken) {
  return tokenRequest(env, { grant_type: "refresh_token", refresh_token: refreshToken });
}

// ---- GitHub App auth ----

function derLength(n) {
  if (n < 0x80) return [n];
  const bytes = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

function der(tag, content) {
  return Uint8Array.from([tag, ...derLength(content.length), ...content]);
}

// GitHub hands out PKCS#1 keys ("BEGIN RSA PRIVATE KEY"); WebCrypto only
// imports PKCS#8, so wrap the PKCS#1 body in a PKCS#8 envelope.
export function pemToPkcs8(pem) {
  const isPkcs1 = pem.includes("BEGIN RSA PRIVATE KEY");
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const raw = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  if (!isPkcs1) return raw;
  const version = [0x02, 0x01, 0x00];
  const rsaAlgorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octets = der(0x04, raw);
  return der(0x30, [...version, ...rsaAlgorithm, ...octets]);
}

export async function appJwt(env) {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n")),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlEncode(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = b64urlEncode(
    encoder.encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(env.GITHUB_APP_ID) })),
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64urlEncode(new Uint8Array(signature))}`;
}

export async function installationToken(jwt, installationId) {
  const data = await gh(jwt, `/app/installations/${installationId}/access_tokens`, { method: "POST" });
  return data.token;
}

export async function paginate(token, path, key) {
  const items = [];
  for (let page = 1; ; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const data = await gh(token, `${path}${sep}per_page=100&page=${page}`);
    const batch = key ? data[key] : data;
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

// ---- Repository content helpers ----

export function encodeContent(text) {
  const bytes = encoder.encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function decodeContent(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
