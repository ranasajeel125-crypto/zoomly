// Fetch-based RPC client for the Zoomly server.
// Every server action is POST /api/<actionName> with a JSON body that
// includes the session `token`. Media goes through POST /api/upload
// (multipart), which forwards the file to Cloudinary.
//
// Cold-start resilience: the app runs on a free host that sleeps when idle
// and can take 30–60s to wake. While it wakes, requests fail fast with a
// network error or a 502/503/504 from the platform. Read-only actions are
// therefore retried automatically with backoff for up to ~90 seconds, so a
// waking server simply looks like a slow load instead of a dead app. While
// any call is in that retry loop, the UI is told the server is "waking" so
// it can show a friendly message instead of an error.

const TOKEN_KEY = "zoomly_token";

// Actions that only read data — safe to retry after a transport failure.
const READ_ACTIONS = new Set([
  "getMe",
  "getFeed",
  "getWatch",
  "getComments",
  "getPeople",
  "getProfile",
  "getRewards",
  "getMonetization",
  "getAdminCoinRequests",
  "getAdminMonetizationApplications",
  "listLive",
  "getLive",
  "getLikedPosts", "getRankedFeed", "getTrending", "getByHashtag", "getSounds", "getSoundVideos",
  "getSavedPosts", "getHiddenItems", "getMutedUsers", "getCommentKeywords", "getInterests",
  "getCreatorAnalytics", "exportMyData", "getFollowRecommendations", "getFollowersList",
  "getFollowingList", "listPlaylists", "getPlaylist", "getMyAppeals", "getMyNotices",
  "getAppeals", "getAdminOverview", "getPublicFeed",
]);

const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const RETRY_BUDGET_MS = 90_000; // total patience for a waking server
const ATTEMPT_TIMEOUT_MS = 20_000; // a single hung request must not eat the budget
const FIRST_RETRY_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 10_000;

// ---- "server is waking" pub/sub -------------------------------------------

let wakingLoops = 0;
const wakeListeners = new Set();

function notifyWaking() {
  const waking = wakingLoops > 0;
  for (const fn of wakeListeners) {
    try {
      fn(waking);
    } catch {
      /* a broken listener must not break the client */
    }
  }
}

function wakeBegin() {
  wakingLoops += 1;
  if (wakingLoops === 1) notifyWaking();
}

function wakeEnd() {
  wakingLoops = Math.max(0, wakingLoops - 1);
  if (wakingLoops === 0) notifyWaking();
}

export function isWaking() {
  return wakingLoops > 0;
}

// Subscribe to waking changes; the listener is called immediately with the
// current state. Returns an unsubscribe function.
export function subscribeWaking(fn) {
  wakeListeners.add(fn);
  try {
    fn(isWaking());
  } catch {
    /* ignore */
  }
  return () => wakeListeners.delete(fn);
}

// ---- token storage ----------------------------------------------------------

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

// ---- the RPC call -------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// One fetch attempt with a timeout. Returns the Response, or null when the
// attempt failed at the transport level (network error / timeout) — the
// classic symptom of a server that is still waking up.
async function attemptFetch(action, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
  try {
    return await fetch(`/api/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: controller.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function parseResponse(res) {
  const data = await res.json().catch(() => null);
  if (!data) return { ok: false, message: `Server error (HTTP ${res.status}).` };
  return data;
}

const TRANSPORT_FAIL_RESULT = {
  ok: false,
  transportError: true,
  message: "Zoomly could not be reached — the server may still be waking up. Please try again.",
};

export async function call(action, args = {}) {
  const body = JSON.stringify({ token: getToken(), ...args });
  const retryable = READ_ACTIONS.has(action);

  if (!retryable) {
    // Writes are never blindly retried (they might have reached the server),
    // but a transport failure is reported as a result instead of a rejection
    // so callers can show the message and reset their busy state.
    const res = await attemptFetch(action, body);
    if (!res) return { ...TRANSPORT_FAIL_RESULT };
    return parseResponse(res);
  }

  const deadline = Date.now() + RETRY_BUDGET_MS;
  let delay = FIRST_RETRY_DELAY_MS;
  let inRetryLoop = false;
  try {
    for (;;) {
      const res = await attemptFetch(action, body);
      if (res && !RETRYABLE_STATUSES.has(res.status)) {
        return await parseResponse(res);
      }
      // Transport failure or a wake-up status (502/503/504): wait and retry
      // until the budget runs out.
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ...TRANSPORT_FAIL_RESULT };
      if (!inRetryLoop) {
        inRetryLoop = true;
        wakeBegin();
      }
      await sleep(Math.min(delay, remaining));
      delay = Math.min(Math.round(delay * 1.5), MAX_RETRY_DELAY_MS);
    }
  } finally {
    if (inRetryLoop) wakeEnd();
  }
}

// Upload a media file (kind: "video" | "image"). Returns the server's JSON:
// { ok, url, public_id, thumbnail_url } or { ok:false, message }.
export async function uploadMedia(file, kind, signal) {
  const form = new FormData();
  form.append("token", getToken());
  form.append("kind", kind);
  form.append("file", file);
  let res;
  try {
    res = await fetch("/api/upload", { method: "POST", body: form, signal });
  } catch {
    return { ok: false, message: "Upload failed — network error. Please try again." };
  }
  const data = await res.json().catch(() => null);
  if (!data) return { ok: false, message: `Upload failed (HTTP ${res.status}).` };
  return data;
}
