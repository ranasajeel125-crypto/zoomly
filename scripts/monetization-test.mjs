// End-to-end tests for the Monetization program (owner spec 2026-10-23):
// criteria (18+, 5,000 followers, 50,000 total video views) -> creator
// APPLIES with full name / DOB / JazzCash -> owner approves or rejects ->
// only APPROVED creators can withdraw (owner/admin exempt).
//
// Followers and views are seeded straight into the DB (TEST_DB_URL, the
// same libsql file the server uses): 5,000 dummy followers per creator
// via a recursive CTE, and view counts via UPDATE posts — the API-level
// behaviour under test (apply gates, review, withdraw gate) is all real.
//
//   PORT=3113 ADMIN_USERNAME=sajeel TURSO_DATABASE_URL=file:/tmp/zoomly-monetization.db npm start
//   BASE_URL=http://localhost:3113 ADMIN_USERNAME=sajeel \
//     TEST_DB_URL=file:/tmp/zoomly-monetization.db node scripts/monetization-test.mjs
import { createClient } from "@libsql/client";

const BASE = process.env.BASE_URL || "http://localhost:3113";
const ADMIN = (process.env.ADMIN_USERNAME || "sajeel").toLowerCase();
const DB_URL = process.env.TEST_DB_URL || "file:/tmp/zoomly-monetization.db";

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

const db = createClient({ url: DB_URL });
const suffix = Math.random().toString(36).slice(2, 8);

function dobYearsAgo(years) {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}
const ADULT_DOB = dobYearsAgo(25);

// Seed `count` followers for a user: dummy accounts + follow rows, one
// SQL statement each (recursive CTE), tagged so suites stay independent.
async function seedFollowers(userId, count, tag) {
  const now = Date.now();
  await db.execute({
    sql: `INSERT INTO users (username, display_name, password_hash, referral_code, created_at)
          WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < ?)
          SELECT 'mf_' || ? || '_' || x, 'Seed Fan', 'seeded-no-login', 'ZOOM-MF-' || ? || '-' || x, ? FROM cnt`,
    args: [count, tag, tag, now],
  });
  await db.execute({
    sql: `INSERT INTO follows (follower_id, followee_id, created_at)
          SELECT id, ?, ? FROM users WHERE username LIKE 'mf_' || ? || '_%'`,
    args: [userId, now, tag],
  });
}

async function seedApprovedApplication(userId) {
  const now = Date.now();
  await db.execute({
    sql: `INSERT INTO monetization_applications (user_id, full_name, dob, jazzcash_number, followers_snapshot, views_snapshot, status, created_at, decided_at)
          VALUES (?, 'Seeded Approved', '2000-01-01', '03001234567', 5000, 50000, 'approved', ?, ?)`,
    args: [userId, now, now],
  });
}

async function fundWithCoins(token, adminToken, coins = 100) {
  // pack 0 = 100 coins; approve it as admin.
  const tid = `MON-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const req = await api("requestCoins", { token, pack_index: 0, tid });
  if (!req.ok) throw new Error(`fund request failed: ${JSON.stringify(req)}`);
  const pending = await api("getAdminCoinRequests", { token: adminToken });
  const row = pending.requests?.find((r) => r.tid === tid);
  const review = await api("reviewCoinRequest", { token: adminToken, request_id: row.id, decision: "approved" });
  if (!review.ok) throw new Error(`fund approve failed: ${JSON.stringify(review)}`);
  return coins;
}

const mkUser = async (name) => {
  const res = await api("signup", { username: `${name}_${suffix}`, display_name: `Mon ${name}`, password: "test-pass-123" });
  if (!res.ok) throw new Error(`signup ${name} failed: ${JSON.stringify(res)}`);
  return { token: res.token, user: res.user };
};

console.log(`Monetization test against ${BASE} (admin=${ADMIN})`);

let admin = await api("signup", { username: ADMIN, display_name: "Owner", password: "test-pass-123" });
if (!admin.ok) admin = await api("login", { username: ADMIN, password: "test-pass-123" });
check("admin signup/login", admin.ok === true, JSON.stringify(admin).slice(0, 160));
const adminToken = admin.token;

// ---- 1. fresh user: every criterion unmet, cannot apply ----------------------
const low = await mkUser("monlow");
const lowMon = await api("getMonetization", { token: low.token });
check("getMonetization ok for a fresh user", lowMon.ok === true && Boolean(lowMon.monetization), JSON.stringify(lowMon).slice(0, 200));
const lc = lowMon.monetization?.criteria ?? {};
check("followers criterion 0/5000 unmet", lc.followers?.required === 5000 && lc.followers?.current === 0 && lc.followers?.met === false, JSON.stringify(lc.followers));
check("views criterion 0/50000 unmet", lc.views?.required === 50000 && lc.views?.current === 0 && lc.views?.met === false, JSON.stringify(lc.views));
check("age criterion unmet with no DOB on file (current null)", lc.age?.required === 18 && lc.age?.current === null && lc.age?.met === false, JSON.stringify(lc.age));
check("fresh user: can_apply false, monetized false, no application", lowMon.monetization?.can_apply === false && lowMon.monetization?.monetized === false && lowMon.monetization?.application === null);
const lowRewards = await api("getRewards", { token: low.token });
check("getRewards carries the same monetization object", lowRewards.monetization?.monetized === false && lowRewards.monetization?.criteria?.followers?.required === 5000);
const lowApply = await api("applyForMonetization", { token: low.token, full_name: "Low User Full", dob: ADULT_DOB, jazzcash_number: "03001234567" });
check("below-criteria apply is rejected", lowApply.ok === false, JSON.stringify(lowApply));
check("rejection names the missing criteria", /Followers 0\/5000/.test(lowApply.message || "") && /Video views 0\/50000/.test(lowApply.message || ""), lowApply.message);
const lowAfter = await api("getMonetization", { token: low.token });
check("rejected apply wrote NO application row", lowAfter.monetization?.application === null);

// ---- 2. views are real: one counted view per viewer, never the author's -----
const creator = await mkUser("moncreator");
const fan = await mkUser("monfan");
const post = await api("createPost", { token: creator.token, title: "Monetization journey video", video_url: "https://example.com/mon.mp4" });
check("creator post created", post.ok === true, JSON.stringify(post).slice(0, 160));
const postId = post.post.id;
const view1 = await api("recordPostView", { token: fan.token, post_id: postId });
check("first view by a fan counts", view1.ok === true && view1.counted === true && view1.view_count === 1, JSON.stringify(view1));
const view2 = await api("recordPostView", { token: fan.token, post_id: postId });
check("same viewer again does NOT double-count", view2.ok === true && view2.counted === false && view2.view_count === 1, JSON.stringify(view2));
const viewOwn = await api("recordPostView", { token: creator.token, post_id: postId });
check("author's own view never counts", viewOwn.ok === true && viewOwn.counted === false && viewOwn.view_count === 1, JSON.stringify(viewOwn));
const postAfterViews = await api("getPost", { token: fan.token, post_id: postId });
check("post payload carries view_count 1", postAfterViews.post?.view_count === 1, JSON.stringify(postAfterViews.post?.view_count));
const creatorMon1 = await api("getMonetization", { token: creator.token });
check("creator views progress reads the real sum (1)", creatorMon1.monetization?.criteria?.views?.current === 1, JSON.stringify(creatorMon1.monetization?.criteria?.views));

// ---- 3. seed the creator to the criteria line --------------------------------
await seedFollowers(creator.user.id, 5000, `a${suffix}`);
await db.execute({ sql: "UPDATE posts SET view_count = 50000 WHERE id = ?", args: [postId] });
const creatorMon2 = await api("getMonetization", { token: creator.token });
const cc = creatorMon2.monetization?.criteria ?? {};
check("seeded followers hit exactly 5000 (met)", cc.followers?.current === 5000 && cc.followers?.met === true, JSON.stringify(cc.followers));
check("seeded views hit exactly 50000 (met)", cc.views?.current === 50000 && cc.views?.met === true, JSON.stringify(cc.views));
check("can_apply true once followers + views are met", creatorMon2.monetization?.can_apply === true);

// ---- 4. apply gates: under-18, impossible DOB, bad JazzCash ------------------
const underAge = await api("applyForMonetization", { token: creator.token, full_name: "Young Creator", dob: dobYearsAgo(17), jazzcash_number: "03001234567" });
check("under-18 apply rejected", underAge.ok === false, JSON.stringify(underAge));
check("under-18 message is the plain one", (underAge.message || "").includes("18 saal se kam umar monetization ke liye eligible nahi hai"), underAge.message);
const badDate = await api("applyForMonetization", { token: creator.token, full_name: "Bad Date", dob: "2000-02-30", jazzcash_number: "03001234567" });
check("impossible DOB (Feb 30) rejected", badDate.ok === false && /date of birth/.test(badDate.message || ""), JSON.stringify(badDate));
const futureDob = await api("applyForMonetization", { token: creator.token, full_name: "Future Kid", dob: dobYearsAgo(-1), jazzcash_number: "03001234567" });
check("future DOB rejected", futureDob.ok === false, JSON.stringify(futureDob));
const badNumber = await api("applyForMonetization", { token: creator.token, full_name: "Bad Number", dob: ADULT_DOB, jazzcash_number: "12345678901" });
check("JazzCash number not starting 03 rejected", badNumber.ok === false && /JazzCash/.test(badNumber.message || ""), JSON.stringify(badNumber));
const stillNone = await api("getMonetization", { token: creator.token });
check("failed applies wrote no application", stillNone.monetization?.application === null);

// ---- 5. the real application: pending, one active only -----------------------
const applied = await api("applyForMonetization", { token: creator.token, full_name: "Creator Real Name", dob: ADULT_DOB, jazzcash_number: "03001234567" });
check("eligible adult apply succeeds", applied.ok === true, JSON.stringify(applied));
const pendingMon = await api("getMonetization", { token: creator.token });
check("state is pending with the submitted data", pendingMon.monetization?.application?.status === "pending" && pendingMon.monetization?.application?.full_name === "Creator Real Name" && pendingMon.monetization?.application?.jazzcash_number === "03001234567", JSON.stringify(pendingMon.monetization?.application));
check("age criterion now met from the application DOB (25)", pendingMon.monetization?.criteria?.age?.current === 25 && pendingMon.monetization?.criteria?.age?.met === true, JSON.stringify(pendingMon.monetization?.criteria?.age));
check("can_apply false while pending; monetized still false", pendingMon.monetization?.can_apply === false && pendingMon.monetization?.monetized === false);
const secondApply = await api("applyForMonetization", { token: creator.token, full_name: "Creator Real Name", dob: ADULT_DOB, jazzcash_number: "03001234567" });
check("second apply while pending is blocked", secondApply.ok === false && /review me hai/.test(secondApply.message || ""), JSON.stringify(secondApply));
const applicationId = pendingMon.monetization.application.id;

// ---- 6. criteria + pending application do NOT unlock withdrawal --------------
await fundWithCoins(creator.token, adminToken, 100);
const creatorBal1 = (await api("getMe", { token: creator.token })).user.coin_balance;
check("creator funded to 100", creatorBal1 === 100, `bal=${creatorBal1}`);
const earlyWd = await api("requestWithdrawal", { token: creator.token, coins: 100, jazzcash_number: "03001234567" });
check("withdraw before approval is rejected", earlyWd.ok === false, JSON.stringify(earlyWd));
check("gate message is the plain apply-first one", earlyWd.message === "Pehle monetization ke liye apply karein aur approval lein", earlyWd.message);
const creatorBal2 = (await api("getMe", { token: creator.token })).user.coin_balance;
check("rejected withdraw deducted NOTHING (balance still 100)", creatorBal2 === 100, `bal=${creatorBal2}`);
const creatorRewards = await api("getRewards", { token: creator.token });
check("rejected withdraw wrote NO withdrawal row", (creatorRewards.my_withdrawals ?? []).length === 0);

// ---- 7. owner review: only the owner, with live + snapshot numbers -----------
const nonAdminList = await api("getAdminMonetizationApplications", { token: creator.token });
check("non-admin cannot list applications", nonAdminList.ok === false);
const nonAdminReview = await api("reviewMonetizationApplication", { token: creator.token, application_id: applicationId, decision: "approved" });
check("non-admin cannot approve an application", nonAdminReview.ok === false);
const adminList = await api("getAdminMonetizationApplications", { token: adminToken });
const adminRow = adminList.applications?.find((a) => a.id === applicationId);
check("owner sees the pending application", Boolean(adminRow) && adminRow.status === "pending", JSON.stringify(adminList).slice(0, 240));
check("owner row carries form data + computed age 25", adminRow?.full_name === "Creator Real Name" && adminRow?.dob === ADULT_DOB && adminRow?.age === 25 && adminRow?.jazzcash_number === "03001234567", JSON.stringify(adminRow));
check("owner row carries snapshot AND current followers/views", adminRow?.followers_snapshot === 5000 && adminRow?.views_snapshot === 50000 && adminRow?.current_followers === 5000 && adminRow?.current_views === 50000, JSON.stringify(adminRow));
check("owner row identifies the applicant", adminRow?.applicant?.username === creator.user.username, JSON.stringify(adminRow?.applicant));

// ---- 8. approval: notified, monetized, withdrawal unlocks --------------------
const approve = await api("reviewMonetizationApplication", { token: adminToken, application_id: applicationId, decision: "approved" });
check("owner approves the application", approve.ok === true, JSON.stringify(approve));
const reReview = await api("reviewMonetizationApplication", { token: adminToken, application_id: applicationId, decision: "approved" });
check("double review rejected", reReview.ok === false);
const creatorInbox = await api("getNotifications", { token: creator.token });
check("approval notified the creator", creatorInbox.notifications?.some((n) => n.type === "monetization" && /approved/.test(n.text)), JSON.stringify(creatorInbox.notifications ?? []).slice(0, 240));
const approvedMon = await api("getMonetization", { token: creator.token });
check("creator is now monetized", approvedMon.monetization?.monetized === true && approvedMon.monetization?.application?.status === "approved");
const wdOk = await api("requestWithdrawal", { token: creator.token, coins: 100, jazzcash_number: "03001234567" });
check("approved creator can withdraw (hold placed, balance 0)", wdOk.ok === true && wdOk.my_balance === 0, JSON.stringify(wdOk));
const wdReview = await api("reviewWithdrawal", { token: adminToken, withdrawal_id: wdOk.withdrawal.id, decision: "approved" });
check("owner approves the withdrawal", wdReview.ok === true, JSON.stringify(wdReview));

// ---- 9. rejection: notified, still locked out, may apply again ---------------
const creator3 = await mkUser("monrej");
const post3 = await api("createPost", { token: creator3.token, title: "Rejection path video", video_url: "https://example.com/mon3.mp4" });
await seedFollowers(creator3.user.id, 5000, `b${suffix}`);
await db.execute({ sql: "UPDATE posts SET view_count = 50000 WHERE id = ?", args: [post3.post.id] });
const applied3 = await api("applyForMonetization", { token: creator3.token, full_name: "Rejected Creator", dob: ADULT_DOB, jazzcash_number: "03007654321" });
check("second creator applies", applied3.ok === true, JSON.stringify(applied3));
const app3Id = applied3.monetization?.application?.id;
const reject3 = await api("reviewMonetizationApplication", { token: adminToken, application_id: app3Id, decision: "rejected" });
check("owner rejects the application", reject3.ok === true, JSON.stringify(reject3));
const inbox3 = await api("getNotifications", { token: creator3.token });
check("rejection notified the creator", inbox3.notifications?.some((n) => n.type === "monetization" && /reject/.test(n.text)), JSON.stringify(inbox3.notifications ?? []).slice(0, 240));
const mon3 = await api("getMonetization", { token: creator3.token });
check("rejected state: not monetized, can apply again", mon3.monetization?.application?.status === "rejected" && mon3.monetization?.monetized === false && mon3.monetization?.can_apply === true, JSON.stringify(mon3.monetization));
await fundWithCoins(creator3.token, adminToken, 100);
const wd3 = await api("requestWithdrawal", { token: creator3.token, coins: 100, jazzcash_number: "03007654321" });
check("rejected creator still cannot withdraw", wd3.ok === false && wd3.message === "Pehle monetization ke liye apply karein aur approval lein", JSON.stringify(wd3));
const bal3 = (await api("getMe", { token: creator3.token })).user.coin_balance;
check("rejected creator balance untouched (100)", bal3 === 100, `bal=${bal3}`);
const reapplied3 = await api("applyForMonetization", { token: creator3.token, full_name: "Rejected Creator", dob: ADULT_DOB, jazzcash_number: "03007654321" });
check("rejected creator can apply again (new pending application)", reapplied3.ok === true && reapplied3.monetization?.application?.status === "pending" && reapplied3.monetization?.application?.id !== app3Id, JSON.stringify(reapplied3).slice(0, 200));

// ---- 10. exactly 18 today counts as 18 ---------------------------------------
const creator4 = await mkUser("monexact");
const post4 = await api("createPost", { token: creator4.token, title: "Exactly eighteen", video_url: "https://example.com/mon4.mp4" });
await seedFollowers(creator4.user.id, 5000, `c${suffix}`);
await db.execute({ sql: "UPDATE posts SET view_count = 50000 WHERE id = ?", args: [post4.post.id] });
const exactApply = await api("applyForMonetization", { token: creator4.token, full_name: "Just Eighteen", dob: dobYearsAgo(18), jazzcash_number: "03001112223" });
check("exactly-18 DOB applies successfully", exactApply.ok === true, JSON.stringify(exactApply));
check("exactly-18 age criterion reads 18 and met", exactApply.monetization?.criteria?.age?.current === 18 && exactApply.monetization?.criteria?.age?.met === true, JSON.stringify(exactApply.monetization?.criteria?.age));

// ---- 11. the owner/admin is exempt from the whole program --------------------
const adminMon = await api("getMonetization", { token: adminToken });
check("admin has no application and meets nothing (exemption is by role, not criteria)", adminMon.monetization?.application === null && adminMon.monetization?.monetized === false);
await fundWithCoins(adminToken, adminToken, 100);
const adminWd = await api("requestWithdrawal", { token: adminToken, coins: 100, jazzcash_number: "03001234567" });
check("admin withdraws WITHOUT any monetization application", adminWd.ok === true, JSON.stringify(adminWd));

console.log(failures === 0 ? "\nMONETIZATION TEST PASSED ✔" : `\nMONETIZATION TEST FAILED — ${failures} check(s) failed ✗`);
process.exit(failures === 0 ? 0 : 1);
