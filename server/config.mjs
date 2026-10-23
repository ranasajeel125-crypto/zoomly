// Shared configuration for Zoomly: coin packs, coin levels, JazzCash
// buy-coins display info, and the Cloudinary configuration check.
export const COIN_PACKS = [
  { coins: 100, pricePkr: 100 },
  { coins: 550, pricePkr: 500 },
  { coins: 1150, pricePkr: 1000 },
  { coins: 6000, pricePkr: 5000 },
  { coins: 14000, pricePkr: 10000 },
];

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

// Referrals mint NO coins (owner decision 2026-10-23): a referral only
// links the two accounts so the inviter's referral COUNT goes up. With
// cash withdrawals in the app, free referral coins would be real money
// out of the owner's pocket — no code path may credit them.
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
// and getLive return this list as `ice_servers`, and the client adopts it
// (client/src/live.js keeps an identical built-in fallback copy) — so TURN
// credentials can be rotated here, server-side, with no client release.
//
// STUN alone cannot connect peers behind carrier-grade NAT — most mobile
// data in Pakistan — so alongside Google STUN the list carries the free
// public Metered Open Relay (openrelay.metered.ca) TURN servers. That is a
// shared community relay (bandwidth-limited, can be congested at peak
// times); a dedicated TURN account's servers can simply replace these
// entries here when needed.
export const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:openrelay.metered.ca:80" },
  { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turns:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
];
