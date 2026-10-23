// Headless tests for Zoomly LIVE PK matches: invite/accept/decline over
// WebSocket, cross-room wiring, gift scoring, timer end + winner, ties,
// match end when a live ends, and DB persistence (live_matches).
//
// Needs a server booted with a SHORT match duration so the timer path is
// testable:
//   PORT=3105 ADMIN_USERNAME=sajeel MATCH_DURATION_SECONDS=5 \
//     TURSO_DATABASE_URL=file:/tmp/zoomly-match.db npm start
//   BASE_URL=http://localhost:3105 ADMIN_USERNAME=sajeel \
//     TEST_DB_URL=file:/tmp/zoomly-match.db node scripts/match-test.mjs
import { createClient } from "@libsql/client";
import { WebSocket } from "ws";

const BASE = process.env.BASE_URL || "http://localhost:3105";
const ADMIN = (process.env.ADMIN_USERNAME || "sajeel").toLowerCase();
const DB_URL = process.env.TEST_DB_URL || "file:/tmp/zoomly-match.db";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(action, args = {}) {
  const res = await fetch(`${BASE}/api/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  return res.json();
}

const db = createClient({ url: DB_URL });
async function dbAll(sql, args = []) {
  const res = await db.execute({ sql, args });
  return res.rows;
}
async function dbOne(sql, args = []) {
  const rows = await dbAll(sql, args);
  return rows[0] ?? null;
}

function connectSocket(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE.replace(/^http/, "ws") + "/ws");
    const client = {
      ws,
      peerId: null,
      messages: [],
      waiters: [],
      send(obj) {
        ws.send(JSON.stringify(obj));
      },
      ofType(type) {
        return client.messages.filter((m) => m.type === type);
      },
      waitFor(pred, timeoutMs = 9000, label = "message") {
        const found = client.messages.find(pred);
        if (found) return Promise.resolve(found);
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error(`Timed out waiting for ${label}`)), timeoutMs);
          client.waiters.push({
            pred,
            resolve: (m) => {
              clearTimeout(timer);
              res(m);
            },
          });
        });
      },
      close() {
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      },
    };
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      client.messages.push(msg);
      client.waiters = client.waiters.filter((w) => {
        if (w.pred(msg)) {
          w.resolve(msg);
          return false;
        }
        return true;
      });
      if (msg.type === "auth-ok") {
        client.peerId = msg.peerId;
        resolve(client);
      }
      if (msg.type === "auth-error") reject(new Error(`WS auth failed: ${msg.message}`));
    });
    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token })));
    ws.on("error", reject);
    setTimeout(() => reject(new Error("WS connect/auth timed out")), 10000);
  });
}

async function fundUser(token, packIndex = 3) {
  const tid = `MATCHTID${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const req = await api("requestCoins", { token, pack_index: packIndex, tid });
  if (!req.ok) throw new Error(`fund request failed: ${JSON.stringify(req)}`);
  const pending = await api("getAdminCoinRequests", { token: adminToken });
  const row = pending.requests?.find((r) => r.tid === tid);
  const review = await api("reviewCoinRequest", { token: adminToken, request_id: row.id, decision: "approved" });
  if (!review.ok) throw new Error(`fund approve failed: ${JSON.stringify(review)}`);
}

// ---- setup ---------------------------------------------------------------------

console.log(`Match test against ${BASE} (admin=${ADMIN}, short match duration expected)`);
const suffix = Math.random().toString(36).slice(2, 8);

let admin = await api("signup", { username: ADMIN, display_name: "Owner", password: "test-pass-123" });
if (!admin.ok) admin = await api("login", { username: ADMIN, password: "test-pass-123" });
check("admin signup/login", admin.ok === true);
const adminToken = admin.token;

async function makeUser(name, display) {
  const u = await api("signup", { username: name, display_name: display, password: "test-pass-123" });
  if (!u.ok) throw new Error(`signup ${name} failed: ${JSON.stringify(u)}`);
  return u;
}
const userA = await makeUser(`pk_a_${suffix}`, "PK Host A");
const userB = await makeUser(`pk_b_${suffix}`, "PK Host B");
const userC = await makeUser(`pk_c_${suffix}`, "Solo Host C");
const fanA = await makeUser(`pk_fana_${suffix}`, "Fan A");
const fanB = await makeUser(`pk_fanb_${suffix}`, "Fan B");
await fundUser(fanA.token);
await fundUser(fanB.token);
check("fans funded", (await api("getMe", { token: fanA.token })).user.coin_balance >= 6000);

const liveA = await api("startLive", { token: userA.token, title: "A ki live" });
const liveB = await api("startLive", { token: userB.token, title: "B ki live" });
const liveC = await api("startLive", { token: userC.token, title: "C solo live" });
const sidA = liveA.session.id;
const sidB = liveB.session.id;
const sidC = liveC.session.id;
check("three lives started", Boolean(sidA && sidB && sidC));

const sockA = await connectSocket(userA.token);
const sockB = await connectSocket(userB.token);
const sockVA = await connectSocket(fanA.token);
const sockVB = await connectSocket(fanB.token);
sockA.send({ type: "join", liveSessionId: sidA });
sockB.send({ type: "join", liveSessionId: sidB });
sockVA.send({ type: "join", liveSessionId: sidA });
sockVB.send({ type: "join", liveSessionId: sidB });
await sockA.waitFor((m) => m.type === "joined", 9000, "A joined");
await sockB.waitFor((m) => m.type === "joined", 9000, "B joined");
await sockVA.waitFor((m) => m.type === "joined", 9000, "fanA joined");
await sockVB.waitFor((m) => m.type === "joined", 9000, "fanB joined");
check("all four sockets in their rooms", true);

// A viewer must not be able to send a match invite.
sockVA.send({ type: "match-invite", toLiveSessionId: sidB });
const viewerInviteErr = await sockVA.waitFor((m) => m.type === "error", 9000, "viewer invite error");
check("viewer invite rejected with error", Boolean(viewerInviteErr?.message));

// Cross-room signaling must NOT work before a match: fanA -> B's socket.
sockB.messages.length = 0;
sockVA.send({ type: "signal", to: sockB.peerId, data: { kind: "offer", description: { type: "offer", sdp: "pre-match" } } });
await sleep(700);
check("no cross-room signal before match", sockB.ofType("signal").length === 0, JSON.stringify(sockB.messages).slice(0, 200));

// ---- decline flow -----------------------------------------------------------------

sockA.send({ type: "match-invite", toLiveSessionId: sidB });
const invite1 = await sockB.waitFor((m) => m.type === "match-invite", 9000, "invite at B");
check("B received the invite", invite1.from?.liveSessionId === sidA && invite1.from?.user?.username === userA.user.username, JSON.stringify(invite1).slice(0, 220));
sockB.send({ type: "match-respond", inviteId: invite1.inviteId, accept: false });
const declined = await sockA.waitFor((m) => m.type === "match-declined", 9000, "declined at A");
check("A told about the decline", declined.by?.username === userB.user.username);
const rowsAfterDecline = await dbAll("SELECT * FROM live_matches");
check("decline creates no match row", rowsAfterDecline.length === 0, `rows=${rowsAfterDecline.length}`);

// ---- accept flow + wiring -----------------------------------------------------------

sockA.send({ type: "match-invite", toLiveSessionId: sidB });
const invite2 = await sockB.waitFor((m) => m.type === "match-invite" && m.inviteId !== invite1.inviteId, 9000, "second invite at B");
sockB.send({ type: "match-respond", inviteId: invite2.inviteId, accept: true });

const startedAtA = await sockA.waitFor((m) => m.type === "match-started", 9000, "match-started at A");
const startedAtVB = await sockVB.waitFor((m) => m.type === "match-started", 9000, "match-started at fanB");
check(
  "match-started in both rooms (inviter is side A)",
  startedAtA.liveSessionA === sidA && startedAtA.liveSessionB === sidB && startedAtA.scoreA === 0 && startedAtA.scoreB === 0 && startedAtA.endsAt > Date.now(),
  JSON.stringify(startedAtA).slice(0, 260)
);
check("audience of B also got match-started", startedAtVB.matchId === startedAtA.matchId);
const matchId = startedAtA.matchId;

const peerAtA = await sockA.waitFor((m) => m.type === "match-peer", 9000, "match-peer at A");
const peerAtB = await sockB.waitFor((m) => m.type === "match-peer", 9000, "match-peer at B");
check("broadcaster pair wiring (A initiates)", peerAtA.peerId === sockB.peerId && peerAtA.initiate === true && peerAtB.peerId === sockA.peerId && peerAtB.initiate === false, JSON.stringify({ peerAtA, peerAtB }).slice(0, 240));

const crossJoinAtA = await sockA.waitFor((m) => m.type === "viewer-joined" && Boolean(m.matchId), 9000, "cross viewer-joined at A");
check("A told about B's viewer (cross-wiring)", crossJoinAtA.peerId === sockVB.peerId, JSON.stringify(crossJoinAtA).slice(0, 200));
const crossJoinAtVA = await sockVA.waitFor((m) => m.type === "broadcaster-joined" && Boolean(m.matchId), 9000, "cross broadcaster-joined at fanA");
check("fanA told about B's broadcaster peer", crossJoinAtVA.peerId === sockB.peerId && crossJoinAtVA.liveSessionId === sidB);

const matchRow = await dbOne("SELECT * FROM live_matches WHERE id = ?", [matchId]);
check(
  "match row persisted (running)",
  matchRow && matchRow.live_session_a === sidA && matchRow.live_session_b === sidB && matchRow.user_a === userA.user.id && matchRow.user_b === userB.user.id && matchRow.ended_at === null && matchRow.winner_user_id === null,
  JSON.stringify(matchRow)
);

// Cross-room signal now flows: fanA -> B broadcaster.
sockVA.send({ type: "signal", to: sockB.peerId, data: { kind: "offer", description: { type: "offer", sdp: "cross-offer" } } });
const crossSignal = await sockB.waitFor((m) => m.type === "signal" && m.data?.description?.sdp === "cross-offer", 9000, "cross-room signal");
check("cross-room signal delivered during match", crossSignal.from === sockVA.peerId);

// ---- scoring ------------------------------------------------------------------------

const giftA = await api("sendGift", { token: fanA.token, live_session_id: sidA, gift_key: "giftbox" }); // 100 to A
check("gift to A during match ok", giftA.ok === true, JSON.stringify(giftA).slice(0, 160));
const score1 = await sockB.waitFor((m) => m.type === "match-score", 9000, "match-score at B room");
check("score after A gift: 100 – 0", score1.scoreA === 100 && score1.scoreB === 0, JSON.stringify(score1));

const giftB = await api("sendGift", { token: fanB.token, live_session_id: sidB, gift_key: "chocolate" }); // 25 to B
check("gift to B during match ok", giftB.ok === true);
const score2 = await sockA.waitFor((m) => m.type === "match-score" && m.scoreB === 25, 9000, "match-score 100-25 at A");
check("score after B gift: 100 – 25", score2.scoreA === 100 && score2.scoreB === 25, JSON.stringify(score2));

// A gift to C (live but NOT in the match) must not score.
const scoresBefore = sockA.ofType("match-score").length;
const giftC = await api("sendGift", { token: fanA.token, live_session_id: sidC, gift_key: "rose" });
check("gift to solo C ok", giftC.ok === true);
await sleep(800);
check("gift outside the match does not score", sockA.ofType("match-score").length === scoresBefore);

const midRow = await dbOne("SELECT score_a, score_b FROM live_matches WHERE id = ?", [matchId]);
check("running scores mirrored to DB (100 / 25)", midRow?.score_a === 100 && midRow?.score_b === 25, JSON.stringify(midRow));

// The 70/30 balance split still applies during a match: A got +70 of the 100.
const aBalance = (await api("getMe", { token: userA.token })).user.coin_balance;
check("broadcaster balance still uses 70/30 split (+70)", aBalance === 70, `bal=${aBalance}`);

// ---- timer end + winner --------------------------------------------------------------

const ended1 = await sockB.waitFor((m) => m.type === "match-ended", 15000, "match-ended (timer)");
check("timer ended the match", ended1.matchId === matchId && ended1.reason === "time", JSON.stringify(ended1).slice(0, 240));
check("winner is A (100 > 25)", ended1.winnerUserId === userA.user.id && ended1.draw === false && ended1.scoreA === 100 && ended1.scoreB === 25, JSON.stringify(ended1).slice(0, 240));
const finalRow1 = await dbOne("SELECT * FROM live_matches WHERE id = ?", [matchId]);
check(
  "final row persisted (scores, winner, ended_at)",
  finalRow1 && finalRow1.score_a === 100 && finalRow1.score_b === 25 && finalRow1.winner_user_id === userA.user.id && finalRow1.ended_at !== null,
  JSON.stringify(finalRow1)
);

// A gift after the match ended must not score anywhere.
const scoresAfterEnd = sockA.ofType("match-score").length;
await api("sendGift", { token: fanA.token, live_session_id: sidA, gift_key: "rose" });
await sleep(700);
check("gift after match end does not score", sockA.ofType("match-score").length === scoresAfterEnd);

// ---- tie match ------------------------------------------------------------------------

sockA.send({ type: "match-invite", toLiveSessionId: sidB });
const invite3 = await sockB.waitFor((m) => m.type === "match-invite" && m.inviteId !== invite2.inviteId && m.inviteId !== invite1.inviteId, 9000, "third invite");
sockB.send({ type: "match-respond", inviteId: invite3.inviteId, accept: true });
const started2 = await sockA.waitFor((m) => m.type === "match-started" && m.matchId !== matchId, 9000, "second match-started");
check("second match started", Boolean(started2.matchId));
await api("sendGift", { token: fanA.token, live_session_id: sidA, gift_key: "heart" }); // 50
await api("sendGift", { token: fanB.token, live_session_id: sidB, gift_key: "heart" }); // 50
const ended2 = await sockA.waitFor((m) => m.type === "match-ended" && m.matchId === started2.matchId, 15000, "second match-ended");
check("tied match is a draw", ended2.draw === true && ended2.winnerUserId === null && ended2.scoreA === 50 && ended2.scoreB === 50, JSON.stringify(ended2).slice(0, 220));
const finalRow2 = await dbOne("SELECT * FROM live_matches WHERE id = ?", [started2.matchId]);
check("draw persisted with null winner", finalRow2 && finalRow2.winner_user_id === null && finalRow2.ended_at !== null && finalRow2.score_a === 50 && finalRow2.score_b === 50, JSON.stringify(finalRow2));

// ---- match ends when a live ends --------------------------------------------------------

sockA.send({ type: "match-invite", toLiveSessionId: sidB });
const invite4 = await sockB.waitFor((m) => m.type === "match-invite" && ![invite1.inviteId, invite2.inviteId, invite3.inviteId].includes(m.inviteId), 9000, "fourth invite");
sockB.send({ type: "match-respond", inviteId: invite4.inviteId, accept: true });
const started3 = await sockVB.waitFor((m) => m.type === "match-started" && m.matchId !== matchId && m.matchId !== started2.matchId, 9000, "third match-started");
check("third match started", Boolean(started3.matchId));
await api("sendGift", { token: fanB.token, live_session_id: sidB, gift_key: "giftbox" }); // B leads 100-0
const endRes = await api("endLive", { token: userA.token, live_session_id: sidA });
check("A ends its live mid-match", endRes.ok === true, JSON.stringify(endRes).slice(0, 160));
const ended3 = await sockVB.waitFor((m) => m.type === "match-ended" && m.matchId === started3.matchId, 9000, "match-ended via live end");
check("match ended for B's room when A's live ended", ended3.reason === "live-ended" && ended3.winnerUserId === userB.user.id, JSON.stringify(ended3).slice(0, 240));
const finalRow3 = await dbOne("SELECT * FROM live_matches WHERE id = ?", [started3.matchId]);
check("live-ended match persisted (B wins 0–100)", finalRow3 && finalRow3.ended_at !== null && finalRow3.winner_user_id === userB.user.id && finalRow3.score_b === 100, JSON.stringify(finalRow3));
const listAfter = await api("listLive", { token: fanB.token });
check("B is still live after the match ended", listAfter.lives?.some((l) => l.id === sidB) === true && !listAfter.lives?.some((l) => l.id === sidA));

// Cleanup
await api("endLive", { token: userB.token, live_session_id: sidB });
await api("endLive", { token: userC.token, live_session_id: sidC });
for (const s of [sockA, sockB, sockVA, sockVB]) s.close();

console.log(failures === 0 ? "\nMATCH TEST PASSED ✔" : `\nMATCH TEST FAILED — ${failures} check(s) failed ✗`);
process.exit(failures === 0 ? 0 : 1);
