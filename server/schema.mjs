// Drizzle schema for Zoomly (SQLite via libsql/Turso).
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(), // stored lowercase
  displayName: text("display_name").notNull(),
  bio: text("bio").notNull().default(""),
  passwordHash: text("password_hash").notNull(),
  googleId: text("google_id").unique(), // Google account id ("sub") — null for password-only accounts
  email: text("email"), // from Google sign-in (or null)
  avatarUrl: text("avatar_url"), // profile photo (DP), hosted on Cloudinary
  avatarPublicId: text("avatar_public_id"),
  coinBalance: integer("coin_balance").notNull().default(0),
  liveTitle: text("live_title"), // last-used LIVE title — asked once, then reused by startLive
  banned: integer("banned").notNull().default(0), // 1 = banned by the owner (moderation)
  banReason: text("ban_reason"),
  hiddenCount: integer("hidden_count").notNull().default(0), // how many times this user's content was auto-hidden
  referralCode: text("referral_code").notNull().unique(), // e.g. ZOOM-3-ALI
  referredBy: integer("referred_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const sessions = sqliteTable("sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const posts = sqliteTable("posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  videoUrl: text("video_url").notNull(),
  videoPublicId: text("video_public_id"),
  thumbnailUrl: text("thumbnail_url"),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  hidden: integer("hidden").notNull().default(0), // 1 = auto-hidden by reports / owner moderation (owner still sees it)
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const likes = sqliteTable("likes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  postId: integer("post_id").notNull().references(() => posts.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const comments = sqliteTable("comments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  postId: integer("post_id").notNull().references(() => posts.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const follows = sqliteTable("follows", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  followerId: integer("follower_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  followeeId: integer("followee_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const coinRequests = sqliteTable("coin_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  packCoins: integer("pack_coins").notNull(),
  pricePkr: integer("price_pkr").notNull(),
  // 1 when the buyer chose a custom amount (1 coin = Rs.1) instead of a pack.
  isCustom: integer("is_custom").notNull().default(0),
  tid: text("tid").notNull().unique(), // JazzCash transaction id — unique, duplicates rejected
  status: text("status", { enum: ["pending", "approved", "rejected"] }).notNull().default("pending"),
  reviewedBy: integer("reviewed_by").references(() => users.id),
  reviewedAt: integer("reviewed_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

// A cash-out request. The coins are HELD at submission (deducted from the
// user's balance with an atomic guarded update, like a gift spend): on
// REJECT the held coins are refunded; on APPROVE they stay deducted and the
// owner pays the user manually via JazzCash outside the app.
// amountPkr always equals coins (1 coin = Rs.1), derived server-side.
export const withdrawalRequests = sqliteTable("withdrawal_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  coins: integer("coins").notNull(),
  amountPkr: integer("amount_pkr").notNull(),
  jazzcashNumber: text("jazzcash_number").notNull(),
  accountTitle: text("account_title").notNull().default(""),
  status: text("status", { enum: ["pending", "approved", "rejected"] }).notNull().default("pending"),
  reviewedBy: integer("reviewed_by").references(() => users.id),
  decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

// A LIVE broadcast. endedAt is null while the broadcast is running.
// totalGiftCoins = gross gift coins received; platformCutCoins = the
// platform's 30% share of those gifts (the creator received the other 70%).
export const liveSessions = sqliteTable("live_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  endedAt: integer("ended_at", { mode: "timestamp_ms" }),
  hidden: integer("hidden").notNull().default(0), // 1 = auto-hidden by reports / owner moderation
  peakViewers: integer("peak_viewers").notNull().default(0),
  totalGiftCoins: integer("total_gift_coins").notNull().default(0),
  platformCutCoins: integer("platform_cut_coins").notNull().default(0),
});

// One row per gift sent during a live broadcast. coins = full gift price
// (deducted from the sender); creatorShare went to the broadcaster's coin
// balance; platformShare is the platform cut (recorded, credited nowhere).
export const giftEvents = sqliteTable("gift_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  liveSessionId: integer("live_session_id").notNull().references(() => liveSessions.id, { onDelete: "cascade" }),
  senderId: integer("sender_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  creatorId: integer("creator_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  giftKey: text("gift_key").notNull(),
  coins: integer("coins").notNull(),
  creatorShare: integer("creator_share").notNull(),
  platformShare: integer("platform_share").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

// A PK match between two live broadcasts. scoreA/scoreB are the summed
// gift coin values each side received during the match (balances still use
// the normal 70/30 gift split). winnerUserId is null for a draw and while
// the match is running; endedAt is null while running.
export const liveMatches = sqliteTable("live_matches", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  liveSessionA: integer("live_session_a").notNull().references(() => liveSessions.id, { onDelete: "cascade" }),
  liveSessionB: integer("live_session_b").notNull().references(() => liveSessions.id, { onDelete: "cascade" }),
  userA: integer("user_a").notNull().references(() => users.id, { onDelete: "cascade" }),
  userB: integer("user_b").notNull().references(() => users.id, { onDelete: "cascade" }),
  scoreA: integer("score_a").notNull().default(0),
  scoreB: integer("score_b").notNull().default(0),
  winnerUserId: integer("winner_user_id").references(() => users.id, { onDelete: "set null" }),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  endedAt: integer("ended_at", { mode: "timestamp_ms" }),
});

// A community report against a video (post), live, comment or user. One
// row per (reporter, target): re-reporting UPDATES the row instead of
// stacking. status: pending -> dismissed | actioned (the moderation log
// lives on the row: actionTaken / actionBy / actionAt).
export const reports = sqliteTable("reports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  reporterId: integer("reporter_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  targetType: text("target_type", { enum: ["post", "live", "comment", "user"] }).notNull(),
  targetId: integer("target_id").notNull(),
  targetOwnerId: integer("target_owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  reason: text("reason", { enum: ["spam", "abuse", "nudity", "violence", "other"] }).notNull(),
  details: text("details").notNull().default(""),
  status: text("status", { enum: ["pending", "dismissed", "actioned"] }).notNull().default("pending"),
  actionTaken: text("action_taken"),
  actionBy: integer("action_by").references(() => users.id),
  actionAt: integer("action_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

// A block: userId has blocked blockedId. Blocked users' content is hidden
// from the blocker, they cannot comment on the blocker's videos, join the
// blocker's live as guest, or DM the blocker; follows between them are
// removed when the block is placed.
export const blocks = sqliteTable("blocks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  blockedId: integer("blocked_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

// An in-app notification for userId (no push infrastructure). `text` is a
// snapshot written at creation time; actorId/postId/liveSessionId give the
// client something to render/link. read flips to 1 via markNotificationsRead.
export const notifications = sqliteTable("notifications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull(), // like | comment | follow | gift | referral | coin_request | withdrawal | live | story | dm
  actorId: integer("actor_id").references(() => users.id, { onDelete: "set null" }),
  postId: integer("post_id").references(() => posts.id, { onDelete: "set null" }),
  liveSessionId: integer("live_session_id").references(() => liveSessions.id, { onDelete: "set null" }),
  text: text("text").notNull(),
  coins: integer("coins"),
  read: integer("read").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});
