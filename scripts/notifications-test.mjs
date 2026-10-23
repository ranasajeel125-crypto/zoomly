// End-to-end tests for Zoomly in-app notifications (Phase 2B): generation
// on like / comment / follow / gift / referral / coin-request and
// withdrawal decisions / live-started-by-a-followee, unread counts via
// getMe + getNotifications, and mark-all-read.
//
//   PORT=3107 ADMIN_USERNAME=sajeel TURSO_DATABASE_URL=file:/tmp/zoomly-notif.db npm start
//   BASE_URL=http://localhost:3107 ADMIN_USERNAME=sajeel node scripts/notifications-test.mjs

const BASE = process.env.BASE_URL || "http://localhost:3107";
const ADMIN = (process.env.ADMIN_USERNAME || "sajeel").toLowerCase();

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

async function api(action, args = {}) {
  const res = await fetch(`${BASE}/api/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  return res.json();
}

console.log(`Notifications test against ${BASE} (admin=${ADMIN})`);
const suffix = Math.random().toString(36).slice(2, 8);
const mkUser = async (name, extra = {}) => {
  const res = await api("signup", { username: `${name}_${suffix}`, display_name: `User ${name}`, password: "test-pass-123", ...extra });
  if (!res.ok) throw new Error(`signup ${name} failed: ${JSON.stringify(res)}`);
  return { token: res.token, user: res.user };
};
let admin = await api("signup", { username: ADMIN, display_name: "Owner", password: "test-pass-123" });
if (!admin.ok) admin = await api("login", { username: ADMIN, password: "test-pass-123" });
const adminToken = admin.token;

const creator = await mkUser("ntcreator");
const fan = await mkUser("ntfan");

// Creator posts a video; fan likes + comments + follows.
const post = await api("createPost", { token: creator.token, title: "Notif video", video_url: "https://example.com/n.mp4" });
const postId = post.post.id;
await api("toggleLike", { token: fan.token, post_id: postId });
await api("addComment", { token: fan.token, post_id: postId, body: "Bohut acha!" });
await api("toggleFollow", { token: fan.token, user_id: creator.user.id });

let inbox = await api("getNotifications", { token: creator.token });
check("creator inbox ok", inbox.ok === true, JSON.stringify(inbox).slice(0, 200));
const types = (inbox.notifications ?? []).map((n) => n.type);
check("like notification created", types.includes("like"), types.join(","));
check("comment notification created with text snapshot", inbox.notifications.some((n) => n.type === "comment" && /commented/.test(n.text) && n.post_id === postId));
check("follow notification created", types.includes("follow"));
check("actor attached to notifications", inbox.notifications.every((n) => n.actor && n.actor.username === fan.user.username));
check("unread count is 3", inbox.unread_count === 3, `unread=${inbox.unread_count}`);
const meCreator = await api("getMe", { token: creator.token });
check("getMe carries unread_notifications", meCreator.user.unread_notifications === 3, `unread=${meCreator.user.unread_notifications}`);

// Self-actions do not notify.
await api("toggleLike", { token: creator.token, post_id: postId });
inbox = await api("getNotifications", { token: creator.token });
check("self-like creates no notification", inbox.unread_count === 3, `unread=${inbox.unread_count}`);

// Referral signup notifies the inviter and pays the +1 coin reward (the
// referred user gets nothing). The referred signup sends its own device id,
// like a real client's browser would.
const referred = await mkUser("ntref", { referral_code: creator.user.referral_code, device_id: `nt-device-${suffix}` });
inbox = await api("getNotifications", { token: creator.token });
check("referral-joined notification created", inbox.notifications.some((n) => n.type === "referral" && n.actor?.username === referred.user.username));
const refNotif = inbox.notifications.find((n) => n.type === "referral" && n.actor?.username === referred.user.username);
check("referral notification mentions the +1 coin", Boolean(refNotif) && /\+1 coin/.test(refNotif.text), refNotif?.text);
check("referral credits inviter +1 coin; referred user gets nothing", referred.user.coin_balance === 0 && (await api("getMe", { token: creator.token })).user.coin_balance === 1);

// Fund the fan (pack 3 = 6000 coins) — the approval itself notifies the fan.
const tid = `NT-${Date.now()}`;
await api("requestCoins", { token: fan.token, pack_index: 3, tid });
const adminReqs = await api("getAdminCoinRequests", { token: adminToken });
const fanReq = adminReqs.requests.find((r) => r.tid === tid);
await api("reviewCoinRequest", { token: adminToken, request_id: fanReq.id, decision: "approved" });
const fanInbox1 = await api("getNotifications", { token: fan.token });
check("coin-request approval notifies the buyer", fanInbox1.notifications.some((n) => n.type === "coin_request" && /approved/.test(n.text)), JSON.stringify(fanInbox1.notifications).slice(0, 200));

// Gift during a live: creator receives a gift notification with the 70% share.
const live = await api("startLive", { token: creator.token, title: "Notif live" });
check("creator live started", live.ok === true, JSON.stringify(live));
const gift = await api("sendGift", { token: fan.token, live_session_id: live.session.id, gift_key: "giftbox" });
check("gift sent", gift.ok === true, JSON.stringify(gift));
inbox = await api("getNotifications", { token: creator.token });
const giftNotif = inbox.notifications.find((n) => n.type === "gift");
check("gift notification created", Boolean(giftNotif), JSON.stringify(inbox.notifications).slice(0, 200));
check("gift notification carries the creator share (70)", giftNotif?.coins === 70, `coins=${giftNotif?.coins}`);
await api("endLive", { token: creator.token, live_session_id: live.session.id });

// Live-started fanout: a follower is told when the creator goes live again.
const live2 = await api("startLive", { token: creator.token, title: "Second live" });
const fanInbox2 = await api("getNotifications", { token: fan.token });
check("follower notified when creator goes live", fanInbox2.notifications.some((n) => n.type === "live" && n.live_session_id === live2.session.id), JSON.stringify(fanInbox2.notifications).slice(0, 200));
await api("endLive", { token: creator.token, live_session_id: live2.session.id });

// Withdrawal decisions notify: reject refunds + notifies; approve notifies too.
const wd = await api("requestWithdrawal", { token: fan.token, coins: 100, jazzcash_number: "03001234567" });
check("fan withdrawal placed", wd.ok === true, JSON.stringify(wd));
const adminView = await api("getAdminCoinRequests", { token: adminToken });
const wdRow = adminView.withdrawals.find((w) => w.id === wd.withdrawal.id);
await api("reviewWithdrawal", { token: adminToken, withdrawal_id: wdRow.id, decision: "rejected" });
let fanInbox3 = await api("getNotifications", { token: fan.token });
check("withdrawal rejection notifies (with refund wording)", fanInbox3.notifications.some((n) => n.type === "withdrawal" && /rejected/.test(n.text)));
const wd2 = await api("requestWithdrawal", { token: fan.token, coins: 100, jazzcash_number: "03001234567" });
await api("reviewWithdrawal", { token: adminToken, withdrawal_id: wd2.withdrawal.id, decision: "approved" });
fanInbox3 = await api("getNotifications", { token: fan.token });
check("withdrawal approval notifies", fanInbox3.notifications.some((n) => n.type === "withdrawal" && /approved/.test(n.text)));

// Coin-request rejection notifies too.
const tid2 = `NT2-${Date.now()}`;
await api("requestCoins", { token: fan.token, pack_index: 0, tid: tid2 });
const adminReqs2 = await api("getAdminCoinRequests", { token: adminToken });
const fanReq2 = adminReqs2.requests.find((r) => r.tid === tid2);
await api("reviewCoinRequest", { token: adminToken, request_id: fanReq2.id, decision: "rejected" });
const fanInbox4 = await api("getNotifications", { token: fan.token });
check("coin-request rejection notifies", fanInbox4.notifications.some((n) => n.type === "coin_request" && /rejected/.test(n.text)));

// Mark all read.
const before = (await api("getNotifications", { token: creator.token })).unread_count;
check("creator has unread notifications before mark", before > 0, `unread=${before}`);
const marked = await api("markNotificationsRead", { token: creator.token });
check("mark-all-read ok", marked.ok === true && marked.unread_count === 0, JSON.stringify(marked));
const afterInbox = await api("getNotifications", { token: creator.token });
check("unread count is 0 after mark", afterInbox.unread_count === 0 && afterInbox.notifications.every((n) => n.read === true));
const meAfter = await api("getMe", { token: creator.token });
check("getMe unread back to 0", meAfter.user.unread_notifications === 0);

console.log(failures === 0 ? "\nNOTIFICATIONS TEST PASSED ✔" : `\nNOTIFICATIONS TEST FAILED — ${failures} check(s) failed ✗`);
process.exit(failures === 0 ? 0 : 1);
