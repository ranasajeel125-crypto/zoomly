// Fetch-based RPC client for the Zoomly server.
// Every server action is POST /api/<actionName> with a JSON body that
// includes the session `token`. Media goes through POST /api/upload
// (multipart), which forwards the file to Cloudinary.

const TOKEN_KEY = "zoomly_token";

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

export async function call(action, args = {}) {
  const res = await fetch(`/api/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: getToken(), ...args }),
  });
  const data = await res.json().catch(() => null);
  if (!data) return { ok: false, message: `Server error (HTTP ${res.status}).` };
  return data;
}

// Upload a media file (kind: "video" | "image"). Returns the server's JSON:
// { ok, url, public_id, thumbnail_url } or { ok:false, message }.
export async function uploadMedia(file, kind) {
  const form = new FormData();
  form.append("token", getToken());
  form.append("kind", kind);
  form.append("file", file);
  const res = await fetch("/api/upload", { method: "POST", body: form });
  const data = await res.json().catch(() => null);
  if (!data) return { ok: false, message: `Upload failed (HTTP ${res.status}).` };
  return data;
}
