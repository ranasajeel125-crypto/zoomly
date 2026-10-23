// Shared configuration for Zoomly: coin packs, coin levels, JazzCash
// buy-coins display info, and the Cloudinary configuration check.
export const COIN_PACKS = [
  { coins: 100, pricePkr: 100 },
  { coins: 550, pricePkr: 500 },
  { coins: 1150, pricePkr: 1000 },
  { coins: 6000, pricePkr: 5000 },
  { coins: 14000, pricePkr: 10000 },
];

// Custom coin buy: besides the packs, a user can buy any amount of coins at
// exactly 1 coin = Rs.1 (the server derives price_pkr == coins itself; a
// client-supplied price is never trusted), with this minimum.
export const CUSTOM_BUY_MIN_COINS = 10;

// Withdrawals: users cash out coins at 1 coin = Rs.1, with this minimum
// (raised 10 -> 100 by the owner 2026-10-23, alongside the referral reward:
// small balances can no longer be cashed out).
export const WITHDRAW_MIN_COINS = 100;

// Monetization program (owner spec 2026-10-23): creators APPLY from the
// Monetization screen; the owner approves or rejects each application;
// only APPROVED creators (and the owner/admin) can withdraw. Meeting the
// criteria only unlocks the Apply button — approval is what unlocks
// cash-out. Views = the sum of posts.view_count over ALL of the user's
// posts. Change the numbers here and the whole program follows.
export const MONETIZATION_CRITERIA = { minAge: 18, minFollowers: 5000, minViews: 50000 };

// Coin levels, by current coin balance. `min` is the balance at which the
// level starts. Progress is measured towards the next level's `min`.
//   Starter    0 – 99
//   Bronze     100 – 499
//   Silver     500 – 1,499
//   Golden     1,500 – 4,999
//   Platinum   5,000 – 13,999
//   Diamond    14,000+
export const COIN_LEVELS = [
  { name: "Starter", min: 0 },
  { name: "Bronze", min: 100 },
  { name: "Silver", min: 500 },
  { name: "Golden", min: 1500 },
  { name: "Platinum", min: 5000 },
  { name: "Diamond", min: 14000 },
];

export function levelFor(balance) {
  let current = COIN_LEVELS[0];
  let next = null;
  for (let i = 0; i < COIN_LEVELS.length; i += 1) {
    if (balance >= COIN_LEVELS[i].min) {
      current = COIN_LEVELS[i];
      next = COIN_LEVELS[i + 1] ?? null;
    }
  }
  const progress = next ? Math.min(1, (balance - current.min) / (next.min - current.min)) : 1;
  return { level: current.name, level_min: current.min, next_level: next?.name ?? null, next_level_min: next?.min ?? null, progress };
}

// JazzCash details shown on the "Buy coins" page. This is the owner's public
// business number (also shown on his public SMM website); overridable by env.
export const JAZZCASH = {
  number: process.env.JAZZCASH_NUMBER || "03266040350",
  title: process.env.JAZZCASH_TITLE || "Muhammad Sajeel",
};

// The username (case-insensitive) whose account gets admin rights —
// reviewing coin requests. Set ADMIN_USERNAME in the environment.
export function adminUsername() {
  return (process.env.ADMIN_USERNAME || "").trim().toLowerCase();
}

export function isAdminUser(user) {
  const admin = adminUsername();
  return Boolean(admin) && user.username.toLowerCase() === admin;
}

// Cloudinary: all media (videos + profile photos) lives there — Render's
// disk is ephemeral, so nothing is ever stored locally in production.
export function cloudinaryConfig() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME || "";
  const apiKey = process.env.CLOUDINARY_API_KEY || "";
  const apiSecret = process.env.CLOUDINARY_API_SECRET || "";
  return { cloudName, apiKey, apiSecret, configured: Boolean(cloudName && apiKey && apiSecret) };
}

// Google OAuth ("Continue with Google"). Both values come from the Google
// Cloud Console OAuth client; without them the button still renders but the
// flow returns a clear "not configured" message.
export function googleConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID || "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
  return { clientId, clientSecret, configured: Boolean(clientId && clientSecret) };
}

// Referral reward (owner decision 2026-10-23, superseding the earlier
// no-coins rule): the INVITER earns this many coins per completed referral
// signup, credited once inside applyReferral. The new user still gets NO
// coins (no welcome bonus). The credit is gated by an anti-self-referral
// guard (device/IP match — see applyReferral in actions.mjs); the referral
// COUNT and leaderboard are never gated. Withdrawals stay owner-approved
// with a 100-coin minimum, which is the house's cash-out checkpoint.
export const REFERRAL_REWARD_COINS = 1;
export const LEADERBOARD_LIMIT = 50;

// ---- Live gifts -------------------------------------------------------------
// The gift catalog for LIVE broadcasts. The server is the source of truth:
// clients render exactly these entries (getLive returns them) and sendGift
// prices come only from here. Field names are part of the API contract —
// { key, name, emoji, coins } — keep them in sync with the client.
// Revenue split (owner-set): the broadcaster (creator) receives 70% of
// the gift price — floor(coins * 0.7) — into their normal coin balance;
// the platform keeps the remaining 30%, recorded in the DB
// (gift_events.platform_share + live_sessions.platform_cut_coins) and
// credited nowhere.
export const GIFT_CATALOG = [
  { key: "rose", name: "Rose", emoji: "🌹", coins: 10 },
  { key: "chocolate", name: "Chocolate", emoji: "🍫", coins: 25 },
  { key: "heart", name: "Heart", emoji: "❤️", coins: 50 },
  { key: "giftbox", name: "Gift Box", emoji: "🎁", coins: 100 },
  { key: "crown", name: "Crown", emoji: "👑", coins: 250 },
  { key: "rocket", name: "Rocket", emoji: "🚀", coins: 500 },
  { key: "diamond", name: "Diamond", emoji: "💎", coins: 1000 },
  { key: "lion", name: "Lion", emoji: "🦁", coins: 2500 },
];

export function giftForKey(key) {
  return GIFT_CATALOG.find((g) => g.key === key) ?? null;
}

// Splits a gift's price: creator gets 70% (floored), platform keeps the
// rest (so an odd price like 25 → creator 17, platform 8).
export function giftSplit(coins) {
  const creatorShare = Math.floor(coins * 0.7);
  return { creatorShare, platformShare: coins - creatorShare };
}

// ---- Live PK matches ----------------------------------------------------------
// A match between two live broadcasters lasts 5 minutes by default
// (MATCH_DURATION_SECONDS can override it — the headless tests use a few
// seconds). Invites expire after 30 seconds unanswered.
export const MATCH_DURATION_MS = Math.max(5, Number(process.env.MATCH_DURATION_SECONDS) || 300) * 1000;
export const MATCH_INVITE_TTL_MS = 30_000;

// ---- WebRTC ICE servers (LIVE) -------------------------------------------------
// Single source of truth for the peer-connection configuration: startLive
// and getLive return iceServers() as `ice_servers`, and the client adopts
// it (client/src/live.js keeps a built-in fallback copy) — so TURN
// credentials can be rotated server-side, with no client release.
//
// STUN alone cannot connect peers behind carrier-grade NAT — most mobile
// data in Pakistan — so a working TURN relay is essential, not optional.
//
// TURN selection, in order:
//  1. A DEDICATED TURN service, when the owner configures one on Render:
//       TURN_URL          e.g. turn:global.turn.twilio.com:3478
//       TURN_USERNAME     the service's username
//       TURN_CREDENTIAL   the service's password/credential
//       TURN_URL_TCP      optional second URL (e.g. turns:...:5349?transport=tcp)
//     (Cloudflare Calls TURN, Metered premium, Twilio NTS all fit this
//     shape; static long-term credentials from the provider's dashboard.)
//  2. Otherwise, Metered's Open Relay via its STATIC-AUTH host. The old
//     anonymous long-term credentials (openrelayproject/openrelayproject
//     on openrelay.metered.ca) are dead: Metered's own Open Relay page now
//     requires a signed-up account + API key for that host, and two
//     real-world two-phone tests failed black+silent through them. The
//     static-auth host (documented on the same page for Nextcloud Talk
//     etc.) instead uses coturn's REST credential scheme — username
//     "<expiry-unix>:<label>", credential base64(HMAC-SHA1(secret,
//     username)) — which this server mints fresh, so no signup is
//     needed. TURN_HOST / TURN_SECRET can override the defaults. It is
//     still a shared community relay (Metered states 20 GB/month free):
//     fine for launch, replace with option 1 when it gets busy.
import { createHmac } from "node:crypto";

const STUN_ENTRIES = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:openrelay.metered.ca:80" },
];

const TURN_CRED_TTL_MS = 6 * 60 * 60 * 1000; // minted credentials live 6h
let iceCache = null; // { expiresAtMs, list }

function buildIceServers(now = Date.now()) {
  const turnUrl = (process.env.TURN_URL || "").trim();
  const turnUser = (process.env.TURN_USERNAME || "").trim();
  const turnCred = (process.env.TURN_CREDENTIAL || "").trim();
  if (turnUrl && turnUser && turnCred) {
    const entries = [{ urls: turnUrl, username: turnUser, credential: turnCred }];
    const tcp = (process.env.TURN_URL_TCP || "").trim();
    if (tcp) entries.push({ urls: tcp, username: turnUser, credential: turnCred });
    return [...STUN_ENTRIES, ...entries];
  }
  const host = (process.env.TURN_HOST || "").trim() || "staticauth.openrelay.metered.ca";
  const secret = (process.env.TURN_SECRET || "").trim() || "openrelayprojectsecret";
  const expiry = Math.floor((now + TURN_CRED_TTL_MS) / 1000);
  const username = `${expiry}:zoomly`;
  const credential = createHmac("sha1", secret).update(username).digest("base64");
  const auth = { username, credential };
  return [
    ...STUN_ENTRIES,
    { urls: `turn:${host}:80`, ...auth },
    { urls: `turn:${host}:443`, ...auth },
    { urls: `turn:${host}:443?transport=tcp`, ...auth },
    { urls: `turns:${host}:443?transport=tcp`, ...auth },
  ];
}

// The live ICE list. Minted staticauth credentials are cached until they
// near expiry so startLive and getLive hand out the identical list (and
// clients aren't churning credentials mid-session).
export function iceServers() {
  const now = Date.now();
  if (iceCache && iceCache.expiresAtMs - now > 30 * 60 * 1000) return iceCache.list;
  const list = buildIceServers(now);
  iceCache = { list, expiresAtMs: now + TURN_CRED_TTL_MS };
  return list;
}

// Static snapshot kept for any importer that just needs a list shape;
// actions use iceServers() for the fresh, credentialed list.
export const ICE_SERVERS = buildIceServers();

// ---- Content safety: word filter + report auto-hide ---------------------------
// Auto-catch layer 1: this text filter, applied to comments, live chat,
// video titles/captions, live titles and display names. Matching text is
// rejected with a clear notice. Layer 2 is community reports: a video or
// live with REPORT_AUTOHIDE_THRESHOLD distinct reporters is auto-hidden
// until the owner reviews it (see actions.mjs reportContent). NOTE: this
// is a text filter only — it does NOT scan video frames (that needs a paid
// external AI moderation service).
//
// Extend BANNED_WORDS freely: entries are matched case-insensitively on
// word boundaries, so keep them distinctive to avoid tripping innocent
// words. Roman Urdu abuse terms are included alongside English ones.
export const BANNED_WORDS = [
  // English profanity / sexual / slurs
  "fuck", "fucking", "motherfucker", "shit", "bullshit", "bitch", "bitches",
  "bastard", "asshole", "whore", "slut", "dick", "cock", "pussy", "cunt",
  "porn", "porno", "nude", "nudes", "rape", "rapist", "nigger", "nigga",
  "faggot", "penis", "vagina", "boobs", "sex", "sexy", "xxx",
  // Roman Urdu profanity / abuse
  "bhenchod", "madarchod", "chutiya", "gandu", "randi", "harami",
  "haramzada", "haramzadi", "kanjar", "kutta", "kutti", "kuttey", "kaminay",
  "lanati", "bhadwa", "chod", "lund", "phudi", "gaand",
];

// Spam patterns: external links and phone-number spam (comments/chat).
const SPAM_PATTERNS = [
  /https?:\/\//i,
  /www\.[a-z0-9-]+\.[a-z]{2,}/i,
  /\b[a-z0-9-]+\.(com|net|org|io|xyz|top|site|online|pk|info|biz)\b/i,
  /\b\d{10,}\b/,
  /\b\d{4}[- ]\d{7}\b/,
];

const BANNED_WORDS_RE = new RegExp(`\\b(?:${BANNED_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");

// Returns a short label ("word" | "spam") when the text trips the filter,
// or null when it is clean. The specific match is never shown to users.
export function findBannedContent(text) {
  const value = String(text ?? "");
  if (!value) return null;
  if (BANNED_WORDS_RE.test(value)) return "word";
  for (const pattern of SPAM_PATTERNS) {
    if (pattern.test(value)) return "spam";
  }
  return null;
}

// A video or live is auto-hidden once this many DISTINCT users report it.
export const REPORT_AUTOHIDE_THRESHOLD = 3;
