// Zoomly server (Node 20+).
// - POST /api/<actionName>  -> runs the matching action from actions.mjs (JSON)
// - POST /api/upload        -> multipart media upload (video or photo) to Cloudinary
// - GET  /api/health        -> liveness check (used by Render)
// - Serves the built Vite client from ../client/dist for everything else.
import express from "express";
import multer from "multer";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Actions, authUser, googleCompleteSignup, googleSignIn } from "./actions.mjs";
import { attachLiveServer } from "./live.mjs";
import { initDb } from "./db.mjs";
import { uploadToCloudinary } from "./cloudinary.mjs";
import { cloudinaryConfig, googleConfig } from "./config.mjs";
import {
  GOOGLE_PENDING_COOKIE,
  GOOGLE_PENDING_TTL_MS,
  GOOGLE_STATE_COOKIE,
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  signPendingProfile,
  suggestUsername,
  verifyPendingProfile,
} from "./google.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "zoomly", media_configured: cloudinaryConfig().configured, google_configured: googleConfig().configured });
});

// ---- Public pages: Privacy Policy + Terms -----------------------------------
// Plain server-served HTML (also linked from the Google OAuth consent
// screen). Served before the SPA fallback below.
function legalPage({ title, heading, bodyHtml }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — Zoomly</title>
<link rel="icon" href="/logo.svg">
<style>
  body { margin:0; background:#0a0f0d; color:#f2f7f4; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
  main { max-width: 720px; margin: 0 auto; padding: 28px 20px 48px; line-height: 1.65; }
  a { color:#a3e635; }
  h1 { font-size: 30px; margin: 14px 0 4px; letter-spacing:-0.5px; }
  h2 { font-size: 19px; margin: 26px 0 6px; }
  p, li { color:#c9d6ce; font-size: 15.5px; }
  .brand { display:flex; align-items:center; gap:10px; text-decoration:none; color:#f2f7f4; font-weight:900; font-size:22px; }
  .brand img { width:38px; height:38px; border-radius:9px; }
  .brand span { color:#a3e635; }
  .muted { color:#93a69c; font-size:14px; }
  footer { margin-top:40px; border-top:1px solid #243129; padding-top:16px; }
</style>
</head>
<body>
<main>
  <a class="brand" href="/"><img src="/logo.svg" alt="Zoomly logo">Zoom<span>ly</span></a>
  <h1>${heading}</h1>
  <p class="muted">Last updated: October 22, 2026</p>
  ${bodyHtml}
  <footer>
    <p class="muted"><a href="/">← Back to Zoomly</a> &nbsp;·&nbsp; <a href="/privacy">Privacy Policy</a> &nbsp;·&nbsp; <a href="/terms">Terms of Service</a></p>
  </footer>
</main>
</body>
</html>`;
}

app.get("/privacy", (_req, res) => {
  res.type("html").send(
    legalPage({
      title: "Privacy Policy",
      heading: "Privacy Policy",
      bodyHtml: `
  <p>Zoomly is a social video app where people create accounts, upload short videos and photos, follow each other, and earn coins and rewards. This policy explains what information we collect, how we use it, and the choices you have.</p>
  <h2>What we collect</h2>
  <ul>
    <li><strong>Account information</strong> — your username, display name and bio, and a securely hashed password. If you sign in with Google, we also receive basic profile information from Google: your name, email address and profile picture, plus a Google account identifier we use to recognize your account.</li>
    <li><strong>Content you upload</strong> — videos, profile photos, titles, descriptions and comments you post, and the likes and follows you make.</li>
    <li><strong>App activity needed to run the service</strong> — things like your coin balance, coin purchase requests (including the JazzCash transaction ID you submit), referral codes and leaderboards.</li>
    <li><strong>Basic technical data</strong> — server logs and similar usage data needed to keep the service running and secure.</li>
  </ul>
  <h2>How we use it</h2>
  <p>We use this information only to operate the app: to run your account, show feeds and profiles, process coins and rewards, display leaderboards, prevent abuse, and fix problems. We do not use your information for anything unrelated to running Zoomly.</p>
  <h2>Where it is stored</h2>
  <p>Videos and photos are stored with our media provider, <strong>Cloudinary</strong>. Account and app data is stored in our database. If you sign in with Google, Google also processes your sign-in under Google's own privacy policy.</p>
  <h2>Your choices and deletion</h2>
  <p>You can delete your own videos at any time inside the app, and you can change or remove your profile photo. To request deletion of your account and its data, email us at <a href="mailto:ranasajeel125@gmail.com">ranasajeel125@gmail.com</a> and we will delete your account and associated content.</p>
  <h2>We do not sell your data</h2>
  <p>We do not sell your personal data to anyone. We share it only with the providers needed to run the service (such as media storage and hosting), as described above.</p>
  <h2>Contact</h2>
  <p>Questions about privacy: <a href="mailto:ranasajeel125@gmail.com">ranasajeel125@gmail.com</a></p>`,
    })
  );
});

app.get("/terms", (_req, res) => {
  res.type("html").send(
    legalPage({
      title: "Terms of Service",
      heading: "Terms of Service",
      bodyHtml: `
  <p>Welcome to Zoomly. By creating an account or using the app, you agree to these terms.</p>
  <h2>Your account</h2>
  <p>You are responsible for your account and for keeping your sign-in details safe. You must provide accurate information and may not impersonate someone else.</p>
  <h2>Your content</h2>
  <p>You are responsible for the videos, photos, comments and other content you upload. You must own the content or have the right to post it. Do not post unlawful content, content that infringes someone else's rights, hateful or harassing content, or content that is otherwise harmful. We may remove content or suspend accounts that break these rules.</p>
  <h2>Coins and rewards</h2>
  <p>Coins are a virtual in-app feature with no cash value. Coin purchases are verified manually before coins are credited, and a JazzCash transaction ID can only be used once.</p>
  <h2>The service</h2>
  <p>Zoomly is provided "as is", without warranties of any kind. The service may change, be interrupted, or be discontinued at any time. To the extent allowed by law, we are not liable for damages arising from use of the service.</p>
  <h2>Contact</h2>
  <p>Questions about these terms: <a href="mailto:ranasajeel125@gmail.com">ranasajeel125@gmail.com</a></p>`,
    })
  );
});

// Media upload: multipart form with fields `token`, `kind` ("video"|"image")
// and the file in `file`. The file is forwarded straight to Cloudinary —
// it is never written to this server's disk. Returns the hosted URL, which
// the client then saves via createPost (video) or setAvatar (image).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB max (videos)
});

app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const token = req.body?.token;
    const kind = req.body?.kind === "image" ? "image" : "video";
    if (!token) return res.status(401).json({ ok: false, message: "Please sign in." });
    // Reuse the getMe action as the auth check so upload auth matches the API.
    const me = await Actions.getMe({ token });
    if (!me.ok) return res.status(401).json({ ok: false, message: "Please sign in." });
    if (!req.file) return res.status(400).json({ ok: false, message: "No file was uploaded." });
    if (kind === "image" && req.file.size > 10 * 1024 * 1024) {
      return res.status(400).json({ ok: false, message: "Profile photo must be under 10 MB." });
    }
    const result = await uploadToCloudinary(req.file.buffer, { kind, filename: req.file.originalname });
    if (!result.ok) return res.status(503).json(result);
    return res.json({ ok: true, url: result.url, public_id: result.publicId, thumbnail_url: result.thumbnailUrl });
  } catch (err) {
    console.error("[upload] failed:", err && err.message ? err.message : err);
    return res.status(500).json({ ok: false, message: "Upload failed. Please try again." });
  }
});

// ---- Google sign-in ("Continue with Google") --------------------------------
// Browser (GET) routes, not JSON actions: the callback redirects back into
// the SPA with either a session token (#google-token=...), the first-login
// username screen (#google-setup, profile held in a signed httpOnly cookie),
// or an error message (#google-error=...).
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) {
      try {
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        /* ignore malformed cookie */
      }
    }
  }
  return out;
}

const GOOGLE_NOT_CONFIGURED = "Google login is not configured yet. Please use your username and password for now.";

app.get("/api/auth/google", (req, res) => {
  if (!googleConfig().configured) {
    return res.redirect(`/#google-error=${encodeURIComponent(GOOGLE_NOT_CONFIGURED)}`);
  }
  const state = crypto.randomBytes(16).toString("hex");
  res.cookie(GOOGLE_STATE_COOKIE, state, { httpOnly: true, sameSite: "lax", maxAge: GOOGLE_PENDING_TTL_MS, path: "/api/auth/google" });
  return res.redirect(buildGoogleAuthUrl(req, state));
});

app.get("/api/auth/google/callback", async (req, res) => {
  const fail = (message) => res.redirect(`/#google-error=${encodeURIComponent(message)}`);
  if (!googleConfig().configured) return fail(GOOGLE_NOT_CONFIGURED);
  const { code, state, error } = req.query;
  if (error || !code) return fail("Google sign-in was cancelled or failed. Please try again.");
  const cookies = parseCookies(req);
  if (!state || !cookies[GOOGLE_STATE_COOKIE] || String(state) !== cookies[GOOGLE_STATE_COOKIE]) {
    return fail("Google sign-in failed its security check. Please try again.");
  }
  res.clearCookie(GOOGLE_STATE_COOKIE, { path: "/api/auth/google" });
  let profile = null;
  try {
    profile = await exchangeGoogleCode(req, String(code));
  } catch (err) {
    console.error("[google] code exchange failed:", err && err.message ? err.message : err);
  }
  if (!profile?.sub) return fail("We could not read your Google profile. Please try again.");
  try {
    const result = await googleSignIn(profile);
    if (result.status === "banned") {
      return fail(`Your Zoomly account has been banned by the owner.${result.reason ? ` Reason: ${result.reason}` : ""}`);
    }
    if (result.status === "login") {
      return res.redirect(`/#google-token=${encodeURIComponent(result.token)}`);
    }
  } catch (err) {
    console.error("[google] sign-in failed:", err && err.message ? err.message : err);
    return fail("Google sign-in failed. Please try again.");
  }
  // First time: hold the profile in a signed cookie and ask for a username.
  res.cookie(GOOGLE_PENDING_COOKIE, signPendingProfile(profile), { httpOnly: true, sameSite: "lax", maxAge: GOOGLE_PENDING_TTL_MS, path: "/" });
  return res.redirect("/#google-setup");
});

// The choose-username screen reads the pending Google profile from here.
app.get("/api/auth/google/pending", (req, res) => {
  const profile = verifyPendingProfile(parseCookies(req)[GOOGLE_PENDING_COOKIE]);
  if (!profile) return res.status(401).json({ ok: false, message: "Your Google sign-in session has expired. Please try signing in with Google again." });
  return res.json({ ok: true, email: profile.email, name: profile.name, picture: profile.picture, suggested_username: suggestUsername(profile.email, profile.name) });
});

// Finalizes a first-time Google signup (username + optional referral code).
app.post("/api/auth/google/complete", async (req, res) => {
  const profile = verifyPendingProfile(parseCookies(req)[GOOGLE_PENDING_COOKIE]);
  if (!profile) return res.status(401).json({ ok: false, message: "Your Google sign-in session has expired. Please try signing in with Google again." });
  try {
    const result = await googleCompleteSignup(profile, req.body ?? {});
    if (result.ok) res.clearCookie(GOOGLE_PENDING_COOKIE, { path: "/" });
    return res.json(result);
  } catch (err) {
    console.error("[google] signup completion failed:", err && err.message ? err.message : err);
    return res.status(500).json({ ok: false, message: "Something went wrong. Please try again." });
  }
});

app.post("/api/:action", async (req, res) => {
  const name = req.params.action;
  const handler = Actions[name];
  if (typeof handler !== "function") {
    return res.status(404).json({ ok: false, message: "Unknown action." });
  }
  try {
    const result = await handler(req.body ?? {});
    res.json(result ?? { ok: false, message: "Empty response." });
  } catch (err) {
    console.error(`[api] action "${name}" threw:`, err && err.message ? err.message : err);
    res.status(500).json({ ok: false, message: "Something went wrong. Please try again." });
  }
});

const clientDir = path.join(__dirname, "..", "client", "dist");
app.use(express.static(clientDir, { maxAge: "1h", index: false }));
// SPA fallback: every non-API route serves the client.
app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(path.join(clientDir, "index.html"));
});

async function main() {
  await initDb();
  const server = http.createServer(app);
  // LIVE real-time hub (WebSocket at /ws): WebRTC signaling relay, live
  // chat, viewer counts and gift broadcasts. Media stays peer-to-peer.
  attachLiveServer(server, { authenticate: authUser });
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[server] Zoomly listening on port ${PORT}`);
    if (!cloudinaryConfig().configured) {
      console.log("[server] WARNING: CLOUDINARY_* env vars are not set — video/photo uploads will fail with a 'not configured' message until they are.");
    }
  });
}

main().catch((err) => {
  console.error("[server] failed to start:", err && err.message ? err.message : err);
  process.exit(1);
});
