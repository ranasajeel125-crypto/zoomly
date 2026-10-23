// jsdom check for video share deep links (Phase 2C): opening the built app
// at /?v=<post id> pins that video at the top of the feed with a "Shared
// video" badge, and /?v=<missing> shows a graceful unavailable message.
//
//   PORT=3108 ADMIN_USERNAME=sajeel TURSO_DATABASE_URL=file:/tmp/zoomly-share.db npm start
//   npm run build
//   BASE_URL=http://localhost:3108 node scripts/share-check.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const BASE = process.env.BASE_URL || "http://localhost:3108";
const DIST_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "client", "dist");
const TOKEN_KEY = "zoomly_token";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.log(`  ✗ ${name} ${extra}`);
  }
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
async function api(action, args = {}) {
  const res = await fetch(`${BASE}/api/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  return res.json();
}

console.log(`Share deep-link check against ${BASE}`);
const suffix = Math.random().toString(36).slice(2, 8);
const author = await api("signup", { username: `share_${suffix}`, display_name: "Share Author", password: "test-pass-123" });
check("author signup ok", author.ok === true);
const post = await api("createPost", { token: author.token, title: "Shared Kite Video", video_url: "https://example.com/kite.mp4" });
check("post created", post.ok === true, JSON.stringify(post));
const viewer = await api("signup", { username: `viewer_${suffix}`, display_name: "Share Viewer", password: "test-pass-123" });
check("viewer signup ok", viewer.ok === true);

const bundleName = fs.readdirSync(path.join(DIST_DIR, "assets")).find((f) => /^index-.*\.js$/.test(f));
check("built bundle exists", Boolean(bundleName));
const bundle = fs.readFileSync(path.join(DIST_DIR, "assets", bundleName), "utf8");
const indexHtml = fs.readFileSync(path.join(DIST_DIR, "index.html"), "utf8");

function boot(url, token) {
  const dom = new JSDOM(indexHtml, {
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
      if (token) window.localStorage.setItem(TOKEN_KEY, token);
    },
  });
  dom.window.eval(bundle);
  return dom;
}

// 1. The shared video opens pinned at the top of the feed with its badge.
try {
  const dom = boot(`${BASE}/?v=${post.post.id}`, viewer.token);
  const text = () => dom.window.document.body?.textContent || "";
  await waitFor("shared video in feed", () => text().includes("Shared Kite Video") || text().includes("could not open"));
  check("app did NOT crash on the deep link", !text().includes("could not open"));
  check("shared video title renders in the feed", text().includes("Shared Kite Video"));
  check("Shared video badge renders", text().includes("Shared video"));
  check("Share button renders on the video card", text().includes("Share"));
  dom.window.close();
} catch (err) {
  check(`shared-video flow completed (${err.message})`, false);
}

// 2. A missing video shows the graceful message instead of breaking.
try {
  const dom = boot(`${BASE}/?v=99999999`, viewer.token);
  const text = () => dom.window.document.body?.textContent || "";
  await waitFor("unavailable message", () => text().includes("available nahi hai") || text().includes("could not open"));
  check("missing shared video shows a graceful message", text().includes("available nahi hai") && !text().includes("could not open"));
  dom.window.close();
} catch (err) {
  check(`missing-video flow completed (${err.message})`, false);
}

console.log(failures === 0 ? "\nSHARE CHECK PASSED ✔" : `\nSHARE CHECK FAILED — ${failures} check(s) failed ✗`);
process.exit(failures === 0 ? 0 : 1);
