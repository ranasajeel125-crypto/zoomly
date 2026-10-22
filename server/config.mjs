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

export const REFERRAL_INVITER_COINS = 20;
export const REFERRAL_WELCOME_COINS = 10;
export const LEADERBOARD_LIMIT = 50;
