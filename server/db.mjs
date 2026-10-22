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
      avatar_url TEXT,
      avatar_public_id TEXT,
      coin_balance INTEGER NOT NULL DEFAULT 0,
      referral_code TEXT NOT NULL UNIQUE,
      referred_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
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
      tid TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      reviewed_by INTEGER REFERENCES users(id),
      reviewed_at INTEGER,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_likes_post ON likes(post_id)`,
    `CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id)`,
    `CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id)`,
    `CREATE INDEX IF NOT EXISTS idx_users_coins ON users(coin_balance)`,
  ];
  for (const sql of statements) {
    await client.execute(sql);
  }
}
