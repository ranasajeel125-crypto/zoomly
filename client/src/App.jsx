import { useCallback, useEffect, useRef, useState } from "react";
import { call, getToken, isWaking, setToken, subscribeWaking, uploadMedia } from "./api";
import { LiveView } from "./Live.jsx";
import { setViewerMuted, viewerMuted } from "./sound.js";

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

function timeAgo(ts) {
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
      body: JSON.stringify({ username, display_name: displayName || undefined, referral_code: referralCode || undefined }),
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

function AuthView({ onAuthed }) {
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
        ? await call("signup", { username, display_name: displayName || undefined, password, referral_code: referralCode || undefined })
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
      {mode === "signup" && <p style={{ color: "var(--dim)", fontSize: 13, marginTop: 12 }}>Signing up with a friend&apos;s referral code counts you as their referral.</p>}
    </div>
  );
}

// ---------- comments ------------------------------------------------------------

function CommentsSheet({ post, onClose, onAdded }) {
  const [comments, setComments] = useState([]);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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
    const res = await call("addComment", { post_id: post.id, body });
    setBusy(false);
    if (!res.ok) {
      setError(res.message || "Could not post the comment.");
      return;
    }
    setBody("");
    setComments((prev) => [...prev, res.comment]);
    onAdded?.();
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 60, display: "flex", alignItems: "flex-end", justifyContent: "center" }} onClick={onClose}>
      <div
        style={{ background: "var(--surface)", width: "100%", maxWidth: 560, maxHeight: "75vh", borderRadius: "18px 18px 0 0", display: "flex", flexDirection: "column", padding: "14px 16px calc(14px + env(safe-area-inset-bottom))" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <strong>Comments ({comments.length})</strong>
          <button className="btn btn-small" onClick={onClose}>
            ✕
          </button>
        </div>
        <div style={{ overflowY: "auto", flex: 1, display: "grid", gap: 12, padding: "6px 0" }}>
          {comments.length === 0 && <p style={{ color: "var(--dim)" }}>No comments yet — be the first!</p>}
          {comments.map((c) => (
            <div key={c.id} style={{ display: "flex", gap: 10 }}>
              <Avatar user={c.author} size={34} />
              <div>
                <div style={{ fontSize: 13 }}>
                  <strong>{c.author.display_name}</strong> <span style={{ color: "var(--dim)" }}>@{c.author.username} · {timeAgo(c.created_at)}</span>
                </div>
                <div style={{ fontSize: 15 }}>{c.body}</div>
              </div>
            </div>
          ))}
        </div>
        <Notice text={error} bad />
        <form onSubmit={submit} style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input className="input" placeholder="Add a comment…" value={body} onChange={(e) => setBody(e.target.value)} maxLength={500} />
          <button className="btn btn-primary" type="submit" disabled={busy}>
            Post
          </button>
        </form>
      </div>
    </div>
  );
}

// ---------- feed ------------------------------------------------------------------

function VideoCard({ post, onLike, onFollow, onComment, onOpenProfile }) {
  const videoRef = useRef(null);
  const cardRef = useRef(null);
  // Sound is ON by default; `muted` here is only ever the viewer's own
  // persisted choice — or a temporary browser-forced muted autoplay
  // (forcedMute), which shows the "🔊 Sound on" overlay and is NOT
  // persisted as a preference.
  const [muted, setMuted] = useState(() => viewerMuted());
  const [forcedMute, setForcedMute] = useState(false);
  const [paused, setPaused] = useState(false);
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
    <div className="feed-item" ref={cardRef} style={{ background: "#000" }}>
      <video
        ref={videoRef}
        src={post.video_url}
        poster={post.thumbnail_url || undefined}
        style={{ width: "100%", height: "100%", objectFit: "contain", background: "#000" }}
        loop
        muted={muted}
        playsInline
        preload="metadata"
        onClick={togglePlay}
        onDoubleClick={() => onLike(post)}
      />
      {paused && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none", fontSize: 64, opacity: 0.8 }}>
          ▶
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
      <div style={{ position: "absolute", right: 10, bottom: 96, display: "flex", flexDirection: "column", gap: 16, alignItems: "center" }}>
        <button onClick={() => onOpenProfile(post.author.id)} style={{ background: "none", border: "none", padding: 0 }} aria-label="Open profile">
          <Avatar user={post.author} size={48} />
        </button>
        {post.author && !post.author.is_me && (
          <button className="btn btn-primary btn-small" onClick={() => onFollow(post.author)}>
            {post.author.followed_by_me ? "Following" : "Follow"}
          </button>
        )}
        <button onClick={() => onLike(post)} style={{ background: "none", border: "none", color: post.liked_by_me ? "var(--accent)" : "#fff", fontSize: 30, lineHeight: 1 }} aria-label="Like">
          ♥
          <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>{post.like_count}</div>
        </button>
        <button onClick={() => onComment(post)} style={{ background: "none", border: "none", color: "#fff", fontSize: 28, lineHeight: 1 }} aria-label="Comments">
          💬
          <div style={{ fontSize: 13, fontWeight: 700 }}>{post.comment_count}</div>
        </button>
        <button onClick={toggleMute} style={{ background: "none", border: "none", color: "#fff", fontSize: 24, lineHeight: 1 }} aria-label="Sound">
          {muted ? "🔇" : "🔊"}
        </button>
      </div>
      <div style={{ position: "absolute", left: 12, right: 84, bottom: 86, color: "#fff", textShadow: "0 1px 6px rgba(0,0,0,0.8)" }}>
        <button onClick={() => onOpenProfile(post.author.id)} style={{ background: "none", border: "none", color: "#fff", padding: 0, fontWeight: 800, fontSize: 16 }}>
          @{post.author?.username}
        </button>
        <div style={{ fontWeight: 700, marginTop: 2 }}>{post.title}</div>
        {post.description && <div style={{ fontSize: 14, opacity: 0.9 }}>{post.description}</div>}
        <div style={{ fontSize: 12, opacity: 0.75, marginTop: 2 }}>{timeAgo(post.created_at)}</div>
      </div>
    </div>
  );
}

function FeedView({ me, onOpenProfile, refreshMe }) {
  const [stream, setStream] = useState("foryou");
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [commentPost, setCommentPost] = useState(null);
  const waking = useWaking();

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    // getFeed is a read: retried automatically while the server wakes up.
    const res = await call("getFeed", { stream, limit: 30 });
    if (res.ok) setPosts(res.posts);
    else if (res.transportError) setLoadError(true);
    setLoading(false);
  }, [stream]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleLike(post) {
    const res = await call("toggleLike", { post_id: post.id });
    if (res.ok) {
      setPosts((prev) => prev.map((p) => (p.id === post.id ? { ...p, liked_by_me: res.liked, like_count: res.like_count } : p)));
    }
  }

  async function handleFollow(author) {
    const res = await call("toggleFollow", { user_id: author.id });
    if (res.ok) {
      setPosts((prev) => prev.map((p) => (p.author?.id === author.id ? { ...p, author: { ...p.author, followed_by_me: res.following } } : p)));
      refreshMe?.();
    }
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px 0" }}>
        <Logo size={30} />
        <div style={{ display: "flex", flex: 1, gap: 6 }}>
          <button className={`tab-btn ${stream === "following" ? "active" : ""}`} onClick={() => setStream("following")}>
            Following
          </button>
          <button className={`tab-btn ${stream === "foryou" ? "active" : ""}`} onClick={() => setStream("foryou")}>
            For You
          </button>
        </div>
        <span className="chip" title="Your coin balance">
          🪙 {me?.coin_balance ?? 0}
        </span>
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
        {posts.map((post) => (
          <VideoCard key={post.id} post={post} onLike={handleLike} onFollow={handleFollow} onComment={setCommentPost} onOpenProfile={onOpenProfile} />
        ))}
      </div>
      {commentPost && (
        <CommentsSheet
          post={commentPost}
          onClose={() => setCommentPost(null)}
          onAdded={() => setPosts((prev) => prev.map((p) => (p.id === commentPost.id ? { ...p, comment_count: p.comment_count + 1 } : p)))}
        />
      )}
    </div>
  );
}

// ---------- watch / browse -----------------------------------------------------

function WatchView({ onOpenProfile }) {
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

  return (
    <div style={{ padding: "14px 14px 20px", maxWidth: 720, margin: "0 auto" }}>
      <h2 style={{ margin: "2px 0 12px" }}>Watch</h2>
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
            <div style={{ fontWeight: 700 }}>{playing.title}</div>
            {playing.description && <div style={{ color: "var(--dim)", fontSize: 14 }}>{playing.description}</div>}
            <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
              <button className="btn" onClick={() => handleLike(playing)} style={{ color: playing.liked_by_me ? "var(--accent)" : "var(--text)" }}>
                ♥ {playing.like_count}
              </button>
              <button className="btn" onClick={() => setCommentPost(playing)}>
                💬 {playing.comment_count} Comments
              </button>
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

function UploadView({ onPosted }) {
  const [file, setFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  function pickFile(f) {
    setFile(f || null);
    setDone("");
    setError("");
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(f ? URL.createObjectURL(f) : "");
  }

  async function submit(e) {
    e.preventDefault();
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
    const up = await uploadMedia(file, "video");
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

  return (
    <div style={{ padding: "14px 14px 20px", maxWidth: 560, margin: "0 auto" }}>
      <h2 style={{ margin: "2px 0 12px" }}>Upload a video</h2>
      <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
        <label className="card" style={{ textAlign: "center", cursor: "pointer", borderStyle: "dashed" }}>
          <input type="file" accept="video/*" style={{ display: "none" }} onChange={(e) => pickFile(e.target.files?.[0])} />
          {previewUrl ? (
            <video
              src={previewUrl}
              style={{ width: "100%", maxHeight: 320, borderRadius: 12, background: "#000" }}
              controls
              playsInline
              ref={(el) => {
                if (el && el.dataset.mutedInit !== "1") {
                  el.muted = viewerMuted();
                  el.dataset.mutedInit = "1";
                }
              }}
            />
          ) : (
            <div style={{ padding: "18px 0" }}>
              <div style={{ fontSize: 36 }}>⬆️</div>
              <div style={{ fontWeight: 700, marginTop: 4 }}>Tap to choose a video</div>
              <div style={{ color: "var(--dim)", fontSize: 13 }}>MP4 and other video formats, up to 100 MB</div>
            </div>
          )}
          {file && <div style={{ color: "var(--dim)", fontSize: 13, marginTop: 6 }}>{file.name}</div>}
        </label>
        <input className="input" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} />
        <textarea className="input" placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} rows={3} />
        <Notice text={error} bad />
        <Notice text={done} />
        <button className="btn btn-primary" type="submit" disabled={busy} style={{ padding: "12px 16px", fontSize: 16 }}>
          {busy ? "Uploading… please keep this open" : "Post video"}
        </button>
      </form>
    </div>
  );
}

// ---------- people -----------------------------------------------------------------

function PeopleView({ onOpenProfile, refreshMe }) {
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
      <h2 style={{ margin: "2px 0 12px" }}>People</h2>
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
                  {person.display_name} <LevelBadge level={person.level} />
                </span>
                <span style={{ display: "block", color: "var(--dim)", fontSize: 13 }}>
                  @{person.username} · ID #{person.id} · {person.follower_count} followers
                </span>
              </span>
            </button>
            {!person.is_me && (
              <button className={`btn btn-small ${person.followed_by_me ? "" : "btn-primary"}`} onClick={() => handleFollow(person)}>
                {person.followed_by_me ? "Following" : "Follow"}
              </button>
            )}
            {person.is_me && <span className="chip">You</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- profile ------------------------------------------------------------------

function ProfileView({ me, userId, onOpenProfile, refreshMe, onLogout }) {
  const isMe = !userId || userId === me.id;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [dpBusy, setDpBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
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

  async function handleDelete(post) {
    if (!window.confirm(`Delete "${post.title}"? This cannot be undone.`)) return;
    const res = await call("deletePost", { post_id: post.id });
    if (res.ok) load();
  }

  if (loading) return <p style={{ padding: 20, color: "var(--dim)" }}>Loading profile…</p>;
  if (!data) return <p style={{ padding: 20, color: "var(--dim)" }}>Profile not found.</p>;
  const profile = data.profile;

  return (
    <div style={{ padding: "14px 14px 20px", maxWidth: 640, margin: "0 auto" }}>
      <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
        <Avatar user={profile} size={76} />
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 20, fontWeight: 800 }}>{profile.display_name}</span>
            <LevelBadge level={profile.level} />
          </div>
          <div style={{ color: "var(--dim)", fontSize: 14 }}>
            @{profile.username} · ID #{profile.id}
          </div>
          <div style={{ fontSize: 14, marginTop: 2 }}>🪙 {profile.coin_balance} coins</div>
        </div>
      </div>
      {profile.bio && <p style={{ margin: "12px 0 0", fontSize: 15 }}>{profile.bio}</p>}
      <div style={{ display: "flex", gap: 18, marginTop: 14, fontSize: 14 }}>
        <span>
          <strong>{profile.video_count}</strong> <span style={{ color: "var(--dim)" }}>Videos</span>
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
          {profile.avatar_url && (
            <button className="btn btn-danger" onClick={removeDp} disabled={dpBusy}>
              Remove DP
            </button>
          )}
          <button className="btn" onClick={onLogout}>
            Log out
          </button>
          <input ref={dpInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => pickDp(e.target.files?.[0])} />
        </div>
      ) : (
        <div style={{ marginTop: 16 }}>
          <button className={`btn ${profile.followed_by_me ? "" : "btn-primary"}`} onClick={handleFollow}>
            {profile.followed_by_me ? "Following" : "Follow"}
          </button>
        </div>
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
      {data.posts.length === 0 && <p style={{ color: "var(--dim)" }}>No videos yet.</p>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
        {data.posts.map((post) => (
          <div key={post.id} style={{ position: "relative", borderRadius: 10, overflow: "hidden", background: "#000", aspectRatio: "3/4" }}>
            {post.thumbnail_url ? (
              <img src={post.thumbnail_url} alt={post.title} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            ) : (
              <video src={post.video_url} preload="metadata" muted style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            )}
            <div style={{ position: "absolute", left: 6, bottom: 6, right: 6, color: "#fff", fontSize: 12, fontWeight: 600, textShadow: "0 1px 4px rgba(0,0,0,0.9)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              ▶ {post.title}
            </div>
            {isMe && (
              <button onClick={() => handleDelete(post)} style={{ position: "absolute", top: 6, right: 6, background: "rgba(0,0,0,0.65)", color: "#ff9a8a", border: "1px solid rgba(255,255,255,0.25)", borderRadius: 8, fontSize: 12, padding: "3px 7px" }}>
                Delete
              </button>
            )}
          </div>
        ))}
      </div>

      {isMe && data.referrals && (
        <>
          <h3 style={{ margin: "22px 0 10px" }}>My referrals ({data.referrals.length})</h3>
          {data.referrals.length === 0 && <p style={{ color: "var(--dim)" }}>Nobody has joined with your code yet. Share it from the Rewards tab!</p>}
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
    </div>
  );
}

// ---------- rewards: referrals + coins + leaderboards + admin ----------------------

function BoardRow({ row, metric }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 2px", borderBottom: "1px solid var(--border)" }}>
      <span style={{ width: 30, textAlign: "center", fontWeight: 800, fontSize: 15 }}>{row.rank <= 3 ? ["🥇", "🥈", "🥉"][row.rank - 1] : `#${row.rank}`}</span>
      <Avatar user={row} size={40} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {row.display_name} <LevelBadge level={row.level} />
          {row.is_me && <span className="chip" style={{ padding: "1px 7px", fontSize: 11 }}>You</span>}
        </div>
        <div style={{ color: "var(--dim)", fontSize: 13 }}>
          @{row.username} · ID #{row.id}
        </div>
      </div>
      <strong>{metric === "coins" ? `🪙 ${row.coin_balance}` : `👥 ${row.referral_count}`}</strong>
    </div>
  );
}

function AdminSection({ refreshMe }) {
  const [requests, setRequests] = useState([]);
  const [platformGiftCoins, setPlatformGiftCoins] = useState(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const res = await call("getAdminCoinRequests", {});
    if (res.ok) {
      setRequests(res.requests);
      if (typeof res.platform_gift_coins === "number") setPlatformGiftCoins(res.platform_gift_coins);
    }
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

  const pending = requests.filter((r) => r.status === "pending");
  const reviewed = requests.filter((r) => r.status !== "pending");

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
                  {r.pack_coins} coins · Rs.{r.price_pkr} · @{r.buyer.username} · TID {r.tid}
                </span>
                <strong style={{ color: r.status === "approved" ? "var(--accent)" : "var(--bad)" }}>{r.status}</strong>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function RewardsView({ me, refreshMe }) {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [board, setBoard] = useState("coins");
  const [claimCode, setClaimCode] = useState("");
  const [packIndex, setPackIndex] = useState(0);
  const [tid, setTid] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const waking = useWaking();

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
    const res = await call("requestCoins", { pack_index: packIndex, tid });
    setBusy(false);
    if (!res.ok) {
      setError(res.message || "Could not send the request.");
      return;
    }
    setNotice(res.message);
    setTid("");
    load();
  }

  if (!data && loadError) {
    return (
      <div style={{ padding: 20, textAlign: "center" }}>
        <p style={{ color: "var(--dim)" }}>Rewards could not load — the server may be waking up.</p>
        <button className="btn btn-primary" onClick={load}>
          Try again
        </button>
      </div>
    );
  }
  if (!data) return <p style={{ padding: 20, color: "var(--dim)" }}>{waking ? WAKING_TEXT : "Loading rewards…"}</p>;
  const selectedPack = data.packs[packIndex] || data.packs[0];

  return (
    <div style={{ padding: "14px 14px 20px", maxWidth: 640, margin: "0 auto" }}>
      <h2 style={{ margin: "2px 0 12px" }}>Rewards</h2>
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

      <div className="card" style={{ marginTop: 14 }}>
        <h3 style={{ margin: "0 0 4px" }}>🔗 Your referral code & invite link</h3>
        <p style={{ color: "var(--dim)", fontSize: 14, margin: "0 0 10px" }}>
          Share your code or your invite link — every friend who joins with it counts as your referral and climbs you up the Top Referrals board. Friends who open your link get the code applied automatically when they sign up. You have {data.referral_count} referral{data.referral_count === 1 ? "" : "s"} so far.
        </p>
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
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(104px, 1fr))", gap: 8 }}>
          {data.packs.map((pack, i) => (
            <button
              key={pack.coins}
              onClick={() => setPackIndex(i)}
              className="card"
              style={{ padding: 10, textAlign: "center", cursor: "pointer", borderColor: i === packIndex ? "var(--accent)" : "var(--border)", color: "var(--text)" }}
            >
              <div style={{ fontWeight: 900, fontSize: 17 }}>🪙 {pack.coins.toLocaleString()}</div>
              <div style={{ color: "var(--dim)", fontSize: 13 }}>Rs.{Number(pack.pricePkr ?? 0).toLocaleString()}</div>
            </button>
          ))}
        </div>
        <form onSubmit={buy} style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <input className="input" placeholder={`JazzCash TID for the Rs.${selectedPack.pricePkr} payment`} value={tid} onChange={(e) => setTid(e.target.value)} required />
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
                    🪙 {r.pack_coins} · Rs.{r.price_pkr} · TID {r.tid}
                  </span>
                  <strong style={{ color: r.status === "approved" ? "var(--accent)" : r.status === "rejected" ? "var(--bad)" : "var(--dim)" }}>{r.status}</strong>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

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

      {me?.is_admin && <AdminSection refreshMe={refreshMe} />}
    </div>
  );
}

// ---------- app shell ------------------------------------------------------------------

// Bottom navigation: 3 + center + 3, with Live as the prominent raised
// center button (TikTok-style) — it is the app's headline action.
const NAV = [
  { key: "feed", label: "Home", icon: "🏠" },
  { key: "watch", label: "Watch", icon: "▶️" },
  { key: "people", label: "People", icon: "👥" },
  { key: "live", label: "Live", icon: "🔴" },
  { key: "upload", label: "Upload", icon: "＋" },
  { key: "rewards", label: "Rewards", icon: "🏆" },
  { key: "profile", label: "Profile", icon: "👤" },
];

export function App() {
  const [me, setMe] = useState(null);
  const [booting, setBooting] = useState(true);
  const [bootFailed, setBootFailed] = useState(false);
  const [googleSetup, setGoogleSetup] = useState(false);
  const [tab, setTab] = useState("feed");
  const [profileUserId, setProfileUserId] = useState(null);
  const [feedKey, setFeedKey] = useState(0);
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

  function openProfile(userId) {
    setProfileUserId(userId ?? null);
    setTab("profile");
  }

  async function logout() {
    await call("logout", {});
    setToken("");
    setMe(null);
    setTab("feed");
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
          onAuthed={(user) => {
            setGoogleSetup(false);
            setMe(user);
            setTab("feed");
          }}
          onCancel={() => setGoogleSetup(false)}
        />
      );
    }
    return (
      <AuthView
        onAuthed={(user) => {
          setMe(user);
          setTab("feed");
        }}
      />
    );
  }

  return (
    <div style={{ height: "100dvh", display: "flex", flexDirection: "column", maxWidth: 860, margin: "0 auto" }}>
      <div style={{ flex: 1, minHeight: 0, overflowY: tab === "feed" ? "hidden" : "auto" }} className={tab === "feed" ? "" : "no-scrollbar"}>
        {tab === "feed" && <FeedView key={feedKey} me={me} onOpenProfile={openProfile} refreshMe={refreshMe} />}
        {tab === "watch" && <WatchView onOpenProfile={openProfile} />}
        {tab === "live" && <LiveView me={me} refreshMe={refreshMe} onOpenProfile={openProfile} />}
        {tab === "upload" && (
          <UploadView
            onPosted={() => {
              setFeedKey((k) => k + 1);
            }}
          />
        )}
        {tab === "people" && <PeopleView onOpenProfile={openProfile} refreshMe={refreshMe} />}
        {tab === "rewards" && <RewardsView me={me} refreshMe={refreshMe} />}
        {tab === "profile" && <ProfileView me={me} userId={profileUserId} onOpenProfile={openProfile} refreshMe={refreshMe} onLogout={logout} />}
      </div>
      <nav
        style={{
          display: "flex",
          borderTop: "1px solid var(--border)",
          background: "var(--surface)",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
      >
        {NAV.map((item) =>
          item.key === "live" ? (
            <button
              key={item.key}
              onClick={() => setTab("live")}
              aria-label="Live"
              style={{
                flex: 1,
                background: "none",
                border: "none",
                padding: "8px 2px 7px",
                color: tab === "live" ? "#ff7aa8" : "var(--dim)",
                fontSize: 11,
                fontWeight: 700,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 2,
              }}
            >
              <span
                style={{
                  width: 54,
                  height: 54,
                  borderRadius: "50%",
                  background: "#e0245e",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 25,
                  marginTop: -26,
                  border: `3px solid ${tab === "live" ? "var(--accent)" : "var(--surface)"}`,
                  boxShadow: "0 6px 18px rgba(224,36,94,0.5)",
                  flexShrink: 0,
                }}
              >
                🔴
              </span>
              {item.label}
            </button>
          ) : (
            <button
              key={item.key}
              onClick={() => {
                if (item.key === "profile") setProfileUserId(null);
                setTab(item.key);
              }}
              style={{
                flex: 1,
                background: "none",
                border: "none",
                padding: "8px 2px 7px",
                color: tab === item.key ? "var(--accent)" : "var(--dim)",
                fontSize: 11,
                fontWeight: 700,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 2,
              }}
            >
              <span style={{ fontSize: item.key === "upload" ? 24 : 20, lineHeight: 1 }}>{item.icon}</span>
              {item.label}
            </button>
          )
        )}
      </nav>
    </div>
  );
}
