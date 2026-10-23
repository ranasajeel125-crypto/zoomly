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
// Section 4 below also covers the remembered tab (owner fix 2026-10-23):
// a page refresh used to always dump the user back on Home; the shell now
// stores the open tab in localStorage ("zoomly_tab") and boots on it,
// while share deep links (?v=) still win over the saved tab.
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

// Two feed posts for the caption-clamp render checks in section 2: one
// with a very long title + hashtag-heavy description (the kind that
// used to cover the whole For You screen), one short and plain.
const longPost = await api("createPost", {
  token,
  title: "LONGCAP Yeh meri sab se lambi caption wali video hai jo pehle poori screen cover kar leti thi ab bilkul nahi karegi tum bas dekhte jao",
  description: "aur yeh hain hashtags #fun #video #zoomly #live #pk #gifts #earn #daily #viral #trending #music #dance #comedy #family #friends #zoomlyendtag",
  video_url: "https://example.com/longcap.mp4",
  thumbnail_url: "https://example.com/longcap.jpg",
});
check("long-caption post created", longPost.ok === true, JSON.stringify(longPost).slice(0, 160));
const shortPost = await api("createPost", {
  token,
  title: "Short caption post",
  description: "tiny",
  video_url: "https://example.com/shortcap.mp4",
  thumbnail_url: "https://example.com/shortcap.jpg",
});
check("short-caption post created", shortPost.ok === true, JSON.stringify(shortPost).slice(0, 160));

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

  // ---- caption clamp: long captions collapse, short ones don't -------------
  // Owner fix 2026-10-23: a post with a huge title + hashtags covered the
  // whole For You screen. The caption must start clamped (2 lines) with a
  // "… more" toggle, expand in place on tap, and collapse back — while a
  // short caption renders with NO toggle at all.
  await waitFor("feed shows both caption posts", () => bodyText().includes("LONGCAP") && bodyText().includes("Short caption post"));
  const clickEl = (el) => el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  const cards = [...document.querySelectorAll(".feed-item")];
  const longCard = cards.find((c) => (c.textContent || "").includes("LONGCAP"));
  const shortCard = cards.find((c) => (c.textContent || "").includes("Short caption post"));
  check("long + short caption cards both render in the feed", Boolean(longCard) && Boolean(shortCard));
  const longText = longCard?.querySelector("[data-caption-text]");
  const longToggle = () => longCard?.querySelector("button[data-caption-toggle]");
  check("long caption starts collapsed (data-expanded=false)", longText?.getAttribute("data-expanded") === "false");
  // The toggle renders after CaptionBlock's overflow measurement effect
  // settles — wait for it rather than racing the effect.
  await waitFor("'… more' toggle appears", () => Boolean(longToggle()));
  check("long caption shows the '… more' toggle", longToggle()?.textContent.includes("… more") ?? false);
  check("short caption has NO toggle", !shortCard?.querySelector("button[data-caption-toggle]"));
  // Expand via the toggle: full text reachable in a capped scroll area.
  clickEl(longToggle());
  await waitFor("caption expands", () => longText?.getAttribute("data-expanded") === "true");
  check("expanded caption shows the 'bandh karo' collapse control", longToggle()?.textContent.includes("bandh karo") ?? false);
  check("expanded caption is height-capped + scrollable", longText?.style.maxHeight === "48dvh" && longText?.style.overflowY === "auto", `maxHeight=${longText?.style.maxHeight} overflowY=${longText?.style.overflowY}`);
  check("expanded caption contains the FULL text (end hashtag reachable)", (longText?.textContent || "").includes("#zoomlyendtag"));
  // Collapse again via the toggle.
  clickEl(longToggle());
  await waitFor("caption collapses", () => longText?.getAttribute("data-expanded") === "false");
  check("caption collapses back to the '… more' state", longToggle()?.textContent.includes("… more") ?? false);
  // Tapping the caption text itself toggles too (and never touches the video).
  clickEl(longText);
  await waitFor("caption expands via text tap", () => longText?.getAttribute("data-expanded") === "true");
  check("tapping the caption text expands it", longText?.getAttribute("data-expanded") === "true");
  clickEl(longText);
  await waitFor("caption collapses via text tap", () => longText?.getAttribute("data-expanded") === "false");
  check("tapping the caption text again collapses it", longText?.getAttribute("data-expanded") === "false");
  // The short caption's text is inert: no toggle appears after tapping.
  const shortText = shortCard?.querySelector("[data-caption-text]");
  clickEl(shortText);
  await sleep(300);
  check("short caption stays plain after a tap (no toggle, not expanded)", !shortCard?.querySelector("button[data-caption-toggle]") && shortText?.getAttribute("data-expanded") === "false");

  // ---- feed tap gestures: single tap = play/pause, double tap = like -------
  // Owner spec 2026-10-23: one tap on a For You video pauses/plays it,
  // a double tap likes (and can never unlike). jsdom's media elements
  // never change `paused` on their own, so for THIS section the media
  // prototype gets an honest play/pause flag; originals are restored
  // afterwards so no other section sees a difference.
  const mediaProto = dom.window.HTMLMediaElement.prototype;
  const savedPlay = mediaProto.play;
  const savedPause = mediaProto.pause;
  const savedPausedDesc = Object.getOwnPropertyDescriptor(mediaProto, "paused");
  Object.defineProperty(mediaProto, "paused", {
    configurable: true,
    get() {
      return this._tapPaused !== false;
    },
  });
  mediaProto.play = function () {
    this._tapPaused = false;
    return Promise.resolve();
  };
  mediaProto.pause = function () {
    this._tapPaused = true;
  };
  try {
    const shortVideo = shortCard?.querySelector("video");
    check("feed tap target (short post video) found", Boolean(shortVideo));
    const likeCountOf = (card) => {
      const b = card?.querySelector('button[aria-label="Like"]');
      const m = (b?.textContent || "").match(/\d+/);
      return m ? parseInt(m[0], 10) : NaN;
    };
    const flashOf = () => shortCard?.querySelector("[data-tap-flash]")?.getAttribute("data-tap-flash") ?? null;
    check("short post starts unliked (count 0)", likeCountOf(shortCard) === 0, `count=${likeCountOf(shortCard)}`);
    // Single tap on a paused video: plays, flashes the ▶ glyph, no like.
    clickEl(shortVideo);
    await waitFor("single tap flashes play", () => flashOf() === "play");
    check("single tap flashes the play glyph", flashOf() === "play");
    await sleep(600);
    check("single tap does NOT like", likeCountOf(shortCard) === 0, `count=${likeCountOf(shortCard)}`);
    await waitFor("play flash clears with no paused overlay", () => !shortCard?.querySelector("[data-tap-flash]") && !shortCard?.querySelector("[data-paused-overlay]"));
    check("after the play tap the video is playing (no paused overlay)", !shortCard?.querySelector("[data-paused-overlay]"));
    // Single tap on the playing video: pauses (flash ⏸, then the static
    // paused ▶ overlay stays), still no like.
    clickEl(shortVideo);
    await waitFor("single tap flashes pause", () => flashOf() === "pause");
    check("single tap on a playing video flashes the pause glyph", flashOf() === "pause");
    await waitFor("paused overlay stays after the flash", () => !shortCard?.querySelector("[data-tap-flash]") && Boolean(shortCard?.querySelector("[data-paused-overlay]")));
    check("paused video keeps its ▶ overlay", Boolean(shortCard?.querySelector("[data-paused-overlay]")));
    check("pause tap still did NOT like", likeCountOf(shortCard) === 0, `count=${likeCountOf(shortCard)}`);
    // Resume, then let the flash fully clear before the double tap.
    clickEl(shortVideo);
    await waitFor("resume flash", () => flashOf() === "play");
    await sleep(900);
    // Double tap: heart burst + like, and it must NOT pause (the pending
    // single tap is cancelled — no flash may appear).
    clickEl(shortVideo);
    clickEl(shortVideo);
    await waitFor("double-tap heart burst", () => Boolean(shortCard?.querySelector(".zoomly-heart-burst")));
    check("double tap bursts a heart at the tap point", Boolean(shortCard?.querySelector(".zoomly-heart-burst")));
    await waitFor("double tap likes the post (count 1)", () => likeCountOf(shortCard) === 1);
    check("double tap liked the post (count 1)", likeCountOf(shortCard) === 1);
    await sleep(600);
    check("double tap did NOT pause (no flash, no paused overlay)", !shortCard?.querySelector("[data-tap-flash]") && !shortCard?.querySelector("[data-paused-overlay]"));
    // Double tap on the now-LIKED post: bursts again but the like stays —
    // it must never unlike.
    clickEl(shortVideo);
    clickEl(shortVideo);
    await waitFor("second double-tap heart burst", () => Boolean(shortCard?.querySelector(".zoomly-heart-burst")));
    check("double tap on a liked post bursts again", Boolean(shortCard?.querySelector(".zoomly-heart-burst")));
    await sleep(900);
    check("double tap on a liked post keeps the like (count still 1)", likeCountOf(shortCard) === 1, `count=${likeCountOf(shortCard)}`);
  } finally {
    mediaProto.play = savedPlay;
    mediaProto.pause = savedPause;
    if (savedPausedDesc) Object.defineProperty(mediaProto, "paused", savedPausedDesc);
    else delete mediaProto.paused;
  }

  // ---- stories placement: strip is OUT of the feed, in a Watch section -----
  // Owner fix 2026-10-23: the story strip at the top of the feed ate vertical
  // space and made feed videos render shorter. Feed must have no strip;
  // stories live in their own "Stories" section at the top of the Watch tab.
  await sleep(2000); // let the feed settle — a strip, if present, loads by now
  check("feed (Home) does NOT render the story strip", !bodyText().includes("Your story"));
  check(
    "feed has no story-create button",
    ![...document.querySelectorAll("button")].some((b) => (b.getAttribute("aria-label") || "") === "Your story"),
  );
  const watchBtn = [...document.querySelectorAll("nav button")].find((b) => (b.textContent || "").includes("Watch"));
  check("Watch nav button found", Boolean(watchBtn));
  watchBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await waitFor("Stories section in Watch", () => bodyText().includes("Your story"));
  check("Watch tab renders a Stories section with the story strip", bodyText().includes("Stories") && bodyText().includes("Your story"));
  check(
    "story-create entry lives in the Watch section now",
    [...document.querySelectorAll("button")].some((b) => (b.getAttribute("aria-label") || "") === "Your story"),
  );

  const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("Rewards"));
  check("Rewards nav button found", Boolean(btn));
  btn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await sleep(3000);

  const t = bodyText();
  check("Rewards view did NOT crash the app", !t.includes("could not open"));
  check("referral code rendered", t.includes(rewards.my_code));
  check("invite link rendered with ?ref=<code>", t.includes(`/?ref=${rewards.my_code}`));
  check("referral offer copy rendered (Har referral pe 1 coin)", t.includes("Har referral pe 1 coin — foran aap ke balance me!"));
  check("withdraw minimum copy rendered as 100 coins (Rs.100)", t.includes("Kam az kam 100 coins (Rs.100)"));
  check("Copy link button rendered", [...document.querySelectorAll("button")].some((b) => (b.textContent || "").includes("Copy link")));
  check("coin balance + level rendered", t.includes("Your coin balance") && t.includes(rewards.level));
  check("all 5 pack prices rendered", rewards.packs.every((p) => t.includes(`Rs.${p.pricePkr.toLocaleString()}`)));
  check("no 'Rs.undefined' anywhere", !t.includes("Rs.undefined"));
  check("JazzCash number rendered", t.includes(rewards.jazzcash.number));
  check("leaderboard rendered", t.includes("Leaderboard") && t.includes("Top Coins") && t.includes("Top Referrals"));
  check("Top Coins board renders anonymously (ID # shown, own @username absent)", t.includes("ID #") && !t.includes(`@${username}`), `username=@${username}`);
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

// ---- 4. remembered tab: a refresh returns to the tab you left ----------------
// Each scenario boots a FRESH jsdom with localStorage seeded the way a
// previous session would have left it, using the section-1 user's token.
function bootTab({ url = `${BASE}/`, seed = {} }) {
  const d = new JSDOM(indexHtml, {
    url,
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
      window.localStorage.setItem("zoomly_token", token);
      for (const [k, v] of Object.entries(seed)) window.localStorage.setItem(k, v);
    },
  });
  d.window.eval(bundle);
  return d;
}
const tabText = (doc) => doc.body?.textContent || "";
const crashed = (doc) => tabText(doc).includes("could not open");
const isFeedView = (doc) => [...doc.querySelectorAll("button")].some((b) => (b.textContent || "").trim() === "For You");
const isPeopleView = (doc) => Boolean(doc.querySelector('input[placeholder^="Search people"]'));
const isRewardsView = (doc) => tabText(doc).includes("Your coin balance");
try {
  // (a) saved "people" tab → boots straight onto People
  const dA = bootTab({ seed: { zoomly_tab: "people" } });
  await waitFor("People view from saved tab", () => isPeopleView(dA.window.document) || crashed(dA.window.document));
  check("boot with saved tab=people lands on People", isPeopleView(dA.window.document) && !crashed(dA.window.document));
  dA.window.close();

  // (b) saved "rewards" tab → boots straight onto Rewards
  const dB = bootTab({ seed: { zoomly_tab: "rewards" } });
  await waitFor("Rewards view from saved tab", () => isRewardsView(dB.window.document) || crashed(dB.window.document));
  check("boot with saved tab=rewards lands on Rewards", isRewardsView(dB.window.document) && !crashed(dB.window.document));
  dB.window.close();

  // (c) no saved tab → Home (feed), as before
  const dC = bootTab({});
  await waitFor("feed from no saved tab", () => isFeedView(dC.window.document) || crashed(dC.window.document));
  check("boot with NO saved tab lands on Home", isFeedView(dC.window.document) && !isPeopleView(dC.window.document));
  dC.window.close();

  // (d) stale/garbage saved value → falls back to Home
  const dD = bootTab({ seed: { zoomly_tab: "some-old-tab" } });
  await waitFor("feed from invalid saved tab", () => isFeedView(dD.window.document) || crashed(dD.window.document));
  check("boot with an invalid saved tab falls back to Home", isFeedView(dD.window.document) && !crashed(dD.window.document));
  dD.window.close();

  // (e) the app itself WRITES the tab when the user navigates
  const dE = bootTab({});
  await waitFor("feed before navigating", () => isFeedView(dE.window.document) || crashed(dE.window.document));
  const watchBtnE = [...dE.window.document.querySelectorAll("nav button")].find((b) => (b.textContent || "").includes("Watch"));
  check("Watch nav button found (write-path scenario)", Boolean(watchBtnE));
  watchBtnE.dispatchEvent(new dE.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await waitFor("tab written to storage", () => dE.window.localStorage.getItem("zoomly_tab") === "watch");
  check("navigating stores zoomly_tab=watch (what the next refresh restores)", dE.window.localStorage.getItem("zoomly_tab") === "watch");
  dE.window.close();

  // (f) deep link wins: saved tab=rewards + ?v=<post> → feed with the pin
  const post = await api("createPost", { token, title: "Tab Restore Shared Post", video_url: "https://example.com/tabrestore.mp4" });
  check("post created for the deep-link scenario", post.ok === true, JSON.stringify(post).slice(0, 200));
  const dF = bootTab({ url: `${BASE}/?v=${post.post.id}`, seed: { zoomly_tab: "rewards" } });
  await waitFor("shared video pin despite saved tab", () => tabText(dF.window.document).includes("Shared video") || crashed(dF.window.document));
  check("share link ?v= beats the saved tab (feed + pinned video)", tabText(dF.window.document).includes("Shared video") && !isRewardsView(dF.window.document));
  dF.window.close();
} catch (err) {
  check(`remembered-tab flow completed (${err.message})`, false);
}

// ---- 5. owner badge: only the owner's (admin) account carries it -------------
// The server derives is_owner from the same ADMIN_USERNAME check as admin
// rights; the client renders a "👑 Official Owner" pill on the profile of a
// user whose payload has it. A normal user's profile must never show it.
try {
  const adminName = (process.env.ADMIN_USERNAME || "sajeel").toLowerCase();
  let owner = await api("signup", { username: adminName, display_name: "Zoomly Owner", password: "test-pass-123" });
  if (!owner.ok) owner = await api("login", { username: adminName, password: "test-pass-123" });
  check("owner (admin) account available for the badge scenario", owner.ok === true, JSON.stringify(owner).slice(0, 200));
  check("owner payload carries is_owner === true", owner.user?.is_owner === true);
  check("normal user payload carries is_owner === false", signup.user?.is_owner === false);
  const ownerProfile = await api("getProfile", { token, user_id: owner.user.id });
  check("owner profile payload carries is_owner === true", ownerProfile.profile?.is_owner === true);
  const myProfile = await api("getProfile", { token, user_id: signup.user.id });
  check("normal profile payload carries is_owner === false", myProfile.profile?.is_owner === false);

  // Render as the normal user: People -> owner's row -> profile shows badge.
  const dG = bootTab({});
  const docG = dG.window.document;
  await waitFor("shell for the badge scenario", () => [...docG.querySelectorAll("nav button")].some((b) => (b.textContent || "").includes("People")) || crashed(docG));
  const peopleBtn = [...docG.querySelectorAll("nav button")].find((b) => (b.textContent || "").includes("People"));
  check("People nav button found (badge scenario)", Boolean(peopleBtn));
  peopleBtn.dispatchEvent(new dG.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await waitFor("owner row in People", () => [...docG.querySelectorAll("button")].some((b) => (b.textContent || "").includes(`@${adminName}`)) || crashed(docG));
  check("owner row in People carries the 👑 Owner tag", [...docG.querySelectorAll("button")].some((b) => (b.textContent || "").includes(`@${adminName}`) && (b.textContent || "").includes("👑 Owner")));
  const ownerRowBtn = [...docG.querySelectorAll("button")].find((b) => (b.textContent || "").includes(`@${adminName}`));
  ownerRowBtn.dispatchEvent(new dG.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await waitFor("owner badge on the profile", () => tabText(docG).includes("Official Owner") || crashed(docG));
  check("owner profile renders the 👑 Official Owner badge", tabText(docG).includes("👑 Official Owner") && !crashed(docG));

  // The normal user's OWN profile must NOT show the badge.
  const profileBtn = [...docG.querySelectorAll("nav button")].find((b) => (b.textContent || "").includes("Profile"));
  check("Profile nav button found (badge scenario)", Boolean(profileBtn));
  profileBtn.dispatchEvent(new dG.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  await waitFor("own profile view", () => tabText(docG).includes(`@${username}`) && tabText(docG).includes("ID #"));
  await sleep(800);
  check("normal user's own profile has NO owner badge", !tabText(docG).includes("Official Owner") && !tabText(docG).includes("👑 Owner"));
  dG.window.close();
} catch (err) {
  check(`owner-badge flow completed (${err.message})`, false);
}

if (failures > 0 || jsdomError) {
  console.log(`\nREWARDS RENDER CHECK FAILED ✗ (${failures} failures)`);
  process.exit(1);
}
console.log("\nREWARDS RENDER CHECK PASSED ✔");
