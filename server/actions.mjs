// Business logic for Zoomly. Every action is an async function
// `(args) => responseObject`, exposed by index.mjs as POST /api/<name>.
// Mirrors the SMM panel's conventions: zod validation, PBKDF2 password
// hashes, SHA-256-hashed session tokens stored in the DB.
import { z } from "zod";
import { and, desc, eq, gte, inArray, isNull, like, or, sql } from "drizzle-orm";
import { db } from "./db.mjs";
import * as schema from "./schema.mjs";
import {
  COIN_PACKS,
  CUSTOM_BUY_MIN_COINS,
  WITHDRAW_MIN_COINS,
  GIFT_CATALOG,
  ICE_SERVERS,
  JAZZCASH,
  LEADERBOARD_LIMIT,
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
  return row.user;
}

// ---- DTOs -----------------------------------------------------------------

function authorDto(user) {
  return {
    id: user.id,
    username: user.username,
    display_name: user.displayName,
    avatar_url: user.avatarUrl ?? null,
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
  return {
    ...publicUserDto(user, counts.get(user.id) ?? 0),
    referral_code: user.referralCode,
    referred_by: user.referredBy ?? null,
    live_title: user.liveTitle ?? null,
    follower_count: fc.followers,
    following_count: fc.following,
    is_admin: isAdminUser(user),
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
// First valid claim only: sets referred_by so the inviter's referral
// COUNT goes up (leaderboard + profile counts). It credits NO coins to
// either side — referrals must never mint free coins (see config.mjs).
async function applyReferral(user, rawCode) {
  const code = String(rawCode || "").trim().toUpperCase();
  if (!code) return { ok: false, message: "Enter a referral code." };
  if (user.referredBy) return { ok: false, message: "You have already claimed a referral code." };
  const inviters = await db.select().from(schema.users).where(eq(schema.users.referralCode, code)).limit(1);
  const inviter = inviters[0];
  if (!inviter) return { ok: false, message: "That referral code was not found." };
  if (inviter.id === user.id) return { ok: false, message: "You cannot use your own referral code." };
  await db.update(schema.users).set({ referredBy: inviter.id }).where(eq(schema.users.id, user.id));
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
// referral claim links the referrer (count only — no coins are minted),
// and the Google profile picture becomes the account's DP.
export async function googleCompleteSignup(profile, rawArgs) {
  const parsed = z
    .object({
      username: usernameRule,
      display_name: z.string().trim().min(2).max(60).optional(),
      referral_code: z.string().trim().max(64).optional(),
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
function withValidation(shape, handler) {
  return async (rawArgs) => {
    let args;
    try {
      args = shape.parse(rawArgs ?? {});
    } catch {
      return { ok: false, message: "Invalid request." };
    }
    return handler(args);
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
    }),
    async (args) => {
      const username = args.username.toLowerCase();
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
      let rows;
      if (args.stream === "following") {
        const followees = await db.select({ id: schema.follows.followeeId }).from(schema.follows).where(eq(schema.follows.followerId, user.id));
        const ids = followees.map((f) => f.id);
        if (ids.length === 0) return { ok: true, posts: [] };
        rows = await db.select().from(schema.posts).where(inArray(schema.posts.userId, ids)).orderBy(desc(schema.posts.createdAt)).limit(args.limit).offset(args.offset);
      } else {
        rows = await db.select().from(schema.posts).orderBy(desc(schema.posts.createdAt)).limit(args.limit).offset(args.offset);
      }
      return { ok: true, posts: await postDtos(rows, user) };
    }
  ),

  getWatch: withValidation(
    z.object({ token: tokenArg, query: z.string().trim().max(120).optional(), limit: z.number().int().min(1).max(50).default(30), offset: z.number().int().min(0).default(0) }),
    async (args) => {
      const user = await authUser(args.token);
      if (!user) return { ok: false, message: "Please sign in." };
      let query = db.select().from(schema.posts);
      if (args.query) {
        const term = `%${args.query}%`;
        query = query.where(or(like(schema.posts.title, term), like(schema.posts.description, term)));
      }
      const rows = await query.orderBy(desc(schema.posts.createdAt)).limit(args.limit).offset(args.offset);
      return { ok: true, posts: await postDtos(rows, user) };
    }
  ),

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
    if (post.userId !== user.id) return { ok: false, message: "You can only delete your own videos." };
    await db.delete(schema.posts).where(eq(schema.posts.id, post.id));
    if (post.videoPublicId) await destroyFromCloudinary(post.videoPublicId, "video");
    return { ok: true, message: "Video deleted." };
  }),

  toggleLike: withValidation(z.object({ token: tokenArg, post_id: z.number().int().positive() }), async (args) => {
    const user = await authUser(args.token);
    if (!user) return { ok: false, message: "Please sign in." };
    const post = (await db.select({ id: schema.posts.id }).from(schema.posts).where(eq(schema.posts.id, args.post_id)).limit(1))[0];
    if (!post) return { ok: false, message: "Video not found." };
    const existing = await db.select({ id: schema.likes.id }).from(schema.likes).where(and(eq(schema.likes.userId, user.id), eq(schema.likes.postId, args.post_id))).limit(1);
    let liked;
    if (existing.length > 0) {
      await db.delete(schema.likes).where(eq(schema.likes.id, existing[0].id));
      liked = false;
    } else {
      await db.insert(schema.likes).values({ userId: user.id, postId: args.post_id });
      liked = true;
    }
    const countRows = await db.select({ count: sql`count(*)`.mapWith(Number) }).from(schema.likes).where(eq(schema.likes.postId, args.post_id));
    return { ok: true, liked, like_count: countRows[0]?.count ?? 0 };
  }),

  getComments: withValidation(z.object({ token: tokenArg, post_id: z.number().int().positive() }), async (args) => {
    const user = await authUser(args.token);
    if (!user) return { ok: false, message: "Please sign in." };
    const rows = await db
      .select({ comment: schema.comments, author: schema.users })
      .from(schema.comments)
      .innerJoin(schema.users, eq(schema.comments.userId, schema.users.id))
      .where(eq(schema.comments.postId, args.post_id))
      .orderBy(schema.comments.createdAt);
    return {
      ok: true,
      comments: rows.map((r) => ({ id: r.comment.id, body: r.comment.body, created_at: r.comment.createdAt.getTime(), author: authorDto(r.author) })),
    };
  }),

  addComment: withValidation(z.object({ token: tokenArg, post_id: z.number().int().positive(), body: z.string().trim().min(1).max(500) }), async (args) => {
    const user = await authUser(args.token);
    if (!user) return { ok: false, message: "Please sign in." };
    const post = (await db.select({ id: schema.posts.id }).from(schema.posts).where(eq(schema.posts.id, args.post_id)).limit(1))[0];
    if (!post) return { ok: false, message: "Video not found." };
    const inserted = await db.insert(schema.comments).values({ userId: user.id, postId: args.post_id, body: args.body }).returning();
    const comment = inserted[0];
    if (!comment) return { ok: false, message: "Comment could not be posted." };
    return { ok: true, message: "Comment posted.", comment: { id: comment.id, body: comment.body, created_at: comment.createdAt.getTime(), author: authorDto(user) } };
  }),

  toggleFollow: withValidation(z.object({ token: tokenArg, user_id: z.number().int().positive() }), async (args) => {
    const user = await authUser(args.token);
    if (!user) return { ok: false, message: "Please sign in." };
    if (args.user_id === user.id) return { ok: false, message: "You cannot follow yourself." };
    const target = (await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, args.user_id)).limit(1))[0];
    if (!target) return { ok: false, message: "User not found." };
    const existing = await db.select({ id: schema.follows.id }).from(schema.follows).where(and(eq(schema.follows.followerId, user.id), eq(schema.follows.followeeId, args.user_id))).limit(1);
    let following;
    if (existing.length > 0) {
      await db.delete(schema.follows).where(eq(schema.follows.id, existing[0].id));
      following = false;
    } else {
      await db.insert(schema.follows).values({ followerId: user.id, followeeId: args.user_id });
      following = true;
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
    const counts = await referralCounts();
    const myFollows = await db.select({ followeeId: schema.follows.followeeId }).from(schema.follows).where(eq(schema.follows.followerId, user.id));
    const followSet = new Set(myFollows.map((f) => f.followeeId));
    const followerRows = await db.select({ followeeId: schema.follows.followeeId, count: sql`count(*)`.mapWith(Number) }).from(schema.follows).groupBy(schema.follows.followeeId);
    const followerMap = new Map(followerRows.map((r) => [r.followeeId, r.count]));
    return {
      ok: true,
      people: rows.map((u) => ({
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
    const postRows = await db.select().from(schema.posts).where(eq(schema.posts.userId, target.id)).orderBy(desc(schema.posts.createdAt)).limit(60);
    const isFollowing = target.id === viewer.id ? false : (await db.select({ id: schema.follows.id }).from(schema.follows).where(and(eq(schema.follows.followerId, viewer.id), eq(schema.follows.followeeId, target.id))).limit(1)).length > 0;
    let referrals = null;
    if (target.id === viewer.id) {
      const referred = await db.select().from(schema.users).where(eq(schema.users.referredBy, target.id)).orderBy(desc(schema.users.createdAt));
      referrals = referred.map((u) => ({ ...authorDto(u), created_at: u.createdAt.getTime() }));
    }
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
      },
      posts: await postDtos(postRows, viewer),
      referrals,
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
        top_coins: byCoins.slice(0, LEADERBOARD_LIMIT).map((u, i) => ({ rank: i + 1, ...boardRow(u) })),
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

  // ---- LIVE: broadcasts, gifts ---------------------------------------------
  // Sessions live in the DB (live_sessions); who is connected right now is
  // tracked by the WebSocket hub (live.mjs) — viewer counts come from there.

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
      return { ok: true, message: "You are live!", session: liveSessionDto(session, user), ice_servers: ICE_SERVERS };
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
    const lives = [];
    for (const r of rows) {
      // A session whose broadcaster never connected (or vanished without a
      // clean disconnect) must not haunt the list forever: once it is a
      // couple of minutes old with no broadcaster socket, close it out.
      if (!hasBroadcaster(r.session.id) && Date.now() - r.session.startedAt.getTime() > 120_000) {
        await endLiveSession(r.session.id, { notify: false });
        continue;
      }
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
      const broadcaster = (await db.select().from(schema.users).where(eq(schema.users.id, session.userId)).limit(1))[0];
      const followRow =
        session.userId === user.id
          ? null
          : (await db.select({ id: schema.follows.id }).from(schema.follows).where(and(eq(schema.follows.followerId, user.id), eq(schema.follows.followeeId, session.userId))).limit(1))[0];
      return {
        ok: true,
        session: liveSessionDto(session, broadcaster),
        gifts: GIFT_CATALOG,
        ice_servers: ICE_SERVERS,
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
      return {
        ok: true,
        message:
          args.decision === "approved"
            ? `Approved — ab Rs.${wd.amountPkr} JazzCash ${wd.jazzcashNumber} par bhej dein.`
            : "Withdrawal rejected — held coins wapas balance me daal diye.",
      };
    }
  ),
};
