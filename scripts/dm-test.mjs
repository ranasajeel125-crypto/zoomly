// End-to-end tests for Zoomly direct messages (Phase 3F): send/receive,
// conversation list with unread counts, read marking, block enforcement,
// the word filter, and self-DM rejection. Delivery to an open chat is by
// polling getMessages (the WS hub is broadcast-room based).
//
//   PORT=3110 ADMIN_USERNAME=sajeel TURSO_DATABASE_URL=file:/tmp/zoomly-dm.db npm start
//   BASE_URL=http://localhost:3110 node scripts/dm-test.mjs

const BASE = process.env.BASE_URL || "http://localhost:3110";

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

console.log(`DM test against ${BASE}`);
const suffix = Math.random().toString(36).slice(2, 8);
const mkUser = async (name) => {
  const res = await api("signup", { username: `${name}_${suffix}`, display_name: `User ${name}`, password: "test-pass-123" });
  if (!res.ok) throw new Error(`signup ${name} failed`);
  return { token: res.token, user: res.user };
};
const A = await mkUser("dma");
const B = await mkUser("dmb");

// Empty inbox at the start.
let convs = await api("getConversations", { token: A.token });
check("inbox starts empty", convs.ok === true && convs.conversations.length === 0, JSON.stringify(convs));

// Send A -> B.
const sent = await api("sendMessage", { token: A.token, user_id: B.user.id, body: "hello B, kya haal hai?" });
check("message sent", sent.ok === true && sent.chat_message?.body === "hello B, kya haal hai?", JSON.stringify(sent));

// B's inbox: one conversation with A, unread 1, latest message preview.
convs = await api("getConversations", { token: B.token });
const convB = convs.conversations?.find((c) => c.user.id === A.user.id);
check("B sees the conversation", Boolean(convB), JSON.stringify(convs.conversations));
check("B unread count is 1", convB?.unread === 1, JSON.stringify(convB));
check("latest preview matches", convB?.latest.body === "hello B, kya haal hai?" && convB.latest.is_mine === false);
let meB = await api("getMe", { token: B.token });
check("getMe unread_messages is 1", meB.user?.unread_messages === 1, JSON.stringify(meB.user?.unread_messages));

// B opens the thread -> messages marked read.
const thread = await api("getMessages", { token: B.token, user_id: A.user.id });
check("thread has the message", thread.ok === true && thread.messages.length === 1 && thread.messages[0].body === "hello B, kya haal hai?", JSON.stringify(thread));
meB = await api("getMe", { token: B.token });
check("getMe unread_messages back to 0 after reading", meB.user?.unread_messages === 0, JSON.stringify(meB.user?.unread_messages));
convs = await api("getConversations", { token: B.token });
check("conversation unread cleared", convs.conversations?.find((c) => c.user.id === A.user.id)?.unread === 0);

// A can see B read it.
const threadA = await api("getMessages", { token: A.token, user_id: B.user.id });
check("sender sees the message as read", threadA.messages?.[0]?.read === true && threadA.messages[0].is_mine === true, JSON.stringify(threadA.messages));

// Reply B -> A; ordering stays chronological.
const reply = await api("sendMessage", { token: B.token, user_id: A.user.id, body: "theek hoon bhai" });
check("reply sent", reply.ok === true);
const thread2 = await api("getMessages", { token: A.token, user_id: B.user.id });
check("thread is chronological (2 messages)", thread2.messages?.length === 2 && thread2.messages[0].body.startsWith("hello") && thread2.messages[1].body === "theek hoon bhai", JSON.stringify(thread2.messages));

// Rejections: self-DM, banned word, empty body (validation).
const self = await api("sendMessage", { token: A.token, user_id: A.user.id, body: "note to self" });
check("self-DM rejected", self.ok === false, JSON.stringify(self));
const bad = await api("sendMessage", { token: A.token, user_id: B.user.id, body: "you are a fucking idiot" });
check("banned-word DM rejected", bad.ok === false, JSON.stringify(bad));

// Block: A blocks B -> neither can DM the other.
await api("blockUser", { token: A.token, user_id: B.user.id });
const blockedAB = await api("sendMessage", { token: A.token, user_id: B.user.id, body: "still there?" });
check("blocker's DM to the blocked user fails", blockedAB.ok === false, JSON.stringify(blockedAB));
const blockedBA = await api("sendMessage", { token: B.token, user_id: A.user.id, body: "hello?" });
check("blocked user's DM fails too", blockedBA.ok === false, JSON.stringify(blockedBA));
await api("unblockUser", { token: A.token, user_id: B.user.id });
const afterUnblock = await api("sendMessage", { token: B.token, user_id: A.user.id, body: "back again" });
check("DM works again after unblock", afterUnblock.ok === true, JSON.stringify(afterUnblock));

// A DM also creates an in-app notification for the recipient: B got one
// for A's first message; A got them for B's reply + post-unblock message.
const notifs = await api("getNotifications", { token: B.token });
const dmNotifs = (notifs.notifications || []).filter((n) => n.type === "dm");
check("recipient got a DM notification (B)", dmNotifs.length === 1, JSON.stringify(dmNotifs.length));
const notifsA = await api("getNotifications", { token: A.token });
const dmNotifsA = (notifsA.notifications || []).filter((n) => n.type === "dm");
check("recipient got DM notifications (A: reply + post-unblock)", dmNotifsA.length === 2, JSON.stringify(dmNotifsA.length));

console.log(failures === 0 ? "\nDM TEST PASSED ✔" : `\nDM TEST FAILED — ${failures} check(s) failed ✗`);
process.exit(failures === 0 ? 0 : 1);
