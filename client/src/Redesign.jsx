// TikTok-style layout additions (2026-10-26 redesign) — kept in a
// separate module so the 3,800-line App.jsx stays diffable. These screens
// reuse the EXISTING backend actions (getWatch / getPeople /
// getNotifications / getConversations / updateSettings / deleteAccount /
// changePassword / getBlockedUsers) — nothing here is a placeholder.
// Colours: the ORIGINAL Zoomly palette (see theme.css); the spec's
// TikTok pink/cyan palette was explicitly rejected by the owner and is
// not used anywhere in this file.
import { useCallback, useEffect, useRef, useState } from "react";
import { call } from "./api";
import { Avatar, CommentsSheet, shareUrl, timeAgo } from "./App.jsx";

// ---------- persisted local preferences (theme / language / text size) ----
// Local-only by design: there is no push infrastructure and no server
// field for these, so they live in localStorage (zoomly_prefs) and are
// applied to <html> (data-theme / data-text / lang / dir) on load.
export const PREF_KEY = "zoomly_prefs";

export function getPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

export function applyPrefs() {
  const p = getPrefs();
  const theme = p.theme === "light" ? "light" : "dark";
  const language = p.language === "ur" ? "ur" : "en";
  try {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.text = p.largeText ? "large" : "";
    document.documentElement.lang = language;
    // Urdu is right-to-left; this flips document direction only when
    // Urdu is selected. App strings themselves are NOT translated yet
    // (see SettingsView note) — this is direction + locale metadata.
    document.documentElement.dir = language === "ur" ? "rtl" : "ltr";
  } catch {
    /* DOM unavailable (tests) */
  }
  return p;
}

export function savePrefs(patch) {
  const next = { ...getPrefs(), ...patch };
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable */
  }
  return applyPrefs();
}

// Applied at import time (App.jsx imports this module before rendering),
// so the first paint already uses the stored theme/language.
applyPrefs();

const RECENT_KEY = "zoomly_recent_searches";
function recentSearches() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]") || [];
  } catch {
    return [];
  }
}
function pushRecent(term) {
  const t = term.trim();
  if (!t) return;
  try {
    const next = [t, ...recentSearches().filter((x) => x !== t)].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

function extractHashtags(posts) {
  const counts = new Map();
  for (const p of posts || []) {
    const text = `${p.title || ""} ${p.description || ""}`;
    for (const m of text.match(/#[\p{L}\p{N}_]+/gu) || []) {
      counts.set(m.toLowerCase(), (counts.get(m.toLowerCase()) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
}

// ---------- Search -----------------------------------------------------------
// Real data only: videos via getWatch, creators via getPeople, hashtags
// computed from real video titles/descriptions, "sounds" = the audio of
// real videos (Zoomly has no separate sound library — each video's own
// audio is its sound, shown as "Original audio · @creator").
export function SearchView({ me, onOpenProfile }) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all"); // all | videos | creators | hashtags | sounds
  const [videos, setVideos] = useState([]);
  const [creators, setCreators] = useState([]);
  const [trending, setTrending] = useState([]);
  const [recent, setRecent] = useState(recentSearches());
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(null);
  const [commentPost, setCommentPost] = useState(null);

  const loadTrending = useCallback(async () => {
    const res = await call("getWatch", { limit: 30 });
    if (res.ok) setTrending(extractHashtags(res.posts));
  }, []);
  useEffect(() => {
    loadTrending();
  }, [loadTrending]);

  const runSearch = useCallback(async (q) => {
    const term = (q || "").trim();
    setLoading(true);
    const [vRes, pRes] = await Promise.all([
      call("getWatch", { query: term || undefined, limit: 30 }),
      call("getPeople", { query: term || undefined }),
    ]);
    if (vRes.ok) setVideos(vRes.posts);
    if (pRes.ok) setCreators(pRes.people);
    setLoading(false);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => runSearch(query), 250);
    return () => clearTimeout(t);
  }, [query, runSearch]);

  function submitSearch(term) {
    const t = (term ?? query).trim();
    if (!t) return;
    pushRecent(t);
    setRecent(recentSearches());
    setQuery(t);
    runSearch(t);
  }

  const q = query.trim().toLowerCase();
  const hashtagVideos = q ? videos.filter((v) => `${v.title} ${v.description}`.toLowerCase().includes(`#${q.replace(/^#/, "")}`)) : videos;
  const shownVideos = scope === "hashtags" ? hashtagVideos : videos;
  const shownCreators = scope === "all" || scope === "creators" ? creators : [];
  const showSounds = scope === "all" || scope === "sounds";

  return (
    <div style={{ padding: "14px 14px 20px", maxWidth: 720, margin: "0 auto" }}>
      <h2 style={{ margin: "2px 0 12px" }}>🔍 Search</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submitSearch();
        }}
        style={{ display: "flex", gap: 8 }}
      >
        <input className="input" placeholder="Search videos, creators, hashtags, sounds…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search" />
        <button className="btn btn-primary" type="submit">
          Search
        </button>
      </form>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12 }}>
        {[
          ["all", "All"],
          ["videos", "Videos"],
          ["creators", "Creators"],
          ["hashtags", "Hashtags"],
          ["sounds", "Sounds"],
        ].map(([key, label]) => (
          <button key={key} className="chip search-chip" onClick={() => setScope(key)} style={{ background: scope === key ? "var(--accent)" : undefined, color: scope === key ? "#131a02" : undefined, borderColor: scope === key ? "var(--accent)" : undefined }}>
            {label}
          </button>
        ))}
      </div>
      {trending.length > 0 && (
        <>
          <h3 style={{ margin: "18px 0 8px", fontSize: 15 }}>🔥 Trending hashtags</h3>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {trending.map(([tag, count]) => (
              <button key={tag} className="chip search-chip" onClick={() => submitSearch(tag)} title={`${count} videos`}>
                {tag} · {count}
              </button>
            ))}
          </div>
        </>
      )}
      {recent.length > 0 && !query && (
        <>
          <h3 style={{ margin: "18px 0 8px", fontSize: 15 }}>Recent searches</h3>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {recent.map((t) => (
              <button key={t} className="chip search-chip" onClick={() => submitSearch(t)}>
                🕘 {t}
              </button>
            ))}
            <button
              className="chip search-chip"
              onClick={() => {
                try {
                  localStorage.removeItem(RECENT_KEY);
                } catch {
                  /* ignore */
                }
                setRecent([]);
              }}
            >
              Clear
            </button>
          </div>
        </>
      )}
      {loading && <p style={{ color: "var(--dim)", marginTop: 14 }}>Loading…</p>}
      {!loading && query && shownVideos.length === 0 && shownCreators.length === 0 && <p style={{ color: "var(--dim)", marginTop: 14 }}>No results for “{query}”. Try another word or hashtag.</p>}
      {(scope === "all" || scope === "videos" || scope === "hashtags") && shownVideos.length > 0 && (
        <>
          <h3 style={{ margin: "18px 0 10px", fontSize: 15 }}>Videos</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
            {shownVideos.map((post) => (
              <button key={post.id} onClick={() => setPlaying(post)} style={{ position: "relative", borderRadius: 10, overflow: "hidden", background: "#000", aspectRatio: "3/4", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }} aria-label={`Play ${post.title}`}>
                {post.thumbnail_url ? (
                  <img src={post.thumbnail_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                ) : (
                  <video src={post.video_url} preload="metadata" muted style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                )}
                <span style={{ position: "absolute", left: 6, bottom: 6, right: 6, color: "#fff", fontSize: 12, fontWeight: 700, textShadow: "0 1px 4px rgba(0,0,0,0.9)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  ▶ {post.title}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
      {showSounds && shownVideos.length > 0 && (
        <>
          <h3 style={{ margin: "18px 0 10px", fontSize: 15 }}>🎵 Sounds (video audio)</h3>
          <div style={{ display: "grid", gap: 8 }}>
            {shownVideos.slice(0, 10).map((post) => (
              <button key={`sound-${post.id}`} onClick={() => setPlaying(post)} className="card" style={{ display: "flex", alignItems: "center", gap: 10, padding: 10, textAlign: "left", color: "var(--text)", cursor: "pointer" }}>
                <span style={{ fontSize: 24 }}>💿</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <strong style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Original audio · @{post.author?.username}</strong>
                  <span style={{ color: "var(--dim)", fontSize: 13, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{post.title}</span>
                </span>
                <span style={{ color: "var(--dim)", fontSize: 13 }}>▶ Play</span>
              </button>
            ))}
          </div>
        </>
      )}
      {shownCreators.length > 0 && (
        <>
          <h3 style={{ margin: "18px 0 10px", fontSize: 15 }}>Creators</h3>
          <div style={{ display: "grid", gap: 8 }}>
            {shownCreators.map((person) => (
              <button key={person.id} onClick={() => onOpenProfile(person.id)} className="card" style={{ display: "flex", alignItems: "center", gap: 10, padding: 10, textAlign: "left", color: "var(--text)", cursor: "pointer" }}>
                <Avatar user={person} size={44} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <strong>{person.display_name}</strong>
                  <span style={{ display: "block", color: "var(--dim)", fontSize: 13 }}>@{person.username} · {person.follower_count} followers</span>
                </span>
                <span style={{ color: "var(--dim)", fontSize: 13 }}>View →</span>
              </button>
            ))}
          </div>
        </>
      )}
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
          <video src={playing.video_url} style={{ flex: 1, width: "100%", minHeight: 0, background: "#000" }} controls autoPlay loop playsInline />
          <div style={{ padding: "12px 16px calc(14px + env(safe-area-inset-bottom))", color: "#fff" }}>
            <strong>{playing.title}</strong>
            <div style={{ fontSize: 13, color: "#ccc", marginTop: 2 }}>🎵 Original audio · @{playing.author?.username} · ♥ {playing.like_count} · 💬 {playing.comment_count}</div>
            <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
              <button
                className="btn"
                onClick={async () => {
                  const res = await call("toggleLike", { post_id: playing.id });
                  if (res.ok) setPlaying((cur) => (cur ? { ...cur, liked_by_me: res.liked, like_count: res.like_count } : cur));
                }}
                style={{ color: playing.liked_by_me ? "var(--accent)" : "var(--text)" }}
              >
                ♥ {playing.like_count}
              </button>
              <button className="btn" onClick={() => setCommentPost(playing)}>
                💬 {playing.comment_count} Comments
              </button>
            </div>
          </div>
        </div>
      )}
      {commentPost && <CommentsSheet post={commentPost} onClose={() => setCommentPost(null)} onAdded={() => setPlaying((cur) => (cur ? { ...cur, comment_count: cur.comment_count + 1 } : cur))} />}
    </div>
  );
}

// ---------- Inbox --------------------------------------------------------------
// Two real tabs: Activity (getNotifications, unread dot = unread rows) and
// Messages (getConversations, unread counts per thread). Opening a thread
// uses the existing ChatScreen via onOpenChat. No push notifications:
// Zoomly has no push infrastructure — notifications are in-app only.
export function InboxView({ me, onOpenChat, onGoLive, refreshMe }) {
  const [sub, setSub] = useState("activity");
  const [items, setItems] = useState(null);
  const [convs, setConvs] = useState(null);

  useEffect(() => {
    if (sub !== "activity") return;
    (async () => {
      const res = await call("getNotifications", {});
      if (res.ok) {
        setItems(res.notifications);
        await call("markNotificationsRead", {});
        refreshMe?.();
      } else setItems([]);
    })();
  }, [sub, refreshMe]);

  useEffect(() => {
    if (sub !== "messages") return;
    (async () => {
      const res = await call("getConversations", {});
      if (res.ok) setConvs(res.conversations);
      else setConvs([]);
    })();
  }, [sub]);

  const unreadNotifs = (items || []).filter((n) => !n.read).length;
  return (
    <div style={{ padding: "14px 14px 20px", maxWidth: 640, margin: "0 auto" }}>
      <h2 style={{ margin: "2px 0 12px" }}>✉️ Inbox</h2>
      <div style={{ display: "flex", gap: 6 }}>
        <button className={`tab-btn ${sub === "activity" ? "active" : ""}`} onClick={() => setSub("activity")}>
          Activity {unreadNotifs > 0 ? `(${unreadNotifs} new)` : ""}
        </button>
        <button className={`tab-btn ${sub === "messages" ? "active" : ""}`} onClick={() => setSub("messages")}>
          Messages {(me?.unread_messages ?? 0) > 0 ? `(${me.unread_messages})` : ""}
        </button>
      </div>
      {sub === "activity" && (
        <div style={{ marginTop: 12 }}>
          {items === null && <p style={{ color: "var(--dim)" }}>Loading…</p>}
          {items !== null && items.length === 0 && <p style={{ color: "var(--dim)" }}>No notifications yet — likes, comments, follows, gifts and owner decisions will show up here.</p>}
          {(items || []).map((n) => (
            <div
              key={n.id}
              onClick={() => {
                if (n.live_session_id) onGoLive?.();
              }}
              style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 8px", borderBottom: "1px solid var(--border)", background: n.read ? "transparent" : "var(--surface-2)", borderRadius: 10, cursor: n.live_session_id ? "pointer" : "default" }}
            >
              {n.actor ? <Avatar user={n.actor} size={38} /> : <div style={{ width: 38, height: 38, borderRadius: "50%", background: "var(--surface)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17, flexShrink: 0 }}>🔔</div>}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14.5 }}>{n.text}</div>
                <div style={{ color: "var(--dim)", fontSize: 12.5, marginTop: 2 }}>
                  {timeAgo(n.created_at)}
                  {!n.read ? " · new" : ""}
                </div>
              </div>
              {!n.read && <span style={{ width: 9, height: 9, borderRadius: "50%", background: "var(--accent)", marginTop: 6, flexShrink: 0 }} />}
            </div>
          ))}
        </div>
      )}
      {sub === "messages" && (
        <div style={{ marginTop: 12 }}>
          {convs === null && <p style={{ color: "var(--dim)" }}>Loading…</p>}
          {convs !== null && convs.length === 0 && <p style={{ color: "var(--dim)" }}>Abhi koi chat nahi. Kisi ki profile ya People list se ✉️ Message dabao.</p>}
          {(convs || []).map((c) => (
            <button key={c.user.id} onClick={() => onOpenChat(c.user)} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", background: "none", border: "none", padding: "9px 8px", borderRadius: 12, cursor: "pointer", color: "var(--text)" }}>
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
              {c.unread > 0 && <span style={{ background: "var(--accent)", color: "#131a02", borderRadius: 999, minWidth: 20, height: 20, padding: "0 6px", fontSize: 12, fontWeight: 800, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{c.unread}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Settings & Privacy ---------------------------------------------------
// Only toggles that REALLY persist are wired as toggles:
//  - server: private account, comment permission, message permission
//    (updateSettings), blocked list (getBlockedUsers/unblockUser),
//    password (changePassword), logout, account deletion (deleteAccount)
//  - local: theme, language/direction, large text (zoomly_prefs)
// Notification "preferences" have no server push to gate, so the screen
// says so plainly instead of offering a fake toggle. Account recovery:
// no email reset exists (password accounts have no verified email) —
// recovery is the existing owner-assisted temporary password, stated here.
function Toggle({ checked, onChange, label }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="toggle" onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

export function SettingsView({ me, onClose, onLogout, refreshMe }) {
  const prefs = getPrefs();
  const [theme, setTheme] = useState(prefs.theme === "light" ? "light" : "dark");
  const [language, setLanguage] = useState(prefs.language === "ur" ? "ur" : "en");
  const [largeText, setLargeText] = useState(Boolean(prefs.largeText));
  const [priv, setPriv] = useState(Boolean(me?.private_account));
  const [commentPerm, setCommentPerm] = useState(me?.comment_permission || "everyone");
  const [messagePerm, setMessagePerm] = useState(me?.message_permission || "everyone");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [blocked, setBlocked] = useState([]);
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [deleteText, setDeleteText] = useState("");

  useEffect(() => {
    (async () => {
      const res = await call("getBlockedUsers", {});
      if (res.ok) setBlocked(res.blocked);
    })();
  }, []);

  async function saveServerSettings(patch) {
    setError("");
    setNotice("");
    const res = await call("updateSettings", patch);
    if (!res.ok) {
      setError(res.message || "Settings save failed.");
      return;
    }
    setNotice("Settings saved ✓");
    refreshMe?.();
  }

  function applyLocal(next) {
    savePrefs(next);
    if (next.theme !== undefined) setTheme(next.theme);
    if (next.language !== undefined) setLanguage(next.language);
    if (next.largeText !== undefined) setLargeText(next.largeText);
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--bg)", zIndex: 70, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
        <strong style={{ fontSize: 18, flex: 1 }}>⚙️ Settings &amp; Privacy</strong>
        <button className="btn btn-small" onClick={onClose}>
          ✕ Close
        </button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "10px 14px calc(20px + env(safe-area-inset-bottom))", maxWidth: 640, width: "100%", margin: "0 auto" }}>
        {error && <div style={{ background: "rgba(255,122,102,0.12)", border: "1px solid var(--bad)", color: "var(--bad)", borderRadius: 12, padding: "9px 12px", fontSize: 14, margin: "10px 0" }}>{error}</div>}
        {notice && <div style={{ background: "rgba(163,230,53,0.12)", border: "1px solid var(--accent)", color: "var(--accent)", borderRadius: 12, padding: "9px 12px", fontSize: 14, margin: "10px 0" }}>{notice}</div>}

        <h3>Account</h3>
        <p style={{ color: "var(--dim)", fontSize: 14 }}>
          @{me?.username} · ID #{me?.id}
          <br />
          {me?.display_name} · 🪙 {me?.coin_balance ?? 0} coins{me?.level ? ` · Level: ${me.level}` : ""}
          <br />
          {me?.email ? `Email: ${me.email}` : "No email on file (password account)."}
        </p>

        <h3>Appearance</h3>
        <div className="settings-row">
          <span>
            <strong>Theme</strong>
            <span style={{ display: "block", color: "var(--dim)", fontSize: 13 }}>Dark (default) or Light — saved on this device.</span>
          </span>
          <select className="input" style={{ width: "auto" }} value={theme} onChange={(e) => applyLocal({ theme: e.target.value })} aria-label="Theme">
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </div>
        <div className="settings-row">
          <span>
            <strong>Language</strong>
            <span style={{ display: "block", color: "var(--dim)", fontSize: 13 }}>Urdu switches the app direction to right-to-left. App text is not fully translated yet — this setting changes direction and locale, not every string.</span>
          </span>
          <select className="input" style={{ width: "auto" }} value={language} onChange={(e) => applyLocal({ language: e.target.value })} aria-label="Language">
            <option value="en">English</option>
            <option value="ur">Urdu (RTL)</option>
          </select>
        </div>
        <div className="settings-row">
          <span>
            <strong>Large text</strong>
            <span style={{ display: "block", color: "var(--dim)", fontSize: 13 }}>Accessibility: bigger base text on this device.</span>
          </span>
          <Toggle checked={largeText} onChange={(v) => applyLocal({ largeText: v })} label="Large text" />
        </div>

        <h3>Privacy</h3>
        <div className="settings-row">
          <span>
            <strong>Private account</strong>
            <span style={{ display: "block", color: "var(--dim)", fontSize: 13 }}>On: your videos only show to followers (and you) in For You, Watch and Search. Following still works immediately — there is no follow-request flow yet.</span>
          </span>
          <Toggle
            checked={priv}
            onChange={(v) => {
              setPriv(v);
              saveServerSettings({ private_account: v });
            }}
            label="Private account"
          />
        </div>
        <div className="settings-row">
          <span>
            <strong>Who can comment</strong>
          </span>
          <select
            className="input"
            style={{ width: "auto" }}
            value={commentPerm}
            onChange={(e) => {
              setCommentPerm(e.target.value);
              saveServerSettings({ comment_permission: e.target.value });
            }}
            aria-label="Who can comment"
          >
            <option value="everyone">Everyone</option>
            <option value="followers">Followers only</option>
            <option value="nobody">Nobody</option>
          </select>
        </div>
        <div className="settings-row">
          <span>
            <strong>Who can message you</strong>
          </span>
          <select
            className="input"
            style={{ width: "auto" }}
            value={messagePerm}
            onChange={(e) => {
              setMessagePerm(e.target.value);
              saveServerSettings({ message_permission: e.target.value });
            }}
            aria-label="Who can message you"
          >
            <option value="everyone">Everyone</option>
            <option value="followers">Followers only</option>
            <option value="nobody">Nobody</option>
          </select>
        </div>

        <h3>Blocked accounts ({blocked.length})</h3>
        {blocked.length === 0 && <p style={{ color: "var(--dim)", fontSize: 14 }}>No blocked accounts.</p>}
        {blocked.map((u) => (
          <div key={u.id} className="card" style={{ display: "flex", alignItems: "center", gap: 10, padding: 10, marginBottom: 8 }}>
            <Avatar user={u} size={36} />
            <span style={{ flex: 1 }}>
              <strong>{u.display_name}</strong>
              <span style={{ display: "block", color: "var(--dim)", fontSize: 13 }}>@{u.username}</span>
            </span>
            <button
              className="btn btn-small"
              onClick={async () => {
                const res = await call("unblockUser", { user_id: u.id });
                if (res.ok) setBlocked((prev) => prev.filter((x) => x.id !== u.id));
              }}
            >
              Unblock
            </button>
          </div>
        ))}

        <h3>Login &amp; security</h3>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setError("");
            setNotice("");
            if (pw.next !== pw.confirm) {
              setError("New password aur confirm password match nahi karte.");
              return;
            }
            const res = await call("changePassword", { current_password: pw.current, new_password: pw.next });
            if (!res.ok) {
              setError(res.message || "Password change failed.");
              return;
            }
            setNotice(res.message);
            setPw({ current: "", next: "", confirm: "" });
          }}
          style={{ display: "grid", gap: 8 }}
        >
          <input className="input" type="password" placeholder="Current password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required />
          <input className="input" type="password" placeholder="New password (min 6 characters)" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} required minLength={6} />
          <input className="input" type="password" placeholder="Confirm new password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} required minLength={6} />
          <button className="btn btn-primary btn-small" type="submit" style={{ justifySelf: "start" }}>
            Change password
          </button>
        </form>
        <p style={{ color: "var(--dim)", fontSize: 13 }}>Account recovery: no email reset exists (password accounts have no verified email). If you forget your password, ask the owner for a temporary password, then change it here. Google users sign in with Google.</p>

        <h3>Notifications</h3>
        <p style={{ color: "var(--dim)", fontSize: 14 }}>Push notifications are not available — Zoomly has no push infrastructure. Notifications are in-app only and appear in the Inbox tab (unread dot included). No toggle is offered here because there is nothing server-side to toggle.</p>

        <h3>Data usage &amp; cache</h3>
        <p style={{ color: "var(--dim)", fontSize: 14 }}>Videos stream from Cloudinary; the app stores no video files on your device. Local data is only small preferences (theme, language, recent searches, remembered tab).</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            className="btn btn-small"
            onClick={() => {
              try {
                localStorage.removeItem(RECENT_KEY);
                localStorage.removeItem("zoomly_tab");
              } catch {
                /* ignore */
              }
              setNotice("Recent searches + remembered tab cleared.");
            }}
          >
            Clear recent searches
          </button>
          <button
            className="btn btn-small btn-danger"
            onClick={() => {
              if (!window.confirm("Clear ALL local Zoomly data on this device (theme, language, saved tab, session)? You will be signed out on this device.")) return;
              try {
                localStorage.clear();
                sessionStorage.clear();
              } catch {
                /* ignore */
              }
              window.location.reload();
            }}
          >
            Clear all local data
          </button>
        </div>

        <h3>Help &amp; legal</h3>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <a className="btn btn-small" href="/privacy" target="_blank" rel="noreferrer">
            Privacy Policy
          </a>
          <a className="btn btn-small" href="/terms" target="_blank" rel="noreferrer">
            Terms of Service
          </a>
        </div>
        <p style={{ color: "var(--dim)", fontSize: 13 }}>Support: message the owner from inside the app (their profile is marked 👑 Official Owner), or use Report on any video/comment/user for moderation.</p>

        <h3>Account actions</h3>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="btn" onClick={onLogout}>
            Log out
          </button>
        </div>
        <div style={{ marginTop: 14 }}>
          <p style={{ color: "var(--dim)", fontSize: 13 }}>Delete account is permanent: your videos, comments, likes, follows, messages and coin history are removed. Type DELETE below to confirm.</p>
          <div style={{ display: "flex", gap: 8 }}>
            <input className="input" placeholder="Type DELETE" value={deleteText} onChange={(e) => setDeleteText(e.target.value)} style={{ maxWidth: 200 }} />
            <button
              className="btn btn-danger"
              disabled={deleteText !== "DELETE"}
              onClick={async () => {
                if (!window.confirm("Pakka? Ye account hamesha ke liye delete ho jayega.")) return;
                const res = await call("deleteAccount", { confirm: "DELETE" });
                if (!res.ok) {
                  setError(res.message || "Account deletion failed.");
                  return;
                }
                onLogout();
              }}
            >
              Delete account
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
