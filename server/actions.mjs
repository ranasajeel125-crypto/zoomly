// Business logic for Zoomly. Every action is an async function
// `(args) => responseObject`, exposed by index.mjs as POST /api/<name>.
// Mirrors the SMM panel's conventions: zod validation, PBKDF2 password
// hashes, SHA-256-hashed session tokens stored in the DB.
import { z } from "zod";
import { and, desc, eq, gte, inArray, isNull, like, lt, ne, notInArray, or, sql } from "drizzle-orm";
import { db } from "./db.mjs";
import * as schema from "./schema.mjs";
import {
  COIN_PACKS,
  CUSTOM_BUY_MIN_COINS,
  WITHDRAW_MIN_COINS,
  GIFT_CATALOG,
  iceServers,
  JAZZCASH,
  LEADERBOARD_LIMIT,
  REFERRAL_REWARD_COINS,
  REPORT_AUTOHIDE_THRESHOLD,
  findBannedContent,
  giftForKey,
  giftSplit,
  isAdminUser,
  levelFor,
} from "./config.mjs";
import { destroyFromCloudinary } from "./cloudinary.mjs";
import { broadcastGift, endLiveSession, hasBroadcaster, isInMatch, noteGiftForMatch, viewerCountFor } from "./live.mjs";

const encoder = new TextEncoder();

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

async function sha256(value) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 120000 }, key, 256);
  return `pbkdf2$120000$${bytesToHex(salt)}$${bytesToHex(new Uint8Array(bits))}`;
}

async function verifyPassword(password, stored) {
  const [kind, iterationsText, saltHex, expectedHex] = String(stored).split("$");
  if (kind !== "pbkdf2" || !iterationsText || !saltHex || !expectedHex) return false;
  const iterations = Number(iterationsText);
  if (!Number.isFinite(iterations) || iterations < 100000) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: hexToBytes(saltHex), iterations }, key, 256);
  const actual = new Uint8Array(bits);
  const expected = hexToBytes(expectedHex);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i += 1) diff |= (actual[i] ?? 0) ^ (expected[i] ?? 0);
  return diff === 0;
}

async function createSession(userId) {
  const raw = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  await db.insert(schema.sessions).values({
    userId,
    tokenHash: await sha256(raw),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });
  return raw;
}

// Exported so index.mjs can hand it to the live WebSocket hub (live.mjs)
// for socket authentication — live.mjs must not import this module.
export async function authUser(token) {
  if (!token) return null;
  const rows = await db
    .select({ user: schema.users, expiresAt: schema.sessions.expiresAt })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
    .where(eq(schema.sessions.tokenHash, await sha256(token)))
    .limit(1);
  const row = rows[0];
  if (!row || row.expiresAt.getTime() <= Date.now()) return null;
  // A banned user's existing sessions stop working immediately.
  if (row.user.banned) return null;
  return row.user;
}

// ---- DTOs -----------------------------------------------------------------

function authorDto(user) {
  return {
    id: user.id,
    username: user.username,
    display_name: user.displayName,
    avatar_url: user.avatarUrl ?? null,
    // Derived from the same admin check as is_admin — never a stored or
    // user-editable field, so only the owner's account can ever carry it.
    is_owner: isAdminUser(user),
  };
}

function withdrawalDto(r) {
  return {
    id: r.id,
    coins: r.coins,
    amount_pkr: r.amountPkr,
    jazzcash_number: r.jazzcashNumber,
    account_title: r.accountTitle,
    status: r.status,
    created_at: r.createdAt.getTime(),
    decided_at: r.decidedAt ? r.decidedAt.getTime() : null,
  };
}

function publicUserDto(user, referralCount) {
  return {
    ...authorDto(user),
    bio: user.bio ?? "",
    coin_balance: user.coinBalance,
    referral_count: referralCount ?? 0,
    ...levelFor(user.coinBalance),
  };
}

async function referralCounts() {
  const rows = await db
    .select({ referredBy: schema.users.referredBy, count: sql`count(*)`.mapWith(Number) })
    .from(schema.users)
    .where(sql`${schema.users.referredBy} is not null`)
    .groupBy(schema.users.referredBy);
  return new Map(rows.map((r) => [r.referredBy, r.count]));
}

// Best-effort in-app notification write: a notification failure must never
// fail the action that triggered it, so errors are logged and swallowed.
async function notify({ userId, type, actorId = null, postId = null, liveSessionId = null, text, coins = null }) {
  if (!userId || !text) return;
  try {
    await db.insert(schema.notifications).values({ userId, type, actorId, postId, liveSessionId, text, coins });
  } catch (err) {
    console.error("[notify] insert failed:", err?.message || err);
  }
}

// ---- Stories (24h) --------------------------------------------------------------
const STORY_TTL_MS = 24 * 60 * 60 * 1000;

function storyDto(s, viewCount, seenByMe) {
  return {
    id: s.id,
    media_url: s.mediaUrl,
    media_type: s.mediaType,
    created_at: s.createdAt.getTime(),
    view_count: viewCount ?? 0,
    seen_by_me: Boolean(seenByMe),
  };
}

// Active (< 24h) stories of one author as DTOs, with view counts and the
// viewer's seen flags.
async function storyDtosFor(authorId, viewerId) {
  const cutoff = new Date(Date.now() - STORY_TTL_MS);
  const rows = await db
    .select()
    .from(schema.stories)
    .where(and(eq(schema.stories.userId, authorId), gte(schema.stories.createdAt, cutoff)))
    .orderBy(schema.stories.createdAt);
  if (rows.length === 0) return [];
  const ids = rows.map((s) => s.id);
  const viewRows = await db
    .select({ storyId: schema.storyViews.storyId, viewerId: schema.storyViews.viewerId, count: sql`count(*)`.mapWith(Number) })
    .from(schema.storyViews)
    .where(inArray(schema.storyViews.storyId, ids))
    .groupBy(schema.storyViews.storyId, schema.storyViews.viewerId);
  const counts = new Map();
  const seen = new Set();
  for (const r of viewRows) {
    counts.set(r.storyId, (counts.get(r.storyId) ?? 0) + r.count);
    if (r.viewerId === viewerId) seen.add(r.storyId);
  }
  return rows.map((s) => storyDto(s, counts.get(s.id) ?? 0, seen.has(s.id)));
}

// Who may see an author's stories: the author, or someone who follows them.
async function canViewStories(viewerId, authorId) {
  if (viewerId === authorId) return true;
  const rows = await db
    .select({ id: schema.follows.id })
    .from(schema.follows)
    .where(and(eq(schema.follows.followerId, viewerId), eq(schema.follows.followeeId, authorId)))
    .limit(1);
  return rows.length > 0;
}

// ---- Moderation helpers -------------------------------------------------------
// Every user id that has a block relationship with `userId`, in EITHER
// direction (people they blocked + people who blocked them). Content from
// these users is hidden from `userId` and interactions are refused.
async function blockedIdsFor(userId) {
  const rows = await db
    .select()
    .from(schema.blocks)
    .where(or(eq(schema.blocks.userId, userId), eq(schema.blocks.blockedId, userId)));
  const ids = new Set();
  for (const r of rows) ids.add(r.userId === userId ? r.blockedId : r.userId);
  return ids;
}

async function blockExistsBetween(a, b) {
  const rows = await db
    .select({ id: schema.blocks.id })
    .from(schema.blocks)
    .where(
      or(
        and(eq(schema.blocks.userId, a), eq(schema.blocks.blockedId, b)),
        and(eq(schema.blocks.userId, b), eq(schema.blocks.blockedId, a)),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

// Resolves a report target to { ownerId, post?, comment?, session?, targetUser? }
// or null when the target does not exist.
async function resolveReportTarget(targetType, targetId) {
  if (targetType === "post") {
    const post = (await db.select().from(schema.posts).where(eq(schema.posts.id, targetId)).limit(1))[0];
    return post ? { ownerId: post.userId, post } : null;
  }
  if (targetType === "comment") {
    const comment = (await db.select().from(schema.comments).where(eq(schema.comments.id, targetId)).limit(1))[0];
    return comment ? { ownerId: comment.userId, comment } : null;
  }
  if (targetType === "live") {
    const session = (await db.select().from(schema.liveSessions).where(eq(schema.liveSessions.id, targetId)).limit(1))[0];
    return session ? { ownerId: session.userId, session } : null;
  }
  const targetUser = (await db.select().from(schema.users).where(eq(schema.users.id, targetId)).limit(1))[0];
  return targetUser ? { ownerId: targetUser.id, targetUser } : null;
}

// Auto-catch layer 2: once a post/live has REPORT_AUTOHIDE_THRESHOLD
// distinct pending reporters, hide it for everyone except its owner until
// the owner (admin) reviews it. Returns true when this call hid it.
async function maybeAutoHide(targetType, targetId, ownerId) {
  if (targetType !== "post" && targetType !== "live") return false;
  const rows = await db
    .select({ reporterId: schema.reports.reporterId })
    .from(schema.reports)
    .where(and(eq(schema.reports.targetType, targetType), eq(schema.reports.targetId, targetId), eq(schema.reports.status, "pending")));
  const distinct = new Set(rows.map((r) => r.reporterId)).size;
  if (distinct < REPORT_AUTOHIDE_THRESHOLD) return false;
  if (targetType === "post") {
    const post = (await db.select({ hidden: schema.posts.hidden }).from(schema.posts).where(eq(schema.posts.id, targetId)).limit(1))[0];
    if (!post || post.hidden) return false;
    await db.update(schema.posts).set({ hidden: 1 }).where(eq(schema.posts.id, targetId));
  } else {
    const session = (await db.select({ hidden: schema.liveSessions.hidden }).from(schema.liveSessions).where(eq(schema.liveSessions.id, targetId)).limit(1))[0];
    if (!session || session.hidden) return false;
    await db.update(schema.liveSessions).set({ hidden: 1 }).where(eq(schema.liveSessions.id, targetId));
  }
  // Track repeat offenders: the admin queue flags owners hidden 2+ times.
  await db.update(schema.users).set({ hiddenCount: sql`${schema.users.hiddenCount} + 1` }).where(eq(schema.users.id, ownerId));
  return true;
}

async function followCounts(userId) {
  const [followers, following] = await Promise.all([
    db.select({ count: sql`count(*)`.mapWith(Number) }).from(schema.follows).where(eq(schema.follows.followeeId, userId)),
    db.select({ count: sql`count(*)`.mapWith(Number) }).from(schema.follows).where(eq(schema.follows.followerId, userId)),
  ]);
  return { followers: followers[0]?.count ?? 0, following: following[0]?.count ?? 0 };
}

async function meDto(user) {
  const counts = await referralCounts();
  const fc = await followCounts(user.id);
  const unreadRows = await db
    .select({ count: sql`count(*)`.mapWith(Number) })
    .from(schema.notifications)
    .where(and(eq(schema.notifications.userId, user.id), eq(schema.notifications.read, 0)));
  const unreadMsgRows = await db
    .select({ count: sql`count(*)`.mapWith(Number) })
    .from(schema.messages)
    .where(and(eq(schema.messages.recipientId, user.id), isNull(schema.messages.readAt)));
  return {
    ...publicUserDto(user, counts.get(user.id) ?? 0),
    referral_code: user.referralCode,
    referred_by: user.referredBy ?? null,
    live_title: user.liveTitle ?? null,
    follower_count: fc.followers,
    following_count: fc.following,
    is_admin: isAdminUser(user),
    unread_notifications: unreadRows[0]?.count ?? 0,
    unread_messages: unreadMsgRows[0]?.count ?? 0,
  };
}

async function postDtos(postRows, viewer) {
  if (postRows.length === 0) return [];
  const postIds = postRows.map((p) => p.id);
  const authorIds = [...new Set(postRows.map((p) => p.userId))];
  const [authors, likeRows, commentRows, myLikes, myFollows] = await Promise.all([
    db.select().from(schema.users).where(inArray(schema.users.id, authorIds)),
    db.select({ postId: schema.likes.postId, count: sql`count(*)`.mapWith(Number) }).from(schema.likes).where(inArray(schema.likes.postId, postIds)).groupBy(schema.likes.postId),
    db.select({ postId: schema.comments.postId, count: sql`count(*)`.mapWith(Number) }).from(schema.comments).where(inArray(schema.comments.postId, postIds)).groupBy(schema.comments.postId),
    db.select({ postId: schema.likes.postId }).from(schema.likes).where(and(eq(schema.likes.userId, viewer.id), inArray(schema.likes.postId, postIds))),
    db.select({ followeeId: schema.follows.followeeId }).from(schema.follows).where(and(eq(schema.follows.followerId, viewer.id), inArray(schema.follows.followeeId, authorIds))),
  ]);
  const authorMap = new Map(authors.map((a) => [a.id, a]));
  const likeMap = new Map(likeRows.map((r) => [r.postId, r.count]));
  const commentMap = new Map(commentRows.map((r) => [r.postId, r.count]));
  const likedSet = new Set(myLikes.map((r) => r.postId));
  const followSet = new Set(myFollows.map((r) => r.followeeId));
  return postRows.map((p) => ({
    id: p.id,
    title: p.title,
    description: p.description,
    video_url: p.videoUrl,
    thumbnail_url: p.thumbnailUrl ?? null,
    created_at: p.createdAt.getTime(),
    hidden: Boolean(p.hidden),
    like_count: likeMap.get(p.id) ?? 0,
    comment_count: commentMap.get(p.id) ?? 0,
    liked_by_me: likedSet.has(p.id),
    author: authorMap.get(p.userId) ? { ...authorDto(authorMap.get(p.userId)), followed_by_me: followSet.has(p.userId), is_me: p.userId === viewer.id } : null,
  }));
}

function liveSessionDto(session, broadcaster) {
  return {
    id: session.id,
    user_id: session.userId,
    title: session.title,
    started_at: session.startedAt.getTime(),
    ended_at: session.endedAt ? session.endedAt.getTime() : null,
    is_live: !session.endedAt,
    hidden: Boolean(session.hidden),
    in_match: !session.endedAt && isInMatch(session.id),
    viewer_count: viewerCountFor(session.id),
    peak_viewers: session.peakViewers,
    total_gift_coins: session.totalGiftCoins,
    platform_cut_coins: session.platformCutCoins,
    creator_earned_coins: session.totalGiftCoins - session.platformCutCoins,
    broadcaster: broadcaster ? authorDto(broadcaster) : null,
  };
}

// ---- Referral -------------------------------------------------------------
// First valid claim only: sets referred_by so the inviter's referral COUNT
// goes up (leaderboard + profile counts), and credits the INVITER
// REFERRAL_REWARD_COINS (+1) as part of that same one-time operation. The
// new user gets NO coins — the welcome bonus stays removed. The link UPDATE
// only lands while referred_by is still NULL, so replays/retries/races can
// never set it — or pay the reward — twice.
//
// Anti-self-referral guard (gates ONLY the coin, never the count): one
// person must not farm coins by signing up alt accounts on their own
// device and cashing out at 100. The coin is withheld when
//   (a) the new account's signup_device is non-null and matches ANY other
//       existing account's signup_device (same physical device/browser
//       already had an account — the inviter's own device included), or
//   (b) the signup sent no device id AND the new account's signup_ip
//       exactly matches the inviter's signup_ip (same-network signal with
//       no device proof to clear it).
// Missing data never blocks by itself (legacy accounts have NULLs), and a
// device-cleared signup is never blocked on IP alone — Pakistani mobile
// IPs are shared (CGNAT), so IP is only a fallback signal.
async function referralCoinBlocked(user, inviter) {
  if (user.signupDevice) {
    const clash = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.signupDevice, user.signupDevice), ne(schema.users.id, user.id)))
      .limit(1);
    return clash.length > 0;
  }
  return Boolean(user.signupIp && inviter.signupIp && user.signupIp === inviter.signupIp);
}

async function applyReferral(user, rawCode) {
  const code = String(rawCode || "").trim().toUpperCase();
  if (!code) return { ok: false, message: "Enter a referral code." };
  if (user.referredBy) return { ok: false, message: "You have already claimed a referral code." };
  const inviters = await db.select().from(schema.users).where(eq(schema.users.referralCode, code)).limit(1);
  const inviter = inviters[0];
  if (!inviter) return { ok: false, message: "That referral code was not found." };
  if (inviter.id === user.id) return { ok: false, message: "You cannot use your own referral code." };
  const linked = await db
    .update(schema.users)
    .set({ referredBy: inviter.id })
    .where(and(eq(schema.users.id, user.id), isNull(schema.users.referredBy)))
    .returning({ id: schema.users.id });
  if (linked.length === 0) return { ok: false, message: "You have already claimed a referral code." };
  const credited = !(await referralCoinBlocked(user, inviter));
  if (credited) {
    await db
      .update(schema.users)
      .set({ coinBalance: sql`${schema.users.coinBalance} + ${REFERRAL_REWARD_COINS}` })
      .where(eq(schema.users.id, inviter.id));
  }
  await notify({
    userId: inviter.id,
    type: "referral",
    actorId: user.id,
    text: credited
      ? `@${user.username} joined Zoomly with your referral code 🎉 +${REFERRAL_REWARD_COINS} coin tumhare balance me add ho gaya!`
      : `@${user.username} joined Zoomly with your referral code 🎉`,
  });
  return { ok: true, message: `Referral claimed! @${inviter.username} is now counted as your referrer.` };
}

// ---- Google sign-in ---------------------------------------------------------
// Called from the OAuth callback (index.mjs) with the verified Google
// profile { sub, email, name, picture }.
// - Known google_id: fill in a missing DP/email, issue a normal session.
// - New google_id:   { status: "pending" } — the client must still pick a
//   username via googleCompleteSignup before the account exists.
export async function googleSignIn(profile) {
  const rows = await db.select().from(schema.users).where(eq(schema.users.googleId, profile.sub)).limit(1);
  const user = rows[0];
  if (!user) return { status: "pending" };
  if (user.banned) return { status: "banned", reason: user.banReason ?? "" };
  const patch = {};
  if (!user.avatarUrl && profile.picture) patch.avatarUrl = profile.picture;
  if (!user.email && profile.email) patch.email = profile.email;
  if (Object.keys(patch).length > 0) {
    await db.update(schema.users).set(patch).where(eq(schema.users.id, user.id));
    Object.assign(user, patch);
  }
  const token = await createSession(user.id);
  return { status: "login", token, user: await meDto(user) };
}

// Finalizes a first-time Google signup once the user has picked a username.
// Mirrors the password signup: referral code is generated, an optional
// referral claim links the referrer (the inviter earns the guarded +1 coin
// — see applyReferral), and the Google profile picture becomes the DP.
export async function googleCompleteSignup(profile, rawArgs) {
  const parsed = z
    .object({
      username: usernameRule,
      display_name: z.string().trim().min(2).max(60).optional(),
      referral_code: z.string().trim().max(64).optional(),
      device_id: z.string().trim().max(64).optional(),
    })
    .safeParse(rawArgs ?? {});
  if (!parsed.success) return { ok: false, message: "Please pick a valid username (3–24 letters, numbers or underscores)." };
  const args = parsed.data;
  const username = args.username.toLowerCase();

  const linked = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.googleId, profile.sub)).limit(1);
  if (linked.length > 0) return { ok: false, message: "This Google account is already linked to a Zoomly account — please log in instead." };
  const existing = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, username)).limit(1);
  if (existing.length > 0) return { ok: false, message: "That username is already taken — please pick another." };

  const displayName = (args.display_name?.trim() || profile.name || username).slice(0, 60);
  if (findBannedContent(displayName)) return { ok: false, message: "Is display name me aisi language allowed nahi hai — koi aur name choose karein." };
  const tempCode = `PENDING-${bytesToHex(crypto.getRandomValues(new Uint8Array(8)))}`;
  const inserted = await db
    .insert(schema.users)
    .values({
      username,
      displayName,
      // Google accounts have no password; store a hash of a random secret so
      // password login simply never matches (and the NOT NULL column holds).
      passwordHash: await hashPassword(bytesToHex(crypto.getRandomValues(new Uint8Array(32)))),
      googleId: profile.sub,
      email: profile.email ?? null,
      avatarUrl: profile.picture ?? null,
      referralCode: tempCode,
      // Anti-self-referral guard inputs, same as the password signup.
      signupDevice: args.device_id || null,
      signupIp: rawArgs?.__ip || null,
    })
    .returning();
  const user = inserted[0];
  if (!user) return { ok: false, message: "Account could not be created." };
  const referralCode = `ZOOM-${user.id}-${username.toUpperCase()}`;
  await db.update(schema.users).set({ referralCode }).where(eq(schema.users.id, user.id));
  user.referralCode = referralCode;
  let referralMessage = null;
  if (args.referral_code) {
    const claim = await applyReferral(user, args.referral_code);
    referralMessage = claim.message;
    if (claim.ok) {
      const fresh = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).limit(1);
      if (fresh[0]) Object.assign(user, fresh[0]);
    }
  }
  const token = await createSession(user.id);
  return { ok: true, message: "Account created with Google.", token, user: await meDto(user), referral_message: referralMessage };
}

// Validates request args with zod; returns { ok:false, message } on bad input.
// The handler also receives the RAW args as its second parameter so it can
// read server-injected fields that are not part of the client contract
// (currently __ip, set by index.mjs from the request — never client data).
function withValidation(shape, handler) {
  return async (rawArgs) => {
    let args;
    try {
      args = shape.parse(rawArgs ?? {});
    } catch {
      return { ok: false, message: "Invalid request." };
    }
    return handler(args, rawArgs ?? {});
  };
}

const tokenArg = z.string().min(1);
const usernameRule = z
  .string()
  .trim()
  .min(3)
  .max(24)
  .regex(/^[a-zA-Z0-9_]+$/, "Username can only use letters, numbers and underscores.");

export const Actions = {
  signup: withValidation(
    z.object({
      username: usernameRule,
      display_name: z.string().trim().min(2).max(60).optional(),
      password: z.string().min(6).max(128),
      referral_code: z.string().trim().max(64).optional(),
      device_id: z.string().trim().max(64).optional(),
    }),
    async (args, rawArgs) => {
      const username = args.username.toLowerCase();
      if (args.display_name && findBannedContent(args.display_name)) {
        return { ok: false, message: "Is display name me aisi language allowed nahi hai — koi aur name choose karein." };
      }
      const existing = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, username)).limit(1);
      if (existing.length > 0) return { ok: false, message: "That username is already taken." };
      const tempCode = `PENDING-${bytesToHex(crypto.getRandomValues(new Uint8Array(8)))}`;
      const inserted = await db
        .insert(schema.users)
        .values({
          username,
          displayName: args.display_name?.trim() || username,
          passwordHash: await hashPassword(args.password),
          referralCode: tempCode,
          // Anti-self-referral guard inputs (see applyReferral): the device
          // id the client sent, and the request IP injected by index.mjs.
          signupDevice: args.device_id || null,
          signupIp: rawArgs?.__ip || null,
        })
        .returning();
      const user = inserted[0];
      if (!user) return { ok: false, message: "Account could not be created." };
      const referralCode = `ZOOM-${user.id}-${username.toUpperCase()}`;
      await db.update(schema.users).set({ referralCode }).where(eq(schema.users.id, user.id));
      user.referralCode = referralCode;
      let referralMessage = null;
      if (args.referral_code) {
        const claim = await applyReferral(user, args.referral_code);
        referralMessage = claim.message;
        if (claim.ok) {
          const fresh = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).limit(1);
          if (fresh[0]) Object.assign(user, fresh[0]);
        }
      }
      const token = await createSession(user.id);
      return { ok: true, message: "Account created.", token, user: await meDto(user), referral_message: referralMessage };
    }
  ),

  login: withValidation(
    z.object({ username: z.string().trim().min(1).max(24), password: z.string().min(1).max(128) }),
    async (args) => {
      const rows = await db.select().from(schema.users).where(eq(schema.users.username, args.username.toLowerCase())).limit(1);
      const user = rows[0];
      if (!user || !(await verifyPassword(args.password, user.passwordHash))) {
        return { ok: false, message: "Username or password is incorrect." };
      }
      if (user.banned) {
        return { ok: false, message: `Your account has been banned by the owner.${user.banReason ? ` Reason: ${user.banReason}` : ""}` };
      }
      const token = await createSession(user.id);
      return { ok: true, message: "Signed in.", token, user: await meDto(user) };
    }
  ),

  logout: withValidation(z.object({ token: tokenArg }), async (args) => {
    await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, await sha256(args.token)));
    return { ok: true, message: "Signed out." };
  }),

  getMe: withValidation(z.object({ token: tokenArg }), async (args) => {
    const user = await authUser(args.token);
    if (!user) return { ok: false, message: "Please sign in." };
    return { ok: true, user: await meDto(user) };
  }),

  updateProfile: withValidation(
    z.object({ token: tokenArg, display_name: z.string().trim().min(2).max(60), bio: z.string().trim().max(300).optional() }),
    async (args) => {
      const user = await authUser(args.token);
      if (!user) return { ok: false, message: "Please sign in." };
      if (findBannedContent(args.display_name)) return { ok: false, message: "Is display name me aisi language allowed nahi hai." };
      await db.update(schema.users).set({ displayName: args.display_name, bio: args.bio ?? user.bio }).where(eq(schema.users.id, user.id));
      const fresh = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).limit(1);
      return { ok: true, message: "Profile updated.", user: await meDto(fresh[0]) };
    }
  ),

  // Called after /api/upload (kind=avatar) returns the Cloudinary URL.
  setAvatar: withValidation(
    z.object({ token: tokenArg, avatar_url: z.string().url().max(2000), avatar_public_id: z.string().max(300).optional() }),
    async (args) => {
      const user = await authUser(args.token);
      if (!user) return { ok: false, message: "Please sign in." };
      const oldPublicId = user.avatarPublicId;
      await db.update(schema.users).set({ avatarUrl: args.avatar_url, avatarPublicId: args.avatar_public_id ?? null }).where(eq(schema.users.id, user.id));
      if (oldPublicId && oldPublicId !== args.avatar_public_id) await destroyFromCloudinary(oldPublicId, "image");
      const fresh = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).limit(1);
      return { ok: true, message: "Profile photo updated.", user: await meDto(fresh[0]) };
    }
  ),

  removeAvatar: withValidation(z.object({ token: tokenArg }), async (args) => {
    const user = await authUser(args.token);
    if (!user) return { ok: false, message: "Please sign in." };
    const oldPublicId = user.avatarPublicId;
    await db.update(schema.users).set({ avatarUrl: null, avatarPublicId: null }).where(eq(schema.users.id, user.id));
    if (oldPublicId) await destroyFromCloudinary(oldPublicId, "image");
    const fresh = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).limit(1);
    return { ok: true, message: "Profile photo removed.", user: await meDto(fresh[0]) };
  }),

  getFeed: withValidation(
    z.object({ token: tokenArg, stream: z.enum(["foryou", "following"]).default("foryou"), limit: z.number().int().min(1).max(50).default(20), offset: z.number().int().min(0).default(0) }),
    async (args) => {
      const user = await authUser(args.token);
      if (!user) return { ok: false, message: "Please sign in." };
      // Hidden posts (auto-hidden by reports / moderation) show only to
      // their owner; blocked users' posts never reach this viewer.
      const blocked = await blockedIdsFor(user.id);
      const visible = or(eq(schema.posts.hidden, 0), eq(schema.posts.userId, user.id));
      let rows;
      if (args.stream === "following") {
        const followees = await db.select({ id: schema.follows.followeeId }).from(schema.follows).where(eq(schema.follows.followerId, user.id));
        const ids = followees.map((f) => f.id).filter((id) => !blocked.has(id));
        if (ids.length === 0) return { ok: true, posts: [] };
        rows = await db.select().from(schema.posts).where(and(inArray(schema.posts.userId, ids), visible)).orderBy(desc(schema.posts.createdAt)).limit(args.limit).offset(args.offset);
      } else {
        const conds = [visible];
        if (blocked.size > 0) conds.push(notInArray(schema.posts.userId, [...blocked]));
        rows = await db.select().from(schema.posts).where(and(...conds)).orderBy(desc(schema.posts.createdAt)).limit(args.limit).offset(args.offset);
      }
      return { ok: true, posts: await postDtos(rows, user) };
    }
  ),

  getWatch: withValidation(
    z.object({ token: tokenArg, query: z.string().trim().max(120).optional(), limit: z.number().int().min(1).max(50).default(30), offset: z.number().int().min(0).default(0) }),
    async (args) => {
      const user = await authUser(args.token);
      if (!user) return { ok: false, message: "Please sign in." };
      const blocked = await blockedIdsFor(user.id);
      const conds = [or(eq(schema.posts.hidden, 0), eq(schema.posts.userId, user.id))];
      if (blocked.size > 0) conds.push(notInArray(schema.posts.userId, [...blocked]));
      if (args.query) {
        const term = `%${args.query}%`;
        conds.push(or(like(schema.posts.title, term), like(schema.posts.description, term)));
      }
      const rows = await db.select().from(schema.posts).where(and(...conds)).orderBy(desc(schema.posts.createdAt)).limit(args.limit).offset(args.offset);
      return { ok: true, posts: await postDtos(rows, user) };
    }
  ),

  // Single-post lookup for share deep links (/?v=<id>): respects the same
  // hidden/block rules as the feed — a hidden or unavailable video returns
  // a clean failure so the client can show a graceful message.
  getPost: withValidation(z.object({ token: tokenArg, post_id: z.number().int().positive() }), async (args) => {
    const user = await authUser(args.token);
    if (!user) return { ok: false, message: "Please sign in." };
    const post = (await db.select().from(schema.posts).where(eq(schema.posts.id, args.post_id)).limit(1))[0];
    if (!post) return { ok: false, message: "Video not found." };
    if (post.hidden && post.userId !== user.id) return { ok: false, message: "Ye video abhi available nahi hai (review me hai)." };
    if (post.userId !== user.id && (await blockExistsBetween(user.id, post.userId))) return { ok: false, message: "Video not available." };
    return { ok: true, post: (await postDtos([post], user))[0] };
  }),

  createPost: withValidation(
    z.object({
      token: tokenArg,
      title: z.string().trim().min(1).max(140),
      description: z.string().trim().max(1000).optional(),
      video_url: z.string().url().max(2000),
      video_public_id: z.string().max(300).optional(),
      thumbnail_url: z.string().url().max(2000).optional(),
    }),
    async (args) => {
      const user = await authUser(args.token);
      if (!user) return { ok: false, message: "Please sign in." };
      if (findBannedContent(args.title) || findBannedContent(args.description ?? "")) {
        return { ok: false, message: "Video ke title/description me aisi language ya link allowed nahi hai." };
      }
      const inserted = await db
        .insert(schema.posts)
        .values({ userId: user.id, title: args.title, description: args.description ?? "", videoUrl: args.video_url, videoPublicId: args.video_public_id ?? null, thumbnailUrl: args.thumbnail_url ?? null })
        .returning();
      const post = inserted[0];
      if (!post) return { ok: false, message: "Post could not be created." };
      return { ok: true, message: "Video posted.", post: (await postDtos([post], user))[0] };
    }
  ),

  deletePost: withValidation(z.object({ token: tokenArg, post_id: z.number().int().positive() }), async (args) => {
    const user = await authUser(args.token);
    if (!user) return { ok: false, message: "Please sign in." };
    const rows = await db.select().from(schema.posts).where(eq(schema.posts.id, args.post_id)).limit(1);
    const post = rows[0];
    if (!post) return { ok: false, message: "Video not found." };
    // The post's owner can always delete it; the app owner (admin) can
    // delete ANY user's video — same cleanup as the moderation
    // delete_content path (row removed, Cloudinary asset destroyed,
    // comments/likes go with the row).
    if (post.userId !== user.id && !isAdminUser(user)) return { ok: false, message: "You can only delete your own videos." };
    await db.delete(schema.posts).where(eq(schema.posts.id, post.id));
    if (post.videoPublicId) await destroyFromCloudinary(post.videoPublicId, "video");
    return { ok: true, message: "Video deleted." };
  }),

  toggleLike: withValidation(z.object({ token: tokenArg, post_id: z.number().int().positive() }), async (args) => {
    const user = await authUser(args.token);
    if (!user) return { ok: false, message: "Please sign in." };
    const post = (await db.select({ id: schema.posts.id, userId: schema.posts.userId }).from(schema.posts).where(eq(schema.posts.id, args.post_id)).limit(1))[0];
    if (!post) return { ok: false, message: "Video not found." };
    const existing = await db.select({ id: schema.likes.id }).from(schema.likes).where(and(eq(schema.likes.userId, user.id), eq(schema.likes.postId, args.post_id))).limit(1);
    let liked;
    if (existing.length > 0) {
      await db.delete(schema.likes).where(eq(schema.likes.id, existing[0].id));
      liked = false;
    } else {
      await db.insert(schema.likes).values({ userId: user.id, postId: args.post_id });
      liked = true;
      if (post.userId !== user.id) {
        await notify({ userId: post.userId, type: "like", actorId: user.id, postId: post.id, text: `@${user.username} liked your video ❤️` });
      }
    }
    const countRows = await db.select({ count: sql`count(*)`.mapWith(Number) }).from(schema.likes).where(eq(schema.likes.postId, args.post_id));
    return { ok: true, liked, like_count: countRows[0]?.count ?? 0 };
  }),

  getComments: withValidation(z.object({ token: tokenArg, post_id: z.number().int().positive() }), async (args) => {
    const user = await authUser(args.token);
    if (!user) return { ok: false, message: "Please sign in." };
    const blocked = await blockedIdsFor(user.id);
    const rows = await db
      .select({ comment: schema.comments, author: schema.users })
      .from(schema.comments)
      .innerJoin(schema.users, eq(schema.comments.userId, schema.users.id))
      .where(eq(schema.comments.postId, args.post_id))
      .orderBy(schema.comments.createdAt);
    return {
      ok: true,
      comments: rows
        .filter((r) => !blocked.has(r.author.id))
        .map((r) => ({ id: r.comment.id, body: r.comment.body, created_at: r.comment.createdAt.getTime(), author: authorDto(r.author) })),
    };
  }),

  addComment: withValidation(z.object({ token: tokenArg, post_id: z.number().int().positive(), body: z.string().trim().min(1).max(500) }), async (args) => {
    const user = await authUser(args.token);
    if (!user) return { ok: false, message: "Please sign in." };
    if (findBannedContent(args.body)) {
      return { ok: false, message: "Comment me aisi language ya link allowed nahi hai — comment nahi bheja gaya." };
    }
    const post = (await db.select().from(schema.posts).where(eq(schema.posts.id, args.post_id)).limit(1))[0];
    if (!post) return { ok: false, message: "Video not found." };
    if (post.hidden && post.userId !== user.id) return { ok: false, message: "Video not found." };
    if (post.userId !== user.id && (await blockExistsBetween(user.id, post.userId))) {
      return { ok: false, message: "You can't comment on this video." };
    }
    const inserted = await db.insert(schema.comments).values({ userId: user.id, postId: args.post_id, body: args.body }).returning();
    const comment = inserted[0];
    if (!comment) return { ok: false, message: "Comment could not be posted." };
    if (post.userId !== user.id) {
      await notify({ userId: post.userId, type: "comment", actorId: user.id, postId: post.id, text: `@${user.username} commented: “${args.body.slice(0, 80)}”` });
    }
    return { ok: true, message: "Comment posted.", comment: { id: comment.id, body: comment.body, created_at: comment.createdAt.getTime(), author: authorDto(user) } };
  }),

  toggleFollow: withValidation(z.object({ token: tokenArg, user_id: z.number().int().positive() }), async (args) => {
    const user = await authUser(args.token);
    if (!user) return { ok: false, message: "Please sign in." };
    if (args.user_id === user.id) return { ok: false, message: "You cannot follow yourself." };
    const target = (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, args.user_id)).limit(1))[0];
    if (!target) return { ok: false, message: "User not found." };
    if (await blockExistsBetween(user.id, args.user_id)) return { ok: false, message: "You can't follow this user." };
    const existing = await db.select({ id: schema.follows.id }).from(schema.follows).where(and(eq(schema.follows.followerId, user.id), eq(schema.follows.followeeId, args.user_id))).limit(1);
    let following;
    if (existing.length > 0) {
      await db.delete(schema.follows).where(eq(schema.follows.id, existing[0].id));
      following = false;
    } else {
      await db.insert(schema.follows).values({ followerId: user.id, followeeId: args.user_id });
      following = true;
      await notify({ userId: args.user_id, type: "follow", actorId: user.id, text: `@${user.username} started following you 👥` });
    }
    const countRows = await db.select({ count: sql`count(*)`.mapWith(Number) }).from(schema.follows).where(eq(schema.follows.followeeId, args.user_id));
    return { ok: true, following, follower_count: countRows[0]?.count ?? 0 };
  }),

  getPeople: withValidation(z.object({ token: tokenArg, query: z.string().trim().max(60).optional() }), async (args) => {
    const user = await authUser(args.token);
    if (!user) return { ok: false, message: "Please sign in." };
    let query = db.select().from(schema.users);
    if (args.query) {
      const term = `%${args.query}%`;
      query = query.where(or(like(schema.users.username, term), like(schema.users.displayName, term)));
    }
    const rows = await query.orderBy(desc(schema.users.coinBalance)).limit(100);
    const blocked = await blockedIdsFor(user.id);
    const visibleRows = rows.filter((u) => !blocked.has(u.id));
    const counts = await referralCounts();
    const myFollows = await db.select({ followeeId: schema.follows.followeeId }).from(schema.follows).where(eq(schema.follows.followerId, user.id));
    const followSet = new Set(myFollows.map((f) => f.followeeId));
    const followerRows = await db.select({ followeeId: schema.follows.followeeId, count: sql`count(*)`.mapWith(Number) }).from(schema.follows).groupBy(schema.follows.followeeId);
    const followerMap = new Map(followerRows.map((r) => [r.followeeId, r.count]));
    return {
      ok: true,
      people: visibleRows.map((u) => ({
        ...publicUserDto(u, counts.get(u.id) ?? 0),
        follower_count: followerMap.get(u.id) ?? 0,
        followed_by_me: followSet.has(u.id),
        is_me: u.id === user.id,
      })),
    };
  }),

  getProfile: withValidation(z.object({ token: tokenArg, user_id: z.number().int().positive().optional() }), async (args) => {
    const viewer = await authUser(args.token);
    if (!viewer) return { ok: false, message: "Please sign in." };
    const targetId = args.user_id ?? viewer.id;
    const target = (await db.select().from(schema.users).where(eq(schema.users.id, targetId)).limit(1))[0];
    if (!target) return { ok: false, message: "User not found." };
    const counts = await referralCounts();
    const fc = await followCounts(target.id);
    const allPostRows = await db.select().from(schema.posts).where(eq(schema.posts.userId, target.id)).orderBy(desc(schema.posts.createdAt)).limit(60);
    // A block in either direction hides the videos between the two users;
    // hidden (under-review) videos show only to their owner.
    const blockedPair = target.id !== viewer.id && (await blockExistsBetween(viewer.id, target.id));
    const blockedByMe =
      target.id !== viewer.id &&
      (await db.select({ id: schema.blocks.id }).from(schema.blocks).where(and(eq(schema.blocks.userId, viewer.id), eq(schema.blocks.blockedId, target.id))).limit(1)).length > 0;
    const postRows = blockedPair ? [] : target.id === viewer.id ? allPostRows : allPostRows.filter((p) => !p.hidden);
    const isFollowing = target.id === viewer.id ? false : (await db.select({ id: schema.follows.id }).from(schema.follows).where(and(eq(schema.follows.followerId, viewer.id), eq(schema.follows.followeeId, target.id))).limit(1)).length > 0;
    let referrals = null;
    if (target.id === viewer.id) {
      const referred = await db.select().from(schema.users).where(eq(schema.users.referredBy, target.id)).orderBy(desc(schema.users.createdAt));
      referrals = referred.map((u) => ({ ...authorDto(u), created_at: u.createdAt.getTime() }));
    }
    // Active stories for the profile ring (visible to the owner + followers).
    const profileStories = target.id === viewer.id || isFollowing ? await storyDtosFor(target.id, viewer.id) : [];
    return {
      ok: true,
      profile: {
        ...publicUserDto(target, counts.get(target.id) ?? 0),
        referral_code: target.referralCode,
        follower_count: fc.followers,
        following_count: fc.following,
        video_count: postRows.length,
        is_me: target.id === viewer.id,
        followed_by_me: isFollowing,
        blocked_by_me: blockedByMe,
      },
      posts: await postDtos(postRows, viewer),
      referrals,
      stories: profileStories,
    };
  }),

  // ---- Rewards: referrals + coins + leaderboards ---------------------------

  claimReferral: withValidation(z.object({ token: tokenArg, code: z.string().trim().min(1).max(64) }), async (args) => {
    const user = await authUser(args.token);
    if (!user) return { ok: false, message: "Please sign in." };
    const result = await applyReferral(user, args.code);
    if (!result.ok) return result;
    const fresh = await db.select().from(schema.users).where(eq(schema.users.id, user.id)).limit(1);
    return { ...result, user: await meDto(fresh[0]) };
  }),

  getRewards: withValidation(z.object({ token: tokenArg }), async (args) => {
    const user = await authUser(args.token);
    if (!user) return { ok: false, message: "Please sign in." };
    const allUsers = await db.select().from(schema.users);
    const counts = await referralCounts();
    const boardRow = (u) => ({ ...publicUserDto(u, counts.get(u.id) ?? 0), is_me: u.id === user.id });
    const byCoins = [...allUsers].sort((a, b) => b.coinBalance - a.coinBalance || (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0) || a.id - b.id);
    const byReferrals = [...allUsers].sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0) || b.coinBalance - a.coinBalance || a.id - b.id);
    const myRequests = await db.select().from(schema.coinRequests).where(eq(schema.coinRequests.userId, user.id)).orderBy(desc(schema.coinRequests.createdAt)).limit(20);
    const myWithdrawals = await db.select().from(schema.withdrawalRequests).where(eq(schema.withdrawalRequests.userId, user.id)).orderBy(desc(schema.withdrawalRequests.createdAt)).limit(20);
    return {
      ok: true,
      my_code: user.referralCode,
      has_claimed_referral: Boolean(user.referredBy),
      coin_balance: user.coinBalance,
      ...levelFor(user.coinBalance),
      referral_count: counts.get(user.id) ?? 0,
      packs: COIN_PACKS,
      jazzcash: JAZZCASH,
      my_requests: myRequests.map((r) => ({ id: r.id, pack_coins: r.packCoins, price_pkr: r.pricePkr, is_custom: Boolean(r.isCustom), tid: r.tid, status: r.status, created_at: r.createdAt.getTime() })),
      my_withdrawals: myWithdrawals.map(withdrawalDto),
      leaderboards: {
        // Top Coins is ANONYMOUS by owner decision: rows carry rank, id,
        // DP (avatar_url), balance and level only — display_name/username
        // are never sent, so coin-rich users can't be identified from the
        // payload. Top Referrals keeps full identities.
        top_coins: byCoins.slice(0, LEADERBOARD_LIMIT).map((u, i) => ({
          rank: i + 1,
          id: u.id,
          avatar_url: u.avatarUrl ?? null,
          coin_balance: u.coinBalance,
          ...levelFor(u.coinBalance),
          is_me: u.id === user.id,
        })),
        top_referrals: byReferrals.slice(0, LEADERBOARD_LIMIT).map((u, i) => ({ rank: i + 1, ...boardRow(u) })),
      },
    };
  }),

  requestCoins: withValidation(
    z.object({ token: tokenArg, pack_index: z.number().int().min(0).max(COIN_PACKS.length - 1), tid: z.string().trim().min(4).max(80) }),
    async (args) => {
      const user = await authUser(args.token);
      if (!user) return { ok: false, message: "Please sign in." };
      const pack = COIN_PACKS[args.pack_index];
      const existing = await db.select({ id: schema.coinRequests.id }).from(schema.coinRequests).where(eq(schema.coinRequests.tid, args.tid)).limit(1);
      if (existing.length > 0) return { ok: false, message: "This TID was already submitted. Each JazzCash transaction can only be used once." };
      try {
        const inserted = await db.insert(schema.coinRequests).values({ userId: user.id, packCoins: pack.coins, pricePkr: pack.pricePkr, tid: args.tid }).returning();
        if (!inserted[0]) return { ok: false, message: "Request could not be created." };
      } catch {
        return { ok: false, message: "This TID was already submitted. Each JazzCash transaction can only be used once." };
      }
      return { ok: true, message: `Request sent: ${pack.coins} coins for Rs.${pack.pricePkr}. The owner will verify your JazzCash payment and approve it.` };
    }
  ),

  // Custom coin buy: any amount >= CUSTOM_BUY_MIN_COINS at exactly
  // 1 coin = Rs.1. The price is derived here (price_pkr == coins) and never
  // taken from the client. The request lands in the same coin_requests
  // table (flagged is_custom) and goes through the same owner flow.
  requestCustomCoins: withValidation(
    z.object({ token: tokenArg, coins: z.number().int().min(1).max(1000000), tid: z.string().trim().min(4).max(80) }),
    async (args) => {
      const user = await authUser(args.token);
      if (!user) return { ok: false, message: "Please sign in." };
      if (args.coins < CUSTOM_BUY_MIN_COINS) return { ok: false, message: `Kam az kam ${CUSTOM_BUY_MIN_COINS} coins khareed sakte hain.` };
      const existing = await db.select({ id: schema.coinRequests.id }).from(schema.coinRequests).where(eq(schema.coinRequests.tid, args.tid)).limit(1);
      if (existing.length > 0) return { ok: false, message: "This TID was already submitted. Each JazzCash transaction can only be used once." };
      try {
        const inserted = await db
          .insert(schema.coinRequests)
          .values({ userId: user.id, packCoins: args.coins, pricePkr: args.coins, isCustom: 1, tid: args.tid })
          .returning();
        if (!inserted[0]) return { ok: false, message: "Request could not be created." };
      } catch {
        return { ok: false, message: "This TID was already submitted. Each JazzCash transaction can only be used once." };
      }
      return { ok: true, message: `Request sent: ${args.coins} coins for Rs.${args.coins}. The owner will verify your JazzCash payment and approve it.` };
    }
  ),

  // Withdrawal (cash-out) at 1 coin = Rs.1. HOLD MODEL: the coins are
  // deducted at submission with the same atomic balance-guarded UPDATE
  // sendGift uses, so held coins can never be gifted or withdrawn a second
  // time. On owner REJECT the hold is refunded (see reviewWithdrawal); on
  // APPROVE the coins stay deducted and the owner pays the user manually
  // via JazzCash outside the app — the app never sends money itself.
  requestWithdrawal: withValidation(
    z.object({
      token: tokenArg,
      coins: z.number().int().min(1).max(1000000),
      jazzcash_number: z.string().trim().min(10).max(15),
      account_title: z.string().trim().max(80).optional(),
    }),
    async (args) => {
      const user = await authUser(args.token);
      if (!user) return { ok: false, message: "Please sign in." };
      if (args.coins < WITHDRAW_MIN_COINS) return { ok: false, message: `Kam az kam ${WITHDRAW_MIN_COINS} coins withdraw kar sakte hain.` };
      if (!/^0\d{10}$/.test(args.jazzcash_number)) return { ok: false, message: "Sahi JazzCash number likhein (11 digits, 03 se shuru)." };
      const deducted = await db
        .update(schema.users)
        .set({ coinBalance: sql`${schema.users.coinBalance} - ${args.coins}` })
        .where(and(eq(schema.users.id, user.id), gte(schema.users.coinBalance, args.coins)))
        .returning({ coinBalance: schema.users.coinBalance });
      if (deducted.length === 0) {
        const fresh = (await db.select({ coinBalance: schema.users.coinBalance }).from(schema.users).where(eq(schema.users.id, user.id)).limit(1))[0];
        return { ok: false, message: `Not enough coins — withdrawal ke liye ${args.coins} chahiye aur tumhare paas ${fresh?.coinBalance ?? 0} hain.`, my_balance: fresh?.coinBalance ?? 0 };
      }
      try {
        const inserted = await db
          .insert(schema.withdrawalRequests)
          .values({ userId: user.id, coins: args.coins, amountPkr: args.coins, jazzcashNumber: args.jazzcash_number, accountTitle: args.account_title ?? "" })
          .returning();
        if (!inserted[0]) throw new Error("withdrawal insert returned no row");
        return {
          ok: true,
          message: `Withdrawal request bhej di: ${args.coins} coins (Rs.${args.coins}) hold par hain. Owner approve karega to JazzCash par paise milenge.`,
          my_balance: deducted[0].coinBalance,
          withdrawal: withdrawalDto(inserted[0]),
        };
      } catch (err) {
        // The row could not be recorded after the hold — refund the hold so
        // a failed request never costs the user coins.
        console.error("[api] requestWithdrawal insert failed, refunding hold:", err?.message || err);
        await db.update(schema.users).set({ coinBalance: sql`${schema.users.coinBalance} + ${args.coins}` }).where(eq(schema.users.id, user.id));
        return { ok: false, message: "Withdrawal could not be created. Your coins were not deducted — please try again." };
      }
    }
  ),

  // Creator-facing gift earnings: every gift received, who sent it, and
  // the creator's 70% share — plus all-time totals. Source: gift_events.
  getGiftEarnings: withValidation(z.object({ token: tokenArg }), async (args) => {
    const user = await authUser(args.token);
    if (!user) return { ok: false, message: "Please sign in." };
    const rows = await db.select().from(schema.giftEvents).where(eq(schema.giftEvents.creatorId, user.id)).orderBy(desc(schema.giftEvents.createdAt)).limit(50);
    const totals = await db
      .select({
        earned: sql`coalesce(sum(${schema.giftEvents.creatorShare}), 0)`.mapWith(Number),
        gross: sql`coalesce(sum(${schema.giftEvents.coins}), 0)`.mapWith(Number),
        count: sql`count(*)`.mapWith(Number),
      })
      .from(schema.giftEvents)
      .where(eq(schema.giftEvents.creatorId, user.id));
    const senderIds = [...new Set(rows.map((r) => r.senderId))];
    const senders = senderIds.length ? await db.select().from(schema.users).where(inArray(schema.users.id, senderIds)) : [];
    const senderMap = new Map(senders.map((s) => [s.id, s]));
    return {
      ok: true,
      total_earned: totals[0]?.earned ?? 0,
      total_gift_coins: totals[0]?.gross ?? 0,
      gift_count: totals[0]?.count ?? 0,
      earnings: rows.map((r) => {
        const gift = giftForKey(r.giftKey);
        return {
          id: r.id,
          gift_key: r.giftKey,
          gift_name: gift?.name ?? r.giftKey,
          gift_emoji: gift?.emoji ?? "🎁",
          coins: r.coins,
          creator_share: r.creatorShare,
          platform_share: r.platformShare,
          created_at: r.createdAt.getTime(),
          sender: senderMap.has(r.senderId) ? authorDto(senderMap.get(r.senderId)) : null,
        };
      }),
    };
  }),

  // ---- LIVE: broadcasts, gifts ---------------------------------------------
  // Sessions live in the DB (live_sessions); who is connected right now is
  // tracked by the WebSocket hub (live.mjs) — viewer counts come from there.

  // ICE diagnostics: clients report the FINAL outcome of a peer connection
  // (connected — and via which candidate type — or failed even through the
  // relay) so real-world connection problems are visible in the server log
  // instead of guesswork. Log-only; never stored, never shown to users.
  iceReport: withValidation(
    z.object({
      token: tokenArg,
      role: z.string().trim().max(24),
      kind: z.string().trim().max(24).optional(),
      state: z.string().trim().max(32),
      via: z.string().trim().max(16).optional(),
      relay: z.boolean().optional(),
    }),
    async (args) => {
      const user = await authUser(args.token);
      if (!user) return { ok: false, message: "Please sign in." };
      console.log(
        `[ice] @${user.username} role=${args.role} kind=${args.kind ?? "-"} state=${args.state} via=${args.via ?? "-"} relay=${args.relay ? "yes" : "no"}`
      );
      return { ok: true };
    }
  ),

  // The title is asked ONCE: whatever title a live is started with is
  // saved on the account, and later startLive calls may omit it entirely
  // to reuse the saved one. With neither, a default is used (and saved),
  // so going live never blocks on typing a title.
  startLive: withValidation(
    z.object({ token: tokenArg, title: z.string().trim().max(120).optional() }),
    async (args) => {
      const user = await authUser(args.token);
      if (!user) return { ok: false, message: "Please sign in." };
      const title = (args.title ?? "").trim() || user.liveTitle || `${user.displayName} is live 🔴`;
      if (findBannedContent(title)) return { ok: false, message: "Live title me aisi language ya link allowed nahi hai." };
      if (title !== user.liveTitle) {
        await db.update(schema.users).set({ liveTitle: title }).where(eq(schema.users.id, user.id));
      }
      // One live at a time per user: end any previous still-open session.
      const previous = await db
        .select({ id: schema.liveSessions.id })
        .from(schema.liveSessions)
        .where(and(eq(schema.liveSessions.userId, user.id), isNull(schema.liveSessions.endedAt)));
      for (const p of previous) await endLiveSession(p.id);
      const inserted = await db.insert(schema.liveSessions).values({ userId: user.id, title }).returning();
      const session = inserted[0];
      if (!session) return { ok: false, message: "Could not start the live. Please try again." };
      // Tell every follower the broadcaster went live (in-app only).
      try {
        const followerRows = await db.select({ followerId: schema.follows.followerId }).from(schema.follows).where(eq(schema.follows.followeeId, user.id));
        if (followerRows.length > 0) {
          await db.insert(schema.notifications).values(
            followerRows.map((f) => ({
              userId: f.followerId,
              type: "live",
              actorId: user.id,
              liveSessionId: session.id,
              text: `@${user.username} is live now 🔴 — “${title}”`,
            })),
          );
        }
      } catch (err) {
        console.error("[notify] live-started fanout failed:", err?.message || err);
      }
      return { ok: true, message: "You are live!", session: liveSessionDto(session, user), ice_servers: iceServers() };
    }
  ),

  endLive: withValidation(
    z.object({
      token: tokenArg,
      live_session_id: z.number().int().positive().optional(),
      liveSessionId: z.number().int().positive().optional(),
    }),
    async (args) => {
      const user = await authUser(args.token);
      if (!user) return { ok: false, message: "Please sign in." };
      const sessionId = args.live_session_id ?? args.liveSessionId;
      if (!sessionId) return { ok: false, message: "Invalid request." };
      const session = (await db.select().from(schema.liveSessions).where(eq(schema.liveSessions.id, sessionId)).limit(1))[0];
      if (!session) return { ok: false, message: "Live session not found." };
      if (session.userId !== user.id) return { ok: false, message: "Only the broadcaster can end this live." };
      await endLiveSession(session.id);
      const final = (await db.select().from(schema.liveSessions).where(eq(schema.liveSessions.id, session.id)).limit(1))[0] ?? session;
      return {
        ok: true,
        message: "Live ended.",
        summary: {
          live_session_id: final.id,
          duration_seconds: Math.max(0, Math.round(((final.endedAt?.getTime() ?? Date.now()) - final.startedAt.getTime()) / 1000)),
          peak_viewers: final.peakViewers,
          total_gift_coins: final.totalGiftCoins,
          creator_earned_coins: final.totalGiftCoins - final.platformCutCoins,
          platform_cut_coins: final.platformCutCoins,
        },
      };
    }
  ),

  listLive: withValidation(z.object({ token: tokenArg }), async (args) => {
    const user = await authUser(args.token);
    if (!user) return { ok: false, message: "Please sign in." };
    const rows = await db
      .select({ session: schema.liveSessions, broadcaster: schema.users })
      .from(schema.liveSessions)
      .innerJoin(schema.users, eq(schema.liveSessions.userId, schema.users.id))
      .where(isNull(schema.liveSessions.endedAt))
      .orderBy(desc(schema.liveSessions.startedAt))
      .limit(50);
    const blocked = await blockedIdsFor(user.id);
    const lives = [];
    for (const r of rows) {
      // A session whose broadcaster never connected (or vanished without a
      // clean disconnect) must not haunt the list forever: once it is a
      // couple of minutes old with no broadcaster socket, close it out.
      if (!hasBroadcaster(r.session.id) && Date.now() - r.session.startedAt.getTime() > 120_000) {
        await endLiveSession(r.session.id, { notify: false });
        continue;
      }
      // Hidden (under-review) lives show only to their broadcaster, and
      // blocked broadcasters never reach this viewer.
      if (r.session.hidden && r.session.userId !== user.id) continue;
      if (blocked.has(r.session.userId)) continue;
      lives.push(liveSessionDto(r.session, r.broadcaster));
    }
    return { ok: true, lives };
  }),

  getLive: withValidation(
    z.object({
      token: tokenArg,
      live_session_id: z.number().int().positive().optional(),
      liveSessionId: z.number().int().positive().optional(),
    }),
    async (args) => {
      const user = await authUser(args.token);
      if (!user) return { ok: false, message: "Please sign in." };
      const sessionId = args.live_session_id ?? args.liveSessionId;
      if (!sessionId) return { ok: false, message: "Invalid request." };
      const session = (await db.select().from(schema.liveSessions).where(eq(schema.liveSessions.id, sessionId)).limit(1))[0];
      if (!session) return { ok: false, message: "Live session not found." };
      if (session.hidden && session.userId !== user.id) return { ok: false, message: "Ye live moderation review me hai." };
      if (session.userId !== user.id && (await blockExistsBetween(user.id, session.userId))) return { ok: false, message: "Live not available." };
      const broadcaster = (await db.select().from(schema.users).where(eq(schema.users.id, session.userId)).limit(1))[0];
      const followRow =
        session.userId === user.id
          ? null
          : (await db.select({ id: schema.follows.id }).from(schema.follows).where(and(eq(schema.follows.followerId, user.id), eq(schema.follows.followeeId, session.userId))).limit(1))[0];
      return {
        ok: true,
        session: liveSessionDto(session, broadcaster),
        gifts: GIFT_CATALOG,
        ice_servers: iceServers(),
        my_coin_balance: user.coinBalance,
        is_mine: session.userId === user.id,
        broadcaster_followed: Boolean(followRow),
      };
    }
  ),

  sendGift: withValidation(
    z.object({
      token: tokenArg,
      live_session_id: z.number().int().positive().optional(),
      liveSessionId: z.number().int().positive().optional(),
      gift_key: z.string().trim().min(1).max(40).optional(),
      giftKey: z.string().trim().min(1).max(40).optional(),
    }),
    async (args) => {
      const user = await authUser(args.token);
      if (!user) return { ok: false, message: "Please sign in." };
      const sessionId = args.live_session_id ?? args.liveSessionId;
      const gift = giftForKey(args.gift_key ?? args.giftKey ?? "");
      if (!sessionId) return { ok: false, message: "Invalid request." };
      if (!gift) return { ok: false, message: "That gift is not available." };
      const session = (await db.select().from(schema.liveSessions).where(eq(schema.liveSessions.id, sessionId)).limit(1))[0];
      if (!session) return { ok: false, message: "Live session not found." };
      if (session.endedAt) return { ok: false, message: "This live has ended." };
      if (session.hidden) return { ok: false, message: "Ye live moderation review me hai." };
      if (await blockExistsBetween(user.id, session.userId)) return { ok: false, message: "You can't send gifts on this live." };
      if (session.userId === user.id) return { ok: false, message: "You cannot send a gift to your own live." };

      // Atomic, balance-guarded deduct: the WHERE clause makes the spend
      // fail cleanly instead of overdrawing if the balance moved since the
      // last read (double-tap, two tabs, ...).
      const deducted = await db
        .update(schema.users)
        .set({ coinBalance: sql`${schema.users.coinBalance} - ${gift.coins}` })
        .where(and(eq(schema.users.id, user.id), gte(schema.users.coinBalance, gift.coins)))
        .returning({ coinBalance: schema.users.coinBalance });
      if (deducted.length === 0) {
        const fresh = (await db.select({ coinBalance: schema.users.coinBalance }).from(schema.users).where(eq(schema.users.id, user.id)).limit(1))[0];
        return {
          ok: false,
          message: `Not enough coins — this gift costs ${gift.coins} coins and you have ${fresh?.coinBalance ?? 0}. Buy more coins from the Rewards tab.`,
          my_balance: fresh?.coinBalance ?? 0,
        };
      }
      const myBalance = deducted[0].coinBalance;
      const { creatorShare, platformShare } = giftSplit(gift.coins);
      try {
        await db.batch([
          db.update(schema.users).set({ coinBalance: sql`${schema.users.coinBalance} + ${creatorShare}` }).where(eq(schema.users.id, session.userId)),
          db.insert(schema.giftEvents).values({
            liveSessionId: session.id,
            senderId: user.id,
            creatorId: session.userId,
            giftKey: gift.key,
            coins: gift.coins,
            creatorShare,
            platformShare,
          }),
          db
            .update(schema.liveSessions)
            .set({
              totalGiftCoins: sql`${schema.liveSessions.totalGiftCoins} + ${gift.coins}`,
              platformCutCoins: sql`${schema.liveSessions.platformCutCoins} + ${platformShare}`,
            })
            .where(eq(schema.liveSessions.id, session.id)),
        ]);
      } catch (err) {
        // The credit side failed after the deduct — refund the sender so a
        // failed gift never costs anyone coins.
        console.error("[api] sendGift credit failed, refunding sender:", err?.message || err);
        await db.update(schema.users).set({ coinBalance: sql`${schema.users.coinBalance} + ${gift.coins}` }).where(eq(schema.users.id, user.id));
        return { ok: false, message: "The gift could not be sent. Your coins were not deducted — please try again." };
      }

      const giftPayload = {
        key: gift.key,
        name: gift.name,
        emoji: gift.emoji,
        coins: gift.coins,
        creator_share: creatorShare,
        platform_share: platformShare,
      };
      broadcastGift(session.id, { from: authorDto(user), gift: giftPayload, created_at: Date.now() });
      await notify({
        userId: session.userId,
        type: "gift",
        actorId: user.id,
        liveSessionId: session.id,
        coins: creatorShare,
        text: `@${user.username} sent you ${gift.emoji} ${gift.name} — you received ${creatorShare} coins 🎁`,
      });
      // If this live is in a PK match, the gift's full value scores for
      // the broadcaster's side (balances above used the 70/30 split).
      noteGiftForMatch(session.id, gift.coins);
      return {
        ok: true,
        message: `You sent ${gift.emoji} ${gift.name} (${gift.coins} coins)!`,
        gift: giftPayload,
        creator_share: creatorShare,
        platform_share: platformShare,
        my_balance: myBalance,
      };
    }
  ),

  // ---- Admin ----------------------------------------------------------------

  getAdminCoinRequests: withValidation(z.object({ token: tokenArg }), async (args) => {
    const user = await authUser(args.token);
    if (!user) return { ok: false, message: "Please sign in." };
    if (!isAdminUser(user)) return { ok: false, message: "Owner access required." };
    const rows = await db
      .select({ request: schema.coinRequests, buyer: schema.users })
      .from(schema.coinRequests)
      .innerJoin(schema.users, eq(schema.coinRequests.userId, schema.users.id))
      .orderBy(sql`case when ${schema.coinRequests.status} = 'pending' then 0 else 1 end`, desc(schema.coinRequests.createdAt))
      .limit(100);
    // Total platform cut from LIVE gifts (recorded in gift_events; the
    // coins themselves are credited nowhere — this is the owner's tally).
    const giftTotals = await db
      .select({ total: sql`coalesce(sum(${schema.giftEvents.platformShare}), 0)`.mapWith(Number) })
      .from(schema.giftEvents);
    // Withdrawal requests (coins already held at submission). Approving
    // only marks the payout the owner then sends manually via JazzCash;
    // rejecting refunds the held coins (see reviewWithdrawal).
    const wdRows = await db
      .select({ withdrawal: schema.withdrawalRequests, requester: schema.users })
      .from(schema.withdrawalRequests)
      .innerJoin(schema.users, eq(schema.withdrawalRequests.userId, schema.users.id))
      .orderBy(sql`case when ${schema.withdrawalRequests.status} = 'pending' then 0 else 1 end`, desc(schema.withdrawalRequests.createdAt))
      .limit(100);
    // Recent platform gift earnings (the 30% side of every gift).
    const giftEventRows = await db.select().from(schema.giftEvents).orderBy(desc(schema.giftEvents.createdAt)).limit(50);
    const giftUserIds = [...new Set(giftEventRows.flatMap((r) => [r.senderId, r.creatorId]))];
    const giftUsers = giftUserIds.length ? await db.select().from(schema.users).where(inArray(schema.users.id, giftUserIds)) : [];
    const giftUserMap = new Map(giftUsers.map((u) => [u.id, u]));
    return {
      ok: true,
      platform_gift_coins: giftTotals[0]?.total ?? 0,
      requests: rows.map((r) => ({
        id: r.request.id,
        pack_coins: r.request.packCoins,
        price_pkr: r.request.pricePkr,
        is_custom: Boolean(r.request.isCustom),
        tid: r.request.tid,
        status: r.request.status,
        created_at: r.request.createdAt.getTime(),
        buyer: authorDto(r.buyer),
      })),
      withdrawals: wdRows.map((r) => ({ ...withdrawalDto(r.withdrawal), requester: authorDto(r.requester) })),
      platform_gift_events: giftEventRows.map((r) => {
        const gift = giftForKey(r.giftKey);
        return {
          id: r.id,
          gift_key: r.giftKey,
          gift_name: gift?.name ?? r.giftKey,
          gift_emoji: gift?.emoji ?? "🎁",
          coins: r.coins,
          creator_share: r.creatorShare,
          platform_share: r.platformShare,
          created_at: r.createdAt.getTime(),
          sender: giftUserMap.has(r.senderId) ? authorDto(giftUserMap.get(r.senderId)) : null,
          creator: giftUserMap.has(r.creatorId) ? authorDto(giftUserMap.get(r.creatorId)) : null,
        };
      }),
    };
  }),

  reviewCoinRequest: withValidation(
    z.object({ token: tokenArg, request_id: z.number().int().positive(), decision: z.enum(["approved", "rejected"]) }),
    async (args) => {
      const admin = await authUser(args.token);
      if (!admin) return { ok: false, message: "Please sign in." };
      if (!isAdminUser(admin)) return { ok: false, message: "Owner access required." };
      const request = (await db.select().from(schema.coinRequests).where(eq(schema.coinRequests.id, args.request_id)).limit(1))[0];
      if (!request) return { ok: false, message: "Request not found." };
      if (request.status !== "pending") return { ok: false, message: `This request was already ${request.status}.` };
      const statements = [
        db.update(schema.coinRequests).set({ status: args.decision, reviewedBy: admin.id, reviewedAt: new Date() }).where(eq(schema.coinRequests.id, request.id)),
      ];
      if (args.decision === "approved") {
        statements.push(db.update(schema.users).set({ coinBalance: sql`${schema.users.coinBalance} + ${request.packCoins}` }).where(eq(schema.users.id, request.userId)));
      }
      await db.batch(statements);
      await notify({
        userId: request.userId,
        type: "coin_request",
        text:
          args.decision === "approved"
            ? `Your coin request was approved — ${request.packCoins} coins added to your balance 🪙`
            : "Your coin request was rejected by the owner. Koi masla ho to owner se rabta karein.",
      });
      return { ok: true, message: args.decision === "approved" ? `Approved — ${request.packCoins} coins credited.` : "Request rejected." };
    }
  ),

  // Owner decision on a withdrawal. The coins were already held at
  // submission: APPROVE leaves them deducted (the owner pays the user via
  // JazzCash manually); REJECT refunds the held coins in the same batch,
  // so a rejected withdrawal never costs the user anything and the house
  // can never pay out twice for the same coins.
  reviewWithdrawal: withValidation(
    z.object({ token: tokenArg, withdrawal_id: z.number().int().positive(), decision: z.enum(["approved", "rejected"]) }),
    async (args) => {
      const admin = await authUser(args.token);
      if (!admin) return { ok: false, message: "Please sign in." };
      if (!isAdminUser(admin)) return { ok: false, message: "Owner access required." };
      const wd = (await db.select().from(schema.withdrawalRequests).where(eq(schema.withdrawalRequests.id, args.withdrawal_id)).limit(1))[0];
      if (!wd) return { ok: false, message: "Withdrawal not found." };
      if (wd.status !== "pending") return { ok: false, message: `This withdrawal was already ${wd.status}.` };
      const statements = [
        db.update(schema.withdrawalRequests).set({ status: args.decision, reviewedBy: admin.id, decidedAt: new Date() }).where(eq(schema.withdrawalRequests.id, wd.id)),
      ];
      if (args.decision === "rejected") {
        statements.push(db.update(schema.users).set({ coinBalance: sql`${schema.users.coinBalance} + ${wd.coins}` }).where(eq(schema.users.id, wd.userId)));
      }
      await db.batch(statements);
      await notify({
        userId: wd.userId,
        type: "withdrawal",
        coins: wd.coins,
        text:
          args.decision === "approved"
            ? `Your withdrawal of ${wd.coins} coins (Rs.${wd.amountPkr}) was approved — paise tumhare JazzCash ${wd.jazzcashNumber} par bheje jayenge 💸`
            : `Your withdrawal of ${wd.coins} coins was rejected — held coins wapas tumhare balance me aa gaye hain.`,
      });
      return {
        ok: true,
        message:
          args.decision === "approved"
            ? `Approved — ab Rs.${wd.amountPkr} JazzCash ${wd.jazzcashNumber} par bhej dein.`
            : "Withdrawal rejected — held coins wapas balance me daal diye.",
      };
    }
  ),

  // ---- Moderation: reports, blocks, owner queue ------------------------------
  // Auto-catch layers: (1) text filter (config.findBannedContent),
  // (2) reports — REPORT_AUTOHIDE_THRESHOLD distinct reporters auto-hide a
  // post/live, (3) this owner queue for restore/delete/ban decisions.

  reportContent: withValidation(
    z.object({
      token: tokenArg,
      target_type: z.enum(["post", "live", "comment", "user"]),
      target_id: z.number().int().positive(),
      reason: z.enum(["spam", "abuse", "nudity", "violence", "other"]),
      details: z.string().trim().max(500).optional(),
    }),
    async (args) => {
      const user = await authUser(args.token);
      if (!user) return { ok: false, message: "Please sign in." };
      const target = await resolveReportTarget(args.target_type, args.target_id);
      if (!target) return { ok: false, message: "Content not found." };
      if (target.ownerId === user.id) return { ok: false, message: "You can't report your own content." };
      // One report per user per target: a re-report updates the same row.
      const existing = (
        await db
          .select()
          .from(schema.reports)
          .where(and(eq(schema.reports.reporterId, user.id), eq(schema.reports.targetType, args.target_type), eq(schema.reports.targetId, args.target_id)))
          .limit(1)
      )[0];
      if (existing) {
        await db
          .update(schema.reports)
          .set({ reason: args.reason, details: args.details ?? "", status: "pending", actionTaken: null, actionBy: null, actionAt: null })
          .where(eq(schema.reports.id, existing.id));
      } else {
        await db.insert(schema.reports).values({
          reporterId: user.id,
          targetType: args.target_type,
          targetId: args.target_id,
          targetOwnerId: target.ownerId,
          reason: args.reason,
          details: args.details ?? "",
        });
      }
      const autoHidden = await maybeAutoHide(args.target_type, args.target_id, target.ownerId);
      return {
        ok: true,
        message: autoHidden
          ? "Report bhej di — ye content zyada reports ki wajah se ab review tak chhupa diya gaya hai."
          : "Report bhej di — shukriya. Owner isay review karega.",
        auto_hidden: autoHidden,
      };
    }
  ),

  blockUser: withValidation(z.object({ token: tokenArg, user_id: z.number().int().positive() }), async (args) => {
    const user = await authUser(args.token);
    if (!user) return { ok: false, message: "Please sign in." };
    if (args.user_id === user.id) return { ok: false, message: "You can't block yourself." };
    const target = (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, args.user_id)).limit(1))[0];
    if (!target) return { ok: false, message: "User not found." };
    const existing = (
      await db
        .select({ id: schema.blocks.id })
        .from(schema.blocks)
        .where(and(eq(schema.blocks.userId, user.id), eq(schema.blocks.blockedId, args.user_id)))
        .limit(1)
    )[0];
    if (!existing) {
      await db.insert(schema.blocks).values({ userId: user.id, blockedId: args.user_id });
    }
    // Blocking removes the follows between the two users, both ways.
    await db.batch([
      db.delete(schema.follows).where(and(eq(schema.follows.followerId, user.id), eq(schema.follows.followeeId, args.user_id))),
      db.delete(schema.follows).where(and(eq(schema.follows.followerId, args.user_id), eq(schema.follows.followeeId, user.id))),
    ]);
    return { ok: true, message: "User blocked. Unki videos, comments aur live ab tumhe nahi dikhengi." };
  }),

  unblockUser: withValidation(z.object({ token: tokenArg, user_id: z.number().int().positive() }), async (args) => {
    const user = await authUser(args.token);
    if (!user) return { ok: false, message: "Please sign in." };
    await db.delete(schema.blocks).where(and(eq(schema.blocks.userId, user.id), eq(schema.blocks.blockedId, args.user_id)));
    return { ok: true, message: "User unblocked." };
  }),

  // ---- Password help --------------------------------------------------------------
  // Self-serve: a signed-in user changes their password with the current
  // one. (There is no email-based reset: password accounts have no
  // verified email, so recovery is the owner-assisted reset below.)
  changePassword: withValidation(
    z.object({ token: tokenArg, current_password: z.string().min(1).max(200), new_password: z.string().min(6).max(200) }),
    async (args) => {
      const user = await authUser(args.token);
      if (!user) return { ok: false, message: "Please sign in." };
      if (!user.passwordHash || !(await verifyPassword(args.current_password, user.passwordHash))) {
        return { ok: false, message: "Current password galat hai." };
      }
      if (args.new_password === args.current_password) return { ok: false, message: "New password purane se alag rakho." };
      await db.update(schema.users).set({ passwordHash: await hashPassword(args.new_password) }).where(eq(schema.users.id, user.id));
      return { ok: true, message: "Password change ho gaya ✓ Ab is new password se login hoga." };
    }
  ),

  // Owner-assisted reset: the admin sets a temporary password for a user
  // (their sessions are killed so a lost account is secured too). The
  // user logs in with it and changes it via changePassword.
  adminResetPassword: withValidation(
    z.object({ token: tokenArg, user_id: z.number().int().positive(), temp_password: z.string().min(6).max(200) }),
    async (args) => {
      const admin = await authUser(args.token);
      if (!admin || !isAdminUser(admin)) return { ok: false, message: "Admin only." };
      const target = (await db.select().from(schema.users).where(eq(schema.users.id, args.user_id)).limit(1))[0];
      if (!target) return { ok: false, message: "User not found." };
      await db.update(schema.users).set({ passwordHash: await hashPassword(args.temp_password) }).where(eq(schema.users.id, target.id));
      await db.delete(schema.sessions).where(eq(schema.sessions.userId, target.id));
      return {
        ok: true,
        message: `@${target.username} (ID #${target.id}) ka password reset ho gaya. Ye temporary password user ko do — woh login karke Profile se apna password change kar sakta hai.`,
      };
    }
  ),

  getBlockedUsers: withValidation(z.object({ token: tokenArg }), async (args) => {
    const user = await authUser(args.token);
    if (!user) return { ok: false, message: "Please sign in." };
    const rows = await db
      .select({ blocked: schema.users })
      .from(schema.blocks)
      .innerJoin(schema.users, eq(schema.blocks.blockedId, schema.users.id))
      .where(eq(schema.blocks.userId, user.id))
      .orderBy(desc(schema.blocks.createdAt));
    return { ok: true, blocked: rows.map((r) => authorDto(r.blocked)) };
  }),

  // ---- Notifications (in-app inbox) ------------------------------------------
  getNotifications: withValidation(z.object({ token: tokenArg }), async (args) => {
    const user = await authUser(args.token);
    if (!user) return { ok: false, message: "Please sign in." };
    const rows = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, user.id))
      .orderBy(desc(schema.notifications.createdAt))
      .limit(50);
    const actorIds = [...new Set(rows.map((r) => r.actorId).filter(Boolean))];
    const actors = actorIds.length ? await db.select().from(schema.users).where(inArray(schema.users.id, actorIds)) : [];
    const actorMap = new Map(actors.map((a) => [a.id, a]));
    const unreadRows = await db
      .select({ count: sql`count(*)`.mapWith(Number) })
      .from(schema.notifications)
      .where(and(eq(schema.notifications.userId, user.id), eq(schema.notifications.read, 0)));
    return {
      ok: true,
      unread_count: unreadRows[0]?.count ?? 0,
      notifications: rows.map((r) => ({
        id: r.id,
        type: r.type,
        text: r.text,
        coins: r.coins ?? null,
        post_id: r.postId ?? null,
        live_session_id: r.liveSessionId ?? null,
        read: Boolean(r.read),
        created_at: r.createdAt.getTime(),
        actor: r.actorId && actorMap.has(r.actorId) ? authorDto(actorMap.get(r.actorId)) : null,
      })),
    };
  }),

  markNotificationsRead: withValidation(z.object({ token: tokenArg }), async (args) => {
    const user = await authUser(args.token);
    if (!user) return { ok: false, message: "Please sign in." };
    await db.update(schema.notifications).set({ read: 1 }).where(and(eq(schema.notifications.userId, user.id), eq(schema.notifications.read, 0)));
    return { ok: true, message: "All notifications marked as read.", unread_count: 0 };
  }),

  // ---- Stories (24h) ------------------------------------------------------------
  createStory: withValidation(
    z.object({
      token: tokenArg,
      media_url: z.string().url().max(2000),
      media_public_id: z.string().max(300).optional(),
      media_type: z.enum(["image", "video"]).default("image"),
    }),
    async (args) => {
      const user = await authUser(args.token);
      if (!user) return { ok: false, message: "Please sign in." };
      const inserted = await db
        .insert(schema.stories)
        .values({ userId: user.id, mediaUrl: args.media_url, mediaPublicId: args.media_public_id ?? null, mediaType: args.media_type })
        .returning();
      const story = inserted[0];
      if (!story) return { ok: false, message: "Story could not be posted." };
      return { ok: true, message: "Story posted — 24 ghante rahegi.", story: storyDto(story, 0, true) };
    }
  ),

  // Story strip for the feed: my own + my followees' active stories,
  // grouped by author (mine first, then unseen, then most recent).
  getStories: withValidation(z.object({ token: tokenArg }), async (args) => {
    const user = await authUser(args.token);
    if (!user) return { ok: false, message: "Please sign in." };
    // Cleanup on read: expired stories (and their views, via FK cascade
    // at the app level) are deleted opportunistically.
    const cutoff = new Date(Date.now() - STORY_TTL_MS);
    await db.delete(schema.storyViews).where(
      inArray(
        schema.storyViews.storyId,
        db.select({ id: schema.stories.id }).from(schema.stories).where(lt(schema.stories.createdAt, cutoff)),
      ),
    );
    await db.delete(schema.stories).where(lt(schema.stories.createdAt, cutoff));
    const followees = await db.select({ id: schema.follows.followeeId }).from(schema.follows).where(eq(schema.follows.followerId, user.id));
    const authorIds = [user.id, ...followees.map((f) => f.id)];
    const authors = await db.select().from(schema.users).where(inArray(schema.users.id, authorIds));
    const authorMap = new Map(authors.map((a) => [a.id, a]));
    const groups = [];
    for (const authorId of authorIds) {
      const stories = await storyDtosFor(authorId, user.id);
      if (stories.length === 0) continue;
      groups.push({
        author: authorMap.has(authorId) ? authorDto(authorMap.get(authorId)) : null,
        stories,
        has_unseen: stories.some((s) => !s.seen_by_me),
        latest_at: stories[stories.length - 1].created_at,
      });
    }
    groups.sort((a, b) => {
      const aMine = a.author?.id === user.id ? 0 : 1;
      const bMine = b.author?.id === user.id ? 0 : 1;
      if (aMine !== bMine) return aMine - bMine;
      if (a.has_unseen !== b.has_unseen) return a.has_unseen ? -1 : 1;
      return b.latest_at - a.latest_at;
    });
    return { ok: true, groups };
  }),

  viewStory: withValidation(z.object({ token: tokenArg, story_id: z.number().int().positive() }), async (args) => {
    const user = await authUser(args.token);
    if (!user) return { ok: false, message: "Please sign in." };
    const story = (await db.select().from(schema.stories).where(eq(schema.stories.id, args.story_id)).limit(1))[0];
    if (!story || Date.now() - story.createdAt.getTime() > STORY_TTL_MS) return { ok: false, message: "Story expired or not found." };
    if (!(await canViewStories(user.id, story.userId))) return { ok: false, message: "Story not available." };
    if (story.userId !== user.id) {
      try {
        await db.insert(schema.storyViews).values({ storyId: story.id, viewerId: user.id });
      } catch {
        /* already viewed */
      }
    }
    const countRows = await db.select({ count: sql`count(*)`.mapWith(Number) }).from(schema.storyViews).where(eq(schema.storyViews.storyId, story.id));
    return { ok: true, view_count: countRows[0]?.count ?? 0 };
  }),

  getStoryViewers: withValidation(z.object({ token: tokenArg, story_id: z.number().int().positive() }), async (args) => {
    const user = await authUser(args.token);
    if (!user) return { ok: false, message: "Please sign in." };
    const story = (await db.select().from(schema.stories).where(eq(schema.stories.id, args.story_id)).limit(1))[0];
    if (!story) return { ok: false, message: "Story not found." };
    if (story.userId !== user.id) return { ok: false, message: "Sirf story ka owner viewers dekh sakta hai." };
    const rows = await db
      .select({ view: schema.storyViews, viewer: schema.users })
      .from(schema.storyViews)
      .innerJoin(schema.users, eq(schema.storyViews.viewerId, schema.users.id))
      .where(eq(schema.storyViews.storyId, story.id))
      .orderBy(desc(schema.storyViews.createdAt));
    return { ok: true, viewers: rows.map((r) => ({ viewer: authorDto(r.viewer), viewed_at: r.view.createdAt.getTime() })) };
  }),

  deleteStory: withValidation(z.object({ token: tokenArg, story_id: z.number().int().positive() }), async (args) => {
    const user = await authUser(args.token);
    if (!user) return { ok: false, message: "Please sign in." };
    const story = (await db.select().from(schema.stories).where(eq(schema.stories.id, args.story_id)).limit(1))[0];
    if (!story) return { ok: false, message: "Story not found." };
    if (story.userId !== user.id) return { ok: false, message: "You can only delete your own stories." };
    await db.delete(schema.storyViews).where(eq(schema.storyViews.storyId, story.id));
    await db.delete(schema.stories).where(eq(schema.stories.id, story.id));
    if (story.mediaPublicId) await destroyFromCloudinary(story.mediaPublicId, story.mediaType === "video" ? "video" : "image");
    return { ok: true, message: "Story deleted." };
  }),

  // ---- Direct messages (1-to-1, polled delivery) --------------------------------
  sendMessage: withValidation(
    z.object({ token: tokenArg, user_id: z.number().int().positive(), body: z.string().trim().min(1).max(1000) }),
    async (args) => {
      const user = await authUser(args.token);
      if (!user) return { ok: false, message: "Please sign in." };
      if (args.user_id === user.id) return { ok: false, message: "You can't message yourself." };
      const target = (await db.select().from(schema.users).where(eq(schema.users.id, args.user_id)).limit(1))[0];
      if (!target) return { ok: false, message: "User not found." };
      if (await blockExistsBetween(user.id, target.id)) return { ok: false, message: "Messaging is not available with this user." };
      if (findBannedContent(args.body)) return { ok: false, message: "Message me aisi language ya link allowed nahi hai — message nahi bheja gaya." };
      const inserted = await db.insert(schema.messages).values({ senderId: user.id, recipientId: target.id, body: args.body }).returning();
      const msg = inserted[0];
      if (!msg) return { ok: false, message: "Message could not be sent." };
      await notify({ userId: target.id, type: "dm", actorId: user.id, text: `@${user.username} sent you a message ✉️` });
      return {
        ok: true,
        message: "Message sent.",
        chat_message: { id: msg.id, body: msg.body, created_at: msg.createdAt.getTime(), is_mine: true, read: false },
      };
    }
  ),

  // Conversation list: latest message + unread count per counterpart.
  getConversations: withValidation(z.object({ token: tokenArg }), async (args) => {
    const user = await authUser(args.token);
    if (!user) return { ok: false, message: "Please sign in." };
    const rows = await db
      .select()
      .from(schema.messages)
      .where(or(eq(schema.messages.senderId, user.id), eq(schema.messages.recipientId, user.id)))
      .orderBy(desc(schema.messages.createdAt))
      .limit(500);
    const byPeer = new Map();
    for (const m of rows) {
      const peerId = m.senderId === user.id ? m.recipientId : m.senderId;
      if (!byPeer.has(peerId)) byPeer.set(peerId, { peerId, latest: m, unread: 0 });
      const entry = byPeer.get(peerId);
      if (m.recipientId === user.id && !m.readAt) entry.unread += 1;
    }
    const peerIds = [...byPeer.keys()];
    const peers = peerIds.length ? await db.select().from(schema.users).where(inArray(schema.users.id, peerIds)) : [];
    const peerMap = new Map(peers.map((p) => [p.id, p]));
    const conversations = [...byPeer.values()]
      .filter((e) => peerMap.has(e.peerId))
      .map((e) => ({
        user: authorDto(peerMap.get(e.peerId)),
        latest: { body: e.latest.body, created_at: e.latest.createdAt.getTime(), is_mine: e.latest.senderId === user.id },
        unread: e.unread,
      }))
      .sort((a, b) => b.latest.created_at - a.latest.created_at);
    return { ok: true, conversations };
  }),

  // One thread: the latest 100 messages between the two users, oldest
  // first. Fetching a thread marks the peer's messages as read.
  getMessages: withValidation(z.object({ token: tokenArg, user_id: z.number().int().positive() }), async (args) => {
    const user = await authUser(args.token);
    if (!user) return { ok: false, message: "Please sign in." };
    const peer = (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, args.user_id)).limit(1))[0];
    if (!peer) return { ok: false, message: "User not found." };
    await db
      .update(schema.messages)
      .set({ readAt: new Date() })
      .where(and(eq(schema.messages.recipientId, user.id), eq(schema.messages.senderId, args.user_id), isNull(schema.messages.readAt)));
    const rows = await db
      .select()
      .from(schema.messages)
      .where(
        or(
          and(eq(schema.messages.senderId, user.id), eq(schema.messages.recipientId, args.user_id)),
          and(eq(schema.messages.senderId, args.user_id), eq(schema.messages.recipientId, user.id)),
        ),
      )
      .orderBy(desc(schema.messages.createdAt))
      .limit(100);
    const thread = rows.reverse().map((m) => ({
      id: m.id,
      body: m.body,
      created_at: m.createdAt.getTime(),
      is_mine: m.senderId === user.id,
      read: Boolean(m.readAt) || m.recipientId === user.id, // freshly marked above for incoming
    }));
    return { ok: true, messages: thread };
  }),

  // Owner moderation queue: reports grouped by target, with the reported
  // content preview, distinct-reporter counts and repeat-offender flags.
  getModerationQueue: withValidation(z.object({ token: tokenArg }), async (args) => {
    const admin = await authUser(args.token);
    if (!admin) return { ok: false, message: "Please sign in." };
    if (!isAdminUser(admin)) return { ok: false, message: "Owner access required." };
    const reportRows = await db.select().from(schema.reports).orderBy(desc(schema.reports.createdAt)).limit(300);
    const userIds = [...new Set(reportRows.flatMap((r) => [r.reporterId, r.targetOwnerId]))];
    const userRows = userIds.length ? await db.select().from(schema.users).where(inArray(schema.users.id, userIds)) : [];
    const userMap = new Map(userRows.map((u) => [u.id, u]));
    const groups = new Map();
    for (const report of reportRows) {
      const reporter = userMap.get(report.reporterId);
      const owner = userMap.get(report.targetOwnerId);
      if (!reporter || !owner) continue;
      const r = { report, reporter, owner };
      const key = `${r.report.targetType}:${r.report.targetId}`;
      if (!groups.has(key)) {
        groups.set(key, {
          target_type: r.report.targetType,
          target_id: r.report.targetId,
          owner: { ...authorDto(r.owner), banned: Boolean(r.owner.banned), hidden_count: r.owner.hiddenCount, flagged: r.owner.hiddenCount >= 2 },
          reporter_ids: new Set(),
          reports: [],
          has_pending: false,
          latest_at: 0,
          preview: null,
        });
      }
      const g = groups.get(key);
      g.reporter_ids.add(r.report.reporterId);
      if (r.report.status === "pending") g.has_pending = true;
      g.latest_at = Math.max(g.latest_at, r.report.createdAt.getTime());
      g.reports.push({
        id: r.report.id,
        reason: r.report.reason,
        details: r.report.details,
        status: r.report.status,
        action_taken: r.report.actionTaken,
        created_at: r.report.createdAt.getTime(),
        reporter: authorDto(r.reporter),
      });
    }
    // Attach a content preview per group.
    for (const g of groups.values()) {
      const t = await resolveReportTarget(g.target_type, g.target_id);
      if (!t) {
        g.preview = { missing: true };
      } else if (g.target_type === "post") {
        g.preview = { title: t.post.title, hidden: Boolean(t.post.hidden), video_url: t.post.videoUrl, thumbnail_url: t.post.thumbnailUrl ?? null };
      } else if (g.target_type === "comment") {
        g.preview = { body: t.comment.body, post_id: t.comment.postId };
      } else if (g.target_type === "live") {
        g.preview = { title: t.session.title, hidden: Boolean(t.session.hidden), is_live: !t.session.endedAt };
      } else {
        g.preview = { bio: t.targetUser.bio ?? "" };
      }
      g.report_count = g.reporter_ids.size;
      delete g.reporter_ids;
    }
    const list = [...groups.values()].sort((a, b) => Number(b.has_pending) - Number(a.has_pending) || b.latest_at - a.latest_at);
    return { ok: true, groups: list };
  }),

  // Owner decision on a whole report group. Every decided report row is
  // stamped with the action (the moderation log).
  moderateContent: withValidation(
    z.object({
      token: tokenArg,
      target_type: z.enum(["post", "live", "comment", "user"]),
      target_id: z.number().int().positive(),
      action: z.enum(["dismiss", "delete_content", "ban_user", "unban_user"]),
    }),
    async (args) => {
      const admin = await authUser(args.token);
      if (!admin) return { ok: false, message: "Please sign in." };
      if (!isAdminUser(admin)) return { ok: false, message: "Owner access required." };
      const target = await resolveReportTarget(args.target_type, args.target_id);
      if (!target && args.action !== "dismiss") return { ok: false, message: "Content not found." };
      const ownerId = target?.ownerId;
      const stamp = { actionTaken: args.action, actionBy: admin.id, actionAt: new Date() };
      const markReports = (status) =>
        db
          .update(schema.reports)
          .set({ status, ...stamp })
          .where(and(eq(schema.reports.targetType, args.target_type), eq(schema.reports.targetId, args.target_id), eq(schema.reports.status, "pending")));

      if (args.action === "dismiss") {
        // Restore the content if it was auto-hidden, close the reports.
        if (target?.post) await db.update(schema.posts).set({ hidden: 0 }).where(eq(schema.posts.id, target.post.id));
        if (target?.session) await db.update(schema.liveSessions).set({ hidden: 0 }).where(eq(schema.liveSessions.id, target.session.id));
        await markReports("dismissed");
        return { ok: true, message: "Reports dismissed — content (agar chhupa tha) wapas visible hai." };
      }
      if (args.action === "delete_content") {
        if (args.target_type === "user") return { ok: false, message: "User ko delete nahi — ban karein." };
        if (target.post) {
          await db.delete(schema.posts).where(eq(schema.posts.id, target.post.id));
          if (target.post.videoPublicId) await destroyFromCloudinary(target.post.videoPublicId, "video");
        } else if (target.comment) {
          await db.delete(schema.comments).where(eq(schema.comments.id, target.comment.id));
        } else if (target.session) {
          await endLiveSession(target.session.id);
          await db.update(schema.liveSessions).set({ hidden: 1 }).where(eq(schema.liveSessions.id, target.session.id));
        }
        await markReports("actioned");
        return { ok: true, message: "Content deleted/ended." };
      }
      if (args.action === "ban_user") {
        const owner = target.targetUser ?? (ownerId ? (await db.select().from(schema.users).where(eq(schema.users.id, ownerId)).limit(1))[0] : null);
        if (!owner) return { ok: false, message: "User not found." };
        if (isAdminUser(owner)) return { ok: false, message: "Owner account ko ban nahi kiya ja sakta." };
        await db.update(schema.users).set({ banned: 1, banReason: `Moderation: reported ${args.target_type} #${args.target_id}` }).where(eq(schema.users.id, owner.id));
        // Kill their sessions (auth stops working at once) and end any
        // live they currently have running.
        await db.delete(schema.sessions).where(eq(schema.sessions.userId, owner.id));
        const open = await db.select({ id: schema.liveSessions.id }).from(schema.liveSessions).where(and(eq(schema.liveSessions.userId, owner.id), isNull(schema.liveSessions.endedAt)));
        for (const s of open) await endLiveSession(s.id);
        await markReports("actioned");
        return { ok: true, message: `@${owner.username} ban ho gaya — login/post/live sab band.` };
      }
      // unban_user
      const owner = target?.targetUser ?? (ownerId ? (await db.select().from(schema.users).where(eq(schema.users.id, ownerId)).limit(1))[0] : null);
      if (!owner) return { ok: false, message: "User not found." };
      await db.update(schema.users).set({ banned: 0, banReason: null }).where(eq(schema.users.id, owner.id));
      await markReports("actioned");
      return { ok: true, message: `@${owner.username} unban ho gaya.` };
    }
  ),
};
