// server/auth.mjs: access code, device tokens, parent PIN, admin key.
//
// Flow: the tester types the shared code once. On success the server issues a
// random device token, stores only its hash against that kid, and sets it as
// an httpOnly cookie. Every later request authenticates by token, so the code
// is typed exactly once per device.
//
// Unauthenticated requests never reach gitagent, so they can never spend
// money. The code check is written against a map-shaped lookup so M2 can
// swap in per-family codes without a rewrite.

import { randomBytes, timingSafeEqual, scryptSync, randomUUID } from "node:crypto";
import { config, LOCAL_DEV } from "./config.mjs";
import { sha256, update, read } from "./registry.mjs";

const COOKIE = "whyzr_token";

/** Constant-time string compare that tolerates length differences. */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // Still burn a comparison so failure timing does not leak length.
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/** M1: one shared code. Shaped so M2 can return a code -> scope map. */
export function checkCode(submitted) {
  if (LOCAL_DEV) return { ok: true, scope: "local-dev" };
  if (!submitted) return { ok: false };
  return safeEqual(submitted, config.code) ? { ok: true, scope: "m1" } : { ok: false };
}

export function issueToken() {
  return randomBytes(24).toString("base64url");
}

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function tokenCookie(token) {
  // httpOnly so page scripts cannot read it; SameSite=Lax so a cross-site
  // form post cannot ride the session; Secure in production only, since
  // local dev is plain http.
  const secure = LOCAL_DEV ? "" : " Secure;";
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax;${secure} Max-Age=${60 * 60 * 24 * 90}`;
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Bind a freshly issued token to a kid. */
export function bindToken(kidId, token) {
  return update((reg) => {
    const kid = reg.kids[kidId];
    if (!kid) throw new Error("unknown kid");
    kid.tokenHashes = [...new Set([...(kid.tokenHashes || []), sha256(token)])].slice(-5);
  });
}

/** Resolve the request's device token to a kid id, or null. */
export function kidFromRequest(req) {
  const token = parseCookies(req)[COOKIE] || (req.headers["x-whyzr-token"] || "");
  if (!token) return null;
  const hash = sha256(token);
  // One tester in M1, so a scan is fine; a hash -> kid index is the M2 shape.
  for (const [id, kid] of Object.entries(read().kids)) {
    if ((kid.tokenHashes || []).includes(hash)) return id;
  }
  return null;
}

/** Parent PIN: scrypt with a per-PIN salt, stored as salt:hash. */
export function hashPin(pin) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(String(pin), salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPin(pin, stored) {
  if (!stored || !pin) return false;
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(String(pin), salt, 32).toString("hex");
  return safeEqual(candidate, hash);
}

// Parent PIN lockout. A 4-digit PIN is only 10,000 guesses, so attempts are
// counted per kid and backed off hard. State lives in the registry so it
// survives a restart (an attacker could otherwise reset it by waiting for a
// deploy).
const PIN_FREE_TRIES = 5;
const PIN_BACKOFF_MS = 60_000;   // after the free tries: 1min, 2min, 4min...
const PIN_MAX_BACKOFF_MS = 60 * 60_000;

export function pinLockState(kidId) {
  const kid = read().kids[kidId];
  const f = kid?.pinFailures;
  if (!f || f.count <= PIN_FREE_TRIES) return { locked: false };
  const steps = Math.min(f.count - PIN_FREE_TRIES - 1, 6);
  const wait = Math.min(PIN_BACKOFF_MS * 2 ** steps, PIN_MAX_BACKOFF_MS);
  const remaining = f.lastAt + wait - Date.now();
  return remaining > 0
    ? { locked: true, waitSeconds: Math.ceil(remaining / 1000) }
    : { locked: false };
}

export function notePinFailure(kidId) {
  return update((reg) => {
    const kid = reg.kids[kidId];
    if (!kid) return;
    const f = kid.pinFailures || { count: 0, lastAt: 0 };
    kid.pinFailures = { count: f.count + 1, lastAt: Date.now() };
  });
}

export function clearPinFailures(kidId) {
  return update((reg) => {
    if (reg.kids[kidId]) reg.kids[kidId].pinFailures = { count: 0, lastAt: 0 };
  });
}

export function checkAdminKey(submitted) {
  if (!config.adminKey) return false; // no key configured, admin stays shut
  return safeEqual(submitted || "", config.adminKey);
}

export function newSessionId() {
  return `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}-${randomUUID().slice(0, 6)}`;
}
