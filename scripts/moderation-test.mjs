// End-to-end tests for Zoomly moderation (Phase 2A): the word/spam filter,
// community reports with the 3-distinct-reporters auto-hide, the owner
// moderation queue (dismiss / delete / ban / unban), and blocks (feed,
// people, comments, follows, live guest seat, live chat filter).
//
// Boots against an already-running server (BASE_URL):
//   PORT=3106 ADMIN_USERNAME=sajeel TURSO_DATABASE_URL=file:/tmp/zoomly-mod.db npm start
//   BASE_URL=http://localhost:3106 ADMIN_USERNAME=sajeel node scripts/moderation-test.mjs
import { WebSocket } from "ws";

const BASE = process.env.BASE_URL || "http://localhost:3106";
const ADMIN = (process.env.ADMIN_USERNAME || "sajeel").toLowerCase();

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

console.log(`Moderation test against ${BASE} (admin=${ADMIN})`);
const suffix = Math.random().toString(36).slice(2, 8);
const mkUser = async (name) => {
  const res = await api("signup", { username: `${name}_${suffix}`, display_name: `User ${name}`, password: "test-pass-123" });
  if (!res.ok) throw new Error(`signup ${name} failed: ${JSON.stringify(res)}`);
  return { token: res.token, user: res.user };
};
let admin = await api("signup", { username: ADMIN, display_name: "Owner", password: "test-pass-123" });
if (!admin.ok) admin = await api("login", { username: ADMIN, password: "test-pass-123" });
const adminToken = admin.token;
const A = await mkUser("moda"); // content creator
const B = await mkUser("modb");
const C = await mkUser("modc");
const D = await mkUser("modd");

// ---- Word / spam filter --------------------------------------------------------
const postRes = await api("createPost", {
  token: A.token,
  title: "My clean video",
  description: "a nice day out",
  video_url: "https://example.com/v.mp4",
});
check("clean post passes the filter", postRes.ok === true, JSON.stringify(postRes));
const postId = postRes.post.id;

const badTitle = await api("createPost", { token: A.token, title: "my fuck video", video_url: "https://example.com/v2.mp4" });
check("banned word in title rejected", badTitle.ok === false, JSON.stringify(badTitle));

const cleanComment = await api("addComment", { token: B.token, post_id: postId, body: "Nice video, keep it up!" });
check("clean comment passes", cleanComment.ok === true, JSON.stringify(cleanComment));

const badComment = await api("addComment", { token: B.token, post_id: postId, body: "this is shit content" });
check("banned word in comment rejected", badComment.ok === false, JSON.stringify(badComment));

const linkComment = await api("addComment", { token: B.token, post_id: postId, body: "free followers at www.spam-site.com now" });
check("external link in comment rejected (spam)", linkComment.ok === false, JSON.stringify(linkComment));

const phoneComment = await api("addComment", { token: B.token, post_id: postId, body: "call me 03001234567 for followers" });
check("phone-number spam in comment rejected", phoneComment.ok === false, JSON.stringify(phoneComment));

const badName = await api("updateProfile", { token: B.token, display_name: "kutta khan" });
check("banned word in display name rejected", badName.ok === false, JSON.stringify(badName));

const commentsAfter = await api("getComments", { token: A.token, post_id: postId });
check("only the clean comment was stored", commentsAfter.comments?.length === 1, JSON.stringify(commentsAfter.comments));

// ---- Reports + auto-hide at 3 distinct reporters -------------------------------
const feedHasPost = async (token) => {
  const feed = await api("getFeed", { token, stream: "foryou", limit: 30 });
  return feed.posts?.some((p) => p.id === postId);
};
check("post visible in feed before reports", await feedHasPost(C.token));

const rep1 = await api("reportContent", { token: B.token, target_type: "post", target_id: postId, reason: "spam" });
check("first report ok, not hidden", rep1.ok === true && rep1.auto_hidden === false, JSON.stringify(rep1));
const rep1b = await api("reportContent", { token: B.token, target_type: "post", target_id: postId, reason: "abuse", details: "still spam" });
check("re-report updates (does not stack)", rep1b.ok === true && rep1b.auto_hidden === false, JSON.stringify(rep1b));
check("post still visible after 1 distinct reporter", await feedHasPost(C.token));
const rep2 = await api("reportContent", { token: C.token, target_type: "post", target_id: postId, reason: "nudity" });
check("second distinct report, still visible", rep2.ok === true && (await feedHasPost(D.token)), JSON.stringify(rep2));
const rep3 = await api("reportContent", { token: D.token, target_type: "post", target_id: postId, reason: "violence" });
check("third distinct report auto-hides", rep3.ok === true && rep3.auto_hidden === true, JSON.stringify(rep3));
check("hidden post gone from other users' feed", !(await feedHasPost(C.token)));
check("hidden post still visible to its owner", await feedHasPost(A.token));
const ownerFeed = await api("getFeed", { token: A.token, stream: "foryou", limit: 30 });
check("owner's copy is flagged hidden (under review)", ownerFeed.posts?.find((p) => p.id === postId)?.hidden === true);
const ownReport = await api("reportContent", { token: A.token, target_type: "post", target_id: postId, reason: "spam" });
check("reporting your own content is refused", ownReport.ok === false);

// ---- Owner queue: dismiss restores ----------------------------------------------
const nonAdminQueue = await api("getModerationQueue", { token: B.token });
check("non-admin blocked from moderation queue", nonAdminQueue.ok === false);
const queue = await api("getModerationQueue", { token: adminToken });
const group = queue.groups?.find((g) => g.target_type === "post" && g.target_id === postId);
check("queue shows the post group", Boolean(group), JSON.stringify(queue).slice(0, 300));
check("group counts 3 distinct reporters", group?.report_count === 3, `count=${group?.report_count}`);
check("group preview shows title + hidden state", group?.preview?.title === "My clean video" && group?.preview?.hidden === true, JSON.stringify(group?.preview));
check("group carries reporter reasons", Array.isArray(group?.reports) && group.reports.length === 3 && group.reports.every((r) => r.reporter?.username));
const dismiss = await api("moderateContent", { token: adminToken, target_type: "post", target_id: postId, action: "dismiss" });
check("owner dismiss ok", dismiss.ok === true, JSON.stringify(dismiss));
check("dismissed post visible again", await feedHasPost(C.token));

// ---- Owner queue: delete content -------------------------------------------------
for (const u of [B, C, D]) await api("reportContent", { token: u.token, target_type: "post", target_id: postId, reason: "spam" });
check("post auto-hidden again after fresh reports", !(await feedHasPost(C.token)));
const del = await api("moderateContent", { token: adminToken, target_type: "post", target_id: postId, action: "delete_content" });
check("owner delete_content ok", del.ok === true, JSON.stringify(del));
const commentOnGone = await api("addComment", { token: B.token, post_id: postId, body: "hello?" });
check("deleted post is really gone", commentOnGone.ok === false);

// ---- Owner queue: ban + unban -----------------------------------------------------
const post2 = await api("createPost", { token: A.token, title: "Second video", video_url: "https://example.com/v3.mp4" });
const post2Id = post2.post.id;
for (const u of [B, C, D]) await api("reportContent", { token: u.token, target_type: "post", target_id: post2Id, reason: "abuse" });
const ban = await api("moderateContent", { token: adminToken, target_type: "post", target_id: post2Id, action: "ban_user" });
check("owner ban_user ok", ban.ok === true, JSON.stringify(ban));
const bannedLogin = await api("login", { username: A.user.username, password: "test-pass-123" });
check("banned user cannot log in", bannedLogin.ok === false && /banned/i.test(bannedLogin.message || ""), JSON.stringify(bannedLogin));
const bannedMe = await api("getMe", { token: A.token });
check("banned user's existing session stops working", bannedMe.ok === false);
const queue2 = await api("getModerationQueue", { token: adminToken });
const group2 = queue2.groups?.find((g) => g.target_type === "post" && g.target_id === post2Id);
check("queue shows owner as banned", group2?.owner?.banned === true, JSON.stringify(group2?.owner));
const unban = await api("moderateContent", { token: adminToken, target_type: "post", target_id: post2Id, action: "unban_user" });
check("owner unban_user ok", unban.ok === true, JSON.stringify(unban));
const loginAgain = await api("login", { username: A.user.username, password: "test-pass-123" });
check("unbanned user can log in again", loginAgain.ok === true, JSON.stringify(loginAgain));
if (loginAgain.ok) A.token = loginAgain.token;

// ---- Blocks ----------------------------------------------------------------------
const postB = await api("createPost", { token: B.token, title: "B video", video_url: "https://example.com/b.mp4" });
const postC = await api("createPost", { token: C.token, title: "C video", video_url: "https://example.com/c.mp4" });
const follow = await api("toggleFollow", { token: C.token, user_id: B.user.id });
check("C follows B before block", follow.ok === true && follow.following === true, JSON.stringify(follow));
const block = await api("blockUser", { token: B.token, user_id: C.user.id });
check("B blocks C", block.ok === true, JSON.stringify(block));
const cProfileOfB = await api("getProfile", { token: C.token, user_id: B.user.id });
check("block removes the follow", cProfileOfB.profile?.followed_by_me === false, JSON.stringify(cProfileOfB.profile));
check("block hides B's videos from C's profile view", (cProfileOfB.posts ?? []).length === 0);
const refollow = await api("toggleFollow", { token: C.token, user_id: B.user.id });
check("blocked user cannot re-follow", refollow.ok === false);
const blockedComment = await api("addComment", { token: C.token, post_id: postB.post.id, body: "nice one" });
check("blocked user cannot comment on blocker's video", blockedComment.ok === false, JSON.stringify(blockedComment));
const bFeed = await api("getFeed", { token: B.token, stream: "foryou", limit: 30 });
check("blocker's feed hides the blocked user's posts", !bFeed.posts?.some((p) => p.id === postC.post.id));
const bPeople = await api("getPeople", { token: B.token });
check("blocked user disappears from People", !bPeople.people?.some((p) => p.id === C.user.id));
const blockedList = await api("getBlockedUsers", { token: B.token });
check("blocked list shows C", blockedList.blocked?.some((u) => u.id === C.user.id) === true, JSON.stringify(blockedList));
const unblock = await api("unblockUser", { token: B.token, user_id: C.user.id });
check("unblock ok", unblock.ok === true);
const commentAfterUnblock = await api("addComment", { token: C.token, post_id: postB.post.id, body: "nice one" });
check("after unblock, commenting works again", commentAfterUnblock.ok === true, JSON.stringify(commentAfterUnblock));
const userReport = await api("reportContent", { token: D.token, target_type: "user", target_id: A.user.id, reason: "spam" });
check("reporting a user works (no auto-hide for users)", userReport.ok === true && userReport.auto_hidden === false, JSON.stringify(userReport));

// ---- Live: chat filter + guest-seat block -----------------------------------------
const live = await api("startLive", { token: A.token, title: "Mod test live" });
check("A goes live", live.ok === true, JSON.stringify(live));
const sid = live.session.id;
const hostSock = await connectSocket(A.token);
hostSock.send({ type: "join", liveSessionId: sid });
await hostSock.waitFor((m) => m.type === "joined", 8000, "host joined");
const viewSock = await connectSocket(B.token);
viewSock.send({ type: "join", liveSessionId: sid });
await viewSock.waitFor((m) => m.type === "joined", 8000, "viewer joined");

viewSock.send({ type: "chat", text: "hello everyone" });
const relayed = await hostSock.waitFor((m) => m.type === "chat" && m.text === "hello everyone", 8000, "clean chat relay");
check("clean live chat relays", Boolean(relayed));
const hostMsgCountBefore = hostSock.messages.filter((m) => m.type === "chat").length;
viewSock.send({ type: "chat", text: "you are a bitch" });
const chatErr = await viewSock.waitFor((m) => m.type === "error" && /allowed nahi/i.test(m.message || ""), 8000, "chat filter error");
check("banned word in live chat rejected to sender", Boolean(chatErr));
await sleep(500);
check("filtered chat never reached the room", hostSock.messages.filter((m) => m.type === "chat").length === hostMsgCountBefore);
viewSock.send({ type: "chat", text: "visit cheap-followers.net for likes" });
const linkErr = await viewSock.waitFor((m) => m.type === "error", 8000, "chat link error");
check("spam link in live chat rejected", Boolean(linkErr));

// Host blocks the viewer -> guest request must fail; unblock -> it goes through.
await api("blockUser", { token: A.token, user_id: B.user.id });
viewSock.send({ type: "guest-request" });
const guestErr = await viewSock.waitFor((m) => m.type === "error" && /guest/i.test(m.message || ""), 8000, "guest block error");
check("blocked viewer cannot request the guest seat", Boolean(guestErr));
check("host got no guest request from blocked viewer", !hostSock.messages.some((m) => m.type === "guest-request"));
await api("unblockUser", { token: A.token, user_id: B.user.id });
viewSock.send({ type: "guest-request" });
const guestReq = await hostSock.waitFor((m) => m.type === "guest-request", 8000, "guest request after unblock");
check("after unblock the guest request reaches the host", Boolean(guestReq));

hostSock.close();
viewSock.close();
await api("endLive", { token: A.token, live_session_id: sid });

console.log(failures === 0 ? "\nMODERATION TEST PASSED ✔" : `\nMODERATION TEST FAILED — ${failures} check(s) failed ✗`);
process.exit(failures === 0 ? 0 : 1);
