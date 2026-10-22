// Business logic for Zoomly. Every action is an async function
// `(args) => responseObject`, exposed by index.mjs as POST /api/<name>.
// Mirrors the SMM panel's conventions: zod validation, PBKDF2 password
// hashes, SHA-256-hashed session tokens stored in the DB.
import { z } from "zod";
import { and, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import { db } from "./db.mjs";
import * as schema from "./schema.mjs";
import {
  COIN_PACKS,
  JAZZCASH,
  LEADERBOARD_LIMIT,
  REFERRAL_INVITER_COINS,
  REFERRAL_WELCOME_COINS,
  isAdminUser,
  levelFor,
} from "./config.mjs";
import { destroyFromCloudinary } from "./cloudinary.mjs";

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

async function authUser(token) {
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

// ---- Referral -------------------------------------------------------------
// First valid claim only: sets referred_by, inviter +25 coins, claimer +10.
async function applyReferral(user, rawCode) {
  const code = String(rawCode || "").trim().toUpperCase();
  if (!code) return { ok: false, message: "Enter a referral code." };
  if (user.referredBy) return { ok: false, message: "You have already claimed a referral code." };
  const inviters = await db.select().from(schema.users).where(eq(schema.users.referralCode, code)).limit(1);
  const inviter = inviters[0];
  if (!inviter) return { ok: false, message: "That referral code was not found." };
  if (inviter.id === user.id) return { ok: false, message: "You cannot use your own referral code." };
  await db.batch([
    db.update(schema.users).set({ referredBy: inviter.id, coinBalance: sql`${schema.users.coinBalance} + ${REFERRAL_WELCOME_COINS}` }).where(eq(schema.users.id, user.id)),
    db.update(schema.users).set({ coinBalance: sql`${schema.users.coinBalance} + ${REFERRAL_INVITER_COINS}` }).where(eq(schema.users.id, inviter.id)),
  ]);
  return { ok: true, message: `Referral claimed! You got ${REFERRAL_WELCOME_COINS} welcome coins and @${inviter.username} got ${REFERRAL_INVITER_COINS}.` };
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
    return {
      ok: true,
      my_code: user.referralCode,
      has_claimed_referral: Boolean(user.referredBy),
      coin_balance: user.coinBalance,
      ...levelFor(user.coinBalance),
      referral_count: counts.get(user.id) ?? 0,
      packs: COIN_PACKS,
      jazzcash: JAZZCASH,
      my_requests: myRequests.map((r) => ({ id: r.id, pack_coins: r.packCoins, price_pkr: r.pricePkr, tid: r.tid, status: r.status, created_at: r.createdAt.getTime() })),
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
    return {
      ok: true,
      requests: rows.map((r) => ({
        id: r.request.id,
        pack_coins: r.request.packCoins,
        price_pkr: r.request.pricePkr,
        tid: r.request.tid,
        status: r.request.status,
        created_at: r.request.createdAt.getTime(),
        buyer: authorDto(r.buyer),
      })),
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
};
