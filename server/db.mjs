// Database connection for Zoomly.
// Uses @libsql/client (Turso) so the same SQLite schema runs locally
// (file: URL) and in production (libsql:// URL + auth token).
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema.mjs";

const url = process.env.TURSO_DATABASE_URL || "file:./data/local.db";
const authToken = process.env.TURSO_AUTH_TOKEN;

if (url.startsWith("file:")) {
  const filePath = url.slice("file:".length);
  const dir = path.dirname(filePath);
  if (dir && dir !== "." && dir !== "") fs.mkdirSync(dir, { recursive: true });
} else if (!process.env.TURSO_DATABASE_URL) {
  console.log("[db] TURSO_DATABASE_URL not set — using local SQLite file ./data/local.db");
}

export const client = createClient(url.startsWith("file:") ? { url } : { url, authToken });
export const db = drizzle(client, { schema });

// Create tables on fresh databases. Safe to run on every boot.
export async function initDb() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      bio TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      google_id TEXT,
      email TEXT,
      avatar_url TEXT,
      avatar_public_id TEXT,
      coin_balance INTEGER NOT NULL DEFAULT 0,
      live_title TEXT,
      banned INTEGER NOT NULL DEFAULT 0,
      ban_reason TEXT,
      hidden_count INTEGER NOT NULL DEFAULT 0,
      referral_code TEXT NOT NULL UNIQUE,
      referred_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      signup_device TEXT,
      signup_ip TEXT,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      video_url TEXT NOT NULL,
      video_public_id TEXT,
      thumbnail_url TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      hidden INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS likes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, post_id)
    )`,
    `CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS follows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      UNIQUE(follower_id, followee_id)
    )`,
    `CREATE TABLE IF NOT EXISTS coin_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      pack_coins INTEGER NOT NULL,
      price_pkr INTEGER NOT NULL,
      is_custom INTEGER NOT NULL DEFAULT 0,
      tid TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      reviewed_by INTEGER REFERENCES users(id),
      reviewed_at INTEGER,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS withdrawal_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      coins INTEGER NOT NULL,
      amount_pkr INTEGER NOT NULL,
      jazzcash_number TEXT NOT NULL,
      account_title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      reviewed_by INTEGER REFERENCES users(id),
      decided_at INTEGER,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_type TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      target_owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      action_taken TEXT,
      action_by INTEGER REFERENCES users(id),
      action_at INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE(reporter_id, target_type, target_id)
    )`,
    `CREATE TABLE IF NOT EXISTS blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, blocked_id)
    )`,
    `CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      post_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
      live_session_id INTEGER REFERENCES live_sessions(id) ON DELETE SET NULL,
      text TEXT NOT NULL,
      coins INTEGER,
      read INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS stories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      media_url TEXT NOT NULL,
      media_public_id TEXT,
      media_type TEXT NOT NULL DEFAULT 'image',
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS story_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
      viewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      UNIQUE(story_id, viewer_id)
    )`,
    `CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      read_at INTEGER,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS live_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      hidden INTEGER NOT NULL DEFAULT 0,
      peak_viewers INTEGER NOT NULL DEFAULT 0,
      total_gift_coins INTEGER NOT NULL DEFAULT 0,
      platform_cut_coins INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS gift_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      live_session_id INTEGER NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      creator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      gift_key TEXT NOT NULL,
      coins INTEGER NOT NULL,
      creator_share INTEGER NOT NULL,
      platform_share INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS live_matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      live_session_a INTEGER NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
      live_session_b INTEGER NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
      user_a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      score_a INTEGER NOT NULL DEFAULT 0,
      score_b INTEGER NOT NULL DEFAULT 0,
      winner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_likes_post ON likes(post_id)`,
    `CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id)`,
    `CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id)`,
    `CREATE INDEX IF NOT EXISTS idx_users_coins ON users(coin_balance)`,
    `CREATE INDEX IF NOT EXISTS idx_live_user ON live_sessions(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_live_active ON live_sessions(ended_at)`,
    `CREATE INDEX IF NOT EXISTS idx_gifts_session ON gift_events(live_session_id)`,
  ];
  for (const sql of statements) {
    await client.execute(sql);
  }
  // Migrations for databases created before a column existed (SQLite cannot
  // add a UNIQUE column via ALTER TABLE, so google_id gets a unique index —
  // multiple NULLs are allowed, matching the nullable-unique requirement).
  const cols = await client.execute("PRAGMA table_info(users)");
  const colNames = new Set(cols.rows.map((r) => r.name));
  if (!colNames.has("google_id")) await client.execute("ALTER TABLE users ADD COLUMN google_id TEXT");
  if (!colNames.has("email")) await client.execute("ALTER TABLE users ADD COLUMN email TEXT");
  if (!colNames.has("live_title")) await client.execute("ALTER TABLE users ADD COLUMN live_title TEXT");
  if (!colNames.has("signup_device")) await client.execute("ALTER TABLE users ADD COLUMN signup_device TEXT");
  if (!colNames.has("signup_ip")) await client.execute("ALTER TABLE users ADD COLUMN signup_ip TEXT");
  await client.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id)");
  const crCols = await client.execute("PRAGMA table_info(coin_requests)");
  const crColNames = new Set(crCols.rows.map((r) => r.name));
  if (!crColNames.has("is_custom")) await client.execute("ALTER TABLE coin_requests ADD COLUMN is_custom INTEGER NOT NULL DEFAULT 0");
  // Moderation columns (Phase 2): ban state on users, hidden flags on
  // posts / live_sessions — same add-if-missing pattern.
  if (!colNames.has("banned")) await client.execute("ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0");
  if (!colNames.has("ban_reason")) await client.execute("ALTER TABLE users ADD COLUMN ban_reason TEXT");
  if (!colNames.has("hidden_count")) await client.execute("ALTER TABLE users ADD COLUMN hidden_count INTEGER NOT NULL DEFAULT 0");
  const postCols = await client.execute("PRAGMA table_info(posts)");
  const postColNames = new Set(postCols.rows.map((r) => r.name));
  if (!postColNames.has("hidden")) await client.execute("ALTER TABLE posts ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0");
  const liveCols = await client.execute("PRAGMA table_info(live_sessions)");
  const liveColNames = new Set(liveCols.rows.map((r) => r.name));
  if (!liveColNames.has("hidden")) await client.execute("ALTER TABLE live_sessions ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0");
}
