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
check("viewer starts with 0 coins (no free welcome coins)", viewer.user.coin_balance === 0, `bal=${viewer.user.coin_balance}`);

// Fund the viewer properly: a custom 6,000-coin request (packs are flat
// 1:1 now — the biggest pack is 5,000) + admin approve.
const tid = `LIVETID${Date.now()}`;
const req = await api("requestCustomCoins", { token: viewerToken, coins: 6000, tid });
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
  byKey.rose === 1 && byKey.chocolate === 25 && byKey.heart === 50 && byKey.giftbox === 100 && byKey.crown === 250 && byKey.rocket === 500 && byKey.diamond === 1000 && byKey.lion === 2500,
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
check(
  "every room adopts the server ICE list (start + video watch + broad watch)",
  liveJsxSrc.split("setIceServers(res.ice_servers)").length - 1 >= 3,
  `adoptions=${liveJsxSrc.split("setIceServers(res.ice_servers)").length - 1}`
);
check("client fallback list carries TURN", liveJsSrc.includes("openrelay.metered.ca") && liveJsSrc.includes("FALLBACK_ICE_SERVERS"));
check(
  "client retries failed peers via relay + renegotiate",
  liveJsSrc.includes("iceTransportPolicy") && liveJsSrc.includes('"relay"') && liveJsxSrc.includes("renegotiate") && liveJsxSrc.includes("onPeerIceFailed")
);
check("client logs the selected candidate pair type", liveJsSrc.includes("logSelectedCandidatePair") && liveJsxSrc.includes("logSelectedCandidatePair"));

// ---- TURN credentials: staticauth REST scheme (the dead-cred fix) -------------
// The old anonymous openrelayproject long-term credentials no longer
// allocate (Metered now requires an account for that host — two real
// two-phone tests failed black+silent). The server now mints coturn
// REST credentials for the static-auth host: username "<expiry>:zoomly",
// credential base64(HMAC-SHA1(secret, username)). Verify the served
// credentials cryptographically, here in the test.
{
  const { createHmac } = await import("node:crypto");
  const turn = turnEntries.find((s) => String(s.urls).includes("staticauth.openrelay.metered.ca"));
  check("TURN entries point at the static-auth Open Relay host", Boolean(turn), JSON.stringify(iceList));
  const expiry = Number(String(turn?.username ?? "").split(":")[0]);
  check(
    "TURN username is a future expiry in REST format",
    /^\d+:zoomly$/.test(String(turn?.username ?? "")) && expiry * 1000 > Date.now(),
    String(turn?.username)
  );
  const expected = createHmac("sha1", "openrelayprojectsecret").update(String(turn?.username ?? "")).digest("base64");
  check("TURN credential is the valid HMAC of the username", turn?.credential === expected);
  check(
    "client fallback mints the same staticauth scheme",
    liveJsSrc.includes("staticauth.openrelay.metered.ca") && liveJsSrc.includes("hmacSha1Base64") && liveJsSrc.includes("mintFallbackIceServers")
  );
}

// ---- ICE diagnostics: clients report final outcomes to the server log ---------
{
  const rep = await api("iceReport", { token: creatorToken, role: "watch", kind: "main", state: "connected", via: "relay", relay: true });
  check("iceReport accepts a signed-in report", rep.ok === true, JSON.stringify(rep).slice(0, 160));
  const repBad = await api("iceReport", { token: "bogus-token", role: "watch", state: "failed" });
  check("iceReport rejects an invalid token", repBad.ok === false);
  check(
    "client reports ICE outcomes (connected + final failures)",
    liveJsSrc.includes("reportIce") && liveJsSrc.includes("/api/iceReport") && liveJsxSrc.includes("reportIce")
  );
}

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

// ---- Face filters ---------------------------------------------------------------
// Broadcasters (host + seated guest) can filter their own camera and the
// filter is rendered into the published stream via a canvas pipeline
// (filters.js). Headless checks: the module's shape, the persistence, and
// that both publish paths consume the processed stream. The jsdom host
// section at the end exercises the picker itself with stubbed media.
const filtersJsSrc = fs.readFileSync(path.join(SRC_DIR, "filters.js"), "utf8");
check(
  "filter module defines all 7 filters",
  ["normal", "beauty", "bright", "warm", "cool", "vivid", "bw"].every((k) => filtersJsSrc.includes(`key: "${k}"`)) &&
    ["Normal", "Beauty", "Bright", "Warm", "Cool", "Vivid", "B&W"].every((l) => filtersJsSrc.includes(`label: "${l}"`))
);
check("filter choice persists via localStorage", filtersJsSrc.includes("zoomly_live_filter") && filtersJsSrc.includes("getLiveFilter") && filtersJsSrc.includes("setLiveFilter"));
check("processor publishes a canvas captureStream (viewers get the filtered video)", filtersJsSrc.includes("createVideoProcessor") && filtersJsSrc.includes("captureStream") && filtersJsSrc.includes("drawImage"));
check("beauty filter is a smoothing blend, not just a colour wash", filtersJsSrc.includes('currentKey === "beauty"') && filtersJsSrc.includes('blur(3px)') && filtersJsSrc.includes("globalAlpha"));
check("unsupported browsers fall back (support probe + null processor)", filtersJsSrc.includes("filtersSupported") && filtersJsSrc.includes('ctx.filter = "blur(2px)"'));
check(
  "front camera is mirrored in the published canvas draw (translate + scale(-1,1))",
  filtersJsSrc.includes("scale(-1, 1)") && filtersJsSrc.includes("translate(w, 0)") && filtersJsSrc.includes("mirrored")
);
check(
  "mirror applies to the front camera only (rear/environment left unmirrored)",
  filtersJsSrc.includes('facingMode !== "environment"') && filtersJsSrc.includes("settings.facingMode")
);
check(
  "host path: camera runs through the processor, room publishes the given stream",
  liveJsxSrc.includes("createVideoProcessor(s, getLiveFilter())") && liveJsxSrc.includes("onStart(res.session, stream, proc)") && liveJsxSrc.includes("for (const track of stream.getTracks()) pc.addTrack(track, stream)")
);
check(
  "guest path: seated guest publishes the processed stream too",
  liveJsxSrc.includes("guestStreamRef.current = proc ? proc.stream : stream") && liveJsxSrc.includes("guestStreamRef.current.getTracks()")
);
check(
  "filter picker is wired for publishers (sheet + 🎨 buttons)",
  liveJsxSrc.includes("Face Filters") && liveJsxSrc.includes("LIVE_FILTERS.map") && (liveJsxSrc.match(/aria-label="Filters"/g) ?? []).length >= 2 && liveJsxSrc.includes("processor?.setFilter(key)") && liveJsxSrc.includes("guestProcessorRef.current?.setFilter(key)")
);
check("picking a filter persists it for the next live", liveJsxSrc.includes("setLiveFilter(key)"));
check(
  "filter pipeline is stall-proof (multi-scheduler draw loop + stall hook + frames counter)",
  filtersJsSrc.includes("requestVideoFrameCallback") && filtersJsSrc.includes("setInterval") && filtersJsSrc.includes("setOnStall") && filtersJsSrc.includes("framesDrawn") && filtersJsSrc.includes("halt")
);
check(
  "rooms rescue a stalled filter by swapping senders to the raw camera track",
  liveJsxSrc.includes("rawFallbackRef") && liveJsxSrc.includes("replaceTrack(rawTrack)") && liveJsxSrc.includes("guestStreamRef.current = stream")
);

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

// ---- Tap-tap likes -------------------------------------------------------------
// Viewers tap the stage to like; the server owns the running total and
// broadcasts it to the whole room. Viewers only (the host can't like
// their own stream), batches clamped to 10, ~10 counted per second.
check("joined payloads seed the like count (0)", hostJoined.likeCount === 0 && fanJoined.likeCount === 0, JSON.stringify({ h: hostJoined.likeCount, f: fanJoined.likeCount }));
fanSock.send({ type: "live-like", n: 3 });
const likeAtHost = await hostSock.waitFor((m) => m.type === "live-likes" && m.total === 3, 8000, "like total 3 at host");
check("viewer likes broadcast to the host (total 3)", likeAtHost.n === 3 && likeAtHost.fromPeerId === fanSock.peerId, JSON.stringify(likeAtHost));
const likeAtFan = await fanSock.waitFor((m) => m.type === "live-likes" && m.total === 3, 8000, "like total 3 at viewer");
check("viewer likes broadcast back to viewers (total 3)", likeAtFan.total === 3);
// The host's own like must be refused: if it were counted, the next
// total would jump by 5 first — the fan's +1 must land exactly on 4.
hostSock.send({ type: "live-like", n: 5 });
fanSock.send({ type: "live-like", n: 1 });
const likeTotal4 = await hostSock.waitFor((m) => m.type === "live-likes" && m.total === 4, 8000, "like total 4");
check("host cannot like their own stream (fan's +1 lands on 4, not 9)", likeTotal4.total === 4);
// Batch clamp: in a fresh rate window, an oversized batch counts 10.
await sleep(1100);
fanSock.send({ type: "live-like", n: 500 });
const likeTotal14 = await hostSock.waitFor((m) => m.type === "live-likes" && m.total === 14, 8000, "like total 14");
check("oversized like batch clamped to +10 (total 14)", likeTotal14.n === 10, JSON.stringify(likeTotal14));
// Rate limit: a full second batch inside the same window counts 0 —
// no further broadcast may arrive.
await sleep(1100);
fanSock.send({ type: "live-like", n: 10 });
const likeTotal24 = await hostSock.waitFor((m) => m.type === "live-likes" && m.total === 24, 8000, "like total 24");
check("fresh window counts again (total 24)", likeTotal24.total === 24);
const likesSeenAtHost = hostSock.messages.filter((m) => m.type === "live-likes").length;
fanSock.send({ type: "live-like", n: 10 });
await sleep(600);
const likesSeenAfter = hostSock.messages.filter((m) => m.type === "live-likes").length;
check("second batch inside the same second is rate-limited (no new broadcast)", likesSeenAfter === likesSeenAtHost, `before=${likesSeenAtHost} after=${likesSeenAfter}`);
// Client wiring (source shape): socket helper, stage tap handler, the
// heart animation and the ❤️ counter in both rooms.
check(
  "live-like client wiring (socket helper + stage tap + counter)",
  liveJsSrc.includes('"live-like"') && liveJsxSrc.includes("handleStageTap") && liveJsxSrc.includes("data-live-likes") && liveJsxSrc.includes("room.liveLikes")
);
check("live-like hearts spawn at the tap point and for remote likes", liveJsxSrc.includes("spawnHeart") && liveJsxSrc.includes("zoomly-live-heart") && liveJsxSrc.includes("FloatingHearts"));

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

// ---- Gift earnings history (creator + platform) ----------------------------------
const earnings = await api("getGiftEarnings", { token: creatorToken });
check("gift earnings totals (87 earned of 125 gross, 2 gifts)", earnings.total_earned === 87 && earnings.total_gift_coins === 125 && earnings.gift_count === 2, JSON.stringify(earnings).slice(0, 200));
check(
  "gift earnings list newest-first with sender + 70% shares",
  earnings.earnings?.length === 2 && earnings.earnings[0].creator_share === 17 && earnings.earnings[1].creator_share === 70 && earnings.earnings[0].sender?.username === viewer.user.username,
  JSON.stringify(earnings.earnings).slice(0, 200),
);
check(
  "admin platform gift events listed (30 + 8 = 38)",
  Array.isArray(adminView.platform_gift_events) && adminView.platform_gift_events.reduce((s, e) => s + e.platform_share, 0) === 38,
  JSON.stringify(adminView.platform_gift_events).slice(0, 200),
);

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
// Withdrawals are gated on an APPROVED monetization application (owner
// program, 2026-10-23) — seed one for the viewer; the apply/review
// journey itself is covered by scripts/monetization-test.mjs.
{
  const now = Date.now();
  await db.execute({
    sql: `INSERT INTO monetization_applications (user_id, full_name, dob, jazzcash_number, followers_snapshot, views_snapshot, status, created_at, decided_at)
          VALUES (?, 'Live Seeded', '2000-01-01', '03001234567', 5000, 50000, 'approved', ?, ?)`,
    args: [viewerId, now, now],
  });
}
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
const holdReject = await api("reviewWithdrawal", { token: adminToken, withdrawal_id: hold.withdrawal.id, decision: "rejected" });
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
  check("bundle contains Live UI", bundle.includes("Go Live") && bundle.includes("Abhi koi live nahi hai.") && bundle.includes("Abhi koi broad nahi hai."));

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
  // The raised centre nav button carries a small "Go Live" caption under
  // its circle (the broadcast entry — the feed's TV icon is for watching).
  const goLiveCaptionBtn = [...document.querySelectorAll("nav button")].find((b) => (b.textContent || "").includes("Go Live"));
  check("centre nav LIVE button shows the 'Go Live' caption", Boolean(goLiveCaptionBtn));
  // The owner rejected the big red 🔴 LIVE pill in the feed header. Instead
  // the feed carries a small TikTok-style TV "LIVE" icon at the top-left of
  // the header: icon-only, no red pill, and NOT the 🔴-emoji text button.
  const pillBtn = [...document.querySelectorAll("button")].find((b) => !b.closest("nav") && (b.textContent || "").includes("🔴"));
  check("feed header has NO red 🔴 LIVE pill", !pillBtn);
  const liveIconBtn = document.querySelector('button[aria-label="Open Live"]');
  check("feed header has the small LIVE icon button", Boolean(liveIconBtn) && !liveIconBtn.closest("nav"));
  check("feed LIVE entry is an icon (SVG), not a text pill", Boolean(liveIconBtn?.querySelector("svg")));
  liveIconBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await waitForText("Live tab opened from the feed LIVE icon", (t) => t.includes("Go Live") || t.includes("could not open"));
  check("feed LIVE icon opens the Live tab", bodyText().includes("Go Live"));
  // Back to the feed via the Home nav button, then in through the raised
  // centre nav LIVE button — it must keep working exactly as before.
  const homeBtn = [...document.querySelectorAll("nav button")].find((b) => (b.textContent || "").includes("Home"));
  check("Home nav button found", Boolean(homeBtn));
  homeBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await waitForText("back on the feed", (t) => t.includes("For You") || t.includes("could not open"));
  const liveBtn = [...document.querySelectorAll("nav button")].find((b) => (b.textContent || "").includes("Live"));
  check("raised centre nav LIVE button found", Boolean(liveBtn));
  liveBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await waitForText("Live tab opened from the centre nav LIVE button", (t) => t.includes("Go Live") || t.includes("could not open"));
  check("centre nav LIVE button opens the Live tab", bodyText().includes("Go Live"));
  await waitForText("live list shows the running broadcast", (t) => t.includes("Live test show") || t.includes("could not open"), 25000);
  const t = bodyText();
  check("Live tab did NOT crash the app", !t.includes("could not open"));
  check("running broadcast listed in Live tab", t.includes("Live test show"), t.slice(0, 300));
  check("Go Live button rendered", t.includes("Go Live"));
  // Two-section list (owner's layout): video rooms under "🔴 Live",
  // broad rooms under "🎙️ Broad", each section always present.
  const videoSection = document.querySelector('[data-live-section="video"]');
  const broadSection = document.querySelector('[data-live-section="broad"]');
  check("Live list renders BOTH sections (🔴 Live + 🎙️ Broad)", Boolean(videoSection) && Boolean(broadSection) && (videoSection.textContent || "").includes("🔴 Live") && (broadSection.textContent || "").includes("🎙️ Broad"));
  const videoCardEl = [...document.querySelectorAll('[data-live-kind="video"]')].find((c) => (c.textContent || "").includes("Live test show"));
  check("video broadcast sits inside the 🔴 Live section (not Broad)", Boolean(videoCardEl) && Boolean(videoSection?.contains(videoCardEl)) && !broadSection?.contains(videoCardEl));
  check("empty Broad section shows its quiet line", (broadSection?.textContent || "").includes("Abhi koi broad nahi hai."), (broadSection?.textContent || "").slice(0, 120));
  // Enter the watch screen: the Follow and Join Live (guest) buttons must
  // render there (render-level check for both).
  const watchBtn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "Watch");
  check("Watch button found for the broadcast", Boolean(watchBtn));
  watchBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await waitForText("watch screen shows Follow + Join Live", (x) => x.includes("Join Live") && x.includes("Follow"), 25000);
  const wt = bodyText();
  check("watch screen renders the Follow button", wt.includes("Follow"));
  check("watch screen renders the Join Live button", wt.includes("Join Live"));
  // A plain viewer is not a publisher: no filter controls for them.
  check("watch screen (plain viewer) has NO Filters button", !document.querySelector('button[aria-label="Filters"]'));
  check("watch screen (plain viewer) shows no Face Filters picker", !wt.includes("Face Filters"));
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

// ---- Rose = 1 coin (owner pricing) ----------------------------------------------
// The flower costs exactly 1 coin now. The 70/30 split floors the
// creator's share — floor(0.7 × 1) = 0 — so the platform keeps the
// whole coin; that is the owner's price under the existing split
// rules, pinned here so nobody "fixes" the rounding later. (Its own
// no-title session, so the saved-title checks above stay untouched.)
const started3 = await api("startLive", { token: creatorToken });
check("rose-check startLive ok", started3.ok === true, JSON.stringify(started3).slice(0, 160));
const viewerBeforeRose = (await api("getMe", { token: viewerToken })).user.coin_balance;
const creatorBeforeRose = (await api("getMe", { token: creatorToken })).user.coin_balance;
const roseGift = await api("sendGift", { token: viewerToken, live_session_id: started3.session.id, gift_key: "rose" });
check("rose sent for exactly 1 coin", roseGift.ok === true && roseGift.gift?.coins === 1, JSON.stringify(roseGift).slice(0, 200));
check("rose split: creator 0 / platform 1 (floor of 70%)", roseGift.creator_share === 0 && roseGift.platform_share === 1, JSON.stringify(roseGift));
check("rose cost the sender exactly 1 coin", roseGift.my_balance === viewerBeforeRose - 1, `bal=${roseGift.my_balance} before=${viewerBeforeRose}`);
const creatorAfterRose = (await api("getMe", { token: creatorToken })).user.coin_balance;
check("broadcaster credited +0 for a rose", creatorAfterRose === creatorBeforeRose, `before=${creatorBeforeRose} after=${creatorAfterRose}`);
const evRose = await dbOne("SELECT * FROM gift_events WHERE live_session_id = ? AND gift_key = 'rose'", [started3.session.id]);
check("gift_events row: rose 1 = 0 creator + 1 platform", evRose && evRose.coins === 1 && evRose.creator_share === 0 && evRose.platform_share === 1, JSON.stringify(evRose));
await api("endLive", { token: creatorToken, live_session_id: started3.session.id });

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

// ---- jsdom: the host's own live screen has the filter picker ----------------------
// A fresh user (so nothing above is disturbed) goes live in jsdom with
// stubbed camera/canvas: jsdom has no MediaStream or canvas pipeline,
// so the stubs stand in for them — what is asserted is the real client
// wiring: the processor runs (canvas capture happens), the processed
// stream reaches the stage preview, the 🎨 button + picker render for
// the host, picking a filter updates + persists the choice.
try {
  const fhName = `filterhost_${suffix}`;
  const fh = await api("signup", { username: fhName, display_name: "Filter Host", password: "test-pass-123" });
  check("filter host signup", fh.ok === true, JSON.stringify(fh).slice(0, 160));
  const indexHtml = fs.readFileSync(path.join(DIST_DIR, "index.html"), "utf8");
  const bundleName = fs.readdirSync(path.join(DIST_DIR, "assets")).find((f) => f.endsWith(".js"));
  const bundle = fs.readFileSync(path.join(DIST_DIR, "assets", bundleName), "utf8");
  check("bundle contains the filter picker", bundle.includes("Face Filters") && bundle.includes("zoomly_live_filter"));

  const dom = new JSDOM(indexHtml, {
    url: `${BASE}/`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.localStorage.setItem("zoomly_token", fh.token);
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
      // --- stubbed media stack (jsdom has none of this) ---
      const fakeTrack = (kind) => ({
        kind,
        readyState: "live",
        stop() {
          this.readyState = "ended";
        },
        getSettings: () => ({ width: 640, height: 480, frameRate: 30 }),
      });
      window.MediaStream = class FakeMediaStream {
        constructor(tracks = []) {
          this._tracks = [...tracks];
        }
        getTracks() {
          return [...this._tracks];
        }
        getVideoTracks() {
          return this._tracks.filter((t) => t.kind === "video");
        }
        getAudioTracks() {
          return this._tracks.filter((t) => t.kind === "audio");
        }
        addTrack(t) {
          this._tracks.push(t);
        }
      };
      Object.defineProperty(window.navigator, "mediaDevices", {
        configurable: true,
        value: { getUserMedia: async () => new window.MediaStream([fakeTrack("video"), fakeTrack("audio")]) },
      });
      window.__canvasCaptures = 0;
      window.HTMLCanvasElement.prototype.getContext = function () {
        return { filter: "", globalAlpha: 1, drawImage() {}, save() {}, restore() {}, translate() {}, scale() {} };
      };
      window.HTMLCanvasElement.prototype.captureStream = function () {
        window.__canvasCaptures += 1;
        return new window.MediaStream([fakeTrack("video")]);
      };
    },
  });
  const { document } = dom.window;
  const bodyText = () => document.body?.textContent || "";
  const waitFor = async (desc, pred, timeoutMs = 25000) => {
    const t0 = Date.now();
    for (;;) {
      if (pred()) return;
      if (Date.now() - t0 > timeoutMs) throw new Error(`Timed out waiting for: ${desc}`);
      await sleep(200);
    }
  };
  const click = (el) => el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  dom.window.eval(bundle);
  await waitFor("app boot", () => bodyText().includes("For You") || bodyText().includes("could not open"));
  check("host app boots without crash", !bodyText().includes("could not open"));

  const navLiveBtn = [...document.querySelectorAll("nav button")].find((b) => (b.textContent || "").includes("Live"));
  check("host: centre nav LIVE button found", Boolean(navLiveBtn));
  click(navLiveBtn);
  await waitFor("Live tab", () => bodyText().includes("shuru karo") || bodyText().includes("could not open"));
  const goLiveBtn = [...document.querySelectorAll("button")].find((b) => !b.closest("nav") && (b.textContent || "").includes("shuru karo"));
  check("host: Go Live button found", Boolean(goLiveBtn));
  click(goLiveBtn);
  await waitFor("go-live setup", () => bodyText().includes("Camera on karo") || bodyText().includes("could not open"));
  const camBtn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("Camera on karo"));
  click(camBtn);
  await waitFor("camera on + processor running", () => dom.window.__canvasCaptures >= 1);
  check("camera runs through the filter processor (canvas capture happened)", dom.window.__canvasCaptures >= 1);
  const startBtn = () => [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("Start Live"));
  await waitFor("Start Live enabled", () => startBtn() && !startBtn().disabled);
  click(startBtn());
  await waitFor("broadcast room", () => bodyText().includes("End Live") || bodyText().includes("could not open"));
  check("broadcast room renders", bodyText().includes("End Live") && !bodyText().includes("could not open"));
  check("host screen shows the tap-tap like counter (❤️ 0)", Boolean(document.querySelector("[data-live-likes]")) && bodyText().includes("❤️ 0"));
  const stageVideo = [...document.querySelectorAll("video")].find((v) => v.srcObject && typeof v.srcObject.getVideoTracks === "function");
  check("stage preview shows a (processed) stream", Boolean(stageVideo));
  check("stage preview stream's video track is the canvas capture", stageVideo?.srcObject.getVideoTracks().length === 1 && dom.window.__canvasCaptures >= 1);

  const filtersBtn = document.querySelector('button[aria-label="Filters"]');
  check("host live screen renders the 🎨 Filters button", Boolean(filtersBtn));
  check("picker is closed until tapped", !bodyText().includes("Face Filters"));
  click(filtersBtn);
  await waitFor("filter picker opens", () => bodyText().includes("Face Filters"));
  const chips = [...document.querySelectorAll("button[data-filter-key]")].map((b) => b.getAttribute("data-filter-key")).sort();
  check("picker lists all 7 filters", JSON.stringify(chips) === JSON.stringify(["beauty", "bright", "bw", "cool", "normal", "vivid", "warm"]), chips.join(","));
  const vividChip = document.querySelector('button[data-filter-key="vivid"]');
  click(vividChip);
  await waitFor("vivid persisted", () => dom.window.localStorage.getItem("zoomly_live_filter") === "vivid");
  check("picking a filter persists it (localStorage)", dom.window.localStorage.getItem("zoomly_live_filter") === "vivid");
  check("picked chip shows as active", document.querySelector('button[data-filter-key="vivid"]')?.getAttribute("aria-pressed") === "true");
  const bwChip = document.querySelector('button[data-filter-key="bw"]');
  click(bwChip);
  await waitFor("bw persisted", () => dom.window.localStorage.getItem("zoomly_live_filter") === "bw");
  check("switching filters live updates the persisted choice", dom.window.localStorage.getItem("zoomly_live_filter") === "bw");
  check("broadcast room still healthy after filter switches", bodyText().includes("End Live") && !bodyText().includes("could not open"));

  // Gift animation on the HOST's own stage: a gift broadcast must
  // surface the big overlay here too — not just the chat-feed line —
  // and a second gift must QUEUE behind the first (one at a time)
  // instead of replacing it.
  const llAnim = await api("listLive", { token: fh.token });
  const myLive = llAnim.lives?.find((l) => l.broadcaster?.username === fhName);
  check("host live session found for the gift animation check", Boolean(myLive));
  if (myLive) {
    const animEl = () => document.querySelector("[data-gift-animation]");
    const roseToHost = await api("sendGift", { token: viewerToken, live_session_id: myLive.id, gift_key: "rose" });
    check("rose gift to the jsdom host ok", roseToHost.ok === true, JSON.stringify(roseToHost).slice(0, 160));
    await waitFor("host gift animation appears", () => Boolean(animEl()));
    const firstAnimText = animEl()?.textContent || "";
    check(
      "host animation shows the rose + '@sender ne … bheja' label",
      firstAnimText.includes("🌹") && firstAnimText.includes(`@${viewerName}`) && firstAnimText.includes("Rose") && firstAnimText.includes("bheja"),
      firstAnimText.slice(0, 140)
    );
    const chocToHost = await api("sendGift", { token: viewerToken, live_session_id: myLive.id, gift_key: "chocolate" });
    check("second gift sent while the first is animating", chocToHost.ok === true, JSON.stringify(chocToHost).slice(0, 160));
    check("second gift QUEUES (first animation not replaced)", (animEl()?.textContent || "").includes("🌹"), (animEl()?.textContent || "").slice(0, 140));
    await waitFor("queued gift animation plays next on the host", () => (animEl()?.textContent || "").includes("🍫"), 10000);
    check("queued gift animates after the first (host)", (animEl()?.textContent || "").includes("🍫"));
    check("chat feed still recorded the rose gift line (host)", bodyText().includes("sent Rose"));
  }

  // PK split-screen on the HOST's own stage: a rival broadcaster (raw
  // socket) challenges this jsdom host; accepting must flip the stage
  // into the 50/50 side-by-side split with the TikTok-style score bar
  // pinned at the top, a gift must move the score + fill live, and the
  // stage must return to single when the match ends.
  if (myLive) {
    const foeName = `pkfoe_${suffix}`;
    const foe = await api("signup", { username: foeName, display_name: "PK Foe", password: "test-pass-123" });
    check("pk rival signup", foe.ok === true, JSON.stringify(foe).slice(0, 160));
    const foeLive = await api("startLive", { token: foe.token, title: "Foe ki live" });
    check("pk rival live", foeLive.ok === true, JSON.stringify(foeLive).slice(0, 160));
    const foeSock = await connectSocket(foe.token);
    foeSock.send({ type: "join", liveSessionId: foeLive.session.id });
    await foeSock.waitFor((m) => m.type === "joined", 8000, "rival joined its room");
    foeSock.send({ type: "match-invite", toLiveSessionId: myLive.id });
    await waitFor("PK invite panel on the host", () => bodyText().includes("challenge bheja hai") || bodyText().includes("could not open"));
    const acceptBtn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("match shuru karo"));
    check("host sees the PK invite with an Accept button", Boolean(acceptBtn));
    check("host has no PK band before the match starts", !document.querySelector("[data-pk-band]"));
    click(acceptBtn);
    await waitFor("host stage splits for the match", () => Boolean(document.querySelector('[data-stage-layout="pk"]')));
    check("host stage is in the PK split layout", Boolean(document.querySelector('[data-stage-layout="pk"]')));
    check("host split renders both peer tiles", document.querySelectorAll("[data-stage-tile]").length === 2);
    const hostBand = document.querySelector("[data-pk-band]");
    check("host cameras sit in the framed PK band (data-pk-band)", Boolean(hostBand));
    check("host PK band is the split layer itself", hostBand?.getAttribute("data-stage-layout") === "pk");
    check("host PK band is framed at 55% of the stage height", hostBand?.style.height === "55%", hostBand?.style.height);
    const barText = document.querySelector("[data-pk-scorebar]")?.textContent || "";
    check("host score bar shows both broadcasters", barText.includes(`@${fhName}`) && barText.includes(`@${foeName}`), barText.slice(0, 140));
    check("host score bar has the centre countdown", Boolean(document.querySelector("[data-pk-countdown]")), barText.slice(0, 140));
    // The rival invited, so the rival is side A and this host is side B:
    // a gift to THIS host must move score B and swing the fill to B.
    const pkGift = await api("sendGift", { token: viewerToken, live_session_id: myLive.id, gift_key: "giftbox" });
    check("PK gift to the jsdom host ok", pkGift.ok === true, JSON.stringify(pkGift).slice(0, 160));
    await waitFor("host score B updates to 100", () => (document.querySelector('[data-pk-score="b"]')?.textContent || "").includes("100"), 10000);
    check("host score bar updates live from match-score (B = 100)", (document.querySelector('[data-pk-score="b"]')?.textContent || "").includes("100"));
    check("host fill swings fully to B (A fill 0%)", document.querySelector('[data-pk-fill="a"]')?.style.width === "0%", document.querySelector('[data-pk-fill="a"]')?.style.width);
    // Ending the rival's live ends the match: stage back to single.
    await api("endLive", { token: foe.token, live_session_id: foeLive.session.id });
    await waitFor("host stage returns to single", () => !document.querySelector("[data-pk-scorebar]") && Boolean(document.querySelector('[data-stage-layout="single"]')), 10000);
    check("host stage returns to single after match-ended", !document.querySelector("[data-pk-scorebar]"));
    check("host PK band is gone after the match", !document.querySelector("[data-pk-band]"));
    foeSock.close();
  }

  // Tidy up: end this host's live through the API.
  const ll = await api("listLive", { token: fh.token });
  const mine = ll.lives?.find((l) => l.broadcaster?.username === fhName);
  if (mine) await api("endLive", { token: fh.token, live_session_id: mine.id });
  dom.window.close();
} catch (err) {
  check(`jsdom host filter check (${err.message})`, false);
}

// ---- jsdom: a VIEWER sees the gift animation too --------------------------------
// A fresh host goes live through the API; a fresh fan opens the watch
// room in jsdom (real socket, stubbed media playback) and the suite's
// funded viewer sends two gifts back-to-back: the first must animate
// at once with its label, the second must QUEUE behind it, and the
// chat feed must still record both gift lines.
try {
  const ahName = `animhost_${suffix}`;
  const ah = await api("signup", { username: ahName, display_name: "Anim Host", password: "test-pass-123" });
  check("anim host signup", ah.ok === true, JSON.stringify(ah).slice(0, 160));
  const startedAnim = await api("startLive", { token: ah.token, title: "Gift anim show" });
  check("anim host live via API", startedAnim.ok === true, JSON.stringify(startedAnim).slice(0, 160));
  const animSid = startedAnim.session.id;
  const afName = `animfan_${suffix}`;
  const af = await api("signup", { username: afName, display_name: "Anim Fan", password: "test-pass-123" });
  check("anim fan signup", af.ok === true, JSON.stringify(af).slice(0, 160));

  const indexHtml = fs.readFileSync(path.join(DIST_DIR, "index.html"), "utf8");
  const bundleName = fs.readdirSync(path.join(DIST_DIR, "assets")).find((f) => f.endsWith(".js"));
  const bundle = fs.readFileSync(path.join(DIST_DIR, "assets", bundleName), "utf8");
  check("bundle contains the gift animation overlay", bundle.includes("data-gift-animation") && bundle.includes("bheja"));

  const dom = new JSDOM(indexHtml, {
    url: `${BASE}/`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.localStorage.setItem("zoomly_token", af.token);
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
  const waitFor = async (desc, pred, timeoutMs = 25000) => {
    const t0 = Date.now();
    for (;;) {
      if (pred()) return;
      if (Date.now() - t0 > timeoutMs) throw new Error(`Timed out waiting for: ${desc}`);
      await sleep(200);
    }
  };
  const click = (el) => el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  dom.window.eval(bundle);
  await waitFor("anim fan app boot", () => bodyText().includes("For You") || bodyText().includes("could not open"));
  check("anim fan app boots without crash", !bodyText().includes("could not open"));
  const liveIconBtn = document.querySelector('button[aria-label="Open Live"]');
  check("anim fan: feed LIVE icon found", Boolean(liveIconBtn));
  click(liveIconBtn);
  await waitFor("anim broadcast listed", () => bodyText().includes("Gift anim show") || bodyText().includes("could not open"));
  const watchBtn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "Watch");
  check("anim fan: Watch button found", Boolean(watchBtn));
  click(watchBtn);
  await waitFor("anim watch room chrome", () => bodyText().includes("Join Live") || bodyText().includes("could not open"));
  check("anim watch room renders", bodyText().includes("Join Live") && !bodyText().includes("could not open"));

  const animEl = () => document.querySelector("[data-gift-animation]");
  check("no gift animation before any gift", !animEl());
  const g1 = await api("sendGift", { token: viewerToken, live_session_id: animSid, gift_key: "rose" });
  check("anim gift 1 sent (rose = 1 coin)", g1.ok === true && g1.gift?.coins === 1, JSON.stringify(g1).slice(0, 160));
  await waitFor("viewer gift animation appears", () => Boolean(animEl()));
  const viewerFirstText = animEl()?.textContent || "";
  check(
    "viewer animation shows the rose + '@sender ne … bheja' label",
    viewerFirstText.includes("🌹") && viewerFirstText.includes(`@${viewerName}`) && viewerFirstText.includes("Rose") && viewerFirstText.includes("bheja"),
    viewerFirstText.slice(0, 140)
  );
  const g2 = await api("sendGift", { token: viewerToken, live_session_id: animSid, gift_key: "chocolate" });
  check("anim gift 2 sent while the first is animating", g2.ok === true, JSON.stringify(g2).slice(0, 160));
  check("viewer: second gift QUEUES (first animation not replaced)", (animEl()?.textContent || "").includes("🌹"), (animEl()?.textContent || "").slice(0, 140));
  await waitFor("viewer queued gift animation plays next", () => (animEl()?.textContent || "").includes("🍫"), 10000);
  check("viewer: queued gift animates after the first", (animEl()?.textContent || "").includes("🍫"));
  check("viewer chat feed recorded both gift lines", bodyText().includes("sent Rose") && bodyText().includes("sent Chocolate"));

  await api("endLive", { token: ah.token, live_session_id: animSid });
  dom.window.close();
} catch (err) {
  check(`jsdom gift animation check (${err.message})`, false);
}

// ---- Broad (audio-only voice rooms) -------------------------------------------------
// Raw-socket protocol: session kind, seat request/accept with the mic
// OPEN by default, host authority (drop / seat-mute / invite), the
// 6-seat cap, and the kind refusals (no video guest seat, no PK match
// inside a broad). Then two jsdom renders: the listener side (list
// badge, seats stage, real follow, seat via the CTA with an audio-only
// mic capture) and the host side (Go Broad setup, stage, accepting a
// seat request from the real UI).
console.log("\n— Broad voice rooms —");
try {
  const bHostName = `bhost_${suffix}`;
  const bHost = await api("signup", { username: bHostName, display_name: "Broad Host", password: "test-pass-123" });
  check("broad host signup", bHost.ok === true, JSON.stringify(bHost).slice(0, 160));
  const mkB = async (name, display) => {
    const u = await api("signup", { username: `${name}_${suffix}`, display_name: display, password: "test-pass-123" });
    return u;
  };
  const bLis = await mkB("blis", "Broad Listener");
  const bInv = await mkB("binv", "Broad Invited");
  check("broad users signup", bLis.ok === true && bInv.ok === true);

  const bStart = await api("startLive", { token: bHost.token, title: "Broad Gapshap", kind: "broad" });
  check("startLive accepts kind=broad", bStart.ok === true && bStart.session?.kind === "broad", JSON.stringify(bStart).slice(0, 200));
  const bSid = bStart.session.id;
  const bVid = await mkB("bvid", "Video Host");
  const bVidStart = await api("startLive", { token: bVid.token, title: "Sirf video" });
  check("startLive without kind stays a video live", bVidStart.ok === true && bVidStart.session?.kind === "video", JSON.stringify(bVidStart).slice(0, 160));

  const bList = await api("listLive", { token: bLis.token });
  const bCard = bList.lives?.find((l) => l.id === bSid);
  check("broad session lists with kind=broad", bCard?.kind === "broad", JSON.stringify(bCard).slice(0, 160));
  const bDetail = await api("getLive", { token: bLis.token, live_session_id: bSid });
  check("getLive carries the broad kind", bDetail.ok === true && bDetail.session?.kind === "broad");

  const bh = await connectSocket(bHost.token);
  bh.send({ type: "join", liveSessionId: bSid });
  const bhJoined = await bh.waitFor((m) => m.type === "joined", 8000, "broad host joined");
  check("host joined payload carries kind=broad", bhJoined.kind === "broad");
  check("host seat starts with the mic OPEN (muted=false)", bhJoined.seats?.host?.muted === false, JSON.stringify(bhJoined.seats).slice(0, 160));
  check("host joined snapshot has 6 free seats", bhJoined.seats?.seatsFree === 6 && bhJoined.seats?.seats?.length === 0);

  const bl = await connectSocket(bLis.token);
  bl.send({ type: "join", liveSessionId: bSid });
  const blJoined = await bl.waitFor((m) => m.type === "joined", 8000, "broad listener joined");
  check("listener joined as viewer of the broad", blJoined.role === "viewer" && blJoined.kind === "broad");
  await bh.waitFor((m) => m.type === "viewer-joined" && m.peerId === bl.peerId, 8000, "host told about the listener");
  check("listener joining publishes nothing by itself (host wires a plain listener connection)", true);

  // Kind refusals: no video guest seat and no PK match inside a broad.
  bl.send({ type: "guest-request" });
  const guestRefused = await bl.waitFor((m) => m.type === "error" && /Broad room/.test(m.message || ""), 8000, "guest-request refused in broad");
  check("video guest-request inside a broad is refused", Boolean(guestRefused));
  const bv = await connectSocket(bVid.token);
  bv.send({ type: "join", liveSessionId: bVidStart.session.id });
  await bv.waitFor((m) => m.type === "joined", 8000, "video host joined");
  bh.send({ type: "match-invite", toLiveSessionId: bVidStart.session.id });
  const matchRefusedA = await bh.waitFor((m) => m.type === "error" && /Broad \(voice\) room se PK/.test(m.message || ""), 8000, "broad host match-invite refused");
  check("match-invite FROM a broad room is refused", Boolean(matchRefusedA));
  bv.send({ type: "match-invite", toLiveSessionId: bSid });
  const matchRefusedB = await bv.waitFor((m) => m.type === "error" && /Broad \(voice\) room ke sath PK/.test(m.message || ""), 8000, "match-invite TO a broad refused");
  check("match-invite TO a broad room is refused", Boolean(matchRefusedB));

  // Seat request -> host accept -> speaker wiring, mic open by default.
  bl.send({ type: "seat-request" });
  const seatReq = await bh.waitFor((m) => m.type === "seat-request", 8000, "seat-request at host");
  check("host receives the seat request with the requester", seatReq.from?.user?.username === bLis.user.username, JSON.stringify(seatReq).slice(0, 160));

  // A plain listener has NO seat authority: drop / host-mute / respond
  // from them must change nothing.
  const gatecrasher = await mkB("bgate", "Gate Crasher");
  const bg = await connectSocket(gatecrasher.token);
  bg.send({ type: "join", liveSessionId: bSid });
  await bg.waitFor((m) => m.type === "joined", 8000, "gatecrasher joined");
  const seatMsgsBefore = bh.messages.filter((m) => m.type === "seats" || m.type === "seat-left").length;
  bg.send({ type: "seat-drop", peerId: bl.peerId });
  bg.send({ type: "seat-host-mute", peerId: bl.peerId, muted: true });
  bg.send({ type: "seat-respond", requestId: seatReq.requestId, accept: false });
  await sleep(500);
  check(
    "non-host seat-drop / seat-host-mute / seat-respond are rejected (no seat state change)",
    bh.messages.filter((m) => m.type === "seats" || m.type === "seat-left").length === seatMsgsBefore
  );

  bh.send({ type: "seat-respond", requestId: seatReq.requestId, accept: true });
  const seated = await bl.waitFor((m) => m.type === "seat-seated", 8000, "listener seated");
  check("accepted listener is seated in seat 1", seated.seat === 1, JSON.stringify(seated).slice(0, 120));
  const snap1 = await bl.waitFor((m) => m.type === "seats" && m.seats?.length === 1, 8000, "seats snapshot with 1 seat");
  check("seat snapshot shows the speaker with mic OPEN (muted=false)", snap1.seats[0].peerId === bl.peerId && snap1.seats[0].muted === false, JSON.stringify(snap1.seats).slice(0, 200));
  check("snapshot seatsFree drops to 5", snap1.seatsFree === 5);
  bl.send({ type: "seat-ready" });
  const seatPeerHost = await bh.waitFor((m) => m.type === "seat-peer" && m.peerId === bl.peerId, 8000, "seat-peer at host");
  check("host told to initiate the speaker connection", seatPeerHost.initiate === true);
  const seatPeerSpk = await bl.waitFor((m) => m.type === "seat-peer" && m.peerId === bh.peerId, 8000, "seat-peer at speaker");
  check("speaker told the host peer (answer side)", seatPeerSpk.initiate === false);
  // Audio mesh signaling relays between the seat peers like any peer.
  bl.send({ type: "signal", to: bh.peerId, data: { kind: "offer", description: { type: "offer", sdp: "fake-audio" }, broadSeat: true } });
  const sigAtHost = await bh.waitFor((m) => m.type === "signal" && m.from === bl.peerId && m.data?.broadSeat === true, 8000, "speaker signal at host");
  check("seat audio signaling relays over the existing mesh", Boolean(sigAtHost));

  // Host seat-mute, then the speaker's own self-mute toggle wins back.
  bh.send({ type: "seat-host-mute", peerId: bl.peerId, muted: true });
  const hostMutedNote = await bl.waitFor((m) => m.type === "seat-host-muted" && m.muted === true, 8000, "seat-host-muted note");
  check("speaker is told the host muted their seat", Boolean(hostMutedNote));
  const snapMuted = await bl.waitFor((m) => m.type === "seats" && m.seats?.[0]?.muted === true, 8000, "snapshot with muted seat");
  check("snapshot shows the host-muted seat", snapMuted.seats[0].muted === true);
  bl.send({ type: "seat-mute", muted: false });
  const snapUnmuted = await bl.waitFor((m) => m.type === "seats" && m.seats?.[0]?.muted === false, 8000, "snapshot after self-unmute");
  check("speaker self-mute toggle updates the seat state", snapUnmuted.seats[0].muted === false);

  // Fill the remaining 5 seats; the 7th seat request must be refused.
  const fillers = [];
  for (let i = 0; i < 5; i++) {
    const fu = await mkB(`bfill${i}`, `Filler ${i}`);
    const fs2 = await connectSocket(fu.token);
    fs2.send({ type: "join", liveSessionId: bSid });
    await fs2.waitFor((m) => m.type === "joined", 8000, `filler ${i} joined`);
    fs2.send({ type: "seat-request" });
    const rq = await bh.waitFor((m) => m.type === "seat-request" && m.from?.user?.username === fu.user.username, 8000, `filler ${i} request`);
    bh.send({ type: "seat-respond", requestId: rq.requestId, accept: true });
    await fs2.waitFor((m) => m.type === "seat-seated", 8000, `filler ${i} seated`);
    fillers.push({ user: fu, sock: fs2 });
  }
  const snapFull = await bh.waitFor((m) => m.type === "seats" && m.seats?.length === 6, 8000, "full seats snapshot");
  check("all 6 guest seats fill (7 voices with the host)", snapFull.seats.length === 6 && snapFull.seatsFree === 0);
  check("every filled seat starts with the mic OPEN", snapFull.seats.every((s) => s.muted === false));
  const bLate = await mkB("blate", "Too Late");
  const bLateSock = await connectSocket(bLate.token);
  bLateSock.send({ type: "join", liveSessionId: bSid });
  await bLateSock.waitFor((m) => m.type === "joined", 8000, "late listener joined");
  bLateSock.send({ type: "seat-request" });
  const fullRefusal = await bLateSock.waitFor((m) => m.type === "error" && /seats full/.test(m.message || ""), 8000, "7th seat request refused");
  check("a seat request with all 6 seats full is refused with a plain message", Boolean(fullRefusal));

  // Host drop: the speaker returns to listener and the host re-offers
  // its normal listener connection to them.
  const droppedPeer = fillers[0].sock.peerId;
  bh.send({ type: "seat-drop", peerId: droppedPeer });
  const dropNote = await fillers[0].sock.waitFor((m) => m.type === "seat-left" && m.peerId === droppedPeer, 8000, "seat-left at dropped speaker");
  check("host drop broadcasts seat-left with removed=true", dropNote.removed === true);
  await waitForCount(bh, (m) => m.type === "viewer-joined" && m.peerId === droppedPeer, 2, "host re-offer to dropped speaker");
  check("dropped speaker is re-wired as a plain listener", true);
  const snapAfterDrop = await bh.waitFor((m) => m.type === "seats" && m.seats?.length === 5, 8000, "snapshot after drop");
  check("the dropped seat frees up", snapAfterDrop.seatsFree === 1);

  // Voluntary leave.
  bl.send({ type: "seat-leave" });
  const leaveNote = await bh.waitFor((m) => m.type === "seat-left" && m.peerId === bl.peerId, 8000, "seat-left at host");
  check("voluntary seat-leave broadcasts seat-left with removed=false", leaveNote.removed === false);

  // Host invite path: pick a current listener, they accept.
  const bi = await connectSocket(bInv.token);
  bi.send({ type: "join", liveSessionId: bSid });
  await bi.waitFor((m) => m.type === "joined", 8000, "invitee joined");
  bh.send({ type: "seat-invite", toPeerId: bi.peerId });
  const invite = await bi.waitFor((m) => m.type === "seat-invited", 8000, "seat-invited at listener");
  check("host invite reaches the picked listener", invite.from?.user?.username === bHost.user.username, JSON.stringify(invite).slice(0, 160));
  bi.send({ type: "seat-invite-respond", inviteId: invite.inviteId, accept: true });
  const invitedSeated = await bi.waitFor((m) => m.type === "seat-seated", 8000, "invitee seated");
  check("accepting a host invite seats the listener", typeof invitedSeated.seat === "number");
  const snapInvite = await bi.waitFor((m) => m.type === "seats" && m.seats?.some((s) => s.peerId === bi.peerId), 8000, "snapshot with invitee");
  check("invited speaker's mic is OPEN by default", snapInvite.seats.find((s) => s.peerId === bi.peerId)?.muted === false);

  // Gifts work in a broad exactly like a video live (animation rides
  // the same broadcast): fund the listener 100 coins first.
  const bTid = `BROADTID${Date.now()}`;
  const bReqCoins = await api("requestCustomCoins", { token: bLis.token, coins: 100, tid: bTid });
  const bPending = await api("getAdminCoinRequests", { token: adminToken });
  const bReqRow = bPending.requests?.find((r) => r.tid === bTid);
  await api("reviewCoinRequest", { token: adminToken, request_id: bReqRow.id, decision: "approved" });
  check("broad gift funding approved", bReqCoins.ok === true && Boolean(bReqRow));
  const hostBefore = (await api("getMe", { token: bHost.token })).user.coin_balance;
  const bGift = await api("sendGift", { token: bLis.token, live_session_id: bSid, gift_key: "chocolate" });
  check("gift sends inside a broad room", bGift.ok === true && bGift.gift?.coins === 25, JSON.stringify(bGift).slice(0, 160));
  const giftAtHost = await bh.waitFor((m) => m.type === "gift" && m.gift?.key === "chocolate", 8000, "gift broadcast at broad host");
  check("gift broadcast reaches the broad room (animation rides it)", Boolean(giftAtHost));
  const hostAfter = (await api("getMe", { token: bHost.token })).user.coin_balance;
  check("broad host earns the 70% creator share (25 -> 17)", hostAfter - hostBefore === 17, `${hostBefore} -> ${hostAfter}`);

  // ---- jsdom: listener side — badge, stage, follow, seat via CTA ----
  try {
    const bw = await mkB("bwatch", "Broad Watcher");
    const indexHtml = fs.readFileSync(path.join(DIST_DIR, "index.html"), "utf8");
    const bundleName = fs.readdirSync(path.join(DIST_DIR, "assets")).find((f) => f.endsWith(".js"));
    const bundle = fs.readFileSync(path.join(DIST_DIR, "assets", bundleName), "utf8");
    check("bundle contains the Broad UI", bundle.includes("Broad (sirf awaz)") && bundle.includes("Seat lo"));
    const dom = new JSDOM(indexHtml, {
      url: `${BASE}/`,
      runScripts: "dangerously",
      pretendToBeVisual: true,
      beforeParse(window) {
        window.localStorage.setItem("zoomly_token", bw.token);
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
        // Fake media: records every capture request so the test can
        // prove a broad speaker is only ever asked for AUDIO.
        window.__gumCalls = [];
        const fakeTrack = (kind) => ({
          kind,
          enabled: true,
          readyState: "live",
          stop() {
            this.readyState = "ended";
          },
          getSettings: () => ({}),
        });
        window.MediaStream = class FakeMediaStream {
          constructor(tracks = []) {
            this._tracks = [...tracks];
          }
          getTracks() {
            return [...this._tracks];
          }
          getVideoTracks() {
            return this._tracks.filter((t) => t.kind === "video");
          }
          getAudioTracks() {
            return this._tracks.filter((t) => t.kind === "audio");
          }
          addTrack(t) {
            this._tracks.push(t);
          }
        };
        Object.defineProperty(window.navigator, "mediaDevices", {
          configurable: true,
          value: {
            getUserMedia: async (constraints = {}) => {
              window.__gumCalls.push(constraints);
              const tracks = [];
              if (constraints.audio) tracks.push(fakeTrack("audio"));
              if (constraints.video) tracks.push(fakeTrack("video"));
              return new window.MediaStream(tracks);
            },
          },
        });
        window.RTCPeerConnection = class FakePC {
          constructor() {
            this.connectionState = "new";
            this.iceConnectionState = "new";
            this.localDescription = null;
            this.remoteDescription = null;
          }
          addTrack() {}
          async createOffer() {
            return { type: "offer", sdp: "fake" };
          }
          async createAnswer() {
            return { type: "answer", sdp: "fake" };
          }
          async setLocalDescription(d) {
            this.localDescription = d;
          }
          async setRemoteDescription(d) {
            this.remoteDescription = d;
          }
          async addIceCandidate() {}
          close() {
            this.connectionState = "closed";
          }
        };
      },
    });
    const { document } = dom.window;
    const bodyText = () => document.body?.textContent || "";
    const waitFor = async (desc, pred, timeoutMs = 25000) => {
      const t0 = Date.now();
      for (;;) {
        if (pred()) return;
        if (Date.now() - t0 > timeoutMs) throw new Error(`Timed out waiting for: ${desc}`);
        await sleep(200);
      }
    };
    const click = (el) => el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    dom.window.eval(bundle);
    await waitFor("broad watcher app boot", () => bodyText().includes("For You") || bodyText().includes("could not open"));
    check("broad watcher app boots without crash", !bodyText().includes("could not open"));
    const liveIconBtn = document.querySelector('button[aria-label="Open Live"]');
    click(liveIconBtn);
    await waitFor("broad listed in the Live list", () => Boolean(document.querySelector('[data-live-kind="broad"]')) || bodyText().includes("could not open"));
    const broadCard = [...document.querySelectorAll('[data-live-kind="broad"]')].find((c) => (c.textContent || "").includes("Broad Gapshap"));
    check("Live list shows the broad with its 🎙️ Broad badge", Boolean(broadCard) && (broadCard.textContent || "").includes("🎙️ Broad"), (broadCard?.textContent || "").slice(0, 140));
    const broadSectionEl = document.querySelector('[data-live-section="broad"]');
    const videoSectionEl = document.querySelector('[data-live-section="video"]');
    check("broad room sits inside the 🎙️ Broad section (not 🔴 Live)", Boolean(broadCard) && Boolean(broadSectionEl?.contains(broadCard)) && !videoSectionEl?.contains(broadCard));
    const sunnoBtn = [...broadCard.querySelectorAll("button")].find((b) => (b.textContent || "").includes("Sunno"));
    check("broad card's join button says 🎙️ Sunno", Boolean(sunnoBtn));
    click(sunnoBtn);
    await waitFor("broad watch room stage", () => Boolean(document.querySelector("[data-broad-stage]")) || bodyText().includes("could not open"));
    check("broad watch room renders the seats stage (no video stage)", Boolean(document.querySelector("[data-broad-stage]")) && !bodyText().includes("could not open"));
    const hostCell = document.querySelector("[data-broad-host]");
    check("host seat renders first with mic OPEN", Boolean(hostCell) && hostCell.getAttribute("data-seat-muted") === "false", hostCell?.textContent?.slice(0, 100));
    check("stage shows the filled seats from the snapshot", document.querySelectorAll('[data-seat-state="filled"]').length >= 4, `filled=${document.querySelectorAll('[data-seat-state="filled"]').length}`);
    // Follow from a seat: the host's seat offers Follow (not followed
    // yet), clicking calls the real toggleFollow, and the button goes.
    const followBtn = document.querySelector(`[data-follow-user="${bHost.user.id}"]`);
    check("host seat shows a Follow button", Boolean(followBtn));
    click(followBtn);
    await waitFor("follow button retires after following", () => !document.querySelector(`[data-follow-user="${bHost.user.id}"]`));
    const profileAfterFollow = await api("getProfile", { token: bw.token, user_id: bHost.user.id });
    check("follow from the seat hit the real follow action", profileAfterFollow.profile?.followed_by_me === true);
    // Seat via the CTA: request goes to the raw host, who accepts; the
    // room flips to speaker controls and only AUDIO was ever captured.
    const cta = document.querySelector('[data-seat-cta="true"]');
    check("listener sees the ✋ Seat lo button", Boolean(cta) && !cta.disabled);
    click(cta);
    const bwReq = await bh.waitFor((m) => m.type === "seat-request" && m.from?.user?.username === bw.user.username, 8000, "watcher seat request at host");
    bh.send({ type: "seat-respond", requestId: bwReq.requestId, accept: true });
    await waitFor("watcher becomes a speaker", () => bodyText().includes("Mic khula hai") || bodyText().includes("could not open"));
    check("accepted watcher sees speaker controls with the mic OPEN", bodyText().includes("🎙️ Mic khula hai"));
    check(
      "broad speaker capture was AUDIO ONLY (video was never requested)",
      dom.window.__gumCalls.length >= 1 && dom.window.__gumCalls.every((c) => c.audio && !c.video),
      JSON.stringify(dom.window.__gumCalls).slice(0, 160)
    );
    dom.window.close();
  } catch (err) {
    check(`jsdom broad watch check (${err.message})`, false);
  }

  // ---- jsdom: host side — Go Broad setup + stage + accept ----
  try {
    const bh3 = await mkB("bhost3", "Broad Host Three");
    const indexHtml = fs.readFileSync(path.join(DIST_DIR, "index.html"), "utf8");
    const bundleName = fs.readdirSync(path.join(DIST_DIR, "assets")).find((f) => f.endsWith(".js"));
    const bundle = fs.readFileSync(path.join(DIST_DIR, "assets", bundleName), "utf8");
    const dom = new JSDOM(indexHtml, {
      url: `${BASE}/`,
      runScripts: "dangerously",
      pretendToBeVisual: true,
      beforeParse(window) {
        window.localStorage.setItem("zoomly_token", bh3.token);
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
        window.__gumCalls = [];
        const fakeTrack = (kind) => ({
          kind,
          enabled: true,
          readyState: "live",
          stop() {
            this.readyState = "ended";
          },
          getSettings: () => ({}),
        });
        window.MediaStream = class FakeMediaStream {
          constructor(tracks = []) {
            this._tracks = [...tracks];
          }
          getTracks() {
            return [...this._tracks];
          }
          getVideoTracks() {
            return this._tracks.filter((t) => t.kind === "video");
          }
          getAudioTracks() {
            return this._tracks.filter((t) => t.kind === "audio");
          }
          addTrack(t) {
            this._tracks.push(t);
          }
        };
        Object.defineProperty(window.navigator, "mediaDevices", {
          configurable: true,
          value: {
            getUserMedia: async (constraints = {}) => {
              window.__gumCalls.push(constraints);
              const tracks = [];
              if (constraints.audio) tracks.push(fakeTrack("audio"));
              if (constraints.video) tracks.push(fakeTrack("video"));
              return new window.MediaStream(tracks);
            },
          },
        });
        window.RTCPeerConnection = class FakePC {
          constructor() {
            this.connectionState = "new";
            this.iceConnectionState = "new";
            this.localDescription = null;
            this.remoteDescription = null;
          }
          addTrack() {}
          async createOffer() {
            return { type: "offer", sdp: "fake" };
          }
          async createAnswer() {
            return { type: "answer", sdp: "fake" };
          }
          async setLocalDescription(d) {
            this.localDescription = d;
          }
          async setRemoteDescription(d) {
            this.remoteDescription = d;
          }
          async addIceCandidate() {}
          close() {
            this.connectionState = "closed";
          }
        };
      },
    });
    const { document } = dom.window;
    const bodyText = () => document.body?.textContent || "";
    const waitFor = async (desc, pred, timeoutMs = 25000) => {
      const t0 = Date.now();
      for (;;) {
        if (pred()) return;
        if (Date.now() - t0 > timeoutMs) throw new Error(`Timed out waiting for: ${desc}`);
        await sleep(200);
      }
    };
    const click = (el) => el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    dom.window.eval(bundle);
    await waitFor("broad host app boot", () => bodyText().includes("For You") || bodyText().includes("could not open"));
    const navLiveBtn = [...document.querySelectorAll("nav button")].find((b) => (b.textContent || "").includes("Live"));
    click(navLiveBtn);
    await waitFor("Live tab", () => bodyText().includes("shuru karo") || bodyText().includes("could not open"));
    const goLiveBtn = [...document.querySelectorAll("button")].find((b) => !b.closest("nav") && (b.textContent || "").includes("shuru karo"));
    click(goLiveBtn);
    await waitFor("go-live setup", () => Boolean(document.querySelector('[data-live-mode="broad"]')) || bodyText().includes("could not open"));
    const broadModeBtn = document.querySelector('[data-live-mode="broad"]');
    check("setup offers the 🎙️ Broad (sirf awaz) mode", Boolean(broadModeBtn));
    click(broadModeBtn);
    await waitFor("broad setup panel", () => bodyText().includes("Mic on karo") || bodyText().includes("could not open"));
    const micBtn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("Mic on karo"));
    click(micBtn);
    await waitFor("mic captured", () => bodyText().includes("Mic tayyar hai"));
    check(
      "broad setup captured AUDIO ONLY (camera never requested)",
      dom.window.__gumCalls.length === 1 && dom.window.__gumCalls.every((c) => c.audio && !c.video),
      JSON.stringify(dom.window.__gumCalls).slice(0, 160)
    );
    const startBroadBtn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("Start Broad"));
    await waitFor("Start Broad enabled", () => startBroadBtn && !startBroadBtn.disabled);
    click(startBroadBtn);
    await waitFor("broad host room", () => Boolean(document.querySelector("[data-broad-stage]")) || bodyText().includes("could not open"));
    check("broad host room renders the seats stage", Boolean(document.querySelector("[data-broad-stage]")) && bodyText().includes("End Broad"));
    const hostCell = document.querySelector("[data-broad-host]");
    check("host's own seat shows the mic OPEN", hostCell?.getAttribute("data-seat-muted") === "false");
    check("host stage starts with 6 empty seats", document.querySelectorAll('[data-seat-state="empty"]').length === 6);
    // A raw listener joins this host's broad and asks for a seat; the
    // host accepts from the real UI and the stage fills.
    const bh3List = await api("listLive", { token: bh3.token });
    const bh3Sid = bh3List.lives?.find((l) => l.broadcaster?.username === bh3.user.username)?.id;
    check("jsdom host's broad session is listed", Boolean(bh3Sid));
    const bReq2 = await mkB("breq2", "Seat Asker");
    const bReq2Sock = await connectSocket(bReq2.token);
    bReq2Sock.send({ type: "join", liveSessionId: bh3Sid });
    await bReq2Sock.waitFor((m) => m.type === "joined", 8000, "asker joined the jsdom broad");
    bReq2Sock.send({ type: "seat-request" });
    await waitFor("seat request card in the host UI", () => Boolean(document.querySelector("[data-seat-request]")));
    const acceptBtn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("Accept"));
    check("host UI shows the seat request with Accept", Boolean(acceptBtn));
    click(acceptBtn);
    await bReq2Sock.waitFor((m) => m.type === "seat-seated", 8000, "asker seated via host UI");
    check("accepting in the host UI seats the requester", true);
    await waitFor("host stage shows the filled seat", () => document.querySelectorAll('[data-seat-state="filled"]').length === 1);
    check("host stage fills the seat", document.querySelectorAll('[data-seat-state="filled"]').length === 1);
    bReq2Sock.close();
    await api("endLive", { token: bh3.token, live_session_id: bh3Sid });
    dom.window.close();
  } catch (err) {
    check(`jsdom broad host check (${err.message})`, false);
  }

  bh.close();
  bl.close();
  bv.close();
  bg.close();
  bi.close();
  bLateSock.close();
  for (const f of fillers) f.sock.close();
  await api("endLive", { token: bHost.token, live_session_id: bSid });
  await api("endLive", { token: bVid.token, live_session_id: bVidStart.session.id });
} catch (err) {
  check(`broad section (${err.message})`, false);
}

console.log(failures === 0 ? "\nLIVE TEST PASSED ✔" : `\nLIVE TEST FAILED — ${failures} check(s) failed ✗`);
process.exit(failures === 0 ? 0 : 1);
