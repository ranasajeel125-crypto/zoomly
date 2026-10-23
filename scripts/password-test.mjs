// End-to-end tests for Zoomly password help (Phase 3G): logged-in
// change-password (current password required) and the owner-assisted
// reset (admin sets a temporary password; the user's old sessions die;
// the temp login works and can itself be changed).
//
//   PORT=3111 ADMIN_USERNAME=sajeel TURSO_DATABASE_URL=file:/tmp/zoomly-pw.db npm start
//   BASE_URL=http://localhost:3111 ADMIN_USERNAME=sajeel node scripts/password-test.mjs

const BASE = process.env.BASE_URL || "http://localhost:3111";
const ADMIN = process.env.ADMIN_USERNAME || "sajeel";

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

console.log(`Password test against ${BASE}`);
const suffix = Math.random().toString(36).slice(2, 8);
const username = `pw_${suffix}`;
const signup = await api("signup", { username, display_name: "PW User", password: "old-pass-123" });
if (!signup.ok) throw new Error("signup failed");
const token = signup.token;
const userId = signup.user.id;
// ADMIN_USERNAME only grants admin via signup (the bootstrap account).
const admin = await api("signup", { username: ADMIN, display_name: "Admin", password: "admin-pass-123" }).catch(() => null);
const adminToken = admin?.token || (await api("login", { username: ADMIN, password: "admin-pass-123" })).token;

// Wrong current password is rejected.
const wrong = await api("changePassword", { token, current_password: "not-the-password", new_password: "new-pass-456" });
check("wrong current password rejected", wrong.ok === false, JSON.stringify(wrong));
// Too-short new password fails validation.
const short = await api("changePassword", { token, current_password: "old-pass-123", new_password: "abc" });
check("short new password rejected", short.ok === false, JSON.stringify(short));
// Correct change works; the old password stops working, the new one works.
const changed = await api("changePassword", { token, current_password: "old-pass-123", new_password: "new-pass-456" });
check("change with correct current password works", changed.ok === true, JSON.stringify(changed));
const oldLogin = await api("login", { username, password: "old-pass-123" });
check("old password no longer logs in", oldLogin.ok === false, JSON.stringify(oldLogin));
const newLogin = await api("login", { username, password: "new-pass-456" });
check("new password logs in", newLogin.ok === true, JSON.stringify(newLogin).slice(0, 120));

// A non-admin cannot use the owner reset.
const userReset = await api("adminResetPassword", { token: newLogin.token, user_id: userId, temp_password: "temp-12345" });
check("non-admin reset rejected", userReset.ok === false, JSON.stringify(userReset));

// Admin reset: temp password works, previous sessions are killed.
const before = await api("getMe", { token: newLogin.token });
check("session alive before reset", before.ok === true || Boolean(before.user));
const reset = await api("adminResetPassword", { token: adminToken, user_id: userId, temp_password: "temp-12345" });
check("admin reset works", reset.ok === true, JSON.stringify(reset));
const afterOldToken = await api("getMe", { token: newLogin.token });
check("old session killed by reset", afterOldToken.ok === false && !afterOldToken.user, JSON.stringify(afterOldToken).slice(0, 120));
const tempLogin = await api("login", { username, password: "temp-12345" });
check("temp password logs in", tempLogin.ok === true, JSON.stringify(tempLogin).slice(0, 120));
const prevLogin = await api("login", { username, password: "new-pass-456" });
check("pre-reset password no longer works", prevLogin.ok === false);
// And the user can change away from the temp password.
const rechange = await api("changePassword", { token: tempLogin.token, current_password: "temp-12345", new_password: "final-pass-789" });
check("change from temp password works", rechange.ok === true, JSON.stringify(rechange));

console.log(failures === 0 ? "\nPASSWORD TEST PASSED ✔" : `\nPASSWORD TEST FAILED — ${failures} check(s) failed ✗`);
process.exit(failures === 0 ? 0 : 1);
