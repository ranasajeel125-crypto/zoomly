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
  tid: text("tid").notNull().unique(), // JazzCash transaction id — unique, duplicates rejected
  status: text("status", { enum: ["pending", "approved", "rejected"] }).notNull().default("pending"),
  reviewedBy: integer("reviewed_by").references(() => users.id),
  reviewedAt: integer("reviewed_at", { mode: "timestamp_ms" }),
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
