// Unit tests for the WebRTC ICE server selection in server/config.mjs:
// the sync iceServers() list (static TURN env, else Metered staticauth)
// and the async getIceServers() wrapper that prefers Cloudflare Realtime
// TURN when CF_TURN_KEY_ID + CF_TURN_API_TOKEN are set — minted via API,
// cached, and fail-safe (any mint failure falls back to the sync list).
//
// No server needed; this imports the config module directly and drives
// it through env vars + an injectable fetch:
//
//   node scripts/ice-test.mjs
import { getIceServers, iceServers, _resetIceCachesForTests } from "../server/config.mjs";

let failures = 0;
let checks = 0;
function check(name, cond, extra = "") {
  checks += 1;
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Env hygiene: pin every var the ICE code reads, restore at the end.
const ENV_KEYS = [
  "CF_TURN_KEY_ID", "CF_TURN_API_TOKEN",
  "TURN_URL", "TURN_USERNAME", "TURN_CREDENTIAL", "TURN_URL_TCP",
  "TURN_HOST", "TURN_SECRET",
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  _resetIceCachesForTests();
}

// ---- (a) CF unset: getIceServers() === iceServers() -------------------------
clearEnv();
{
  const syncList = iceServers();
  const asyncList = await getIceServers();
  check("(a) CF unset: async list equals sync list", same(asyncList, syncList));
  check(
    "(a) CF unset: sync fallback is the Metered staticauth list",
    syncList.some((e) => String(e.urls).includes("staticauth.openrelay.metered.ca")),
    JSON.stringify(syncList.map((e) => e.urls)),
  );
}

// ---- (a2) CF unset + static TURN env: passthrough ---------------------------
clearEnv();
process.env.TURN_URL = "turn:turn.example.com:3478";
process.env.TURN_USERNAME = "static-user";
process.env.TURN_CREDENTIAL = "static-pass";
process.env.TURN_URL_TCP = "turns:turn.example.com:5349?transport=tcp";
{
  const syncList = iceServers();
  const asyncList = await getIceServers();
  check("(a2) CF unset + static TURN: async list equals sync list", same(asyncList, syncList));
  check(
    "(a2) static TURN entries are handed out",
    syncList.some((e) => e.urls === "turn:turn.example.com:3478" && e.username === "static-user")
      && syncList.some((e) => e.urls === "turns:turn.example.com:5349?transport=tcp"),
  );
}

// ---- (b) CF set + stubbed fetch: parse, shape, request, caching -------------
clearEnv();
process.env.CF_TURN_KEY_ID = "fake-key-id";
process.env.CF_TURN_API_TOKEN = "fake-api-token";
const CF_URLS = ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:5349?transport=tcp"];
const cfBody = { iceServers: { urls: CF_URLS, username: "cf-fake-user", credential: "cf-fake-cred" } };
const fetchCalls = [];
const okFetch = async (url, opts) => {
  fetchCalls.push({ url, opts });
  return { ok: true, json: async () => cfBody };
};
{
  const list1 = await getIceServers(okFetch);
  const last = list1[list1.length - 1];
  check("(b) CF list = STUN entries + Cloudflare entry", list1.length === 4, `len=${list1.length}`);
  check(
    "(b) STUN entries come first",
    list1.slice(0, 3).every((e) => String(e.urls).startsWith("stun:")),
    JSON.stringify(list1.slice(0, 3)),
  );
  check(
    "(b) Cloudflare response normalized to {urls, username, credential}",
    same(last, { urls: CF_URLS, username: "cf-fake-user", credential: "cf-fake-cred" }),
    JSON.stringify(last),
  );
  check("(b) exactly one mint fetch", fetchCalls.length === 1, `calls=${fetchCalls.length}`);
  check(
    "(b) mint URL targets the configured key",
    fetchCalls[0]?.url === "https://rtc.live.cloudflare.com/v1/turn/keys/fake-key-id/credentials/generate",
    fetchCalls[0]?.url,
  );
  check(
    "(b) mint sends the Bearer token + ttl 86400",
    fetchCalls[0]?.opts?.headers?.Authorization === "Bearer fake-api-token"
      && JSON.parse(fetchCalls[0]?.opts?.body ?? "{}").ttl === 86400,
  );
  const list2 = await getIceServers(okFetch);
  check("(b) second call served from cache (no re-fetch)", fetchCalls.length === 1, `calls=${fetchCalls.length}`);
  check("(b) cached list identical", same(list2, list1));
}

// ---- (b2) default fetch seam: globalThis.fetch is used when none passed -----
clearEnv();
process.env.CF_TURN_KEY_ID = "fake-key-id";
process.env.CF_TURN_API_TOKEN = "fake-api-token";
{
  const realFetch = globalThis.fetch;
  let globalCalls = 0;
  globalThis.fetch = async () => {
    globalCalls += 1;
    return { ok: true, json: async () => cfBody };
  };
  try {
    const list = await getIceServers();
    check("(b2) no-arg call uses globalThis.fetch", globalCalls === 1 && list[list.length - 1]?.username === "cf-fake-user");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---- (c) CF failures fall back to the sync list ------------------------------
clearEnv();
process.env.CF_TURN_KEY_ID = "fake-key-id";
process.env.CF_TURN_API_TOKEN = "fake-api-token";
{
  const throwingFetch = async () => {
    throw new Error("network boom");
  };
  const list = await getIceServers(throwingFetch);
  check("(c) fetch throw -> sync fallback list", same(list, iceServers()));

  _resetIceCachesForTests();
  const httpFailFetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const list2 = await getIceServers(httpFailFetch);
  check("(c) HTTP 500 -> sync fallback list", same(list2, iceServers()));

  _resetIceCachesForTests();
  const badShapeFetch = async () => ({ ok: true, json: async () => ({ nope: true }) });
  const list3 = await getIceServers(badShapeFetch);
  check("(c) malformed body -> sync fallback list", same(list3, iceServers()));

  _resetIceCachesForTests();
  const hangFetch = async (_url, opts) => {
    // Never resolves on its own; only the AbortSignal can cut it short.
    await new Promise((_, reject) => {
      opts.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  };
  const started = Date.now();
  const list4 = await getIceServers(hangFetch);
  check("(c) hung fetch is aborted (~8s) -> sync fallback list", same(list4, iceServers()) && Date.now() - started < 15000, `took ${Date.now() - started}ms`);
}

// ---- (d) only ONE of the CF vars set: feature stays off ----------------------
clearEnv();
process.env.CF_TURN_KEY_ID = "fake-key-id"; // token missing
{
  let called = 0;
  const spyFetch = async () => {
    called += 1;
    return { ok: true, json: async () => cfBody };
  };
  const list = await getIceServers(spyFetch);
  check("(d) key without token: no fetch, sync list", called === 0 && same(list, iceServers()));
}

// Restore env and report.
for (const k of ENV_KEYS) {
  if (savedEnv[k] === undefined) delete process.env[k];
  else process.env[k] = savedEnv[k];
}
console.log(`\n${checks - failures}/${checks} checks passed${failures ? ` — ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : 0);
