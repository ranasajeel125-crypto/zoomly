// Regression check for the Rewards view crash (fixed 2026-10-22).
//
// Root cause it guards against: the server's getRewards payload sends coin
// packs as { coins, pricePkr } (camelCase), but RewardsView rendered
// pack.price_pkr (snake_case) — undefined — and called .toLocaleString()
// on it. That TypeError threw during render, hit the app-wide startup
// boundary, and dropped the user on the "Zoomly could not open" screen
// every time the Rewards tab was opened, even though the API was healthy.
//
// What this script does:
//   1. Signs up a fresh user against a running server (BASE_URL) and pulls
//      the REAL getRewards payload, asserting the field shape the view
//      depends on.
//   2. Loads the built client (client/dist) in jsdom with that user's
//      token, opens the Rewards tab, and asserts the screen actually
//      renders: referral code, coin packs with prices, the JazzCash
//      number, and both leaderboards — and does NOT crash.
//
// Requires: a running server serving the built client
//   (PORT=3102 ADMIN_USERNAME=sajeel npm start, after `npm run build`)
//   and jsdom (dev dependency).
// Usage:  BASE_URL=http://localhost:3102 node scripts/rewards-render-check.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const BASE = process.env.BASE_URL || "http://localhost:3102";
const DIST_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "client", "dist");

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
async function waitFor(desc, fn, timeoutMs = 25000) {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`Timed out waiting for: ${desc}`);
    await sleep(150);
  }
}

console.log(`Rewards render check against ${BASE}`);

// ---- 1. real payload shape --------------------------------------------------
const suffix = Math.random().toString(36).slice(2, 8);
const username = `render_${suffix}`;
const signup = await api("signup", { username, display_name: "Render Check", password: "test-pass-123" });
check("signup ok", signup.ok === true, JSON.stringify(signup).slice(0, 200));
const token = signup.token;

const rewards = await api("getRewards", { token });
check("getRewards ok", rewards.ok === true);
check("payload has my_code", typeof rewards.my_code === "string" && rewards.my_code.startsWith("ZOOM-"));
check("payload packs have numeric coins + pricePkr", Array.isArray(rewards.packs) && rewards.packs.length === 5 && rewards.packs.every((p) => typeof p.coins === "number" && typeof p.pricePkr === "number"));
check("payload jazzcash has number + title", typeof rewards.jazzcash?.number === "string" && typeof rewards.jazzcash?.title === "string");
check("payload my_requests is an array", Array.isArray(rewards.my_requests));
check("payload leaderboards have both boards", Array.isArray(rewards.leaderboards?.top_coins) && Array.isArray(rewards.leaderboards?.top_referrals));
check(
  "top_coins rows are anonymous (id + avatar_url + coin_balance + level; NO username/display_name keys)",
  rewards.leaderboards.top_coins.every((r) => !("username" in r) && !("display_name" in r) && "id" in r && "avatar_url" in r && "coin_balance" in r && "level" in r),
  JSON.stringify(rewards.leaderboards.top_coins[0] || {}),
);
check(
  "top_referrals rows still carry username + display_name",
  rewards.leaderboards.top_referrals.every((r) => "username" in r && "display_name" in r),
);

// ---- 2. render the built client and open Rewards -----------------------------
const indexHtml = fs.readFileSync(path.join(DIST_DIR, "index.html"), "utf8");
const bundleName = fs.readdirSync(path.join(DIST_DIR, "assets")).find((f) => f.endsWith(".js"));
check("built bundle exists", Boolean(bundleName), "run `npm run build` first");
const bundle = fs.readFileSync(path.join(DIST_DIR, "assets", bundleName), "utf8");

let jsdomError = null;
const dom = new JSDOM(indexHtml, {
  url: `${BASE}/`,
  runScripts: "dangerously",
  pretendToBeVisual: true,
  beforeParse(window) {
    window.localStorage.setItem("zoomly_token", token);
    // Bridge fetch to Node's; strip the jsdom-realm AbortSignal, which
    // Node's fetch cannot consume (same-realm in a real browser).
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
  },
});

const { document } = dom.window;
const bodyText = () => document.body?.textContent || "";
try {
  dom.window.eval(bundle);
  await waitFor("app boot", () => bodyText().includes("Rewards") || bodyText().includes("could not open"));
  check("app boots to the shell (no crash)", !bodyText().includes("could not open"));

  const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("Rewards"));
  check("Rewards nav button found", Boolean(btn));
  btn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(3000);

  const t = bodyText();
  check("Rewards view did NOT crash the app", !t.includes("could not open"));
  check("referral code rendered", t.includes(rewards.my_code));
  check("invite link rendered with ?ref=<code>", t.includes(`/?ref=${rewards.my_code}`));
  check("Copy link button rendered", [...document.querySelectorAll("button")].some((b) => (b.textContent || "").includes("Copy link")));
  check("coin balance + level rendered", t.includes("Your coin balance") && t.includes(rewards.level));
  check("all 5 pack prices rendered", rewards.packs.every((p) => t.includes(`Rs.${p.pricePkr.toLocaleString()}`)));
  check("no 'Rs.undefined' anywhere", !t.includes("Rs.undefined"));
  check("JazzCash number rendered", t.includes(rewards.jazzcash.number));
  check("leaderboard rendered", t.includes("Leaderboard") && t.includes("Top Coins") && t.includes("Top Referrals"));
  check("Top Coins board renders anonymously (ID # shown, own @username absent)", t.includes("ID #") && !t.includes(`@${me.username}`), `username=@${me.username}`);
  // Switch to the Top Referrals board and confirm it renders too.
  const refBtn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "") === "Top Referrals");
  if (refBtn) {
    refBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await sleep(500);
    check("Top Referrals board renders without crash", !bodyText().includes("could not open") && bodyText().includes(`@${username}`));
  }
} catch (err) {
  jsdomError = err;
  check(`render flow completed (${err.message})`, false);
} finally {
  dom.window.close();
}

// ---- 3. invite link: opening /?ref=CODE stores the code and pre-fills signup --
try {
  const dom2 = new JSDOM(indexHtml, {
    url: `${BASE}/?ref=${rewards.my_code}`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
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
    },
  });
  const doc2 = dom2.window.document;
  const text2 = () => doc2.body?.textContent || "";
  dom2.window.eval(bundle);
  await waitFor("auth view at ?ref=", () => text2().includes("Log in") || text2().includes("could not open"));
  check("logged-out app at invite link did NOT crash", !text2().includes("could not open"));
  check("invite code captured from ?ref= into storage", dom2.window.localStorage.getItem("zoomly_ref") === rewards.my_code, `stored=${dom2.window.localStorage.getItem("zoomly_ref")}`);
  const signUpTab = [...doc2.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "Sign up");
  check("Sign up tab found", Boolean(signUpTab));
  signUpTab.dispatchEvent(new dom2.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(400);
  const refInput = [...doc2.querySelectorAll("input")].find((i) => (i.placeholder || "").includes("Referral code"));
  check("signup form pre-fills the referral code from the link", Boolean(refInput) && refInput.value === rewards.my_code, `value=${refInput?.value}`);
  dom2.window.close();
} catch (err) {
  check(`invite-link flow completed (${err.message})`, false);
}

if (failures > 0 || jsdomError) {
  console.log(`\nREWARDS RENDER CHECK FAILED ✗ (${failures} failures)`);
  process.exit(1);
}
console.log("\nREWARDS RENDER CHECK PASSED ✔");
