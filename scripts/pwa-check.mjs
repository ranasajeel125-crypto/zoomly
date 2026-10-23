// PWA checks (Phase 3H): the manifest is served and valid, the built
// index.html links it (plus theme-color + apple touch icon), and every
// icon the manifest declares is reachable. Run AFTER `npm run build`
// (the manifest lives in client/public and is copied into dist).
//
//   PORT=3112 ADMIN_USERNAME=sajeel TURSO_DATABASE_URL=file:/tmp/zoomly-pwa.db npm start
//   BASE_URL=http://localhost:3112 node scripts/pwa-check.mjs

const BASE = process.env.BASE_URL || "http://localhost:3112";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

console.log(`PWA check against ${BASE}`);
const manifestRes = await fetch(`${BASE}/manifest.webmanifest`);
check("manifest is served (200)", manifestRes.status === 200, String(manifestRes.status));
let manifest = null;
try {
  manifest = await manifestRes.json();
} catch {
  /* handled by the next check */
}
check("manifest parses as JSON", Boolean(manifest));
check("manifest name is Zoomly", manifest?.name === "Zoomly" && manifest?.short_name === "Zoomly", JSON.stringify(manifest?.name));
check("display is standalone", manifest?.display === "standalone", JSON.stringify(manifest?.display));
check("start_url + scope are /", manifest?.start_url === "/" && manifest?.scope === "/");
check("theme + background colors set", Boolean(manifest?.theme_color) && Boolean(manifest?.background_color));
check("icons declared (incl. a 512 png)", Array.isArray(manifest?.icons) && manifest.icons.length > 0 && manifest.icons.some((i) => i.sizes === "512x512" && i.type === "image/png"), JSON.stringify(manifest?.icons));

for (const icon of manifest?.icons || []) {
  const res = await fetch(`${BASE}${icon.src}`);
  check(`icon reachable: ${icon.src}`, res.status === 200, String(res.status));
}

const html = await (await fetch(`${BASE}/`)).text();
check("index.html links the manifest", html.includes('rel="manifest"'), "");
check("index.html has theme-color", html.includes('name="theme-color"'));
check("index.html has apple-touch-icon", html.includes("apple-touch-icon"));

console.log(failures === 0 ? "\nPWA CHECK PASSED ✔" : `\nPWA CHECK FAILED — ${failures} check(s) failed ✗`);
process.exit(failures === 0 ? 0 : 1);
