// Google OAuth 2.0 helpers for "Continue with Google" — plain fetch, no SDK.
//
// Flow:
//   1. GET /api/auth/google            -> state cookie + redirect to Google
//   2. GET /api/auth/google/callback   -> exchange code, read profile
//        - known google_id  -> session token handed to the SPA via #google-token
//        - new google_id    -> signed "pending" cookie + redirect to
//                              #google-setup (choose-a-username screen)
//   3. POST /api/auth/google/complete   -> verifies the pending cookie and
//                                          finalizes the account
//
// The pending cookie is an HMAC-signed payload (key = GOOGLE_CLIENT_SECRET),
// so no server-side storage is needed between the callback and signup.
import crypto from "node:crypto";
import { googleConfig } from "./config.mjs";

export const GOOGLE_STATE_COOKIE = "zoomly_gstate";
export const GOOGLE_PENDING_COOKIE = "zoomly_gpending";
export const GOOGLE_PENDING_TTL_MS = 10 * 60 * 1000;

// The redirect URI is derived from the incoming request so the exact same
// code works locally (http://localhost:3100/...) and in production
// (https://zoomly.onrender.com/...). The production value must be registered
// in the Google Cloud Console — see README.
export function googleRedirectUri(req) {
  const proto = String(req.get("x-forwarded-proto") || req.protocol || "http").split(",")[0].trim();
  const host = req.get("host");
  return `${proto}://${host}/api/auth/google/callback`;
}

export function buildGoogleAuthUrl(req, state) {
  const { clientId } = googleConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: googleRedirectUri(req),
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "online",
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function hmac(payloadB64) {
  const { clientSecret } = googleConfig();
  return crypto.createHmac("sha256", clientSecret).update(payloadB64).digest("base64url");
}

// Sign a Google profile into the pending-signup cookie value.
export function signPendingProfile(profile) {
  const payload = {
    sub: profile.sub,
    email: profile.email ?? null,
    name: profile.name ?? null,
    picture: profile.picture ?? null,
    exp: Date.now() + GOOGLE_PENDING_TTL_MS,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${payloadB64}.${hmac(payloadB64)}`;
}

// Verify + decode a pending cookie value. Returns the profile or null.
export function verifyPendingProfile(value) {
  if (!value || typeof value !== "string") return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const payloadB64 = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  const expected = hmac(payloadB64);
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload?.sub || typeof payload.exp !== "number" || payload.exp <= Date.now()) return null;
  return { sub: payload.sub, email: payload.email ?? null, name: payload.name ?? null, picture: payload.picture ?? null };
}

// Exchange the authorization code and read the Google profile.
// Returns { sub, email, name, picture } or null on any failure.
export async function exchangeGoogleCode(req, code) {
  const { clientId, clientSecret } = googleConfig();
  let tokenRes;
  try {
    tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: googleRedirectUri(req),
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    return null;
  }
  const tokenData = await tokenRes.json().catch(() => null);
  if (!tokenRes.ok || !tokenData?.access_token) return null;

  let profileRes;
  try {
    profileRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${tokenData.access_token}` },
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    return null;
  }
  const profile = await profileRes.json().catch(() => null);
  if (!profileRes.ok || !profile?.sub) return null;
  return {
    sub: String(profile.sub),
    email: profile.email ?? null,
    name: profile.name ?? null,
    picture: profile.picture ?? null,
  };
}

// Pre-suggested username for the choose-username screen: from the email
// prefix (falling back to the display name), sanitized to the app's rules.
export function suggestUsername(email, name) {
  let base = "";
  if (email && email.includes("@")) base = email.split("@")[0];
  if (!base && name) base = name;
  base = base.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24);
  if (base.length < 3) base = `${base}_zoomly`.slice(0, 24);
  return base;
}
