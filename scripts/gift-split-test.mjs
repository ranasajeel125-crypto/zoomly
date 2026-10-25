// Exact 70/30 gift-split test (owner rule 2026-10-25).
//
// Proves, against a FRESH throwaway database (never production), that:
//   * 10x 1-coin roses credit the creator exactly 7 coins total and
//     record exactly 3.0 platform coins (0.7 / 0.3 per rose, carried
//     in milli-coins until a whole coin is reached);
//   * a 25-coin gift splits exactly 17.5 / 7.5 and a 100-coin gift
//     exactly 70 / 30;
//   * no single gift ever credits more than its price, and cumulative
//     credited coins never exceed cumulative exact creator share.
//
// Self-contained: spawns its own server on PORT 3121 with a throwaway
// libsql file, runs the API calls, then kills the server and deletes
// the database file. Usage: node scripts/gift-split-test.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = "/tmp/zoomly-gift-split-test.db";
const DB_URL = `file:${DB_PATH}`;
const PORT = 3121;
const BASE = `http://localhost:${PORT}`;

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
const server = spawn("node", ["server/index.mjs"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), TURSO_DATABASE_URL: DB_URL, ADMIN_USERNAME: "sajeel" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => { serverLog += d; });
server.stderr.on("data", (d) => { serverLog += d; });
try {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) break;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  const db = createClient({ url: DB_URL });
  const suffix = Math.random().toString(36).slice(2, 8);
  const creator = await api("signup", { username: `creator_${suffix}`, display_name: "Creator", password: "test-pass-123" });
  check("creator signup", creator.ok === true, JSON.stringify(creator).slice(0, 160));
  const sender = await api("signup", { username: `sender_${suffix}`, display_name: "Sender", password: "test-pass-123" });
  check("sender signup", sender.ok === true);
  // Fund the sender directly in the throwaway DB (no payment flow here).
  await db.execute({ sql: "UPDATE users SET coin_balance = 100000 WHERE id = ?", args: [sender.user.id] });
  const live = await api("startLive", { token: creator.token, title: "Gift split test live" });
  check("startLive", live.ok === true && live.session?.id, JSON.stringify(live).slice(0, 160));
  const sid = live.session.id;
  const creatorBal = async () => (await api("getMe", { token: creator.token })).user.coin_balance;
  const senderBal = async () => (await api("getMe", { token: sender.token })).user.coin_balance;
  const sessionRow = async () => {
    const r = await db.execute({ sql: "SELECT * FROM live_sessions WHERE id = ?", args: [sid] });
    return r.rows[0];
  };
  const giftRows = async () => {
    const r = await db.execute({ sql: "SELECT * FROM gift_events WHERE live_session_id = ? ORDER BY id ASC", args: [sid] });
    return r.rows;
  };

  // ---- 10x 1-coin roses -------------------------------------------------
  const before10 = await creatorBal();
  let lastRose = null;
  for (let i = 0; i < 10; i += 1) {
    lastRose = await api("sendGift", { token: sender.token, live_session_id: sid, gift_key: "rose" });
    check(`rose ${i + 1}/10 sent`, lastRose.ok === true, JSON.stringify(lastRose).slice(0, 200));
    check(`rose ${i + 1}/10 exact split 0.7/0.3`, lastRose.creator_share_exact === "0.7" && lastRose.platform_share_exact === "0.3", JSON.stringify(lastRose.gift));
    check(`rose ${i + 1}/10 never credits more than 1`, lastRose.creator_credited_coins <= 1, `credited=${lastRose.creator_credited_coins}`);
  }
  const after10 = await creatorBal();
  check("10 roses credit exactly 7 coins total", after10 === before10 + 7, `before=${before10} after=${after10}`);
  check("10th rose credits the 7th coin (carry completes)", lastRose.creator_credited_coins === 1 && lastRose.creator_pending_milli === 0, JSON.stringify(lastRose));
  const rows10 = await giftRows();
  const plat10 = rows10.reduce((s, r) => s + r.platform_share_milli, 0);
  const cred10 = rows10.reduce((s, r) => s + r.creator_credited_coins, 0);
  check("10 roses record exactly 3000 platform milli", plat10 === 3000, `platform_milli=${plat10}`);
  check("10 roses credited sum = 7", cred10 === 7, `credited=${cred10}`);
  check("10 roses exact creator milli = 7000", rows10.reduce((s, r) => s + r.creator_share_milli, 0) === 7000);

  // ---- 25-coin gift -------------------------------------------------------
  const before25 = await creatorBal();
  const g25 = await api("sendGift", { token: sender.token, live_session_id: sid, gift_key: "chocolate" });
  check("chocolate (25) sent", g25.ok === true);
  check("chocolate exact split 17.5/7.5", g25.creator_share_exact === "17.5" && g25.platform_share_exact === "7.5", JSON.stringify(g25.gift));
  check("chocolate credits 17 whole coins (carry: 17.5 -> 17, 0.5 pending)", g25.creator_credited_coins === 17 && g25.creator_pending_milli === 500, JSON.stringify(g25));
  check("chocolate credited balance +17", (await creatorBal()) === before25 + 17);

  // ---- 100-coin gift ------------------------------------------------------
  const before100 = await creatorBal();
  const g100 = await api("sendGift", { token: sender.token, live_session_id: sid, gift_key: "giftbox" });
  check("giftbox (100) sent", g100.ok === true);
  check("giftbox exact split 70/30", g100.creator_share_exact === "70" && g100.platform_share_exact === "30", JSON.stringify(g100.gift));
  // Pending before was 0.5, so 70.0 + 0.5 carry -> 70 whole credited, 0.5 still pending.
  check("giftbox credits 70 whole coins, 0.5 pending", g100.creator_credited_coins === 70 && g100.creator_pending_milli === 500, JSON.stringify(g100));
  check("giftbox credited balance +70", (await creatorBal()) === before100 + 70);

  // ---- Cumulative invariants ---------------------------------------------
  const rows = await giftRows();
  const gross = rows.reduce((s, r) => s + r.coins, 0);
  const exactCreator = rows.reduce((s, r) => s + r.creator_share_milli, 0);
  const exactPlatform = rows.reduce((s, r) => s + r.platform_share_milli, 0);
  const credited = rows.reduce((s, r) => s + r.creator_credited_coins, 0);
  check("gross = 10 + 25 + 100 = 135", gross === 135, `gross=${gross}`);
  check("exact creator + exact platform = gross * 1000", exactCreator + exactPlatform === gross * 1000, `creator=${exactCreator} platform=${exactPlatform}`);
  check("exact creator = 70% of gross (94500 milli)", exactCreator === 94500, `exactCreator=${exactCreator}`);
  check("exact platform = 30% of gross (40500 milli)", exactPlatform === 40500, `exactPlatform=${exactPlatform}`);
  check("credited (94) <= exact creator (94.5) and never exceeds gross", credited === 94 && credited * 1000 <= exactCreator, `credited=${credited}`);
  const sess = await sessionRow();
  check("session totals: gross 135, platform milli 40500, credited 94", sess.total_gift_coins === 135 && sess.platform_cut_milli === 40500 && sess.creator_credited_coins === 94, JSON.stringify(sess));
  const earn = await api("getGiftEarnings", { token: creator.token });
  check("getGiftEarnings: credited 94, exact 94.5, pending 0.5", earn.total_earned === 94 && earn.total_earned_exact === "94.5" && earn.creator_pending_milli === 500, JSON.stringify(earn).slice(0, 300));
  const senderAfter = await senderBal();
  check("sender spent exactly 135 (no refund, no overcharge)", senderAfter === 100000 - 135, `sender=${senderAfter}`);
  const types = await db.execute({ sql: "SELECT typeof(coin_balance) AS t, typeof(gift_earned_milli) AS g FROM users WHERE id = ?", args: [creator.user.id] });
  check("balances stay INTEGER in the DB (no REAL fraction leaked)", types.rows[0]?.t === "integer" && types.rows[0]?.g === "integer", JSON.stringify(types.rows[0]));
  const notif = await db.execute({ sql: "SELECT text, coins FROM notifications WHERE user_id = ? AND type = 'gift' ORDER BY id DESC LIMIT 1", args: [creator.user.id] });
  check("latest gift notification is honest (70 exact, 70 credited, 0.5 pending)", /70 coins \(70 whole coins credited now, 0\.5 pending in total\)/.test(notif.rows[0]?.text || ""), notif.rows[0]?.text || "(none)");
  await api("endLive", { token: creator.token, live_session_id: sid });
} finally {
  server.kill("SIGTERM");
  await sleep(500);
  try { server.kill("SIGKILL"); } catch { /* already dead */ }
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
}
console.log(failures === 0 ? "ALL GIFT-SPLIT CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
