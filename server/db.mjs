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
      created_at INTEGER NOT NULL,
      gift_earned_milli INTEGER NOT NULL DEFAULT 0,
      private_account INTEGER NOT NULL DEFAULT 0,
      comment_permission TEXT NOT NULL DEFAULT 'everyone',
      message_permission TEXT NOT NULL DEFAULT 'everyone'
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
      view_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS post_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      UNIQUE(post_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS monetization_applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      full_name TEXT NOT NULL,
      dob TEXT NOT NULL,
      jazzcash_number TEXT NOT NULL,
      followers_snapshot INTEGER NOT NULL DEFAULT 0,
      views_snapshot INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      reviewed_by INTEGER REFERENCES users(id),
      decided_at INTEGER,
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
      parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
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
      kind TEXT NOT NULL DEFAULT 'video',
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      hidden INTEGER NOT NULL DEFAULT 0,
      peak_viewers INTEGER NOT NULL DEFAULT 0,
      total_gift_coins INTEGER NOT NULL DEFAULT 0,
      platform_cut_coins INTEGER NOT NULL DEFAULT 0,
      platform_cut_milli INTEGER NOT NULL DEFAULT 0,
      creator_credited_coins INTEGER NOT NULL DEFAULT 0
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
      creator_share_milli INTEGER NOT NULL DEFAULT 0,
      platform_share_milli INTEGER NOT NULL DEFAULT 0,
      creator_credited_coins INTEGER NOT NULL DEFAULT 0,
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
  if (!postColNames.has("view_count")) await client.execute("ALTER TABLE posts ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0");
  const liveCols = await client.execute("PRAGMA table_info(live_sessions)");
  const liveColNames = new Set(liveCols.rows.map((r) => r.name));
  if (!liveColNames.has("hidden")) await client.execute("ALTER TABLE live_sessions ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0");
  if (!liveColNames.has("kind")) await client.execute("ALTER TABLE live_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'video'");
  // Exact 70/30 gift split (owner rule 2026-10-25): additive-only
  // migration, run once per column (guarded by the column-existence
  // checks, so repeat boots are no-ops and never double-backfill).
  // gift_events: new milli columns backfill from the OLD rounded
  // integer shares (legacy rows keep their rounded values as their
  // "exact" history — the old over-credit on 1-coin roses is sunk,
  // not clawed back); creator_credited_coins backfills to the old
  // creator_share, i.e. what was actually credited then.
  const giftCols = await client.execute("PRAGMA table_info(gift_events)");
  const giftColNames = new Set(giftCols.rows.map((r) => r.name));
  if (!giftColNames.has("creator_share_milli")) {
    await client.execute("ALTER TABLE gift_events ADD COLUMN creator_share_milli INTEGER NOT NULL DEFAULT 0");
    await client.execute("ALTER TABLE gift_events ADD COLUMN platform_share_milli INTEGER NOT NULL DEFAULT 0");
    await client.execute("ALTER TABLE gift_events ADD COLUMN creator_credited_coins INTEGER NOT NULL DEFAULT 0");
    await client.execute("UPDATE gift_events SET creator_share_milli = creator_share * 1000, platform_share_milli = platform_share * 1000, creator_credited_coins = creator_share");
  }
  // live_sessions: exact platform cut + session credited totals backfill
  // from the legacy integer totals (creator_credited = gross - cut).
  if (!liveColNames.has("platform_cut_milli")) {
    await client.execute("ALTER TABLE live_sessions ADD COLUMN platform_cut_milli INTEGER NOT NULL DEFAULT 0");
    await client.execute("ALTER TABLE live_sessions ADD COLUMN creator_credited_coins INTEGER NOT NULL DEFAULT 0");
    await client.execute("UPDATE live_sessions SET platform_cut_milli = platform_cut_coins * 1000, creator_credited_coins = total_gift_coins - platform_cut_coins");
  }
  // users: per-creator exact cumulative. Backfilled to (old integer
  // creator shares) * 1000 — always a multiple of 1000 — so the first
  // gifts under the new rule credit exactly floor(new exact / 1000)
  // and the carry remainder starts at 0 for every creator. No old
  // balance is touched: coin_balance keeps what was already credited.
  // Settings & Privacy columns (2026-10-26): additive-only.
  if (!colNames.has("private_account")) await client.execute("ALTER TABLE users ADD COLUMN private_account INTEGER NOT NULL DEFAULT 0");
  if (!colNames.has("comment_permission")) await client.execute("ALTER TABLE users ADD COLUMN comment_permission TEXT NOT NULL DEFAULT 'everyone'");
  if (!colNames.has("message_permission")) await client.execute("ALTER TABLE users ADD COLUMN message_permission TEXT NOT NULL DEFAULT 'everyone'");
  const commentCols = await client.execute("PRAGMA table_info(comments)");
  const commentColNames = new Set(commentCols.rows.map((r) => r.name));
  if (!commentColNames.has("parent_id")) await client.execute("ALTER TABLE comments ADD COLUMN parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE");
  if (!colNames.has("gift_earned_milli")) {
    await client.execute("ALTER TABLE users ADD COLUMN gift_earned_milli INTEGER NOT NULL DEFAULT 0");
    await client.execute(
      "UPDATE users SET gift_earned_milli = (SELECT COALESCE(SUM(creator_share), 0) * 1000 FROM gift_events WHERE gift_events.creator_id = users.id)",
    );
  }
  // Phase 2 tables (2026-10-26): CREATE TABLE IF NOT EXISTS — additive only, existing rows untouched.
  await client.execute(`CREATE TABLE IF NOT EXISTS post_events (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, event TEXT NOT NULL, duration_ms INTEGER NOT NULL DEFAULT 0, watch_ms INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`);
  await client.execute(`CREATE TABLE IF NOT EXISTS post_shares (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, UNIQUE(post_id, user_id))`);
  await client.execute(`CREATE TABLE IF NOT EXISTS hidden_for_viewer (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, scope TEXT NOT NULL, target_id INTEGER NOT NULL, created_at INTEGER NOT NULL, UNIQUE(user_id, scope, target_id))`);
  await client.execute(`CREATE TABLE IF NOT EXISTS saved_posts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, UNIQUE(user_id, post_id))`);
  await client.execute(`CREATE TABLE IF NOT EXISTS muted_users (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, muted_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, UNIQUE(user_id, muted_id))`);
  await client.execute(`CREATE TABLE IF NOT EXISTS comment_keywords (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, keyword TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(user_id, keyword))`);
  await client.execute(`CREATE TABLE IF NOT EXISTS moderation_appeals (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, target_type TEXT NOT NULL, target_id INTEGER NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', decided_by INTEGER REFERENCES users(id), decided_at INTEGER, created_at INTEGER NOT NULL)`);
  await client.execute(`CREATE TABLE IF NOT EXISTS admin_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id INTEGER NOT NULL, details TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)`);
  await client.execute(`CREATE TABLE IF NOT EXISTS playlists (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  await client.execute(`CREATE TABLE IF NOT EXISTS playlist_items (id INTEGER PRIMARY KEY AUTOINCREMENT, playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE, post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, UNIQUE(playlist_id, post_id))`);
  await client.execute(`CREATE TABLE IF NOT EXISTS user_interests (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, tag TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(user_id, tag))`);
  await client.execute(`CREATE TABLE IF NOT EXISTS client_metrics (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, kind TEXT NOT NULL, value_ms INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`);
  const _p2post = await client.execute("PRAGMA table_info(posts)"); const _p2pn = new Set(_p2post.rows.map((r) => r.name));
  if (!_p2pn.has("comments_allowed")) await client.execute("ALTER TABLE posts ADD COLUMN comments_allowed INTEGER NOT NULL DEFAULT 1");
  if (!_p2pn.has("duet_allowed")) await client.execute("ALTER TABLE posts ADD COLUMN duet_allowed INTEGER NOT NULL DEFAULT 1");
  const _liveCols2 = await client.execute("PRAGMA table_info(live_sessions)"); const _liveNames = new Set(_liveCols2.rows.map((r) => r.name));
  if (!_liveNames.has("category")) await client.execute("ALTER TABLE live_sessions ADD COLUMN category TEXT NOT NULL DEFAULT ''");
  if (!_liveNames.has("cover_url")) await client.execute("ALTER TABLE live_sessions ADD COLUMN cover_url TEXT");
  if (!_liveNames.has("audience")) await client.execute("ALTER TABLE live_sessions ADD COLUMN audience TEXT NOT NULL DEFAULT 'everyone'");
  const _p2com = await client.execute("PRAGMA table_info(comments)"); const _p2cn = new Set(_p2com.rows.map((r) => r.name));
  if (!_p2cn.has("pinned")) await client.execute("ALTER TABLE comments ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");


}
