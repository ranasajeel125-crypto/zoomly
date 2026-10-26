import { useCallback, useEffect, useRef, useState } from "react";
import { call, getToken, isWaking, setToken, subscribeWaking, uploadMedia } from "./api";
import { LiveView } from "./Live.jsx";
import AdSlot from "./AdSlot.jsx";
import { setViewerMuted, viewerMuted } from "./sound.js";
import { InboxView, SearchView, SettingsView } from "./Redesign.jsx";
import { GuestFeedView, Phase2Hub } from "./Phase2.jsx";

// Shown while the (free-tier) server is waking up and the client is
// retrying — a slow first load is normal, not an error.
const WAKING_TEXT = "Zoomly jag raha hai… pehli dafa khulne me thora waqt lag sakta hai";

function useWaking() {
  const [waking, setWaking] = useState(isWaking());
  useEffect(() => subscribeWaking(setWaking), []);
  return waking;
}

// ---------- small helpers ---------------------------------------------------

export const TIER_COLORS = {
  Starter: "#9aa7a0",
  Bronze: "#e09a5a",
  Silver: "#d7dde2",
  Golden: "#ffd54a",
  Platinum: "#7ee8fa",
  Diamond: "#c4b5fd",
};

export function Logo({ size = 40, withWordmark = false }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <img src="/logo.svg" alt="Zoomly logo" style={{ width: size, height: size, borderRadius: Math.round(size * 0.24), flexShrink: 0 }} />
      {withWordmark && (
        <span style={{ fontSize: Math.round(size * 0.62), fontWeight: 900, letterSpacing: -0.5 }}>
          Zoom<span style={{ color: "var(--accent)" }}>ly</span>
        </span>
      )}
    </span>
  );
}

export function Avatar({ user, size = 40 }) {
  const letter = (user?.display_name || user?.username || "?").trim().charAt(0).toUpperCase() || "?";
  if (user?.avatar_url) {
    return (
      <img
        src={user.avatar_url}
        alt={user.display_name || user.username || "avatar"}
        style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0, background: "var(--surface-2)" }}
      />
    );
  }
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: "var(--accent-dark)",
        color: "#e9ffb0",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 800,
        fontSize: Math.round(size * 0.45),
        flexShrink: 0,
      }}
    >
      {letter}
    </div>
  );
}

export function LevelBadge({ level }) {
  if (!level) return null;
  const color = TIER_COLORS[level] || "#9aa7a0";
  return (
    <span className="chip" style={{ color, borderColor: color, padding: "2px 8px", fontSize: 12 }}>
      ◆ {level}
    </span>
  );
}

// Shown only for the owner's account: the server sets `is_owner` from the
// admin check, so no user can fake or earn this badge.
export function OwnerBadge({ user, full = false }) {
  if (!user?.is_owner) return null;
  return (
    <span
      className="chip"
      title="Zoomly ke official owner"
      style={{
        background: "linear-gradient(90deg, #bef264, #84cc16)",
        color: "#1c2a05",
        borderColor: "transparent",
        padding: "2px 8px",
        fontSize: 12,
        fontWeight: 800,
        whiteSpace: "nowrap",
      }}
    >
      👑 {full ? "Official Owner" : "Owner"}
    </span>
  );
}

export function timeAgo(ts) {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function Notice({ text, bad }) {
  if (!text) return null;
  return (
    <div
      style={{
        background: bad ? "rgba(255,122,102,0.12)" : "rgba(163,230,53,0.12)",
        border: `1px solid ${bad ? "var(--bad)" : "var(--accent)"}`,
        color: bad ? "var(--bad)" : "var(--accent)",
        borderRadius: 12,
        padding: "9px 12px",
        fontSize: 14,
        margin: "10px 0",
      }}
    >
      {text}
    </div>
  );
}

// ---------- referral invite links ----------------------------------------------
// A shared invite link looks like https://zoomly.onrender.com/?ref=ZOOM-1-X.
// Opening the app with ?ref=CODE stores the code so BOTH signup flows can
// pre-fill and apply it with no typing; the manual code fields stay as a
// backup. The stored code is cleared after a successful signup.
const REF_STORAGE_KEY = "zoomly_ref";

export function captureInviteRef() {
  try {
    const ref = new URLSearchParams(window.location.search).get("ref");
    if (ref && ref.trim()) {
      localStorage.setItem(REF_STORAGE_KEY, ref.trim().toUpperCase());
      const url = new URL(window.location.href);
      url.searchParams.delete("ref");
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
  } catch {
    /* storage or URL unavailable — manual code entry still works */
  }
}

export function storedInviteRef() {
  try {
    return localStorage.getItem(REF_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function clearInviteRef() {
  try {
    localStorage.removeItem(REF_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function inviteLinkFor(code) {
  return `${window.location.origin}/?ref=${encodeURIComponent(code || "")}`;
}

// ---------- device id (anti-self-referral guard) ------------------------------
// A stable per-browser id, created once and kept in localStorage. Both
// signup flows send it; the server stores it on the account and withholds
// the referral coin when a "new" account is really the inviter's own alt
// on the same device. It is NOT a tracking/fingerprint id — just a random
// value this browser generated for itself.
const DEVICE_STORAGE_KEY = "zoomly_device_id";

export function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_STORAGE_KEY);
    if (!id) {
      id =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
      localStorage.setItem(DEVICE_STORAGE_KEY, id);
    }
    return id;
  } catch {
    return undefined;
  }
}

// A shared video link looks like https://zoomly.onrender.com/?v=<post id>.
// Opening the app with ?v=<id> returns the id once (and cleans the URL) so
// the feed can open at that video.
export function captureSharedPostId() {
  try {
    const v = new URLSearchParams(window.location.search).get("v");
    if (v && /^\d+$/.test(v)) {
      const url = new URL(window.location.href);
      url.searchParams.delete("v");
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
      return Number(v);
    }
  } catch {
    /* ignore */
  }
  return null;
}

// ---------- remembered tab -----------------------------------------------------
// The shell remembers which main tab the user was on and returns to it
// after a page refresh, instead of always landing on Home. Like the sound
// preference, it is a plain localStorage value, written whenever the tab
// changes while signed in. Deep links keep priority over the remembered
// tab: a shared video link (?v=<id>) still opens the feed, where the
// shared video is pinned.
const TAB_STORAGE_KEY = "zoomly_tab";
const PROFILE_USER_STORAGE_KEY = "zoomly_profile_user";
const TAB_KEYS = ["feed", "watch", "people", "live", "upload", "rewards", "profile", "search", "inbox"];

export function storedTab() {
  try {
    const t = localStorage.getItem(TAB_STORAGE_KEY);
    return TAB_KEYS.includes(t) ? t : null;
  } catch {
    return null;
  }
}

export function storedProfileUserId() {
  try {
    const id = Number(localStorage.getItem(PROFILE_USER_STORAGE_KEY));
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

export function saveTab(tab, profileUserId) {
  try {
    if (TAB_KEYS.includes(tab)) localStorage.setItem(TAB_STORAGE_KEY, tab);
    // Whose profile is open is part of "where you were": a refresh on
    // someone's profile should return to that profile, not your own.
    if (tab === "profile" && profileUserId) {
      localStorage.setItem(PROFILE_USER_STORAGE_KEY, String(profileUserId));
    } else {
      localStorage.removeItem(PROFILE_USER_STORAGE_KEY);
    }
  } catch {
    /* storage unavailable (private mode) — refresh just lands on Home */
  }
}

export function clearStoredTab() {
  try {
    localStorage.removeItem(TAB_STORAGE_KEY);
    localStorage.removeItem(PROFILE_USER_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

// The tab to open on at boot: a shared video link wins (the feed pins the
// video), then the remembered tab, then Home.
export function initialTab() {
  try {
    const v = new URLSearchParams(window.location.search).get("v");
    if (v && /^\d+$/.test(v)) return "feed";
  } catch {
    /* ignore */
  }
  return storedTab() || "feed";
}

// Web Share API when available, clipboard otherwise (used by video Share
// buttons and profile sharing).
export async function shareUrl({ url, text }) {
  if (navigator.share) {
    try {
      await navigator.share({ title: "Zoomly", text, url });
      return "shared";
    } catch {
      /* user cancelled */
      return "cancelled";
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return "copied";
  } catch {
    return "failed";
  }
}

// ---------- video views --------------------------------------------------------
// A view counts once per viewer per post (the server enforces it via
// post_views); this set just avoids re-sending within one app session.
// Own videos are skipped here too — the server ignores them anyway.
const countedViewPostIds = new Set();
export function notePostView(post) {
  if (!post?.id || post.author?.is_me || countedViewPostIds.has(post.id)) return;
  countedViewPostIds.add(post.id);
  call("recordPostView", { post_id: post.id }).catch(() => {});
}

// ---------- auth --------------------------------------------------------------

export function GoogleIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z" />
      <path fill="#FF3D00" d="m6.306 14.691 6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z" />
      <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0 1 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z" />
      <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z" />
    </svg>
  );
}

export function GoogleButton() {
  return (
    <a className="btn btn-google" href="/api/auth/google">
      <GoogleIcon /> Continue with Google
    </a>
  );
}

// First Google sign-in lands here (server holds the Google profile in a
// signed cookie): the user picks their Zoomly username before the account
// is created. A friend's referral code can be entered on the same screen.
function GoogleSetupView({ onAuthed, onCancel }) {
  const [profile, setProfile] = useState(null);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [referralCode, setReferralCode] = useState(() => storedInviteRef());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/auth/google/pending").then((r) => r.json()).catch(() => null);
      if (!res?.ok) {
        setError(res?.message || "Your Google sign-in session has expired. Please try again.");
        return;
      }
      setProfile(res);
      setUsername(res.suggested_username || "");
      setDisplayName(res.name || "");
    })();
  }, []);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/auth/google/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, display_name: displayName || undefined, referral_code: referralCode || undefined, device_id: deviceId() }),
    }).then((r) => r.json()).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      setError(res?.message || "Could not create your account. Please try again.");
      return;
    }
    clearInviteRef();
    setToken(res.token);
    onAuthed(res.user);
  }

  return (
    <div style={{ maxWidth: 420, margin: "0 auto", padding: "48px 20px 24px" }}>
      <div style={{ textAlign: "center", marginBottom: 24 }}>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <Logo size={76} />
        </div>
        <div style={{ fontSize: 34, fontWeight: 900, letterSpacing: -1, marginTop: 10 }}>
          Almost there!
        </div>
        <p style={{ color: "var(--dim)", marginTop: 4 }}>Pick your Zoomly username to finish signing up with Google.</p>
      </div>
      {profile && (
        <div className="card" style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
          {profile.picture ? (
            <img src={profile.picture} alt="" style={{ width: 44, height: 44, borderRadius: "50%", objectFit: "cover" }} />
          ) : (
            <Avatar user={{ display_name: profile.name || profile.email || "G" }} size={44} />
          )}
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700 }}>{profile.name || "Google user"}</div>
            <div style={{ color: "var(--dim)", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{profile.email || ""}</div>
          </div>
        </div>
      )}
      <form onSubmit={submit} style={{ display: "grid", gap: 10 }}>
        <input className="input" placeholder="Choose a username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        <input className="input" placeholder="Display name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="name" />
        <input className="input" placeholder="Referral code (optional) — e.g. ZOOM-1-SAJEEL" value={referralCode} onChange={(e) => setReferralCode(e.target.value)} />
        <Notice text={error} bad />
        <button className="btn btn-primary" type="submit" disabled={busy || !profile} style={{ padding: "12px 16px", fontSize: 16 }}>
          {busy ? "Please wait…" : "Create my account"}
        </button>
      </form>
      <p style={{ color: "var(--dim)", fontSize: 13, marginTop: 12 }}>Your Google profile photo becomes your Zoomly photo (DP) — you can change it later. Signing up with a friend&apos;s referral code counts you as their referral.</p>
      <button className="btn" onClick={onCancel} style={{ marginTop: 6 }}>
        ← Back to log in
      </button>
    </div>
  );
}

function AuthView({ onAuthed, onGuest }) {
  const [mode, setMode] = useState("login");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [referralCode, setReferralCode] = useState(() => storedInviteRef());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  // The Google flow reports failures by redirecting back with
  // #google-error=<message> — show it once, then clean the URL.
  useEffect(() => {
    const hash = window.location.hash || "";
    if (hash.startsWith("#google-error=")) {
      setError(decodeURIComponent(hash.slice("#google-error=".length)));
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNote("");
    const res =
      mode === "signup"
        ? await call("signup", { username, display_name: displayName || undefined, password, referral_code: referralCode || undefined, device_id: deviceId() })
        : await call("login", { username, password });
    setBusy(false);
    if (!res.ok) {
      setError(res.message || "Something went wrong.");
      return;
    }
    if (mode === "signup") clearInviteRef();
    setToken(res.token);
    if (res.referral_message) setNote(res.referral_message);
    onAuthed(res.user);
  }

  return (
    <div style={{ maxWidth: 420, margin: "0 auto", padding: "48px 20px 24px" }}>
      <div style={{ textAlign: "center", marginBottom: 24 }}>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <Logo size={76} />
        </div>
        <div style={{ fontSize: 40, fontWeight: 900, letterSpacing: -1, marginTop: 10 }}>
          Zoom<span style={{ color: "var(--accent)" }}>ly</span>
        </div>
        <p style={{ color: "var(--dim)", marginTop: 4 }}>Short videos, creators, coins &amp; rewards — all in one app.</p>
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        <button className={`tab-btn ${mode === "login" ? "active" : ""}`} onClick={() => setMode("login")}>
          Log in
        </button>
        <button className={`tab-btn ${mode === "signup" ? "active" : ""}`} onClick={() => setMode("signup")}>
          Sign up
        </button>
      </div>
      <form onSubmit={submit} style={{ display: "grid", gap: 10 }}>
        <input className="input" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        {mode === "signup" && (
          <input className="input" placeholder="Display name (optional)" value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="name" />
        )}
        <input className="input" type="password" placeholder="Password (min 6 characters)" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "signup" ? "new-password" : "current-password"} required />
        {mode === "signup" && (
          <input className="input" placeholder="Referral code (optional) — e.g. ZOOM-1-SAJEEL" value={referralCode} onChange={(e) => setReferralCode(e.target.value)} />
        )}
        <Notice text={error} bad />
        <Notice text={note} />
        <button className="btn btn-primary" type="submit" disabled={busy} style={{ padding: "12px 16px", fontSize: 16 }}>
          {busy ? "Please wait…" : mode === "signup" ? "Create account" : "Log in"}
        </button>
      </form>
      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "16px 0 12px", color: "var(--dim)", fontSize: 13 }}>
        <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
        or
        <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
      </div>
      <GoogleButton />
      {onGuest && <button className="btn" type="button" onClick={onGuest} style={{ width: "100%", marginTop: 10 }}>👀 Browse as guest (no account needed)</button>}
      {mode === "signup" && <p style={{ color: "var(--dim)", fontSize: 13, marginTop: 12 }}>Signing up with a friend&apos;s referral code counts you as their referral.</p>}
    </div>
  );
}

// ---------- comments ------------------------------------------------------------

export function CommentsSheet({ post, onClose, onAdded, onHashtag, onMention }) {
  const [comments, setComments] = useState([]);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reportComment, setReportComment] = useState(null);
  const [replyTo, setReplyTo] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editBody, setEditBody] = useState("");

  const load = useCallback(async () => {
    const res = await call("getComments", { post_id: post.id });
    if (res.ok) setComments(res.comments);
  }, [post.id]);

  useEffect(() => {
    load();
  }, [load]);

  async function submit(e) {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    setError("");
    const res = await call("addComment", { post_id: post.id, body, parent_id: replyTo?.id });
    setBusy(false);
    if (!res.ok) {
      setError(res.message || "Could not post the comment.");
      return;
    }
    setBody("");
    setReplyTo(null);
    setComments((prev) => [...prev, res.comment]);
    onAdded?.();
  }

  async function saveEdit(comment) {
    if (!editBody.trim()) return;
    const res = await call("editComment", { comment_id: comment.id, body: editBody });
    if (!res.ok) {
      setError(res.message || "Could not edit the comment.");
      return;
    }
    setEditingId(null);
    load();
  }

  async function removeComment(comment) {
    if (!window.confirm("Delete this comment?")) return;
    const res = await call("deleteComment", { comment_id: comment.id });
    if (!res.ok) {
      setError(res.message || "Could not delete the comment.");
      return;
    }
    load();
  }

  const tops = comments.filter((c) => !c.parent_id);
  const repliesOf = (id) => comments.filter((c) => c.parent_id === id);

  function renderComment(c, indented) {
    return (
      <div key={c.id} style={{ display: "flex", gap: 10, marginLeft: indented ? 34 : 0 }}>
        <Avatar user={c.author} size={indented ? 28 : 34} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13 }}>
            <strong>{c.author.display_name}</strong> <OwnerBadge user={c.author} /> <span style={{ color: "var(--dim)" }}>@{c.author.username} · {timeAgo(c.created_at)}</span>
          </div>
          {editingId === c.id ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                saveEdit(c);
              }}
              style={{ display: "flex", gap: 6, marginTop: 4 }}
            >
              <input className="input" value={editBody} onChange={(e) => setEditBody(e.target.value)} maxLength={500} />
              <button className="btn btn-primary btn-small" type="submit">
                Save
              </button>
              <button className="btn btn-small" type="button" onClick={() => setEditingId(null)}>
                Cancel
              </button>
            </form>
          ) : (
            <>
              <div style={{ fontSize: 15 }}>{renderRichText(c.body, onHashtag, onMention)}{c.pinned ? " 📌" : ""}</div>
              {(post.author?.is_me || false) && <button className="btn btn-small" onClick={async () => { await call("pinComment", { comment_id: c.id, pinned: !c.pinned }); const r = await call("getComments", { post_id: post.id }); if (r.ok) setComments(r.comments); }}>{c.pinned ? "Unpin" : "Pin comment"}</button>}
            </>
          )}
          <div style={{ display: "flex", gap: 10, marginTop: 2, fontSize: 12.5 }}>
            {!indented && (
              <button onClick={() => setReplyTo(c)} style={{ background: "none", border: "none", color: "var(--dim)", padding: 0, fontWeight: 700 }}>
                Reply
              </button>
            )}
            {c.is_mine && (
              <button
                onClick={() => {
                  setEditingId(c.id);
                  setEditBody(c.body);
                }}
                style={{ background: "none", border: "none", color: "var(--dim)", padding: 0, fontWeight: 700 }}
              >
                Edit
              </button>
            )}
            {c.can_delete && (
              <button onClick={() => removeComment(c)} style={{ background: "none", border: "none", color: "var(--bad)", padding: 0, fontWeight: 700 }}>
                Delete
              </button>
            )}
          </div>
        </div>
      </div>
      );
    }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 60, display: "flex", alignItems: "flex-end", justifyContent: "center" }} onClick={onClose}>
      <div
        style={{ background: "var(--surface)", width: "100%", maxWidth: 560, maxHeight: "75vh", borderRadius: "18px 18px 0 0", display: "flex", flexDirection: "column", padding: "14px 16px calc(14px + env(safe-area-inset-bottom))" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <strong>Comments ({comments.length})</strong>
          <button className="btn btn-small" onClick={onClose} aria-label="Close comments">
            ✕
          </button>
        </div>
        <div style={{ overflowY: "auto", flex: 1, display: "grid", gap: 12, padding: "6px 0" }}>
          {comments.length === 0 && <p style={{ color: "var(--dim)" }}>No comments yet — be the first!</p>}
          {tops.map((c) => (
            <div key={c.id} style={{ display: "grid", gap: 10 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                <div style={{ flex: 1 }}>{renderComment(c, false)}</div>
                <button onClick={() => setReportComment(c)} style={{ background: "none", border: "none", fontSize: 14, opacity: 0.65, alignSelf: "flex-start" }} aria-label="Report comment" title="Report comment">
                  🚩
                </button>
              </div>
              {repliesOf(c.id).map((r) => renderComment(r, true))}
            </div>
          ))}
        </div>
        <Notice text={error} bad />
        {replyTo && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, color: "var(--dim)", marginBottom: 4 }}>
            <span>
              Replying to <strong style={{ color: "var(--text)" }}>@{replyTo.author.username}</strong>
            </span>
            <button onClick={() => setReplyTo(null)} style={{ background: "none", border: "none", color: "var(--dim)" }}>
              ✕ Cancel reply
            </button>
          </div>
        )}
        <form onSubmit={submit} style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input className="input" placeholder={replyTo ? `Reply to @${replyTo.author.username}…` : "Add a comment…"} value={body} onChange={(e) => setBody(e.target.value)} maxLength={500} aria-label="Comment text" />
          <button className="btn btn-primary" type="submit" disabled={busy}>
            Post
          </button>
        </form>
      </div>
      {reportComment && <ReportDialog targetType="comment" targetId={reportComment.id} label="comment" onClose={() => setReportComment(null)} />}
    </div>
  );
}

// ---------- feed ------------------------------------------------------------------

// ---------- report / moderation UI ------------------------------------------------
// Shared report dialog: reason list + optional details, used for videos,
// lives, comments and users. Reports feed the owner's moderation queue;
// enough distinct reports auto-hide content (see server reportContent).
const REPORT_REASONS = [
  ["spam", "🚫 Spam"],
  ["abuse", "😡 Abuse / harassment"],
  ["nudity", "🔞 Nudity / sexual content"],
  ["violence", "⚠️ Violence"],
  ["other", "❓ Other"],
];

export function ReportDialog({ targetType, targetId, label, onClose }) {
  const [reason, setReason] = useState("spam");
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await call("reportContent", { target_type: targetType, target_id: targetId, reason, details: details.trim() });
    setBusy(false);
    if (!res.ok) {
      setError(res.message || "Report could not be sent.");
      return;
    }
    setDone(res.message);
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 80, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={onClose}>
      <div className="card" style={{ width: "100%", maxWidth: 420, maxHeight: "85vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <strong>🚩 Report {label || "this content"}</strong>
          <button className="btn btn-small" onClick={onClose}>
            ✕
          </button>
        </div>
        {done ? (
          <>
            <p style={{ fontSize: 14, marginTop: 12 }}>{done}</p>
            <button className="btn btn-primary" onClick={onClose} style={{ marginTop: 8 }}>
              Close
            </button>
          </>
        ) : (
          <form onSubmit={submit} style={{ display: "grid", gap: 8, marginTop: 12 }}>
            {REPORT_REASONS.map(([value, text]) => (
              <label key={value} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 15, cursor: "pointer" }}>
                <input type="radio" name="report-reason" value={value} checked={reason === value} onChange={() => setReason(value)} />
                {text}
              </label>
            ))}
            <textarea className="input" rows={3} maxLength={500} placeholder="Details (optional)" value={details} onChange={(e) => setDetails(e.target.value)} />
            <Notice text={error} bad />
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? "Sending…" : "Send report"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

// ---- caption (title + description/hashtags) --------------------------------------
// Long captions used to cover the whole video. This block renders the
// title (bold) and description as ONE flowing caption clamped to 2
// lines; when the text overflows, a "… more" toggle expands it in
// place (capped at ~55% of the card, scrollable beyond that) and
// "bandh karo" collapses it again. Short captions render plainly —
// no toggle. Tapping the caption text itself also toggles; the block
// is not part of the <video> element, so this never fights the
// play/pause tap on the video.
export function renderRichText(text, onHashtag, onMention) {
  const parts = String(text ?? "").split(/(#[\p{L}\p{N}_]+|@[A-Za-z0-9_]+)/gu);
  return parts.map((part, i) => {
    if (part.startsWith("#") && onHashtag) return <button key={i} type="button" onClick={(e) => { e.stopPropagation(); onHashtag(part); }} style={{ background: "none", border: "none", color: "var(--accent)", fontWeight: 700, padding: 0, cursor: "pointer", fontSize: "inherit" }}>{part}</button>;
    if (part.startsWith("@") && onMention) return <button key={i} type="button" onClick={(e) => { e.stopPropagation(); onMention(part.slice(1)); }} style={{ background: "none", border: "none", color: "var(--accent)", fontWeight: 700, padding: 0, cursor: "pointer", fontSize: "inherit" }}>{part}</button>;
    return <span key={i}>{part}</span>;
  });
}

function CaptionBlock({ title, description, onHashtag, onMention }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const textRef = useRef(null);
  const combined = `${title ?? ""} ${description ?? ""}`.trim();

  // Decide overflow once per caption, measured on the clamped render.
  useEffect(() => {
    setExpanded(false);
    const el = textRef.current;
    if (!el) return;
    if (el.clientHeight === 0 && el.scrollHeight === 0) {
      // No layout engine (headless render tests): estimate by length —
      // at feed caption widths, >90 chars cannot fit the 2-line clamp.
      setOverflowing(combined.length > 90);
    } else {
      setOverflowing(el.scrollHeight > el.clientHeight + 2);
    }
  }, [combined]);

  return (
    <div style={{ marginTop: 2 }}>
      <div
        ref={textRef}
        data-caption-text=""
        data-expanded={expanded ? "true" : "false"}
        onClick={() => {
          if (overflowing) setExpanded((v) => !v);
        }}
        style={
          expanded
            ? { maxHeight: "48dvh", overflowY: "auto", fontSize: 15, cursor: overflowing ? "pointer" : undefined }
            : { display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", fontSize: 15, cursor: overflowing ? "pointer" : undefined }
        }
      >
        <span style={{ fontWeight: 700 }}>{renderRichText(title, onHashtag, onMention)}</span>
        {description ? <span style={{ fontSize: 14, opacity: 0.9 }}> {renderRichText(description, onHashtag, onMention)}</span> : null}
      </div>
      {overflowing && !expanded && (
        <button
          type="button"
          data-caption-toggle=""
          aria-label="Show full caption"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(true);
          }}
          style={{ display: "block", background: "none", border: "none", color: "var(--accent)", padding: "3px 0 0", fontSize: 13.5, fontWeight: 700, textShadow: "none", cursor: "pointer", textAlign: "left" }}
        >
          … more
        </button>
      )}
      {overflowing && expanded && (
        <button
          type="button"
          data-caption-toggle=""
          aria-label="Hide full caption"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(false);
          }}
          style={{ background: "none", border: "none", color: "inherit", padding: "2px 0 0", fontSize: 13.5, fontWeight: 700, opacity: 0.85, cursor: "pointer", textShadow: "none" }}
        >
          bandh karo
        </button>
      )}
    </div>
  );
}

// Section 71 rail icons: vector strokes (lime = active), not emoji, so the
// right-side column reads the same at any density. Colours are the old
// Zoomly palette only — accent is lime, never TikTok pink/cyan.
function HeartIcon({ filled }) {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill={filled ? "var(--accent)" : "none"} stroke={filled ? "var(--accent)" : "#fff"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  );
}
function CommentIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}
function BookmarkIcon({ filled }) {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill={filled ? "var(--accent)" : "none"} stroke={filled ? "var(--accent)" : "#fff"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  );
}
function ShareIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" />
      <path d="M16 6l-4-4-4 4" />
      <path d="M12 2v13" />
    </svg>
  );
}
function SearchIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.35-4.35" />
    </svg>
  );
}

function VideoCard({ post, onLike, onFollow, onComment, onOpenProfile, onBlock, badge, canModerate, onDelete, onHashtag, onMention, saved, onToggleSave }) {
  const videoRef = useRef(null);
  const cardRef = useRef(null);
  // Sound is ON by default; `muted` here is only ever the viewer's own
  // persisted choice — or a temporary browser-forced muted autoplay
  // (forcedMute), which shows the "🔊 Sound on" overlay and is NOT
  // persisted as a preference.
  const [muted, setMuted] = useState(() => viewerMuted());
  const [forcedMute, setForcedMute] = useState(false);
  const [paused, setPaused] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [progress, setProgress] = useState(0);
  const [videoError, setVideoError] = useState(false);
  const [videoKey, setVideoKey] = useState(0);
  const holdTimerRef = useRef(0);
  const holdFiredRef = useRef(false);
  const completedRef = useRef(false);
  const lastTimeRef = useRef(0);
  const [reportOpen, setReportOpen] = useState(false);
  const [shareNote, setShareNote] = useState("");
  // Feed tap gestures (owner spec): ONE tap toggles play/pause, a
  // DOUBLE tap likes. The single tap is deferred ~300ms so a double
  // tap can cancel it — the two never fight. `flash` is the brief
  // centre glyph for the tap action; `bursts` are double-tap hearts.
  const [flash, setFlash] = useState(null); // "play" | "pause" | null
  const [bursts, setBursts] = useState([]);
  const tapTimerRef = useRef(0);
  const flashTimerRef = useRef(0);
  const burstSeqRef = useRef(0);

  useEffect(
    () => () => {
      clearTimeout(tapTimerRef.current);
      clearTimeout(flashTimerRef.current);
    },
    []
  );

  async function shareVideo() {
    const url = `${window.location.origin}/?v=${post.id}`;
    call("recordShare", { post_id: post.id }).catch(() => {});
    const result = await shareUrl({ url, text: `Watch “${post.title}” on Zoomly` });
    if (result === "copied") {
      setShareNote("Link copied ✓");
      setTimeout(() => setShareNote(""), 2000);
    } else if (result === "failed") {
      window.prompt("Copy this video link:", url);
    }
  }
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  // Keep the element's muted property in lockstep with the state (the
  // React attribute alone does not reliably flip the property).
  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
  }, [muted]);

  useEffect(() => {
    const el = cardRef.current;
    const video = videoRef.current;
    if (!el || !video) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const wantMuted = mutedRef.current;
            video.muted = wantMuted;
            video
              .play()
              .then(() => {
                if (!wantMuted) setForcedMute(false);
              })
              .catch(() => {
                if (!wantMuted) {
                  // Autoplay-with-sound blocked (no page interaction
                  // yet): start muted, offer one-tap sound instead.
                  video.muted = true;
                  setMuted(true);
                  setForcedMute(true);
                  video.play().catch(() => {});
                }
              });
            setPaused(false);
          } else {
            video.pause();
          }
        }
      },
      { threshold: 0.6 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Section 71: pause when the app/tab goes to the background; resume on
  // return only if this card is still the on-screen one (the observer
  // above owns the normal in/out-of-viewport pauses).
  useEffect(() => {
    function onVis() {
      const video = videoRef.current;
      if (!video) return;
      if (document.hidden) {
        video.pause();
        setPaused(true);
      } else {
        const rect = cardRef.current?.getBoundingClientRect();
        if (rect && rect.top < window.innerHeight && rect.bottom > 0 && !videoError) {
          video.play().catch(() => {});
          setPaused(false);
        }
      }
    }
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [videoError]);

  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch(() => {});
      setPaused(false);
    } else {
      video.pause();
      setPaused(true);
    }
  }

  function showTapFlash(kind) {
    setFlash(kind);
    clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlash(null), 650);
  }

  function burstAt(e) {
    const rect = cardRef.current?.getBoundingClientRect();
    burstSeqRef.current += 1;
    const id = burstSeqRef.current;
    const heart = { id, x: rect ? e.clientX - rect.left : 0, y: rect ? e.clientY - rect.top : 0 };
    setBursts((prev) => [...prev.slice(-5), heart]);
    setTimeout(() => setBursts((prev) => prev.filter((b) => b.id !== id)), 780);
  }

  // Tap disambiguation on the video itself. First tap starts the
  // window; a second tap inside it is a DOUBLE tap: burst a heart and
  // like — a like-only path (on an already-liked post it changes
  // nothing, it never unlikes). If the window expires, the tap was
  // single: toggle play/pause and flash the action glyph. Caption taps
  // land on the caption block (a separate element), and the rail
  // buttons are their own targets — neither reaches this handler.
  function handleVideoTap(e) {
    if (holdFiredRef.current) { holdFiredRef.current = false; return; }
    if (tapTimerRef.current) {
      clearTimeout(tapTimerRef.current);
      tapTimerRef.current = 0;
      burstAt(e);
      if (!post.liked_by_me) onLike(post);
      return;
    }
    tapTimerRef.current = setTimeout(() => {
      tapTimerRef.current = 0;
      const willPlay = videoRef.current ? videoRef.current.paused : true;
      togglePlay();
      showTapFlash(willPlay ? "play" : "pause");
    }, 300);
  }

  // The speaker button is the viewer's own control: whatever they pick
  // becomes the persisted default for every player.
  function toggleMute() {
    const next = !muted;
    setForcedMute(false);
    setMuted(next);
    setViewerMuted(next);
    if (videoRef.current) videoRef.current.muted = next;
  }

  function soundOn() {
    setForcedMute(false);
    setMuted(false);
    setViewerMuted(false);
    const video = videoRef.current;
    if (video) {
      video.muted = false;
      video.play().catch(() => {});
    }
  }

  return (
    <div className="feed-item" ref={cardRef} style={{ background: "var(--bg)" }}>
      <video
        key={videoKey}
        ref={videoRef}
        src={post.video_url}
        poster={post.thumbnail_url || undefined}
        // User order 2026-10-26: original aspect ratio, NEVER cropped —
        // this overrides the earlier Section 71 center-crop rule.
        // contain letterboxes landscape/portrait videos with old-bg bars.
        style={{ width: "100%", height: "100%", objectFit: "contain", background: "var(--bg)" }}
        loop
        muted={muted}
        playsInline
        preload="metadata"
        onClick={handleVideoTap}
        onPointerDown={() => { holdTimerRef.current = setTimeout(() => { holdFiredRef.current = true; videoRef.current?.pause(); setPaused(true); }, 600); }}
        onPointerUp={() => { clearTimeout(holdTimerRef.current); if (holdFiredRef.current) { videoRef.current?.play().catch(() => {}); setPaused(false); } }}
        onPointerLeave={() => clearTimeout(holdTimerRef.current)}
        onPlay={() => { notePostView(post); call("recordWatchEvent", { post_id: post.id, event: "started" }).catch(() => {}); }}
        onTimeUpdate={(e) => { const v = e.target; if (v.duration) { setProgress(v.currentTime / v.duration); if (v.currentTime < lastTimeRef.current - 1) call("recordWatchEvent", { post_id: post.id, event: "replay" }).catch(() => {}); lastTimeRef.current = v.currentTime; if (v.currentTime / v.duration > 0.9 && !completedRef.current) { completedRef.current = true; call("recordWatchEvent", { post_id: post.id, event: "completed", duration_ms: Math.round(v.duration * 1000), watch_ms: Math.round(v.currentTime * 1000) }).catch(() => {}); } } }}
        onError={() => { setVideoError(true); call("recordMetric", { kind: "playback_failure" }).catch(() => {}); }}
        onWaiting={() => setBuffering(true)}
        onPlaying={() => setBuffering(false)}
        onCanPlay={() => setBuffering(false)}
      />
      {/* No bottom progress bar: the old 3px lime/white strip at the very
          bottom edge of the video read as a stray line cutting across
          the video on phones, so it was removed (looped short videos
          do not need it; progress state is still tracked internally). */}
      {videoError && (
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, background: "rgba(0,0,0,0.6)", zIndex: 5 }}>
          <span style={{ color: "#fff", fontWeight: 700 }}>Video could not play (network or file error)</span>
          <button className="btn btn-primary" onClick={() => { setVideoError(false); setVideoKey((k) => k + 1); }}>↻ Retry video</button>
        </div>
      )}
      {buffering && !paused && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }} aria-label="Loading video">
          <div className="buffer-spinner" />
        </div>
      )}
      {(flash || paused) && (
        <div
          data-tap-flash={flash ?? undefined}
          data-paused-overlay={!flash && paused ? "" : undefined}
          className={flash ? "zoomly-tap-flash" : undefined}
          style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none", fontSize: 64, opacity: 0.8 }}
        >
          {flash === "pause" ? "⏸" : "▶"}
        </div>
      )}
      {bursts.map((b) => (
        <span key={b.id} className="zoomly-heart-burst" style={{ left: b.x, top: b.y }}>
          ❤️
        </span>
      ))}
      {badge && (
        <div style={{ position: "absolute", top: 10, left: 10, background: "rgba(10,10,10,0.78)", color: "#fff", borderRadius: 999, padding: "5px 11px", fontSize: 12.5, fontWeight: 700, zIndex: 4 }}>{badge}</div>
      )}
      {post.hidden && post.author?.is_me && (
        <div style={{ position: "absolute", top: 10, left: 10, right: 10, background: "rgba(120,53,15,0.92)", color: "#ffd9a8", borderRadius: 10, padding: "8px 10px", fontSize: 13, zIndex: 4 }}>
          ⏳ Ye video reports ki wajah se <strong>review me hai</strong> — abhi sirf tumhe dikh rahi hai.
        </div>
      )}
      {forcedMute && !paused && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            soundOn();
          }}
          style={{
            position: "absolute",
            left: "50%",
            bottom: 168,
            transform: "translateX(-50%)",
            background: "rgba(0,0,0,0.72)",
            color: "#fff",
            border: "1px solid rgba(255,255,255,0.45)",
            borderRadius: 999,
            padding: "9px 18px",
            fontSize: 15,
            fontWeight: 700,
            zIndex: 3,
            whiteSpace: "nowrap",
          }}
        >
          🔊 Sound on
        </button>
      )}
      <div style={{ position: "absolute", right: 12, bottom: 96, display: "flex", flexDirection: "column", gap: 12, alignItems: "center", zIndex: 3 }}>
        <div style={{ position: "relative", width: 52, height: 52 }}>
          <button onClick={() => onOpenProfile(post.author.id)} style={{ background: "none", border: "none", padding: 0, display: "block" }} aria-label="Open profile">
            <Avatar user={post.author} size={52} />
          </button>
          {post.author && !post.author.is_me && (
            <button
              onClick={() => onFollow(post.author)}
              aria-label={post.author.followed_by_me ? "Unfollow" : "Follow"}
              title={post.author.followed_by_me ? "Unfollow" : "Follow"}
              style={{ position: "absolute", right: 0, bottom: -2, width: 22, height: 22, borderRadius: "50%", background: "var(--accent)", color: "#131a02", border: "2px solid var(--bg)", fontSize: 16, fontWeight: 900, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}
            >
              {post.author.followed_by_me ? "✓" : "+"}
            </button>
          )}
        </div>
        <button onClick={() => onLike(post)} className={`rail-btn like-btn ${post.liked_by_me ? "liked like-pop" : ""}`} aria-label={post.liked_by_me ? "Unlike" : "Like"}>
          <HeartIcon filled={post.liked_by_me} />
          <span className="rail-count">{post.like_count}</span>
        </button>
        <button onClick={() => onComment(post)} className="rail-btn" aria-label="Comments">
          <CommentIcon />
          <span className="rail-count">{post.comment_count}</span>
        </button>
        <button
          onClick={() => onToggleSave?.(post)}
          className="rail-btn"
          aria-label={saved ? "Remove bookmark" : "Bookmark video"}
          title={saved ? "Saved" : "Save video"}
        >
          <BookmarkIcon filled={!!saved} />
          <span className="rail-label">{saved ? "Saved" : "Save"}</span>
        </button>
        <button onClick={shareVideo} className="rail-btn" aria-label="Share video" title="Share video">
          <ShareIcon />
          <span className="rail-label">{shareNote || "Share"}</span>
        </button>
        <button onClick={toggleMute} className={`sound-disc ${muted ? "muted" : ""}`} aria-label={muted ? "Unmute original audio" : "Mute original audio"} title="Original audio">
          {/* Vector note — replaces the spinning ♪ text glyph, which rendered
              as a printed-looking mark on Android. */}
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M9 18.5A2.5 2.5 0 1 1 6.5 16c.4 0 .8.1 1.1.3V5.5L19 3v11a2.5 2.5 0 1 1-1.5-2.3V6.2L9 8.4v10.1z" />
          </svg>
        </button>
        <div style={{ position: "relative" }}>
          <button onClick={() => setMenuOpen((v) => !v)} style={{ background: "none", border: "none", color: "#fff", fontSize: 24, lineHeight: 1 }} aria-label="More options">
            ⋯
          </button>
          {menuOpen && (
            <div style={{ position: "absolute", right: 46, bottom: 0, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 6, display: "grid", gap: 2, minWidth: 190, zIndex: 6, boxShadow: "0 10px 30px rgba(0,0,0,0.5)" }}>
              <button
                className="btn btn-small"
                onClick={() => {
                  setMenuOpen(false);
                  setReportOpen(true);
                }}
              >
                🚩 Report video
              </button>
              <button className="btn btn-small" onClick={async () => { setMenuOpen(false); await call("toggleSave", { post_id: post.id }); }}>
                💾 Save video
              </button>
              <button className="btn btn-small" onClick={async () => { setMenuOpen(false); await call("hideNotInterested", { post_id: post.id }); onBlock?.(null); }}>
                🙈 Not interested
              </button>
              <div style={{ fontSize: 12, color: "var(--dim)", padding: "4px 8px" }}>Quality: single Cloudinary source — no quality selector exists (no variants are served).</div>
              {post.author && !post.author.is_me && (
                <button
                  className="btn btn-small"
                  onClick={async () => {
                    setMenuOpen(false);
                    if (!window.confirm(`Block @${post.author.username}? Unki videos, comments aur live ab tumhe nahi dikhengi.`)) return;
                    const res = await call("blockUser", { user_id: post.author.id });
                    if (res.ok) onBlock?.(post.author);
                  }}
                >
                  🚫 Block @{post.author?.username}
                </button>
              )}
              {canModerate && post.author && !post.author.is_me && (
                <button
                  className="btn btn-small"
                  data-admin-delete=""
                  onClick={async () => {
                    setMenuOpen(false);
                    if (!window.confirm("Ye video delete kar dein?")) return;
                    const res = await call("deletePost", { post_id: post.id });
                    if (res.ok) onDelete?.(post);
                  }}
                >
                  🗑 Delete video (Owner)
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {/* NO caption scrim, NO text-shadow — user order 2026-10-26:
          the dark gradient/shadow beside the caption text is removed
          entirely, by the user's explicit choice. Plain text on the
          video only; do NOT reintroduce a scrim in another form. */}
      <div style={{ position: "absolute", left: 0, right: 84, bottom: 0, color: "#fff", textShadow: "none", padding: "2px 12px 2px", zIndex: 2 }}>
        <button onClick={() => onOpenProfile(post.author.id)} style={{ background: "none", border: "none", color: "#fff", padding: 0, fontWeight: 800, fontSize: 16 }}>
          @{post.author?.username}
        </button>{" "}
        <OwnerBadge user={post.author} />
        <CaptionBlock title={post.title} description={post.description} onHashtag={onHashtag} onMention={onMention} />
        <button onClick={toggleMute} style={{ background: "none", border: "none", color: "#fff", padding: 0, fontSize: 13, marginTop: 4, textAlign: "left", display: "flex", alignItems: "center", gap: 5 }} aria-label="Original audio — toggle sound">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 18.5A2.5 2.5 0 1 1 6.5 16c.4 0 .8.1 1.1.3V5.5L19 3v11a2.5 2.5 0 1 1-1.5-2.3V6.2L9 8.4v10.1z" /></svg>
          Original audio · @{post.author?.username} {muted ? "(muted)" : ""}
        </button>
        <div style={{ fontSize: 12, opacity: 0.75, marginTop: 2 }}>{timeAgo(post.created_at)}</div>
      </div>
      {reportOpen && <ReportDialog targetType="post" targetId={post.id} label="video" onClose={() => setReportOpen(false)} />}
    </div>
  );
}

// ---------- stories (24h) ---------------------------------------------------------
function storyRingStyle(unseen) {
  return {
    display: "inline-flex",
    borderRadius: "50%",
    padding: 2.5,
    background: unseen ? "conic-gradient(from 210deg, #feda75, #fa7e1e, #d62976, #962fbf, #4f5bd5, #feda75)" : "var(--border)",
  };
}

// Full-screen story player: tap right/left to move through an author's
// stories, then on to the next author. Views are recorded once per story;
// the owner gets the view count, a viewers list and a delete button.
export function StoryViewer({ groups, startAuthorId, me, onClose, onChanged }) {
  const [gIdx, setGIdx] = useState(() => Math.max(0, groups.findIndex((g) => g.author?.id === startAuthorId)));
  const [sIdx, setSIdx] = useState(0);
  const [viewers, setViewers] = useState(null);
  const viewedRef = useRef(new Set());
  const group = groups[gIdx];
  const story = group?.stories?.[sIdx];

  useEffect(() => {
    setViewers(null);
  }, [gIdx, sIdx]);

  useEffect(() => {
    if (!story) return;
    if (!viewedRef.current.has(story.id)) {
      viewedRef.current.add(story.id);
      call("viewStory", { story_id: story.id });
    }
  }, [story?.id]);

  if (!group || !story) return null;
  const isMine = group.author?.id === me?.id;

  function next() {
    if (sIdx + 1 < group.stories.length) setSIdx(sIdx + 1);
    else if (gIdx + 1 < groups.length) {
      setGIdx(gIdx + 1);
      setSIdx(0);
    } else onClose();
  }
  function prev() {
    if (sIdx > 0) setSIdx(sIdx - 1);
    else if (gIdx > 0) {
      setGIdx(gIdx - 1);
      setSIdx(groups[gIdx - 1].stories.length - 1);
    }
  }
  async function showViewers() {
    const res = await call("getStoryViewers", { story_id: story.id });
    if (res.ok) setViewers(res.viewers);
  }
  async function remove() {
    if (!window.confirm("Story delete kar dein?")) return;
    const res = await call("deleteStory", { story_id: story.id });
    if (res.ok) {
      onChanged?.();
      onClose();
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000", zIndex: 90, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", gap: 4, padding: "10px 12px 0" }}>
        {group.stories.map((s, i) => (
          <div key={s.id} style={{ flex: 1, height: 3, borderRadius: 999, background: i < sIdx ? "#fff" : i === sIdx ? "#fff" : "rgba(255,255,255,0.35)", opacity: i <= sIdx ? 1 : 0.5 }} />
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px" }}>
        <Avatar user={group.author} size={36} />
        <div style={{ flex: 1, color: "#fff" }}>
          <strong>{group.author?.display_name}</strong> <OwnerBadge user={group.author} />{" "}
          <span style={{ color: "rgba(255,255,255,0.7)", fontSize: 13 }}>
            @{group.author?.username} · {timeAgo(story.created_at)}
          </span>
        </div>
        {isMine && (
          <button className="btn btn-small" onClick={remove} style={{ background: "rgba(20,20,20,0.6)", color: "#ff9a8a", borderColor: "rgba(255,255,255,0.3)" }}>
            🗑
          </button>
        )}
        <button className="btn btn-small" onClick={onClose} style={{ background: "rgba(20,20,20,0.6)", color: "#fff", borderColor: "rgba(255,255,255,0.3)" }}>
          ✕
        </button>
      </div>
      <div style={{ flex: 1, position: "relative", display: "flex", alignItems: "center", justifyContent: "center", minHeight: 0 }}>
        {story.media_type === "video" ? (
          <video src={story.media_url} autoPlay loop playsInline style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
        ) : (
          <img src={story.media_url} alt="Story" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
        )}
        <button onClick={prev} aria-label="Previous story" style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "32%", background: "none", border: "none" }} />
        <button onClick={next} aria-label="Next story" style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: "32%", background: "none", border: "none" }} />
      </div>
      {isMine && (
        <div style={{ padding: "10px 12px calc(12px + env(safe-area-inset-bottom))", color: "#fff" }}>
          <button className="btn btn-small" onClick={showViewers} style={{ background: "rgba(20,20,20,0.6)", color: "#fff", borderColor: "rgba(255,255,255,0.3)" }}>
            👀 {story.view_count} views — viewers dekho
          </button>
          {viewers && (
            <div style={{ marginTop: 8, display: "grid", gap: 6, maxHeight: "30vh", overflowY: "auto" }}>
              {viewers.length === 0 && <span style={{ color: "rgba(255,255,255,0.7)", fontSize: 13.5 }}>Abhi tak kisi ne nahi dekha.</span>}
              {viewers.map((v) => (
                <div key={v.viewer.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Avatar user={v.viewer} size={28} />
                  <span style={{ fontSize: 14 }}>
                    {v.viewer.display_name} <span style={{ color: "rgba(255,255,255,0.65)" }}>@{v.viewer.username} · {timeAgo(v.viewed_at)}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// The story strip in its own Stories section at the top of the Watch tab:
// my own story (with + to add) and every followee with active stories,
// ring-colored while unseen. (Moved out of the feed 2026-10-23 — the strip
// ate vertical space and made feed videos render shorter.)
function StoriesRow({ me }) {
  const [groups, setGroups] = useState([]);
  const [viewer, setViewer] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [note, setNote] = useState("");
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    const res = await call("getStories", {});
    if (res.ok) setGroups(res.groups);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function pickStory(f) {
    if (!f) return;
    setUploading(true);
    setNote("");
    const kind = f.type.startsWith("video") ? "video" : "image";
    const up = await uploadMedia(f, kind);
    if (!up.ok) {
      setUploading(false);
      setNote(up.message || "Story upload failed.");
      return;
    }
    const res = await call("createStory", { media_url: up.url, media_public_id: up.public_id, media_type: kind });
    setUploading(false);
    if (res.ok) {
      setNote("Story lag gayi ✓ (24 ghante rahegi)");
      load();
    } else setNote(res.message || "Story could not be posted.");
  }

  const myGroup = groups.find((g) => g.author?.id === me?.id);
  const otherGroups = groups.filter((g) => g.author?.id !== me?.id);

  return (
    <div style={{ padding: "6px 10px 0" }}>
      <div className="no-scrollbar" style={{ display: "flex", gap: 12, overflowX: "auto" }}>
        <div style={{ textAlign: "center", flexShrink: 0, width: 66 }}>
          <button onClick={() => (myGroup ? setViewer(me.id) : fileRef.current?.click())} style={{ background: "none", border: "none", padding: 0, position: "relative" }} aria-label="Your story">
            <span style={storyRingStyle(myGroup ? myGroup.has_unseen : false)}>
              <Avatar user={me} size={54} />
            </span>
            <span
              onClick={(e) => {
                e.stopPropagation();
                fileRef.current?.click();
              }}
              style={{ position: "absolute", right: -1, bottom: -1, background: "var(--accent)", color: "#06280f", borderRadius: "50%", width: 20, height: 20, fontSize: 14, fontWeight: 900, display: "flex", alignItems: "center", justifyContent: "center", border: "2px solid var(--bg)" }}
            >
              +
            </span>
          </button>
          <div style={{ fontSize: 11.5, color: "var(--dim)", marginTop: 3 }}>{uploading ? "Uploading…" : "Your story"}</div>
        </div>
        {otherGroups.map((g) => (
          <div key={g.author.id} style={{ textAlign: "center", flexShrink: 0, width: 66 }}>
            <button onClick={() => setViewer(g.author.id)} style={{ background: "none", border: "none", padding: 0 }} aria-label={`Story by ${g.author.username}`}>
              <span style={storyRingStyle(g.has_unseen)}>
                <Avatar user={g.author} size={54} />
              </span>
            </button>
            <div style={{ fontSize: 11.5, color: "var(--dim)", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.author.username}</div>
          </div>
        ))}
      </div>
      {note && <div style={{ fontSize: 12.5, color: "var(--dim)", marginTop: 2 }}>{note}</div>}
      <input ref={fileRef} type="file" accept="image/*,video/*" style={{ display: "none" }} onChange={(e) => pickStory(e.target.files?.[0])} />
      {viewer && (
        <StoryViewer
          groups={groups}
          startAuthorId={viewer}
          me={me}
          onClose={() => {
            setViewer(null);
            load();
          }}
          onChanged={load}
        />
      )}
    </div>
  );
}

function FeedView({ me, onOpenProfile, refreshMe, onGoLive, onOpenNotifications, onOpenSearch, onOpenCommunity, sharedPostId, onHashtag, onMention }) {
  const [stream, setStream] = useState("foryou");
  const [posts, setPosts] = useState([]);
  const [savedIds, setSavedIds] = useState(() => new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [commentPost, setCommentPost] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // A video shared via /?v=<id> opens pinned at the top of the feed.
  const [sharedPost, setSharedPost] = useState(null);
  const [sharedMissing, setSharedMissing] = useState(false);
  const waking = useWaking();

  useEffect(() => {
    if (!sharedPostId) return;
    (async () => {
      const res = await call("getPost", { post_id: sharedPostId });
      if (res.ok) setSharedPost(res.post);
      else setSharedMissing(true);
    })();
  }, [sharedPostId]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    // getFeed is a read: retried automatically while the server wakes up.
    const res = await call("getFeed", { stream, limit: 30 });
    if (res.ok) {
      // Belt-and-braces: a post id may never render twice in one feed
      // session (the server orders seen-last; this guards the list
      // itself, and any future paged append goes through the same cut).
      const seenIds = new Set();
      setPosts(
        (res.posts ?? []).filter((p) => {
          if (seenIds.has(p.id)) return false;
          seenIds.add(p.id);
          return true;
        }),
      );
    } else if (res.transportError) setLoadError(true);
    setLoading(false);
  }, [stream]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleLike(post) {
    const res = await call("toggleLike", { post_id: post.id });
    if (res.ok) {
      const patch = (p) => (p.id === post.id ? { ...p, liked_by_me: res.liked, like_count: res.like_count } : p);
      setPosts((prev) => prev.map(patch));
      setSharedPost((prev) => (prev ? patch(prev) : prev));
    }
  }

  async function handleFollow(author) {
    const res = await call("toggleFollow", { user_id: author.id });
    if (res.ok) {
      const patch = (p) => (p.author?.id === author.id ? { ...p, author: { ...p.author, followed_by_me: res.following } } : p);
      setPosts((prev) => prev.map(patch));
      setSharedPost((prev) => (prev ? patch(prev) : prev));
      refreshMe?.();
    }
  }

  // Section 71 bookmark state comes from the real saved list (getSavedPosts,
  // max 60) — the feed payload itself carries no saved flag, so the rail
  // shows the server list, never a guessed state.
  useEffect(() => {
    (async () => {
      const res = await call("getSavedPosts", {});
      if (res.ok) setSavedIds(new Set((res.posts ?? []).map((p) => p.id)));
    })();
  }, []);

  async function handleToggleSave(post) {
    const res = await call("toggleSave", { post_id: post.id });
    if (res.ok) {
      setSavedIds((prev) => {
        const next = new Set(prev);
        if (res.saved) next.add(post.id);
        else next.delete(post.id);
        return next;
      });
    }
  }

  async function loadMore() {
    if (loadingMore) return;
    setLoadingMore(true);
    const res = await call("getFeed", { stream, limit: 30, offset: posts.length });
    setLoadingMore(false);
    if (res.ok) {
      const seen = new Set(posts.map((p) => p.id));
      setPosts((prev) => [...prev, ...res.posts.filter((p) => !seen.has(p.id))]);
    }
  }

  // Owner moderation: a video the owner deleted (from the card menu)
  // disappears from the feed at once.
  function handleDeleted(post) {
    setPosts((prev) => prev.filter((p) => p.id !== post.id));
    setSharedPost((prev) => (prev && prev.id === post.id ? null : prev));
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Feed header, fixed 2026-10-26: row 1 holds ONLY Live + the 4 tabs +
          Search, so every tab fits on a 360px phone. Bell + coins moved to
          a small second row below (still reachable, same actions). */}
      <div style={{ padding: "calc(env(safe-area-inset-top) + 4px) 6px 0 6px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <button
            onClick={onGoLive}
            aria-label="Open Live"
            title="Watch live broadcasts"
            style={{
              background: "none",
              border: "none",
              padding: "0 2px",
              cursor: "pointer",
              color: "#fff",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 0,
              flexShrink: 0,
              lineHeight: 1,
              opacity: 0.92,
              minWidth: 38,
              minHeight: 44,
            }}
          >
            {/* Clean record-dot pill — replaces the old TV line-art SVG, whose
                stray strokes read as printed marks on small screens. */}
            <svg width="26" height="18" viewBox="0 0 26 18" fill="none" aria-hidden="true">
              <rect x="1" y="1" width="24" height="16" rx="8" stroke="var(--accent)" strokeWidth="1.6" />
              <circle cx="13" cy="9" r="3.5" fill="var(--accent)" />
            </svg>
            <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: 1, marginTop: 1 }}>LIVE</span>
          </button>
          <div className="feed-top-tabs no-scrollbar" role="tablist" aria-label="Feed">
            <button className="feed-top-tab" onClick={() => onOpenSearch?.()} aria-label="Discover">
              Discover
            </button>
            <button className="feed-top-tab" onClick={() => onOpenCommunity?.()} aria-label="Community">
              Community
            </button>
            <button className={`feed-top-tab ${stream === "following" ? "active" : ""}`} onClick={() => setStream("following")} role="tab" aria-selected={stream === "following"}>
              Following
            </button>
            <button className={`feed-top-tab ${stream === "foryou" ? "active" : ""}`} onClick={() => setStream("foryou")} role="tab" aria-selected={stream === "foryou"}>
              For You
            </button>
          </div>
          <button onClick={() => onOpenSearch?.()} aria-label="Search" title="Search" style={{ background: "none", border: "none", padding: 0, flexShrink: 0, width: 38, height: 44, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <SearchIcon />
          </button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 2px 0 2px" }}>
          <button onClick={onOpenNotifications} aria-label="Notifications" title="Notifications" style={{ position: "relative", background: "none", border: "none", cursor: "pointer", padding: 0, flexShrink: 0, width: 40, height: 34, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.7 21a2 2 0 0 1-3.4 0" />
            </svg>
            {(me?.unread_notifications ?? 0) + (me?.unread_messages ?? 0) > 0 && (
              <span style={{ position: "absolute", top: 1, right: 2, background: "var(--accent)", color: "#131a02", borderRadius: 999, fontSize: 10, fontWeight: 800, padding: "1px 5px" }}>
                {(me?.unread_notifications ?? 0) + (me?.unread_messages ?? 0) > 99 ? "99+" : (me?.unread_notifications ?? 0) + (me?.unread_messages ?? 0)}
              </span>
            )}
          </button>
          <span className="chip" title="Your coin balance" style={{ flexShrink: 0 }}>
            <svg width="17" height="17" viewBox="0 0 20 20" aria-hidden="true" style={{ display: "inline-block", verticalAlign: "-3px" }}>
              <circle cx="10" cy="10" r="9" fill="#FFD700" stroke="#B8860B" strokeWidth="1.5" />
              <circle cx="10" cy="10" r="5.5" fill="none" stroke="#B8860B" strokeWidth="1" />
            </svg> {me?.coin_balance ?? 0}
          </span>
        </div>
      </div>
      <div className="feed-snap" style={{ flex: 1, marginTop: 8 }}>
        {loading && <p style={{ padding: 20, color: "var(--dim)" }}>{waking ? WAKING_TEXT : "Loading videos…"}</p>}
        {!loading && loadError && posts.length === 0 && (
          <div style={{ padding: 28, textAlign: "center", color: "var(--dim)" }}>
            <p style={{ fontSize: 18, color: "var(--text)", fontWeight: 700 }}>Videos could not load</p>
            <p>The server may be waking up — please try again.</p>
            <button className="btn btn-primary" onClick={load}>
              Try again
            </button>
          </div>
        )}
        {!loading && !loadError && posts.length === 0 && (
          <div style={{ padding: 28, textAlign: "center", color: "var(--dim)" }}>
            <p style={{ fontSize: 18, color: "var(--text)", fontWeight: 700 }}>No videos here yet</p>
            <p>{stream === "following" ? "Follow some creators and their videos will show up here." : "Be the first to upload a video — tap the + button below."}</p>
          </div>
        )}
        {sharedMissing && (
          <div style={{ padding: 28, textAlign: "center", color: "var(--dim)" }}>
            <p style={{ fontSize: 18, color: "var(--text)", fontWeight: 700 }}>😕 Shared video available nahi hai</p>
            <p>Ye video delete ho gayi hai ya abhi review me hai. Baqi videos neeche hain.</p>
          </div>
        )}
        {sharedPost && (
          <VideoCard
            key={`shared-${sharedPost.id}`}
            post={sharedPost}
            badge="🔗 Shared video"
            onLike={handleLike}
            onFollow={handleFollow}
            onComment={setCommentPost}
            onOpenProfile={onOpenProfile}
            onHashtag={onHashtag}
            onMention={onMention}
            saved={savedIds.has(sharedPost.id)}
            onToggleSave={handleToggleSave}
            onBlock={(author) => {
              setSharedPost(null);
              setPosts((prev) => prev.filter((p) => p.author?.id !== author.id));
            }}
            canModerate={me?.is_owner === true}
            onDelete={handleDeleted}
          />
        )}
        {posts
          .filter((p) => p.id !== sharedPost?.id)
          .map((post) => (
            <VideoCard
              key={post.id}
              post={post}
              onLike={handleLike}
              onFollow={handleFollow}
              onComment={setCommentPost}
              onOpenProfile={onOpenProfile}
              onHashtag={onHashtag}
              onMention={onMention}
              saved={savedIds.has(post.id)}
              onToggleSave={handleToggleSave}
              onBlock={(author) => setPosts((prev) => prev.filter((p) => p.author?.id !== author.id))}
              canModerate={me?.is_owner === true}
              onDelete={handleDeleted}
            />
          ))}
        {!loading && !loadError && posts.length > 0 && (<><button className="btn" onClick={loadMore} disabled={loadingMore} style={{ margin: "16px auto", display: "block" }}>{loadingMore ? "Loading…" : "Load more videos (pagination)"}</button><button className="btn" onClick={load} style={{ margin: "0 auto 16px", display: "block" }}>↻ Refresh feed</button><AdSlot /></>)}
      </div>
      {commentPost && (
        <CommentsSheet
          post={commentPost}
          onHashtag={onHashtag}
          onMention={onMention}
          onClose={() => setCommentPost(null)}
          onAdded={() => setPosts((prev) => prev.map((p) => (p.id === commentPost.id ? { ...p, comment_count: p.comment_count + 1 } : p)))}
        />
      )}
    </div>
  );
}

// ---------- watch / browse -----------------------------------------------------

function WatchView({ me, onOpenProfile }) {
  const [query, setQuery] = useState("");
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState(null);
  const [commentPost, setCommentPost] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await call("getWatch", { query: query || undefined, limit: 30 });
    if (res.ok) setPosts(res.posts);
    setLoading(false);
  }, [query]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  async function handleLike(post) {
    const res = await call("toggleLike", { post_id: post.id });
    if (res.ok) {
      setPosts((prev) => prev.map((p) => (p.id === post.id ? { ...p, liked_by_me: res.liked, like_count: res.like_count } : p)));
      setPlaying((cur) => (cur && cur.id === post.id ? { ...cur, liked_by_me: res.liked, like_count: res.like_count } : cur));
    }
  }

  // Owner moderation: the app owner can delete any video from here too
  // (the server enforces the admin right on deletePost).
  async function handleAdminDelete(post) {
    if (!window.confirm("Ye video delete kar dein?")) return;
    const res = await call("deletePost", { post_id: post.id });
    if (res.ok) {
      setPosts((prev) => prev.filter((p) => p.id !== post.id));
      setPlaying((cur) => (cur && cur.id === post.id ? null : cur));
    }
  }

  return (
    <div style={{ padding: "14px 14px 20px", maxWidth: 720, margin: "0 auto" }}>
      <h2 style={{ margin: "2px 0 6px" }}>Stories</h2>
      <StoriesRow me={me} />
      <h2 style={{ margin: "20px 0 12px" }}>Watch</h2>
      <input className="input" placeholder="Search videos…" value={query} onChange={(e) => setQuery(e.target.value)} />
      {loading && <p style={{ color: "var(--dim)", marginTop: 14 }}>Loading…</p>}
      {!loading && posts.length === 0 && <p style={{ color: "var(--dim)", marginTop: 14 }}>No videos found.</p>}
      <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
        {posts.map((post) => (
          <div key={post.id} className="card" style={{ display: "flex", gap: 12, padding: 10, cursor: "pointer" }} onClick={() => setPlaying(post)}>
            {post.thumbnail_url ? (
              <img src={post.thumbnail_url} alt="" style={{ width: 128, height: 72, objectFit: "cover", borderRadius: 10, flexShrink: 0, background: "#000" }} />
            ) : (
              <video src={post.video_url} preload="metadata" muted style={{ width: 128, height: 72, objectFit: "cover", borderRadius: 10, flexShrink: 0, background: "#000" }} />
            )}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{post.title}</div>
              <div style={{ color: "var(--dim)", fontSize: 13, marginTop: 3, display: "flex", alignItems: "center", gap: 6 }}>
                <Avatar user={post.author} size={18} /> @{post.author?.username} · {timeAgo(post.created_at)}
              </div>
              <div style={{ color: "var(--dim)", fontSize: 13, marginTop: 2 }}>
                ♥ {post.like_count} · 💬 {post.comment_count}
              </div>
            </div>
          </div>
        ))}
      </div>
      {playing && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.92)", zIndex: 55, display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 14px" }}>
            <button onClick={() => onOpenProfile(playing.author.id)} style={{ background: "none", border: "none", color: "#fff", display: "flex", gap: 8, alignItems: "center", fontWeight: 700 }}>
              <Avatar user={playing.author} size={32} /> @{playing.author?.username}
            </button>
            <button className="btn btn-small" onClick={() => setPlaying(null)}>
              ✕ Close
            </button>
          </div>
          <video
            src={playing.video_url}
            style={{ flex: 1, width: "100%", minHeight: 0, background: "#000" }}
            controls
            autoPlay
            loop
            playsInline
            onPlay={() => notePostView(playing)}
            ref={(el) => {
              // Start from the viewer's sound preference (default: sound
              // on); the native controls let them change it freely after.
              if (el && el.dataset.mutedInit !== "1") {
                el.muted = viewerMuted();
                el.dataset.mutedInit = "1";
              }
            }}
          />
          <div style={{ padding: "12px 16px calc(14px + env(safe-area-inset-bottom))" }}>
            <CaptionBlock title={playing.title} description={playing.description} />
            <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
              <button className="btn" onClick={() => handleLike(playing)} style={{ color: playing.liked_by_me ? "var(--accent)" : "var(--text)" }}>
                ♥ {playing.like_count}
              </button>
              <button className="btn" onClick={() => setCommentPost(playing)}>
                💬 {playing.comment_count} Comments
              </button>
              {me?.is_owner === true && !playing.author?.is_me && (
                <button className="btn" data-admin-delete="" onClick={() => handleAdminDelete(playing)} style={{ color: "#ff9a8a" }}>
                  🗑 Delete video (Owner)
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {commentPost && (
        <CommentsSheet
          post={commentPost}
          onClose={() => setCommentPost(null)}
          onAdded={() => {
            setPosts((prev) => prev.map((p) => (p.id === commentPost.id ? { ...p, comment_count: p.comment_count + 1 } : p)));
            setPlaying((cur) => (cur && cur.id === commentPost.id ? { ...cur, comment_count: cur.comment_count + 1 } : cur));
          }}
        />
      )}
    </div>
  );
}

// ---------- upload ---------------------------------------------------------------

function UploadView({ onPosted, onGoLive }) {
  const [file, setFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const abortRef = useRef(null);

  function pickFile(f) {
    setFile(f || null);
    setDone("");
    setError("");
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(f ? URL.createObjectURL(f) : "");
  }

  // Retry re-uses the kept file + title + description — nothing is lost
  // on a failed upload, and the media step is NOT retried blindly by
  // the RPC client (writes are never auto-retried).
  async function submit(e) {
    e?.preventDefault();
    if (!file) {
      setError("Choose a video file first.");
      return;
    }
    if (!title.trim()) {
      setError("Give your video a title.");
      return;
    }
    setBusy(true);
    setError("");
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const up = await uploadMedia(file, "video", ctrl.signal);
    abortRef.current = null;
    if (!up.ok) {
      setBusy(false);
      setError(up.message || "Upload failed.");
      return;
    }
    const res = await call("createPost", { title, description, video_url: up.url, video_public_id: up.public_id, thumbnail_url: up.thumbnail_url || undefined });
    setBusy(false);
    if (!res.ok) {
      setError(res.message || "Could not post the video.");
      return;
    }
    setFile(null);
    setPreviewUrl("");
    setTitle("");
    setDescription("");
    setDone("Your video is live! 🎉");
    onPosted?.();
  }

  function addHashtag(tag) {
    setDescription((prev) => (prev.includes(tag) ? prev : `${prev ? `${prev} ` : ""}${tag}`));
  }

  return (
    <div style={{ padding: "14px 14px 20px", maxWidth: 560, margin: "0 auto" }}>
      <h2 style={{ margin: "2px 0 12px" }}>＋ Create a video</h2>
      <div className="card" style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <strong style={{ fontSize: 16 }}>🔴 Go Live</strong>
          <p style={{ color: "var(--dim)", fontSize: 13, margin: "2px 0 0" }}>
            Live rooms, gifts aur PK matches — yehi Zoomly ka existing Live system hai, yahan se seedha khulta hai.
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => onGoLive?.()} style={{ flexShrink: 0 }}>
          Go Live →
        </button>
      </div>
      <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
        <div style={{ display: "flex", gap: 8 }}>
          <label className="btn btn-primary" style={{ flex: 1, cursor: "pointer" }}>
            <input type="file" accept="video/*" capture="environment" style={{ display: "none" }} onChange={(e) => pickFile(e.target.files?.[0])} />
            📷 Record with camera
          </label>
          <label className="btn" style={{ flex: 1, cursor: "pointer" }}>
            <input type="file" accept="video/*" style={{ display: "none" }} onChange={(e) => pickFile(e.target.files?.[0])} />
            🖼️ Choose from gallery
          </label>
        </div>
        <p style={{ color: "var(--dim)", fontSize: 13, margin: 0 }}>
          Camera / gallery access is requested by your device when you pick a file (Android permissions: Camera, Microphone, Media). Preview below uses the player's own volume control for sound.
        </p>
        <label className="card" style={{ textAlign: "center", borderStyle: "dashed" }}>
          {previewUrl ? (
            <video src={previewUrl} style={{ width: "100%", maxHeight: 320, borderRadius: 12, background: "#000" }} controls playsInline />
          ) : (
            <div style={{ padding: "18px 0" }}>
              <div style={{ fontSize: 36 }}>⬆️</div>
              <div style={{ fontWeight: 700, marginTop: 4 }}>No video chosen yet</div>
              <div style={{ color: "var(--dim)", fontSize: 13 }}>MP4 and other video formats, up to 100 MB. Cover = the video's first frame (Cloudinary thumbnail).</div>
            </div>
          )}
          {file && <div style={{ color: "var(--dim)", fontSize: 13, marginTop: 6 }}>{file.name}</div>}
        </label>
        <input className="input" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} aria-label="Video title" />
        <textarea className="input" placeholder="Description + hashtags (optional)" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} rows={3} aria-label="Video description and hashtags" />
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {["#fyp", "#zoomly", "#trending", "#viral"].map((tag) => (
            <button key={tag} type="button" className="chip search-chip" onClick={() => addHashtag(tag)}>
              {tag}
            </button>
          ))}
        </div>
        <Notice text={error} bad />
        <Notice text={done} />
        {busy && (
          <div>
            <div className="upload-progress" aria-label="Uploading">
              <div />
            </div>
            <p style={{ color: "var(--dim)", fontSize: 13, marginTop: 6 }}>Uploading… please keep this open. (Exact % is not shown: the browser upload API reports no progress events, so no fake percentage is displayed.)</p>
          </div>
        )}
        <button className="btn btn-primary" type="submit" disabled={busy} style={{ padding: "12px 16px", fontSize: 16 }}>
          {busy ? "Uploading… please keep this open" : "Post video"}
        </button>
        {busy && (
          <button className="btn btn-danger" type="button" onClick={() => { abortRef.current?.abort(); setBusy(false); setError("Upload cancelled — your video, title and description are kept. Retry when ready."); }}>
            ✕ Cancel upload
          </button>
        )}
        {error && file && !busy && (
          <button className="btn" type="button" onClick={submit}>
            ↻ Retry upload (same video, title &amp; description kept)
          </button>
        )}
        <p style={{ color: "var(--dim)", fontSize: 13, margin: 0 }}>
          Trimming on upload is not available in this web client (it needs a native editor) — preview the full clip above before posting; only the full video is uploaded.
        </p>
      </form>
    </div>
  );
}

// ---------- people -----------------------------------------------------------------

// ---------- direct messages ---------------------------------------------------------
// A 1-to-1 chat thread. Delivery is by polling getMessages every few
// seconds (the server documents why: the WS hub is broadcast-room based).
export function ChatScreen({ me, peer, onClose, refreshMe }) {
  const [messages, setMessages] = useState([]);
  const [body, setBody] = useState("");
  const [note, setNote] = useState("");
  const bottomRef = useRef(null);

  const load = useCallback(async () => {
    const res = await call("getMessages", { user_id: peer.id });
    if (res.ok) setMessages(res.messages);
  }, [peer.id]);

  useEffect(() => {
    load();
    refreshMe?.(); // opening the thread marked messages read server-side
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  async function send(e) {
    e.preventDefault();
    const text = body.trim();
    if (!text) return;
    setBody("");
    const res = await call("sendMessage", { user_id: peer.id, body: text });
    if (res.ok) {
      setNote("");
      load();
    } else setNote(res.message || "Message could not be sent.");
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="panel" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560, width: "100%", height: "92dvh", display: "flex", flexDirection: "column", padding: 0, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
          <Avatar user={peer} size={36} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong>{peer.display_name}</strong>{" "}
            <span style={{ color: "var(--dim)", fontSize: 13 }}>@{peer.username}</span>
          </div>
          <button className="btn btn-small" onClick={onClose}>
            Close
          </button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
          {messages.length === 0 && <p style={{ color: "var(--dim)", textAlign: "center", marginTop: 30 }}>Abhi koi message nahi — pehla message bhejo 👋</p>}
          {messages.map((m) => (
            <div key={m.id} style={{ alignSelf: m.is_mine ? "flex-end" : "flex-start", maxWidth: "78%" }}>
              <div
                style={{
                  background: m.is_mine ? "var(--accent)" : "var(--card2)",
                  color: m.is_mine ? "#06280f" : "var(--text)",
                  borderRadius: 16,
                  padding: "8px 12px",
                  fontSize: 14.5,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {m.body}
              </div>
              <div style={{ fontSize: 11, color: "var(--dim)", marginTop: 2, textAlign: m.is_mine ? "right" : "left" }}>
                {timeAgo(m.created_at)}
                {m.is_mine ? (m.read ? " · ✓✓ Seen" : " · ✓ Sent") : ""}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
        {note && (
          <div className="banner-error" style={{ margin: "0 14px 8px" }}>
            {note}
          </div>
        )}
        <form onSubmit={send} style={{ display: "flex", gap: 8, padding: "10px 14px calc(10px + env(safe-area-inset-bottom))", borderTop: "1px solid var(--border)" }}>
          <input className="input" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Message likho…" maxLength={1000} style={{ flex: 1 }} />
          <button className="btn btn-primary" type="submit" disabled={!body.trim()}>
            Send
          </button>
        </form>
      </div>
    </div>
  );
}

// The inbox: one row per conversation (latest message + unread count).
export function ConversationsScreen({ me, onClose, onOpenChat }) {
  const [convs, setConvs] = useState(null);
  useEffect(() => {
    (async () => {
      const res = await call("getConversations", {});
      if (res.ok) setConvs(res.conversations);
    })();
  }, []);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="panel" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560, width: "100%", maxHeight: "88dvh", display: "flex", flexDirection: "column", padding: 0, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
          <strong style={{ flex: 1, fontSize: 17 }}>💬 Messages</strong>
          <button className="btn btn-small" onClick={onClose}>
            Close
          </button>
        </div>
        <div style={{ overflowY: "auto", padding: "8px 10px" }}>
          {convs === null && <p style={{ color: "var(--dim)", padding: 12 }}>Loading…</p>}
          {convs?.length === 0 && <p style={{ color: "var(--dim)", padding: 12 }}>Abhi koi chat nahi. Kisi ki profile ya People list se ✉️ Message dabao.</p>}
          {(convs || []).map((c) => (
            <button
              key={c.user.id}
              onClick={() => onOpenChat(c.user)}
              style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", background: "none", border: "none", padding: "9px 8px", borderRadius: 12, cursor: "pointer", color: "var(--text)" }}
            >
              <Avatar user={c.user} size={44} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontWeight: 700, fontSize: 15 }}>
                  {c.user.display_name} <span style={{ color: "var(--dim)", fontWeight: 400, fontSize: 13 }}>@{c.user.username}</span>
                </span>
                <span style={{ display: "block", color: c.unread > 0 ? "var(--text)" : "var(--dim)", fontWeight: c.unread > 0 ? 700 : 400, fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {c.latest.is_mine ? "You: " : ""}
                  {c.latest.body}
                </span>
              </span>
              <span style={{ color: "var(--dim)", fontSize: 11.5, flexShrink: 0 }}>{timeAgo(c.latest.created_at)}</span>
              {c.unread > 0 && (
                <span style={{ background: "var(--accent)", color: "#06280f", borderRadius: 999, minWidth: 20, height: 20, padding: "0 6px", fontSize: 12, fontWeight: 800, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  {c.unread}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function PeopleView({ me, onOpenProfile, refreshMe, onMessage, onOpenInbox }) {
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await call("getPeople", { query: query || undefined });
    if (res.ok) setPeople(res.people);
    setLoading(false);
  }, [query]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  async function handleFollow(person) {
    const res = await call("toggleFollow", { user_id: person.id });
    if (res.ok) {
      setPeople((prev) => prev.map((p) => (p.id === person.id ? { ...p, followed_by_me: res.following, follower_count: res.follower_count } : p)));
      refreshMe?.();
    }
  }

  return (
    <div style={{ padding: "14px 14px 20px", maxWidth: 640, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "2px 0 12px" }}>
        <h2 style={{ margin: 0, flex: 1 }}>People</h2>
        <button className="btn btn-small" onClick={() => onOpenInbox?.()} style={{ position: "relative" }}>
          💬 Messages
          {(me?.unread_messages ?? 0) > 0 && (
            <span style={{ position: "absolute", top: -6, right: -6, background: "var(--danger)", color: "#fff", borderRadius: 999, minWidth: 18, height: 18, padding: "0 5px", fontSize: 11, fontWeight: 800, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
              {me.unread_messages}
            </span>
          )}
        </button>
      </div>
      <input className="input" placeholder="Search people…" value={query} onChange={(e) => setQuery(e.target.value)} />
      {loading && <p style={{ color: "var(--dim)", marginTop: 14 }}>Loading…</p>}
      {!loading && people.length === 0 && <p style={{ color: "var(--dim)", marginTop: 14 }}>No people found.</p>}
      <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
        {people.map((person) => (
          <div key={person.id} className="card" style={{ display: "flex", alignItems: "center", gap: 12, padding: 12 }}>
            <button onClick={() => onOpenProfile(person.id)} style={{ background: "none", border: "none", padding: 0, display: "flex", alignItems: "center", gap: 12, textAlign: "left", flex: 1, minWidth: 0, color: "var(--text)" }}>
              <Avatar user={person} size={46} />
              <span style={{ minWidth: 0 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700 }}>
                  {person.display_name} <LevelBadge level={person.level} /> <OwnerBadge user={person} />
                </span>
                <span style={{ display: "block", color: "var(--dim)", fontSize: 13 }}>
                  @{person.username} · ID #{person.id} · {person.follower_count} followers
                </span>
              </span>
            </button>
            {!person.is_me && (
              <>
                <button className={`btn btn-small ${person.followed_by_me ? "" : "btn-primary"}`} onClick={() => handleFollow(person)}>
                  {person.followed_by_me ? "Following" : "Follow"}
                </button>
                <button className="btn btn-small" onClick={() => onMessage?.(person)} title="Message bhejo">
                  ✉️
                </button>
              </>
            )}
            {person.is_me && <span className="chip">You</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- profile ------------------------------------------------------------------

// ---------- PWA install -------------------------------------------------------------
// "Install app" affordance: on Chromium the button appears only when the
// browser fires beforeinstallprompt; on iOS Safari (which has no such
// event) a short Share → Add to Home Screen hint shows instead. Renders
// nothing when the app is already running installed (standalone).
export function InstallAppButton() {
  const [deferred, setDeferred] = useState(null);
  const [installed, setInstalled] = useState(false);
  const [isIos] = useState(() => /iphone|ipad|ipod/i.test(window.navigator?.userAgent || ""));

  useEffect(() => {
    if (window.matchMedia?.("(display-mode: standalone)").matches || window.navigator?.standalone) setInstalled(true);
    const onPrompt = (e) => {
      e.preventDefault();
      setDeferred(e);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (installed) return null;
  if (deferred) {
    return (
      <button
        className="btn btn-primary"
        onClick={async () => {
          deferred.prompt();
          try {
            const choice = await deferred.userChoice;
            if (choice?.outcome === "accepted") setInstalled(true);
          } catch {
            /* prompt dismissed */
          }
          setDeferred(null);
        }}
      >
        📲 Install app
      </button>
    );
  }
  if (isIos) {
    return <span className="chip" title="Install Zoomly">📲 Install: Share ⬆️ → “Add to Home Screen”</span>;
  }
  return null;
}

function ProfileView({ me, userId, onOpenProfile, onOpenVideo, refreshMe, onLogout, onMessage, onGoMonetization, onOpenSettings, onOpenPhase2 }) {
  const isMe = !userId || userId === me.id;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [dpBusy, setDpBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [reportOpen, setReportOpen] = useState(false);
  const [storyOpen, setStoryOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [profileTab, setProfileTab] = useState("posted"); // posted | liked | private
  const [likedPosts, setLikedPosts] = useState([]);
  const [likedLoading, setLikedLoading] = useState(false);
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const dpInputRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await call("getProfile", { user_id: isMe ? undefined : userId });
    if (res.ok) {
      setData(res);
      setDisplayName(res.profile.display_name);
      setBio(res.profile.bio || "");
    }
    setLoading(false);
  }, [userId, isMe]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (profileTab !== "liked" || !isMe) return;
    (async () => {
      setLikedLoading(true);
      const res = await call("getLikedPosts", {});
      if (res.ok) setLikedPosts(res.posts);
      setLikedLoading(false);
    })();
  }, [profileTab, isMe]);

  async function saveProfile(e) {
    e.preventDefault();
    setError("");
    setNotice("");
    const res = await call("updateProfile", { display_name: displayName, bio });
    if (!res.ok) {
      setError(res.message || "Could not save.");
      return;
    }
    setNotice("Profile saved.");
    setEditing(false);
    refreshMe?.();
    load();
  }

  async function pickDp(f) {
    if (!f) return;
    setDpBusy(true);
    setError("");
    setNotice("");
    const up = await uploadMedia(f, "image");
    if (!up.ok) {
      setDpBusy(false);
      setError(up.message || "Photo upload failed.");
      return;
    }
    const res = await call("setAvatar", { avatar_url: up.url, avatar_public_id: up.public_id });
    setDpBusy(false);
    if (!res.ok) {
      setError(res.message || "Could not save the photo.");
      return;
    }
    setNotice("Profile photo updated — it now shows everywhere: feed, comments, people and leaderboards.");
    refreshMe?.();
    load();
  }

  async function removeDp() {
    setDpBusy(true);
    const res = await call("removeAvatar", {});
    setDpBusy(false);
    if (res.ok) {
      refreshMe?.();
      load();
    }
  }

  async function handleFollow() {
    const res = await call("toggleFollow", { user_id: data.profile.id });
    if (res.ok) {
      setData((prev) => ({ ...prev, profile: { ...prev.profile, followed_by_me: res.following, follower_count: res.follower_count } }));
      refreshMe?.();
    }
  }

  async function handleBlock() {
    if (!window.confirm(`Block @${profile.username}? Unki videos, comments aur live ab tumhe nahi dikhengi, aur woh tumhari videos par comment nahi kar sakenge.`)) return;
    const res = await call("blockUser", { user_id: profile.id });
    if (res.ok) {
      setNotice(res.message);
      load();
    } else setError(res.message || "Block failed.");
  }

  async function handleUnblock() {
    const res = await call("unblockUser", { user_id: profile.id });
    if (res.ok) {
      setNotice(res.message);
      load();
    } else setError(res.message || "Unblock failed.");
  }

  async function handleDelete(post) {
    if (!window.confirm(`Delete "${post.title}"? This cannot be undone.`)) return;
    const res = await call("deletePost", { post_id: post.id });
    if (res.ok) load();
  }

  // Owner moderation: on someone else's profile the app owner gets a
  // delete button on every video too (server enforces the admin right).
  async function handleAdminDelete(post) {
    if (!window.confirm("Ye video delete kar dein?")) return;
    const res = await call("deletePost", { post_id: post.id });
    if (res.ok) load();
  }

  if (loading) return <p style={{ padding: 20, color: "var(--dim)" }}>Loading profile…</p>;
  if (!data) return <p style={{ padding: 20, color: "var(--dim)" }}>Profile not found.</p>;
  const profile = data.profile;
  // Section 71 profile "likes" total: sum of real like_counts on the posts
  // returned with this profile (getProfile caps at 60 posts) — no invented
  // figure, and no separate total-likes field exists in the payload.
  const totalLikes = (data.posts ?? []).reduce((s, p) => s + (p.like_count ?? 0), 0);

  return (
    <div style={{ padding: "14px 14px 20px", maxWidth: 640, margin: "0 auto" }}>
      <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
        {data.stories?.length > 0 ? (
          <button onClick={() => setStoryOpen(true)} style={{ background: "none", border: "none", padding: 0 }} aria-label="Watch story" title="Story dekho">
            <span style={storyRingStyle(data.stories.some((s) => !s.seen_by_me))}>
              <Avatar user={profile} size={76} />
            </span>
          </button>
        ) : (
          <Avatar user={profile} size={76} />
        )}
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 20, fontWeight: 800 }}>{profile.display_name}</span>
            <LevelBadge level={profile.level} />
            <OwnerBadge user={profile} full />
          </div>
          <div style={{ color: "var(--dim)", fontSize: 14 }}>
            @{profile.username} · ID #{profile.id}
          </div>
          <div style={{ fontSize: 14, marginTop: 2 }}>🪙 {profile.coin_balance} coins</div>
        </div>
      </div>
      {profile.bio && <p style={{ margin: "12px 0 0", fontSize: 15 }}>{profile.bio}</p>}
      <div style={{ display: "flex", gap: 18, marginTop: 14, fontSize: 14, flexWrap: "wrap" }}>
        <span>
          <strong>{profile.video_count}</strong> <span style={{ color: "var(--dim)" }}>Videos</span>
        </span>
        <span>
          <strong>{totalLikes}</strong> <span style={{ color: "var(--dim)" }}>Likes</span>
        </span>
        <span>
          <strong>{profile.follower_count}</strong> <span style={{ color: "var(--dim)" }}>Followers</span>
        </span>
        <span>
          <strong>{profile.following_count}</strong> <span style={{ color: "var(--dim)" }}>Following</span>
        </span>
        <span>
          <strong>{profile.referral_count}</strong> <span style={{ color: "var(--dim)" }}>Referrals</span>
        </span>
      </div>
      <div style={{ marginTop: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "var(--dim)" }}>
          <span>
            Level: <strong style={{ color: "var(--text)" }}>{profile.level}</strong>
          </span>
          <span>{profile.next_level ? `Next: ${profile.next_level} at ${profile.next_level_min} coins` : "Top level reached 🏆"}</span>
        </div>
        <div className="progress-track" style={{ marginTop: 5 }}>
          <div className="progress-fill" style={{ width: `${Math.round((profile.progress || 0) * 100)}%` }} />
        </div>
      </div>

      {isMe ? (
        <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
          <button className="btn" onClick={() => setEditing((v) => !v)}>
            {editing ? "Close editor" : "Edit profile"}
          </button>
          <button className="btn" onClick={() => dpInputRef.current?.click()} disabled={dpBusy}>
            {dpBusy ? "Uploading…" : profile.avatar_url ? "Change profile photo (DP)" : "Upload profile photo (DP)"}
          </button>
          <button className="btn" onClick={() => setPwOpen((v) => !v)}>
            🔑 Change password
          </button>
          {onOpenPhase2 && <button className="btn" onClick={onOpenPhase2}>⭐ Creator &amp; advanced tools</button>}
          <button className="btn" onClick={() => onOpenSettings?.()}>
            ⚙️ Settings &amp; Privacy
          </button>
          <button className="btn" data-start-monetization="" onClick={() => onGoMonetization?.()}>
            💰 Start Monetization
          </button>
          <InstallAppButton />
          {profile.avatar_url && (
            <button className="btn btn-danger" onClick={removeDp} disabled={dpBusy}>
              Remove DP
            </button>
          )}
          <button className="btn" onClick={onLogout}>
            Log out
          </button>
          <input ref={dpInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => pickDp(e.target.files?.[0])} />
          {pwOpen && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setError("");
                setNotice("");
                if (pwNew !== pwConfirm) {
                  setError("New password aur confirm password match nahi karte.");
                  return;
                }
                const res = await call("changePassword", { current_password: pwCurrent, new_password: pwNew });
                if (!res.ok) {
                  setError(res.message || "Password change failed.");
                  return;
                }
                setNotice(res.message);
                setPwCurrent("");
                setPwNew("");
                setPwConfirm("");
                setPwOpen(false);
              }}
              style={{ flexBasis: "100%", display: "grid", gap: 8, marginTop: 4 }}
            >
              <input className="input" type="password" placeholder="Current password" value={pwCurrent} onChange={(e) => setPwCurrent(e.target.value)} required />
              <input className="input" type="password" placeholder="New password (min 6 characters)" value={pwNew} onChange={(e) => setPwNew(e.target.value)} required minLength={6} />
              <input className="input" type="password" placeholder="Confirm new password" value={pwConfirm} onChange={(e) => setPwConfirm(e.target.value)} required minLength={6} />
              <button className="btn btn-primary btn-small" type="submit" style={{ justifySelf: "start" }}>
                Password change karo
              </button>
              <span style={{ fontSize: 12.5, color: "var(--dim)" }}>Password bhool gaye ho to owner se temporary password le lo (email reset available nahi — Google users Google se login karein).</span>
            </form>
          )}
        </div>
      ) : (
        <div style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className={`btn ${profile.followed_by_me ? "" : "btn-primary"}`} onClick={handleFollow}>
            {profile.followed_by_me ? "Following" : "Follow"}
          </button>
          {!profile.blocked_by_me && (
            <button
              className="btn"
              onClick={() => onMessage?.({ id: profile.id, username: profile.username, display_name: profile.display_name, avatar_url: profile.avatar_url })}
            >
              ✉️ Message
            </button>
          )}
          <button className="btn" onClick={() => setReportOpen(true)}>
            🚩 Report
          </button>
          <button
            className="btn"
            onClick={async () => {
              const r = await shareUrl({ url: `${window.location.origin}/?u=${profile.username}`, text: `@${profile.username} on Zoomly` });
              if (r === "copied") setNotice("Profile link copied ✓");
            }}
          >
            🔗 Share
          </button>
          {profile.blocked_by_me ? (
            <button className="btn" onClick={handleUnblock}>
              Unblock
            </button>
          ) : (
            <button className="btn btn-danger" onClick={handleBlock}>
              🚫 Block
            </button>
          )}
        </div>
      )}
      {reportOpen && <ReportDialog targetType="user" targetId={profile.id} label={`@${profile.username}`} onClose={() => setReportOpen(false)} />}
      {storyOpen && data.stories?.length > 0 && (
        <StoryViewer
          groups={[
            {
              author: { id: profile.id, username: profile.username, display_name: profile.display_name, avatar_url: profile.avatar_url, is_owner: profile.is_owner },
              stories: data.stories,
              has_unseen: data.stories.some((s) => !s.seen_by_me),
            },
          ]}
          startAuthorId={profile.id}
          me={me}
          onClose={() => {
            setStoryOpen(false);
            load();
          }}
          onChanged={load}
        />
      )}

      <Notice text={error} bad />
      <Notice text={notice} />

      {isMe && editing && (
        <form onSubmit={saveProfile} className="card" style={{ display: "grid", gap: 10, marginTop: 14 }}>
          <label style={{ fontSize: 13, color: "var(--dim)" }}>Display name</label>
          <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={60} required />
          <label style={{ fontSize: 13, color: "var(--dim)" }}>Bio</label>
          <textarea className="input" value={bio} onChange={(e) => setBio(e.target.value)} maxLength={300} rows={3} />
          <button className="btn btn-primary" type="submit">
            Save profile
          </button>
        </form>
      )}

      <h3 style={{ margin: "22px 0 10px" }}>Videos</h3>
      {data.profile.private_locked && <p style={{ color: "var(--dim)" }}>🔒 This account is private — follow to see their videos.</p>}
      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        <button className={`tab-btn ${profileTab === "posted" ? "active" : ""}`} onClick={() => setProfileTab("posted")}>
          Posted
        </button>
        {isMe && (
          <button className={`tab-btn ${profileTab === "liked" ? "active" : ""}`} onClick={() => setProfileTab("liked")}>
            Liked
          </button>
        )}
        {isMe && (
          <button className={`tab-btn ${profileTab === "private" ? "active" : ""}`} onClick={() => setProfileTab("private")}>
            Private (review)
          </button>
        )}
      </div>
      {profileTab === "liked" && likedLoading && <p style={{ color: "var(--dim)" }}>Loading liked videos…</p>}
      {profileTab === "liked" && !likedLoading && likedPosts.length === 0 && <p style={{ color: "var(--dim)" }}>No liked videos yet.</p>}
      {profileTab === "private" && data.posts.filter((x) => x.hidden).length === 0 && <p style={{ color: "var(--dim)" }}>No videos under review — this is where your hidden/private videos appear.</p>}
      {profileTab === "posted" && data.posts.filter((x) => !x.hidden).length === 0 && <p style={{ color: "var(--dim)" }}>No videos yet.</p>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 3 }}>
        {(profileTab === "liked" ? likedPosts : profileTab === "private" ? data.posts.filter((x) => x.hidden) : data.posts.filter((x) => !x.hidden)).map((post) => (
          <div key={post.id} style={{ position: "relative", borderRadius: 8, overflow: "hidden", background: "var(--surface-2)", aspectRatio: "1/1" }}>
            {post.thumbnail_url ? (
              <img src={post.thumbnail_url} alt={post.title} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            ) : (
              <video src={post.video_url} preload="metadata" muted style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            )}
            <button
              onClick={() => onOpenVideo?.(post.id)}
              aria-label={`Open video: ${post.title}`}
              title={post.title}
              style={{ position: "absolute", inset: 0, background: "none", border: "none", padding: 0, cursor: "pointer", zIndex: 1 }}
            />
            <div style={{ position: "absolute", left: 6, bottom: 6, right: 6, color: "#fff", fontSize: 12, fontWeight: 700, textShadow: "0 1px 4px rgba(0,0,0,0.9)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", zIndex: 2, pointerEvents: "none" }}>
              ▶ {post.view_count ?? 0}
            </div>
            {isMe && profileTab !== "liked" && (
              <button onClick={() => handleDelete(post)} style={{ position: "absolute", top: 6, right: 6, background: "rgba(0,0,0,0.65)", color: "#ff9a8a", border: "1px solid rgba(255,255,255,0.25)", borderRadius: 8, fontSize: 12, padding: "3px 7px", zIndex: 3 }}>
                Delete
              </button>
            )}
            {!isMe && me?.is_owner === true && (
              <button data-admin-delete="" onClick={() => handleAdminDelete(post)} style={{ position: "absolute", top: 6, right: 6, background: "rgba(0,0,0,0.65)", color: "#ff9a8a", border: "1px solid rgba(255,255,255,0.25)", borderRadius: 8, fontSize: 12, padding: "3px 7px", zIndex: 3 }}>
                Delete
              </button>
            )}
          </div>
        ))}
      </div>

      {isMe && data.referrals && (
        <>
          <h3 style={{ margin: "22px 0 10px" }}>My referrals ({data.referrals.length})</h3>
          {data.referrals.length === 0 && <p style={{ color: "var(--dim)" }}>Nobody has joined with your code yet. Share it from the Rewards + Monetization tab!</p>}
          <div style={{ display: "grid", gap: 8 }}>
            {data.referrals.map((r) => (
              <button key={r.id} onClick={() => onOpenProfile(r.id)} className="card" style={{ display: "flex", alignItems: "center", gap: 10, padding: 10, textAlign: "left", color: "var(--text)" }}>
                <Avatar user={r} size={36} />
                <span>
                  <strong>{r.display_name}</strong>
                  <span style={{ display: "block", color: "var(--dim)", fontSize: 13 }}>
                    @{r.username} · joined {timeAgo(r.created_at)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {isMe && <BlockedUsersSection />}
    </div>
  );
}

// Users the signed-in user has blocked, with one-tap unblock.
function BlockedUsersSection() {
  const [blocked, setBlocked] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const load = useCallback(async () => {
    const res = await call("getBlockedUsers", {});
    if (res.ok) setBlocked(res.blocked);
    setLoaded(true);
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  async function unblock(u) {
    const res = await call("unblockUser", { user_id: u.id });
    if (res.ok) load();
  }
  if (!loaded || blocked.length === 0) return null;
  return (
    <>
      <h3 style={{ margin: "22px 0 10px" }}>🚫 Blocked users ({blocked.length})</h3>
      <div style={{ display: "grid", gap: 8 }}>
        {blocked.map((u) => (
          <div key={u.id} className="card" style={{ display: "flex", alignItems: "center", gap: 10, padding: 10 }}>
            <Avatar user={u} size={36} />
            <span style={{ flex: 1 }}>
              <strong>{u.display_name}</strong>
              <span style={{ display: "block", color: "var(--dim)", fontSize: 13 }}>@{u.username}</span>
            </span>
            <button className="btn btn-small" onClick={() => unblock(u)}>
              Unblock
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

// ---------- rewards: referrals + coins + leaderboards + admin ----------------------

function BoardRow({ row, metric }) {
  // Top Coins rows are anonymous: the payload carries no name/username —
  // show the DP (or a generic coin placeholder, never name initials),
  // "ID #<id>", the level badge and the balance.
  if (metric === "coins") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 2px", borderBottom: "1px solid var(--border)" }}>
        <span style={{ width: 30, textAlign: "center", fontWeight: 800, fontSize: 15 }}>{row.rank <= 3 ? ["🥇", "🥈", "🥉"][row.rank - 1] : `#${row.rank}`}</span>
        {row.avatar_url ? (
          <img src={row.avatar_url} alt="" style={{ width: 40, height: 40, borderRadius: "50%", objectFit: "cover", flexShrink: 0, background: "var(--surface-2)" }} />
        ) : (
          <div style={{ width: 40, height: 40, borderRadius: "50%", background: "var(--surface-2)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 19, flexShrink: 0 }}>🪙</div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700 }}>
            ID #{row.id} <LevelBadge level={row.level} />
            {row.is_me && (
              <span className="chip" style={{ padding: "1px 7px", fontSize: 11 }}>
                You
              </span>
            )}
          </div>
        </div>
        <strong>🪙 {row.coin_balance}</strong>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 2px", borderBottom: "1px solid var(--border)" }}>
      <span style={{ width: 30, textAlign: "center", fontWeight: 800, fontSize: 15 }}>{row.rank <= 3 ? ["🥇", "🥈", "🥉"][row.rank - 1] : `#${row.rank}`}</span>
      <Avatar user={row} size={40} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {row.display_name} <LevelBadge level={row.level} />
          {row.is_me && (
            <span className="chip" style={{ padding: "1px 7px", fontSize: 11 }}>
              You
            </span>
          )}
        </div>
        <div style={{ color: "var(--dim)", fontSize: 13 }}>
          @{row.username} · ID #{row.id}
        </div>
      </div>
      <strong>👥 {row.referral_count}</strong>
    </div>
  );
}

function AdminSection({ refreshMe }) {
  const [requests, setRequests] = useState([]);
  const [withdrawals, setWithdrawals] = useState([]);
  const [monApps, setMonApps] = useState([]);
  const [platformGiftCoins, setPlatformGiftCoins] = useState(null);
  const [platformEvents, setPlatformEvents] = useState([]);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [resetId, setResetId] = useState("");
  const [resetTemp, setResetTemp] = useState("");

  const load = useCallback(async () => {
    const res = await call("getAdminCoinRequests", {});
    if (res.ok) {
      setRequests(res.requests);
      if (Array.isArray(res.withdrawals)) setWithdrawals(res.withdrawals);
      if (Array.isArray(res.platform_gift_events)) setPlatformEvents(res.platform_gift_events);
      if (typeof res.platform_gift_coins === "number") setPlatformGiftCoins(res.platform_gift_coins);
    }
    const monRes = await call("getAdminMonetizationApplications", {});
    if (monRes.ok && Array.isArray(monRes.applications)) setMonApps(monRes.applications);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function review(req, decision) {
    setError("");
    setNotice("");
    const res = await call("reviewCoinRequest", { request_id: req.id, decision });
    if (!res.ok) {
      setError(res.message || "Could not review the request.");
      return;
    }
    setNotice(res.message);
    refreshMe?.();
    load();
  }

  async function reviewWd(wd, decision) {
    setError("");
    setNotice("");
    const res = await call("reviewWithdrawal", { withdrawal_id: wd.id, decision });
    if (!res.ok) {
      setError(res.message || "Could not review the withdrawal.");
      return;
    }
    setNotice(res.message);
    refreshMe?.();
    load();
  }

  async function reviewMonApp(app, decision) {
    setError("");
    setNotice("");
    const res = await call("reviewMonetizationApplication", { application_id: app.id, decision });
    if (!res.ok) {
      setError(res.message || "Could not review the application.");
      return;
    }
    setNotice(res.message);
    refreshMe?.();
    load();
  }

  const pending = requests.filter((r) => r.status === "pending");
  const reviewed = requests.filter((r) => r.status !== "pending");
  const pendingWd = withdrawals.filter((w) => w.status === "pending");
  const reviewedWd = withdrawals.filter((w) => w.status !== "pending");
  const pendingMon = monApps.filter((a) => a.status === "pending");
  const reviewedMon = monApps.filter((a) => a.status !== "pending");

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3 style={{ margin: "0 0 6px" }}>🛠️ Owner: coin requests</h3>
      <p style={{ color: "var(--dim)", fontSize: 14, margin: "0 0 10px" }}>
        Verify the JazzCash payment for each TID in your JazzCash account first — then approve to credit the coins, or reject.
      </p>
      {typeof platformGiftCoins === "number" && (
        <p style={{ fontSize: 14, margin: "0 0 10px" }}>
          🔴 Platform earnings from LIVE gifts (30% cut, recorded): <strong>🪙 {platformGiftCoins.toLocaleString()}</strong>
        </p>
      )}
      {platformEvents.length > 0 && (
        <div style={{ display: "grid", gap: 4, margin: "0 0 12px" }}>
          {platformEvents.slice(0, 10).map((e) => (
            <div key={e.id} style={{ fontSize: 13, color: "var(--dim)" }}>
              {e.gift_emoji} @{e.sender?.username} → @{e.creator?.username} · {e.gift_name} {e.coins} · platform <strong style={{ color: "var(--text)" }}>+{e.platform_share_exact ?? e.platform_share}</strong> · {timeAgo(e.created_at)}
            </div>
          ))}
        </div>
      )}
      <Notice text={error} bad />
      <Notice text={notice} />
      {pending.length === 0 && <p style={{ color: "var(--dim)" }}>No pending requests.</p>}
      <div style={{ display: "grid", gap: 10 }}>
        {pending.map((r) => (
          <div key={r.id} style={{ border: "1px solid var(--border)", borderRadius: 12, padding: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Avatar user={r.buyer} size={36} />
              <div style={{ flex: 1 }}>
                <strong>
                  {r.pack_coins} coins · Rs.{r.price_pkr}
                  {r.is_custom ? " · custom" : ""}
                </strong>
                <div style={{ color: "var(--dim)", fontSize: 13 }}>
                  {r.buyer.display_name} (@{r.buyer.username}) · {timeAgo(r.created_at)}
                </div>
                <div style={{ fontSize: 13 }}>
                  TID: <code>{r.tid}</code>
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button className="btn btn-primary btn-small" onClick={() => review(r, "approved")}>
                ✓ Approve — credit {r.pack_coins} coins
              </button>
              <button className="btn btn-danger btn-small" onClick={() => review(r, "rejected")}>
                ✕ Reject
              </button>
            </div>
          </div>
        ))}
      </div>
      {reviewed.length > 0 && (
        <>
          <h4 style={{ margin: "16px 0 6px", color: "var(--dim)" }}>Reviewed</h4>
          <div style={{ display: "grid", gap: 6 }}>
            {reviewed.slice(0, 10).map((r) => (
              <div key={r.id} style={{ fontSize: 14, color: "var(--dim)", display: "flex", justifyContent: "space-between" }}>
                <span>
                  {r.pack_coins} coins · Rs.{r.price_pkr}{r.is_custom ? " · custom" : ""} · @{r.buyer.username} · TID {r.tid}
                </span>
                <strong style={{ color: r.status === "approved" ? "var(--accent)" : "var(--bad)" }}>{r.status}</strong>
              </div>
            ))}
          </div>
        </>
      )}

      <h4 style={{ margin: "20px 0 6px" }}>💸 Withdrawals (cash-out)</h4>
      <p style={{ color: "var(--dim)", fontSize: 14, margin: "0 0 10px" }}>
        Coins pehle se user ke balance se hold hain. <strong style={{ color: "var(--text)" }}>Approve</strong> = tum pehle JazzCash se paise bhejo, phir yahan approve mark karo. <strong style={{ color: "var(--text)" }}>Reject</strong> = held coins user ko auto-refund.
      </p>
      {pendingWd.length === 0 && <p style={{ color: "var(--dim)" }}>No pending withdrawals.</p>}
      <div style={{ display: "grid", gap: 10 }}>
        {pendingWd.map((w) => (
          <div key={w.id} style={{ border: "1px solid var(--border)", borderRadius: 12, padding: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Avatar user={w.requester} size={36} />
              <div style={{ flex: 1 }}>
                <strong>
                  🪙 {w.coins.toLocaleString()} · Rs.{w.amount_pkr.toLocaleString()}
                </strong>
                <div style={{ color: "var(--dim)", fontSize: 13 }}>
                  {w.requester.display_name} (@{w.requester.username}) · ID #{w.requester.id} · {timeAgo(w.created_at)}
                </div>
                <div style={{ fontSize: 13 }}>
                  JazzCash: <code>{w.jazzcash_number}</code>
                  {w.account_title ? ` · ${w.account_title}` : ""}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button className="btn btn-primary btn-small" onClick={() => reviewWd(w, "approved")}>
                ✓ Approve — Rs.{w.amount_pkr} bhej diye
              </button>
              <button className="btn btn-danger btn-small" onClick={() => reviewWd(w, "rejected")}>
                ✕ Reject — refund coins
              </button>
            </div>
          </div>
        ))}
      </div>
      {reviewedWd.length > 0 && (
        <>
          <h4 style={{ margin: "16px 0 6px", color: "var(--dim)" }}>Withdrawals reviewed</h4>
          <div style={{ display: "grid", gap: 6 }}>
            {reviewedWd.slice(0, 10).map((w) => (
              <div key={w.id} style={{ fontSize: 14, color: "var(--dim)", display: "flex", justifyContent: "space-between" }}>
                <span>
                  🪙 {w.coins} · Rs.{w.amount_pkr} · @{w.requester.username} · {w.jazzcash_number}
                </span>
                <strong style={{ color: w.status === "approved" ? "var(--accent)" : "var(--bad)" }}>{w.status}</strong>
              </div>
            ))}
          </div>
        </>
      )}

      <h4 style={{ margin: "20px 0 6px" }}>💰 Monetization applications</h4>
      <p style={{ color: "var(--dim)", fontSize: 14, margin: "0 0 10px" }}>
        Creators ki monetization applications. Form ki maloomat aur un ke <strong style={{ color: "var(--text)" }}>abhi ke</strong> followers/views check karke faisla karein — <strong style={{ color: "var(--text)" }}>Approve</strong> karte hi creator monetized ho jata hai aur us ke liye withdrawal khul jata hai.
      </p>
      {pendingMon.length === 0 && <p style={{ color: "var(--dim)" }}>No pending monetization applications.</p>}
      <div style={{ display: "grid", gap: 10 }}>
        {pendingMon.map((a) => (
          <div key={a.id} style={{ border: "1px solid var(--border)", borderRadius: 12, padding: 10 }} data-monetization-application="">
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Avatar user={a.applicant} size={36} />
              <div style={{ flex: 1 }}>
                <strong>
                  {a.applicant.display_name} (@{a.applicant.username}) · ID #{a.applicant.id}
                </strong>
                <div style={{ color: "var(--dim)", fontSize: 13 }}>{timeAgo(a.created_at)} apply kiya</div>
                <div style={{ fontSize: 13.5, marginTop: 2 }}>
                  Full name: <strong>{a.full_name}</strong> · DOB: {a.dob}
                  {typeof a.age === "number" ? ` (${a.age} saal)` : ""} · JazzCash: <code>{a.jazzcash_number}</code>
                </div>
                <div style={{ fontSize: 13.5 }}>
                  Abhi: 👥 {a.current_followers.toLocaleString()} followers · 👀 {a.current_views.toLocaleString()} views
                  <span style={{ color: "var(--dim)" }}>
                    {" "}
                    (apply time: 👥 {a.followers_snapshot.toLocaleString()} · 👀 {a.views_snapshot.toLocaleString()})
                  </span>
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button className="btn btn-primary btn-small" onClick={() => reviewMonApp(a, "approved")}>
                ✓ Approve — monetized karo
              </button>
              <button className="btn btn-danger btn-small" onClick={() => reviewMonApp(a, "rejected")}>
                ✕ Reject
              </button>
            </div>
          </div>
        ))}
      </div>
      {reviewedMon.length > 0 && (
        <>
          <h4 style={{ margin: "16px 0 6px", color: "var(--dim)" }}>Monetization applications reviewed</h4>
          <div style={{ display: "grid", gap: 6 }}>
            {reviewedMon.slice(0, 10).map((a) => (
              <div key={a.id} style={{ fontSize: 14, color: "var(--dim)", display: "flex", justifyContent: "space-between" }}>
                <span>
                  @{a.applicant.username} · {a.full_name} · JazzCash {a.jazzcash_number}
                </span>
                <strong style={{ color: a.status === "approved" ? "var(--accent)" : "var(--bad)" }}>{a.status}</strong>
              </div>
            ))}
          </div>
        </>
      )}

      <h4 style={{ margin: "20px 0 6px" }}>🔑 Reset user password (owner)</h4>
      <p style={{ color: "var(--dim)", fontSize: 14, margin: "0 0 10px" }}>
        Jo user apna password bhool jaye, us ke liye temporary password set karo aur use de do — woh login karke Profile se khud change kar lega. Reset par user ki purani sessions band ho jati hain.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          setNotice("");
          const res = await call("adminResetPassword", { user_id: Number(resetId), temp_password: resetTemp });
          if (!res.ok) {
            setError(res.message || "Reset failed.");
            return;
          }
          setNotice(res.message);
          setResetId("");
          setResetTemp("");
        }}
        style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
      >
        <input className="input" type="number" min="1" placeholder="User ID #" value={resetId} onChange={(e) => setResetId(e.target.value)} style={{ width: 130 }} required />
        <input className="input" type="text" placeholder="Temporary password (min 6)" value={resetTemp} onChange={(e) => setResetTemp(e.target.value)} style={{ flex: 1, minWidth: 180 }} required minLength={6} />
        <button className="btn btn-primary btn-small" type="submit">
          Reset password
        </button>
      </form>
    </div>
  );
}

// Owner moderation queue: community reports grouped by target, with the
// reported content preview, reporter reasons, repeat-offender flags and
// the Dismiss / Delete / Ban / Unban decisions (server: getModerationQueue
// + moderateContent). Renders nothing for non-admins (parent gates it too).
function ModerationSection() {
  const [groups, setGroups] = useState(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const res = await call("getModerationQueue", {});
    if (res.ok) setGroups(res.groups);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function act(g, action) {
    setError("");
    setNotice("");
    if (action === "delete_content" && !window.confirm("Content delete kar dein? Ye wapas nahi aayega.")) return;
    if (action === "ban_user" && !window.confirm(`@${g.owner.username} ko BAN kar dein? Woh login, post aur live nahi kar sakega.`)) return;
    const res = await call("moderateContent", { target_type: g.target_type, target_id: g.target_id, action });
    if (!res.ok) {
      setError(res.message || "Action failed.");
      return;
    }
    setNotice(res.message);
    load();
  }

  if (!groups) return null;
  const pendingGroups = groups.filter((g) => g.has_pending);
  const typeLabel = { post: "🎬 Video", live: "🔴 Live", comment: "💬 Comment", user: "👤 User" };

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3 style={{ margin: "0 0 6px" }}>🛡️ Owner: moderation queue</h3>
      <p style={{ color: "var(--dim)", fontSize: 14, margin: "0 0 10px" }}>
        Community reports yahan group ho kar aate hain. 3 alag users ki report par video/live khud hide ho jata hai — <strong style={{ color: "var(--text)" }}>Dismiss</strong> se wapas visible, <strong style={{ color: "var(--text)" }}>Delete</strong> se content khatam, <strong style={{ color: "var(--text)" }}>Ban</strong> se user band.
      </p>
      <Notice text={error} bad />
      <Notice text={notice} />
      {pendingGroups.length === 0 && <p style={{ color: "var(--dim)" }}>No pending reports. 🎉</p>}
      <div style={{ display: "grid", gap: 10 }}>
        {pendingGroups.map((g) => (
          <div key={`${g.target_type}:${g.target_id}`} style={{ border: "1px solid var(--border)", borderRadius: 12, padding: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Avatar user={g.owner} size={36} />
              <div style={{ flex: 1 }}>
                <strong>
                  {typeLabel[g.target_type]} #{g.target_id}
                </strong>{" "}
                — {g.report_count} report{g.report_count === 1 ? "" : "s"}
                <div style={{ color: "var(--dim)", fontSize: 13 }}>
                  Owner: {g.owner.display_name} (@{g.owner.username}) · ID #{g.owner.id}
                  {g.owner.flagged && <span style={{ color: "var(--bad)" }}> · ⚠️ repeat offender ({g.owner.hidden_count}× auto-hidden)</span>}
                  {g.owner.banned && <span style={{ color: "var(--bad)" }}> · BANNED</span>}
                </div>
              </div>
            </div>
            {g.preview && !g.preview.missing && (
              <div style={{ fontSize: 14, marginTop: 6, color: "var(--dim)" }}>
                {g.target_type === "post" && (
                  <>
                    “{g.preview.title}”{g.preview.hidden ? " · ⏳ hidden (under review)" : ""}
                  </>
                )}
                {g.target_type === "comment" && <>“{g.preview.body}”</>}
                {g.target_type === "live" && (
                  <>
                    “{g.preview.title}”{g.preview.is_live ? " · abhi LIVE hai" : " · ended"}
                    {g.preview.hidden ? " · ⏳ hidden" : ""}
                  </>
                )}
                {g.target_type === "user" && <>Profile report</>}
              </div>
            )}
            <div style={{ display: "grid", gap: 2, marginTop: 6 }}>
              {g.reports
                .filter((r) => r.status === "pending")
                .map((r) => (
                  <div key={r.id} style={{ fontSize: 13, color: "var(--dim)" }}>
                    🚩 <strong style={{ color: "var(--text)" }}>{r.reason}</strong> — @{r.reporter.username}
                    {r.details ? `: “${r.details}”` : ""}
                  </div>
                ))}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
              <button className="btn btn-small" onClick={() => act(g, "dismiss")}>
                ✓ Dismiss (restore)
              </button>
              {g.target_type !== "user" && (
                <button className="btn btn-small" onClick={() => act(g, "delete_content")}>
                  🗑 Delete content
                </button>
              )}
              {g.owner.banned ? (
                <button className="btn btn-small" onClick={() => act(g, "unban_user")}>
                  Unban user
                </button>
              ) : (
                <button className="btn btn-danger btn-small" onClick={() => act(g, "ban_user")}>
                  ⛔ Ban user
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      {groups.length > pendingGroups.length && (
        <p style={{ color: "var(--dim)", fontSize: 13, marginTop: 10 }}>
          {groups.length - pendingGroups.length} decided group(s) — sirf pending dikh rahe hain.
        </p>
      )}
    </div>
  );
}

// Creator-facing gift earnings (Rewards tab): totals + who gifted what.
function GiftEarningsCard() {
  const [data, setData] = useState(null);
  useEffect(() => {
    (async () => {
      const res = await call("getGiftEarnings", {});
      if (res.ok) setData(res);
    })();
  }, []);
  if (!data) return null;
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <h3 style={{ margin: "0 0 4px" }}>🎁 Gift earnings</h3>
      <p style={{ color: "var(--dim)", fontSize: 14, margin: "0 0 10px" }}>
        Live gifts se total kamai:{" "}
        <strong style={{ color: "var(--text)" }}>🪙 {data.total_earned.toLocaleString()}</strong> ({data.gift_count} gift{data.gift_count === 1 ? "" : "s"} — har gift ka 70% tumhara hissa
        {data.total_earned_exact != null && data.total_earned_exact !== String(data.total_earned) ? `, exact ${data.total_earned_exact} (baqi ${data.creator_pending_exact ?? "0"} pending)` : ""}).
      </p>
      {data.earnings.length === 0 && <p style={{ color: "var(--dim)", fontSize: 14, margin: 0 }}>Abhi tak koi gift nahi mila — live jao aur gifts kamao!</p>}
      <div style={{ display: "grid", gap: 8 }}>
        {data.earnings.map((e) => (
          <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {e.sender ? <Avatar user={e.sender} size={34} /> : <span style={{ fontSize: 22 }}>🎁</span>}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14 }}>
                <strong>{e.sender?.display_name ?? "Someone"}</strong> sent {e.gift_emoji} {e.gift_name}
              </div>
              <div style={{ color: "var(--dim)", fontSize: 12.5 }}>{timeAgo(e.created_at)}</div>
            </div>
            <strong style={{ color: "var(--accent)" }}>
              +{e.creator_share_exact ?? e.creator_share}
              {e.creator_credited_coins != null && e.creator_share_exact != null && Number(e.creator_share_exact) !== e.creator_credited_coins ? ` (${e.creator_credited_coins} credited)` : ""}
            </strong>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- monetization program ----------------------------------------------
// Dedicated full-screen view opened via "💰 Start Monetization" (Rewards
// tab, or the own-profile shortcut). Hero + the three criteria with live
// progress bars, then the state machine: apply form -> pending -> owner
// approves (monetized) or rejects (apply again). Every number and state
// comes from the server (getMonetization); the DOB age shown while typing
// is only a preview — the server recomputes it at submit.
function agePreviewFromInput(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  const now = new Date();
  let age = now.getFullYear() - y;
  const md = now.getMonth() - (mo - 1);
  if (md < 0 || (md === 0 && now.getDate() < d)) age -= 1;
  return age;
}

function CriteriaRow({ icon, label, current, required, met, display }) {
  const pct = required > 0 ? Math.min(100, Math.round((((current ?? 0) / required) * 100))) : 0;
  return (
    <div style={{ padding: "11px 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 15, gap: 8 }}>
        <span>
          {icon} {label} {met && <span style={{ color: "var(--accent)", fontWeight: 900 }}>✓</span>}
        </span>
        <strong style={{ color: met ? "var(--accent)" : "var(--text)", whiteSpace: "nowrap" }}>{display}</strong>
      </div>
      <div className="progress-track" style={{ marginTop: 7 }}>
        <div className="progress-fill" style={{ width: `${met ? 100 : pct}%` }} />
      </div>
    </div>
  );
}

function MonetizationPanel({ onClose, refreshMe }) {
  const [mon, setMon] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [fullName, setFullName] = useState("");
  const [dob, setDob] = useState("");
  const [jcNumber, setJcNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const waking = useWaking();

  const load = useCallback(async () => {
    const res = await call("getMonetization", {});
    if (res.ok) {
      setMon(res.monetization);
      setLoadError(false);
      // Re-applying after a rejection starts from the last submitted data.
      const app = res.monetization?.application;
      if (app && app.status === "rejected") {
        setFullName((v) => v || app.full_name || "");
        setDob((v) => v || app.dob || "");
        setJcNumber((v) => v || app.jazzcash_number || "");
      }
    } else if (res.transportError) {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function apply(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    const res = await call("applyForMonetization", { full_name: fullName.trim(), dob, jazzcash_number: jcNumber.trim() });
    setBusy(false);
    if (!res.ok) {
      setError(res.message || "Application could not be sent.");
      return;
    }
    setNotice(res.message);
    if (res.monetization) setMon(res.monetization);
    else load();
    refreshMe?.();
  }

  const crit = mon?.criteria;
  const app = mon?.application;
  const localAge = agePreviewFromInput(dob);
  const under18 = dob && localAge !== null && crit ? localAge < crit.age.required : false;
  const formReady =
    Boolean(crit) &&
    crit.followers.met &&
    crit.views.met &&
    fullName.trim().length >= 3 &&
    Boolean(dob) &&
    localAge !== null &&
    crit &&
    localAge >= crit.age.required &&
    /^0\d{10}$/.test(jcNumber.trim());

  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--bg)", zIndex: 70, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
        <strong style={{ fontSize: 18, flex: 1 }}>💰 Monetization</strong>
        <button className="btn btn-small" onClick={onClose}>
          ✕ Close
        </button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "14px 14px calc(20px + env(safe-area-inset-bottom))", maxWidth: 640, width: "100%", margin: "0 auto" }}>
        <div
          style={{
            background: "linear-gradient(135deg, color-mix(in srgb, var(--accent) 22%, var(--surface)), var(--surface))",
            border: "1px solid var(--accent)",
            borderRadius: 16,
            padding: "16px 16px 13px",
          }}
        >
          <div style={{ fontSize: 21, fontWeight: 900 }}>💰 Zoomly Monetization Program</div>
          <p style={{ fontSize: 14.5, margin: "8px 0 0", lineHeight: 1.55 }}>
            Videos aur LIVE gifts se kamao — har gift ka <strong>70% hissa creator ko</strong> milta hai.
            <br />
            Kamaye hue coins withdraw <strong>seedha apne JazzCash</strong> pe — <strong>1 coin = Rs.1</strong>.
            <br />
            Neeche wala criteria pura karo, application bhejo — owner ki approval milte hi withdrawal khul jayega.
          </p>
        </div>

        {mon === null && !loadError && <p style={{ color: "var(--dim)", marginTop: 16 }}>{waking ? WAKING_TEXT : "Loading…"}</p>}
        {loadError && (
          <p style={{ color: "var(--dim)", marginTop: 16 }}>
            Monetization load nahi ho saki — server jaag raha ho ga.{" "}
            <button className="btn btn-small" onClick={load}>
              Try again
            </button>
          </p>
        )}

        {mon && crit && (
          <>
            <div className="card" style={{ marginTop: 14, paddingTop: 4, paddingBottom: 6 }} data-monetization-criteria="">
              <CriteriaRow
                icon="🎂"
                label="Age 18+"
                current={crit.age.current}
                required={crit.age.required}
                met={crit.age.met || (Boolean(dob) && localAge !== null && localAge >= crit.age.required)}
                display={crit.age.current !== null && crit.age.current !== undefined ? `${crit.age.current} / ${crit.age.required} saal` : dob && localAge !== null ? `${localAge} / ${crit.age.required} saal` : "Date of birth neeche likhein"}
              />
              <CriteriaRow icon="👥" label="Followers" current={crit.followers.current} required={crit.followers.required} met={crit.followers.met} display={`${(crit.followers.current ?? 0).toLocaleString()} / ${crit.followers.required.toLocaleString()}`} />
              <CriteriaRow icon="👀" label="Total video views" current={crit.views.current} required={crit.views.required} met={crit.views.met} display={`${(crit.views.current ?? 0).toLocaleString()} / ${crit.views.required.toLocaleString()}`} />
            </div>

            <Notice text={error} bad />
            <Notice text={notice} />

            {mon.monetized ? (
              <div className="card" style={{ marginTop: 14, textAlign: "center", borderColor: "var(--accent)" }} data-monetization-state="approved">
                <div style={{ fontSize: 19, fontWeight: 900, color: "var(--accent)" }}>✅ Aap monetized hain — withdrawal khula hai</div>
                <p style={{ color: "var(--dim)", fontSize: 14, margin: "8px 0 0" }}>Mubarak ho! Ab aap apne coins Rewards + Monetization tab se apne JazzCash pe withdraw kar sakte hain.</p>
              </div>
            ) : app?.status === "pending" ? (
              <div className="card" style={{ marginTop: 14, textAlign: "center" }} data-monetization-state="pending">
                <div style={{ fontSize: 17, fontWeight: 800 }}>Application bheji hui hai — review ka intezar karein ⏳</div>
                <p style={{ color: "var(--dim)", fontSize: 14, margin: "8px 0 0" }}>
                  {app.full_name} · JazzCash {app.jazzcash_number}
                  <br />
                  Owner review karke faisla notification me batayega.
                </p>
              </div>
            ) : (
              <div className="card" style={{ marginTop: 14 }} data-monetization-state={app?.status === "rejected" ? "rejected" : "form"}>
                <h3 style={{ margin: "0 0 4px" }}>📝 Monetization application</h3>
                {app?.status === "rejected" && (
                  <p style={{ color: "var(--bad)", fontSize: 14, margin: "0 0 8px" }}>Tumhari pichli application reject ho gayi thi — maloomat check karke dobara apply kar sakte ho.</p>
                )}
                <p style={{ color: "var(--dim)", fontSize: 14, margin: "0 0 10px" }}>Apni asal maloomat likhein — owner yehi check karke approve karega. Date of birth ghalat likha to application reject ho sakti hai.</p>
                <form onSubmit={apply} style={{ display: "grid", gap: 8 }}>
                  <input className="input" placeholder="Full real name (e.g. Ahmed Raza)" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
                  <label style={{ fontSize: 13, color: "var(--dim)" }}>
                    Date of birth
                    <input className="input" type="date" value={dob} onChange={(e) => setDob(e.target.value)} required style={{ marginTop: 4 }} />
                  </label>
                  {under18 && <div style={{ color: "var(--bad)", fontSize: 14 }}>18 saal se kam umar monetization ke liye eligible nahi hai.</div>}
                  <input className="input" placeholder="JazzCash number (03xxxxxxxxx) — payouts is pe ayenge" value={jcNumber} onChange={(e) => setJcNumber(e.target.value)} required />
                  <button className="btn btn-primary" type="submit" disabled={busy || !formReady} data-apply-monetization="">
                    {busy ? "Bhej rahe hain…" : "💰 Apply for Monetization"}
                  </button>
                  {!crit.followers.met || !crit.views.met ? (
                    <p style={{ color: "var(--dim)", fontSize: 13.5, margin: 0 }}>
                      Apply tab khulega jab: 👥 Followers {crit.followers.current.toLocaleString()}/{crit.followers.required.toLocaleString()} · 👀 Views {crit.views.current.toLocaleString()}/{crit.views.required.toLocaleString()} — jo baqi hai pehle wo pura karein.
                    </p>
                  ) : null}
                </form>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function RewardsView({ me, refreshMe }) {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [board, setBoard] = useState("coins");
  const [claimCode, setClaimCode] = useState("");
  const [packIndex, setPackIndex] = useState(0);
  const [buyMode, setBuyMode] = useState("pack");
  const [customCoins, setCustomCoins] = useState("");
  const [wdCoins, setWdCoins] = useState("");
  const [wdNumber, setWdNumber] = useState("");
  const [wdTitle, setWdTitle] = useState("");
  const [tid, setTid] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [showMonetization, setShowMonetization] = useState(false);
  const [fx, setFx] = useState(null);
  const [fxCur, setFxCur] = useState("USD");
  const waking = useWaking();

  // Own-profile shortcut: Profile's "💰 Start Monetization" jumps to this
  // tab with a session flag — open the panel straight away, once.
  useEffect(() => {
    try {
      if (sessionStorage.getItem("zoomly_open_monetization") === "1") {
        sessionStorage.removeItem("zoomly_open_monetization");
        setShowMonetization(true);
      }
    } catch {
      /* storage unavailable */
    }
  }, []);

  const load = useCallback(async () => {
    setLoadError(false);
    // getRewards is a read: the RPC client retries it while the server
    // wakes up, so data usually just arrives a little late.
    const res = await call("getRewards", {});
    if (res.ok) setData(res);
    else if (res.transportError) setLoadError(true);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Live FX rates for the balance converter (1 coin = Rs.1). Fetched once
  // per visit; a failed fetch just hides the converter card.
  useEffect(() => {
    let alive = true;
    call("getFxRates", {})
      .then((res) => {
        if (alive && res.ok && res.rates) setFx(res);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  async function copyCode() {
    const text = data?.my_code || "";
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Your referral code was copied.");
    } catch {
      setNotice(`Your referral code: ${text}`);
    }
  }

  async function copyLink() {
    const link = inviteLinkFor(data?.my_code);
    try {
      await navigator.clipboard.writeText(link);
      setNotice("Your invite link was copied.");
    } catch {
      setNotice(`Your invite link: ${link}`);
    }
  }

  async function shareCode() {
    const link = inviteLinkFor(data?.my_code);
    const text = `Join me on Zoomly! Sign up with my invite link ${link} — or use my referral code ${data?.my_code} when you sign up.`;
    if (navigator.share) {
      try {
        await navigator.share({ title: "Zoomly", text, url: link });
        return;
      } catch {
        /* user cancelled */
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Invite message copied — paste it anywhere to share.");
    } catch {
      setNotice(text);
    }
  }

  async function claim(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    const res = await call("claimReferral", { code: claimCode });
    setBusy(false);
    if (!res.ok) {
      setError(res.message || "Could not claim that code.");
      return;
    }
    setNotice(res.message);
    setClaimCode("");
    refreshMe?.();
    load();
  }

  async function buy(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    const res =
      buyMode === "custom"
        ? await call("requestCustomCoins", { coins: Math.floor(Number(customCoins) || 0), tid })
        : await call("requestCoins", { pack_index: packIndex, tid });
    setBusy(false);
    if (!res.ok) {
      setError(res.message || "Could not send the request.");
      return;
    }
    setNotice(res.message);
    setTid("");
    load();
  }

  async function withdraw(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    const res = await call("requestWithdrawal", {
      coins: Math.floor(Number(wdCoins) || 0),
      jazzcash_number: wdNumber.trim(),
      account_title: wdTitle.trim(),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.message || "Withdrawal could not be sent.");
      return;
    }
    setNotice(res.message);
    setWdCoins("");
    setWdNumber("");
    setWdTitle("");
    refreshMe?.();
    load();
  }

  if (!data && loadError) {
    return (
      <div style={{ padding: 20, textAlign: "center" }}>
        <p style={{ color: "var(--dim)" }}>Rewards + Monetization could not load — the server may be waking up.</p>
        <button className="btn btn-primary" onClick={load}>
          Try again
        </button>
      </div>
    );
  }
  if (!data) return <p style={{ padding: 20, color: "var(--dim)" }}>{waking ? WAKING_TEXT : "Loading rewards…"}</p>;
  const selectedPack = data.packs[packIndex] || data.packs[0];
  const customCoinsNum = Math.max(0, Math.floor(Number(customCoins) || 0));
  const wdCoinsNum = Math.max(0, Math.floor(Number(wdCoins) || 0));
  const payAmount = buyMode === "custom" ? customCoinsNum : selectedPack.pricePkr;
  // Cash-out is for monetized creators (owner-approved) — the owner/admin
  // is exempt. The server enforces the same gate; this is just so nobody
  // is surprised at submit time.
  const monGate = Boolean(data.monetization) && !data.monetization.monetized && !me?.is_admin;

  return (
    <div style={{ padding: "14px 14px 20px", maxWidth: 640, margin: "0 auto" }}>
      <h2 style={{ margin: "2px 0 12px" }}>Rewards + Monetization</h2>
      <Notice text={error} bad />
      <Notice text={notice} />

      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ color: "var(--dim)", fontSize: 13 }}>Your coin balance</div>
            <div style={{ fontSize: 28, fontWeight: 900 }}>🪙 {data.coin_balance}</div>
          </div>
          <LevelBadge level={data.level} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "var(--dim)", marginTop: 10 }}>
          <span>Level: {data.level}</span>
          <span>{data.next_level ? `Next: ${data.next_level} at ${data.next_level_min} coins` : "Top level 🏆"}</span>
        </div>
        <div className="progress-track" style={{ marginTop: 5 }}>
          <div className="progress-fill" style={{ width: `${Math.round((data.progress || 0) * 100)}%` }} />
        </div>
        <div style={{ color: "var(--dim)", fontSize: 13, marginTop: 8 }}>Levels: Starter → Bronze (100) → Silver (500) → Golden (1,500) → Platinum (5,000) → Diamond (14,000)</div>
      </div>

      {fx && data ? (
        <div className="card" style={{ marginTop: 14 }}>
          <h3 style={{ margin: "0 0 4px" }}>💱 Balance ki value — har currency mein</h3>
          <p style={{ color: "var(--dim)", fontSize: 14, margin: "0 0 10px" }}>
            1 coin = Rs.1 — apna balance kisi bhi currency mein live rate par check karein.
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <select className="input" value={fxCur} onChange={(e) => setFxCur(e.target.value)} style={{ maxWidth: 220 }}>
              {["USD", "EUR", "GBP", "AED", "SAR", "AUD", "CAD", "INR", "CNY", "TRY"]
                .filter((c) => fx.rates[c])
                .concat(Object.keys(fx.rates).filter((c) => !["USD", "EUR", "GBP", "AED", "SAR", "AUD", "CAD", "INR", "CNY", "TRY"].includes(c)).sort())
                .map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
            </select>
            <div style={{ fontSize: 20, fontWeight: 900 }}>
              {(() => {
                try {
                  return new Intl.NumberFormat(undefined, { style: "currency", currency: fxCur, maximumFractionDigits: 2 }).format(data.coin_balance * (fx.rates[fxCur] || 0));
                } catch {
                  return `${(data.coin_balance * (fx.rates[fxCur] || 0)).toFixed(2)} ${fxCur}`;
                }
              })()}
            </div>
          </div>
          <div style={{ color: "var(--dim)", fontSize: 13, marginTop: 8 }}>
            🪙 {data.coin_balance.toLocaleString()} coins = Rs.{data.coin_balance.toLocaleString()} · 1 PKR = {fx.rates[fxCur]} {fxCur} (live market rate
            {fx.updated_unix ? `, ${new Date(fx.updated_unix * 1000).toLocaleDateString()}` : ""})
          </div>
        </div>
      ) : null}

      <button className="btn btn-primary" data-start-monetization="" onClick={() => setShowMonetization(true)} style={{ width: "100%", marginTop: 14, padding: "14px", fontSize: 16.5, fontWeight: 800, borderRadius: 14 }}>
        {data.monetization?.monetized ? "💰 Monetization — Active ✅" : "💰 Start Monetization"}
      </button>
      <p style={{ color: "var(--dim)", fontSize: 13.5, margin: "7px 2px 0", textAlign: "center" }}>
        {data.monetization?.monetized ? "Aap monetized creator hain — withdrawal aap ke liye khula hai." : "Creator ho? Criteria pura karo, apply karo — owner ki approval ke baad withdrawal khul jata hai."}
      </p>

      <div className="card" style={{ marginTop: 14 }}>
        <h3 style={{ margin: "0 0 4px" }}>🔗 Your referral code & invite link</h3>
        <p style={{ color: "var(--dim)", fontSize: 14, margin: "0 0 10px" }}>
          Share your code or your invite link — every friend who joins with it counts as your referral and climbs you up the Top Referrals board. Friends who open your link get the code applied automatically when they sign up. You have {data.referral_count} referral{data.referral_count === 1 ? "" : "s"} so far.
        </p>
        <p style={{ color: "var(--accent)", fontSize: 14, fontWeight: 700, margin: "0 0 10px" }}>🪙 Har referral pe 1 coin — foran aap ke balance me!</p>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <code style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 10, padding: "9px 12px", fontWeight: 700, fontSize: 15 }}>{data.my_code}</code>
          <button className="btn" onClick={copyCode}>
            Copy code
          </button>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 10 }}>
          <code style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 10, padding: "9px 12px", fontWeight: 600, fontSize: 13, wordBreak: "break-all" }}>{inviteLinkFor(data.my_code)}</code>
          <button className="btn" onClick={copyLink}>
            Copy link
          </button>
          <button className="btn btn-primary" onClick={shareCode}>
            Share invite
          </button>
        </div>
        {!data.has_claimed_referral && (
          <form onSubmit={claim} style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <input className="input" placeholder="Have a friend's code? Enter it here" value={claimCode} onChange={(e) => setClaimCode(e.target.value)} />
            <button className="btn" type="submit" disabled={busy}>
              Claim
            </button>
          </form>
        )}
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3 style={{ margin: "0 0 4px" }}>🪙 Buy coins</h3>
        <p style={{ color: "var(--dim)", fontSize: 14, margin: "0 0 10px" }}>
          1) Send the pack price by JazzCash to <strong style={{ color: "var(--text)" }}>{data.jazzcash.number}</strong> ({data.jazzcash.title}).
          <br />
          2) Enter the Transaction ID (TID) from your JazzCash receipt below.
          <br />
          3) The owner verifies it and approves — coins land in your account.
          <br />
          Ya ✏️ <strong style={{ color: "var(--text)" }}>Custom</strong> choose karke apni marzi ke coins bhi le sakte ho (kam az kam 10 — 1 coin = Rs.1).
        </p>
        {/* Highlighted payment card: the number buyers send money to,
            big and unmissable (owner request). The number stays one
            contiguous, selectable text node. */}
        <div
          data-jazzcash-highlight=""
          style={{
            background: "color-mix(in srgb, var(--accent) 12%, var(--surface))",
            border: "2px solid var(--accent)",
            borderRadius: 14,
            padding: "12px 14px",
            margin: "0 0 12px",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 12.5, fontWeight: 800, letterSpacing: 1.4, color: "var(--accent)" }}>💸 JAZZCASH</div>
          <div style={{ fontSize: 27, fontWeight: 900, letterSpacing: 1, color: "var(--text)", marginTop: 2, userSelect: "text" }}>{data.jazzcash.number}</div>
          <div style={{ fontSize: 15, fontWeight: 800, color: "var(--text)" }}>{data.jazzcash.title}</div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(104px, 1fr))", gap: 8 }}>
          {data.packs.map((pack, i) => (
            <button
              key={pack.coins}
              onClick={() => {
                setPackIndex(i);
                setBuyMode("pack");
              }}
              className="card"
              style={{ padding: 10, textAlign: "center", cursor: "pointer", borderColor: buyMode === "pack" && i === packIndex ? "var(--accent)" : "var(--border)", color: "var(--text)" }}
            >
              <div style={{ fontWeight: 900, fontSize: 17 }}>🪙 {pack.coins.toLocaleString()}</div>
              <div style={{ color: "var(--dim)", fontSize: 13 }}>Rs.{Number(pack.pricePkr ?? 0).toLocaleString()}</div>
            </button>
          ))}
          <button
            onClick={() => setBuyMode("custom")}
            className="card"
            style={{ padding: 10, textAlign: "center", cursor: "pointer", borderColor: buyMode === "custom" ? "var(--accent)" : "var(--border)", color: "var(--text)" }}
          >
            <div style={{ fontWeight: 900, fontSize: 17 }}>✏️ Custom</div>
            <div style={{ color: "var(--dim)", fontSize: 13 }}>1 coin = Rs.1</div>
          </button>
        </div>
        {buyMode === "custom" && (
          <div style={{ marginTop: 10 }}>
            <label style={{ fontSize: 13, color: "var(--dim)" }}>Kitne coins chahiye? (kam az kam 10)</label>
            <input className="input" type="number" min="10" step="1" placeholder="e.g. 250" value={customCoins} onChange={(e) => setCustomCoins(e.target.value)} style={{ marginTop: 4 }} />
            <p style={{ fontSize: 14, margin: "6px 0 0" }}>
              Pay <strong>Rs.{customCoinsNum.toLocaleString()}</strong> by JazzCash for <strong>🪙 {customCoinsNum.toLocaleString()} coins</strong>, then enter the TID below.
            </p>
          </div>
        )}
        <form onSubmit={buy} style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <input className="input" placeholder={`JazzCash TID for the Rs.${payAmount} payment`} value={tid} onChange={(e) => setTid(e.target.value)} required />
          <button className="btn btn-primary" type="submit" disabled={busy}>
            Submit
          </button>
        </form>
        {data.my_requests.length > 0 && (
          <>
            <h4 style={{ margin: "16px 0 6px", color: "var(--dim)" }}>My requests</h4>
            <div style={{ display: "grid", gap: 6 }}>
              {data.my_requests.map((r) => (
                <div key={r.id} style={{ fontSize: 14, display: "flex", justifyContent: "space-between" }}>
                  <span>
                    🪙 {r.pack_coins} · Rs.{r.price_pkr}{r.is_custom ? " · custom" : ""} · TID {r.tid}
                  </span>
                  <strong style={{ color: r.status === "approved" ? "var(--accent)" : r.status === "rejected" ? "var(--bad)" : "var(--dim)" }}>{r.status}</strong>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3 style={{ margin: "0 0 4px" }}>💸 Withdraw coins (cash out)</h3>
        <p style={{ color: "var(--dim)", fontSize: 14, margin: "0 0 10px" }}>
          1 coin = Rs.1. Request bhejte hi coins tumhare balance se <strong style={{ color: "var(--text)" }}>hold</strong> ho jate hain — hold wale coins na gift ho sakte hain, na dobara withdraw. Owner approve karega to tumhare JazzCash number par paise milenge; agar reject ho jaye to coins auto wapas balance me aa jate hain. Kam az kam 100 coins (Rs.100).
        </p>
        <form onSubmit={withdraw} style={{ display: "grid", gap: 8 }}>
          <input className="input" type="number" min="100" step="1" placeholder={`Coins to withdraw (your balance: ${data.coin_balance})`} value={wdCoins} onChange={(e) => setWdCoins(e.target.value)} required />
          {wdCoinsNum > 0 && (
            <div style={{ fontSize: 14 }}>
              You will receive: <strong>Rs.{wdCoinsNum.toLocaleString()}</strong>
            </div>
          )}
          <input className="input" placeholder="Your JazzCash number (03xxxxxxxxx)" value={wdNumber} onChange={(e) => setWdNumber(e.target.value)} required />
          <input className="input" placeholder="Account title / name (optional)" value={wdTitle} onChange={(e) => setWdTitle(e.target.value)} />
          <button className="btn btn-primary" type="submit" disabled={busy || monGate}>
            Request withdrawal
          </button>
          {monGate && (
            <div style={{ fontSize: 14, color: "var(--dim)" }} data-withdraw-monetization-hint="">
              Withdrawal sirf monetized creators ke liye hai — pehle monetization criteria pura karke apply karein:{" "}
              <button type="button" onClick={() => setShowMonetization(true)} style={{ background: "none", border: "none", color: "var(--accent)", fontWeight: 800, cursor: "pointer", padding: 0, fontSize: 14 }}>
                💰 Start Monetization
              </button>
            </div>
          )}
        </form>
        {data.my_withdrawals?.length > 0 && (
          <>
            <h4 style={{ margin: "16px 0 6px", color: "var(--dim)" }}>My withdrawals</h4>
            <div style={{ display: "grid", gap: 6 }}>
              {data.my_withdrawals.map((w) => (
                <div key={w.id} style={{ fontSize: 14, display: "flex", justifyContent: "space-between" }}>
                  <span>
                    🪙 {w.coins} · Rs.{w.amount_pkr} · {w.jazzcash_number}
                  </span>
                  <strong style={{ color: w.status === "approved" ? "var(--accent)" : w.status === "rejected" ? "var(--bad)" : "var(--dim)" }}>{w.status}</strong>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <GiftEarningsCard />

      <div className="card" style={{ marginTop: 14 }}>
        <h3 style={{ margin: "0 0 4px" }}>🏆 Leaderboard</h3>
        <p style={{ color: "var(--dim)", fontSize: 14, margin: "0 0 6px" }}>The top 50 users — visible to everyone in the app.</p>
        <div style={{ display: "flex", gap: 6 }}>
          <button className={`tab-btn ${board === "coins" ? "active" : ""}`} onClick={() => setBoard("coins")}>
            Top Coins
          </button>
          <button className={`tab-btn ${board === "referrals" ? "active" : ""}`} onClick={() => setBoard("referrals")}>
            Top Referrals
          </button>
        </div>
        <div>
          {(board === "coins" ? data.leaderboards.top_coins : data.leaderboards.top_referrals).map((row) => (
            <BoardRow key={row.id} row={row} metric={board} />
          ))}
          {(board === "coins" ? data.leaderboards.top_coins : data.leaderboards.top_referrals).length === 0 && <p style={{ color: "var(--dim)" }}>No users yet.</p>}
        </div>
      </div>

      {showMonetization && (
        <MonetizationPanel
          onClose={() => {
            setShowMonetization(false);
            load();
          }}
          refreshMe={refreshMe}
        />
      )}

      {me?.is_admin && <AdminSection refreshMe={refreshMe} />}
      {me?.is_admin && <ModerationSection />}
    </div>
  );
}

// ---------- notifications inbox -------------------------------------------------
// Full-screen in-app inbox (no push). Opening it fetches the latest
// notifications and marks them all read; rows keep the read state they
// arrived with so unread ones stand out during this visit.
const NOTIF_ICONS = { like: "❤️", comment: "💬", follow: "👥", gift: "🎁", referral: "🎉", coin_request: "🪙", withdrawal: "💸", monetization: "💰", live: "🔴", story: "⭕", dm: "✉️" };

function NotificationsPanel({ onClose, refreshMe, onGoLive }) {
  const [items, setItems] = useState(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await call("getNotifications", {});
      if (res.ok) {
        setItems(res.notifications);
        await call("markNotificationsRead", {});
        refreshMe?.();
      } else if (res.transportError) {
        setLoadError(true);
      } else {
        setItems([]);
      }
    })();
  }, [refreshMe]);

  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--bg)", zIndex: 70, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
        <strong style={{ fontSize: 18, flex: 1 }}>🔔 Notifications</strong>
        <button className="btn btn-small" onClick={onClose}>
          ✕ Close
        </button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "10px 14px", maxWidth: 640, width: "100%", margin: "0 auto" }}>
        {items === null && !loadError && <p style={{ color: "var(--dim)" }}>Loading…</p>}
        {loadError && <p style={{ color: "var(--dim)" }}>Notifications could not load — the server may be waking up. Close and try again.</p>}
        {items !== null && items.length === 0 && <p style={{ color: "var(--dim)" }}>No notifications yet — likes, comments, follows, gifts and owner decisions will show up here.</p>}
        {items?.map((n) => (
          <div
            key={n.id}
            onClick={() => {
              if (n.live_session_id) {
                onClose();
                onGoLive?.();
              }
            }}
            style={{
              display: "flex",
              gap: 10,
              alignItems: "flex-start",
              padding: "10px 8px",
              borderBottom: "1px solid var(--border)",
              background: n.read ? "transparent" : "var(--surface-2)",
              borderRadius: 10,
              cursor: n.live_session_id ? "pointer" : "default",
            }}
          >
            {n.actor ? (
              <Avatar user={n.actor} size={38} />
            ) : (
              <div style={{ width: 38, height: 38, borderRadius: "50%", background: "var(--surface)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17, flexShrink: 0 }}>{NOTIF_ICONS[n.type] || "🔔"}</div>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14.5 }}>{n.text}</div>
              <div style={{ color: "var(--dim)", fontSize: 12.5, marginTop: 2 }}>
                {timeAgo(n.created_at)}
                {!n.read ? " · new" : ""}
              </div>
            </div>
            {!n.read && <span style={{ width: 9, height: 9, borderRadius: "50%", background: "#e0245e", marginTop: 6, flexShrink: 0 }} />}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- app shell ------------------------------------------------------------------

// Bottom navigation: 3 + center + 3, with Live as the prominent raised
// center button (TikTok-style) — it is the app's headline action.
// Bottom navigation (2026-10-26 redesign): exactly the 5 requested tabs.
// Legacy screens are NOT deleted: Live stays reachable from the feed
// header's LIVE button, Watch/People from Search results, and Rewards +
// Monetization from the profile's Start Monetization button. Old stored
// tabs (watch/people/live/rewards) still render if restored on refresh.
const NAV = [
  { key: "feed", label: "Home", icon: "🏠" },
  { key: "people", label: "Friends", icon: "👥" },
  { key: "upload", label: "Create", icon: "＋", create: true },
  { key: "inbox", label: "Inbox", icon: "✉️" },
  { key: "profile", label: "Profile", icon: "👤" },
];

export function App() {
  const [me, setMe] = useState(null);
  const [booting, setBooting] = useState(true);
  const [bootFailed, setBootFailed] = useState(false);
  const [googleSetup, setGoogleSetup] = useState(false);
  // Boot on the tab the user left open (a shared video link still wins
  // and opens the feed) so a refresh returns them to the same place.
  const [tab, setTab] = useState(() => initialTab());
  const [showNotifs, setShowNotifs] = useState(false);
  const [chatPeer, setChatPeer] = useState(null);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [sharedPostId, setSharedPostId] = useState(null);
  const [sharedUsername, setSharedUsername] = useState(null);
  // When the restored tab is a profile, restore whose profile it was too
  // (null = the user's own profile).
  const [profileUserId, setProfileUserId] = useState(() => (tab === "profile" ? storedProfileUserId() : null));
  const [feedKey, setFeedKey] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [guest, setGuest] = useState(false);
  const [phase2, setPhase2] = useState(null);
  const waking = useWaking();

  const refreshMe = useCallback(async () => {
    if (!getToken()) return;
    const res = await call("getMe", {});
    if (res.ok) setMe(res.user);
  }, []);

  useEffect(() => {
    (async () => {
      // An invite link (?ref=CODE) may have brought the visitor here:
      // stash the code first so the signup flows can apply it.
      captureInviteRef();
      // A shared video link (?v=<post id>) opens the feed at that video.
      const sharedId = captureSharedPostId();
      if (sharedId) setSharedPostId(sharedId);
      // A shared profile link (?u=<username>) opens that profile.
      try {
        const u = new URLSearchParams(window.location.search).get("u");
        if (u && u.trim()) {
          setSharedUsername(u.trim().toLowerCase());
          const url = new URL(window.location.href);
          url.searchParams.delete("u");
          window.history.replaceState(null, "", url.pathname + url.search + url.hash);
        }
      } catch {
        /* ignore */
      }
      // Google sign-in returns through the URL hash: #google-token=<session>
      // for existing accounts, #google-setup for first-time username choice.
      const hash = window.location.hash || "";
      if (hash.startsWith("#google-token=")) {
        setToken(decodeURIComponent(hash.slice("#google-token=".length)));
        window.history.replaceState(null, "", window.location.pathname);
      } else if (hash.startsWith("#google-setup")) {
        setGoogleSetup(true);
        window.history.replaceState(null, "", window.location.pathname);
      }
      if (getToken()) {
        // getMe is a read, so the RPC client retries it while the server
        // wakes up (up to ~90s). Only a transport failure after all those
        // retries means the app really could not open; a normal "not signed
        // in" answer just means the saved session is gone.
        const res = await call("getMe", {});
        if (res.ok) setMe(res.user);
        else if (res.transportError) setBootFailed(true);
        else setToken("");
      }
      setBooting(false);
    })();
  }, []);

  // Remember the open tab (and whose profile is open on it) so a page
  // refresh returns the user here instead of Home. Saved only while
  // signed in, so a logged-out visit never overwrites the saved place.
  useEffect(() => {
    if (!me) return;
    saveTab(tab, profileUserId);
  }, [me, tab, profileUserId]);

  async function openHashtag(tag) { setPhase2({ screen: "hashtag", tag }); }
  async function openMention(username) {
    const res = await call("getPeople", { query: username });
    const match = res.ok ? res.people.find((p) => p.username === username.toLowerCase()) : null;
    if (match) openProfile(match.id);
  }
  function openProfile(userId) {
    setProfileUserId(userId ?? null);
    setTab("profile");
  }

  // Resolve a shared profile link (?u=<username>) once signed in.
  useEffect(() => {
    if (!sharedUsername || !me) return;
    const wanted = sharedUsername;
    setSharedUsername(null);
    (async () => {
      const res = await call("getPeople", { query: wanted });
      const match = res.ok ? res.people.find((p) => p.username === wanted) : null;
      if (match) openProfile(match.id);
    })();
  }, [sharedUsername, me]);

  async function logout() {
    await call("logout", {});
    setToken("");
    setMe(null);
    // Signing out forgets the saved place: the next sign-in on this
    // browser starts at Home, not where the previous user left off.
    clearStoredTab();
    setProfileUserId(null);
    setTab("feed");
  }

  // A fresh sign-in lands where the boot state already points: the tab
  // state holds the boot decision (shared video → feed, otherwise the
  // remembered tab, otherwise Home), so it is deliberately left alone —
  // only a remembered someone-else's profile is dropped, because after a
  // fresh login the profile tab should mean YOUR profile until you open
  // somebody else's.
  function afterAuth(user) {
    setGoogleSetup(false);
    setMe(user);
    if (profileUserId && profileUserId !== user.id) setProfileUserId(null);
  }

  if (bootFailed) {
    return (
      <div style={{ padding: 48, textAlign: "center" }}>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <Logo size={64} />
        </div>
        <h2 style={{ marginTop: 16 }}>Zoomly could not open</h2>
        <p style={{ color: "var(--dim)" }}>Reload the page to try again.</p>
        <button className="btn btn-primary" onClick={() => window.location.reload()}>
          Reload page
        </button>
      </div>
    );
  }

  if (booting) {
    return (
      <div style={{ padding: 48, textAlign: "center" }}>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <Logo size={64} />
        </div>
        <div style={{ fontSize: 36, fontWeight: 900, marginTop: 10 }}>
          Zoom<span style={{ color: "var(--accent)" }}>ly</span>
        </div>
        <p style={{ color: "var(--dim)" }}>{waking ? WAKING_TEXT : "Loading…"}</p>
      </div>
    );
  }

  if (!me) {
    if (googleSetup) {
      return (
        <GoogleSetupView
          onAuthed={afterAuth}
          onCancel={() => setGoogleSetup(false)}
        />
      );
    }
    if (guest) return <GuestFeedView onSignIn={() => setGuest(false)} />;
    return <AuthView onAuthed={afterAuth} onGuest={() => setGuest(true)} />;
  }

  return (
    <div style={{ height: "100dvh", display: "flex", flexDirection: "column", maxWidth: tab === "feed" ? 480 : 860, margin: "0 auto" }}>
      <div style={{ flex: 1, minHeight: 0, overflowY: tab === "feed" ? "hidden" : "auto" }} className={tab === "feed" ? "" : "no-scrollbar"}>
        {tab === "feed" && <FeedView key={feedKey} me={me} onOpenProfile={openProfile} refreshMe={refreshMe} onGoLive={() => setTab("live")} onOpenNotifications={() => setShowNotifs(true)} onOpenSearch={() => setTab("search")} onOpenCommunity={() => setTab("people")} sharedPostId={sharedPostId} onHashtag={openHashtag} onMention={openMention} />}
        {tab === "watch" && <WatchView me={me} onOpenProfile={openProfile} />}
        {tab === "search" && <SearchView me={me} onOpenProfile={openProfile} />}
        {tab === "inbox" && <InboxView me={me} onOpenChat={(u) => setChatPeer(u)} onGoLive={() => setTab("live")} refreshMe={refreshMe} />}
        {tab === "live" && <LiveView me={me} refreshMe={refreshMe} onOpenProfile={openProfile} />}
        {tab === "upload" && (
          <UploadView
            onGoLive={() => setTab("live")}
            onPosted={() => {
              setFeedKey((k) => k + 1);
            }}
          />
        )}
        {tab === "people" && <PeopleView me={me} onOpenProfile={openProfile} refreshMe={refreshMe} onMessage={(u) => setChatPeer(u)} onOpenInbox={() => setInboxOpen(true)} />}
        {tab === "rewards" && <RewardsView me={me} refreshMe={refreshMe} />}
        {tab === "profile" && (
          <ProfileView
            me={me}
            userId={profileUserId}
            onOpenProfile={openProfile}
            onOpenVideo={(postId) => {
              setSharedPostId(postId);
              setFeedKey((k) => k + 1);
              setTab("feed");
            }}
            refreshMe={refreshMe}
            onLogout={logout}
            onMessage={(u) => setChatPeer(u)}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenPhase2={() => setPhase2({ screen: "menu" })}
            onGoMonetization={() => {
              try {
                sessionStorage.setItem("zoomly_open_monetization", "1");
              } catch {
                /* storage unavailable — the Rewards button still works */
              }
              setTab("rewards");
            }}
          />
        )}
      </div>
      {showNotifs && (
        <NotificationsPanel
          onClose={() => setShowNotifs(false)}
          refreshMe={refreshMe}
          onGoLive={() => setTab("live")}
        />
      )}
      {inboxOpen && (
        <ConversationsScreen
          me={me}
          onClose={() => setInboxOpen(false)}
          onOpenChat={(u) => {
            setInboxOpen(false);
            setChatPeer(u);
          }}
        />
      )}
      {chatPeer && <ChatScreen me={me} peer={chatPeer} onClose={() => setChatPeer(null)} refreshMe={refreshMe} />}
      {settingsOpen && <SettingsView me={me} onClose={() => setSettingsOpen(false)} onLogout={logout} refreshMe={refreshMe} />}
      {phase2 && <Phase2Hub me={me} onClose={() => setPhase2(null)} onGoLive={() => { setPhase2(null); setTab("live"); }} onGoUpload={() => { setPhase2(null); setTab("upload"); }} initialScreen={phase2.screen} initialTag={phase2.tag} />}
      <nav className="tiktok-nav" aria-label="Main navigation">
        {NAV.map((item) =>
          item.create ? (
            <button
              key={item.key}
              onClick={() => setTab("upload")}
              aria-label="Create video"
              className={tab === "upload" ? "active" : ""}
              style={{ color: tab === "upload" ? "var(--text)" : "var(--dim)" }}
            >
              <span className="nav-create-badge" aria-hidden="true">＋</span>
              Create
            </button>
          ) : (
            <button
              key={item.key}
              onClick={() => {
                if (item.key === "profile") setProfileUserId(null);
                setTab(item.key);
              }}
              className={tab === item.key ? "active" : ""}
              aria-label={item.label}
              style={{ position: "relative" }}
            >
              <span style={{ fontSize: 22, lineHeight: 1 }}>{item.icon}</span>
              {item.label}
              {item.key === "inbox" && (me?.unread_notifications ?? 0) + (me?.unread_messages ?? 0) > 0 && (
                <span style={{ position: "absolute", top: 4, right: "calc(50% - 26px)", background: "var(--accent)", color: "#131a02", borderRadius: 999, minWidth: 18, height: 18, padding: "0 5px", fontSize: 11, fontWeight: 800, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                  {(me.unread_notifications + me.unread_messages) > 99 ? "99+" : me.unread_notifications + me.unread_messages}
                </span>
              )}
            </button>
          )
        )}
      </nav>
    </div>
  );
}
