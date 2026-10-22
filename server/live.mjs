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
//   C->S  {type:"signal", to, data}   S->C {type:"signal", from, data}
//   S->C  {type:"gift", ...}    (broadcast by the sendGift RPC action)
//   S->C  {type:"live-ended", liveSessionId}
//   C->S  {type:"leave"}
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
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "./db.mjs";
import * as schema from "./schema.mjs";
import { MATCH_DURATION_MS, MATCH_INVITE_TTL_MS } from "./config.mjs";

const AUTH_TIMEOUT_MS = 10_000;
const MAX_CHAT_CHARS = 500;

const rooms = new Map(); // sessionId -> { broadcaster, viewers: Map }

function roomFor(sessionId) {
  let room = rooms.get(sessionId);
  if (!room) {
    room = { broadcaster: null, viewers: new Map() };
    rooms.set(sessionId, room);
  }
  return room;
}

function publicUser(user) {
  return { id: user.id, username: user.username, display_name: user.displayName, avatar_url: user.avatarUrl ?? null };
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
  const targetRoom = rooms.get(toLiveSessionId);
  if (!targetRoom?.broadcaster) {
    send(conn, { type: "error", message: "Woh broadcaster ab live nahi hai." });
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
  await startMatch(invite.fromSessionId, invite.toSessionId);
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
      viewerCount: room.viewers.size,
      broadcasterPeerId: conn.peerId,
    });
    // Introduce the broadcaster to viewers who were already waiting, and
    // tell the broadcaster about each of them so it can send its offers.
    for (const viewer of room.viewers.values()) {
      send(viewer, { type: "broadcaster-joined", peerId: conn.peerId });
      send(conn, { type: "viewer-joined", peerId: viewer.peerId, user: publicUser(viewer.user) });
    }
  } else {
    room.viewers.set(conn.peerId, conn);
    send(conn, {
      type: "joined",
      liveSessionId: sessionId,
      role,
      viewerCount: room.viewers.size,
      broadcasterPeerId: room.broadcaster?.peerId ?? null,
    });
    if (room.broadcaster) {
      send(room.broadcaster, { type: "viewer-joined", peerId: conn.peerId, user: publicUser(conn.user) });
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
            broadcastRoom(conn.sessionId, {
              type: "chat",
              liveSessionId: conn.sessionId,
              from: publicUser(conn.user),
              text,
              created_at: Date.now(),
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
