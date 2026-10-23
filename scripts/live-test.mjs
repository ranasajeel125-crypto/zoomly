// End-to-end tests for Zoomly LIVE: broadcasts, WebRTC signaling relay,
// live chat, viewer counts, and coin gifts with the 70/30 split.
//
// Boots against an already-running server (BASE_URL) whose database the
// test can also read directly (TEST_DB_URL, a libsql file: URL) to verify
// gift_events rows and live_sessions totals.
//
//   PORT=3104 ADMIN_USERNAME=sajeel TURSO_DATABASE_URL=file:/tmp/zoomly-live.db \
//     npm start
//   BASE_URL=http://localhost:3104 ADMIN_USERNAME=sajeel \
//     TEST_DB_URL=file:/tmp/zoomly-live.db node scripts/live-test.mjs
//
// Also renders the built client in jsdom and opens the Live tab while a
// broadcast is running (needs `npm run build` first).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { WebSocket } from "ws";
import { JSDOM } from "jsdom";

const BASE = process.env.BASE_URL || "http://localhost:3104";
const ADMIN = (process.env.ADMIN_USERNAME || "sajeel").toLowerCase();
const DB_URL = process.env.TEST_DB_URL || "file:/tmp/zoomly-live.db";
const DIST_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "client", "dist");

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
async function dbOne(sql, args = []) {
  const res = await db.execute({ sql, args });
  return res.rows[0] ?? null;
}

// ---- tiny WS client ----------------------------------------------------------

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
      waitFor(pred, timeoutMs = 8000, label = "message") {
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

// ---- setup: users + funding ---------------------------------------------------

console.log(`Live test against ${BASE} (admin=${ADMIN})`);
const suffix = Math.random().toString(36).slice(2, 8);

let admin = await api("signup", { username: ADMIN, display_name: "Owner", password: "test-pass-123" });
if (!admin.ok) admin = await api("login", { username: ADMIN, password: "test-pass-123" });
check("admin signup/login", admin.ok === true, JSON.stringify(admin).slice(0, 160));
const adminToken = admin.token;

const creatorName = `host_${suffix}`;
const creator = await api("signup", { username: creatorName, display_name: "Live Host", password: "test-pass-123" });
check("creator signup", creator.ok === true);
const creatorToken = creator.token;
const creatorId = creator.user.id;

const viewerName = `fan_${suffix}`;
const viewer = await api("signup", { username: viewerName, display_name: "Live Fan", password: "test-pass-123", referral_code: creator.user.referral_code });
check("viewer signup (with referral)", viewer.ok === true);
const viewerToken = viewer.token;
const viewerId = viewer.user.id;
check("viewer starts with 0 coins (referrals mint no free coins)", viewer.user.coin_balance === 0, `bal=${viewer.user.coin_balance}`);

// Fund the viewer properly: coin request for pack 3 (6000 coins) + admin approve.
const tid = `LIVETID${Date.now()}`;
const req = await api("requestCoins", { token: viewerToken, pack_index: 3, tid });
check("viewer coin request created", req.ok === true, JSON.stringify(req));
const pending = await api("getAdminCoinRequests", { token: adminToken });
const myReq = pending.requests?.find((r) => r.tid === tid);
check("admin sees the request", Boolean(myReq));
const review = await api("reviewCoinRequest", { token: adminToken, request_id: myReq.id, decision: "approved" });
check("admin approves", review.ok === true);
const viewerFunded = (await api("getMe", { token: viewerToken })).user;
check("viewer funded to 6000", viewerFunded.coin_balance === 6000, `bal=${viewerFunded.coin_balance}`);

// ---- startLive / listLive / getLive --------------------------------------------

const started = await api("startLive", { token: creatorToken, title: "Live test show 🎤" });
check("startLive ok", started.ok === true && Boolean(started.session?.id), JSON.stringify(started).slice(0, 200));
const sid = started.session.id;
check("session is_live with 0 viewers", started.session.is_live === true && started.session.viewer_count === 0);

const list = await api("listLive", { token: viewerToken });
const listed = list.lives?.find((l) => l.id === sid);
check("listLive contains the session", Boolean(listed));
check("listLive shows broadcaster + title", listed?.broadcaster?.username === creatorName && listed?.title === "Live test show 🎤", JSON.stringify(listed).slice(0, 200));

const detail = await api("getLive", { token: viewerToken, live_session_id: sid });
check("getLive ok", detail.ok === true, JSON.stringify(detail).slice(0, 200));
check("getLive catalog has 8 gifts", Array.isArray(detail.gifts) && detail.gifts.length === 8);
check(
  "catalog shape (key/name/emoji strings, coins number)",
  detail.gifts.every((g) => typeof g.key === "string" && typeof g.name === "string" && typeof g.emoji === "string" && typeof g.coins === "number")
);
const byKey = Object.fromEntries(detail.gifts.map((g) => [g.key, g.coins]));
check(
  "catalog prices exact",
  byKey.rose === 10 && byKey.chocolate === 25 && byKey.heart === 50 && byKey.giftbox === 100 && byKey.crown === 250 && byKey.rocket === 500 && byKey.diamond === 1000 && byKey.lion === 2500,
  JSON.stringify(byKey)
);
check("getLive reports my balance", detail.my_coin_balance === 6000, `bal=${detail.my_coin_balance}`);

// ---- TURN / ICE configuration ------------------------------------------------
// The fix for live video on carrier-grade NAT (mobile data): the server
// hands every client its ICE list (STUN + TURN relays) via startLive /
// getLive, and the client adopts it, preferring direct connections and
// retrying failed peers once through TURN (iceTransportPolicy "relay").
// (The headless tests cannot exercise a real TURN media path from here,
// so these are config/shape checks on the real payloads + client source.)
const iceList = started.ice_servers;
check("startLive returns ice_servers", Array.isArray(iceList) && iceList.length >= 5, JSON.stringify(started).slice(0, 200));
const turnEntries = (iceList ?? []).filter((s) => String(s.urls).startsWith("turn"));
check(
  "ice_servers include TURN relays with credentials",
  turnEntries.length >= 3 && turnEntries.every((s) => typeof s.username === "string" && s.username.length > 0 && typeof s.credential === "string" && s.credential.length > 0),
  JSON.stringify(iceList)
);
check("ice_servers include the Open Relay TURN host", turnEntries.some((s) => String(s.urls).includes("openrelay.metered.ca")));
check("ice_servers keep Google STUN", (iceList ?? []).some((s) => String(s.urls).includes("stun.l.google.com")));
check("getLive returns the same ICE list", JSON.stringify(detail.ice_servers) === JSON.stringify(iceList));
const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "client", "src");
const liveJsSrc = fs.readFileSync(path.join(SRC_DIR, "live.js"), "utf8");
const liveJsxSrc = fs.readFileSync(path.join(SRC_DIR, "Live.jsx"), "utf8");
check("client adopts the server ICE list", liveJsSrc.includes("setIceServers") && liveJsxSrc.includes("setIceServers(res.ice_servers)"));
check("client fallback list carries TURN", liveJsSrc.includes("openrelay.metered.ca") && liveJsSrc.includes("FALLBACK_ICE_SERVERS"));
check(
  "client retries failed peers via relay + renegotiate",
  liveJsSrc.includes("iceTransportPolicy") && liveJsSrc.includes('"relay"') && liveJsxSrc.includes("renegotiate") && liveJsxSrc.includes("onPeerIceFailed")
);
check("client logs the selected candidate pair type", liveJsSrc.includes("logSelectedCandidatePair") && liveJsxSrc.includes("logSelectedCandidatePair"));

// ---- Sound: ON by default everywhere -------------------------------------------
// The owner's rule: videos are never muted by default — muting is the
// viewer's own persisted choice. Browsers can force a muted autoplay,
// and the players must then show a tappable "🔊 Sound on" overlay.
const appJsxSrc = fs.readFileSync(path.join(SRC_DIR, "App.jsx"), "utf8");
const soundJsSrc = fs.readFileSync(path.join(SRC_DIR, "sound.js"), "utf8");
check("sound preference persists via localStorage", soundJsSrc.includes("zoomly_muted") && soundJsSrc.includes("viewerMuted") && soundJsSrc.includes("setViewerMuted"));
check(
  "feed player starts from the preference, no hard-coded mute",
  appJsxSrc.includes("useState(() => viewerMuted())") && !appJsxSrc.includes("const [muted, setMuted] = useState(true)") && appJsxSrc.includes("setViewerMuted")
);
check("live watch starts from the preference too", liveJsxSrc.includes("useState(() => viewerMuted())") && liveJsxSrc.includes("setViewerMuted"));
check("forced-muted autoplay shows a Sound on overlay (feed + live)", appJsxSrc.includes("Sound on") && appJsxSrc.includes("forcedMute") && liveJsxSrc.includes("Sound on") && liveJsxSrc.includes("forcedMute"));

// ---- WebSocket: join, presence, signaling relay, chat ---------------------------

const hostSock = await connectSocket(creatorToken);
check("broadcaster socket authed", Boolean(hostSock.peerId));
hostSock.send({ type: "join", liveSessionId: sid });
const hostJoined = await hostSock.waitFor((m) => m.type === "joined", 8000, "broadcaster joined");
check("broadcaster joined as broadcaster", hostJoined.role === "broadcaster" && hostJoined.viewerCount === 0, JSON.stringify(hostJoined));

const fanSock = await connectSocket(viewerToken);
check("viewer socket authed", Boolean(fanSock.peerId));
fanSock.send({ type: "join", liveSessionId: sid });
const fanJoined = await fanSock.waitFor((m) => m.type === "joined", 8000, "viewer joined");
check("viewer joined as viewer, count 1", fanJoined.role === "viewer" && fanJoined.viewerCount === 1, JSON.stringify(fanJoined));
check("viewer told the broadcaster peer id", fanJoined.broadcasterPeerId === hostSock.peerId);

const viewerJoinedMsg = await hostSock.waitFor((m) => m.type === "viewer-joined", 8000, "viewer-joined at broadcaster");
check("broadcaster notified of viewer", viewerJoinedMsg.peerId === fanSock.peerId && viewerJoinedMsg.user?.username === viewerName, JSON.stringify(viewerJoinedMsg));
const countMsg = await hostSock.waitFor((m) => m.type === "viewer-count" && m.count === 1, 8000, "viewer-count=1");
check("viewer-count broadcast (1)", Boolean(countMsg));

// Signaling relay: viewer -> broadcaster "offer", broadcaster -> viewer "answer".
fanSock.send({ type: "signal", to: hostSock.peerId, data: { kind: "offer", description: { type: "offer", sdp: "fake-sdp-offer" } } });
const offerAtHost = await hostSock.waitFor((m) => m.type === "signal" && m.data?.kind === "offer", 8000, "offer relayed to broadcaster");
check("offer relayed viewer→broadcaster", offerAtHost.from === fanSock.peerId && offerAtHost.data.description.sdp === "fake-sdp-offer", JSON.stringify(offerAtHost));
hostSock.send({ type: "signal", to: fanSock.peerId, data: { kind: "answer", description: { type: "answer", sdp: "fake-sdp-answer" } } });
const answerAtFan = await fanSock.waitFor((m) => m.type === "signal" && m.data?.kind === "answer", 8000, "answer relayed to viewer");
check("answer relayed broadcaster→viewer", answerAtFan.from === hostSock.peerId && answerAtFan.data.description.sdp === "fake-sdp-answer");
fanSock.send({ type: "signal", to: hostSock.peerId, data: { kind: "ice", candidate: { candidate: "candidate:1 1 udp 1 127.0.0.1 9 typ host", sdpMid: "0", sdpMLineIndex: 0 } } });
const iceAtHost = await hostSock.waitFor((m) => m.type === "signal" && m.data?.kind === "ice", 8000, "ice relayed");
check("ICE candidate relayed", iceAtHost.from === fanSock.peerId);

// Chat relay both ways.
fanSock.send({ type: "chat", text: "Assalamualaikum host!" });
const chatAtHost = await hostSock.waitFor((m) => m.type === "chat", 8000, "chat at broadcaster");
check("chat viewer→room", chatAtHost.text === "Assalamualaikum host!" && chatAtHost.from?.username === viewerName, JSON.stringify(chatAtHost));
hostSock.send({ type: "chat", text: "Walaikum assalam, welcome!" });
const chatAtFan = await fanSock.waitFor((m) => m.type === "chat" && m.from?.username === creatorName, 8000, "chat at viewer");
check("chat broadcaster→room", chatAtFan.text === "Walaikum assalam, welcome!");

// Peak viewers persisted.
await sleep(400);
const peakRow = await dbOne("SELECT peak_viewers FROM live_sessions WHERE id = ?", [sid]);
check("peak_viewers recorded (1)", peakRow?.peak_viewers === 1, JSON.stringify(peakRow));

// An unauthenticated socket must be rejected.
let unauthRejected = false;
try {
  const bad = new WebSocket(BASE.replace(/^http/, "ws") + "/ws");
  await new Promise((resolve) => {
    bad.on("open", () => bad.send(JSON.stringify({ type: "auth", token: "not-a-real-token" })));
    bad.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === "auth-error") {
        unauthRejected = true;
        resolve();
      }
    });
    bad.on("close", () => resolve());
    setTimeout(resolve, 5000);
  });
  bad.close();
} catch {
  /* rejection is the point */
}
check("unauthenticated socket rejected", unauthRejected);

// ---- Gifts: the 70/30 split (broadcaster 70% / platform 30%) -------------------------

const creatorBefore = (await api("getMe", { token: creatorToken })).user.coin_balance;
const gift100 = await api("sendGift", { token: viewerToken, live_session_id: sid, gift_key: "giftbox" });
check("giftbox (100) sent", gift100.ok === true, JSON.stringify(gift100).slice(0, 200));
check("giftbox split reported 70/30", gift100.creator_share === 70 && gift100.platform_share === 30);
check("sender balance reported 5900", gift100.my_balance === 5900, `bal=${gift100.my_balance}`);
const creatorAfter100 = (await api("getMe", { token: creatorToken })).user.coin_balance;
check("broadcaster credited +70", creatorAfter100 === creatorBefore + 70, `before=${creatorBefore} after=${creatorAfter100}`);

const giftWs = await fanSock.waitFor((m) => m.type === "gift" && m.gift?.key === "giftbox", 8000, "gift broadcast");
check("gift broadcast over WS (viewer side)", giftWs.gift.coins === 100 && giftWs.gift.creator_share === 70 && giftWs.from?.username === viewerName, JSON.stringify(giftWs).slice(0, 220));
const giftWsHost = await hostSock.waitFor((m) => m.type === "gift" && m.gift?.key === "giftbox", 8000, "gift broadcast at host");
check("gift broadcast over WS (broadcaster side)", giftWsHost.gift.emoji === "🎁");

const ev100 = await dbOne("SELECT * FROM gift_events WHERE live_session_id = ? AND gift_key = 'giftbox'", [sid]);
check(
  "gift_events row: 100 = 70 creator + 30 platform",
  ev100 && ev100.coins === 100 && ev100.creator_share === 70 && ev100.platform_share === 30 && ev100.sender_id === viewerId && ev100.creator_id === creatorId,
  JSON.stringify(ev100)
);
const totals1 = await dbOne("SELECT total_gift_coins, platform_cut_coins FROM live_sessions WHERE id = ?", [sid]);
check("session totals after 100 gift", totals1?.total_gift_coins === 100 && totals1?.platform_cut_coins === 30, JSON.stringify(totals1));

// Odd price: chocolate 25 -> creator 17 (floor of 70%), platform 8.
const gift25 = await api("sendGift", { token: viewerToken, live_session_id: sid, gift_key: "chocolate" });
check("chocolate (25) sent", gift25.ok === true, JSON.stringify(gift25).slice(0, 160));
check("odd split 25 → 17/8", gift25.creator_share === 17 && gift25.platform_share === 8, JSON.stringify(gift25));
const creatorAfter25 = (await api("getMe", { token: creatorToken })).user.coin_balance;
check("broadcaster credited +17", creatorAfter25 === creatorAfter100 + 17, `after=${creatorAfter25}`);
const ev25 = await dbOne("SELECT * FROM gift_events WHERE live_session_id = ? AND gift_key = 'chocolate'", [sid]);
check("gift_events row: 25 = 17 + 8", ev25 && ev25.creator_share === 17 && ev25.platform_share === 8, JSON.stringify(ev25));
const totals2 = await dbOne("SELECT total_gift_coins, platform_cut_coins FROM live_sessions WHERE id = ?", [sid]);
check("session totals after both gifts (125 / 38)", totals2?.total_gift_coins === 125 && totals2?.platform_cut_coins === 38, JSON.stringify(totals2));

// Owner sees the recorded platform take.
const adminView = await api("getAdminCoinRequests", { token: adminToken });
check("admin view reports platform gift earnings (38)", adminView.platform_gift_coins === 38, `got=${adminView.platform_gift_coins}`);

// ---- Gift rejections ----------------------------------------------------------------

const poor = await api("signup", { username: `poor_${suffix}`, display_name: "No Coins", password: "test-pass-123" });
const poorBefore = poor.user.coin_balance;
const broke = await api("sendGift", { token: poor.token, live_session_id: sid, gift_key: "rose" });
check("insufficient balance rejected", broke.ok === false && /not enough coins/i.test(broke.message || ""), JSON.stringify(broke));
const poorAfter = (await api("getMe", { token: poor.token })).user.coin_balance;
check("no balance change on rejection", poorAfter === poorBefore, `before=${poorBefore} after=${poorAfter}`);

const selfGift = await api("sendGift", { token: creatorToken, live_session_id: sid, gift_key: "rose" });
check("self-gift rejected", selfGift.ok === false, JSON.stringify(selfGift));

const unauthGift = await api("sendGift", { token: "bogus-token", live_session_id: sid, gift_key: "rose" });
check("unauthenticated sendGift rejected", unauthGift.ok === false);
const noTokenGift = await api("sendGift", { live_session_id: sid, gift_key: "rose" });
check("tokenless sendGift rejected", noTokenGift.ok === false);

const badGift = await api("sendGift", { token: viewerToken, live_session_id: sid, gift_key: "yacht" });
check("unknown gift rejected", badGift.ok === false);

// ---- Held coins (pending withdrawal) can be neither gifted nor re-withdrawn --
// The viewer holds all 5,875 remaining coins in a withdrawal request: the
// spendable balance drops to 0, so a 100-coin gift and a second withdrawal
// both fail.
const hold = await api("requestWithdrawal", { token: viewerToken, coins: 5875, jazzcash_number: "03001234567" });
check("viewer withdrawal hold placed (balance 0)", hold.ok === true && hold.my_balance === 0, JSON.stringify(hold));
const heldGift = await api("sendGift", { token: viewerToken, live_session_id: sid, gift_key: "giftbox" });
check("held coins cannot be gifted", heldGift.ok === false, JSON.stringify(heldGift));
const heldWd = await api("requestWithdrawal", { token: viewerToken, coins: 10, jazzcash_number: "03001234567" });
check("held coins cannot be withdrawn twice", heldWd.ok === false);
// Rejecting the withdrawal refunds the hold in full.
const holdReject = await api("reviewWithdrawal", { token: creatorToken, withdrawal_id: hold.withdrawal.id, decision: "rejected" });
check("admin rejects the hold", holdReject.ok === true, JSON.stringify(holdReject));
const viewerAfterRefund = (await api("getMe", { token: viewerToken })).user.coin_balance;
check("hold refunded after rejection (5875)", viewerAfterRefund === 5875, `bal=${viewerAfterRefund}`);

// ---- Follow state for the watch screen (getLive.broadcaster_followed) ------------

check("getLive says broadcaster not followed yet", detail.broadcaster_followed === false, JSON.stringify(detail.broadcaster_followed));
const followRes = await api("toggleFollow", { token: viewerToken, user_id: creatorId });
check("toggleFollow follows the broadcaster", followRes.ok === true && followRes.following === true);
const detailFollowed = await api("getLive", { token: viewerToken, live_session_id: sid });
check("getLive now reports broadcaster_followed", detailFollowed.broadcaster_followed === true);
const unfollowRes = await api("toggleFollow", { token: viewerToken, user_id: creatorId });
check("toggleFollow unfollows again", unfollowRes.ok === true && unfollowRes.following === false);

// ---- Guest seat: request -> decline -> accept -> publish wiring -> leave/remove ---
// A third user watches alongside the fan; the fan asks to sit as guest.

async function waitForCount(sock, pred, n, label, timeoutMs = 8000) {
  const t0 = Date.now();
  for (;;) {
    const hits = sock.messages.filter(pred);
    if (hits.length >= n) return hits[n - 1];
    if (Date.now() - t0 > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await sleep(100);
  }
}

// An unauthenticated socket cannot even ask (auth gate answers first).
await new Promise((resolve) => {
  let settled = false;
  const raw = new WebSocket(BASE.replace(/^http/, "ws") + "/ws");
  const finish = (ok) => {
    if (settled) return;
    settled = true;
    check("unauthenticated guest-request rejected", ok);
    try {
      raw.close();
    } catch {
      /* ignore */
    }
    resolve();
  };
  raw.on("open", () => raw.send(JSON.stringify({ type: "guest-request" })));
  raw.on("message", (rawMsg) => {
    try {
      if (JSON.parse(String(rawMsg)).type === "auth-error") finish(true);
    } catch {
      /* ignore */
    }
  });
  setTimeout(() => finish(false), 5000);
});

const guestName = `guest_${suffix}`;
const guestUser = await api("signup", { username: guestName, display_name: "Guest Fan", password: "test-pass-123" });
check("guest-seat third user signup", guestUser.ok === true);
const guestSock = await connectSocket(guestUser.token);
guestSock.send({ type: "join", liveSessionId: sid });
await guestSock.waitFor((m) => m.type === "joined", 8000, "third viewer joined");
check("third viewer joined the room", true);

// 1) Request reaches the broadcaster; a duplicate is refused.
fanSock.send({ type: "guest-request" });
const req1 = await hostSock.waitFor((m) => m.type === "guest-request" && m.from?.user?.username === viewerName, 8000, "guest-request at host");
check("host received the join request with the requester", typeof req1.requestId === "string");
fanSock.send({ type: "guest-request" });
const dupErr = await fanSock.waitFor((m) => m.type === "error" && /intezar/.test(m.message || ""), 8000, "duplicate request error");
check("duplicate join request refused", Boolean(dupErr));

// 2) Decline changes nothing.
hostSock.send({ type: "guest-respond", requestId: req1.requestId, accept: false });
const declined = await fanSock.waitFor((m) => m.type === "guest-declined", 8000, "guest-declined");
check("requester told about the decline", Boolean(declined));
check("decline seated nobody", !hostSock.messages.some((m) => m.type === "guest-seated") && !fanSock.messages.some((m) => m.type === "guest-seated"));

// 3) A fresh request, accepted this time: the whole room hears guest-seated.
fanSock.send({ type: "guest-request" });
const req2 = await waitForCount(hostSock, (m) => m.type === "guest-request", 2, "second guest-request");
hostSock.send({ type: "guest-respond", requestId: req2.requestId, accept: true });
const seated = await fanSock.waitFor((m) => m.type === "guest-seated", 8000, "guest-seated at requester");
check("guest-seated broadcast with the fan as guest", seated.guestPeerId === fanSock.peerId && seated.guest?.username === viewerName, JSON.stringify(seated));
await hostSock.waitFor((m) => m.type === "guest-seated", 8000, "guest-seated at host");
await guestSock.waitFor((m) => m.type === "guest-seated", 8000, "guest-seated at other viewer");
check("host + other viewer also saw guest-seated", true);

// 4) One seat only: further requests are refused while it is taken.
guestSock.send({ type: "guest-request" });
const seatTaken = await guestSock.waitFor((m) => m.type === "error" && /betha/.test(m.message || ""), 8000, "seat-taken error");
check("second join attempt while seated refused", Boolean(seatTaken));

// 5) Guest-ready wires the stage: host initiates the guest-peer link,
//    the guest learns the existing viewers, signaling reaches the guest.
fanSock.send({ type: "guest-ready" });
const guestPeerAtHost = await hostSock.waitFor((m) => m.type === "guest-peer" && m.peerId === fanSock.peerId, 8000, "guest-peer at host");
check("host told to initiate the guest connection", guestPeerAtHost.initiate === true);
const guestPeerAtGuest = await fanSock.waitFor((m) => m.type === "guest-peer" && m.peerId === hostSock.peerId, 8000, "guest-peer at guest");
check("guest told the host peer id", guestPeerAtGuest.initiate === false);
await fanSock.waitFor((m) => m.type === "viewer-joined" && m.peerId === guestSock.peerId, 8000, "guest learns existing viewers");
check("guest learned the existing viewers to publish to", true);
hostSock.send({ type: "signal", to: fanSock.peerId, data: { kind: "offer", description: { type: "offer", sdp: "fake" } } });
const guestSignal = await fanSock.waitFor((m) => m.type === "signal" && m.from === hostSock.peerId && m.data?.kind === "offer", 8000, "offer relayed to guest");
check("signaling relay works for the guest's peers", Boolean(guestSignal));

// 6) Guest leaves: room hears guest-left and the host re-offers to the
//    ex-guest as a plain viewer.
fanSock.send({ type: "guest-leave" });
const left1 = await hostSock.waitFor((m) => m.type === "guest-left" && m.guestPeerId === fanSock.peerId, 8000, "guest-left at host");
check("guest-left broadcast on leave", left1.removed === false);
await guestSock.waitFor((m) => m.type === "guest-left", 8000, "guest-left at other viewer");
await waitForCount(hostSock, (m) => m.type === "viewer-joined" && m.peerId === fanSock.peerId, 2, "host re-offers to ex-guest");
check("host re-notified about the ex-guest as a plain viewer", true);

// 7) Re-seat and let the host remove the guest instead.
fanSock.send({ type: "guest-request" });
const req3 = await waitForCount(hostSock, (m) => m.type === "guest-request", 3, "third guest-request");
hostSock.send({ type: "guest-respond", requestId: req3.requestId, accept: true });
await waitForCount(fanSock, (m) => m.type === "guest-seated", 2, "second guest-seated");
hostSock.send({ type: "guest-remove" });
const removedMsg = await fanSock.waitFor((m) => m.type === "guest-left" && m.removed === true, 8000, "guest-left (removed)");
check("host remove ends the seat with removed=true", removedMsg.guestPeerId === fanSock.peerId);

// 8) The seat is free again afterwards.
fanSock.send({ type: "guest-request" });
const req4 = await waitForCount(hostSock, (m) => m.type === "guest-request", 4, "fourth guest-request (seat free again)");
hostSock.send({ type: "guest-respond", requestId: req4.requestId, accept: false });
await waitForCount(fanSock, (m) => m.type === "guest-declined", 2, "final decline");
check("seat usable again after leave + remove", true);
guestSock.close();

// ---- jsdom: the Live tab renders with this broadcast running ---------------------------

try {
  const indexHtml = fs.readFileSync(path.join(DIST_DIR, "index.html"), "utf8");
  const bundleName = fs.readdirSync(path.join(DIST_DIR, "assets")).find((f) => f.endsWith(".js"));
  check("built bundle exists", Boolean(bundleName), "run `npm run build` first");
  const bundle = fs.readFileSync(path.join(DIST_DIR, "assets", bundleName), "utf8");
  check("bundle contains Live UI", bundle.includes("Go Live") && bundle.includes("No one is live right now"));

  const dom = new JSDOM(indexHtml, {
    url: `${BASE}/`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.localStorage.setItem("zoomly_token", viewerToken);
      window.fetch = (u, o = {}) => {
        const { signal, ...rest } = o;
        return fetch(new URL(u, BASE), rest);
      };
      window.IntersectionObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
      window.HTMLMediaElement.prototype.play = () => Promise.resolve();
      window.HTMLMediaElement.prototype.pause = () => {};
      window.HTMLMediaElement.prototype.load = () => {};
      window.scrollTo = () => {};
      // jsdom may lack a WebSocket client: stub one so the watch room can
      // mount (it renders its chrome while the socket never connects).
      if (!window.WebSocket) {
        window.WebSocket = class {
          constructor() {
            this.readyState = 0;
          }
          send() {}
          close() {
            this.readyState = 3;
          }
        };
      }
    },
  });
  const { document } = dom.window;
  const bodyText = () => document.body?.textContent || "";
  const waitForText = async (desc, pred, timeoutMs = 25000) => {
    const t0 = Date.now();
    for (;;) {
      if (pred(bodyText())) return;
      if (Date.now() - t0 > timeoutMs) throw new Error(`Timed out waiting for: ${desc}`);
      await sleep(200);
    }
  };
  dom.window.eval(bundle);
  await waitForText("app boot", (t) => t.includes("Live") || t.includes("could not open"));
  check("app boots without crash", !bodyText().includes("could not open"));
  // The For You feed carries its own 🔴 LIVE shortcut (TikTok-style) that
  // jumps straight to the Live tab — separate from the bottom nav button.
  const feedLiveBtn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("LIVE"));
  check("feed has a 🔴 LIVE shortcut button", Boolean(feedLiveBtn));
  feedLiveBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await waitForText("Live tab opened from the feed LIVE button", (t) => t.includes("Go Live") || t.includes("could not open"));
  check("feed LIVE button opens the Live tab", bodyText().includes("Go Live"));
  const liveBtn = [...document.querySelectorAll("nav button")].find((b) => (b.textContent || "").includes("Live"));
  check("Live nav button found", Boolean(liveBtn));
  liveBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await waitForText("live list shows the running broadcast", (t) => t.includes("Live test show") || t.includes("could not open"), 25000);
  const t = bodyText();
  check("Live tab did NOT crash the app", !t.includes("could not open"));
  check("running broadcast listed in Live tab", t.includes("Live test show"), t.slice(0, 300));
  check("Go Live button rendered", t.includes("Go Live"));
  // Enter the watch screen: the Follow and Join Live (guest) buttons must
  // render there (render-level check for both).
  const watchBtn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "Watch");
  check("Watch button found for the broadcast", Boolean(watchBtn));
  watchBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await waitForText("watch screen shows Follow + Join Live", (x) => x.includes("Join Live") && x.includes("Follow"), 25000);
  const wt = bodyText();
  check("watch screen renders the Follow button", wt.includes("Follow"));
  check("watch screen renders the Join Live button", wt.includes("Join Live"));
  check("watch screen did NOT crash the app", !wt.includes("could not open"));
  dom.window.close();
} catch (err) {
  check(`jsdom Live tab check (${err.message})`, false);
}

// ---- Ending: viewer leave, then broadcaster disconnect ----------------------------

fanSock.close();
const leftMsg = await hostSock.waitFor((m) => m.type === "viewer-left" && m.peerId === fanSock.peerId, 8000, "viewer-left at broadcaster");
check("broadcaster notified when viewer leaves", leftMsg.peerId === fanSock.peerId);
const count0 = await hostSock.waitFor((m) => m.type === "viewer-count" && m.count === 0, 8000, "viewer-count=0");
check("viewer-count back to 0", Boolean(count0));

// Reconnect a viewer so we can watch the broadcaster-disconnect ending.
const fan2 = await connectSocket(viewerToken);
fan2.send({ type: "join", liveSessionId: sid });
await fan2.waitFor((m) => m.type === "joined", 8000, "viewer re-joined");

const endByViewer = await api("endLive", { token: viewerToken, live_session_id: sid });
check("endLive by non-broadcaster rejected", endByViewer.ok === false, JSON.stringify(endByViewer));

hostSock.close(); // broadcaster disconnect => session must end
const endedMsg = await fan2.waitFor((m) => m.type === "live-ended", 8000, "live-ended broadcast");
check("live-ended broadcast on broadcaster disconnect", endedMsg.liveSessionId === sid);
await sleep(400);
const endedRow = await dbOne("SELECT ended_at, total_gift_coins, platform_cut_coins, peak_viewers FROM live_sessions WHERE id = ?", [sid]);
check("session marked ended in DB", endedRow?.ended_at !== null && endedRow?.ended_at !== undefined, JSON.stringify(endedRow));
check("final totals persisted (125 / 38)", endedRow?.total_gift_coins === 125 && endedRow?.platform_cut_coins === 38, JSON.stringify(endedRow));

const listAfter = await api("listLive", { token: viewerToken });
check("ended session leaves listLive", !listAfter.lives?.some((l) => l.id === sid));

const giftAfterEnd = await api("sendGift", { token: viewerToken, live_session_id: sid, gift_key: "rose" });
check("gift to ended session rejected", giftAfterEnd.ok === false, JSON.stringify(giftAfterEnd));

// A clean RPC endLive on a fresh session returns the summary.
const started2 = await api("startLive", { token: creatorToken, title: "Short second live" });
check("second startLive ok", started2.ok === true);
const summaryRes = await api("endLive", { token: creatorToken, live_session_id: started2.session.id });
check(
  "endLive summary shape",
  summaryRes.ok === true && summaryRes.summary?.live_session_id === started2.session.id && typeof summaryRes.summary?.duration_seconds === "number" && summaryRes.summary?.creator_earned_coins === 0,
  JSON.stringify(summaryRes).slice(0, 220)
);

// ---- Live title: asked once, then remembered on the account ---------------------
// (Every titled startLive saves its title — the most recent one above was
// "Short second live", so that is what the account must now hold.)
const meAfterFirst = await api("getMe", { token: creatorToken });
check("titled startLive saved its title on the account", meAfterFirst.user?.live_title === "Short second live", JSON.stringify(meAfterFirst.user?.live_title));

const titled = await api("startLive", { token: creatorToken, title: "Yaad wala title ✨" });
check("startLive with a new title ok", titled.ok === true && titled.session?.title === "Yaad wala title ✨", JSON.stringify(titled).slice(0, 200));
await api("endLive", { token: creatorToken, live_session_id: titled.session.id });
const meAfterSave = await api("getMe", { token: creatorToken });
check("new title replaced the saved one", meAfterSave.user?.live_title === "Yaad wala title ✨", JSON.stringify(meAfterSave.user?.live_title));

const reused = await api("startLive", { token: creatorToken });
check("startLive WITHOUT a title reuses the saved one", reused.ok === true && reused.session?.title === "Yaad wala title ✨", JSON.stringify(reused).slice(0, 200));
await api("endLive", { token: creatorToken, live_session_id: reused.session.id });

const freshName = `newbie_${suffix}`;
const fresh = await api("signup", { username: freshName, display_name: "Fresh Face", password: "test-pass-123" });
check("fresh user signup", fresh.ok === true);
const defaulted = await api("startLive", { token: fresh.token });
check(
  "first-ever live without a title falls back to the default",
  defaulted.ok === true && defaulted.session?.title === "Fresh Face is live 🔴",
  JSON.stringify(defaulted).slice(0, 200)
);
const freshMe = await api("getMe", { token: fresh.token });
check("the default title was saved too", freshMe.user?.live_title === "Fresh Face is live 🔴", JSON.stringify(freshMe.user?.live_title));
await api("endLive", { token: fresh.token, live_session_id: defaulted.session.id });

fan2.close();

console.log(failures === 0 ? "\nLIVE TEST PASSED ✔" : `\nLIVE TEST FAILED — ${failures} check(s) failed ✗`);
process.exit(failures === 0 ? 0 : 1);
