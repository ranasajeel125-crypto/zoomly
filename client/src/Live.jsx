// Zoomly LIVE: browse live broadcasts, go live, watch + chat + gifts.
//
// Viewers can follow the broadcaster from the watch screen, and one
// viewer at a time can take the guest seat: the host accepts their join
// request and they publish camera/mic as a second publisher next to the
// host (split stage, same mesh + TURN-retry rules). Gifts always target
// the host's session with the usual 70/30 split (broadcaster/platform).
//
// The watch and broadcast rooms are full-screen stages (TikTok-style):
// the video fills the whole viewport and the chat, controls, gift sheet
// and PK score bar float over it.
//
// Video is WebRTC peer-to-peer: the broadcaster's camera/mic goes directly
// to each viewer (mesh). The server only relays signaling, chat, viewer
// counts and gift events over the /ws socket (see live.js). Peers use the
// server-provided ICE list (Google STUN + TURN relays): direct connections
// are preferred, and a peer whose direct connection fails is retried once
// through TURN (iceTransportPolicy "relay") — that is what makes live work
// on carrier-grade NAT / mobile data, where STUN-only cannot connect.
import { useCallback, useEffect, useRef, useState } from "react";
import { call } from "./api";
import { logSelectedCandidatePair, openLiveSocket, peerConnectionConfig, reportIce, setIceServers } from "./live";
import { setViewerMuted, viewerMuted } from "./sound";
import { LIVE_FILTERS, createVideoProcessor, getLiveFilter, setLiveFilter } from "./filters";
import { Avatar, Notice, OwnerBadge, ReportDialog } from "./App.jsx";

const ENDED_TEXT = "This live has ended.";

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function LiveBadge() {
  return (
    <span style={{ background: "#e0245e", color: "#fff", fontWeight: 800, fontSize: 12, borderRadius: 8, padding: "3px 8px", letterSpacing: 0.5 }}>
      ● LIVE
    </span>
  );
}

// ---- full-screen stage (watch + broadcast rooms) ------------------------------
// TikTok-style: the video fills the whole viewport (the stage is fixed, so
// it covers the bottom nav too) and every control floats over it — top bar
// with a fade, notices under it, chat + actions in a bottom gradient. In a
// PK match the cameras instead sit in a framed band under the header +
// score bar (see PK_BAND_HEIGHT below) and the lower stage stays dark.
const stageStyle = {
  position: "fixed",
  inset: 0,
  zIndex: 60,
  background: "#000",
  maxWidth: 860,
  margin: "0 auto",
  display: "flex",
  flexDirection: "column",
  justifyContent: "space-between",
  overflow: "hidden",
};
const videoFillStyle = { width: "100%", height: "100%", objectFit: "cover", display: "block", background: "#000" };
const topBarStyle = {
  position: "relative",
  zIndex: 6,
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
  padding: "calc(10px + env(safe-area-inset-top)) 12px 30px",
  background: "linear-gradient(rgba(0,0,0,0.6), rgba(0,0,0,0))",
};
const bottomOverlayStyle = {
  position: "relative",
  zIndex: 6,
  padding: "30px 12px calc(10px + env(safe-area-inset-bottom))",
  background: "linear-gradient(rgba(0,0,0,0), rgba(0,0,0,0.66))",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};
const bottomBarStyle = { display: "flex", gap: 8, alignItems: "center" };
const noticeStackStyle = {
  position: "absolute",
  top: "calc(118px + env(safe-area-inset-top))",
  left: 12,
  right: 12,
  zIndex: 6,
  display: "grid",
  gap: 6,
  pointerEvents: "none",
};
const darkChipStyle = { background: "rgba(0,0,0,0.5)", borderColor: "rgba(255,255,255,0.25)", color: "#fff" };
const roundBtnStyle = {
  width: 46,
  height: 46,
  borderRadius: "50%",
  border: "1px solid rgba(255,255,255,0.3)",
  background: "rgba(20,20,20,0.6)",
  color: "#fff",
  fontSize: 20,
  flexShrink: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
};
const tileLabelStyle = (bg) => ({
  position: "absolute",
  left: 10,
  top: 10,
  background: bg,
  borderRadius: 10,
  padding: "4px 8px",
  fontSize: 13,
  color: "#fff",
});

// ---- PK band framing ---------------------------------------------------------
// During a PK match the two cameras do NOT fill the screen (owner's
// TikTok reference): they sit side-by-side in a framed BAND under the
// header + score-bar zone — height 55% of the stage — and the stage
// below the band stays dark, where the chat and controls live. The band
// is an in-flow flex row (ordered between the header zone and the
// bottom overlay, which pins itself to the bottom with marginTop:auto)
// so it starts exactly under the score bar on any screen size; outside
// a match the video layer is the usual absolute full-screen layer and
// none of this applies.
const PK_BAND_HEIGHT = "55%";
// Gift animation during a match: its base sits just under the band's
// lower edge (header zone ≈ 15% + band 55% from the top ⇒ ≈ 30% from
// the bottom), floating in the dark zone above the chat — it hangs at
// the band's lower edge instead of covering the faces.
const PK_GIFT_BOTTOM = "31%";

// ---- shared room hook ---------------------------------------------------------
// Opens the socket, authenticates, joins the room, and collects the room's
// chat/gift feed + viewer count. Media/signaling callbacks go to the
// `handlersRef` bag so the broadcaster/watcher components can plug in their
// WebRTC logic without re-creating the socket.
function useLiveRoom(sessionId, handlers = {}) {
  const [messages, setMessages] = useState([]);
  const [viewerCount, setViewerCount] = useState(0);
  // Tap-tap likes: the room's running total, owned by the server (it
  // broadcasts every accepted batch). Seeded from the joined payload so
  // late joiners — and a reconnecting host — see the current count.
  const [liveLikes, setLiveLikes] = useState(0);
  const [ended, setEnded] = useState(false);
  const [connected, setConnected] = useState(false);
  const [authError, setAuthError] = useState("");
  // Broad rooms: the session kind and the live seat snapshot (host +
  // filled seats + free count), owned by the server and resent whole
  // on every seat change.
  const [roomKind, setRoomKind] = useState("video");
  const [seats, setSeats] = useState(null);
  const sockRef = useRef(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const idRef = useRef(0);
  // Gift animation: every gift broadcast also feeds the stage overlay
  // queue (defined below with the overlay component), so the host, the
  // sender, other viewers and a seated guest all see the same show.
  const { giftAnim, enqueueGiftAnim } = useGiftAnimation();

  const pushMsg = useCallback((m) => {
    idRef.current += 1;
    const id = idRef.current;
    setMessages((prev) => [...prev.slice(-90), { ...m, _id: id }]);
  }, []);

  useEffect(() => {
    const sock = openLiveSocket({
      onAuth: () => {
        setConnected(true);
        sock.join(sessionId);
      },
      onAuthError: (msg) => setAuthError(msg.message || "Please sign in again."),
      onClose: () => setConnected(false),
      onMessage: (msg) => {
        const h = handlersRef.current;
        switch (msg.type) {
          case "joined":
            setViewerCount(msg.viewerCount ?? 0);
            if (typeof msg.likeCount === "number") setLiveLikes(msg.likeCount);
            setRoomKind(msg.kind || "video");
            if (msg.seats) setSeats(msg.seats);
            h.onJoined?.(msg);
            break;
          case "viewer-count":
            setViewerCount(msg.count ?? 0);
            break;
          case "live-likes":
            if (typeof msg.total === "number") setLiveLikes(msg.total);
            h.onLiveLikes?.(msg);
            break;
          case "chat":
            pushMsg({ kind: "chat", from: msg.from, text: msg.text, created_at: msg.created_at });
            break;
          case "gift":
            pushMsg({ kind: "gift", from: msg.from, gift: msg.gift, created_at: msg.created_at });
            enqueueGiftAnim(msg.from, msg.gift);
            h.onGift?.(msg);
            break;
          case "signal":
            h.onSignal?.(msg);
            break;
          case "viewer-joined":
            h.onViewerJoined?.(msg);
            break;
          case "viewer-left":
            h.onViewerLeft?.(msg);
            break;
          case "broadcaster-joined":
            h.onBroadcasterJoined?.(msg);
            break;
          case "match-invite":
            h.onMatchInvite?.(msg);
            break;
          case "match-declined":
            pushMsg({ kind: "system", text: `⚔️ @${msg.by?.username} ne PK match ka challenge mana kar diya.` });
            h.onMatchDeclined?.(msg);
            break;
          case "match-invite-expired":
            h.onMatchInviteExpired?.(msg);
            break;
          case "match-started":
            h.onMatchStarted?.(msg);
            break;
          case "match-score":
            h.onMatchScore?.(msg);
            break;
          case "match-ended":
            h.onMatchEnded?.(msg);
            break;
          case "match-peer":
            h.onMatchPeer?.(msg);
            break;
          case "guest-request":
            h.onGuestRequest?.(msg);
            break;
          case "guest-request-expired":
            h.onGuestRequestExpired?.(msg);
            break;
          case "guest-declined":
            h.onGuestDeclined?.(msg);
            break;
          case "guest-seated":
            h.onGuestSeated?.(msg);
            break;
          case "guest-peer":
            h.onGuestPeer?.(msg);
            break;
          case "guest-left":
            h.onGuestLeft?.(msg);
            break;
          case "seats":
            setSeats({ host: msg.host ?? null, seats: msg.seats ?? [], seatsFree: msg.seatsFree ?? 0 });
            break;
          case "seat-request":
            h.onSeatRequest?.(msg);
            break;
          case "seat-request-cancelled":
            h.onSeatRequestGone?.(msg);
            break;
          case "seat-request-expired":
            h.onSeatRequestExpired?.(msg);
            break;
          case "seat-declined":
            h.onSeatDeclined?.(msg);
            break;
          case "seat-seated":
            h.onSeatSeated?.(msg);
            break;
          case "seat-invited":
            h.onSeatInvited?.(msg);
            break;
          case "seat-invite-declined":
            pushMsg({ kind: "system", text: `🎙️ @${msg.by?.user?.username} ne seat invite mana kar diya.` });
            h.onSeatInviteDeclined?.(msg);
            break;
          case "seat-invite-expired":
            h.onSeatInviteExpired?.(msg);
            break;
          case "seat-peer":
            h.onSeatPeer?.(msg);
            break;
          case "seat-left":
            h.onSeatLeft?.(msg);
            break;
          case "seat-host-muted":
            h.onSeatHostMuted?.(msg);
            break;
          case "live-ended":
            setEnded(true);
            h.onEnded?.(msg);
            break;
          case "error":
            if (msg.code === "live-ended") setEnded(true);
            else if (msg.message) pushMsg({ kind: "system", text: msg.message });
            break;
          default:
            break;
        }
      },
    });
    sockRef.current = sock;
    return () => {
      sock.close();
      sockRef.current = null;
    };
  }, [sessionId, pushMsg, enqueueGiftAnim]);

  const sendChat = useCallback((text) => {
    sockRef.current?.chat(text);
  }, []);

  return { sockRef, messages, pushMsg, viewerCount, liveLikes, giftAnim, ended, connected, authError, sendChat, roomKind, seats };
}

// ---- tap-tap like hearts -------------------------------------------------------
// Floating hearts over the live stage: the tapper's hearts spawn at the
// tap point; everyone else's likes spawn one heart each on the stage's
// right side as the broadcasts arrive. Purely visual — the count itself
// comes from the server's live-likes broadcasts.
let heartSeq = 0;
function useFloatingHearts() {
  const [hearts, setHearts] = useState([]);
  const spawnHeart = useCallback((xPct, yPct) => {
    heartSeq += 1;
    const id = heartSeq;
    const heart = {
      id,
      x: xPct,
      y: yPct,
      drift: Math.round(Math.random() * 70) - 35,
      rot: Math.round(Math.random() * 36) - 18,
      size: 26 + Math.round(Math.random() * 16),
    };
    setHearts((prev) => [...prev.slice(-23), heart]);
    setTimeout(() => setHearts((prev) => prev.filter((h) => h.id !== id)), 1400);
  }, []);
  return { hearts, spawnHeart };
}

function FloatingHearts({ hearts }) {
  if (hearts.length === 0) return null;
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none", zIndex: 5 }}>
      {hearts.map((h) => (
        <span
          key={h.id}
          className="zoomly-live-heart"
          style={{ left: `${h.x}%`, top: `${h.y}%`, fontSize: h.size, "--drift": `${h.drift}px`, "--rot": `${h.rot}deg` }}
        >
          ❤️
        </span>
      ))}
    </div>
  );
}

// ---- gift animation overlay ----------------------------------------------------
// When a gift lands, EVERYONE in the room sees it big — not just the
// chat-feed line: the gift's emoji pops into the centre-lower stage,
// floats up and fades over ~2.8s (CSS: .zoomly-gift-pop / -label),
// with a "@sender ne 🌹 Rose bheja" label under it. Gifts play ONE at
// a time from a short queue: a burst of 1-coin flowers queues up
// politely instead of stacking, and once the waiting queue is full
// the extra VISUALS are dropped (the chat feed still records every
// gift). Positioned in the lower-centre of the stage, above the chat:
// callers pass `bottom` to place it — the plain rooms use the default,
// Broad rooms hug the bottom, and during a PK match it hangs at the
// framed band's lower edge (PK_GIFT_BOTTOM), never over the faces.
const GIFT_ANIM_MS = 2800;
const GIFT_ANIM_GAP_MS = 160;
const GIFT_ANIM_QUEUE_MAX = 5;
let giftAnimSeq = 0;

function useGiftAnimation() {
  const [current, setCurrent] = useState(null);
  const queueRef = useRef([]);
  const showingRef = useRef(false);
  const timersRef = useRef([]);

  const later = useCallback((fn, ms) => {
    timersRef.current.push(setTimeout(fn, ms));
  }, []);

  const pump = useCallback(() => {
    if (showingRef.current) return;
    const next = queueRef.current.shift();
    if (!next) return;
    showingRef.current = true;
    setCurrent(next);
    later(() => {
      setCurrent(null);
      showingRef.current = false;
      later(pump, GIFT_ANIM_GAP_MS);
    }, GIFT_ANIM_MS);
  }, [later]);

  const enqueueGiftAnim = useCallback(
    (from, gift) => {
      if (!gift) return;
      // Waiting queue full → drop this visual only. The chat-feed line
      // (pushMsg in useLiveRoom) has already recorded the gift.
      if (queueRef.current.length >= GIFT_ANIM_QUEUE_MAX) return;
      giftAnimSeq += 1;
      queueRef.current.push({ id: giftAnimSeq, from, gift });
      pump();
    },
    [pump]
  );

  useEffect(
    () => () => {
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
    },
    []
  );

  return { giftAnim: current, enqueueGiftAnim };
}

function GiftAnimationOverlay({ anim, bottom = "27%" }) {
  if (!anim?.gift) return null;
  const { gift, from } = anim;
  return (
    <div
      data-gift-animation=""
      style={{ position: "absolute", left: 0, right: 0, bottom, zIndex: 5, display: "flex", justifyContent: "center", pointerEvents: "none", padding: "0 16px" }}
    >
      {/* key restarts the CSS animations for each gift in the queue */}
      <div key={anim.id} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
        <div className="zoomly-gift-pop" style={{ fontSize: 96, lineHeight: 1, filter: "drop-shadow(0 6px 22px rgba(0,0,0,0.55))" }}>
          {gift.emoji}
        </div>
        <div
          className="zoomly-gift-label"
          style={{ background: "rgba(0,0,0,0.62)", border: "1px solid rgba(255,255,255,0.25)", borderRadius: 999, padding: "6px 14px", fontSize: 15, color: "#fff", textShadow: "0 1px 3px rgba(0,0,0,0.8)", whiteSpace: "nowrap", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis" }}
        >
          <strong>@{from?.username}</strong> ne {gift.emoji} <strong>{gift.name}</strong> bheja
        </div>
      </div>
    </div>
  );
}

// ---- chat / gift feed (overlay versions for the full-screen stage) -------------

// The scrolling message list, styled to float over video: no panel box,
// text carries a shadow so it stays readable on any picture.
function ChatFeed({ messages }) {
  const listRef = useRef(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const shadow = { textShadow: "0 1px 4px rgba(0,0,0,0.95), 0 0 2px rgba(0,0,0,0.9)" };
  return (
    <div
      ref={listRef}
      className="no-scrollbar"
      style={{ overflowY: "auto", maxHeight: "30dvh", width: "min(84%, 450px)", display: "grid", gap: 6, alignContent: "start", padding: "4px 2px" }}
    >
      {messages.length === 0 && (
        <p style={{ color: "rgba(255,255,255,0.75)", fontSize: 14, margin: 0, ...shadow }}>Chat is quiet — say hello! 👋</p>
      )}
      {messages.map((m) => {
        if (m.kind === "gift" && m.gift) {
          return (
            <div key={m._id} style={{ background: "rgba(20,40,5,0.55)", border: "1px solid var(--accent-dark)", borderRadius: 10, padding: "6px 9px", fontSize: 14, justifySelf: "start" }}>
              <span style={{ fontSize: 18 }}>{m.gift.emoji}</span> <strong>@{m.from?.username}</strong> sent <strong>{m.gift.name}</strong> · 🪙 {m.gift.coins}
            </div>
          );
        }
        if (m.kind === "system") {
          return (
            <div key={m._id} style={{ color: "rgba(255,255,255,0.8)", fontSize: 13, ...shadow }}>
              {m.text}
            </div>
          );
        }
        return (
          <div key={m._id} style={{ fontSize: 14.5, lineHeight: 1.35, color: "#fff", ...shadow }}>
            <strong style={{ color: "var(--accent)" }}>@{m.from?.username}</strong> <span>{m.text}</span>
          </div>
        );
      })}
    </div>
  );
}

// The pill-shaped message input that sits in the stage's bottom bar,
// next to the room's action buttons (gift, sound, End Live…).
function ChatInput({ onSend, disabled, placeholder }) {
  const [text, setText] = useState("");

  function submit(e) {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText("");
  }

  return (
    <form onSubmit={submit} style={{ display: "flex", gap: 8, flex: 1, minWidth: 0 }}>
      <input
        className="input"
        placeholder={placeholder || "Write a message…"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={500}
        disabled={disabled}
        style={{ background: "rgba(18,18,18,0.68)", borderColor: "rgba(255,255,255,0.28)", color: "#fff", borderRadius: 999, backdropFilter: "blur(3px)" }}
      />
      <button className="btn btn-primary" type="submit" disabled={disabled || !text.trim()} style={{ borderRadius: 999, flexShrink: 0 }}>
        Send
      </button>
    </form>
  );
}

// ---- PK match: score bar + result --------------------------------------------

// TikTok-style PK score bar, pinned at the TOP of the stage during a
// match: side A's avatar/name/score at the left end, side B's at the
// right end, the match countdown in the centre, and a proportional
// two-colour fill underneath that swings toward whoever is ahead.
// Scores arrive live via the match-score broadcasts (match state).
function MatchBar({ match }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!match) return null;
  const secondsLeft = Math.max(0, Math.round((match.endsAt - Date.now()) / 1000));
  const mm = Math.floor(secondsLeft / 60);
  const ss = String(secondsLeft % 60).padStart(2, "0");
  const total = match.scoreA + match.scoreB;
  const aPct = total === 0 ? 50 : Math.round((match.scoreA / total) * 100);
  const sideStyle = { display: "flex", alignItems: "center", gap: 6, minWidth: 0 };
  const nameStyle = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13.5 };
  return (
    <div data-pk-scorebar="">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 14, gap: 8 }}>
        <span style={sideStyle}>
          <Avatar user={match.a.user} size={26} />
          <span style={nameStyle}>@{match.a.user.username}</span>
          <strong data-pk-score="a" style={{ fontSize: 17, whiteSpace: "nowrap" }}>
            🪙 {match.scoreA}
          </strong>
        </span>
        <span className="chip" data-pk-countdown="" style={{ borderColor: "#e0245e", color: "#ff7aa8", flexShrink: 0 }}>
          ⏱ {mm}:{ss}
        </span>
        <span style={{ ...sideStyle, justifyContent: "flex-end" }}>
          <strong data-pk-score="b" style={{ fontSize: 17, whiteSpace: "nowrap" }}>
            🪙 {match.scoreB}
          </strong>
          <span style={nameStyle}>@{match.b.user.username}</span>
          <Avatar user={match.b.user} size={26} />
        </span>
      </div>
      <div style={{ display: "flex", height: 12, borderRadius: 999, overflow: "hidden", marginTop: 6, background: "var(--surface-2)" }}>
        <div data-pk-fill="a" style={{ width: `${aPct}%`, background: "var(--accent)", transition: "width 0.4s" }} />
        <div data-pk-fill="b" style={{ flex: 1, background: "#e0245e", transition: "width 0.4s" }} />
      </div>
    </div>
  );
}

function MatchResultBanner({ result, myUserId }) {
  if (!result) return null;
  const text = result.draw
    ? `🤝 Match DRAW! Dono sides ke ${result.scoreA} — ${result.scoreB} points.`
    : `🏆 @${result.winner?.username} ne PK Match jeet liya! (${result.scoreA} — ${result.scoreB})${result.winnerUserId === myUserId ? " — Mubarak ho! 🎉" : ""}`;
  return (
    <div style={{ background: "rgba(163,230,53,0.12)", border: "1px solid var(--accent)", color: "var(--text)", borderRadius: 12, padding: "10px 12px", fontSize: 15, marginTop: 10, textAlign: "center" }}>
      {text}
    </div>
  );
}

// ---- live list -------------------------------------------------------------------

function LiveList({ me, onGoLive, onWatch, onOpenProfile }) {
  const [lives, setLives] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    // listLive is a read action: retried automatically while the server wakes.
    const res = await call("listLive", {});
    if (res.ok) {
      setLives(res.lives);
      setLoadError(false);
    } else if (res.transportError) {
      setLoadError(true);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);

  const videoLives = lives.filter((l) => (l.kind || "video") !== "broad");
  const broadLives = lives.filter((l) => l.kind === "broad");

  return (
    <div style={{ padding: "14px 14px 20px", maxWidth: 640, margin: "0 auto" }}>
      <h2 style={{ margin: "2px 0 12px" }}>🔴 Live now</h2>
      <button className="btn btn-primary" onClick={onGoLive} style={{ width: "100%", padding: "15px 18px", fontSize: 17.5, fontWeight: 800, borderRadius: 14, marginBottom: 16, boxShadow: "0 6px 18px rgba(224,36,94,0.35)", background: "#e0245e", borderColor: "#e0245e" }}>
        📹 Go Live — apni live shuru karo
      </button>
      {loading && <p style={{ color: "var(--dim)" }}>Loading live broadcasts…</p>}
      {!loading && loadError && lives.length === 0 && (
        <div style={{ textAlign: "center", padding: 20 }}>
          <p style={{ color: "var(--dim)" }}>Live list could not load — the server may be waking up.</p>
          <button className="btn btn-primary" onClick={load}>
            Try again
          </button>
        </div>
      )}
      {!loading && !loadError && (
        <>
          {/* Two separate sections (owner's layout): video lives on top,
              broad (voice) rooms below. A section with no rooms keeps its
              heading plus a quiet line, so the structure is always
              visible — the same way Stories sit in Watch. */}
          {[
            { key: "video", heading: "🔴 Live", empty: "Abhi koi live nahi hai.", rows: videoLives },
            { key: "broad", heading: "🎙️ Broad", empty: "Abhi koi broad nahi hai.", rows: broadLives },
          ].map((section) => (
            <section key={section.key} data-live-section={section.key} style={{ marginBottom: 18 }}>
              <h3 style={{ margin: "0 0 10px", fontSize: 17 }}>{section.heading}</h3>
              {section.rows.length === 0 ? (
                <p style={{ color: "var(--dim)", margin: 0, fontSize: 14 }}>{section.empty}</p>
              ) : (
                <div style={{ display: "grid", gap: 10 }}>
                  {section.rows.map((live) => (
                    <div key={live.id} className="card" data-live-kind={live.kind || "video"} style={{ display: "flex", alignItems: "center", gap: 12, padding: 12 }}>
                      <button onClick={() => live.broadcaster && onOpenProfile(live.broadcaster.id)} style={{ background: "none", border: "none", padding: 0 }} aria-label="Broadcaster profile">
                        <Avatar user={live.broadcaster} size={52} />
                      </button>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <LiveBadge />
                          <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{live.title}</strong>
                        </div>
                        <div style={{ color: "var(--dim)", fontSize: 13, marginTop: 3 }}>
                          {live.broadcaster?.display_name} <OwnerBadge user={live.broadcaster} /> (@{live.broadcaster?.username}) · 👀 {live.viewer_count} {live.kind === "broad" ? "listening" : "watching"}
                          {live.kind === "broad" ? " · 🎙️ Broad" : ""}
                          {live.in_match ? " · ⚔️ PK Match chal raha hai" : ""}
                          {live.hidden ? " · ⏳ review me hai (sirf tumhe dikh raha hai)" : ""}
                        </div>
                      </div>
                      {live.broadcaster?.id === me.id ? (
                        <span className="chip">Your live</span>
                      ) : (
                        <button className="btn btn-primary btn-small" onClick={() => onWatch(live)}>
                          {live.kind === "broad" ? "🎙️ Sunno" : "Watch"}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          ))}
        </>
      )}
    </div>
  );
}

// ---- go-live setup -----------------------------------------------------------------

function GoLiveSetup({ me, onStart, onCancel }) {
  // The live title is asked once and then remembered on the account:
  // with a saved title we go straight to the camera/start screen and
  // only offer a small "change title" edit for those who want it.
  const savedTitle = me.live_title ?? "";
  const [title, setTitle] = useState(savedTitle);
  const [editingTitle, setEditingTitle] = useState(!savedTitle);
  // Live mode: "video" (camera live) or "broad" (audio-only voice room
  // with seats). Switching modes throws away any captured media — a
  // broad must never hold a camera stream.
  const [mode, setMode] = useState("video");
  const [stream, setStream] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const previewRef = useRef(null);
  const streamRef = useRef(null);
  // The filter processor (filters.js): the camera runs through it and
  // its processed stream is what the preview shows and the broadcast
  // room publishes. Null when this browser can't process video — then
  // the raw camera is used, exactly as before filters existed.
  const processorRef = useRef(null);

  useEffect(() => {
    if (previewRef.current && stream) previewRef.current.srcObject = stream;
  }, [stream]);

  useEffect(
    () => () => {
      processorRef.current?.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    },
    []
  );

  function stopCaptured() {
    processorRef.current?.stop();
    processorRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStream(null);
  }

  function pickMode(next) {
    if (next === mode) return;
    stopCaptured();
    setError("");
    setMode(next);
  }

  // Broad setup captures the MICROPHONE ONLY — no camera is ever
  // requested in broad mode (the audio-only promise starts here).
  async function enableMic() {
    setError("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Is browser me microphone support nahi hai. Chrome ka latest version try karo.");
      return;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = s;
      setStream(s);
    } catch (err) {
      if (err && (err.name === "NotAllowedError" || err.name === "SecurityError")) {
        setError("Mic ki ijazat nahi mili. Browser ki settings me microphone Allow karo, phir dobara koshish karo.");
      } else if (err && err.name === "NotFoundError") {
        setError("Koi microphone nahi mila. Device check karke dobara koshish karo.");
      } else {
        setError("Mic khul nahi saka. Dobara koshish karo.");
      }
    }
  }

  async function enableCamera() {
    setError("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Is browser me camera support nahi hai. Chrome ka latest version try karo.");
      return;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      streamRef.current = s;
      const proc = createVideoProcessor(s, getLiveFilter());
      processorRef.current = proc;
      // Preview the same processed picture viewers will receive. (If
      // the pipeline turns out to produce nothing on this device, the
      // broadcast room's stall rescue swaps everyone to the raw camera
      // — working video beats filters, always.)
      setStream(proc ? proc.stream : s);
    } catch (err) {
      if (err && (err.name === "NotAllowedError" || err.name === "SecurityError")) {
        setError("Camera/mic ki ijazat nahi mili. Browser ki settings me camera aur microphone Allow karo, phir dobara koshish karo.");
      } else if (err && err.name === "NotFoundError") {
        setError("Koi camera ya microphone nahi mila. Device check karke dobara koshish karo.");
      } else {
        setError("Camera khul nahi saka. Dobara koshish karo.");
      }
    }
  }

  async function start(e) {
    e.preventDefault();
    if (!stream) {
      setError(mode === "broad" ? "Pehle mic on karo." : "Pehle camera on karo.");
      return;
    }
    setBusy(true);
    setError("");
    // Send a title only when the user typed/edited one; otherwise the
    // server reuses the saved title (or its default) — starting a live
    // never requires touching the title again.
    const typed = editingTitle ? title.trim() : "";
    const res = await call("startLive", { ...(typed ? { title: typed } : {}), kind: mode });
    setBusy(false);
    if (!res.ok) {
      setError(res.message || "Live start nahi ho saki.");
      return;
    }
    // Adopt the server's ICE list (STUN + TURN) for all peer connections.
    setIceServers(res.ice_servers);
    // Ownership of the stream (and its filter processor) passes to the
    // broadcast room.
    streamRef.current = null;
    const proc = processorRef.current;
    processorRef.current = null;
    onStart(res.session, stream, proc);
  }

  function cancel() {
    processorRef.current?.stop();
    processorRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    onCancel();
  }

  return (
    <div style={{ padding: "14px 14px 20px", maxWidth: 560, margin: "0 auto" }}>
      <h2 style={{ margin: "2px 0 12px" }}>{mode === "broad" ? "🎙️ Go Broad" : "📹 Go Live"}</h2>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }} role="group" aria-label="Live mode">
        <button type="button" data-live-mode="video" className={mode === "video" ? "btn btn-primary" : "btn"} style={{ flex: 1, padding: "11px 10px", fontWeight: 700 }} onClick={() => pickMode("video")}>
          📹 Video Live
        </button>
        <button type="button" data-live-mode="broad" className={mode === "broad" ? "btn btn-primary" : "btn"} style={{ flex: 1, padding: "11px 10px", fontWeight: 700 }} onClick={() => pickMode("broad")}>
          🎙️ Broad (sirf awaz)
        </button>
      </div>
      {mode === "broad" ? (
        <div style={{ background: "var(--surface-2, #17141f)", border: "1px solid var(--border)", borderRadius: 16, padding: 22, textAlign: "center" }}>
          <div style={{ fontSize: 44 }}>🎙️</div>
          {stream ? (
            <>
              <p style={{ fontWeight: 700, margin: "8px 0 2px" }}>Mic tayyar hai — tum live awaz me sunai doge</p>
              <p style={{ color: "var(--dim)", margin: 0, fontSize: 13.5 }}>Broad me camera bilkul nahi chalta — sirf awaz. 6 listeners tumhare sath seat le kar baat kar sakenge; kis ko bethana hai, ye tum hi tay karoge.</p>
            </>
          ) : (
            <>
              <p style={{ color: "var(--dim)", margin: "8px 0 12px" }}>Broad = sirf awaz wala live room. Camera on nahi hoga.</p>
              <button type="button" className="btn btn-primary" onClick={enableMic}>
                🎙️ Mic on karo
              </button>
            </>
          )}
        </div>
      ) : (
        <div style={{ background: "#000", borderRadius: 16, overflow: "hidden", aspectRatio: "4/3", display: "flex", alignItems: "center", justifyContent: "center" }}>
          {stream ? (
            <video ref={previewRef} autoPlay muted playsInline style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            <div style={{ textAlign: "center", padding: 20 }}>
              <div style={{ fontSize: 40 }}>🎥</div>
              <p style={{ color: "var(--dim)" }}>Camera preview yahan aayega</p>
              <button type="button" className="btn btn-primary" onClick={enableCamera}>
                Camera on karo
              </button>
            </div>
          )}
        </div>
      )}
      <form onSubmit={start} style={{ display: "grid", gap: 10, marginTop: 14 }}>
        {editingTitle ? (
          <>
            <input className="input" placeholder="Live title — e.g. Sham ki gapshap 🎤" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} autoFocus={!savedTitle} />
            <p style={{ color: "var(--dim)", fontSize: 12.5, margin: 0 }}>
              {savedTitle ? "Naya title save ho jayega — agli dafa yehi use hoga." : "Title ek dafa likho — agli dafa app khud yaad rakhega. Khali chhoro to tumhare naam wala title lag jayega."}
            </p>
          </>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 8, border: "1px solid var(--border)", borderRadius: 12, padding: "10px 12px" }}>
            <span style={{ color: "var(--dim)", fontSize: 13 }}>📌 Title:</span>
            <strong style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 14.5 }}>{savedTitle}</strong>
            <button type="button" className="btn btn-small" onClick={() => setEditingTitle(true)}>
              ✏️ Change
            </button>
          </div>
        )}
        <Notice text={error} bad />
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" type="button" onClick={cancel} style={{ flex: 1 }}>
            ← Back
          </button>
          <button className="btn btn-primary" type="submit" disabled={busy || !stream} style={{ flex: 2, padding: "12px 16px", fontSize: 16 }}>
            {busy ? "Starting…" : mode === "broad" ? "🎙️ Start Broad" : "🔴 Start Live"}
          </button>
        </div>
      </form>
      <p style={{ color: "var(--dim)", fontSize: 13, marginTop: 10 }}>
        {mode === "broad"
          ? "Listeners tumhe gifts bhej sakte hain — har gift ke 70% coins tumhare balance me aayenge. Seat lene walo ko tum khud pick karoge."
          : "Viewers tumhe gifts bhej sakte hain — har gift ke 70% coins tumhare balance me aayenge."}
      </p>
    </div>
  );
}

// ---- face filters ------------------------------------------------------------------
// The picker shown to publishers (host + seated guest). The published
// video itself is filtered (see filters.js), so viewers see the same
// picture. Where the browser can't process the camera, the sheet says
// so and the broadcast simply runs unfiltered.
function FilterSheet({ activeKey, supported, onPick, onClose }) {
  return (
    <>
      <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 7 }} />
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 8,
          background: "var(--surface)",
          borderTop: "1px solid var(--border)",
          borderRadius: "18px 18px 0 0",
          padding: "14px 14px calc(14px + env(safe-area-inset-bottom))",
          animation: "zoomly-sheet-up 0.22s ease-out",
          maxHeight: "62dvh",
          overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <strong style={{ fontSize: 16, flex: 1 }}>🎨 Face Filters</strong>
          <button type="button" className="btn btn-small" onClick={onClose} aria-label="Close filters">
            ✕
          </button>
        </div>
        {supported ? (
          <>
            <p style={{ fontSize: 13, color: "var(--dim)", margin: "8px 0 10px" }}>
              Filter live badal sakte ho — broadcast nahi rukega. Viewers ko bhi yehi filtered video dikhegi.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {LIVE_FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  data-filter-key={f.key}
                  aria-pressed={f.key === activeKey}
                  className={f.key === activeKey ? "btn btn-primary" : "btn"}
                  onClick={() => onPick(f.key)}
                  style={{ borderRadius: 999, padding: "9px 16px", fontWeight: 700 }}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </>
        ) : (
          <p style={{ fontSize: 13.5, color: "var(--dim)", margin: "10px 0 4px" }}>
            ⚠️ Is browser me filters support nahi hain — is liye tumhari video bina filter ke live hai. Chrome ke latest version me filters chal jayenge.
          </p>
        )}
      </div>
    </>
  );
}

// ---- broadcast room -----------------------------------------------------------------

function BroadcastRoom({ me, session, stream, processor, onDone }) {
  const videoRef = useRef(null);
  const secondVideoRef = useRef(null);
  const pcsRef = useRef(new Map()); // peerId -> { pc, pendingIce, kind: "viewer" | "match-viewer" | "match-peer" }
  const matchPeerIdRef = useRef(null);
  const [earned, setEarned] = useState(0);
  const [giftCount, setGiftCount] = useState(0);
  const [ending, setEnding] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const peakRef = useRef(0);
  const endHandledRef = useRef(false);
  // PK match state
  const [match, setMatch] = useState(null);
  const [matchResult, setMatchResult] = useState(null);
  const [showChallenge, setShowChallenge] = useState(false);
  const [others, setOthers] = useState([]);
  const [pendingInviteTo, setPendingInviteTo] = useState(null);
  const [incomingInvite, setIncomingInvite] = useState(null);
  // Guest seat state
  const [guestSeat, setGuestSeat] = useState(null);
  const [guestRequests, setGuestRequests] = useState([]);
  const guestPeerIdRef = useRef(null);
  // Face filter state: `stream` is already the processor's output (or
  // the raw camera when processing is unavailable), so all peers and
  // the preview show the filtered picture. Switching just re-aims the
  // processor's canvas — the published track never changes.
  const [filterKey, setFilterKey] = useState(() => processor?.filter ?? getLiveFilter());
  const [showFilters, setShowFilters] = useState(false);
  // Tap-tap likes: viewers' hearts float up the right side of my stage
  // as their like broadcasts arrive (the count itself is in the top bar).
  const { hearts, spawnHeart } = useFloatingHearts();
  // Set when the filter pipeline stalls mid-broadcast and the room has
  // fallen back to publishing the raw camera track (see the effect).
  // The ref mirror is what wirePeer reads when later peers connect.
  const [processorDead, setProcessorDead] = useState(false);
  const rawFallbackRef = useRef(false);

  function pickFilter(key) {
    setFilterKey(key);
    setLiveFilter(key);
    processor?.setFilter(key);
  }

  // Stall rescue: if the filter canvas stops producing frames while
  // live, swap every peer's video sender to the RAW camera track
  // (replaceTrack — no renegotiation) and halt the processor, so
  // viewers get plain camera video instead of a frozen/black canvas.
  useEffect(() => {
    if (!processor || processorDead) return;
    processor.setOnStall(() => {
      const rawTrack = processor.sourceStream?.getVideoTracks?.()[0];
      const processedTrack = stream.getVideoTracks()[0];
      if (rawTrack && processedTrack && rawTrack !== processedTrack) {
        for (const entry of pcsRef.current.values()) {
          for (const sender of entry.pc.getSenders()) {
            if (sender.track === processedTrack) sender.replaceTrack(rawTrack).catch(() => {});
          }
        }
      }
      processor.halt();
      rawFallbackRef.current = true;
      setProcessorDead(true);
      room.pushMsg({ kind: "system", text: "⚠️ Filter ruk gaya tha — video ab seedhi camera se chal rahi hai (bina filter ke)." });
    });
    return () => processor.setOnStall(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processor, stream, processorDead]);

  const room = useLiveRoom(session.id, {
    onLiveLikes: () => {
      spawnHeart(76 + Math.random() * 16, 66);
    },
    onGift: (msg) => {
      if (msg.gift) {
        setEarned((e) => e + (msg.gift.creator_share ?? 0));
        setGiftCount((c) => c + 1);
      }
    },
    onViewerJoined: (msg) => {
      void connectViewer(msg.peerId, msg.matchId ? "match-viewer" : "viewer");
    },
    onViewerLeft: (msg) => {
      closePeer(msg.peerId);
    },
    onSignal: async (msg) => {
      if (!msg.data) return;
      // A peer whose direct connection failed asks us to re-offer to them
      // through a TURN relay (their retry path — see onPeerIceFailed).
      if (msg.data.kind === "renegotiate") {
        const kind = pcsRef.current.get(msg.from)?.kind ?? (msg.from === matchPeerIdRef.current ? "match-peer" : "viewer");
        closePeer(msg.from);
        void connectViewer(msg.from, kind, { relayOnly: true });
        return;
      }
      // Only the PK match peer ever offers to us; answer it. (This also
      // replaces a failed earlier attempt when they re-offer via relay.)
      if (msg.data.kind === "offer" && msg.data.description) {
        if (msg.from === matchPeerIdRef.current) {
          await answerMatchPeer(msg.from, msg.data.description, { relayOnly: !!msg.data.relay });
        }
        return;
      }
      const entry = pcsRef.current.get(msg.from);
      if (!entry) return;
      const { pc } = entry;
      try {
        if (msg.data.kind === "answer" && msg.data.description) {
          await pc.setRemoteDescription(msg.data.description);
          for (const cand of entry.pendingIce.splice(0)) {
            await pc.addIceCandidate(cand).catch(() => {});
          }
        } else if (msg.data.kind === "ice" && msg.data.candidate) {
          if (pc.remoteDescription) await pc.addIceCandidate(msg.data.candidate).catch(() => {});
          else entry.pendingIce.push(msg.data.candidate);
        }
      } catch {
        /* peer went away mid-handshake */
      }
    },
    onMatchInvite: (msg) => setIncomingInvite(msg),
    onMatchDeclined: () => setPendingInviteTo(null),
    onMatchInviteExpired: () => setPendingInviteTo(null),
    onMatchStarted: (msg) => {
      setMatch(msg);
      setMatchResult(null);
      setIncomingInvite(null);
      setPendingInviteTo(null);
      setShowChallenge(false);
    },
    onMatchScore: (msg) => {
      setMatch((m) => (m && m.matchId === msg.matchId ? { ...m, scoreA: msg.scoreA, scoreB: msg.scoreB } : m));
    },
    onMatchEnded: (msg) => {
      setMatch(null);
      setMatchResult(msg);
      closeMatchPeers();
    },
    onMatchPeer: (msg) => {
      matchPeerIdRef.current = msg.peerId;
      if (msg.initiate) void connectViewer(msg.peerId, "match-peer");
    },
    onGuestRequest: (msg) => {
      setGuestRequests((prev) => [...prev.filter((r) => r.requestId !== msg.requestId), msg]);
    },
    onGuestRequestExpired: (msg) => {
      setGuestRequests((prev) => prev.filter((r) => r.requestId !== msg.requestId));
    },
    onGuestSeated: (msg) => {
      setGuestSeat({ peerId: msg.guestPeerId, user: msg.guest });
      setGuestRequests([]);
    },
    onGuestPeer: (msg) => {
      guestPeerIdRef.current = msg.peerId;
      if (msg.initiate) {
        // Replace the plain viewer connection to the guest with the
        // full-duplex guest connection.
        closePeer(msg.peerId);
        void connectViewer(msg.peerId, "guest-peer");
      }
    },
    onGuestLeft: (msg) => {
      closePeer(msg.guestPeerId);
      if (guestPeerIdRef.current === msg.guestPeerId) guestPeerIdRef.current = null;
      if (secondVideoRef.current) secondVideoRef.current.srcObject = null;
      setGuestSeat(null);
    },
  });
  const { sockRef } = room;

  useEffect(() => {
    peakRef.current = Math.max(peakRef.current, room.viewerCount);
  }, [room.viewerCount]);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = processorDead && processor?.sourceStream ? processor.sourceStream : stream;
    }
  }, [stream, processorDead, processor]);

  useEffect(() => {
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - session.started_at) / 1000)), 1000);
    return () => clearInterval(t);
  }, [session.started_at]);

  // Leaving this screen any other way: stop the camera and close peers.
  // (The socket close ends the live on the server too.) The processor's
  // stop() releases the canvas, its draw loop and the raw camera video
  // track it consumed; the stream cleanup below stops the rest.
  useEffect(
    () => () => {
      processor?.stop();
      stream.getTracks().forEach((t) => t.stop());
      for (const { pc } of pcsRef.current.values()) {
        try {
          pc.close();
        } catch {
          /* ignore */
        }
      }
      pcsRef.current.clear();
    },
    [stream, processor]
  );

  function clearEntryTimers(entry) {
    for (const key of ["disconnectTimer", "renegoTimer", "giveUpTimer"]) {
      if (entry[key]) {
        clearTimeout(entry[key]);
        entry[key] = null;
      }
    }
  }

  function closePeer(peerId) {
    const entry = pcsRef.current.get(peerId);
    if (entry) {
      clearEntryTimers(entry);
      try {
        entry.pc.close();
      } catch {
        /* ignore */
      }
      pcsRef.current.delete(peerId);
    }
  }

  function closeMatchPeers() {
    for (const [peerId, entry] of [...pcsRef.current.entries()]) {
      if (entry.kind === "match-viewer" || entry.kind === "match-peer") closePeer(peerId);
    }
    matchPeerIdRef.current = null;
    if (secondVideoRef.current) secondVideoRef.current.srcObject = null;
  }

  // Creates a peer connection to a viewer (or the match peer) and wires
  // its lifecycle. `initiator` peers are ones we offer to; the match peer
  // we answer is created by answerMatchPeer instead.
  //
  // TURN retry: a peer whose ICE connection fails (or stays disconnected)
  // is retried ONCE with iceTransportPolicy "relay" — the direct path is
  // preferred, the TURN relay is the fallback that works behind
  // carrier-grade NAT. Initiators re-offer with relay:true so the
  // answering side also goes relay-only; answerers ask the other side to
  // re-offer (the "renegotiate" signal).
  function wirePeer(peerId, kind, opts = {}) {
    const { relayOnly = false, retried = false, initiator = true } = opts;
    const pc = new RTCPeerConnection(peerConnectionConfig(relayOnly));
    const entry = { pc, pendingIce: [], kind, relayOnly, retried, initiator, disconnectTimer: null, renegoTimer: null, giveUpTimer: null, pairLogged: false };
    pcsRef.current.set(peerId, entry);
    // After a filter stall the room publishes the processor's raw source
    // stream instead of the (dead) processed one — for every later peer
    // too, not just the ones connected when the stall hit.
    const publishStream = rawFallbackRef.current && processor?.sourceStream ? processor.sourceStream : stream;
    for (const track of publishStream.getTracks()) pc.addTrack(track, publishStream);
    pc.ontrack = (e) => {
      if ((kind === "match-peer" || kind === "guest-peer") && secondVideoRef.current && e.streams[0]) {
        secondVideoRef.current.srcObject = e.streams[0];
      }
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) sockRef.current?.signal(peerId, { kind: "ice", candidate: e.candidate.toJSON() });
    };
    pc.oniceconnectionstatechange = () => monitorIce(peerId, entry);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected" && !entry.pairLogged) {
        entry.pairLogged = true;
        void logSelectedCandidatePair(pc, `broadcast ${kind}`);
      }
      if (pc.connectionState === "closed" && pcsRef.current.get(peerId) === entry) {
        clearEntryTimers(entry);
        pcsRef.current.delete(peerId);
      }
    };
    return entry;
  }

  function monitorIce(peerId, entry) {
    if (pcsRef.current.get(peerId) !== entry) return;
    const st = entry.pc.iceConnectionState;
    if (st === "connected" || st === "completed") {
      clearEntryTimers(entry);
    } else if (st === "disconnected") {
      clearTimeout(entry.disconnectTimer);
      entry.disconnectTimer = setTimeout(() => {
        if (pcsRef.current.get(peerId) === entry && entry.pc.iceConnectionState === "disconnected") onPeerIceFailed(peerId);
      }, 4000);
    } else if (st === "failed") {
      onPeerIceFailed(peerId);
    }
  }

  function onPeerIceFailed(peerId) {
    const entry = pcsRef.current.get(peerId);
    if (!entry) return;
    clearEntryTimers(entry);
    if (entry.retried) {
      // Already retried via relay and still failing — let it go (and
      // leave a trace in the server log for diagnosis).
      reportIce({ role: "broadcast", kind: entry.kind, state: "failed", relay: entry.relayOnly });
      closePeer(peerId);
      return;
    }
    entry.retried = true;
    if (entry.initiator) {
      const { kind } = entry;
      closePeer(peerId);
      room.pushMsg({ kind: "system", text: "🔄 Ek connection direct nahi ban saka — relay (TURN) se dobara koshish ho rahi hai…" });
      void connectViewer(peerId, kind, { relayOnly: true });
    } else {
      // We answered this peer, so we cannot re-offer; ask them to.
      entry.renegoTimer = setTimeout(() => {
        if (pcsRef.current.get(peerId) !== entry) return;
        sockRef.current?.signal(peerId, { kind: "renegotiate", relay: true });
        entry.giveUpTimer = setTimeout(() => {
          if (pcsRef.current.get(peerId) === entry) closePeer(peerId);
        }, 12000);
      }, 1200);
    }
  }

  async function connectViewer(peerId, kind = "viewer", opts = {}) {
    const sock = sockRef.current;
    if (!sock || pcsRef.current.has(peerId)) return;
    const { relayOnly = false } = opts;
    const { pc } = wirePeer(peerId, kind, { relayOnly, retried: relayOnly, initiator: true });
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sock.signal(peerId, { kind: "offer", description: pc.localDescription, relay: relayOnly || undefined });
    } catch {
      pcsRef.current.delete(peerId);
    }
  }

  async function answerMatchPeer(peerId, description, opts = {}) {
    const sock = sockRef.current;
    if (!sock) return;
    const { relayOnly = false } = opts;
    if (pcsRef.current.has(peerId)) closePeer(peerId);
    const entry = wirePeer(peerId, "match-peer", { relayOnly, retried: relayOnly, initiator: false });
    const { pc } = entry;
    try {
      await pc.setRemoteDescription(description);
      for (const cand of entry.pendingIce.splice(0)) {
        await pc.addIceCandidate(cand).catch(() => {});
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sock.signal(peerId, { kind: "answer", description: pc.localDescription });
    } catch {
      pcsRef.current.delete(peerId);
    }
  }

  async function toggleChallenge() {
    const next = !showChallenge;
    setShowChallenge(next);
    if (next) {
      const res = await call("listLive", {});
      if (res.ok) setOthers(res.lives.filter((l) => l.id !== session.id && !l.in_match));
    }
  }

  function sendInvite(live) {
    sockRef.current?.send({ type: "match-invite", toLiveSessionId: live.id });
    setPendingInviteTo(live.id);
  }

  function respondInvite(accept) {
    if (!incomingInvite) return;
    sockRef.current?.send({ type: "match-respond", inviteId: incomingInvite.inviteId, accept });
    setIncomingInvite(null);
  }

  function respondGuest(requestId, accept) {
    sockRef.current?.send({ type: "guest-respond", requestId, accept });
    setGuestRequests((prev) => prev.filter((r) => r.requestId !== requestId));
  }

  function removeGuest() {
    sockRef.current?.send({ type: "guest-remove" });
  }

  async function endLive() {
    if (endHandledRef.current) return;
    endHandledRef.current = true;
    setEnding(true);
    const res = await call("endLive", { live_session_id: session.id });
    const summary = res.ok
      ? res.summary
      : {
          live_session_id: session.id,
          duration_seconds: Math.floor((Date.now() - session.started_at) / 1000),
          peak_viewers: peakRef.current,
          total_gift_coins: 0,
          creator_earned_coins: earned,
          platform_cut_coins: 0,
        };
    onDone(summary);
  }

  const mySide = match ? (match.liveSessionA === session.id ? "a" : "b") : null;
  const opponent = match ? (mySide === "a" ? match.b : match.a) : null;
  // The stage splits for a PK opponent OR a seated guest (never both —
  // the server keeps the two exclusive).
  const splitView = Boolean(match || guestSeat);

  return (
    <div style={stageStyle}>
      {/* video layer: own camera fills the stage full-screen; with a
          seated guest it stacks top/bottom as before. In a PK match the
          layer becomes the framed BAND (see PK_BAND_HEIGHT): an in-flow
          row under the header/score-bar zone holding the two cameras
          side-by-side at 55% of the stage height, dark stage below. */}
      <div
        data-stage-layout={match ? "pk" : splitView ? "guest" : "single"}
        data-pk-band={match ? "" : undefined}
        style={
          match
            ? { position: "relative", order: 1, height: PK_BAND_HEIGHT, flexShrink: 0, display: "flex", flexDirection: "row" }
            : { position: "absolute", inset: 0, display: "flex", flexDirection: "column" }
        }
      >
        <div data-stage-tile="main" style={{ position: "relative", flex: 1, minHeight: 0, minWidth: 0 }}>
          <video ref={videoRef} autoPlay muted playsInline style={videoFillStyle} />
          {splitView && <div style={tileLabelStyle("rgba(0,0,0,0.65)")}>Tum · @{me.username}</div>}
        </div>
        {splitView && (
          <div
            data-stage-tile="second"
            style={{
              position: "relative",
              flex: 1,
              minHeight: 0,
              minWidth: 0,
              ...(match
                ? { borderLeft: "2px solid rgba(255,255,255,0.18)" }
                : { borderTop: "2px solid rgba(255,255,255,0.18)" }),
            }}
          >
            <video ref={secondVideoRef} autoPlay playsInline style={videoFillStyle} />
            {match ? (
              <div style={tileLabelStyle("rgba(224,36,94,0.85)")}>⚔️ @{opponent?.user?.username}</div>
            ) : (
              <>
                <div style={tileLabelStyle("rgba(0,0,0,0.65)")}>🪑 @{guestSeat?.user?.username} · Guest</div>
                <button
                  type="button"
                  onClick={removeGuest}
                  style={{ position: "absolute", right: 10, top: 10, background: "rgba(160,20,40,0.85)", color: "#fff", border: "none", borderRadius: 10, padding: "5px 10px", fontSize: 13, fontWeight: 700 }}
                >
                  ✕ Remove
                </button>
              </>
            )}
          </div>
        )}
      </div>

      <FloatingHearts hearts={hearts} />

      {/* gift animation: the room-wide overlay (host sees it too); in a
          PK match it hangs at the band's lower edge, not over the faces */}
      <GiftAnimationOverlay anim={room.giftAnim} bottom={match ? PK_GIFT_BOTTOM : undefined} />

      {/* header zone: top bar + the PK score bar pinned right under it */}
      <div style={{ position: "relative", zIndex: 6 }}>
        <div style={topBarStyle}>
          <LiveBadge />
        <strong style={{ flex: 1, minWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#fff", textShadow: "0 1px 4px rgba(0,0,0,0.9)" }}>{session.title}</strong>
        <span className="chip" style={darkChipStyle}>
          👀 {room.viewerCount}
        </span>
        <span className="chip" style={darkChipStyle} data-live-likes="">
          ❤️ {room.liveLikes}
        </span>
        <span className="chip" style={darkChipStyle}>
          ⏱ {formatDuration(elapsed)}
        </span>
        </div>

        {/* PK score bar pinned at the top of the stage, under the header */}
        {match && (
          <div style={{ padding: "0 10px", marginTop: -20 }}>
            <div style={{ background: "rgba(0,0,0,0.6)", borderRadius: 14, padding: "8px 12px", backdropFilter: "blur(3px)" }}>
              <MatchBar match={match} />
            </div>
          </div>
        )}
      </div>

      {/* floating status: session earnings + match result + errors */}
      <div style={noticeStackStyle}>
        <div style={{ justifySelf: "start", background: "rgba(0,0,0,0.55)", borderRadius: 10, padding: "6px 10px", fontSize: 14, color: "#fff" }}>
          🎁 Gifts earned: <strong>🪙 {earned}</strong> ({giftCount} gift{giftCount === 1 ? "" : "s"})
        </div>
        <MatchResultBanner result={matchResult} myUserId={me.id} />
        <Notice text={room.authError} bad />
      </div>

      {/* bottom overlay: challenge panel, chat, controls. In a PK match
          it orders itself after the band and pins to the stage bottom
          (marginTop auto), leaving the dark gap under the band. */}
      <div style={match ? { ...bottomOverlayStyle, order: 2, marginTop: "auto" } : bottomOverlayStyle}>
        {!splitView &&
          guestRequests.map((req) => (
            <div key={req.requestId} style={{ background: "rgba(8,40,60,0.85)", border: "1px solid #38bdf8", borderRadius: 14, padding: "10px 12px", backdropFilter: "blur(3px)" }}>
              <div style={{ fontSize: 15, color: "#fff" }}>
                🪑 <strong>@{req.from?.user?.username}</strong> live me bethna chahta hai!
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button className="btn btn-primary btn-small" onClick={() => respondGuest(req.requestId, true)}>
                  ✓ Accept — bethne do
                </button>
                <button className="btn btn-danger btn-small" onClick={() => respondGuest(req.requestId, false)}>
                  ✕ Decline
                </button>
              </div>
            </div>
          ))}
        {!splitView && incomingInvite && (
          <div style={{ background: "rgba(60,5,25,0.82)", border: "1px solid #e0245e", borderRadius: 14, padding: "10px 12px", backdropFilter: "blur(3px)" }}>
            <div style={{ fontSize: 15, color: "#fff" }}>
              ⚔️ <strong>@{incomingInvite.from?.user?.username}</strong> ne PK Match ka challenge bheja hai!
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button className="btn btn-primary btn-small" onClick={() => respondInvite(true)}>
                ✓ Accept — match shuru karo
              </button>
              <button className="btn btn-danger btn-small" onClick={() => respondInvite(false)}>
                ✕ Decline
              </button>
            </div>
          </div>
        )}
        {!splitView && !incomingInvite && pendingInviteTo && (
          <p style={{ color: "#fff", fontSize: 14, margin: 0, textShadow: "0 1px 4px rgba(0,0,0,0.9)" }}>⚔️ Challenge bhej diya hai — jawab ka intezar karo…</p>
        )}
        {!splitView && !incomingInvite && !pendingInviteTo && showChallenge && (
          <div style={{ background: "rgba(15,15,15,0.85)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 14, padding: 10, display: "grid", gap: 8, backdropFilter: "blur(3px)", maxHeight: "38dvh", overflowY: "auto" }}>
            {others.length === 0 && <p style={{ color: "rgba(255,255,255,0.75)", fontSize: 14, margin: 0 }}>Abhi koi aur broadcaster live nahi hai.</p>}
            {others.map((l) => (
              <div key={l.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Avatar user={l.broadcaster} size={34} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <strong style={{ fontSize: 14, color: "#fff" }}>@{l.broadcaster?.username}</strong> <OwnerBadge user={l.broadcaster} />
                  <div style={{ color: "rgba(255,255,255,0.65)", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.title}</div>
                </div>
                <button className="btn btn-primary btn-small" onClick={() => sendInvite(l)}>
                  ⚔️ Challenge
                </button>
              </div>
            ))}
          </div>
        )}
        <ChatFeed messages={room.messages} />
        <div style={bottomBarStyle}>
          <ChatInput onSend={room.sendChat} disabled={!room.connected} placeholder="Viewers se baat karo…" />
          {!splitView && (
            <button type="button" onClick={toggleChallenge} style={roundBtnStyle} aria-label="PK Match challenge" title="PK Match challenge">
              ⚔️
            </button>
          )}
          <button type="button" onClick={() => setShowFilters(true)} style={roundBtnStyle} aria-label="Filters" title="Face filters">
            🎨
          </button>
          <button className="btn btn-danger" onClick={endLive} disabled={ending} style={{ borderRadius: 999, padding: "11px 16px", fontSize: 15, fontWeight: 800, whiteSpace: "nowrap", flexShrink: 0 }}>
            {ending ? "Ending…" : "⏹ End Live"}
          </button>
        </div>
      </div>
      {showFilters && <FilterSheet activeKey={filterKey} supported={Boolean(processor) && !processorDead} onPick={pickFilter} onClose={() => setShowFilters(false)} />}
    </div>
  );
}

// ---- watch room -----------------------------------------------------------------

function WatchRoom({ me, session, refreshMe, onBack }) {
  const videoRef = useRef(null);
  const secondVideoRef = useRef(null);
  const pcsRef = useRef(new Map()); // peerId -> { pc, pendingIce, kind: "main" | "match" }
  const mainPeerRef = useRef(null);
  const matchPeerRef = useRef(null);
  const [detail, setDetail] = useState(null);
  const [balance, setBalance] = useState(me.coin_balance ?? 0);
  const [giftBusy, setGiftBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [videoError, setVideoError] = useState("");
  const [videoStatus, setVideoStatus] = useState("");
  const [needsTap, setNeedsTap] = useState(false);
  // Sound ON by default: the only mute that exists is the viewer's own
  // persisted choice (sound.js), or a temporary browser-forced muted
  // start (forcedMute) that offers the "🔊 Sound on" overlay.
  const [muted, setMuted] = useState(() => viewerMuted());
  const [forcedMute, setForcedMute] = useState(false);
  const [showGifts, setShowGifts] = useState(false);
  // Follow (same toggleFollow RPC as profiles/feed)
  const [following, setFollowing] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  // Guest seat: who is seated (anyone), my pending request, and my own
  // publishing state when I am the guest.
  const [seatedGuest, setSeatedGuest] = useState(null);
  const [joinPending, setJoinPending] = useState(false);
  const [amGuest, setAmGuest] = useState(false);
  const seatedGuestRef = useRef(null);
  const guestStreamRef = useRef(null);
  // The guest's raw camera stream + its filter processor: guestStreamRef
  // holds the processor's (filtered) stream — the raw one only when this
  // browser can't process video — and every publish path reads
  // guestStreamRef, so viewers receive the filtered picture.
  const guestRawRef = useRef(null);
  const guestProcessorRef = useRef(null);
  const myVideoRef = useRef(null);
  const amGuestRef = useRef(false);
  // Face filter (only while I am the seated guest).
  const [guestFilterKey, setGuestFilterKey] = useState(() => getLiveFilter());
  const [showGuestFilters, setShowGuestFilters] = useState(false);
  // Tap-tap likes: hearts at my tap points + a batched sender (taps are
  // counted locally and flushed to the server every 250ms, so a fast
  // tapper sends one small message per burst, not one per tap — the
  // server clamps and rate-limits regardless).
  const { hearts, spawnHeart } = useFloatingHearts();
  const pendingLikesRef = useRef(0);
  const likeFlushRef = useRef(0);

  function queueLike() {
    pendingLikesRef.current += 1;
    if (!likeFlushRef.current) {
      likeFlushRef.current = setTimeout(() => {
        likeFlushRef.current = 0;
        const n = pendingLikesRef.current;
        pendingLikesRef.current = 0;
        if (n > 0) sockRef.current?.like(Math.min(n, 10));
      }, 250);
    }
  }

  // A tap on the broadcaster's video = a like (TikTok-style). The host
  // never likes their own stream (the server also refuses broadcaster
  // sockets); a seated guest CAN like — they are a viewer of the host.
  function handleStageTap(e) {
    if (room.ended || detail?.is_mine) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = rect.width ? ((e.clientX - rect.left) / rect.width) * 100 : 50;
    const y = rect.height ? ((e.clientY - rect.top) / rect.height) * 100 : 50;
    spawnHeart(x, y);
    queueLike();
  }

  function pickGuestFilter(key) {
    setGuestFilterKey(key);
    setLiveFilter(key);
    guestProcessorRef.current?.setFilter(key);
  }

  // Release the guest capture chain: processor (canvas + raw video
  // track), then both streams' remaining tracks. Safe to call twice.
  function stopGuestCapture() {
    guestProcessorRef.current?.stop();
    guestProcessorRef.current = null;
    guestStreamRef.current?.getTracks().forEach((t) => t.stop());
    guestStreamRef.current = null;
    guestRawRef.current?.getTracks().forEach((t) => t.stop());
    guestRawRef.current = null;
  }
  // PK match state
  const [match, setMatch] = useState(null);
  const [matchResult, setMatchResult] = useState(null);

  const room = useLiveRoom(session.id, {
    onLiveLikes: (msg) => {
      // Someone else's likes: one heart floats up the right side. (My
      // own taps already spawned hearts at the tap points.)
      if (msg.fromPeerId && msg.fromPeerId !== sockRef.current?.peerId) {
        spawnHeart(76 + Math.random() * 16, 66);
      }
    },
    onJoined: (msg) => {
      if (msg.broadcasterPeerId) mainPeerRef.current = msg.broadcasterPeerId;
      if (msg.guestPeerId) {
        seatedGuestRef.current = msg.guestPeerId;
        setSeatedGuest({ peerId: msg.guestPeerId, user: msg.guest });
      }
    },
    onBroadcasterJoined: (msg) => {
      if (msg.matchId) matchPeerRef.current = msg.peerId;
      else mainPeerRef.current = msg.peerId;
    },
    onViewerJoined: (msg) => {
      // While I am the seated guest, every (new) viewer gets my stream.
      if (amGuestRef.current) void publishToViewer(msg.peerId);
    },
    onGuestSeated: (msg) => {
      seatedGuestRef.current = msg.guestPeerId;
      setSeatedGuest({ peerId: msg.guestPeerId, user: msg.guest });
      if (msg.guestPeerId === sockRef.current?.peerId) {
        setJoinPending(false);
        void becomeGuest();
      }
    },
    onGuestDeclined: () => {
      setJoinPending(false);
      setNotice("Host ne tumhari join request decline kar di.");
    },
    onGuestRequestExpired: () => setJoinPending(false),
    onGuestLeft: (msg) => {
      if (seatedGuestRef.current === msg.guestPeerId) seatedGuestRef.current = null;
      setSeatedGuest(null);
      const entry = pcsRef.current.get(msg.guestPeerId);
      if (entry && entry.kind === "guest") closePcEntry(msg.guestPeerId, entry);
      if (secondVideoRef.current) secondVideoRef.current.srcObject = null;
      if (amGuestRef.current && msg.guestPeerId === sockRef.current?.peerId) endGuesting(msg.removed === true);
    },
    onSignal: async (msg) => {
      if (!msg.data) return;
      if (msg.data.kind === "renegotiate") {
        // A viewer of my guest stream asks me to re-offer via TURN relay.
        const entry = pcsRef.current.get(msg.from);
        if (entry?.kind === "guest-viewer") {
          closePcEntry(msg.from, entry);
          void publishToViewer(msg.from, { relayOnly: true });
        }
        return;
      }
      if (msg.data.kind === "offer" && msg.data.description) {
        const kind = msg.from === mainPeerRef.current ? "main" : msg.from === seatedGuestRef.current ? "guest" : "match";
        await answerOffer(msg.from, msg.data.description, kind, { relayOnly: !!msg.data.relay });
      } else if (msg.data.kind === "answer" && msg.data.description) {
        // Answers to my guest-publishing offers.
        const entry = pcsRef.current.get(msg.from);
        if (entry) {
          try {
            await entry.pc.setRemoteDescription(msg.data.description);
            for (const cand of entry.pendingIce.splice(0)) {
              await entry.pc.addIceCandidate(cand).catch(() => {});
            }
          } catch {
            /* peer went away mid-handshake */
          }
        }
      } else if (msg.data.kind === "ice" && msg.data.candidate) {
        const entry = pcsRef.current.get(msg.from);
        if (entry) {
          if (entry.pc.remoteDescription) await entry.pc.addIceCandidate(msg.data.candidate).catch(() => {});
          else entry.pendingIce.push(msg.data.candidate);
        }
      }
    },
    onMatchStarted: (msg) => {
      setMatch(msg);
      setMatchResult(null);
    },
    onMatchScore: (msg) => {
      setMatch((m) => (m && m.matchId === msg.matchId ? { ...m, scoreA: msg.scoreA, scoreB: msg.scoreB } : m));
    },
    onMatchEnded: (msg) => {
      setMatch(null);
      setMatchResult(msg);
      closeMatchPcs();
    },
    onEnded: () => {
      closeAllPcs();
      stopGuestCapture();
    },
  });
  const { sockRef } = room;

  const loadDetail = useCallback(async () => {
    const res = await call("getLive", { live_session_id: session.id });
    if (res.ok) {
      setDetail(res);
      setBalance(res.my_coin_balance);
      if (typeof res.broadcaster_followed === "boolean") setFollowing(res.broadcaster_followed);
      // Adopt the server's ICE list (STUN + TURN) for peer connections.
      setIceServers(res.ice_servers);
    }
  }, [session.id]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  useEffect(
    () => () => {
      closeAllPcs();
      stopGuestCapture();
      if (likeFlushRef.current) clearTimeout(likeFlushRef.current);
    },
    []
  );

  // My local preview tile (shown while I am the seated guest).
  useEffect(() => {
    if (myVideoRef.current && guestStreamRef.current) myVideoRef.current.srcObject = guestStreamRef.current;
  }, [amGuest]);

  function clearEntryTimers(entry) {
    for (const key of ["disconnectTimer", "renegoTimer", "giveUpTimer"]) {
      if (entry[key]) {
        clearTimeout(entry[key]);
        entry[key] = null;
      }
    }
  }

  function closePcEntry(peerId, entry) {
    clearEntryTimers(entry);
    try {
      entry.pc.close();
    } catch {
      /* ignore */
    }
    if (pcsRef.current.get(peerId) === entry) pcsRef.current.delete(peerId);
  }

  function closeAllPcs() {
    for (const [peerId, entry] of [...pcsRef.current.entries()]) closePcEntry(peerId, entry);
    pcsRef.current.clear();
  }

  function closeMatchPcs() {
    for (const [peerId, entry] of [...pcsRef.current.entries()]) {
      if (entry.kind === "match") closePcEntry(peerId, entry);
    }
    matchPeerRef.current = null;
    if (secondVideoRef.current) secondVideoRef.current.srcObject = null;
  }

  function showVideoFailure(kind) {
    reportIce({ role: "watch", kind, state: "failed" });
    setVideoStatus("");
    if (kind === "main") setVideoError("Video connection nahi ban saka — is network par direct (P2P) connection mushkil hai. Chat phir bhi chal raha hai.");
    else if (kind === "guest") setVideoError("Guest ki video connect nahi ho saki — chat phir bhi chal raha hai.");
    else setVideoError("PK wale broadcaster ki video connect nahi ho saki — chat aur score phir bhi chal rahe hain.");
  }

  // First ICE failure on a publisher connection: ask the publisher to
  // re-offer through a TURN relay (direct is tried first; relay is the
  // fallback that works behind carrier-grade NAT). If the publisher's
  // own retry offer arrives first, it replaces this entry and wins.
  function onPeerIceFailed(fromPeerId, entry) {
    if (pcsRef.current.get(fromPeerId) !== entry) return;
    if (entry.relayOnly) {
      // This WAS the relay attempt — nothing left to try.
      showVideoFailure(entry.kind);
      return;
    }
    setVideoError("");
    setVideoStatus("Video connect ho raha hai… relay (TURN) se dobara koshish ho rahi hai.");
    entry.renegoTimer = setTimeout(() => {
      sockRef.current?.signal(fromPeerId, { kind: "renegotiate", relay: true });
    }, 1200);
    entry.giveUpTimer = setTimeout(() => {
      if (pcsRef.current.get(fromPeerId) === entry) showVideoFailure(entry.kind);
    }, 15000);
  }

  async function answerOffer(fromPeerId, description, kind, opts = {}) {
    const sock = sockRef.current;
    if (!sock) return;
    const { relayOnly = false } = opts;
    const existing = pcsRef.current.get(fromPeerId);
    if (existing) closePcEntry(fromPeerId, existing);
    setVideoStatus("Video connect ho raha hai…");
    const pc = new RTCPeerConnection(peerConnectionConfig(relayOnly));
    const entry = { pc, pendingIce: [], kind, relayOnly, disconnectTimer: null, renegoTimer: null, giveUpTimer: null, pairLogged: false };
    pcsRef.current.set(fromPeerId, entry);
    // While I am the seated guest, the connection to the host is
    // full-duplex: my camera/mic rides on it too.
    if (kind === "main" && guestStreamRef.current) {
      for (const track of guestStreamRef.current.getTracks()) pc.addTrack(track, guestStreamRef.current);
    }
    pc.ontrack = (e) => {
      const video = kind === "main" ? videoRef.current : secondVideoRef.current;
      if (video && e.streams[0]) {
        video.srcObject = e.streams[0];
        if (kind === "main") {
          // Start with sound per the viewer's preference. If the
          // browser blocks autoplay-with-sound (no interaction yet),
          // fall back to a muted start + the Sound on overlay.
          video.muted = viewerMuted();
          setMuted(video.muted);
          video.play().catch(() => {
            if (!video.muted) {
              video.muted = true;
              setMuted(true);
              setForcedMute(true);
              video.play().catch(() => setNeedsTap(true));
            } else {
              setNeedsTap(true);
            }
          });
        } else {
          video.play().catch(() => {});
        }
      }
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) sock.signal(fromPeerId, { kind: "ice", candidate: e.candidate.toJSON() });
    };
    pc.oniceconnectionstatechange = () => {
      if (pcsRef.current.get(fromPeerId) !== entry) return;
      const st = pc.iceConnectionState;
      if (st === "connected" || st === "completed") {
        clearEntryTimers(entry);
        setVideoStatus("");
        if (kind === "main") setVideoError("");
        if (!entry.pairLogged) {
          entry.pairLogged = true;
          void logSelectedCandidatePair(pc, `watch ${kind}`);
        }
      } else if (st === "disconnected") {
        clearTimeout(entry.disconnectTimer);
        entry.disconnectTimer = setTimeout(() => {
          if (pcsRef.current.get(fromPeerId) === entry && pc.iceConnectionState === "disconnected") onPeerIceFailed(fromPeerId, entry);
        }, 4000);
      } else if (st === "failed") {
        onPeerIceFailed(fromPeerId, entry);
      }
    };
    try {
      await pc.setRemoteDescription(description);
      for (const cand of entry.pendingIce.splice(0)) {
        await pc.addIceCandidate(cand).catch(() => {});
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sock.signal(fromPeerId, { kind: "answer", description: pc.localDescription });
    } catch {
      if (kind === "main") setVideoError("Video connection nahi ban saka — chat phir bhi chal raha hai.");
    }
  }

  // ---- guest seat (I am the guest) -------------------------------------------
  // Accepted by the host: grab camera/mic, then tell the server I am
  // ready to publish. Denial aborts the seat — I stay a plain viewer and
  // my normal viewer connection to the host was never touched.

  async function becomeGuest() {
    if (!navigator.mediaDevices?.getUserMedia) {
      sockRef.current?.send({ type: "guest-abort" });
      setError("Is browser me camera support nahi hai — tum viewer hi rahoge.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      guestRawRef.current = stream;
      // Run the camera through the filter processor; publish its stream
      // (or the raw camera when this browser can't process video).
      const proc = createVideoProcessor(stream, getLiveFilter());
      guestProcessorRef.current = proc;
      guestStreamRef.current = proc ? proc.stream : stream;
      if (proc) {
        setGuestFilterKey(proc.filter);
        // Same safety net as the host path: a filter pipeline that
        // produces no frames (or stalls) must never leave viewers with
        // a black rectangle — swap every sender carrying the processed
        // track to the raw camera track and halt the processor.
        proc.setOnStall(() => {
          const rawTrack = stream.getVideoTracks()[0];
          const processedTrack = guestStreamRef.current?.getVideoTracks?.()[0];
          if (rawTrack && processedTrack && rawTrack !== processedTrack) {
            for (const entry of pcsRef.current.values()) {
              for (const sender of entry.pc.getSenders()) {
                if (sender.track === processedTrack) sender.replaceTrack(rawTrack).catch(() => {});
              }
            }
          }
          proc.halt();
          if (guestProcessorRef.current === proc) guestProcessorRef.current = null;
          // Future offers publish the raw stream too, not the dead one.
          guestStreamRef.current = stream;
          setShowGuestFilters(false);
          setNotice("Filter ruk gaya tha — tumhari video ab seedhi camera se chal rahi hai.");
        });
      }
      amGuestRef.current = true;
      setAmGuest(true);
      sockRef.current?.send({ type: "guest-ready" });
    } catch {
      sockRef.current?.send({ type: "guest-abort" });
      setError("Camera/mic ki ijazat nahi mili — tum viewer hi rahoge.");
    }
  }

  function endGuesting(removed = false) {
    if (!amGuestRef.current) return;
    amGuestRef.current = false;
    setAmGuest(false);
    setJoinPending(false);
    setShowGuestFilters(false);
    stopGuestCapture();
    for (const [peerId, entry] of [...pcsRef.current.entries()]) {
      if (entry.kind === "guest-viewer") closePcEntry(peerId, entry);
    }
    // The host connection is replaced by the broadcaster's fresh
    // plain-viewer offer (the server re-notifies them on guest-left).
    const hostPeer = mainPeerRef.current;
    const hostEntry = hostPeer ? pcsRef.current.get(hostPeer) : null;
    if (hostEntry) closePcEntry(hostPeer, hostEntry);
    if (myVideoRef.current) myVideoRef.current.srcObject = null;
    if (removed) setNotice("Host ne tumhe live se hata diya — tum ab sirf viewer ho.");
  }

  function leaveSeat() {
    sockRef.current?.send({ type: "guest-leave" });
    endGuesting(false);
  }

  function requestJoin() {
    if (joinPending || seatedGuest || room.ended) return;
    setError("");
    setNotice("");
    sockRef.current?.send({ type: "guest-request" });
    setJoinPending(true);
  }

  // While seated I offer my stream to every viewer; they answer and
  // receive it. Same ICE + one-relay-retry policy as every other peer.
  async function publishToViewer(peerId, opts = {}) {
    const sock = sockRef.current;
    const stream = guestStreamRef.current;
    if (!sock || !stream || pcsRef.current.has(peerId)) return;
    const { relayOnly = false } = opts;
    const pc = new RTCPeerConnection(peerConnectionConfig(relayOnly));
    const entry = { pc, pendingIce: [], kind: "guest-viewer", relayOnly, retried: relayOnly, disconnectTimer: null, renegoTimer: null, giveUpTimer: null, pairLogged: false };
    pcsRef.current.set(peerId, entry);
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    pc.onicecandidate = (e) => {
      if (e.candidate) sock.signal(peerId, { kind: "ice", candidate: e.candidate.toJSON() });
    };
    pc.oniceconnectionstatechange = () => {
      if (pcsRef.current.get(peerId) !== entry) return;
      const st = pc.iceConnectionState;
      if (st === "connected" || st === "completed") {
        clearEntryTimers(entry);
        if (!entry.pairLogged) {
          entry.pairLogged = true;
          void logSelectedCandidatePair(pc, "guest publish");
        }
      } else if (st === "disconnected") {
        clearTimeout(entry.disconnectTimer);
        entry.disconnectTimer = setTimeout(() => {
          if (pcsRef.current.get(peerId) === entry && pc.iceConnectionState === "disconnected") retryGuestPublish(peerId, entry);
        }, 4000);
      } else if (st === "failed") {
        retryGuestPublish(peerId, entry);
      }
    };
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sock.signal(peerId, { kind: "offer", description: pc.localDescription, relay: relayOnly || undefined });
    } catch {
      pcsRef.current.delete(peerId);
    }
  }

  function retryGuestPublish(peerId, entry) {
    if (pcsRef.current.get(peerId) !== entry) return;
    clearEntryTimers(entry);
    closePcEntry(peerId, entry);
    if (!entry.retried) void publishToViewer(peerId, { relayOnly: true });
    else reportIce({ role: "guest-publish", kind: "guest-viewer", state: "failed", relay: true });
  }

  async function toggleFollow() {
    if (!broadcaster?.id || followBusy || detail?.is_mine) return;
    setFollowBusy(true);
    const res = await call("toggleFollow", { user_id: broadcaster.id });
    setFollowBusy(false);
    if (res.ok) setFollowing(res.following);
  }

  // The speaker button is the viewer's own control — their pick becomes
  // the persisted default for every player in the app.
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
    const v = videoRef.current;
    if (v) {
      v.muted = false;
      v.play().catch(() => {});
    }
  }

  async function sendGift(gift) {
    if (room.ended) {
      setError(ENDED_TEXT);
      return;
    }
    setGiftBusy(gift.key);
    setError("");
    setNotice("");
    const res = await call("sendGift", { live_session_id: session.id, gift_key: gift.key });
    setGiftBusy("");
    if (!res.ok) {
      setError(res.message || "Gift nahi bheja ja saka.");
      if (typeof res.my_balance === "number") setBalance(res.my_balance);
      return;
    }
    setNotice(res.message);
    if (typeof res.my_balance === "number") setBalance(res.my_balance);
    refreshMe?.();
  }

  const gifts = detail?.gifts ?? [];
  const broadcaster = detail?.session?.broadcaster ?? session.broadcaster;
  const matchOpponent = match ? (match.liveSessionA === session.id ? match.b : match.a) : null;

  return (
    <div style={stageStyle}>
      {/* video layer: the broadcaster fills the stage full-screen; with
          a seated guest it stacks top/bottom as before. In a PK match
          the layer becomes the framed BAND (see PK_BAND_HEIGHT): an
          in-flow row under the header/score-bar zone holding the two
          cameras side-by-side at 55% of the stage height, dark below. */}
      <div
        data-stage-layout={match ? "pk" : seatedGuest ? "guest" : "single"}
        data-pk-band={match ? "" : undefined}
        style={
          match
            ? { position: "relative", order: 1, height: PK_BAND_HEIGHT, flexShrink: 0, display: "flex", flexDirection: "row" }
            : { position: "absolute", inset: 0, display: "flex", flexDirection: "column" }
        }
      >
        <div data-stage-tile="main" style={{ position: "relative", flex: 1, minHeight: 0, minWidth: 0 }} onClick={handleStageTap}>
          <video ref={videoRef} autoPlay playsInline muted={muted} style={videoFillStyle} />
          <FloatingHearts hearts={hearts} />
          {room.ended ? (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.7)", fontSize: 18, fontWeight: 700, color: "#fff" }}>
              📴 {ENDED_TEXT}
            </div>
          ) : needsTap ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                const v = videoRef.current;
                if (v && !viewerMuted()) {
                  v.muted = false;
                  setMuted(false);
                  setForcedMute(false);
                }
                v?.play().catch(() => {});
                setNeedsTap(false);
              }}
              style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.45)", color: "#fff", border: "none", fontSize: 20, fontWeight: 700 }}
            >
              ▶ Tap to play
            </button>
          ) : null}
          {forcedMute && !room.ended && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                soundOn();
              }}
              style={{
                position: "absolute",
                left: "50%",
                bottom: 16,
                transform: "translateX(-50%)",
                background: "rgba(0,0,0,0.72)",
                color: "#fff",
                border: "1px solid rgba(255,255,255,0.45)",
                borderRadius: 999,
                padding: "9px 18px",
                fontSize: 15,
                fontWeight: 700,
                whiteSpace: "nowrap",
                zIndex: 3,
              }}
            >
              🔊 Sound on
            </button>
          )}
          {match && <div style={tileLabelStyle("rgba(0,0,0,0.65)")}>@{broadcaster?.username}</div>}
        </div>
        {(match || seatedGuest) && (
          <div
            data-stage-tile="second"
            style={{
              position: "relative",
              flex: 1,
              minHeight: 0,
              minWidth: 0,
              ...(match
                ? { borderLeft: "2px solid rgba(255,255,255,0.18)" }
                : { borderTop: "2px solid rgba(255,255,255,0.18)" }),
            }}
          >
            {amGuest ? (
              <video ref={myVideoRef} autoPlay muted playsInline style={videoFillStyle} />
            ) : (
              <video ref={secondVideoRef} autoPlay playsInline style={videoFillStyle} />
            )}
            {match ? (
              <div style={tileLabelStyle("rgba(224,36,94,0.85)")}>⚔️ @{matchOpponent?.user?.username}</div>
            ) : (
              <div style={tileLabelStyle("rgba(0,0,0,0.65)")}>🪑 {amGuest ? "Tum (Guest)" : `@${seatedGuest?.user?.username} · Guest`}</div>
            )}
          </div>
        )}
      </div>

      {/* gift animation: the room-wide overlay (viewers + seated guest);
          in a PK match it hangs at the band's lower edge, not over faces */}
      <GiftAnimationOverlay anim={room.giftAnim} bottom={match ? PK_GIFT_BOTTOM : undefined} />

      {/* header zone: top bar + the PK score bar pinned right under it */}
      <div style={{ position: "relative", zIndex: 6 }}>
        <div style={topBarStyle}>
          <button
          className="btn btn-small"
          onClick={onBack}
          style={{ background: "rgba(20,20,20,0.6)", borderColor: "rgba(255,255,255,0.3)", color: "#fff", backdropFilter: "blur(3px)" }}
        >
          ← Leave
        </button>
        <LiveBadge />
        <strong style={{ flex: 1, minWidth: 90, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#fff", textShadow: "0 1px 4px rgba(0,0,0,0.9)" }}>{session.title}</strong>
        <span className="chip" style={darkChipStyle}>
          👀 {room.viewerCount}
        </span>
        <span className="chip" style={darkChipStyle} data-live-likes="">
          ❤️ {room.liveLikes}
        </span>
        <span className="chip" style={darkChipStyle}>
          🪙 {balance}
        </span>
        <div style={{ flexBasis: "100%", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Avatar user={broadcaster} size={30} />
          <span style={{ fontSize: 14, color: "#fff", textShadow: "0 1px 4px rgba(0,0,0,0.9)" }}>
            {broadcaster?.display_name} <span style={{ color: "rgba(255,255,255,0.7)" }}>@{broadcaster?.username}</span>
          </span>
          <OwnerBadge user={broadcaster} />
          {!detail?.is_mine && broadcaster?.id && (
            <button
              type="button"
              className={following ? "btn btn-small" : "btn btn-primary btn-small"}
              onClick={toggleFollow}
              disabled={followBusy}
              style={following ? { background: "rgba(20,20,20,0.6)", borderColor: "rgba(255,255,255,0.3)", color: "#fff" } : undefined}
            >
              {following ? "✓ Following" : "+ Follow"}
            </button>
          )}
          {!detail?.is_mine && (
            <button
              type="button"
              className="btn btn-small"
              onClick={() => setReportOpen(true)}
              style={{ background: "rgba(20,20,20,0.6)", borderColor: "rgba(255,255,255,0.3)", color: "#fff" }}
              title="Report this live"
            >
              🚩 Report
            </button>
          )}
          {amGuest ? (
            <button type="button" className="btn btn-danger btn-small" onClick={leaveSeat}>
              🚪 Leave seat
            </button>
          ) : seatedGuest ? (
            <span style={{ fontSize: 13, color: "rgba(255,255,255,0.85)", textShadow: "0 1px 4px rgba(0,0,0,0.9)" }}>
              🪑 Guest: @{seatedGuest.user?.username}
            </span>
          ) : joinPending ? (
            <span style={{ fontSize: 13, color: "rgba(255,255,255,0.85)", textShadow: "0 1px 4px rgba(0,0,0,0.9)" }}>🪑 Request bheja… host ke jawab ka intezar karo</span>
          ) : (
            <button type="button" className="btn btn-primary btn-small" onClick={requestJoin} disabled={!room.connected || room.ended} style={{ background: "#38bdf8", borderColor: "#38bdf8" }}>
              🪑 Join Live
            </button>
          )}
        </div>
      </div>

        {/* PK score bar pinned at the top of the stage, under the header */}
        {match && (
          <div style={{ padding: "0 10px", marginTop: -20 }}>
            <div style={{ background: "rgba(0,0,0,0.6)", borderRadius: 14, padding: "8px 12px", backdropFilter: "blur(3px)" }}>
              <MatchBar match={match} />
            </div>
          </div>
        )}
      </div>

      {/* floating status: connecting / errors / results */}
      <div style={noticeStackStyle}>
        <MatchResultBanner result={matchResult} myUserId={me.id} />
        <Notice text={videoStatus} />
        <Notice text={videoError} bad />
        <Notice text={room.authError} bad />
        <Notice text={error} bad />
        <Notice text={notice} />
      </div>

      {/* bottom overlay: chat + actions. In a PK match it orders itself
          after the band and pins to the stage bottom (marginTop auto),
          leaving the dark gap under the band. */}
      <div style={match ? { ...bottomOverlayStyle, order: 2, marginTop: "auto" } : bottomOverlayStyle}>
        <ChatFeed messages={room.messages} />
        <div style={bottomBarStyle}>
          <ChatInput onSend={room.sendChat} disabled={!room.connected || room.ended} placeholder="Chat me kuch likho…" />
          <button type="button" onClick={() => setShowGifts(true)} disabled={room.ended || gifts.length === 0} style={{ ...roundBtnStyle, opacity: room.ended || gifts.length === 0 ? 0.5 : 1 }} aria-label="Gifts" title="Gift bhejo">
            🎁
          </button>
          {amGuest && (
            <button type="button" onClick={() => setShowGuestFilters(true)} style={roundBtnStyle} aria-label="Filters" title="Face filters">
              🎨
            </button>
          )}
          <button type="button" onClick={toggleMute} style={roundBtnStyle} aria-label="Sound">
            {muted ? "🔇" : "🔊"}
          </button>
        </div>
      </div>
      {showGuestFilters && amGuest && (
        <FilterSheet activeKey={guestFilterKey} supported={Boolean(guestProcessorRef.current)} onPick={pickGuestFilter} onClose={() => setShowGuestFilters(false)} />
      )}

      {/* gift bottom sheet over the video */}
      {reportOpen && <ReportDialog targetType="live" targetId={session.id} label="live" onClose={() => setReportOpen(false)} />}
      {showGifts && !room.ended && gifts.length > 0 && (
        <>
          <div onClick={() => setShowGifts(false)} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 7 }} />
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 8,
              background: "var(--surface)",
              borderTop: "1px solid var(--border)",
              borderRadius: "18px 18px 0 0",
              padding: "14px 14px calc(14px + env(safe-area-inset-bottom))",
              animation: "zoomly-sheet-up 0.22s ease-out",
              maxHeight: "62dvh",
              overflowY: "auto",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <strong style={{ fontSize: 16, flex: 1 }}>🎁 Gift bhejo</strong>
              <span className="chip">🪙 {balance}</span>
              <button type="button" className="btn btn-small" onClick={() => setShowGifts(false)} aria-label="Close gifts">
                ✕
              </button>
            </div>
            <div style={{ fontSize: 13, color: "var(--dim)", margin: "8px 0 10px" }}>
              Gift ke 70% coins broadcaster ka hissa hain (fraction poora hone par poore coins balance me aayenge){match ? ", aur poori value uski PK score me judegi" : ""}. Tumhara balance:{" "}
              <strong style={{ color: "var(--text)" }}>🪙 {balance}</strong>
            </div>
            <Notice text={error} bad />
            <Notice text={notice} />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginTop: 6 }}>
              {gifts.map((gift) => (
                <button
                  key={gift.key}
                  className="card"
                  onClick={() => sendGift(gift)}
                  disabled={giftBusy === gift.key}
                  style={{ padding: "8px 4px", textAlign: "center", cursor: "pointer", color: "var(--text)", opacity: giftBusy && giftBusy !== gift.key ? 0.6 : 1 }}
                >
                  <div style={{ fontSize: 24 }}>{gift.emoji}</div>
                  <div style={{ fontSize: 12, fontWeight: 700 }}>{gift.name}</div>
                  <div style={{ fontSize: 12, color: "var(--dim)" }}>🪙 {gift.coins.toLocaleString()}</div>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---- end-of-live summary -----------------------------------------------------------

function EndSummary({ summary, onClose }) {
  return (
    <div style={{ padding: "28px 14px", maxWidth: 520, margin: "0 auto", textAlign: "center" }}>
      <div style={{ fontSize: 44 }}>🎉</div>
      <h2 style={{ margin: "8px 0 4px" }}>Live khatam!</h2>
      <p style={{ color: "var(--dim)", marginTop: 0 }}>Bohut khoob — ye raha tumhari live ka khulasa:</p>
      <div className="card" style={{ display: "grid", gap: 10, textAlign: "left", marginTop: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: "var(--dim)" }}>⏱ Duration</span>
          <strong>{formatDuration(summary.duration_seconds)}</strong>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: "var(--dim)" }}>👀 Peak viewers</span>
          <strong>{summary.peak_viewers}</strong>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: "var(--dim)" }}>🎁 Total gifts</span>
          <strong>🪙 {summary.total_gift_coins}</strong>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: "var(--dim)" }}>💰 Tumhari kamai (70%)</span>
          <strong style={{ color: "var(--accent)" }}>🪙 {summary.creator_earned_coins}</strong>
        </div>
      </div>
      <p style={{ color: "var(--dim)", fontSize: 13 }}>Tumhari kamai tumhare coin balance me add ho chuki hai.</p>
      <button className="btn btn-primary" onClick={onClose} style={{ padding: "12px 22px", fontSize: 16, marginTop: 8 }}>
        Back to Live
      </button>
    </div>
  );
}

// ---- Broad (voice) rooms -----------------------------------------------------------
// Audio-only live rooms: a host plus up to 6 seated speakers, everyone
// else listening. The peer topology mirrors the video rooms' mesh —
// publishers initiate to each member — with three simplifications:
// no video track is ever captured or sent, one connection kind set
// ("listener" send-only, "seat"/"seat-host" full-duplex), and remote
// media renders as hidden <audio> elements instead of a video stage.
// Microphones are OPEN BY DEFAULT everywhere: a speaker's mic track is
// enabled the moment it is captured; mute is an explicit toggle.

// Peer manager shared by the broad host room and the broad watch room.
function useBroadPeers({ sockRef, getStream, onRemote, getAnswerKind }) {
  const pcsRef = useRef(new Map());

  function clearTimers(entry) {
    for (const key of ["disconnectTimer", "renegoTimer", "giveUpTimer"]) {
      if (entry[key]) {
        clearTimeout(entry[key]);
        entry[key] = null;
      }
    }
  }

  function closePeer(peerId) {
    const entry = pcsRef.current.get(peerId);
    if (entry) {
      clearTimers(entry);
      try {
        entry.pc.close();
      } catch {
        /* ignore */
      }
      pcsRef.current.delete(peerId);
    }
    onRemote(peerId, null);
  }

  function closeAll() {
    for (const peerId of [...pcsRef.current.keys()]) closePeer(peerId);
  }

  function wire(peerId, kind, { initiator, relayOnly = false, retried = false, broadSeat = false }) {
    const pc = new RTCPeerConnection(peerConnectionConfig(relayOnly));
    const entry = { pc, pendingIce: [], kind, initiator, retried, relayOnly, broadSeat, disconnectTimer: null, renegoTimer: null, giveUpTimer: null };
    pcsRef.current.set(peerId, entry);
    const s = getStream();
    // Audio tracks ONLY — a broad peer never carries video, whoever
    // publishes on it.
    if (s) for (const track of s.getAudioTracks()) pc.addTrack(track, s);
    pc.ontrack = (e) => {
      if (e.streams[0]) onRemote(peerId, e.streams[0]);
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) sockRef.current?.signal(peerId, { kind: "ice", candidate: e.candidate.toJSON() });
    };
    pc.oniceconnectionstatechange = () => monitor(peerId, entry);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "closed" && pcsRef.current.get(peerId) === entry) {
        clearTimers(entry);
        pcsRef.current.delete(peerId);
        onRemote(peerId, null);
      }
    };
    return entry;
  }

  async function offer(peerId, entry, { relay = false } = {}) {
    try {
      const desc = await entry.pc.createOffer();
      await entry.pc.setLocalDescription(desc);
      sockRef.current?.signal(peerId, {
        kind: "offer",
        description: entry.pc.localDescription?.toJSON() ?? desc,
        ...(relay ? { relay: true } : {}),
        ...(entry.broadSeat ? { broadSeat: true } : {}),
      });
    } catch {
      /* peer already gone */
    }
  }

  // Initiate a connection to a member (replaces any existing one).
  function connect(peerId, kind, { broadSeat = false } = {}) {
    closePeer(peerId);
    const entry = wire(peerId, kind, { initiator: true, broadSeat });
    void offer(peerId, entry);
  }

  function onPeerIceFailed(peerId) {
    const entry = pcsRef.current.get(peerId);
    if (!entry) return;
    clearTimers(entry);
    if (entry.retried) {
      reportIce({ role: "broad", kind: entry.kind, state: "failed", relay: entry.relayOnly });
      closePeer(peerId);
      return;
    }
    entry.retried = true;
    if (entry.initiator) {
      const { kind, broadSeat } = entry;
      closePeer(peerId);
      const fresh = wire(peerId, kind, { initiator: true, relayOnly: true, retried: true, broadSeat });
      void offer(peerId, fresh, { relay: true });
    } else {
      entry.renegoTimer = setTimeout(() => {
        if (pcsRef.current.get(peerId) !== entry) return;
        sockRef.current?.signal(peerId, { kind: "renegotiate", relay: true });
        entry.giveUpTimer = setTimeout(() => {
          if (pcsRef.current.get(peerId) === entry) closePeer(peerId);
        }, 12000);
      }, 600);
    }
  }

  function monitor(peerId, entry) {
    if (pcsRef.current.get(peerId) !== entry) return;
    const st = entry.pc.iceConnectionState;
    if (st === "connected" || st === "completed") {
      clearTimers(entry);
    } else if (st === "disconnected") {
      clearTimeout(entry.disconnectTimer);
      entry.disconnectTimer = setTimeout(() => {
        if (pcsRef.current.get(peerId) === entry && entry.pc.iceConnectionState === "disconnected") onPeerIceFailed(peerId);
      }, 4000);
    } else if (st === "failed") {
      onPeerIceFailed(peerId);
    }
  }

  async function handleSignal(msg) {
    const data = msg.data;
    if (!data) return;
    if (data.kind === "offer" && data.description) {
      // An incoming offer always replaces whatever we held to that peer
      // (this is also how a dropped speaker falls back to a plain
      // listener connection from the host's re-offer).
      const kind = getAnswerKind(msg.from, data);
      closePeer(msg.from);
      const entry = wire(msg.from, kind, { initiator: false, relayOnly: !!data.relay });
      try {
        await entry.pc.setRemoteDescription(data.description);
        for (const c of entry.pendingIce.splice(0)) {
          try {
            await entry.pc.addIceCandidate(c);
          } catch {
            /* stale candidate */
          }
        }
        const answer = await entry.pc.createAnswer();
        await entry.pc.setLocalDescription(answer);
        sockRef.current?.signal(msg.from, { kind: "answer", description: entry.pc.localDescription?.toJSON() ?? answer });
      } catch {
        /* peer vanished mid-negotiation */
      }
    } else if (data.kind === "answer" && data.description) {
      const entry = pcsRef.current.get(msg.from);
      if (entry) {
        try {
          await entry.pc.setRemoteDescription(data.description);
          for (const c of entry.pendingIce.splice(0)) {
            try {
              await entry.pc.addIceCandidate(c);
            } catch {
              /* stale candidate */
            }
          }
        } catch {
          /* already answered */
        }
      }
    } else if (data.kind === "ice" && data.candidate) {
      const entry = pcsRef.current.get(msg.from);
      if (entry) {
        if (entry.pc.remoteDescription) {
          try {
            await entry.pc.addIceCandidate(data.candidate);
          } catch {
            /* stale candidate */
          }
        } else {
          entry.pendingIce.push(data.candidate);
        }
      }
    } else if (data.kind === "renegotiate") {
      const entry = pcsRef.current.get(msg.from);
      if (entry) {
        const { kind, broadSeat } = entry;
        closePeer(msg.from);
        const fresh = wire(msg.from, kind, { initiator: true, relayOnly: true, retried: true, broadSeat });
        void offer(msg.from, fresh, { relay: true });
      }
    }
  }

  return { pcsRef, connect, closePeer, closeAll, handleSignal };
}

// Hidden <audio> sinks for every remote publisher in a broad room.
function BroadAudios({ audios, muted }) {
  return (
    <div aria-hidden="true" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", opacity: 0, pointerEvents: "none" }}>
      {audios.map((a) => (
        <audio
          key={a.peerId}
          data-broad-audio={a.peerId}
          autoPlay
          playsInline
          muted={muted}
          ref={(el) => {
            if (el && el.srcObject !== a.stream) {
              el.srcObject = a.stream;
              el.play?.().catch(() => {});
            }
          }}
        />
      ))}
    </div>
  );
}

function useRemoteAudios() {
  const [audios, setAudios] = useState([]);
  const onRemote = useCallback((peerId, stream) => {
    setAudios((prev) => {
      const rest = prev.filter((a) => a.peerId !== peerId);
      return stream ? [...rest, { peerId, stream }] : rest;
    });
  }, []);
  return { audios, onRemote };
}

// The seats stage shared by both broad rooms: the host seat pinned
// first (full-width), then the 6 guest seats in a grid. Filled seats
// show DP + @name + mic state; empty seats a placeholder. Follow
// buttons ride along for anyone the viewer does not follow yet.
// Speaking glow: v1 renders the mic state (open = accent, muted =
// red slash) rather than a live level analyser.
function BroadStage({ seats, me, myPeerId, followed, onFollow, onSeatTap, isHostView }) {
  const host = seats?.host ?? null;
  const bySeat = new Map((seats?.seats ?? []).map((s) => [s.seat, s]));
  const followBtn = (user) =>
    user && user.id !== me.id && followed[user.id] === false ? (
      <button
        type="button"
        className="btn btn-primary btn-small"
        data-follow-user={user.id}
        style={{ padding: "3px 12px", fontSize: 12.5, borderRadius: 999 }}
        onClick={(e) => {
          e.stopPropagation();
          onFollow(user);
        }}
      >
        Follow
      </button>
    ) : null;
  const micBadge = (mutedState) =>
    mutedState ? <span title="Mic band hai">🔇</span> : <span title="Mic khula hai">🎙️</span>;
  return (
    <div data-broad-stage="true">
      <div
        data-broad-host="true"
        data-seat-muted={host?.muted ? "true" : "false"}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 14px",
          borderRadius: 16,
          border: "1.5px solid var(--accent)",
          background: "rgba(255,255,255,0.05)",
          marginBottom: 10,
        }}
      >
        <Avatar user={host?.user ?? { username: "?", display_name: "Host" }} size={54} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 16, display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{host?.user?.display_name ?? "Host"}</span>
            <OwnerBadge user={host?.user} />
            <span style={{ fontSize: 15 }}>{micBadge(host?.muted)}</span>
          </div>
          <div style={{ color: "var(--dim)", fontSize: 13 }}>
            @{host?.user?.username} · 👑 Host {host?.peerId === myPeerId ? "· Tum" : ""}
          </div>
        </div>
        {followBtn(host?.user)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
        {[1, 2, 3, 4, 5, 6].map((n) => {
          const s = bySeat.get(n);
          if (!s) {
            return (
              <button
                key={n}
                type="button"
                data-broad-seat={n}
                data-seat-state="empty"
                onClick={() => onSeatTap?.(null, n)}
                style={{
                  border: "1.5px dashed var(--border)",
                  borderRadius: 16,
                  background: "transparent",
                  color: "var(--dim)",
                  padding: "16px 6px",
                  textAlign: "center",
                  cursor: onSeatTap ? "pointer" : "default",
                }}
              >
                <div style={{ fontSize: 24 }}>🪑</div>
                <div style={{ fontSize: 12.5, marginTop: 4 }}>{isHostView ? "Khali seat — listener ko invite karo" : "Khali seat"}</div>
              </button>
            );
          }
          const isMe = s.peerId === myPeerId;
          return (
            <div
              key={n}
              data-broad-seat={n}
              data-seat-state="filled"
              data-seat-peer={s.peerId}
              data-seat-muted={s.muted ? "true" : "false"}
              onClick={() => onSeatTap?.(s, n)}
              style={{
                border: `1.5px solid ${isMe ? "var(--accent)" : "var(--border)"}`,
                borderRadius: 16,
                background: "rgba(255,255,255,0.04)",
                padding: "12px 6px",
                textAlign: "center",
                cursor: onSeatTap ? "pointer" : "default",
              }}
            >
              <div style={{ display: "flex", justifyContent: "center" }}>
                <Avatar user={s.user} size={46} />
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, marginTop: 5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                @{s.user.username} {isMe ? "(Tum)" : ""}
              </div>
              <div style={{ fontSize: 15, marginTop: 2 }}>{micBadge(s.muted)}</div>
              {followBtn(s.user)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Follow-state helper for the broad rooms: seeds the host from the
// getLive payload and lazily resolves seat users via getProfile so the
// stage can offer (and retire) Follow buttons accurately.
function useBroadFollows(me) {
  const [followed, setFollowed] = useState({});
  const askedRef = useRef(new Set());
  const ensure = useCallback(
    (user) => {
      if (!user || user.id === me.id || askedRef.current.has(user.id)) return;
      askedRef.current.add(user.id);
      call("getProfile", { user_id: user.id }).then((res) => {
        if (res.ok) setFollowed((prev) => ({ ...prev, [user.id]: Boolean(res.profile?.followed_by_me) }));
      });
    },
    [me.id]
  );
  const follow = useCallback((user) => {
    if (!user) return;
    setFollowed((prev) => ({ ...prev, [user.id]: true }));
    call("toggleFollow", { user_id: user.id }).then((res) => {
      if (res.ok) setFollowed((prev) => ({ ...prev, [user.id]: Boolean(res.following) }));
    });
  }, []);
  return { followed, ensure, follow, setFollowed };
}

// ---- Broad host room ---------------------------------------------------------------
// The broadcaster's side of a voice room: publishes its mic to every
// member, runs the seats (requests, invites, drop, seat-mute), and
// reads chat/gifts like the video host. Ending the broad goes through
// the same endLive RPC + summary as a video live.

function BroadHostRoom({ me, session, stream, onDone }) {
  const [myPeerId, setMyPeerId] = useState(null);
  const [viewers, setViewers] = useState({}); // peerId -> user (listeners + speakers)
  const [seatRequests, setSeatRequests] = useState([]);
  const [selectedSeat, setSelectedSeat] = useState(null); // seat no. the host tapped
  const [myMuted, setMyMuted] = useState(false); // host mic — OPEN by default
  const [ending, setEnding] = useState(false);
  const [earned, setEarned] = useState(0);
  const streamRef = useRef(stream);
  const endHandledRef = useRef(false);
  const peakRef = useRef(0);
  const { audios, onRemote } = useRemoteAudios();
  const follows = useBroadFollows(me);

  const room = useLiveRoom(session.id, {
    onJoined: () => setMyPeerId(sockRef.current?.peerId ?? null),
    onViewerJoined: (msg) => {
      setViewers((prev) => ({ ...prev, [msg.peerId]: msg.user }));
      peers.connect(msg.peerId, "listener");
    },
    onViewerLeft: (msg) => {
      setViewers((prev) => {
        const next = { ...prev };
        delete next[msg.peerId];
        return next;
      });
      peers.closePeer(msg.peerId);
    },
    onSignal: (msg) => void peers.handleSignal(msg),
    onSeatRequest: (msg) => {
      setSeatRequests((prev) => (prev.some((r) => r.requestId === msg.requestId) ? prev : [...prev, msg]));
    },
    onSeatRequestGone: (msg) => {
      setSeatRequests((prev) => prev.filter((r) => r.requestId !== msg.requestId));
    },
    onSeatPeer: (msg) => {
      if (msg.initiate) peers.connect(msg.peerId, "seat");
    },
    onSeatLeft: (msg) => {
      peers.closePeer(msg.peerId);
    },
    onGift: (msg) => {
      if (msg.gift && typeof msg.gift.creator_share === "number") setEarned((prev) => prev + msg.gift.creator_share);
    },
    onEnded: () => {
      if (!endHandledRef.current) {
        endHandledRef.current = true;
        onDone({
          live_session_id: session.id,
          duration_seconds: Math.floor((Date.now() - session.started_at) / 1000),
          peak_viewers: peakRef.current,
          total_gift_coins: 0,
          creator_earned_coins: earned,
          platform_cut_coins: 0,
        });
      }
    },
  });
  const { sockRef } = room;
  if (room.viewerCount > peakRef.current) peakRef.current = room.viewerCount;

  const peers = useBroadPeers({
    sockRef,
    getStream: () => streamRef.current,
    onRemote,
    getAnswerKind: (from) => (room.seats?.seats?.some((s) => s.peerId === from) ? "seat" : "listener"),
  });
  const peersRef = useRef(peers);
  peersRef.current = peers;

  // Leaving the room tears the mesh down and stops the mic.
  useEffect(
    () => () => {
      peersRef.current?.closeAll();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    },
    []
  );

  // Follow state for everyone on stage.
  useEffect(() => {
    if (room.seats?.host?.user) follows.ensure(room.seats.host.user);
    for (const s of room.seats?.seats ?? []) follows.ensure(s.user);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.seats]);

  function toggleMyMute() {
    const next = !myMuted;
    setMyMuted(next);
    for (const t of streamRef.current?.getAudioTracks() ?? []) t.enabled = !next;
    sockRef.current?.send({ type: "seat-mute", muted: next });
  }

  function respondSeat(requestId, accept) {
    sockRef.current?.send({ type: "seat-respond", requestId, accept });
    setSeatRequests((prev) => prev.filter((r) => r.requestId !== requestId));
  }

  function inviteListener(peerId) {
    sockRef.current?.send({ type: "seat-invite", toPeerId: peerId });
    room.pushMsg({ kind: "system", text: "🎙️ Seat invite bhej diya — listener ke jawab ka intezar hai." });
  }

  async function endLive() {
    if (endHandledRef.current) return;
    endHandledRef.current = true;
    setEnding(true);
    const res = await call("endLive", { live_session_id: session.id });
    const summary = res.ok
      ? res.summary
      : {
          live_session_id: session.id,
          duration_seconds: Math.floor((Date.now() - session.started_at) / 1000),
          peak_viewers: peakRef.current,
          total_gift_coins: 0,
          creator_earned_coins: earned,
          platform_cut_coins: 0,
        };
    onDone(summary);
  }

  const seatList = room.seats?.seats ?? [];
  const seatedPeers = new Set(seatList.map((s) => s.peerId));
  const listeners = Object.entries(viewers).filter(([peerId]) => !seatedPeers.has(peerId));
  const selected = selectedSeat != null ? seatList.find((s) => s.seat === selectedSeat) ?? null : null;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 40, background: "var(--bg, #0b0a10)", color: "var(--text)", display: "flex", flexDirection: "column" }}>
      <BroadAudios audios={audios} muted={false} />
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px 8px" }}>
        <LiveBadge />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 16.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>🎙️ {session.title}</div>
          <div style={{ color: "var(--dim)", fontSize: 12.5 }}>
            👀 {room.viewerCount} listening · ❤️ {room.liveLikes} · 🪙 kamai {earned}
            {!room.connected ? " · reconnect ho raha hai…" : ""}
          </div>
        </div>
        <button className="btn" onClick={toggleMyMute} style={{ borderRadius: 999, padding: "9px 13px", fontWeight: 700 }} aria-label="Apna mic mute/unmute">
          {myMuted ? "🔇 Mic band" : "🎙️ Mic khula"}
        </button>
        <button className="btn btn-danger" onClick={endLive} disabled={ending} style={{ borderRadius: 999, padding: "10px 15px", fontWeight: 800 }}>
          {ending ? "Ending…" : "End Broad"}
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "4px 14px 10px", position: "relative" }}>
        <BroadStage
          seats={room.seats}
          me={me}
          myPeerId={myPeerId}
          followed={follows.followed}
          onFollow={follows.follow}
          isHostView
          onSeatTap={(entry) => {
            if (entry) setSelectedSeat(entry.seat);
          }}
        />
        <GiftAnimationOverlay anim={room.giftAnim} bottom="4%" />
        {selected && (
          <div className="card" data-seat-actions={selected.seat} style={{ marginTop: 10, padding: 12, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <strong style={{ flex: 1, minWidth: 120 }}>@{selected.user.username} ki seat</strong>
            <button className="btn btn-small" onClick={() => sockRef.current?.send({ type: "seat-host-mute", peerId: selected.peerId, muted: !selected.muted })}>
              {selected.muted ? "🎙️ Unmute karo" : "🔇 Mute karo"}
            </button>
            <button className="btn btn-small btn-danger" onClick={() => { sockRef.current?.send({ type: "seat-drop", peerId: selected.peerId }); setSelectedSeat(null); }}>
              ⬇️ Seat se hatao (Drop)
            </button>
            <button className="btn btn-small" onClick={() => setSelectedSeat(null)}>✕</button>
          </div>
        )}
        {seatRequests.map((r) => (
          <div key={r.requestId} className="card" data-seat-request={r.requestId} style={{ marginTop: 10, padding: 12, display: "flex", alignItems: "center", gap: 10 }}>
            <Avatar user={r.from.user} size={38} />
            <div style={{ flex: 1, minWidth: 0, fontSize: 14 }}>
              <strong>@{r.from.user.username}</strong> seat lena chahta hai 🎙️
            </div>
            <button className="btn btn-primary btn-small" onClick={() => respondSeat(r.requestId, true)}>✔️ Accept</button>
            <button className="btn btn-small" onClick={() => respondSeat(r.requestId, false)}>✖️ Decline</button>
          </div>
        ))}
        <div style={{ marginTop: 14 }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>🎧 Listeners ({listeners.length})</div>
          {listeners.length === 0 && <p style={{ color: "var(--dim)", fontSize: 13, margin: 0 }}>Abhi koi listener nahi — apna link share karo!</p>}
          <div style={{ display: "grid", gap: 6 }}>
            {listeners.map(([peerId, user]) => (
              <div key={peerId} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Avatar user={user} size={30} />
                <span style={{ flex: 1, minWidth: 0, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>@{user.username}</span>
                {follows.followed[user.id] === false && (
                  <button className="btn btn-small" data-follow-user={user.id} onClick={() => follows.follow(user)}>Follow</button>
                )}
                <button className="btn btn-small" data-invite-peer={peerId} disabled={(room.seats?.seatsFree ?? 0) <= 0} onClick={() => inviteListener(peerId)}>
                  🎙️ Seat do
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ borderTop: "1px solid var(--border)", padding: "8px 14px calc(10px + env(safe-area-inset-bottom))", background: "var(--surface)" }}>
        <ChatFeed messages={room.messages} compact />
        <ChatInput onSend={room.sendChat} />
      </div>
    </div>
  );
}

// ---- Broad watch (listener) room ---------------------------------------------------
// Joining a broad = listening: the host and every seated speaker send
// their audio to you. Taking a seat (request or host invite) starts
// your microphone — OPEN BY DEFAULT, no unmute gate — and you publish
// audio only to the whole room. Gifts, chat, likes and follows work
// exactly like the video watch room.

function BroadWatchRoom({ me, session, refreshMe, onBack }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [myPeerId, setMyPeerId] = useState(null);
  const [hostPeerId, setHostPeerId] = useState(null);
  const [seatPending, setSeatPending] = useState(false);
  const [seatInvite, setSeatInvite] = useState(null); // { inviteId, from }
  const [myMuted, setMyMuted] = useState(false); // my mic — OPEN by default once seated
  const [soundMuted, setSoundMuted] = useState(() => {
    try {
      return window.localStorage.getItem("zoomly-viewer-sound-muted") === "1";
    } catch {
      return false;
    }
  });
  const [showGifts, setShowGifts] = useState(false);
  const [giftBusy, setGiftBusy] = useState("");
  const [balance, setBalance] = useState(0);
  const [hearts, setHearts] = useState([]);
  const micStreamRef = useRef(null);
  const seatedRef = useRef(false);
  const pendingAnswerKindRef = useRef(new Map()); // peerId -> kind for the next offer
  const heartIdRef = useRef(0);
  const { audios, onRemote } = useRemoteAudios();
  const follows = useBroadFollows(me);

  const room = useLiveRoom(session.id, {
    onJoined: (msg) => {
      setMyPeerId(sockRef.current?.peerId ?? null);
      setHostPeerId(msg.broadcasterPeerId ?? null);
    },
    onBroadcasterJoined: (msg) => setHostPeerId(msg.peerId),
    onViewerJoined: (msg) => {
      // I am a seated speaker: publish my audio to the new member.
      if (msg.seatPublisher && seatedRef.current) {
        peers.connect(msg.peerId, "seat", { broadSeat: true });
      }
    },
    onViewerLeft: (msg) => peers.closePeer(msg.peerId),
    onSignal: (msg) => void peers.handleSignal(msg),
    onSeatSeated: () => {
      void startPublishing();
    },
    onSeatPeer: (msg) => {
      // The host will offer on a full-duplex seat connection; remember
      // to answer it with my mic attached.
      if (!msg.initiate) pendingAnswerKindRef.current.set(msg.peerId, "seat-host");
    },
    onSeatDeclined: () => {
      setSeatPending(false);
      room.pushMsg({ kind: "system", text: "🎙️ Host ne seat request mana kar di — tum listener hi rahoge." });
    },
    onSeatRequestExpired: () => {
      setSeatPending(false);
      room.pushMsg({ kind: "system", text: "🎙️ Seat request ka time khatam — host ne jawab nahi diya." });
    },
    onSeatInvited: (msg) => setSeatInvite({ inviteId: msg.inviteId, from: msg.from }),
    onSeatInviteExpired: () => setSeatInvite(null),
    onSeatLeft: (msg) => {
      if (msg.peerId === sockRef.current?.peerId) {
        stopPublishing();
        if (msg.removed) room.pushMsg({ kind: "system", text: "🎙️ Host ne tumhe seat se hata diya — ab tum listener ho." });
      } else {
        peers.closePeer(msg.peerId);
      }
    },
    onLiveLikes: () => spawnHeart(),
    onSeatHostMuted: (msg) => {
      // Host authority over my seat: apply it to the actual mic track.
      setMyMuted(msg.muted);
      for (const t of micStreamRef.current?.getAudioTracks() ?? []) t.enabled = !msg.muted;
      room.pushMsg({ kind: "system", text: msg.muted ? "🔇 Host ne tumhara mic band kar diya hai." : "🎙️ Host ne tumhara mic khol diya hai." });
    },
  });
  const { sockRef } = room;

  const peers = useBroadPeers({
    sockRef,
    getStream: () => micStreamRef.current,
    onRemote,
    getAnswerKind: (from, data) => {
      const pending = pendingAnswerKindRef.current.get(from);
      if (pending) {
        pendingAnswerKindRef.current.delete(from);
        return pending;
      }
      if (from === hostPeerId) return seatedRef.current ? "seat-host" : "main";
      if (seatedRef.current && data.broadSeat) return "seat";
      return "listen";
    },
  });

  const peersRef = useRef(peers);
  peersRef.current = peers;

  // Leaving the room stops the mic and tears the mesh down.
  useEffect(
    () => () => {
      peersRef.current?.closeAll();
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    },
    []
  );

  // Session detail (gift catalog, balance, follow state) like the
  // video watch room.
  useEffect(() => {
    let cancelled = false;
    call("getLive", { live_session_id: session.id }).then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setDetail(res);
        // Adopt the server's ICE list (STUN + TURN) like every other
        // room — without this, broad watchers would keep the built-in
        // fallback list and miss a server-side TURN rotation (e.g. a
        // dedicated TURN configured via env).
        setIceServers(res.ice_servers);
        if (typeof res.my_coin_balance === "number") setBalance(res.my_coin_balance);
        const b = res.session?.broadcaster;
        if (b) follows.setFollowed((prev) => ({ ...prev, [b.id]: Boolean(res.broadcaster_followed) }));
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  // Follow state for everyone on stage.
  useEffect(() => {
    if (room.seats?.host?.user) follows.ensure(room.seats.host.user);
    for (const s of room.seats?.seats ?? []) follows.ensure(s.user);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.seats]);

  const iAmSeated = Boolean(myPeerId && room.seats?.seats?.some((s) => s.peerId === myPeerId));
  seatedRef.current = iAmSeated;
  const mySeatMuted = room.seats?.seats?.find((s) => s.peerId === myPeerId)?.muted ?? myMuted;

  async function startPublishing() {
    if (micStreamRef.current) {
      sockRef.current?.send({ type: "seat-ready" });
      return;
    }
    try {
      // AUDIO ONLY — a broad speaker never captures video.
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = s;
      // Mic OPEN by default: the track starts enabled.
      for (const t of s.getAudioTracks()) t.enabled = !myMuted;
      sockRef.current?.send({ type: "seat-ready" });
    } catch {
      room.pushMsg({ kind: "system", text: "🎙️ Mic ki ijazat nahi mili — seat mili thi lekin tum bol nahi sakte. Browser settings me mic Allow karo." });
    }
  }

  function stopPublishing() {
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    setMyMuted(false);
    setSeatPending(false);
    for (const [peerId, entry] of [...peers.pcsRef.current.entries()]) {
      if (entry.kind === "seat" || entry.kind === "seat-host") peers.closePeer(peerId);
    }
  }

  function toggleMyMute() {
    const next = !mySeatMuted;
    setMyMuted(next);
    for (const t of micStreamRef.current?.getAudioTracks() ?? []) t.enabled = !next;
    sockRef.current?.send({ type: "seat-mute", muted: next });
  }

  function toggleSound() {
    setSoundMuted((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem("zoomly-viewer-sound-muted", next ? "1" : "0");
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  }

  function spawnHeart() {
    heartIdRef.current += 1;
    const id = heartIdRef.current;
    const heart = {
      id,
      x: 72 + Math.random() * 18,
      y: 62,
      drift: Math.round(Math.random() * 70) - 35,
      rot: Math.round(Math.random() * 36) - 18,
      size: 26 + Math.round(Math.random() * 16),
    };
    setHearts((prev) => [...prev.slice(-24), heart]);
    setTimeout(() => setHearts((prev) => prev.filter((h) => h.id !== id)), 1600);
  }

  async function sendGift(gift) {
    if (room.ended) return;
    setGiftBusy(gift.key);
    setError("");
    setNotice("");
    const res = await call("sendGift", { live_session_id: session.id, gift_key: gift.key });
    setGiftBusy("");
    if (!res.ok) {
      setError(res.message || "Gift nahi bheja ja saka.");
      if (typeof res.my_balance === "number") setBalance(res.my_balance);
      return;
    }
    setNotice(res.message);
    if (typeof res.my_balance === "number") setBalance(res.my_balance);
    refreshMe?.();
  }

  function leaveSeatOrBack() {
    if (iAmSeated) {
      sockRef.current?.send({ type: "seat-leave" });
      stopPublishing();
    } else {
      onBack();
    }
  }

  const gifts = detail?.gifts ?? [];
  const broadcaster = detail?.session?.broadcaster ?? session.broadcaster;
  const seatsFree = room.seats?.seatsFree ?? 0;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 40, background: "var(--bg, #0b0a10)", color: "var(--text)", display: "flex", flexDirection: "column" }}>
      <BroadAudios audios={audios} muted={soundMuted} />
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px 8px" }}>
        <button className="btn btn-small" onClick={onBack} aria-label="Back">←</button>
        <LiveBadge />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 16.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>🎙️ {session.title}</div>
          <div style={{ color: "var(--dim)", fontSize: 12.5 }}>
            @{broadcaster?.username} · 👀 {room.viewerCount} listening · ❤️ {room.liveLikes}
            {!room.connected ? " · reconnect ho raha hai…" : ""}
          </div>
        </div>
        <button className="btn" onClick={toggleSound} style={{ borderRadius: 999, padding: "9px 13px", fontWeight: 700 }} aria-label="Awaz on/off">
          {soundMuted ? "🔇 Awaz band" : "🔊 Awaz on"}
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "4px 14px 10px", position: "relative" }}>
        <BroadStage
          seats={room.seats}
          me={me}
          myPeerId={myPeerId}
          followed={follows.followed}
          onFollow={follows.follow}
          isHostView={false}
          onSeatTap={(entry, seatNo) => {
            if (!entry && !iAmSeated && !seatPending) {
              setSeatPending(true);
              sockRef.current?.send({ type: "seat-request" });
            }
          }}
        />
        <FloatingHearts hearts={hearts} />
        <GiftAnimationOverlay anim={room.giftAnim} bottom="4%" />
        {seatInvite && !iAmSeated && (
          <div className="card" data-seat-invite={seatInvite.inviteId} style={{ marginTop: 10, padding: 12, display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 22 }}>🎙️</span>
            <div style={{ flex: 1, fontSize: 14 }}>
              <strong>@{seatInvite.from.user.username}</strong> tumhe seat par bula raha hai — mic khula hoga!
            </div>
            <button className="btn btn-primary btn-small" onClick={() => { sockRef.current?.send({ type: "seat-invite-respond", inviteId: seatInvite.inviteId, accept: true }); setSeatInvite(null); }}>✔️ Beth jao</button>
            <button className="btn btn-small" onClick={() => { sockRef.current?.send({ type: "seat-invite-respond", inviteId: seatInvite.inviteId, accept: false }); setSeatInvite(null); }}>✖️ Mana</button>
          </div>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          {iAmSeated ? (
            <>
              <button className="btn" onClick={toggleMyMute} style={{ borderRadius: 999, padding: "10px 15px", fontWeight: 700 }}>
                {mySeatMuted ? "🔇 Mic band hai — kholo" : "🎙️ Mic khula hai"}
              </button>
              <button className="btn" onClick={leaveSeatOrBack} style={{ borderRadius: 999, padding: "10px 15px", fontWeight: 700 }}>
                ⬇️ Seat chhoro
              </button>
            </>
          ) : (
            <button
              className="btn btn-primary"
              data-seat-cta="true"
              disabled={seatPending || seatsFree <= 0}
              onClick={() => {
                setSeatPending(true);
                sockRef.current?.send({ type: "seat-request" });
              }}
              style={{ borderRadius: 999, padding: "11px 18px", fontWeight: 800 }}
            >
              {seatPending ? "⏳ Host ke jawab ka intezar…" : seatsFree <= 0 ? "🪑 Seats full hain" : "✋ Seat lo"}
            </button>
          )}
          <button className="btn" onClick={() => { spawnHeart(); sockRef.current?.like(1); }} style={{ borderRadius: 999, padding: "10px 15px", fontWeight: 700 }} aria-label="Like">
            ❤️
          </button>
          <button className="btn" onClick={() => setShowGifts((v) => !v)} style={{ borderRadius: 999, padding: "10px 15px", fontWeight: 700 }}>
            🎁 Gift
          </button>
        </div>
        {room.ended && (
          <p style={{ color: "var(--dim)", marginTop: 12 }}>Ye broad khatam ho gaya hai. <button className="btn btn-small" onClick={onBack}>Wapas jao</button></p>
        )}
      </div>

      <div style={{ borderTop: "1px solid var(--border)", padding: "8px 14px calc(10px + env(safe-area-inset-bottom))", background: "var(--surface)", position: "relative" }}>
        <ChatFeed messages={room.messages} compact />
        <ChatInput onSend={room.sendChat} />
      </div>

      {showGifts && !room.ended && gifts.length > 0 && (
        <>
          <div onClick={() => setShowGifts(false)} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 7 }} />
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 8,
              background: "var(--surface)",
              borderTop: "1px solid var(--border)",
              borderRadius: "18px 18px 0 0",
              padding: "14px 14px calc(14px + env(safe-area-inset-bottom))",
              animation: "zoomly-sheet-up 0.22s ease-out",
              maxHeight: "62dvh",
              overflowY: "auto",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <strong style={{ fontSize: 16, flex: 1 }}>🎁 Gift bhejo</strong>
              <span className="chip">🪙 {balance}</span>
              <button type="button" className="btn btn-small" onClick={() => setShowGifts(false)} aria-label="Close gifts">✕</button>
            </div>
            <div style={{ fontSize: 13, color: "var(--dim)", margin: "8px 0 10px" }}>
              Gift ke 70% coins host ko jayenge. Tumhara balance: <strong style={{ color: "var(--text)" }}>🪙 {balance}</strong>
            </div>
            <Notice text={error} bad />
            <Notice text={notice} />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginTop: 6 }}>
              {gifts.map((gift) => (
                <button
                  key={gift.key}
                  className="card"
                  onClick={() => sendGift(gift)}
                  disabled={giftBusy === gift.key}
                  style={{ padding: "8px 4px", textAlign: "center", cursor: "pointer", color: "var(--text)", opacity: giftBusy && giftBusy !== gift.key ? 0.6 : 1 }}
                >
                  <div style={{ fontSize: 24 }}>{gift.emoji}</div>
                  <div style={{ fontSize: 12, fontWeight: 700 }}>{gift.name}</div>
                  <div style={{ fontSize: 12, color: "var(--dim)" }}>🪙 {gift.coins.toLocaleString()}</div>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---- Live tab root -----------------------------------------------------------------

export function LiveView({ me, refreshMe, onOpenProfile }) {
  const [screen, setScreen] = useState({ kind: "list" });

  if (screen.kind === "setup") {
    return (
      <GoLiveSetup
        me={me}
        onCancel={() => setScreen({ kind: "list" })}
        onStart={(session, stream, processor) => {
          refreshMe?.();
          setScreen({ kind: "broadcast", session, stream, processor });
        }}
      />
    );
  }
  if (screen.kind === "broadcast") {
    if (screen.session.kind === "broad") {
      return (
        <BroadHostRoom
          me={me}
          session={screen.session}
          stream={screen.stream}
          onDone={(summary) => {
            refreshMe?.();
            setScreen({ kind: "summary", summary });
          }}
        />
      );
    }
    return (
      <BroadcastRoom
        me={me}
        session={screen.session}
        stream={screen.stream}
        processor={screen.processor}
        onDone={(summary) => {
          refreshMe?.();
          setScreen({ kind: "summary", summary });
        }}
      />
    );
  }
  if (screen.kind === "watch") {
    if (screen.session.kind === "broad") {
      return <BroadWatchRoom me={me} session={screen.session} refreshMe={refreshMe} onBack={() => setScreen({ kind: "list" })} />;
    }
    return <WatchRoom me={me} session={screen.session} refreshMe={refreshMe} onBack={() => setScreen({ kind: "list" })} />;
  }
  if (screen.kind === "summary") {
    return <EndSummary summary={screen.summary} onClose={() => setScreen({ kind: "list" })} />;
  }
  return <LiveList me={me} onGoLive={() => setScreen({ kind: "setup" })} onWatch={(session) => setScreen({ kind: "watch", session })} onOpenProfile={onOpenProfile} />;
}
