// End-to-end smoke test for Zoomly. Boots against an already-running server
// (BASE_URL) and exercises the key flows:
//   signup (x2, admin via ADMIN_USERNAME), referral at signup (links only —
//   referrals mint NO coins), login, create post metadata, like, comment,
//   follow, referral double-claim rejection, coin request, duplicate TID
//   rejection, admin approve (coins credited), leaderboards shape (<= 50 rows),
//   DP avatar field round-trip.
// Usage:  BASE_URL=http://localhost:3100 ADMIN_USERNAME=sajeel npm run smoke
const BASE = process.env.BASE_URL || "http://localhost:3100";
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

const suffix = Math.random().toString(36).slice(2, 8);
const adminName = ADMIN; // signup with the exact admin username
const userB = `fan_${suffix}`;

console.log(`Smoke test against ${BASE} (admin=${adminName}, user=${userB})`);

// Health
const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
check("health ok", health.ok === true);

// Signup admin (first time may already exist in a reused DB -> fall back to login)
let admin = await api("signup", { username: adminName, display_name: "Sajeel", password: "test-pass-123" });
if (!admin.ok) admin = await api("login", { username: adminName, password: "test-pass-123" });
check("admin signup/login", admin.ok === true, JSON.stringify(admin));
const adminToken = admin.token;
const adminCode = admin.user.referral_code;
check("admin has referral code", /^ZOOM-\d+-/.test(adminCode), adminCode);
check("admin flagged is_admin", admin.user.is_admin === true);

// Signup user B WITH admin's referral code -> linked as a referral, but
// NO coins are minted for either side (referrals are count-only now).
const before = (await api("getMe", { token: adminToken })).user.coin_balance;
const bSignup = await api("signup", { username: userB, display_name: "Test Fan", password: "test-pass-123", referral_code: adminCode });
check("user B signup with referral", bSignup.ok === true, JSON.stringify(bSignup));
check("user B got NO free welcome coins", bSignup.user.coin_balance === 0, `balance=${bSignup.user.coin_balance}`);
const bToken = bSignup.token;
const adminAfter = (await api("getMe", { token: adminToken })).user;
check("admin got NO referral coins", adminAfter.coin_balance === before, `before=${before} after=${adminAfter.coin_balance}`);
check("admin referral count is >= 1", adminAfter.referral_count >= 1);

// Double claim must fail
const again = await api("claimReferral", { token: bToken, code: adminCode });
check("second referral claim rejected", again.ok === false, JSON.stringify(again));

// Login flow
const bLogin = await api("login", { username: userB, password: "test-pass-123" });
check("user B login", bLogin.ok === true && Boolean(bLogin.token));
const badLogin = await api("login", { username: userB, password: "wrong-password" });
check("wrong password rejected", badLogin.ok === false);

// Create post metadata (video itself would come from /api/upload -> Cloudinary)
const post = await api("createPost", {
  token: adminToken,
  title: "Smoke test video",
  description: "posted by the smoke test",
  video_url: "https://example.com/smoke.mp4",
  thumbnail_url: "https://example.com/smoke.jpg",
});
check("create post", post.ok === true, JSON.stringify(post));
const postId = post.post?.id;

// Feed contains the post with author avatar field present (DP field)
const feed = await api("getFeed", { token: bToken, stream: "foryou" });
const feedPost = feed.posts?.find((p) => p.id === postId);
check("feed returns the post", Boolean(feedPost));
check("post author has avatar_url field (DP)", feedPost && "avatar_url" in feedPost.author);

// Like + comment + follow from B
const like = await api("toggleLike", { token: bToken, post_id: postId });
check("like works", like.ok === true && like.liked === true && like.like_count === 1, JSON.stringify(like));
const comment = await api("addComment", { token: bToken, post_id: postId, body: "Nice video!" });
check("comment works", comment.ok === true && comment.comment?.body === "Nice video!");
const comments = await api("getComments", { token: bToken, post_id: postId });
check("comments list returns it", comments.ok === true && comments.comments.length >= 1);
const follow = await api("toggleFollow", { token: bToken, user_id: admin.user.id });
check("follow works", follow.ok === true && follow.following === true && follow.follower_count >= 1, JSON.stringify(follow));
const followingFeed = await api("getFeed", { token: bToken, stream: "following" });
check("following feed has the post", followingFeed.posts?.some((p) => p.id === postId) === true);

// DP round-trip: set avatar URL (stands in for the Cloudinary URL) and read it back
const setDp = await api("setAvatar", { token: bToken, avatar_url: "https://example.com/dp.jpg", avatar_public_id: "zoomly/avatars/test" });
check("setAvatar ok", setDp.ok === true && setDp.user.avatar_url === "https://example.com/dp.jpg", JSON.stringify(setDp));
const bProfile = await api("getProfile", { token: bToken, user_id: bLogin.user.id });
check("profile shows DP", bProfile.profile?.avatar_url === "https://example.com/dp.jpg");

// Coin request: pack 0 = 100 coins / Rs.100
const tid = `TID${Date.now()}`;
const req = await api("requestCoins", { token: bToken, pack_index: 0, tid });
check("coin request created", req.ok === true, JSON.stringify(req));
const dup = await api("requestCoins", { token: bToken, pack_index: 0, tid });
check("duplicate TID rejected", dup.ok === false, JSON.stringify(dup));

// Admin approves -> B balance 0 + 100 = 100
const pending = await api("getAdminCoinRequests", { token: adminToken });
const myReq = pending.requests?.find((r) => r.tid === tid);
check("admin sees pending request", Boolean(myReq) && myReq.status === "pending", JSON.stringify(pending).slice(0, 200));
const nonAdmin = await api("getAdminCoinRequests", { token: bToken });
check("non-admin blocked from admin view", nonAdmin.ok === false);
const review = await api("reviewCoinRequest", { token: adminToken, request_id: myReq.id, decision: "approved" });
check("admin approve ok", review.ok === true, JSON.stringify(review));
const bAfter = (await api("getMe", { token: bToken })).user;
check("coins credited after approve (100)", bAfter.coin_balance === 100, `balance=${bAfter.coin_balance}`);
check("level after 100 coins is Bronze", bAfter.level === "Bronze", bAfter.level);
const reReview = await api("reviewCoinRequest", { token: adminToken, request_id: myReq.id, decision: "approved" });
check("double approve rejected", reReview.ok === false);

// ---- Custom coin buy (any amount >= 10 at 1 coin = Rs.1) ----------------------
const customTid = `CUSTOM-${Date.now()}`;
const customReq = await api("requestCustomCoins", { token: bToken, coins: 37, tid: customTid });
check("custom coin request ok", customReq.ok === true, JSON.stringify(customReq));
const tooSmall = await api("requestCustomCoins", { token: bToken, coins: 5, tid: `SMALL-${Date.now()}` });
check("custom request under 10 coins rejected", tooSmall.ok === false, JSON.stringify(tooSmall));
const dupCustom = await api("requestCustomCoins", { token: bToken, coins: 50, tid: customTid });
check("custom request duplicate TID rejected", dupCustom.ok === false);
const pendingCustom = await api("getAdminCoinRequests", { token: adminToken });
const myCustom = pendingCustom.requests?.find((r) => r.tid === customTid);
check("admin sees custom request (37 coins = Rs.37, flagged custom)", Boolean(myCustom) && myCustom.pack_coins === 37 && myCustom.price_pkr === 37 && myCustom.is_custom === true, JSON.stringify(myCustom));
const reviewCustom = await api("reviewCoinRequest", { token: adminToken, request_id: myCustom.id, decision: "approved" });
check("admin approve custom ok", reviewCustom.ok === true, JSON.stringify(reviewCustom));
const bAfterCustom = (await api("getMe", { token: bToken })).user;
check("custom coins credited after approve (137)", bAfterCustom.coin_balance === 137, `balance=${bAfterCustom.coin_balance}`);

// ---- Withdrawals: hold at request, reject refunds, approve finalizes ---------
// B has 137 coins. Withdraw 100 -> held immediately (balance 37).
const wd1 = await api("requestWithdrawal", { token: bToken, coins: 100, jazzcash_number: "03001234567", account_title: "Test Fan" });
check("withdrawal request ok", wd1.ok === true, JSON.stringify(wd1));
check("hold deducted at request (balance 37)", wd1.my_balance === 37, `my_balance=${wd1.my_balance}`);
check("withdrawal amount_pkr equals coins", wd1.withdrawal?.amount_pkr === 100 && wd1.withdrawal?.status === "pending", JSON.stringify(wd1.withdrawal));
const wdOver = await api("requestWithdrawal", { token: bToken, coins: 50, jazzcash_number: "03001234567" });
check("over-balance withdrawal rejected (held coins not double-spendable)", wdOver.ok === false, JSON.stringify(wdOver));
const wdSmall = await api("requestWithdrawal", { token: bToken, coins: 5, jazzcash_number: "03001234567" });
check("withdrawal under 10 coins rejected", wdSmall.ok === false);
const wdBadNumber = await api("requestWithdrawal", { token: bToken, coins: 10, jazzcash_number: "12345678901" });
check("withdrawal with invalid JazzCash number rejected", wdBadNumber.ok === false);
const wdNonAdmin = await api("reviewWithdrawal", { token: bToken, withdrawal_id: wd1.withdrawal.id, decision: "approved" });
check("non-admin cannot review withdrawals", wdNonAdmin.ok === false);
const adminWdView = await api("getAdminCoinRequests", { token: adminToken });
const myWd = adminWdView.withdrawals?.find((w) => w.id === wd1.withdrawal.id);
check("admin sees pending withdrawal with JazzCash number", Boolean(myWd) && myWd.jazzcash_number === "03001234567" && myWd.coins === 100 && myWd.requester?.username === userB, JSON.stringify(myWd));
// Reject -> the 100 held coins are refunded (balance back to 137).
const wdReject = await api("reviewWithdrawal", { token: adminToken, withdrawal_id: wd1.withdrawal.id, decision: "rejected" });
check("admin reject ok", wdReject.ok === true, JSON.stringify(wdReject));
const bAfterReject = (await api("getMe", { token: bToken })).user;
check("reject refunds held coins (137)", bAfterReject.coin_balance === 137, `balance=${bAfterReject.coin_balance}`);
// Withdraw 30 again -> approve -> coins stay deducted (balance 107).
const wd2 = await api("requestWithdrawal", { token: bToken, coins: 30, jazzcash_number: "03001234567" });
check("second withdrawal ok (balance 107 on hold)", wd2.ok === true && wd2.my_balance === 107, JSON.stringify(wd2));
const wdApprove = await api("reviewWithdrawal", { token: adminToken, withdrawal_id: wd2.withdrawal.id, decision: "approved" });
check("admin approve withdrawal ok", wdApprove.ok === true, JSON.stringify(wdApprove));
const bAfterApprove = (await api("getMe", { token: bToken })).user;
check("approve keeps coins deducted (107)", bAfterApprove.coin_balance === 107, `balance=${bAfterApprove.coin_balance}`);
const wdDouble = await api("reviewWithdrawal", { token: adminToken, withdrawal_id: wd2.withdrawal.id, decision: "approved" });
check("double review of withdrawal rejected", wdDouble.ok === false);
const rewardsAfterWd = await api("getRewards", { token: bToken });
check("my withdrawals listed with final statuses", Array.isArray(rewardsAfterWd.my_withdrawals) && rewardsAfterWd.my_withdrawals.some((w) => w.id === wd2.withdrawal.id && w.status === "approved") && rewardsAfterWd.my_withdrawals.some((w) => w.id === wd1.withdrawal.id && w.status === "rejected"));

// Rewards + leaderboards shape
const rewards = await api("getRewards", { token: bToken });
check("rewards ok", rewards.ok === true, JSON.stringify(rewards).slice(0, 200));
check("jazzcash number shown", rewards.jazzcash?.number === "03266040350", rewards.jazzcash?.number);
check("5 packs", Array.isArray(rewards.packs) && rewards.packs.length === 5);
check("top_coins <= 50 rows", Array.isArray(rewards.leaderboards?.top_coins) && rewards.leaderboards.top_coins.length <= 50);
check("top_referrals <= 50 rows", Array.isArray(rewards.leaderboards?.top_referrals) && rewards.leaderboards.top_referrals.length <= 50);
const topRow = rewards.leaderboards?.top_coins?.[0];
check("leaderboard row shape (rank/id/avatar)", Boolean(topRow) && topRow.rank === 1 && "id" in topRow && "avatar_url" in topRow, JSON.stringify(topRow).slice(0, 200));
check("top_coins rows are anonymous (no name/username sent; DP + balance + level kept)", Boolean(topRow) && !("username" in topRow) && !("display_name" in topRow) && "coin_balance" in topRow && "level" in topRow, JSON.stringify(topRow).slice(0, 200));
const topRefRow = rewards.leaderboards?.top_referrals?.[0];
check("top_referrals rows keep name/username", Boolean(topRefRow) && "username" in topRefRow && "display_name" in topRefRow, JSON.stringify(topRefRow).slice(0, 200));

// Upload without Cloudinary configured must fail with a clear message
const form = new FormData();
form.append("token", bToken);
form.append("kind", "video");
form.append("file", new Blob(["not-a-video"], { type: "video/mp4" }), "x.mp4");
const up = await fetch(`${BASE}/api/upload`, { method: "POST", body: form }).then((r) => r.json());
if (health.media_configured) {
  console.log("  ~ media_configured=true on this server — skipping the unconfigured-upload check");
} else {
  check("upload blocked with clear message when Cloudinary unconfigured", up.ok === false && /not configured/i.test(up.message || ""), JSON.stringify(up));
}

// Cleanup: delete the smoke post
const del = await api("deletePost", { token: adminToken, post_id: postId });
check("delete own post", del.ok === true);

console.log(failures === 0 ? "\nSMOKE TEST PASSED ✔" : `\nSMOKE TEST FAILED — ${failures} check(s) failed ✗`);
process.exit(failures === 0 ? 0 : 1);
