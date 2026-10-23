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
import { logSelectedCandidatePair, openLiveSocket, peerConnectionConfig, setIceServers } from "./live";
import { setViewerMuted, viewerMuted } from "./sound";
import { Avatar, Notice } from "./App.jsx";

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
// with a fade, notices under it, chat + actions in a bottom gradient, the
// PK score bar across the middle seam when the stage is split in two.
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
const seamBarStyle = {
  position: "absolute",
  top: "50%",
  left: 0,
  right: 0,
  transform: "translateY(-50%)",
  padding: "0 10px",
  zIndex: 5,
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

// ---- shared room hook ---------------------------------------------------------
// Opens the socket, authenticates, joins the room, and collects the room's
// chat/gift feed + viewer count. Media/signaling callbacks go to the
// `handlersRef` bag so the broadcaster/watcher components can plug in their
// WebRTC logic without re-creating the socket.
function useLiveRoom(sessionId, handlers = {}) {
  const [messages, setMessages] = useState([]);
  const [viewerCount, setViewerCount] = useState(0);
  const [ended, setEnded] = useState(false);
  const [connected, setConnected] = useState(false);
  const [authError, setAuthError] = useState("");
  const sockRef = useRef(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const idRef = useRef(0);

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
            h.onJoined?.(msg);
            break;
          case "viewer-count":
            setViewerCount(msg.count ?? 0);
            break;
          case "chat":
            pushMsg({ kind: "chat", from: msg.from, text: msg.text, created_at: msg.created_at });
            break;
          case "gift":
            pushMsg({ kind: "gift", from: msg.from, gift: msg.gift, created_at: msg.created_at });
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
  }, [sessionId, pushMsg]);

  const sendChat = useCallback((text) => {
    sockRef.current?.chat(text);
  }, []);

  return { sockRef, messages, pushMsg, viewerCount, ended, connected, authError, sendChat };
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
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 14, gap: 8 }}>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          ⚔️ <strong>@{match.a.user.username}</strong> · 🪙 {match.scoreA}
        </span>
        <span className="chip" style={{ borderColor: "#e0245e", color: "#ff7aa8" }}>
          ⏱ {mm}:{ss}
        </span>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "right" }}>
          🪙 {match.scoreB} · <strong>@{match.b.user.username}</strong>
        </span>
      </div>
      <div style={{ display: "flex", height: 12, borderRadius: 999, overflow: "hidden", marginTop: 6, background: "var(--surface-2)" }}>
        <div style={{ width: `${aPct}%`, background: "var(--accent)", transition: "width 0.4s" }} />
        <div style={{ flex: 1, background: "#e0245e", transition: "width 0.4s" }} />
      </div>
      <div style={{ textAlign: "center", color: "var(--dim)", fontSize: 12, marginTop: 4 }}>PK Match — zyada gifts wali side jeetegi!</div>
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
      {!loading && !loadError && lives.length === 0 && (
        <div className="card" style={{ textAlign: "center", padding: 26 }}>
          <div style={{ fontSize: 36 }}>📡</div>
          <p style={{ fontWeight: 700, fontSize: 17, margin: "8px 0 4px" }}>No one is live right now</p>
          <p style={{ color: "var(--dim)", margin: 0 }}>Be the first — tap “Go Live” and your viewers can watch, chat and send you gifts.</p>
        </div>
      )}
      <div style={{ display: "grid", gap: 10 }}>
        {lives.map((live) => (
          <div key={live.id} className="card" style={{ display: "flex", alignItems: "center", gap: 12, padding: 12 }}>
            <button onClick={() => live.broadcaster && onOpenProfile(live.broadcaster.id)} style={{ background: "none", border: "none", padding: 0 }} aria-label="Broadcaster profile">
              <Avatar user={live.broadcaster} size={52} />
            </button>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <LiveBadge />
                <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{live.title}</strong>
              </div>
              <div style={{ color: "var(--dim)", fontSize: 13, marginTop: 3 }}>
                {live.broadcaster?.display_name} (@{live.broadcaster?.username}) · 👀 {live.viewer_count} watching
                {live.in_match ? " · ⚔️ PK Match chal raha hai" : ""}
              </div>
            </div>
            {live.broadcaster?.id === me.id ? (
              <span className="chip">Your live</span>
            ) : (
              <button className="btn btn-primary btn-small" onClick={() => onWatch(live)}>
                Watch
              </button>
            )}
          </div>
        ))}
      </div>
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
  const [stream, setStream] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const previewRef = useRef(null);
  const streamRef = useRef(null);

  useEffect(() => {
    if (previewRef.current && stream) previewRef.current.srcObject = stream;
  }, [stream]);

  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    },
    []
  );

  async function enableCamera() {
    setError("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Is browser me camera support nahi hai. Chrome ka latest version try karo.");
      return;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      streamRef.current = s;
      setStream(s);
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
      setError("Pehle camera on karo.");
      return;
    }
    setBusy(true);
    setError("");
    // Send a title only when the user typed/edited one; otherwise the
    // server reuses the saved title (or its default) — starting a live
    // never requires touching the title again.
    const typed = editingTitle ? title.trim() : "";
    const res = await call("startLive", typed ? { title: typed } : {});
    setBusy(false);
    if (!res.ok) {
      setError(res.message || "Live start nahi ho saki.");
      return;
    }
    // Adopt the server's ICE list (STUN + TURN) for all peer connections.
    setIceServers(res.ice_servers);
    // Ownership of the stream passes to the broadcast room.
    streamRef.current = null;
    onStart(res.session, stream);
  }

  function cancel() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    onCancel();
  }

  return (
    <div style={{ padding: "14px 14px 20px", maxWidth: 560, margin: "0 auto" }}>
      <h2 style={{ margin: "2px 0 12px" }}>📹 Go Live</h2>
      <div style={{ background: "#000", borderRadius: 16, overflow: "hidden", aspectRatio: "4/3", display: "flex", alignItems: "center", justifyContent: "center" }}>
        {stream ? (
          <video ref={previewRef} autoPlay muted playsInline style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <div style={{ textAlign: "center", padding: 20 }}>
            <div style={{ fontSize: 40 }}>🎥</div>
            <p style={{ color: "var(--dim)" }}>Camera preview yahan aayega</p>
            <button className="btn btn-primary" onClick={enableCamera}>
              Camera on karo
            </button>
          </div>
        )}
      </div>
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
            {busy ? "Starting…" : "🔴 Start Live"}
          </button>
        </div>
      </form>
      <p style={{ color: "var(--dim)", fontSize: 13, marginTop: 10 }}>
        Viewers tumhe gifts bhej sakte hain — har gift ke 70% coins tumhare balance me aayenge.
      </p>
    </div>
  );
}

// ---- broadcast room -----------------------------------------------------------------

function BroadcastRoom({ me, session, stream, onDone }) {
  const videoRef = useRef(null);
  const secondVideoRef = useRef(null);
  const pcsRef = useRef(new Map()); // peerId -> { pc, pendingIce, kind: "viewer" | "match-viewer" | "match-peer" }
  const matchPeerIdRef = useRef(null);
  const [earned, setEarned] = useState(0);
  const [giftCount, setGiftCount] = useState(0);
  const [lastGift, setLastGift] = useState(null);
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

  const room = useLiveRoom(session.id, {
    onGift: (msg) => {
      if (msg.gift) {
        setEarned((e) => e + (msg.gift.creator_share ?? 0));
        setGiftCount((c) => c + 1);
        setLastGift(msg.gift);
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
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);

  useEffect(() => {
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - session.started_at) / 1000)), 1000);
    return () => clearInterval(t);
  }, [session.started_at]);

  // Leaving this screen any other way: stop the camera and close peers.
  // (The socket close ends the live on the server too.)
  useEffect(
    () => () => {
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
    [stream]
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
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
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
      // Already retried via relay and still failing — let it go.
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
      {/* video layer: own camera fills the stage; in a PK match the stage
          splits into two halves — me on top, the opponent below */}
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
          <video ref={videoRef} autoPlay muted playsInline style={videoFillStyle} />
          {splitView && <div style={tileLabelStyle("rgba(0,0,0,0.65)")}>Tum · @{me.username}</div>}
          {lastGift && (
            <div key={`${lastGift.key}-${giftCount}`} style={{ position: "absolute", right: 12, top: "34%", fontSize: 52, filter: "drop-shadow(0 2px 8px rgba(0,0,0,0.6))" }}>
              {lastGift.emoji}
            </div>
          )}
        </div>
        {splitView && (
          <div style={{ position: "relative", flex: 1, minHeight: 0, borderTop: "2px solid rgba(255,255,255,0.18)" }}>
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

      {/* top bar over the video */}
      <div style={topBarStyle}>
        <LiveBadge />
        <strong style={{ flex: 1, minWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#fff", textShadow: "0 1px 4px rgba(0,0,0,0.9)" }}>{session.title}</strong>
        <span className="chip" style={darkChipStyle}>
          👀 {room.viewerCount}
        </span>
        <span className="chip" style={darkChipStyle}>
          ⏱ {formatDuration(elapsed)}
        </span>
      </div>

      {/* PK score bar across the seam */}
      {match && (
        <div style={seamBarStyle}>
          <div style={{ background: "rgba(0,0,0,0.6)", borderRadius: 14, padding: "8px 12px", backdropFilter: "blur(3px)" }}>
            <MatchBar match={match} />
          </div>
        </div>
      )}

      {/* floating status: session earnings + match result + errors */}
      <div style={noticeStackStyle}>
        <div style={{ justifySelf: "start", background: "rgba(0,0,0,0.55)", borderRadius: 10, padding: "6px 10px", fontSize: 14, color: "#fff" }}>
          🎁 Gifts earned: <strong>🪙 {earned}</strong> ({giftCount} gift{giftCount === 1 ? "" : "s"})
        </div>
        <MatchResultBanner result={matchResult} myUserId={me.id} />
        <Notice text={room.authError} bad />
      </div>

      {/* bottom overlay: challenge panel, chat, controls */}
      <div style={bottomOverlayStyle}>
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
                  <strong style={{ fontSize: 14, color: "#fff" }}>@{l.broadcaster?.username}</strong>
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
          <button className="btn btn-danger" onClick={endLive} disabled={ending} style={{ borderRadius: 999, padding: "11px 16px", fontSize: 15, fontWeight: 800, whiteSpace: "nowrap", flexShrink: 0 }}>
            {ending ? "Ending…" : "⏹ End Live"}
          </button>
        </div>
      </div>
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
  // Guest seat: who is seated (anyone), my pending request, and my own
  // publishing state when I am the guest.
  const [seatedGuest, setSeatedGuest] = useState(null);
  const [joinPending, setJoinPending] = useState(false);
  const [amGuest, setAmGuest] = useState(false);
  const seatedGuestRef = useRef(null);
  const guestStreamRef = useRef(null);
  const myVideoRef = useRef(null);
  const amGuestRef = useRef(false);
  // PK match state
  const [match, setMatch] = useState(null);
  const [matchResult, setMatchResult] = useState(null);

  const room = useLiveRoom(session.id, {
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
      if (guestStreamRef.current) {
        guestStreamRef.current.getTracks().forEach((t) => t.stop());
        guestStreamRef.current = null;
      }
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
      guestStreamRef.current?.getTracks().forEach((t) => t.stop());
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
      guestStreamRef.current = stream;
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
    guestStreamRef.current?.getTracks().forEach((t) => t.stop());
    guestStreamRef.current = null;
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
      {/* video layer: the broadcaster fills the stage; in a PK match the
          stage splits — host on top, opponent below */}
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
          <video ref={videoRef} autoPlay playsInline muted={muted} style={videoFillStyle} />
          {room.ended ? (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.7)", fontSize: 18, fontWeight: 700, color: "#fff" }}>
              📴 {ENDED_TEXT}
            </div>
          ) : needsTap ? (
            <button
              onClick={() => {
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
              onClick={soundOn}
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
          <div style={{ position: "relative", flex: 1, minHeight: 0, borderTop: "2px solid rgba(255,255,255,0.18)" }}>
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

      {/* top bar over the video */}
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
        <span className="chip" style={darkChipStyle}>
          🪙 {balance}
        </span>
        <div style={{ flexBasis: "100%", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Avatar user={broadcaster} size={30} />
          <span style={{ fontSize: 14, color: "#fff", textShadow: "0 1px 4px rgba(0,0,0,0.9)" }}>
            {broadcaster?.display_name} <span style={{ color: "rgba(255,255,255,0.7)" }}>@{broadcaster?.username}</span>
          </span>
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

      {/* PK score bar across the seam */}
      {match && (
        <div style={seamBarStyle}>
          <div style={{ background: "rgba(0,0,0,0.6)", borderRadius: 14, padding: "8px 12px", backdropFilter: "blur(3px)" }}>
            <MatchBar match={match} />
          </div>
        </div>
      )}

      {/* floating status: connecting / errors / results */}
      <div style={noticeStackStyle}>
        <MatchResultBanner result={matchResult} myUserId={me.id} />
        <Notice text={videoStatus} />
        <Notice text={videoError} bad />
        <Notice text={room.authError} bad />
        <Notice text={error} bad />
        <Notice text={notice} />
      </div>

      {/* bottom overlay: chat + actions */}
      <div style={bottomOverlayStyle}>
        <ChatFeed messages={room.messages} />
        <div style={bottomBarStyle}>
          <ChatInput onSend={room.sendChat} disabled={!room.connected || room.ended} placeholder="Chat me kuch likho…" />
          <button type="button" onClick={() => setShowGifts(true)} disabled={room.ended || gifts.length === 0} style={{ ...roundBtnStyle, opacity: room.ended || gifts.length === 0 ? 0.5 : 1 }} aria-label="Gifts" title="Gift bhejo">
            🎁
          </button>
          <button type="button" onClick={toggleMute} style={roundBtnStyle} aria-label="Sound">
            {muted ? "🔇" : "🔊"}
          </button>
        </div>
      </div>

      {/* gift bottom sheet over the video */}
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
              Gift ke 70% coins broadcaster ko jayenge{match ? ", aur poori value uski PK score me judegi" : ""}. Tumhara balance:{" "}
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

// ---- Live tab root -----------------------------------------------------------------

export function LiveView({ me, refreshMe, onOpenProfile }) {
  const [screen, setScreen] = useState({ kind: "list" });

  if (screen.kind === "setup") {
    return (
      <GoLiveSetup
        me={me}
        onCancel={() => setScreen({ kind: "list" })}
        onStart={(session, stream) => {
          refreshMe?.();
          setScreen({ kind: "broadcast", session, stream });
        }}
      />
    );
  }
  if (screen.kind === "broadcast") {
    return (
      <BroadcastRoom
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
  if (screen.kind === "watch") {
    return <WatchRoom me={me} session={screen.session} refreshMe={refreshMe} onBack={() => setScreen({ kind: "list" })} />;
  }
  if (screen.kind === "summary") {
    return <EndSummary summary={screen.summary} onClose={() => setScreen({ kind: "list" })} />;
  }
  return <LiveList me={me} onGoLive={() => setScreen({ kind: "setup" })} onWatch={(session) => setScreen({ kind: "watch", session })} onOpenProfile={onOpenProfile} />;
}
