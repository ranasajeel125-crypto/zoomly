// Real-time hub for Zoomly LIVE (WebSocket, `ws` library).
//
// One WS endpoint (/ws) carries everything live:
//   - WebRTC signaling relay (offer/answer/ICE) between a broadcaster and
//     each of its viewers — media itself is peer-to-peer and never touches
//     this server (same philosophy as uploads going to Cloudinary).
//   - Live chat relay inside a broadcast room.
//   - Viewer-count updates and gift-event broadcasts.
//
// Rooms are in-memory: sessionId -> { broadcaster: conn|null, viewers:
// Map<peerId, conn> }. A conn is { ws, peerId, user, sessionId, role }.
//
// Auth: the client's first message must be { type:"auth", token } with the
// same session token the RPC API uses; the token->user lookup is injected
// from index.mjs (authenticate) so this module never imports actions.mjs
// (actions.mjs imports the broadcast helpers from here — no import cycle).
//
// Protocol (JSON text frames):
//   C->S  {type:"auth", token}
//   S->C  {type:"auth-ok", peerId, user} | {type:"auth-error", message}
//   C->S  {type:"join", liveSessionId}   (role is derived: session owner =
//                                         broadcaster, everyone else viewer)
//   S->C  {type:"joined", liveSessionId, role, viewerCount, broadcasterPeerId}
//   S->C  {type:"viewer-joined", peerId, user}   (to the broadcaster)
//   S->C  {type:"viewer-left", peerId}          (to the broadcaster)
//   S->C  {type:"broadcaster-joined", peerId}   (to waiting viewers)
//   S->C  {type:"viewer-count", liveSessionId, count}
//   C->S  {type:"chat", text}   S->C {type:"chat", from, text, created_at}
//   C->S  {type:"live-like", n}  (viewers tap the stage to like; n is a
//          small batch count, clamped + rate-limited server-side)
//   S->C  {type:"live-likes", total, n, fromPeerId}  (running room total;
//          in-memory only — a live's likes reset when the live ends)
//   C->S  {type:"signal", to, data}   S->C {type:"signal", from, data}
//   S->C  {type:"gift", ...}    (broadcast by the sendGift RPC action)
//   S->C  {type:"live-ended", liveSessionId}
//   C->S  {type:"leave"}
//
// Guest seat (one viewer joins the stage, TikTok-style):
//   C->S  {type:"guest-request"}                    (a viewer asks to join)
//   S->C  {type:"guest-request", requestId, from:{peerId,user}, expiresAt}
//                                                   (to the broadcaster)
//   C->S  {type:"guest-respond", requestId, accept}
//   S->C  {type:"guest-declined"}                   (to the requester)
//   S->C  {type:"guest-request-expired", requestId} (requester + broadcaster)
//   S->C  {type:"guest-seated", guestPeerId, guest} (whole room)
//   C->S  {type:"guest-ready"}   (guest has camera/mic and can publish)
//   S->C  {type:"guest-peer", peerId, initiate}     (host<->guest wiring)
//   C->S  {type:"guest-leave"} | {type:"guest-abort"} (guest steps down)
//   C->S  {type:"guest-remove"}                     (broadcaster removes)
//   S->C  {type:"guest-left", guestPeerId, removed} (whole room)
// The seated guest stays a member of the room's viewers map; the seat is
// just marked on the room. While a guest is seated no PK match can run
// in the room (and vice versa) — v1 keeps the stage to two publishers
// of one kind at a time.
//
// Broad rooms (session kind "broad", audio-only) seat up to 6 speakers
// next to the host instead — same request/invite pattern, seats instead
// of one guest, every publisher audio-only:
//   S->C  {type:"joined", kind:"broad", seats:<snapshot>}
//   S->C  {type:"seats", host:{peerId,user,muted}, seats:[{seat,peerId,user,muted}], seatsFree}
//   C->S  {type:"seat-request"}                     (listener asks)
//   S->C  {type:"seat-request", requestId, from, expiresAt}        (host)
//   C->S  {type:"seat-respond", requestId, accept}                 (host)
//   S->C  {type:"seat-seated", seat} | {type:"seat-declined", requestId} |
//         {type:"seat-request-expired", requestId} | {type:"seat-request-cancelled", requestId}
//   C->S  {type:"seat-ready"}    (speaker has its mic — always live — and can publish)
//   S->C  {type:"seat-peer", peerId, initiate}       (host<->speaker wiring)
//   C->S  {type:"seat-invite", toPeerId}             (host invites a listener)
//   S->C  {type:"seat-invited", inviteId, from, expiresAt}         (listener)
//   C->S  {type:"seat-invite-respond", inviteId, accept}           (listener)
//   S->C  {type:"seat-invite-declined", inviteId, by} | {type:"seat-invite-expired", inviteId}
//   C->S  {type:"seat-leave"}                        (speaker steps down)
//   C->S  {type:"seat-drop", peerId}                 (host drops a speaker)
//   C->S  {type:"seat-mute", muted}                  (self-mute: host or speaker)
//   C->S  {type:"seat-host-mute", peerId, muted}     (host mutes a seat)
//   S->C  {type:"seat-host-muted", muted}            (the muted speaker)
//   S->C  {type:"seat-left", peerId, removed}        (whole room)
// Mics are OPEN BY DEFAULT: every seat (host included) starts
// muted === false; muting is a choice, never a gate. Broad rooms
// refuse PK matches and the video guest seat (kind checks).
//
// PK matches (two broadcasters, one shared 5-minute battle):
//   C->S  {type:"match-invite", toLiveSessionId}
//   S->C  {type:"match-invite", inviteId, from:{liveSessionId,title,user}}
//   C->S  {type:"match-respond", inviteId, accept}
//   S->C  {type:"match-declined", by} | {type:"match-invite-expired", inviteId}
//   S->C  {type:"match-started", matchId, a, b, scoreA, scoreB, endsAt}
//   S->C  {type:"match-peer", matchId, peerId, initiate}  (broadcaster pair)
//   S->C  {type:"match-score", matchId, scoreA, scoreB}
//   S->C  {type:"match-ended", matchId, scoreA, scoreB, winner, draw, reason}
// While matched, the two rooms are also wired together for signaling:
// each broadcaster offers its stream to the other room's viewers, and the
// broadcasters peer-connect to each other.
import { WebSocketServer } from "ws";
import crypto from "node:crypto";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "./db.mjs";
import * as schema from "./schema.mjs";
import { MATCH_DURATION_MS, MATCH_INVITE_TTL_MS, findBannedContent, isAdminUser } from "./config.mjs";

const AUTH_TIMEOUT_MS = 10_000;
const MAX_CHAT_CHARS = 500;

const rooms = new Map(); // sessionId -> { broadcaster, viewers: Map, guest, guestRequests: Map, likes, kind, seats: Map, seatRequests: Map, seatInvites: Map, hostMuted }

// Tap-tap likes: per-user rate limit — at most this many taps are
// counted per second, however fast they tap or batch.
const MAX_LIKES_PER_SECOND = 10;

// Broad (audio-only voice rooms): the host plus at most this many
// seated speakers — 7 voices in total.
const BROAD_MAX_SEATS = 6;
const SEAT_REQUEST_TTL_MS = 30_000;

function roomFor(sessionId) {
  let room = rooms.get(sessionId);
  if (!room) {
    room = {
      broadcaster: null,
      viewers: new Map(),
      guest: null,
      guestWired: false,
      guestRequests: new Map(),
      likes: 0,
      sessionId,
      kind: "video",
      seats: new Map(), // broad: seatNo -> { peerId, user, muted, wired }
      seatRequests: new Map(), // broad: requestId -> { fromPeerId, timer }
      seatInvites: new Map(), // broad: inviteId -> { toPeerId, timer }
      hostMuted: false, // broad: the host's own mic state (open by default)
    };
    rooms.set(sessionId, room);
  }
  return room;
}

// The broad seat state the whole room renders from: the host seat
// (pinned first) plus every filled guest seat. Microphones are OPEN
// by default — `muted` starts false for the host and every speaker;
// it only turns true when that person (or the host, for a speaker)
// mutes. Sent as a full snapshot on every change.
function seatsSnapshot(room) {
  return {
    host: room.broadcaster ? { peerId: room.broadcaster.peerId, user: publicUser(room.broadcaster.user), muted: room.hostMuted } : null,
    seats: [...room.seats.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([seat, s]) => ({ seat, peerId: s.peerId, user: s.user, muted: s.muted })),
    seatsFree: BROAD_MAX_SEATS - room.seats.size,
  };
}

function broadcastSeats(room) {
  broadcastRoom(room.sessionId, { type: "seats", liveSessionId: room.sessionId, ...seatsSnapshot(room) });
}

function seatOfPeer(room, peerId) {
  for (const [seat, s] of room.seats.entries()) {
    if (s.peerId === peerId) return { seat, entry: s };
  }
  return null;
}

function publicUser(user) {
  return { id: user.id, username: user.username, display_name: user.displayName, avatar_url: user.avatarUrl ?? null, is_owner: isAdminUser(user) };
}

function send(conn, obj) {
  if (conn && conn.ws.readyState === conn.ws.OPEN) {
    try {
      conn.ws.send(JSON.stringify(obj));
    } catch {
      /* socket already gone */
    }
  }
}

function roomConns(room) {
  const out = [];
  if (room.broadcaster) out.push(room.broadcaster);
  for (const v of room.viewers.values()) out.push(v);
  return out;
}

function broadcastRoom(sessionId, obj, except = null) {
  const room = rooms.get(sessionId);
  if (!room) return;
  for (const conn of roomConns(room)) {
    if (conn !== except) send(conn, obj);
  }
}

export function viewerCountFor(sessionId) {
  const room = rooms.get(sessionId);
  return room ? room.viewers.size : 0;
}

// True while the broadcaster's socket is connected to the room.
export function hasBroadcaster(sessionId) {
  const room = rooms.get(sessionId);
  return Boolean(room?.broadcaster);
}

function broadcastViewerCount(sessionId) {
  broadcastRoom(sessionId, { type: "viewer-count", liveSessionId: sessionId, count: viewerCountFor(sessionId) });
}

async function notePeakViewers(sessionId, count) {
  try {
    await db
      .update(schema.liveSessions)
      .set({ peakViewers: sql`max(${schema.liveSessions.peakViewers}, ${count})` })
      .where(eq(schema.liveSessions.id, sessionId));
  } catch (err) {
    console.error("[live] peak viewers update failed:", err?.message || err);
  }
}

// Ends a live session in the DB (idempotent) and, if a room is still
// around, tells everyone and tears the room down. Used by the endLive RPC
// action, the broadcaster-leave path and the disconnect handler.
export async function endLiveSession(sessionId, { notify = true } = {}) {
  // A live that ends mid-match ends the match first (the other room hears
  // "match-ended" before this room hears "live-ended").
  await endMatchForSession(sessionId, "live-ended");
  try {
    const rows = await db.select().from(schema.liveSessions).where(eq(schema.liveSessions.id, sessionId)).limit(1);
    const session = rows[0];
    if (session && !session.endedAt) {
      await db.update(schema.liveSessions).set({ endedAt: new Date() }).where(eq(schema.liveSessions.id, sessionId));
    }
  } catch (err) {
    console.error("[live] end session failed:", err?.message || err);
  }
  const room = rooms.get(sessionId);
  if (room) {
    if (notify) broadcastRoom(sessionId, { type: "live-ended", liveSessionId: sessionId });
    for (const req of room.guestRequests.values()) clearTimeout(req.timer);
    room.guestRequests.clear();
    for (const req of room.seatRequests.values()) clearTimeout(req.timer);
    room.seatRequests.clear();
    for (const inv of room.seatInvites.values()) clearTimeout(inv.timer);
    room.seatInvites.clear();
    for (const conn of roomConns(room)) conn.sessionId = null;
    rooms.delete(sessionId);
  }
}

// Called by the sendGift RPC action after the money has moved: everyone in
// the room (broadcaster, sender, other viewers) sees the gift.
export function broadcastGift(sessionId, payload) {
  broadcastRoom(sessionId, { type: "gift", liveSessionId: sessionId, ...payload });
}

// ---- PK matches ---------------------------------------------------------------
// In-memory match state (the DB row in live_matches is the durable record;
// final scores/winner are written when the match ends, running scores are
// also mirrored to the row on each gift, best effort).
const matches = new Map(); // matchId -> match
const matchBySession = new Map(); // liveSessionId -> matchId
const invites = new Map(); // inviteId -> { fromSessionId, toSessionId, timer }

export function isInMatch(sessionId) {
  return matchBySession.has(sessionId);
}

function matchedSessionId(sessionId) {
  const matchId = matchBySession.get(sessionId);
  if (!matchId) return null;
  const match = matches.get(matchId);
  if (!match) return null;
  return match.a.liveSessionId === sessionId ? match.b.liveSessionId : match.a.liveSessionId;
}

function matchPayload(match, type = "match-started") {
  return {
    type,
    matchId: match.id,
    liveSessionA: match.a.liveSessionId,
    liveSessionB: match.b.liveSessionId,
    a: { liveSessionId: match.a.liveSessionId, title: match.a.title, user: match.a.user },
    b: { liveSessionId: match.b.liveSessionId, title: match.b.title, user: match.b.user },
    scoreA: match.scoreA,
    scoreB: match.scoreB,
    endsAt: match.endsAt,
  };
}

function broadcastMatch(match, obj) {
  broadcastRoom(match.a.liveSessionId, obj);
  broadcastRoom(match.b.liveSessionId, obj);
}

// Called by sendGift after a gift lands: if the recipient's live is in a
// match, the gift's full coin value scores for that side.
export function noteGiftForMatch(sessionId, coins) {
  const matchId = matchBySession.get(sessionId);
  if (!matchId) return;
  const match = matches.get(matchId);
  if (!match) return;
  if (match.a.liveSessionId === sessionId) match.scoreA += coins;
  else if (match.b.liveSessionId === sessionId) match.scoreB += coins;
  else return;
  broadcastMatch(match, { type: "match-score", matchId: match.id, scoreA: match.scoreA, scoreB: match.scoreB });
  void db
    .update(schema.liveMatches)
    .set({ scoreA: match.scoreA, scoreB: match.scoreB })
    .where(eq(schema.liveMatches.id, match.id))
    .catch((err) => console.error("[live] match score persist failed:", err?.message || err));
}

async function endMatch(matchId, reason) {
  const match = matches.get(matchId);
  if (!match) return;
  matches.delete(matchId);
  matchBySession.delete(match.a.liveSessionId);
  matchBySession.delete(match.b.liveSessionId);
  if (match.timer) clearTimeout(match.timer);
  const winnerUser =
    match.scoreA > match.scoreB ? match.a.user : match.scoreB > match.scoreA ? match.b.user : null;
  try {
    await db
      .update(schema.liveMatches)
      .set({
        scoreA: match.scoreA,
        scoreB: match.scoreB,
        winnerUserId: winnerUser?.id ?? null,
        endedAt: new Date(),
      })
      .where(eq(schema.liveMatches.id, matchId));
  } catch (err) {
    console.error("[live] match end persist failed:", err?.message || err);
  }
  broadcastMatch(match, {
    type: "match-ended",
    matchId: match.id,
    liveSessionA: match.a.liveSessionId,
    liveSessionB: match.b.liveSessionId,
    scoreA: match.scoreA,
    scoreB: match.scoreB,
    winnerUserId: winnerUser?.id ?? null,
    winner: winnerUser,
    draw: !winnerUser,
    reason,
  });
}

// Ends the match a session is in (if any) — used when a live ends.
export async function endMatchForSession(sessionId, reason) {
  const matchId = matchBySession.get(sessionId);
  if (matchId) await endMatch(matchId, reason);
}

// Introduces two rooms' members for cross-viewing: each broadcaster gets a
// "viewer-joined" for the other room's viewers (so it sends them offers),
// each viewer learns the other broadcaster's peer id, and the two
// broadcasters are told to peer-connect (side A initiates).
function wireMatchRooms(match) {
  const roomA = rooms.get(match.a.liveSessionId);
  const roomB = rooms.get(match.b.liveSessionId);
  if (!roomA || !roomB) return;
  const crossWire = (fromRoom, toRoom, toSessionId) => {
    if (!toRoom.broadcaster) return;
    for (const viewer of fromRoom.viewers.values()) {
      send(toRoom.broadcaster, { type: "viewer-joined", peerId: viewer.peerId, user: publicUser(viewer.user), matchId: match.id });
      send(viewer, { type: "broadcaster-joined", peerId: toRoom.broadcaster.peerId, matchId: match.id, liveSessionId: toSessionId });
    }
  };
  crossWire(roomA, roomB, match.b.liveSessionId);
  crossWire(roomB, roomA, match.a.liveSessionId);
  if (roomA.broadcaster && roomB.broadcaster) {
    send(roomA.broadcaster, { type: "match-peer", matchId: match.id, peerId: roomB.broadcaster.peerId, initiate: true });
    send(roomB.broadcaster, { type: "match-peer", matchId: match.id, peerId: roomA.broadcaster.peerId, initiate: false });
  }
}

async function startMatch(aSessionId, bSessionId) {
  if (isInMatch(aSessionId) || isInMatch(bSessionId)) return null;
  const rows = await db
    .select({ session: schema.liveSessions, user: schema.users })
    .from(schema.liveSessions)
    .innerJoin(schema.users, eq(schema.liveSessions.userId, schema.users.id))
    .where(isNull(schema.liveSessions.endedAt));
  const sideOf = (sid) => {
    const r = rows.find((x) => x.session.id === sid);
    return r ? { liveSessionId: sid, title: r.session.title, user: publicUser(r.user), userId: r.user.id } : null;
  };
  const a = sideOf(aSessionId);
  const b = sideOf(bSessionId);
  if (!a || !b) return null;
  const inserted = await db
    .insert(schema.liveMatches)
    .values({ liveSessionA: aSessionId, liveSessionB: bSessionId, userA: a.userId, userB: b.userId })
    .returning();
  const row = inserted[0];
  if (!row) return null;
  const match = {
    id: row.id,
    a: { liveSessionId: a.liveSessionId, title: a.title, user: a.user },
    b: { liveSessionId: b.liveSessionId, title: b.title, user: b.user },
    scoreA: 0,
    scoreB: 0,
    endsAt: Date.now() + MATCH_DURATION_MS,
    timer: null,
  };
  match.timer = setTimeout(() => {
    void endMatch(match.id, "time");
  }, MATCH_DURATION_MS);
  matches.set(match.id, match);
  matchBySession.set(aSessionId, match.id);
  matchBySession.set(bSessionId, match.id);
  broadcastMatch(match, matchPayload(match));
  wireMatchRooms(match);
  return match;
}

async function handleMatchInvite(conn, toLiveSessionId) {
  if (conn.role !== "broadcaster" || !conn.sessionId) {
    send(conn, { type: "error", message: "Sirf live broadcaster hi PK match ka challenge bhej sakta hai." });
    return;
  }
  if (!Number.isInteger(toLiveSessionId) || toLiveSessionId <= 0 || toLiveSessionId === conn.sessionId) {
    send(conn, { type: "error", message: "Invalid match challenge." });
    return;
  }
  if (isInMatch(conn.sessionId)) {
    send(conn, { type: "error", message: "Tum pehle se ek match me ho." });
    return;
  }
  if (isInMatch(toLiveSessionId)) {
    send(conn, { type: "error", message: "Woh broadcaster pehle se ek match me hai." });
    return;
  }
  const myRoom = rooms.get(conn.sessionId);
  if (myRoom?.kind === "broad") {
    send(conn, { type: "error", message: "Broad (voice) room se PK match nahi hota." });
    return;
  }
  if (myRoom?.guest) {
    send(conn, { type: "error", message: "Tumhare live me guest betha hai — match abhi nahi ho sakta." });
    return;
  }
  const targetRoom = rooms.get(toLiveSessionId);
  if (!targetRoom?.broadcaster) {
    send(conn, { type: "error", message: "Woh broadcaster ab live nahi hai." });
    return;
  }
  if (targetRoom.kind === "broad") {
    send(conn, { type: "error", message: "Broad (voice) room ke sath PK match nahi hota." });
    return;
  }
  if (targetRoom.guest) {
    send(conn, { type: "error", message: "Us broadcaster ke live me guest betha hai — match abhi nahi ho sakta." });
    return;
  }
  for (const inv of invites.values()) {
    if (inv.fromSessionId === conn.sessionId) {
      send(conn, { type: "error", message: "Ek invite pehle se bheja hua hai — jawab ka intezar karo." });
      return;
    }
  }
  const session = (await db.select().from(schema.liveSessions).where(eq(schema.liveSessions.id, conn.sessionId)).limit(1))[0];
  const inviteId = crypto.randomBytes(8).toString("hex");
  const timer = setTimeout(() => {
    if (invites.delete(inviteId)) {
      const fromRoom = rooms.get(conn.sessionId);
      if (fromRoom?.broadcaster) send(fromRoom.broadcaster, { type: "match-invite-expired", inviteId });
    }
  }, MATCH_INVITE_TTL_MS);
  invites.set(inviteId, { fromSessionId: conn.sessionId, toSessionId: toLiveSessionId, timer });
  send(targetRoom.broadcaster, {
    type: "match-invite",
    inviteId,
    from: { liveSessionId: conn.sessionId, title: session?.title ?? "", user: publicUser(conn.user) },
    expiresAt: Date.now() + MATCH_INVITE_TTL_MS,
  });
}

async function handleMatchRespond(conn, inviteId, accept) {
  const invite = typeof inviteId === "string" ? invites.get(inviteId) : undefined;
  if (!invite) {
    send(conn, { type: "error", message: "Ye invite khatam ho chuka hai." });
    return;
  }
  if (conn.role !== "broadcaster" || conn.sessionId !== invite.toSessionId) {
    send(conn, { type: "error", message: "Ye invite tumhare liye nahi hai." });
    return;
  }
  invites.delete(inviteId);
  clearTimeout(invite.timer);
  const fromRoom = rooms.get(invite.fromSessionId);
  if (!accept) {
    if (fromRoom?.broadcaster) send(fromRoom.broadcaster, { type: "match-declined", by: publicUser(conn.user) });
    return;
  }
  if (!fromRoom?.broadcaster || isInMatch(invite.fromSessionId) || isInMatch(invite.toSessionId)) {
    send(conn, { type: "error", message: "Match start nahi ho saka — shayad doosra broadcaster live nahi raha." });
    if (fromRoom?.broadcaster) send(fromRoom.broadcaster, { type: "match-declined", by: publicUser(conn.user) });
    return;
  }
  if (fromRoom.guest || rooms.get(invite.toSessionId)?.guest) {
    send(conn, { type: "error", message: "Kisi ek live me guest betha hai — match abhi nahi ho sakta." });
    if (fromRoom?.broadcaster) send(fromRoom.broadcaster, { type: "match-declined", by: publicUser(conn.user) });
    return;
  }
  if (fromRoom.kind === "broad" || rooms.get(invite.toSessionId)?.kind === "broad") {
    send(conn, { type: "error", message: "Broad (voice) room ke sath PK match nahi hota." });
    if (fromRoom?.broadcaster) send(fromRoom.broadcaster, { type: "match-declined", by: publicUser(conn.user) });
    return;
  }
  await startMatch(invite.fromSessionId, invite.toSessionId);
}

// ---- Guest seat -------------------------------------------------------------
// One viewer at a time can sit on the stage as a guest publisher. The
// flow mirrors the match invites: request -> broadcaster accepts or
// declines -> the guest confirms camera/mic ("guest-ready") -> wiring.
// Wiring mirrors the match cross-wiring too: the broadcaster initiates a
// full-duplex peer connection to the guest (replacing its plain viewer
// connection to them), and the guest is told about every viewer so it
// can publish to each of them. New viewers who join mid-seat are wired
// to both publishers (see handleJoin).
const GUEST_REQUEST_TTL_MS = 30_000;

function seatGuest(room, guestConn) {
  room.guest = { peerId: guestConn.peerId, user: publicUser(guestConn.user) };
  room.guestWired = false;
  broadcastRoom(room.sessionId, { type: "guest-seated", liveSessionId: room.sessionId, guestPeerId: guestConn.peerId, guest: room.guest.user });
}

function wireGuest(room, guestConn) {
  room.guestWired = true;
  if (room.broadcaster) {
    send(room.broadcaster, { type: "guest-peer", peerId: guestConn.peerId, initiate: true });
    send(guestConn, { type: "guest-peer", peerId: room.broadcaster.peerId, initiate: false });
  }
  for (const viewer of room.viewers.values()) {
    if (viewer !== guestConn) {
      send(guestConn, { type: "viewer-joined", peerId: viewer.peerId, user: publicUser(viewer.user), guestPublisher: true });
    }
  }
}

// Frees the seat and tells the whole room. If the ex-guest is still
// connected and the seat had been wired, the broadcaster is re-notified
// about them as a plain viewer so it re-offers its normal stream.
function unseatGuest(room, { removed = false } = {}) {
  if (!room.guest) return;
  const guestPeerId = room.guest.peerId;
  const wasWired = room.guestWired;
  room.guest = null;
  room.guestWired = false;
  broadcastRoom(room.sessionId, { type: "guest-left", liveSessionId: room.sessionId, guestPeerId, removed });
  const guestConn = room.viewers.get(guestPeerId);
  if (guestConn && wasWired && room.broadcaster) {
    send(room.broadcaster, { type: "viewer-joined", peerId: guestConn.peerId, user: publicUser(guestConn.user) });
  }
}

async function handleGuestRequest(conn) {
  if (!conn.sessionId || conn.role !== "viewer") {
    send(conn, { type: "error", message: "Sirf viewers hi live me bethne ki request bhej sakte hain." });
    return;
  }
  const room = rooms.get(conn.sessionId);
  if (room?.kind === "broad") {
    send(conn, { type: "error", message: "Broad room me video guest seat nahi hoti — wahan ✋ Seat lo se sirf awaz ke liye bethte hain." });
    return;
  }
  if (!room?.broadcaster) {
    send(conn, { type: "error", message: "Broadcaster ab live nahi hai." });
    return;
  }
  // A block in either direction means no guest seat on this stage.
  const blockRows = await db
    .select({ id: schema.blocks.id })
    .from(schema.blocks)
    .where(
      or(
        and(eq(schema.blocks.userId, conn.user.id), eq(schema.blocks.blockedId, room.broadcaster.user.id)),
        and(eq(schema.blocks.userId, room.broadcaster.user.id), eq(schema.blocks.blockedId, conn.user.id)),
      ),
    )
    .limit(1);
  if (blockRows.length > 0) {
    send(conn, { type: "error", message: "Tum is live me guest nahi ban sakte." });
    return;
  }
  if (isInMatch(conn.sessionId)) {
    send(conn, { type: "error", message: "PK match ke doran guest nahi beth sakta." });
    return;
  }
  if (room.guest) {
    send(conn, { type: "error", message: "Ek guest pehle se betha hai." });
    return;
  }
  for (const req of room.guestRequests.values()) {
    if (req.fromPeerId === conn.peerId) {
      send(conn, { type: "error", message: "Tumhari request pehle se bheji hui hai — jawab ka intezar karo." });
      return;
    }
  }
  const requestId = crypto.randomBytes(8).toString("hex");
  const timer = setTimeout(() => {
    if (room.guestRequests.delete(requestId)) {
      send(conn, { type: "guest-request-expired", requestId });
      if (room.broadcaster) send(room.broadcaster, { type: "guest-request-expired", requestId });
    }
  }, GUEST_REQUEST_TTL_MS);
  room.guestRequests.set(requestId, { fromPeerId: conn.peerId, timer });
  send(room.broadcaster, {
    type: "guest-request",
    requestId,
    from: { peerId: conn.peerId, user: publicUser(conn.user) },
    expiresAt: Date.now() + GUEST_REQUEST_TTL_MS,
  });
}

function handleGuestRespond(conn, requestId, accept) {
  if (conn.role !== "broadcaster" || !conn.sessionId) return;
  const room = rooms.get(conn.sessionId);
  const req = room && typeof requestId === "string" ? room.guestRequests.get(requestId) : undefined;
  if (!req) {
    send(conn, { type: "error", message: "Ye request khatam ho chuki hai." });
    return;
  }
  room.guestRequests.delete(requestId);
  clearTimeout(req.timer);
  const requester = room.viewers.get(req.fromPeerId);
  if (!accept) {
    if (requester) send(requester, { type: "guest-declined" });
    return;
  }
  if (room.guest || isInMatch(conn.sessionId)) {
    send(conn, { type: "error", message: room.guest ? "Ek guest pehle se betha hai." : "PK match ke doran guest nahi beth sakta." });
    if (requester) send(requester, { type: "guest-declined" });
    return;
  }
  if (!requester) {
    send(conn, { type: "error", message: "Woh viewer ab live me nahi hai." });
    return;
  }
  seatGuest(room, requester);
}

function handleGuestReady(conn) {
  if (!conn.sessionId) return;
  const room = rooms.get(conn.sessionId);
  if (!room || room.guest?.peerId !== conn.peerId) return;
  wireGuest(room, conn);
}

function handleGuestLeave(conn) {
  if (!conn.sessionId) return;
  const room = rooms.get(conn.sessionId);
  if (room && room.guest?.peerId === conn.peerId) unseatGuest(room);
}

function handleGuestRemove(conn) {
  if (conn.role !== "broadcaster" || !conn.sessionId) return;
  const room = rooms.get(conn.sessionId);
  if (room?.guest) unseatGuest(room, { removed: true });
}

// ---- Broad seats (audio-only voice rooms) -----------------------------------
// The model mirrors the video guest seat, multiplied: up to
// BROAD_MAX_SEATS listeners can sit as speakers next to the host, every
// one publishing AUDIO ONLY over the same mesh signaling (broad clients
// never capture video at all). The host holds the authority — seat
// requests are answered by the host, the host can invite a listener
// directly, drop a speaker back to listener, and mute a seat — while
// every speaker controls their own mic too. Microphones are OPEN by
// default: a seat is created with muted === false and the mic is live
// the moment the speaker is wired; there is no tap-to-unmute gate.

// Puts a viewer into the lowest free seat (mic open) and tells the room.
function seatSpeaker(room, conn) {
  let seatNo = 0;
  for (let n = 1; n <= BROAD_MAX_SEATS; n++) {
    if (!room.seats.has(n)) {
      seatNo = n;
      break;
    }
  }
  if (!seatNo) return false;
  room.seats.set(seatNo, { peerId: conn.peerId, user: publicUser(conn.user), muted: false, wired: false });
  send(conn, { type: "seat-seated", liveSessionId: room.sessionId, seat: seatNo });
  broadcastSeats(room);
  return true;
}

// Called once the freshly seated speaker has its mic ("seat-ready"):
// the host initiates the full-duplex host<->speaker connection, and the
// speaker is told to publish to every other member (other speakers get
// a full-duplex pair; plain listeners receive only). The host is not in
// the viewers map, so it never appears in that list.
function wireSeatSpeaker(room, speakerConn) {
  const found = seatOfPeer(room, speakerConn.peerId);
  if (!found || found.entry.wired) return;
  found.entry.wired = true;
  if (room.broadcaster) {
    send(room.broadcaster, { type: "seat-peer", liveSessionId: room.sessionId, peerId: speakerConn.peerId, initiate: true });
    send(speakerConn, { type: "seat-peer", liveSessionId: room.sessionId, peerId: room.broadcaster.peerId, initiate: false });
  }
  for (const member of room.viewers.values()) {
    if (member.peerId === speakerConn.peerId) continue;
    send(speakerConn, {
      type: "viewer-joined",
      peerId: member.peerId,
      user: publicUser(member.user),
      seatPublisher: true,
      seatPeer: Boolean(seatOfPeer(room, member.peerId)),
    });
  }
}

// Returns a speaker to the listener pool (voluntary leave, host drop,
// or seat cleanup). Everyone hears "seat-left" and closes that peer's
// speaker connections; the host re-offers its normal send-only listener
// connection so the ex-speaker keeps hearing the host.
function unseatSpeaker(room, peerId, { removed }) {
  const found = seatOfPeer(room, peerId);
  if (!found) return;
  room.seats.delete(found.seat);
  broadcastRoom(room.sessionId, { type: "seat-left", liveSessionId: room.sessionId, peerId, removed });
  broadcastSeats(room);
  const back = room.viewers.get(peerId);
  if (back && room.broadcaster) {
    send(room.broadcaster, { type: "viewer-joined", peerId, user: publicUser(back.user) });
  }
}

async function handleSeatRequest(conn) {
  if (!conn.sessionId || conn.role !== "viewer") return;
  const room = rooms.get(conn.sessionId);
  if (!room || room.kind !== "broad") {
    send(conn, { type: "error", message: "Seat sirf Broad (voice) rooms me milti hai." });
    return;
  }
  if (!room.broadcaster) {
    send(conn, { type: "error", message: "Host abhi connected nahi hai — thodi dair baad koshish karo." });
    return;
  }
  if (seatOfPeer(room, conn.peerId)) {
    send(conn, { type: "error", message: "Tum pehle se seat par bethay ho." });
    return;
  }
  if (room.seats.size >= BROAD_MAX_SEATS) {
    send(conn, { type: "error", message: "Saari 6 seats full hain — abhi koi seat khali nahi hai." });
    return;
  }
  for (const r of room.seatRequests.values()) {
    if (r.fromPeerId === conn.peerId) {
      send(conn, { type: "error", message: "Tumhari seat request host ke paas pehle se hai." });
      return;
    }
  }
  // A block in either direction means no seat next to this host.
  const blockRows = await db
    .select({ id: schema.blocks.id })
    .from(schema.blocks)
    .where(
      or(
        and(eq(schema.blocks.userId, conn.user.id), eq(schema.blocks.blockedId, room.broadcaster.user.id)),
        and(eq(schema.blocks.userId, room.broadcaster.user.id), eq(schema.blocks.blockedId, conn.user.id)),
      ),
    )
    .limit(1);
  if (blockRows.length > 0) {
    send(conn, { type: "error", message: "Seat request nahi bhej sakte." });
    return;
  }
  const requestId = crypto.randomBytes(8).toString("hex");
  const timer = setTimeout(() => {
    if (room.seatRequests.delete(requestId)) {
      send(conn, { type: "seat-request-expired", liveSessionId: room.sessionId, requestId });
      if (room.broadcaster) send(room.broadcaster, { type: "seat-request-cancelled", liveSessionId: room.sessionId, requestId });
    }
  }, SEAT_REQUEST_TTL_MS);
  room.seatRequests.set(requestId, { fromPeerId: conn.peerId, timer });
  send(room.broadcaster, {
    type: "seat-request",
    liveSessionId: room.sessionId,
    requestId,
    from: { peerId: conn.peerId, user: publicUser(conn.user) },
    expiresAt: Date.now() + SEAT_REQUEST_TTL_MS,
  });
  send(conn, { type: "seat-request-sent", liveSessionId: room.sessionId, requestId });
}

function handleSeatRespond(conn, requestId, accept) {
  if (!conn.sessionId || conn.role !== "broadcaster") return;
  const room = rooms.get(conn.sessionId);
  if (!room || room.kind !== "broad" || typeof requestId !== "string") return;
  const req = room.seatRequests.get(requestId);
  if (!req) return;
  clearTimeout(req.timer);
  room.seatRequests.delete(requestId);
  const requester = room.viewers.get(req.fromPeerId);
  if (!accept) {
    if (requester) send(requester, { type: "seat-declined", liveSessionId: room.sessionId, requestId });
    return;
  }
  if (!requester || seatOfPeer(room, requester.peerId)) return;
  if (!seatSpeaker(room, requester)) {
    send(requester, { type: "error", message: "Seats full ho gayi hain — seat nahi mil saki." });
    send(conn, { type: "error", message: "Seats full ho gayi hain." });
  }
}

function handleSeatReady(conn) {
  if (!conn.sessionId || conn.role !== "viewer") return;
  const room = rooms.get(conn.sessionId);
  if (!room || room.kind !== "broad") return;
  if (seatOfPeer(room, conn.peerId)) wireSeatSpeaker(room, conn);
}

// Host taps an empty seat and invites a specific current listener.
function handleSeatInvite(conn, toPeerId) {
  if (!conn.sessionId || conn.role !== "broadcaster") return;
  const room = rooms.get(conn.sessionId);
  if (!room || room.kind !== "broad" || typeof toPeerId !== "string") return;
  const target = room.viewers.get(toPeerId);
  if (!target) return;
  if (seatOfPeer(room, toPeerId)) {
    send(conn, { type: "error", message: "Ye listener pehle se seat par hai." });
    return;
  }
  if (room.seats.size >= BROAD_MAX_SEATS) {
    send(conn, { type: "error", message: "Saari 6 seats full hain — pehle kisi ko drop karo." });
    return;
  }
  for (const inv of room.seatInvites.values()) {
    if (inv.toPeerId === toPeerId) {
      send(conn, { type: "error", message: "Is listener ko invite pehle se bheja hua hai." });
      return;
    }
  }
  const inviteId = crypto.randomBytes(8).toString("hex");
  const timer = setTimeout(() => {
    if (room.seatInvites.delete(inviteId)) {
      send(target, { type: "seat-invite-expired", liveSessionId: room.sessionId, inviteId });
      send(conn, { type: "seat-invite-cancelled", liveSessionId: room.sessionId, inviteId });
    }
  }, SEAT_REQUEST_TTL_MS);
  room.seatInvites.set(inviteId, { toPeerId, timer });
  send(target, {
    type: "seat-invited",
    liveSessionId: room.sessionId,
    inviteId,
    from: { peerId: conn.peerId, user: publicUser(conn.user) },
    expiresAt: Date.now() + SEAT_REQUEST_TTL_MS,
  });
  send(conn, { type: "seat-invite-sent", liveSessionId: room.sessionId, inviteId, toPeerId });
}

function handleSeatInviteRespond(conn, inviteId, accept) {
  if (!conn.sessionId || conn.role !== "viewer") return;
  const room = rooms.get(conn.sessionId);
  if (!room || room.kind !== "broad" || typeof inviteId !== "string") return;
  const inv = room.seatInvites.get(inviteId);
  if (!inv || inv.toPeerId !== conn.peerId) return;
  clearTimeout(inv.timer);
  room.seatInvites.delete(inviteId);
  if (!accept) {
    if (room.broadcaster) {
      send(room.broadcaster, { type: "seat-invite-declined", liveSessionId: room.sessionId, inviteId, by: { peerId: conn.peerId, user: publicUser(conn.user) } });
    }
    return;
  }
  if (seatOfPeer(room, conn.peerId)) return;
  if (!seatSpeaker(room, conn)) {
    send(conn, { type: "error", message: "Seats full ho gayi hain — seat nahi mil saki." });
    if (room.broadcaster) send(room.broadcaster, { type: "error", message: "Seats full ho gayi hain." });
  }
}

function handleSeatLeave(conn) {
  if (!conn.sessionId || conn.role !== "viewer") return;
  const room = rooms.get(conn.sessionId);
  if (!room || room.kind !== "broad") return;
  unseatSpeaker(room, conn.peerId, { removed: false });
}

function handleSeatDrop(conn, peerId) {
  if (!conn.sessionId || conn.role !== "broadcaster") return;
  const room = rooms.get(conn.sessionId);
  if (!room || room.kind !== "broad" || typeof peerId !== "string") return;
  unseatSpeaker(room, peerId, { removed: true });
}

// Self-mute: the host toggles the host seat; a seated speaker toggles
// their own seat. The new state is broadcast with the seats snapshot.
function handleSeatMute(conn, muted) {
  if (!conn.sessionId) return;
  const room = rooms.get(conn.sessionId);
  if (!room || room.kind !== "broad") return;
  if (conn.role === "broadcaster") {
    room.hostMuted = muted === true;
    broadcastSeats(room);
    return;
  }
  const found = seatOfPeer(room, conn.peerId);
  if (found) {
    found.entry.muted = muted === true;
    broadcastSeats(room);
  }
}

// Host authority: mute/unmute someone else's seat. The target's client
// gets a direct note so it actually silences its microphone track.
function handleSeatHostMute(conn, peerId, muted) {
  if (!conn.sessionId || conn.role !== "broadcaster") return;
  const room = rooms.get(conn.sessionId);
  if (!room || room.kind !== "broad" || typeof peerId !== "string") return;
  const found = seatOfPeer(room, peerId);
  if (!found) return;
  found.entry.muted = muted === true;
  const target = room.viewers.get(peerId);
  if (target) send(target, { type: "seat-host-muted", liveSessionId: room.sessionId, muted: found.entry.muted });
  broadcastSeats(room);
}

// Drops a departing viewer's pending seat requests/invites (and frees
// any seat they held — handled by the caller via unseatSpeaker).
function dropSeatPendingFrom(room, peerId) {
  for (const [requestId, req] of [...room.seatRequests.entries()]) {
    if (req.fromPeerId === peerId) {
      room.seatRequests.delete(requestId);
      clearTimeout(req.timer);
      if (room.broadcaster) send(room.broadcaster, { type: "seat-request-cancelled", liveSessionId: room.sessionId, requestId });
    }
  }
  for (const [inviteId, inv] of [...room.seatInvites.entries()]) {
    if (inv.toPeerId === peerId) {
      room.seatInvites.delete(inviteId);
      clearTimeout(inv.timer);
    }
  }
}

// Drops a departing viewer's pending guest requests (the broadcaster's
// request card must not outlive the requester).
function dropGuestRequestsFrom(room, peerId) {
  for (const [requestId, req] of [...room.guestRequests.entries()]) {
    if (req.fromPeerId === peerId) {
      room.guestRequests.delete(requestId);
      clearTimeout(req.timer);
      if (room.broadcaster) send(room.broadcaster, { type: "guest-request-expired", requestId });
    }
  }
}

function removeFromRoom(conn) {
  const sessionId = conn.sessionId;
  if (!sessionId) return;
  conn.sessionId = null;
  const room = rooms.get(sessionId);
  if (!room) return;
  if (conn.role === "broadcaster" && room.broadcaster === conn) {
    room.broadcaster = null;
    // Broadcaster gone => the live is over (handled by caller for DB +
    // broadcast); viewers are notified through endLiveSession.
    return;
  }
  if (room.viewers.get(conn.peerId) === conn) {
    room.viewers.delete(conn.peerId);
    // If the departing viewer held the guest seat, the seat ends with
    // them (no re-offer — they are gone); their pending requests die too.
    if (room.guest?.peerId === conn.peerId) {
      room.guest = null;
      room.guestWired = false;
      broadcastRoom(sessionId, { type: "guest-left", liveSessionId: sessionId, guestPeerId: conn.peerId, removed: false });
    }
    // Broad: a departing speaker's seat frees up and their pending
    // seat requests/invites die with them.
    if (room.kind === "broad") {
      if (seatOfPeer(room, conn.peerId)) {
        room.seats.delete(seatOfPeer(room, conn.peerId).seat);
        broadcastRoom(sessionId, { type: "seat-left", liveSessionId: sessionId, peerId: conn.peerId, removed: false });
        broadcastSeats(room);
      }
      dropSeatPendingFrom(room, conn.peerId);
    }
    dropGuestRequestsFrom(room, conn.peerId);
    if (room.broadcaster) send(room.broadcaster, { type: "viewer-left", peerId: conn.peerId });
    // In a match, the other broadcaster also holds a peer connection to
    // this viewer — tell it to drop the connection too.
    const matchId = matchBySession.get(sessionId);
    if (matchId) {
      const otherId = matchedSessionId(sessionId);
      const otherRoom = otherId ? rooms.get(otherId) : null;
      if (otherRoom?.broadcaster) send(otherRoom.broadcaster, { type: "viewer-left", peerId: conn.peerId, matchId });
    }
    broadcastViewerCount(sessionId);
  }
  if (!room.broadcaster && room.viewers.size === 0) rooms.delete(sessionId);
}

async function handleJoin(conn, sessionId) {
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    send(conn, { type: "error", message: "Invalid live session." });
    return;
  }
  const rows = await db.select().from(schema.liveSessions).where(eq(schema.liveSessions.id, sessionId)).limit(1);
  const session = rows[0];
  if (!session || session.endedAt) {
    send(conn, { type: "error", code: "live-ended", message: "This live has ended." });
    return;
  }
  // Leaving a previous room first (a broadcaster leaving ends that live).
  if (conn.sessionId && conn.sessionId !== sessionId) await leaveCurrentRoom(conn);

  const role = session.userId === conn.user.id ? "broadcaster" : "viewer";
  conn.sessionId = sessionId;
  conn.role = role;
  const room = roomFor(sessionId);
  room.kind = session.kind || "video";

  if (role === "broadcaster") {
    // A reconnecting broadcaster replaces the stale connection.
    if (room.broadcaster && room.broadcaster !== conn) {
      const stale = room.broadcaster;
      stale.sessionId = null;
      try {
        stale.ws.close();
      } catch {
        /* ignore */
      }
    }
    room.broadcaster = conn;
    send(conn, {
      type: "joined",
      liveSessionId: sessionId,
      role,
      kind: room.kind,
      viewerCount: room.viewers.size,
      likeCount: room.likes,
      broadcasterPeerId: conn.peerId,
      guestPeerId: room.guest?.peerId ?? null,
      guest: room.guest?.user ?? null,
      seats: room.kind === "broad" ? seatsSnapshot(room) : null,
    });
    // Introduce the broadcaster to viewers who were already waiting, and
    // tell the broadcaster about each of them so it can send its offers.
    // The seated guest is wired separately (full-duplex guest connection).
    for (const viewer of room.viewers.values()) {
      send(viewer, { type: "broadcaster-joined", peerId: conn.peerId });
      if (room.guest?.peerId !== viewer.peerId) {
        send(conn, { type: "viewer-joined", peerId: viewer.peerId, user: publicUser(viewer.user) });
      }
    }
    if (room.guest) {
      const guestConn = room.viewers.get(room.guest.peerId);
      if (guestConn) wireGuest(room, guestConn);
    }
    // Broad: a reconnecting host re-wires every seated speaker (their
    // seat state survived; the peer connections did not).
    if (room.kind === "broad") {
      for (const s of room.seats.values()) {
        const sc = room.viewers.get(s.peerId);
        if (sc) {
          s.wired = false;
          wireSeatSpeaker(room, sc);
        }
      }
      broadcastSeats(room);
    }
  } else {
    // A seat holder who reconnects arrives as a brand-new viewer with a
    // new peer id — the old seat cannot follow them, so it ends here.
    if (room.guest && room.guest.user.id === conn.user.id && room.guest.peerId !== conn.peerId) {
      const stalePeerId = room.guest.peerId;
      room.guest = null;
      room.guestWired = false;
      broadcastRoom(sessionId, { type: "guest-left", liveSessionId: sessionId, guestPeerId: stalePeerId, removed: false });
    }
    // Broad: same stale-seat rule for speakers — a reconnected speaker's
    // old seat (keyed by the dead peer id) is freed before they land.
    if (room.kind === "broad") {
      for (const s of [...room.seats.values()]) {
        if (s.user.id === conn.user.id && s.peerId !== conn.peerId) {
          unseatSpeaker(room, s.peerId, { removed: false });
        }
      }
    }
    room.viewers.set(conn.peerId, conn);
    send(conn, {
      type: "joined",
      liveSessionId: sessionId,
      role,
      kind: room.kind,
      viewerCount: room.viewers.size,
      likeCount: room.likes,
      broadcasterPeerId: room.broadcaster?.peerId ?? null,
      guestPeerId: room.guest?.peerId ?? null,
      guest: room.guest?.user ?? null,
      seats: room.kind === "broad" ? seatsSnapshot(room) : null,
    });
    if (room.broadcaster) {
      send(room.broadcaster, { type: "viewer-joined", peerId: conn.peerId, user: publicUser(conn.user) });
    }
    // Mid-seat joiner: the guest must publish to them as well.
    if (room.guest && room.guest.peerId !== conn.peerId) {
      const guestConn = room.viewers.get(room.guest.peerId);
      if (guestConn) send(guestConn, { type: "viewer-joined", peerId: conn.peerId, user: publicUser(conn.user), guestPublisher: true });
    }
    // Broad mid-joiner: every seated speaker must publish to them too
    // (they are a plain listener for now — seatPeer false).
    if (room.kind === "broad") {
      for (const s of room.seats.values()) {
        if (s.peerId === conn.peerId) continue;
        const sc = room.viewers.get(s.peerId);
        if (sc) send(sc, { type: "viewer-joined", peerId: conn.peerId, user: publicUser(conn.user), seatPublisher: true, seatPeer: false });
      }
    }
    broadcastViewerCount(sessionId);
    void notePeakViewers(sessionId, room.viewers.size);
  }

  // If this room is in a PK match, bring the joiner into the match too:
  // the full match state for their UI, plus — for a viewer — the
  // cross-room peer wiring (the other broadcaster will send them an offer).
  const matchId = matchBySession.get(sessionId);
  if (matchId) {
    const match = matches.get(matchId);
    if (match) {
      send(conn, matchPayload(match));
      if (role === "viewer") {
        const otherId = matchedSessionId(sessionId);
        const otherRoom = otherId ? rooms.get(otherId) : null;
        if (otherRoom?.broadcaster) {
          send(otherRoom.broadcaster, { type: "viewer-joined", peerId: conn.peerId, user: publicUser(conn.user), matchId });
          send(conn, { type: "broadcaster-joined", peerId: otherRoom.broadcaster.peerId, matchId, liveSessionId: otherId });
        }
      }
    }
  }
}

async function leaveCurrentRoom(conn) {
  const sessionId = conn.sessionId;
  const wasBroadcaster = conn.role === "broadcaster";
  removeFromRoom(conn);
  conn.role = null;
  if (wasBroadcaster && sessionId) {
    await endLiveSession(sessionId);
  }
}

export function attachLiveServer(httpServer, { authenticate }) {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (ws) => {
    const conn = {
      ws,
      peerId: crypto.randomBytes(8).toString("hex"),
      user: null,
      sessionId: null,
      role: null,
    };

    const authTimer = setTimeout(() => {
      if (!conn.user) {
        try {
          ws.close(4001, "Authentication required");
        } catch {
          /* ignore */
        }
      }
    }, AUTH_TIMEOUT_MS);

    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== "string") return;
      try {
        if (!conn.user) {
          if (msg.type !== "auth") {
            send(conn, { type: "auth-error", message: "Please sign in first." });
            return;
          }
          const user = await authenticate(typeof msg.token === "string" ? msg.token : "");
          if (!user) {
            send(conn, { type: "auth-error", message: "Please sign in." });
            try {
              ws.close(4001, "Authentication failed");
            } catch {
              /* ignore */
            }
            return;
          }
          conn.user = user;
          clearTimeout(authTimer);
          send(conn, { type: "auth-ok", peerId: conn.peerId, user: publicUser(user) });
          return;
        }

        switch (msg.type) {
          case "join":
            await handleJoin(conn, msg.liveSessionId);
            break;
          case "leave":
            await leaveCurrentRoom(conn);
            break;
          case "chat": {
            if (!conn.sessionId) return;
            const text = String(msg.text ?? "").trim().slice(0, MAX_CHAT_CHARS);
            if (!text) return;
            // Word/spam filter: a tripping message is rejected to the
            // sender only — it never reaches the room.
            if (findBannedContent(text)) {
              send(conn, { type: "error", message: "Message me aisi language ya link allowed nahi hai — message nahi bheja gaya." });
              return;
            }
            broadcastRoom(conn.sessionId, {
              type: "chat",
              liveSessionId: conn.sessionId,
              from: publicUser(conn.user),
              text,
              created_at: Date.now(),
            });
            break;
          }
          case "live-like": {
            // Tap-tap likes. Viewers only: the broadcaster's own socket
            // carries role "broadcaster" and is rejected here, so a host
            // can never inflate their own count (a seated guest is a
            // viewer-role conn and may like the host's stream). The
            // sender must actually be a joined viewer of this room.
            if (!conn.sessionId || conn.role !== "viewer") return;
            const room = rooms.get(conn.sessionId);
            if (!room || room.viewers.get(conn.peerId) !== conn) return;
            // Batch clamp + per-user rate limit (10 counted / second).
            let n = Number.isInteger(msg.n) ? msg.n : 1;
            n = Math.max(1, Math.min(MAX_LIKES_PER_SECOND, n));
            const now = Date.now();
            if (!conn.likeWindow || now - conn.likeWindow.start >= 1000) {
              conn.likeWindow = { start: now, count: 0 };
            }
            const allowed = Math.min(n, MAX_LIKES_PER_SECOND - conn.likeWindow.count);
            if (allowed <= 0) return;
            conn.likeWindow.count += allowed;
            room.likes += allowed;
            broadcastRoom(conn.sessionId, {
              type: "live-likes",
              liveSessionId: conn.sessionId,
              total: room.likes,
              n: allowed,
              fromPeerId: conn.peerId,
            });
            break;
          }
          case "signal": {
            if (!conn.sessionId || typeof msg.to !== "string") return;
            const findPeer = (sid) => {
              const r = rooms.get(sid);
              if (!r) return null;
              return r.broadcaster?.peerId === msg.to ? r.broadcaster : r.viewers.get(msg.to) ?? null;
            };
            let target = findPeer(conn.sessionId);
            if (!target) {
              // In a PK match, signaling also flows between the two rooms
              // (cross-viewing + the broadcaster pair connection).
              const otherId = matchedSessionId(conn.sessionId);
              if (otherId) target = findPeer(otherId);
            }
            if (target && target !== conn) {
              send(target, { type: "signal", from: conn.peerId, data: msg.data ?? null });
            }
            break;
          }
          case "match-invite":
            await handleMatchInvite(conn, msg.toLiveSessionId);
            break;
          case "match-respond":
            await handleMatchRespond(conn, msg.inviteId, msg.accept === true);
            break;
          case "guest-request":
            await handleGuestRequest(conn);
            break;
          case "guest-respond":
            handleGuestRespond(conn, msg.requestId, msg.accept === true);
            break;
          case "guest-ready":
            handleGuestReady(conn);
            break;
          case "guest-leave":
          case "guest-abort":
            handleGuestLeave(conn);
            break;
          case "guest-remove":
            handleGuestRemove(conn);
            break;
          case "seat-request":
            await handleSeatRequest(conn);
            break;
          case "seat-respond":
            handleSeatRespond(conn, msg.requestId, msg.accept === true);
            break;
          case "seat-ready":
            handleSeatReady(conn);
            break;
          case "seat-invite":
            handleSeatInvite(conn, msg.toPeerId);
            break;
          case "seat-invite-respond":
            handleSeatInviteRespond(conn, msg.inviteId, msg.accept === true);
            break;
          case "seat-leave":
            handleSeatLeave(conn);
            break;
          case "seat-drop":
            handleSeatDrop(conn, msg.peerId);
            break;
          case "seat-mute":
            handleSeatMute(conn, msg.muted === true);
            break;
          case "seat-host-mute":
            handleSeatHostMute(conn, msg.peerId, msg.muted === true);
            break;
          default:
            break;
        }
      } catch (err) {
        console.error("[live] message handling failed:", err?.message || err);
      }
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      // Fire and forget: a departing broadcaster ends the live.
      void leaveCurrentRoom(conn);
    });
    ws.on("error", () => {
      /* the close handler does the cleanup */
    });
  });

  console.log("[live] WebSocket hub attached at /ws");
  return wss;
}
