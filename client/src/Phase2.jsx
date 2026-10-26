// Phase 2–3 screens (2026-10-26): ranked feed, trending, hashtags, sounds,
// creator dashboard, playlists, saved, mute/hide, interests, duet view,
// editor drafts, appeals, admin overview, monetization dashboard, guidelines.
// Every screen uses REAL backend actions (see server/actions.mjs). Nothing
// here is a demo: where a spec feature cannot exist in this web client,
// the screen says so in plain text instead of showing a fake button.
// Colours: the ORIGINAL Zoomly palette only — no TikTok pink/cyan anywhere.
import { useCallback, useEffect, useRef, useState } from "react";
import { call } from "./api";
import { Avatar, timeAgo } from "./App.jsx";
import { getPrefs, savePrefs } from "./Redesign.jsx";

function Card({ children, style }) {
  return <div className="card" style={{ padding: 12, display: "grid", gap: 8, ...style }}>{children}</div>;
}
function Btn({ children, ...props }) {
  return <button className="btn" {...props}>{children}</button>;
}
function Primary({ children, ...props }) {
  return <button className="btn btn-primary" {...props}>{children}</button>;
}
function Note({ children }) {
  return <p style={{ color: "var(--dim)", fontSize: 13, margin: 0 }}>{children}</p>;
}
function Err({ text }) {
  return text ? <p style={{ color: "var(--bad)", fontSize: 14, margin: 0 }}>{text}</p> : null;
}
function PostRow({ post, onPlay, onSave, saved }) {
  return (
    <Card>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        {post.thumbnail_url ? <img src={post.thumbnail_url} alt="" style={{ width: 96, height: 54, objectFit: "cover", borderRadius: 8, background: "#000" }} /> : <div style={{ width: 96, height: 54, borderRadius: 8, background: "#000", display: "flex", alignItems: "center", justifyContent: "center" }}>▶</div>}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{post.title}</div>
          <div style={{ color: "var(--dim)", fontSize: 13 }}>@{post.author?.username} · ♥ {post.like_count} · 💬 {post.comment_count} · 👁 {post.view_count}{post.share_count ? ` · 🔗 ${post.share_count}` : ""}{post.rank_score ? ` · score ${post.rank_score}` : ""}</div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {onPlay && <Btn onClick={() => onPlay(post)}>▶ Play</Btn>}
        {onSave && <Btn onClick={() => onSave(post)}>{saved ? "Saved ✓" : "💾 Save"}</Btn>}
        <Btn onClick={async () => { const r = await call("hideNotInterested", { post_id: post.id }); if (r.ok) onSave?.(post, true); }}>🙈 Not interested</Btn>
      </div>
    </Card>
  );
}
function Player({ post, onClose }) {
  const ref = useRef(null);
  const [progress, setProgress] = useState(0);
  const sent = useRef(new Set());
  function ev(name, v) {
    if (sent.current.has(name)) return; sent.current.add(name);
    call("recordWatchEvent", { post_id: post.id, event: name, duration_ms: Math.round((ref.current?.duration || 0) * 1000), watch_ms: Math.round((ref.current?.currentTime || 0) * 1000) }).catch(() => {});
  }
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.94)", zIndex: 95, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", justifyContent: "space-between", padding: "12px 14px", color: "#fff", alignItems: "center" }}>
        <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{post.title}</strong>
        <Btn onClick={onClose}>✕ Close</Btn>
      </div>
      <video ref={ref} src={post.video_url} style={{ flex: 1, width: "100%", minHeight: 0, background: "#000", objectFit: "contain" }} controls autoPlay loop playsInline
        onPlay={() => ev("started")}
        onTimeUpdate={(e) => { const v = e.target; if (v.duration) setProgress(v.currentTime / v.duration); if (v.duration && v.currentTime / v.duration > 0.9) ev("completed"); }}
        onEnded={() => ev("replay")} />
      <div style={{ height: 4, background: "rgba(255,255,255,0.2)" }}><div style={{ height: 4, width: `${Math.round(progress * 100)}%`, background: "var(--accent)" }} /></div>
      <div style={{ padding: "10px 14px calc(12px + env(safe-area-inset-bottom))", color: "#fff", display: "flex", gap: 8, alignItems: "center" }}>
        <span>@{post.author?.username}</span>
        <span style={{ color: "var(--dim)", fontSize: 13 }}>Single video source (Cloudinary) — no quality ladder exists, so no quality selector is shown.</span>
      </div>
    </div>
  );
}

function useSavedIds() {
  const [ids, setIds] = useState(new Set());
  useEffect(() => { (async () => { const r = await call("getSavedPosts", {}); if (r.ok) setIds(new Set(r.posts.map((p) => p.id))); })(); }, []);
  return [ids, setIds];
}

export function Phase2Hub({ me, onClose, onGoLive, onGoUpload, initialScreen, initialTag }) {
  const [screen, setScreen] = useState(initialScreen || "menu");
  const [tag, setTag] = useState(initialTag || "");
  const [playing, setPlaying] = useState(null);
  const [savedIds, setSavedIds] = useState(new Set());
  useEffect(() => { (async () => { const r = await call("getSavedPosts", {}); if (r.ok) setSavedIds(new Set(r.posts.map((p) => p.id))); })(); }, []);
  async function toggleSavePost(post, hideOnly) {
    if (hideOnly) return;
    const r = await call("toggleSave", { post_id: post.id });
    if (r.ok) setSavedIds((prev) => { const n = new Set(prev); if (r.saved) n.add(post.id); else n.delete(post.id); return n; });
  }
  const menu = [
    ["ranked", "⭐ Ranked For You feed"],
    ["trending", "🔥 Trending"],
    ["hashtag", "# Hashtag page"],
    ["sounds", "🎵 Sounds (original audio)"],
    ["creator", "📊 Creator dashboard"],
    ["playlists", "📁 Playlists"],
    ["saved", "💾 Saved videos"],
    ["discover", "👥 Discover creators"],
    ["interests", "🎯 Interests & onboarding"],
    ["editor", "✂️ Editor & drafts"],
    ["duet", "👥 Duet view"],
    ["livehub", "🔴 Live hub"],
    ["monetization", "💰 Monetization dashboard"],
    ["mute", "🔇 Mute, hidden & keywords"],
    ["appeals", "⚖️ Appeals & notices"],
    ["admin", "🛡️ Admin overview"],
    ["data", "📦 My data & metrics"],
    ["guidelines", "📜 Guidelines, ads & legal"],
  ];
  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--bg)", zIndex: 80, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
        {screen !== "menu" && <Btn onClick={() => setScreen("menu")}>← Back</Btn>}
        <strong style={{ fontSize: 18, flex: 1 }}>Creator &amp; advanced tools</strong>
        <Btn onClick={onClose}>✕ Close</Btn>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px calc(20px + env(safe-area-inset-bottom))", maxWidth: 720, width: "100%", margin: "0 auto", display: "grid", gap: 12, alignContent: "start" }}>
        {screen === "menu" && (<>
          <Note>All of these use real Zoomly data. Where the web client cannot do something (native trimming, licensed music, push notifications, native background upload), the screen says so instead of faking it.</Note>
          {menu.filter(([k]) => k !== "admin" || me?.is_admin).map(([k, label]) => <Btn key={k} onClick={() => setScreen(k)} style={{ textAlign: "left", padding: "12px 14px", fontSize: 16 }}>{label}</Btn>)}
        </>)}
        {screen === "ranked" && <RankedScreen onPlay={setPlaying} onSave={toggleSavePost} savedIds={savedIds} />}
        {screen === "trending" && <TrendingScreen onPlay={setPlaying} onSave={toggleSavePost} savedIds={savedIds} />}
        {screen === "hashtag" && <HashtagScreen initialTag={tag} onPlay={setPlaying} onSave={toggleSavePost} savedIds={savedIds} />}
        {screen === "sounds" && <SoundsScreen onPlay={setPlaying} />}
        {screen === "creator" && <CreatorScreen me={me} />}
        {screen === "playlists" && <PlaylistsScreen onPlay={setPlaying} />}
        {screen === "saved" && <SavedScreen onPlay={setPlaying} />}
        {screen === "discover" && <DiscoverScreen />}
        {screen === "interests" && <InterestsScreen />}
        {screen === "editor" && <EditorScreen onGoUpload={onGoUpload} />}
        {screen === "duet" && <DuetScreen onPlay={setPlaying} />}
        {screen === "livehub" && <LiveHubScreen onGoLive={onGoLive} />}
        {screen === "monetization" && <MonetizationScreen />}
        {screen === "mute" && <MuteScreen />}
        {screen === "appeals" && <AppealsScreen />}
        {screen === "admin" && me?.is_admin && <AdminScreen />}
        {screen === "data" && <DataScreen />}
        {screen === "guidelines" && <GuidelinesScreen />}
      </div>
      {playing && <Player post={playing} onClose={() => setPlaying(null)} />}
    </div>
  );
}

function RankedScreen({ onPlay, onSave, savedIds }) {
  const [stream, setStream] = useState("foryou");
  const [chrono, setChrono] = useState(false);
  const [posts, setPosts] = useState([]);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const load = useCallback(async (reset) => {
    setLoading(true); setErr("");
    const off = reset ? 0 : offset;
    const res = await call("getRankedFeed", { stream, limit: 20, offset: off, chronological: chrono, exclude_ids: reset ? [] : posts.map((p) => p.id) });
    setLoading(false);
    if (!res.ok) { setErr(res.message || "Could not load ranked feed."); return; }
    setPosts((prev) => reset ? res.posts : [...prev, ...res.posts.filter((p) => !prev.some((x) => x.id === p.id))]);
    setOffset(off + (res.posts?.length ?? 0));
  }, [stream, chrono, offset, posts]);
  useEffect(() => { load(true); }, [stream, chrono]);
  return (<>
    <h3 style={{ margin: 0 }}>Ranked For You</h3>
    <Note>Ranking runs on the server from real signals: views, likes, comments, shares, completions, replays, skips, recency, hashtag affinity from videos you watched, your interests, and followed creators. Hidden, muted, blocked and private-account videos are excluded. Chronological Following is a separate option below.</Note>
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      <Btn onClick={() => setStream("foryou")} style={stream === "foryou" ? { borderColor: "var(--accent)" } : {}}>For You (ranked)</Btn>
      <Btn onClick={() => setStream("following")} style={stream === "following" ? { borderColor: "var(--accent)" } : {}}>Following</Btn>
      <Btn onClick={() => setChrono((v) => !v)}>{chrono ? "Chronological: ON (newest first)" : "Chronological: OFF"}</Btn>
      <Btn onClick={() => load(true)}>↻ Refresh feed</Btn>
    </div>
    <Err text={err} />
    {loading && posts.length === 0 && <Note>Loading…</Note>}
    {posts.length === 0 && !loading && <Note>No videos here yet.</Note>}
    {posts.map((p) => <PostRow key={p.id} post={p} onPlay={onPlay} onSave={onSave} saved={savedIds.has(p.id)} />)}
    {posts.length > 0 && <Primary onClick={() => load(false)} disabled={loading}>{loading ? "Loading…" : "Load more (pagination)"}</Primary>}
  </>);
}

function TrendingScreen({ onPlay, onSave, savedIds }) {
  const [posts, setPosts] = useState([]); const [loading, setLoading] = useState(true); const [err, setErr] = useState("");
  useEffect(() => { (async () => { const r = await call("getTrending", { limit: 30 }); setLoading(false); if (r.ok) setPosts(r.posts); else setErr(r.message); })(); }, []);
  return (<>
    <h3 style={{ margin: 0 }}>🔥 Trending</h3>
    <Note>Real counts only: views, likes, comments, shares and completions, weighted by freshness. If a category has no real data, this screen shows an empty state — never sample data.</Note>
    <Err text={err} />{loading && <Note>Loading…</Note>}
    {posts.length === 0 && !loading && <Note>No trending videos yet.</Note>}
    {posts.map((p) => <PostRow key={p.id} post={p} onPlay={onPlay} onSave={onSave} saved={savedIds.has(p.id)} />)}
  </>);
}

function HashtagScreen({ initialTag, onPlay, onSave, savedIds }) {
  const [tag, setTag] = useState(initialTag || "");
  const [posts, setPosts] = useState([]); const [err, setErr] = useState(""); const [searched, setSearched] = useState(false);
  async function search(e) { e?.preventDefault(); const t = tag.trim(); if (!t) return; const r = await call("getByHashtag", { tag: t }); setSearched(true); if (r.ok) setPosts(r.posts); else setErr(r.message); }
  useEffect(() => { if (initialTag) search(); }, [initialTag]);
  const related = [...new Set(posts.flatMap((p) => `${p.title} ${p.description}`.match(/#[\p{L}\p{N}_]+/gu) || []).map((x) => x.toLowerCase()))].filter((x) => x !== `#${tag.replace(/^#/, "").toLowerCase()}`).slice(0, 8);
  const totalViews = posts.reduce((s, p) => s + (p.view_count ?? 0), 0);
  return (<>
    <h3 style={{ margin: 0 }}># Hashtag page</h3>
    <form onSubmit={search} style={{ display: "flex", gap: 6 }}>
      <input className="input" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="#fyp" aria-label="Hashtag" style={{ flex: 1 }} />
      <Primary type="submit">Search</Primary>
    </form>
    {searched && posts.length > 0 && <Card><strong>#{tag.replace(/^#/, "")}</strong> — {posts.length} videos on this page · {totalViews} total views (real counts). This is a real hashtag page, not a manufactured challenge.</Card>}
    {related.length > 0 && <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{related.map((r) => <Btn key={r} onClick={() => { setTag(r); setTimeout(() => search(), 0); }}>{r}</Btn>)}</div>}
    <Err text={err} />
    {searched && posts.length === 0 && <Note>No videos with this hashtag yet.</Note>}
    {posts.map((p) => <PostRow key={p.id} post={p} onPlay={onPlay} onSave={onSave} saved={savedIds.has(p.id)} />)}
    <Note>Hashtags are validated on publish (they come from real titles/descriptions). No fake challenges are listed: a “challenge” here is just a hashtag with real videos behind it.</Note>
  </>);
}

function SoundsScreen({ onPlay }) {
  const [sounds, setSounds] = useState([]); const [videos, setVideos] = useState(null); const [err, setErr] = useState("");
  useEffect(() => { (async () => { const r = await call("getSounds", {}); if (r.ok) setSounds(r.sounds); else setErr(r.message); })(); }, []);
  async function openSound(s) { const r = await call("getSoundVideos", { user_id: s.creator.id }); if (r.ok) setVideos({ creator: s.creator, posts: r.posts }); }
  return (<>
    <h3 style={{ margin: 0 }}>🎵 Sounds</h3>
    <Note>Original audio only — Zoomly has no licensed music catalogue. Each sound is a creator's own video audio, attributed to that creator. Licensed music is not available and is not claimed.</Note>
    <Err text={err} />
    {!videos && sounds.map((s) => <Card key={s.creator.id}><strong>Original audio · @{s.creator.username}</strong><span style={{ color: "var(--dim)", fontSize: 13 }}>{s.creator.display_name} · {s.video_count} videos</span><Btn onClick={() => openSound(s)}>Videos using this sound →</Btn></Card>)}
    {videos && (<>
      <Btn onClick={() => setVideos(null)}>← All sounds</Btn>
      <h4>Original audio · @{videos.creator.username}</h4>
      {videos.posts.map((p) => <PostRow key={p.id} post={p} onPlay={onPlay} />)}
      <Card><strong>Use this sound</strong><Note>The upload flow records your own video's audio. To credit this creator, add “Sound: Original audio · @{videos.creator.username}” to your caption when you publish — there is no automatic sound-attach in the web upload flow, and this screen does not pretend otherwise.</Note></Card>
    </>)}
  </>);
}

function CreatorScreen({ me }) {
  const [data, setData] = useState(null); const [err, setErr] = useState(""); const [csvNote, setCsvNote] = useState("");
  useEffect(() => { (async () => { const r = await call("getCreatorAnalytics", {}); if (r.ok) setData(r.analytics); else setErr(r.message); })(); }, []);
  function downloadCsv() {
    if (!data) return;
    const rows = [["id", "title", "views", "likes", "comments", "shares", "completions", "watch_seconds"], ...data.per_video.map((v) => [v.id, `"${String(v.title).replace(/"/g, '""')}"`, v.views, v.likes, v.comments, v.shares, v.completions, v.watch_seconds])];
    const blob = new Blob([rows.map((r) => r.join(",")).join("\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "zoomly-creator-stats.csv"; a.click(); setCsvNote("CSV downloaded — your own video stats only.");
  }
  async function setInteraction(post, patch) { const r = await call("setVideoInteraction", { post_id: post.id, ...patch }); if (r.ok) setData((d) => ({ ...d, per_video: d.per_video.map((v) => v.id === post.id ? { ...v, ...patch } : v) })); }
  if (err) return <Err text={err} />;
  if (!data) return <Note>Loading creator dashboard…</Note>;
  return (<>
    <h3 style={{ margin: 0 }}>📊 Creator dashboard</h3>
    <Card><strong>Totals (real data)</strong><span>Videos: {data.totals.videos} · Views: {data.totals.views} · Likes: {data.totals.likes} · Comments: {data.totals.comments} · Shares: {data.totals.shares} · Watch: {Math.round(data.totals.watch_seconds)}s · Followers: {data.totals.followers}</span><span>Gift coins (gross): {data.totals.gift_coins_gross} · Creator credited to balance: {data.totals.gift_coins_creator_credited} (70% rule, milli-coin carry — the difference is pending fractions, not lost money).</span></Card>
    <Card><strong>Monetization eligibility</strong><span>Age 18+: {data.monetization.criteria.age.met ? "✓" : "✗"} ({data.monetization.criteria.age.current ?? "no application yet"}) · Followers {data.monetization.criteria.followers.current}/{data.monetization.criteria.followers.required} · Views {data.monetization.criteria.views.current}/{data.monetization.criteria.views.required} · Status: {data.monetization.monetized ? "Approved" : data.monetization.application ? data.monetization.application.status : "No application"}</span><Note>{data.fees_note}</Note></Card>
    <Primary onClick={downloadCsv}>⬇ Download my stats (CSV)</Primary>
    {csvNote && <Note>{csvNote}</Note>}
    <h4>Per-video performance</h4>
    {data.per_video.map((v) => <Card key={v.id}><strong>{v.title}</strong>{v.hidden && <span style={{ color: "var(--bad)" }}> — hidden pending review</span>}<span style={{ color: "var(--dim)", fontSize: 13 }}>👁 {v.views} · ♥ {v.likes} · 💬 {v.comments} · 🔗 {v.shares} · completed {v.completions} · replays {v.replays} · skips {v.skips} · watch {v.watch_seconds}s</span><div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}><Btn onClick={() => setInteraction(v, { comments_allowed: false })}>Turn comments off</Btn><Btn onClick={() => setInteraction(v, { comments_allowed: true })}>Comments on</Btn><Btn onClick={() => setInteraction(v, { duet_allowed: false })}>Disallow duet reuse</Btn><Btn onClick={() => setInteraction(v, { duet_allowed: true })}>Allow duet reuse</Btn></div></Card>)}
    <h4>Follower growth (last 30 days)</h4>
    {data.follower_growth_30d.length === 0 ? <Note>No new followers in the last 30 days.</Note> : data.follower_growth_30d.map((g) => <div key={g.date} style={{ fontSize: 14 }}>{g.date}: +{g.count}</div>)}
  </>);
}

function PlaylistsScreen({ onPlay }) {
  const [lists, setLists] = useState([]); const [title, setTitle] = useState(""); const [open, setOpen] = useState(null); const [note, setNote] = useState("");
  const load = useCallback(async () => { const r = await call("listPlaylists", {}); if (r.ok) setLists(r.playlists); }, []);
  useEffect(() => { load(); }, [load]);
  async function create(e) { e.preventDefault(); const r = await call("createPlaylist", { title }); if (r.ok) { setTitle(""); load(); } else setNote(r.message); }
  async function openList(id) { const r = await call("getPlaylist", { playlist_id: id }); if (r.ok) setOpen(r); }
  return (<>
    <h3 style={{ margin: 0 }}>📁 Playlists</h3>
    <Note>Playlists are yours only (private). Add videos from Saved or any video's ID; a series is just a playlist you keep in order.</Note>
    <form onSubmit={create} style={{ display: "flex", gap: 6 }}><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New playlist title" style={{ flex: 1 }} /><Primary type="submit">Create</Primary></form>
    {note && <Err text={note} />}
    {lists.map((l) => <Card key={l.id}><strong>{l.title}</strong><span style={{ color: "var(--dim)", fontSize: 13 }}>{l.video_count} videos</span><Btn onClick={() => openList(l.id)}>Open</Btn></Card>)}
    {open && (<>
      <h4>{open.playlist.title}</h4>
      {open.posts.length === 0 && <Note>Empty playlist — add videos from Saved (note the video ID) or use the add form below.</Note>}
      {open.posts.map((p) => <PostRow key={p.id} post={p} onPlay={onPlay} />)}
      <AddToPlaylistForm playlistId={open.playlist.id} onDone={() => openList(open.playlist.id)} />
      <Btn onClick={async () => { if (!window.confirm("Delete this playlist? Videos themselves are not deleted.")) return; await call("deletePlaylist", { playlist_id: open.playlist.id }); setOpen(null); load(); }}>🗑 Delete playlist</Btn>
    </>)}
  </>);
}
function AddToPlaylistForm({ playlistId, onDone }) {
  const [postId, setPostId] = useState(""); const [note, setNote] = useState("");
  return (<form onSubmit={async (e) => { e.preventDefault(); const r = await call("addToPlaylist", { playlist_id: playlistId, post_id: Number(postId) }); setNote(r.ok ? "Added ✓" : r.message); if (r.ok) onDone(); }} style={{ display: "flex", gap: 6 }}>
    <input className="input" value={postId} onChange={(e) => setPostId(e.target.value)} placeholder="Video ID to add" inputMode="numeric" style={{ flex: 1 }} /><Primary type="submit">Add video</Primary><span style={{ fontSize: 13, color: "var(--dim)" }}>{note}</span>
  </form>);
}

function SavedScreen({ onPlay }) {
  const [posts, setPosts] = useState([]); const [loading, setLoading] = useState(true);
  const load = useCallback(async () => { const r = await call("getSavedPosts", {}); setLoading(false); if (r.ok) setPosts(r.posts); }, []);
  useEffect(() => { load(); }, [load]);
  return (<>
    <h3 style={{ margin: 0 }}>💾 Saved videos</h3>
    <Note>Saved on the server (not just this device) — it survives sign-in on another phone.</Note>
    {loading && <Note>Loading…</Note>}
    {posts.length === 0 && !loading && <Note>Nothing saved yet. Save a video from the feed menu or a ranked/trending card.</Note>}
    {posts.map((p) => <PostRow key={p.id} post={p} onPlay={onPlay} onSave={async () => { await call("toggleSave", { post_id: p.id }); load(); }} saved />)}
  </>);
}

function DiscoverScreen() {
  const [recs, setRecs] = useState([]); const [followers, setFollowers] = useState([]); const [following, setFollowing] = useState([]); const [tab, setTab] = useState("recs");
  useEffect(() => { (async () => { const [a, b, c] = await Promise.all([call("getFollowRecommendations", {}), call("getFollowersList", {}), call("getFollowingList", {})]); if (a.ok) setRecs(a.recommendations); if (b.ok) setFollowers(b.users); if (c.ok) setFollowing(c.users); })(); }, []);
  async function follow(id) { const r = await call("toggleFollow", { user_id: id }); if (r.ok) { const a = await call("getFollowRecommendations", {}); if (a.ok) setRecs(a.recommendations); } }
  return (<>
    <h3 style={{ margin: 0 }}>👥 Discover creators</h3>
    <div style={{ display: "flex", gap: 6 }}><Btn onClick={() => setTab("recs")}>Recommended</Btn><Btn onClick={() => setTab("followers")}>Followers ({followers.length})</Btn><Btn onClick={() => setTab("following")}>Following ({following.length})</Btn></div>
    <Note>Recommendations come from real follower counts and your follows — blocked accounts are never recommended, and private-account details are never exposed.</Note>
    {tab === "recs" && recs.map((u) => <Card key={u.id}><div style={{ display: "flex", gap: 10, alignItems: "center" }}><Avatar user={u} size={40} /><div style={{ flex: 1 }}><strong>{u.display_name}</strong><div style={{ color: "var(--dim)", fontSize: 13 }}>@{u.username} · {u.follower_count} followers</div></div><Btn onClick={() => follow(u.id)}>Follow</Btn></div></Card>)}
    {tab === "followers" && followers.map((u) => <Card key={u.id}><div style={{ display: "flex", gap: 10, alignItems: "center" }}><Avatar user={u} size={40} /><strong>@{u.username}</strong></div></Card>)}
    {tab === "following" && following.map((u) => <Card key={u.id}><div style={{ display: "flex", gap: 10, alignItems: "center" }}><Avatar user={u} size={40} /><strong>@{u.username}</strong><Btn onClick={() => follow(u.id)}>Unfollow</Btn></div></Card>)}
  </>);
}

function InterestsScreen() {
  const [tags, setTags] = useState([]); const [input, setInput] = useState(""); const [note, setNote] = useState("");
  useEffect(() => { (async () => { const r = await call("getInterests", {}); if (r.ok) setTags(r.tags); })(); }, []);
  const suggestions = ["comedy", "cricket", "tech", "food", "travel", "music", "gaming", "news", "fitness", "fashion"];
  async function save(next) { const r = await call("setInterests", { tags: next }); if (r.ok) { setTags(r.tags); setNote("Saved — For You ranking uses these interests now."); } else setNote(r.message); }
  return (<>
    <h3 style={{ margin: 0 }}>🎯 Interests &amp; onboarding</h3>
    <Note>Pick interests when you join (or anytime here). They are stored on the server and actually feed the For You ranking — this is not a decorative picker. Skip is always allowed: an empty list just means ranking uses engagement + recency only.</Note>
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{suggestions.map((s) => <Btn key={s} onClick={() => save(tags.includes(s) ? tags.filter((t) => t !== s) : [...tags, s])} style={tags.includes(s) ? { borderColor: "var(--accent)" } : {}}>{tags.includes(s) ? "✓ " : ""}#{s}</Btn>)}</div>
    <form onSubmit={(e) => { e.preventDefault(); if (input.trim()) { save([...tags, input.trim().replace(/^#/, "")]); setInput(""); } }} style={{ display: "flex", gap: 6 }}><input className="input" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Add your own interest" style={{ flex: 1 }} /><Primary type="submit">Add</Primary></form>
    <p style={{ fontSize: 14 }}>Your interests: {tags.length ? tags.map((t) => `#${t}`).join(" ") : "none yet"}</p>
    {note && <Note>{note}</Note>}
    <Card><strong>First-use help</strong><span style={{ fontSize: 14 }}>Feed: swipe vertically, single tap pauses, double tap likes, ⋯ menu has Report / Block / Save / Not interested. Create (+): camera or gallery, then title + hashtags. Live: Live tab → Go Live. Rewards: profile → Start Monetization. This overlay dismisses with ✕ Close and never blocks sign-in.</span></Card>
  </>);
}

function EditorScreen({ onGoUpload }) {
  const DRAFT_KEY = "zoomly_editor_drafts";
  const [drafts, setDrafts] = useState(() => { try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || "[]"); } catch { return []; } });
  const [title, setTitle] = useState(""); const [desc, setDesc] = useState(""); const [overlay, setOverlay] = useState(""); const [speed, setSpeed] = useState(1); const [volume, setVolume] = useState(1); const [file, setFile] = useState(null); const [preview, setPreview] = useState(""); const [draftName, setDraftName] = useState("");
  function persist(next) { setDrafts(next); try { localStorage.setItem(DRAFT_KEY, JSON.stringify(next)); } catch { /* storage full */ } }
  function saveDraft() { const d = { id: Date.now(), name: draftName || title || "Untitled draft", title, description: desc, overlay, speed, volume, saved_at: Date.now() }; persist([d, ...drafts]); }
  function resume(d) { setTitle(d.title || ""); setDesc(d.description || ""); setOverlay(d.overlay || ""); setSpeed(d.speed || 1); setVolume(d.volume || 1); setDraftName(d.name || ""); }
  return (<>
    <h3 style={{ margin: 0 }}>✂️ Editor &amp; drafts</h3>
    <Note>Honest limits of the web editor: trimming, splitting, merging, stickers and auto-captions are NOT available here (they need a native editor). What works: cover selection via the upload flow (first frame), text overlay preview below, playback speed and volume on preview, and drafts. The text overlay below is preview-only — it is NOT burned into the uploaded video. Nothing uploads until you press Publish in the Create tab.</Note>
    <label className="btn" style={{ cursor: "pointer" }}><input type="file" accept="video/*" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; setFile(f || null); if (preview) URL.revokeObjectURL(preview); setPreview(f ? URL.createObjectURL(f) : ""); }} />📹 Choose video to preview</label>
    {preview && <div style={{ position: "relative" }}><video src={preview} controls playsInline style={{ width: "100%", maxHeight: 360, background: "#000", borderRadius: 12 }} ref={(el) => { if (el) { el.playbackRate = speed; el.volume = volume; } }} />{overlay && <div style={{ position: "absolute", top: 12, left: 0, right: 0, textAlign: "center", color: "#fff", fontWeight: 800, fontSize: 20, textShadow: "0 1px 6px #000", pointerEvents: "none" }}>{overlay}</div>}</div>}
    <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" aria-label="Draft title" />
    <textarea className="input" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Description + hashtags" rows={3} aria-label="Draft description" />
    <input className="input" value={overlay} onChange={(e) => setOverlay(e.target.value)} placeholder="Text overlay (preview only)" aria-label="Text overlay" />
    <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
      <label>Speed: <select className="input" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Playback speed"><option value={0.5}>0.5×</option><option value={1}>1×</option><option value={1.5}>1.5×</option><option value={2}>2×</option></select></label>
      <label>Volume: <input type="range" min={0} max={1} step={0.1} value={volume} onChange={(e) => setVolume(Number(e.target.value))} aria-label="Preview volume" /></label>
    </div>
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      <input className="input" value={draftName} onChange={(e) => setDraftName(e.target.value)} placeholder="Draft name" style={{ flex: 1 }} />
      <Primary onClick={saveDraft}>💾 Save draft</Primary>
      <Btn onClick={onGoUpload}>Go to Create to publish →</Btn>
    </div>
    <Note>Drafts store title, description, overlay text, speed and volume on this device only. The video file itself is NOT stored in a draft — if you resume later you must choose the file again (browsers do not let a page re-read a file without you picking it). If a draft's file is missing, the draft still opens with its text intact.</Note>
    {drafts.map((d) => <Card key={d.id}><strong>{d.name}</strong><span style={{ color: "var(--dim)", fontSize: 13 }}>{d.title} · saved {timeAgo(d.saved_at)}</span><div style={{ display: "flex", gap: 6 }}><Btn onClick={() => resume(d)}>Resume</Btn><Btn onClick={() => { const n = drafts.map((x) => x.id === d.id ? { ...x, name: prompt("Rename draft", x.name) || x.name } : x); persist(n); }}>Rename</Btn><Btn onClick={() => { if (window.confirm("Delete this draft?")) persist(drafts.filter((x) => x.id !== d.id)); }}>Delete</Btn></div></Card>)}
    {drafts.length === 0 && <Note>No drafts yet.</Note>}
  </>);
}

function DuetScreen({ onPlay }) {
  const [a, setA] = useState(""); const [b, setB] = useState(""); const [pair, setPair] = useState(null); const [err, setErr] = useState("");
  async function load(e) { e.preventDefault(); const r = await call("getDuetPair", { post_id: Number(a), other_post_id: Number(b) }); if (r.ok) setPair(r.posts); else { setPair(null); setErr(r.message); } }
  return (<>
    <h3 style={{ margin: 0 }}>👥 Duet view</h3>
    <Note>A duet here plays two existing videos side-by-side. It does NOT record a new duet — recording a duet needs a native editor. A creator can turn duet reuse off per video (Creator dashboard); the server enforces that, and this screen shows the refusal honestly. Stitching (joining clips) is not available in the web client.</Note>
    <form onSubmit={load} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      <input className="input" value={a} onChange={(e) => setA(e.target.value)} placeholder="First video ID" inputMode="numeric" style={{ flex: 1 }} />
      <input className="input" value={b} onChange={(e) => setB(e.target.value)} placeholder="Second video ID" inputMode="numeric" style={{ flex: 1 }} />
      <Primary type="submit">Play side-by-side</Primary>
    </form>
    <Err text={err} />
    {pair && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>{pair.map((p) => <div key={p.id}><video src={p.video_url} controls playsInline loop style={{ width: "100%", aspectRatio: "9/16", background: "#000", borderRadius: 12, objectFit: "contain" }} /><div style={{ fontSize: 13 }}>@{p.author?.username} — {p.title}</div><Btn onClick={() => onPlay(p)}>Open full player</Btn></div>)}</div>}
  </>);
}

function LiveHubScreen({ onGoLive }) {
  const [lives, setLives] = useState([]); const [filter, setFilter] = useState(""); const [err, setErr] = useState(""); const [note, setNote] = useState("");
  const load = useCallback(async () => { const r = await call("listLive", {}); if (r.ok) setLives(r.sessions || r.lives || []); else setErr(r.message); }, []);
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);
  const shown = lives.filter((s) => !filter || (s.title || "").toLowerCase().includes(filter.toLowerCase()) || (s.user?.username || "").toLowerCase().includes(filter.toLowerCase()));
  return (<>
    <h3 style={{ margin: 0 }}>🔴 Live hub</h3>
    <Note>Live runs on the existing WebRTC mesh (Cloudflare TURN preferred, Metered fallback) — no new provider. Ended sessions never appear here: this list only shows sessions the backend still marks active, refreshed every 30 seconds. Push notifications for live do not exist — in-app notifications only.</Note>
    <div style={{ display: "flex", gap: 6 }}><input className="input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by title or creator" style={{ flex: 1 }} /><Btn onClick={load}>↻ Refresh</Btn><Primary onClick={onGoLive}>Go Live →</Primary></div>
    <Err text={err} />
    {shown.length === 0 && <Note>No live streams right now.</Note>}
    {shown.map((s) => <Card key={s.id || s.live_session_id}><strong>🔴 {s.title || "Live"}</strong><span style={{ color: "var(--dim)", fontSize: 13 }}>@{s.user?.username || s.username} · {s.viewer_count ?? s.viewers ?? 0} viewers · {s.kind || "video"}</span><Btn onClick={onGoLive}>Open Live tab to watch →</Btn></Card>)}
    <Card><strong>Creator checklist (before going live)</strong><span style={{ fontSize: 14 }}>1) Signed in (live is for signed-in users only — no follower threshold is enforced). 2) Camera + mic permission granted when you tap Go Live. 3) Preview your camera before starting. 4) Title + cover set on the setup screen. 5) If the network drops, the stream ends on the backend and is removed from discovery — viewers see a reconnecting/ended state, never a frozen “live” card.</span></Card>
    <Card><strong>Live notifications</strong><span style={{ fontSize: 14 }}>When a creator you follow goes live, an in-app notification is created (see Inbox). There is no push service, so notifications only appear inside the app. Opening one takes you to the Live tab.</span></Card>
  </>);
}

function MonetizationScreen() {
  const [data, setData] = useState(null); const [err, setErr] = useState("");
  useEffect(() => { (async () => { const r = await call("getCreatorAnalytics", {}); if (r.ok) setData(r.analytics); else setErr(r.message); })(); }, []);
  if (err) return <Err text={err} />;
  if (!data) return <Note>Loading…</Note>;
  const estimated = Math.floor(data.totals.gift_coins_gross * 0.7);
  return (<>
    <h3 style={{ margin: 0 }}>💰 Monetization dashboard</h3>
    <Card><strong>Eligibility &amp; verification</strong><span>Age 18+: {data.monetization.criteria.age.met ? "✓ met" : "✗ not met"} · Followers {data.monetization.criteria.followers.current}/{data.monetization.criteria.followers.required} · Views {data.monetization.criteria.views.current}/{data.monetization.criteria.views.required} · Application: {data.monetization.monetized ? "Approved ✓" : data.monetization.application ? data.monetization.application.status : "Not applied"}</span><Note>Verification is the monetization approval itself (owner reviews your application) plus the 👑 owner badge for the owner account. There is no separate “verified creator” badge beyond that.</Note></Card>
    <Card><strong>Earnings — estimated vs confirmed</strong><span>Estimated creator share (gross gifts × 70%): {estimated} coins — this is an estimate. Confirmed credited to your balance: {data.totals.gift_coins_creator_credited} coins. The difference is pending milli-coin fractions (e.g. a 1-coin rose credits 0 whole coins immediately and carries 0.7 forward) — never silently lost, credited when fractions reach a whole coin.</span></Card>
    <Card><strong>Payout rules (real)</strong><span>Withdrawals: minimum 100 coins, 1 coin = Rs.1, via your JazzCash number. Coins are HELD when you request; the owner approves and pays manually outside the app; a rejection auto-refunds the held coins. Platform fee: exactly 30% of gift value. Fraud prevention: duplicate JazzCash TIDs are rejected, self-referral coins are withheld, and withdrawals need an approved monetization application (owner exempt).</span></Card>
    <Card><strong>Refunds, disputes &amp; tax — plainly</strong><span>Gifts are NOT refunded automatically. A dispute is owner manual review only (contact the owner via the app's contact email on /terms). No tax forms are issued by Zoomly and no automated tax reporting exists — creators handle their own tax obligations.</span></Card>
    <Note>Coin purchases, gift prices and withdrawal requests themselves live in the Rewards tab — this dashboard does not duplicate payment screens, and it never shows TikTok-style rewards (none exist here).</Note>
  </>);
}

function MuteScreen() {
  const [muted, setMuted] = useState([]); const [hidden, setHidden] = useState([]); const [keywords, setKeywords] = useState([]); const [kwInput, setKwInput] = useState(""); const [note, setNote] = useState("");
  const load = useCallback(async () => { const [a, b, c] = await Promise.all([call("getMutedUsers", {}), call("getHiddenItems", {}), call("getCommentKeywords", {})]); if (a.ok) setMuted(a.muted); if (b.ok) setHidden(b.items); if (c.ok) setKeywords(c.keywords); }, []);
  useEffect(() => { load(); }, [load]);
  return (<>
    <h3 style={{ margin: 0 }}>🔇 Mute, hidden &amp; keywords</h3>
    <Note>Mute hides a user's videos and comments from you (server-enforced in ranked feed, trending and comments). Block is stronger and also removes follows. Hidden items are your “Not interested” choices — they are never re-recommended until you unhide them.</Note>
    <h4>Muted ({muted.length})</h4>
    {muted.map((u) => <Card key={u.id}><div style={{ display: "flex", gap: 8, alignItems: "center" }}><Avatar user={u} size={36} /><strong style={{ flex: 1 }}>@{u.username}</strong><Btn onClick={async () => { await call("toggleMute", { user_id: u.id }); load(); }}>Unmute</Btn></div></Card>)}
    <h4>Not interested ({hidden.length})</h4>
    {hidden.map((it) => <Card key={it.id}><span>{it.scope === "creator" ? `Creator: @${it.creator?.username}` : `Video: ${it.post?.title || `#${it.post?.id}`}`}</span><Btn onClick={async () => { await call("unhideNotInterested", { item_id: it.id }); load(); }}>Unhide</Btn></Card>)}
    <h4>Comment keyword filter</h4>
    <form onSubmit={async (e) => { e.preventDefault(); const r = await call("setCommentKeywords", { keywords: [...keywords, kwInput.trim().toLowerCase()].filter(Boolean) }); if (r.ok) { setKeywords(r.keywords); setKwInput(""); setNote("Saved."); } }} style={{ display: "flex", gap: 6 }}>
      <input className="input" value={kwInput} onChange={(e) => setKwInput(e.target.value)} placeholder="Word to hide from comments" style={{ flex: 1 }} /><Primary type="submit">Add word</Primary>
    </form>
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{keywords.map((k) => <Btn key={k} onClick={async () => { const r = await call("setCommentKeywords", { keywords: keywords.filter((x) => x !== k) }); if (r.ok) setKeywords(r.keywords); }}>✕ {k}</Btn>)}</div>
    {note && <Note>{note}</Note>}
  </>);
}

function AppealsScreen() {
  const [appeals, setAppeals] = useState([]); const [notices, setNotices] = useState([]); const [type, setType] = useState("post"); const [targetId, setTargetId] = useState(""); const [msg, setMsg] = useState(""); const [note, setNote] = useState("");
  const load = useCallback(async () => { const [a, b] = await Promise.all([call("getMyAppeals", {}), call("getMyNotices", {})]); if (a.ok) setAppeals(a.appeals); if (b.ok) setNotices(b.notices); }, []);
  useEffect(() => { load(); }, [load]);
  return (<>
    <h3 style={{ margin: 0 }}>⚖️ Appeals &amp; notices</h3>
    {notices.map((n, i) => <Card key={i}><strong>{n.kind === "account_suspended" ? "Account suspended" : "Video hidden"}</strong><span style={{ fontSize: 14 }}>{n.text}</span></Card>)}
    {notices.length === 0 && <Note>No active moderation notices on your account.</Note>}
    <form onSubmit={async (e) => { e.preventDefault(); const r = await call("requestAppeal", { target_type: type, target_id: Number(targetId), message: msg }); setNote(r.ok ? "Appeal sent ✓" : r.message); if (r.ok) load(); }} style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", gap: 6 }}><select className="input" value={type} onChange={(e) => setType(e.target.value)} aria-label="Appeal target type"><option value="post">Video</option><option value="live">Live</option><option value="comment">Comment</option><option value="user">My account</option></select><input className="input" value={targetId} onChange={(e) => setTargetId(e.target.value)} placeholder="ID (video/live/comment/account)" inputMode="numeric" style={{ flex: 1 }} /></div>
      <textarea className="input" value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Why should this be reviewed?" rows={3} />
      <Primary type="submit">Request review</Primary>
    </form>
    {note && <Note>{note}</Note>}
    <h4>My appeals</h4>
    {appeals.map((a) => <Card key={a.id}><span>{a.target_type} #{a.target_id} — {a.status}</span><span style={{ color: "var(--dim)", fontSize: 13 }}>{a.message}</span></Card>)}
  </>);
}

function AdminScreen() {
  const [ov, setOv] = useState(null); const [err, setErr] = useState(""); const [appeals, setAppeals] = useState([]); const [restoreId, setRestoreId] = useState(""); const [note, setNote] = useState("");
  const load = useCallback(async () => { const [a, b] = await Promise.all([call("getAdminOverview", {}), call("getAppeals", {})]); if (a.ok) setOv(a.overview); else setErr(a.message); if (b.ok) setAppeals(b.appeals); }, []);
  useEffect(() => { load(); }, [load]);
  if (err) return <Err text={err} />;
  if (!ov) return <Note>Loading admin overview…</Note>;
  return (<>
    <h3 style={{ margin: 0 }}>🛡️ Admin overview (owner only)</h3>
    <Note>Every admin action here is enforced server-side (owner account check on each action). The client never grants admin rights — a non-owner calling these actions gets “Owner access required.”</Note>
    <Card><strong>Platform</strong><span>Users: {ov.users} · Videos: {ov.posts} · Comments: {ov.comments} · Likes: {ov.likes}</span><span>Pending: reports {ov.pending_reports} · appeals {ov.pending_appeals} · coin requests {ov.pending_coin_requests} · withdrawals {ov.pending_withdrawals}</span><span>{ov.storage_note}</span></Card>
    <Card><strong>App health, last 7 days (aggregate client metrics — no message bodies, no passwords)</strong>{ov.metrics_7d.length === 0 ? <span>No metrics reported yet (opt-in, see Settings → Metrics).</span> : ov.metrics_7d.map((m) => <span key={m.kind}>{m.kind}: {m.count} reports, avg {m.avg_ms}ms</span>)}</Card>
    <form onSubmit={async (e) => { e.preventDefault(); const r = await call("restoreHiddenPost", { post_id: Number(restoreId) }); setNote(r.ok ? "Restored ✓" : r.message); if (r.ok) load(); }} style={{ display: "flex", gap: 6 }}>
      <input className="input" value={restoreId} onChange={(e) => setRestoreId(e.target.value)} placeholder="Video ID to restore" inputMode="numeric" style={{ flex: 1 }} /><Primary type="submit">Restore video</Primary>
    </form>
    {note && <Note>{note}</Note>}
    <h4>Pending appeals</h4>
    {appeals.map((a) => <Card key={a.id}><span>{a.target_type} #{a.target_id} — @{a.user?.username}: {a.message}</span><div style={{ display: "flex", gap: 6 }}><Btn onClick={async () => { await call("reviewAppeal", { appeal_id: a.id, decision: "restore" }); load(); }}>Approve (restore)</Btn><Btn onClick={async () => { await call("reviewAppeal", { appeal_id: a.id, decision: "dismiss" }); load(); }}>Dismiss</Btn></div></Card>)}
    <h4>Audit log (last 50 admin actions)</h4>
    {ov.audit_log.map((r) => <div key={r.id} style={{ fontSize: 13, color: "var(--dim)" }}>{timeAgo(r.created_at)} — {r.action} {r.target_type} #{r.target_id} {r.details}</div>)}
    <Note>Full moderation (reports queue, ban/unban, delete) stays in the owner moderation queue — this overview adds appeals, restoration and the audit log.</Note>
  </>);
}

function DataScreen() {
  const [prefs, setPrefs] = useState(getPrefs());
  const [note, setNote] = useState("");
  async function exportData() { const r = await call("exportMyData", {}); if (!r.ok) { setNote(r.message); return; } const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "zoomly-my-data.json"; a.click(); setNote("Export downloaded — your own posts, comments, likes, follows and payment requests (TIDs omitted)."); }
  return (<>
    <h3 style={{ margin: 0 }}>📦 My data &amp; metrics</h3>
    <Primary onClick={exportData}>⬇ Export my data (JSON)</Primary>
    {note && <Note>{note}</Note>}
    <Card><strong>Anonymous app metrics</strong><span style={{ fontSize: 14 }}>With this ON, the app reports only aggregate numbers (video load time, playback failures, upload success, API latency, startup time) to help the owner find slow/broken parts. It never sends message bodies, video titles, passwords or private data. You can turn it off here; when off, no metrics are sent at all.</span>
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}><input type="checkbox" checked={!prefs.metrics_opt_out} onChange={(e) => { const p = savePrefs({ metrics_opt_out: !e.target.checked }); setPrefs(p); }} /> Send anonymous app metrics</label></Card>
    <Card><strong>Offline &amp; pending actions — plainly</strong><span style={{ fontSize: 14 }}>If you lose connection, in-flight actions show an error and are NOT queued for later — retry them yourself when back online. This avoids duplicate likes, comments or uploads from a blind retry queue. Drafts (Editor screen) are saved on this device and survive a reload.</span></Card>
    <Card><strong>Backup situation — plainly</strong><span style={{ fontSize: 14 }}>The database lives in Turso's cloud service (not on the Render web server, whose disk is ephemeral). There is no separate automated backup export configured by Zoomly — the owner should export Turso backups from the Turso dashboard. This app does not invent a backup system.</span></Card>
  </>);
}

function GuidelinesScreen() {
  return (<>
    <h3 style={{ margin: 0 }}>📜 Guidelines, ads &amp; legal</h3>
    <Card><strong>Community guidelines</strong><span style={{ fontSize: 14 }}>Be respectful. No spam, abuse, nudity, violence or hate. No links to scams. Reports are reviewed by the owner; 3 distinct reports auto-hide a video/live until review. Repeat offenders can be banned. Full rules: <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> (these pages are live in the app).</span></Card>
    <Card><strong>Ads — what exists</strong><span style={{ fontSize: 14 }}>Monetag zones (In-Page Push + Vignette) run site-wide when configured, and an AdSense slot renders only when the owner sets its IDs on Render (currently unset, so it renders nothing). Ads, when shown, are labelled “Ad” by the ad slot. There is NO sponsored-video placement system, brand campaign manager or ad analytics in Zoomly — those are not available and are not claimed. If an ad looks abusive, report it to the owner via the contact email on /terms (ads are not a reportable content target in the moderation queue).</span></Card>
    <Card><strong>Copyright</strong><span style={{ fontSize: 14 }}>Only original audio / audio you own may be uploaded. Do not upload other people's music, videos or logos. Reported copyrighted content is removed by the owner.</span></Card>
    <Card><strong>Child safety — plainly</strong><span style={{ fontSize: 14 }}>Monetization requires age 18+ (verified from the date of birth on the application, computed server-side). General use of Zoomly has NO age gate — the app does not verify age at sign-up, and this screen does not pretend otherwise. Parents should supervise younger users.</span></Card>
    <Card><strong>Google Play</strong><span style={{ fontSize: 14 }}>Zoomly is NOT on Google Play yet. The $25 developer fee is deferred by the owner. The Android app ID is com.zoomly.app and the app icon (app-icon-512.png) exists; screenshots, store description and data-safety declarations are still owner-supplied before any Play submission.</span></Card>
    <Card><strong>Permissions, explained</strong><span style={{ fontSize: 14 }}>Camera + microphone: only when you record or go live. Media: only when you pick a gallery file. Nothing else is collected, and uploads only happen when you press Publish.</span></Card>
  </>);
}

export function GuestFeedView({ onSignIn }) {
  const [posts, setPosts] = useState([]); const [loading, setLoading] = useState(true); const [err, setErr] = useState("");
  useEffect(() => { (async () => { const r = await call("getPublicFeed", { limit: 20 }); setLoading(false); if (r.ok) setPosts(r.posts); else setErr(r.message); })(); }, []);
  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "24px 14px calc(20px + env(safe-area-inset-bottom))" }}>
      <div style={{ textAlign: "center" }}><h2 style={{ margin: "4px 0" }}>Zoom<span style={{ color: "var(--accent)" }}>ly</span> — Guest browsing</h2>
        <p style={{ color: "var(--dim)" }}>You can watch public videos without an account. Liking, commenting, posting, following and messaging need a signed-in account.</p>
        <Primary onClick={onSignIn}>Log in / Sign up</Primary></div>
      {err && <Err text={err} />}
      {loading && <Note>Loading public videos…</Note>}
      <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
        {posts.map((p) => <Card key={p.id}>{p.thumbnail_url && <img src={p.thumbnail_url} alt="" style={{ width: "100%", borderRadius: 10, background: "#000" }} />}<strong>{p.title}</strong><span style={{ color: "var(--dim)", fontSize: 13 }}>@{p.author?.username} · 👁 {p.view_count}</span><video src={p.video_url} controls playsInline preload="metadata" style={{ width: "100%", borderRadius: 10, background: "#000" }} /><Note>Sign in to like, comment or follow this creator.</Note></Card>)}
      </div>
      {posts.length === 0 && !loading && <Note>No public videos yet.</Note>}
    </div>
  );
}
