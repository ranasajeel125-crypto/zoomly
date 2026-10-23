// Google sign-in smoke test for Zoomly. Assumes a server booted WITH dummy
// Google credentials:
//   GOOGLE_CLIENT_ID=dummy-client-id GOOGLE_CLIENT_SECRET=dummy-secret \
//   ADMIN_USERNAME=sajeel PORT=3101 npm start
//   BASE_URL=http://localhost:3101 GOOGLE_CLIENT_SECRET=dummy-secret \
//     node scripts/google-smoke-test.mjs
//
// What it verifies (the real Google round-trip needs real credentials, so
// this crafts the server's own signed "pending" cookie exactly the way the
// OAuth callback does, and exercises everything after that point):
//   - GET /api/auth/google redirects to Google with the right client_id,
//     redirect_uri (.../api/auth/google/callback) and a state cookie
//   - the callback rejects a mismatched state
//   - GET /api/auth/google/pending returns the profile + suggested username
//   - POST /api/auth/google/complete creates the account: chosen username,
//     Google picture as DP, referral linking (NO coins minted for either
//     side — referrals are count-only), and a working session token
//   - a second completion for the same Google account is rejected
//   - a tampered pending cookie is rejected
import crypto from "node:crypto";

const BASE = process.env.BASE_URL || "http://localhost:3101";
const SECRET = process.env.GOOGLE_CLIENT_SECRET || "dummy-secret";
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "dummy-client-id";

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

console.log(`Google smoke test against ${BASE}`);

// Health reports Google configured
const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
check("health google_configured=true", health.google_configured === true, JSON.stringify(health));

// 1) Auth start: redirect to Google with correct params + state cookie
const start = await fetch(`${BASE}/api/auth/google`, { redirect: "manual" });
check("auth start is a redirect", start.status === 302, `status=${start.status}`);
const loc = new URL(start.headers.get("location") || "http://invalid/");
check("redirect goes to Google", loc.origin + loc.pathname === "https://accounts.google.com/o/oauth2/v2/auth", loc.href);
check("client_id matches env", loc.searchParams.get("client_id") === CLIENT_ID, loc.searchParams.get("client_id"));
const redirectUri = loc.searchParams.get("redirect_uri") || "";
check("redirect_uri ends with /api/auth/google/callback", redirectUri.endsWith("/api/auth/google/callback"), redirectUri);
const state = loc.searchParams.get("state") || "";
check("state param present", state.length >= 16);
const setCookie = start.headers.getSetCookie ? start.headers.getSetCookie().join(";") : start.headers.get("set-cookie") || "";
check("state cookie set", setCookie.includes("zoomly_gstate="), setCookie.slice(0, 120));

// 2) Callback with a mismatched state is rejected back to the app with an error
const badCb = await fetch(`${BASE}/api/auth/google/callback?code=fake&state=wrong-state`, {
  redirect: "manual",
  headers: { cookie: `zoomly_gstate=${state}` },
});
const badLoc = badCb.headers.get("location") || "";
check("callback rejects wrong state", badCb.status === 302 && badLoc.startsWith("/#google-error="), `${badCb.status} ${badLoc}`);

// Craft the pending cookie exactly as the callback would after Google
// verifies the user (HMAC-SHA256 over the payload, key = client secret).
function pendingCookie(profile) {
  const payload = { ...profile, exp: Date.now() + 10 * 60 * 1000 };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(payloadB64).digest("base64url");
  return `zoomly_gpending=${payloadB64}.${sig}`;
}
const profile = { sub: `g-${Math.random().toString(36).slice(2, 10)}`, email: "fan.test@gmail.com", name: "Fan Test", picture: "https://example.com/gpic.jpg" };
const cookie = pendingCookie(profile);

// 3) Pending endpoint returns profile + suggested username
const pending = await fetch(`${BASE}/api/auth/google/pending`, { headers: { cookie } }).then((r) => r.json());
check("pending returns profile", pending.ok === true && pending.email === profile.email, JSON.stringify(pending));
check("suggested username from email prefix", pending.suggested_username === "fan_test", pending.suggested_username);

// Tampered cookie rejected
const tampered = await fetch(`${BASE}/api/auth/google/pending`, { headers: { cookie: `${cookie}x` } });
check("tampered pending cookie rejected", tampered.status === 401, `status=${tampered.status}`);

// Inviter (normal password signup) whose referral code the Google user claims
const suffix = Math.random().toString(36).slice(2, 8);
const inviterName = `inv_${suffix}`;
const inviter = await api("signup", { username: inviterName, display_name: "Inviter", password: "test-pass-123" });
check("inviter signup", inviter.ok === true, JSON.stringify(inviter));
const inviterBefore = inviter.user.coin_balance;

// 4) Complete the Google signup with the referral code
const complete = await fetch(`${BASE}/api/auth/google/complete`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ username: `gfan_${suffix}`, referral_code: inviter.user.referral_code }),
}).then((r) => r.json());
check("google signup completes", complete.ok === true, JSON.stringify(complete));
check("google picture became the DP", complete.user?.avatar_url === profile.picture, complete.user?.avatar_url);
check("new google user got NO free welcome coins", complete.user?.coin_balance === 0, `balance=${complete.user?.coin_balance}`);
const inviterAfter = (await api("getMe", { token: inviter.token })).user;
check("inviter got NO referral coins", inviterAfter.coin_balance === inviterBefore, `before=${inviterBefore} after=${inviterAfter.coin_balance}`);
check("inviter referral count is 1", inviterAfter.referral_count === 1, `count=${inviterAfter.referral_count}`);
const meCheck = await api("getMe", { token: complete.token });
check("google session token works (getMe)", meCheck.ok === true && meCheck.user.username === `gfan_${suffix}`, JSON.stringify(meCheck).slice(0, 160));

// 5) Same Google account completing again is rejected (already linked)
const again = await fetch(`${BASE}/api/auth/google/complete`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ username: `other_${suffix}` }),
}).then((r) => r.json());
check("second completion for same Google account rejected", again.ok === false, JSON.stringify(again));

// 6) Taken username is rejected with a clear message (fresh Google profile)
const profile2 = { sub: `g2-${suffix}`, email: "two@gmail.com", name: "Two", picture: null };
const taken = await fetch(`${BASE}/api/auth/google/complete`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: pendingCookie(profile2) },
  body: JSON.stringify({ username: inviterName }),
}).then((r) => r.json());
check("taken username rejected", taken.ok === false && /taken/i.test(taken.message || ""), JSON.stringify(taken));

// 7) Public legal pages
const privacy = await fetch(`${BASE}/privacy`);
const privacyHtml = await privacy.text();
check("GET /privacy returns 200 + policy", privacy.status === 200 && /Privacy Policy/.test(privacyHtml) && privacyHtml.includes("ranasajeel125@gmail.com"), `status=${privacy.status}`);
const terms = await fetch(`${BASE}/terms`);
const termsHtml = await terms.text();
check("GET /terms returns 200 + terms", terms.status === 200 && /Terms of Service/.test(termsHtml), `status=${terms.status}`);
check("legal pages link to each other", privacyHtml.includes('href="/terms"') && termsHtml.includes('href="/privacy"'));

console.log(failures === 0 ? "\nGOOGLE SMOKE TEST PASSED ✔" : `\nGOOGLE SMOKE TEST FAILED — ${failures} check(s) failed ✗`);
process.exit(failures === 0 ? 0 : 1);
