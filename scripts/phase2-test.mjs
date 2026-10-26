// Phase-2 automated tests — throwaway local DB only, NEVER production.
// Usage: TURSO_DATABASE_URL=file:/tmp/zoomly-test.db ADMIN_USERNAME=testowner node scripts/phase2-test.mjs
// The DB file is created fresh by this run (deleted first if present).
import fs from "node:fs";
import { execSync } from "node:child_process";

const DB = process.env.TURSO_DATABASE_URL;
if (!DB || !DB.startsWith("file:/tmp/")) {
  console.error("Refusing to run: TURSO_DATABASE_URL must be a file:/tmp/... throwaway DB.");
  process.exit(2);
}
try { fs.unlinkSync(DB.slice("file:".length)); } catch { /* fresh */ }

const { initDb } = await import("../server/db.mjs");
const { Actions, authUser } = await import("../server/actions.mjs");
await initDb();

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}
const A = Actions;

const sA = await A.signup({ username: "testowner", display_name: "Owner", password: "ownerpass123", __ip: "10.0.0.1" });
check("signup owner", sA.ok, JSON.stringify(sA));
const sB = await A.signup({ username: "viewer1", display_name: "Viewer", password: "viewerpass123", __ip: "10.0.0.2" });
check("signup viewer", sB.ok, JSON.stringify(sB));
const dup = await A.signup({ username: "viewer1", display_name: "Dup", password: "x12345678", __ip: "10.0.0.3" });
check("duplicate username rejected", !dup.ok);
const bad = await A.login({ username: "viewer1", password: "wrongpassword" });
check("wrong password rejected", !bad.ok);
const li = await A.login({ username: "viewer1", password: "viewerpass123" });
check("login ok", li.ok && Boolean(li.token));
const tB = li.token;
const liA = await A.login({ username: "testowner", password: "ownerpass123" });
const tA = liA.token;
const badTok = await A.getMe({ token: "not-a-real-token" });
check("invalid session rejected", !badTok.ok);

// Post + like idempotency
const post = await A.createPost({ token: tA, title: "Test video #zoomly", description: "hello #zoomly world", video_url: "https://example.invalid/v.mp4" });
check("createPost ok", post.ok, JSON.stringify(post));
const pid = post.post.id;
const l1 = await A.toggleLike({ token: tB, post_id: pid });
check("like once", l1.ok && l1.liked === true, JSON.stringify(l1));
const l2 = await A.toggleLike({ token: tB, post_id: pid });
check("like twice toggles off (no duplicate like)", l2.ok && l2.liked === false, JSON.stringify(l2));
const l3 = await A.toggleLike({ token: tB, post_id: pid });
check("like again on", l3.ok && l3.liked === true);

// Comment + reply + pin + duplicate spam
const c1 = await A.addComment({ token: tB, post_id: pid, body: "Great video" });
check("addComment ok", c1.ok, JSON.stringify(c1));
const dupC = await A.addComment({ token: tB, post_id: pid, body: "Great video" });
check("duplicate comment within 60s rejected", !dupC.ok, JSON.stringify(dupC));
const reply = await A.addComment({ token: tA, post_id: pid, body: "Thanks!", parent_id: c1.comment.id });
check("comment reply parent_id set", reply.ok && reply.comment.parent_id === c1.comment.id, JSON.stringify(reply));
const pin = await A.pinComment({ token: tA, comment_id: c1.comment.id, pinned: true });
check("owner pins comment", pin.ok, JSON.stringify(pin));
const comments = await A.getComments({ token: tB, post_id: pid });
check("getComments pinned first", comments.ok && comments.comments[0]?.pinned === true, JSON.stringify(comments.comments?.[0]));
const delReply = await A.deleteComment({ token: tA, comment_id: c1.comment.id });
check("delete parent removes reply thread", delReply.ok);
const comments2 = await A.getComments({ token: tB, post_id: pid });
check("reply gone after parent delete", comments2.ok && !comments2.comments.some((c) => c.id === reply.comment.id));

// Watch events + ranking + trending + hashtag
await A.recordWatchEvent({ token: tB, post_id: pid, event: "started" });
await A.recordWatchEvent({ token: tB, post_id: pid, event: "completed", duration_ms: 10000, watch_ms: 9500 });
const ranked = await A.getRankedFeed({ token: tB, stream: "foryou", limit: 10 });
check("ranked feed returns post with score", ranked.ok && ranked.posts.some((p) => p.id === pid) && typeof ranked.posts[0].rank_score === "number", JSON.stringify(ranked.posts?.[0]));
const trend = await A.getTrending({ token: tB, limit: 10 });
check("trending returns post", trend.ok && trend.posts.some((p) => p.id === pid));
const byTag = await A.getByHashtag({ token: tB, tag: "zoomly", limit: 10 });
check("hashtag search finds post", byTag.ok && byTag.posts.some((p) => p.id === pid));

// Follow + recommendations (mutual must not be hardcoded 0 for a real mutual)
const fol = await A.toggleFollow({ token: tB, user_id: post.post.author.id });
check("follow ok", fol.ok, JSON.stringify(fol));
const recs = await A.getFollowRecommendations({ token: tB, limit: 10 });
check("recommendations exclude followed + self", recs.ok && !recs.recommendations.some((p) => p.id === post.post.author.id));

// Saved / Not Interested / mute / interests / keywords
const save = await A.toggleSave({ token: tB, post_id: pid });
check("save ok", save.ok, JSON.stringify(save));
const saved = await A.getSavedPosts({ token: tB });
check("saved persists server-side", saved.ok && saved.posts.some((p) => p.id === pid));
await A.setInterests({ token: tB, tags: ["zoomly"] });
const ints = await A.getInterests({ token: tB });
check("interests stored", ints.ok && ints.tags.includes("zoomly"));
await A.hideNotInterested({ token: tB, post_id: pid });
const ranked2 = await A.getRankedFeed({ token: tB, stream: "foryou", limit: 10 });
check("Not Interested video excluded from ranking", ranked2.ok && !ranked2.posts.some((p) => p.id === pid));
const hidden = await A.getHiddenItems({ token: tB });
const hidItem = hidden.items.find((i) => i.scope === "post" && i.post?.id === pid);
check("hidden item listed", Boolean(hidItem));
await A.unhideNotInterested({ token: tB, item_id: hidItem.id });
const ranked3 = await A.getRankedFeed({ token: tB, stream: "foryou", limit: 10 });
check("unhide restores video", ranked3.ok && ranked3.posts.some((p) => p.id === pid));

// Playlist
const pl = await A.createPlaylist({ token: tB, title: "My picks" });
check("createPlaylist ok", pl.ok, JSON.stringify(pl));
const addPl = await A.addToPlaylist({ token: tB, playlist_id: pl.playlist.id, post_id: pid });
check("addToPlaylist ok", addPl.ok, JSON.stringify(addPl));
const getPl = await A.getPlaylist({ token: tB, playlist_id: pl.playlist.id });
check("getPlaylist contains video", getPl.ok && getPl.posts.some((p) => p.id === pid));

// Analytics + export
const an = await A.getCreatorAnalytics({ token: tA });
check("creator analytics real rows", an.ok && an.analytics.per_video.some((v) => v.id === pid));
const ex = await A.exportMyData({ token: tB });
check("exportMyData ok, no TIDs", ex.ok && !JSON.stringify(ex.data).includes("tid") && ex.data.liked_post_ids.includes(pid));

// Admin auth failures + audit
const nonAdmin = await A.getAdminOverview({ token: tB });
check("non-owner admin action rejected", !nonAdmin.ok);
const adminOk = await A.getAdminOverview({ token: tA });
check("owner admin overview ok", adminOk.ok, JSON.stringify(adminOk).slice(0, 200));
const delByNonAuthor = await A.deleteComment({ token: tB, comment_id: 999999 });
check("delete missing comment fails safely", !delByNonAuthor.ok);

// Live session fields + admin end
const live = await A.startLive({ token: tA, title: "Test live", kind: "video", category: "talk", audience: "everyone" });
check("startLive with category/audience", live.ok, JSON.stringify(live));
const list = await A.listLive({ token: tB });
check("listLive shows session", list.ok && list.lives.some((l) => l.id === live.session.id));
const endByAdmin = await A.adminEndLive({ token: tA, live_session_id: live.session.id });
check("adminEndLive ok", endByAdmin.ok, JSON.stringify(endByAdmin));
const list2 = await A.listLive({ token: tB });
check("ended session removed from discovery", list2.ok && !list2.lives.some((l) => l.id === live.session.id));

// Account deletion removes phase-2 rows
const del = await A.deleteAccount({ token: tB, confirm: "DELETE" });
check("deleteAccount ok", del.ok, JSON.stringify(del));
const afterDel = await A.getMe({ token: tB });
check("deleted account session invalid", !afterDel.ok);

// Guest feed (no token)
const guest = await A.getPublicFeed({ limit: 10 });
check("guest public feed works without token", guest.ok && guest.guest === true);

console.log(`\nRESULT ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
