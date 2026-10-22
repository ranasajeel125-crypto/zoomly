// Zoomly LIVE: browse live broadcasts, go live, watch + chat + gifts.
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

// ---- chat / gift feed -----------------------------------------------------------

function ChatPanel({ messages, onSend, disabled, placeholder }) {
  const [text, setText] = useState("");
  const listRef = useRef(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function submit(e) {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText("");
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      <div ref={listRef} style={{ overflowY: "auto", flex: 1, display: "grid", gap: 7, alignContent: "start", padding: "8px 2px" }}>
        {messages.length === 0 && <p style={{ color: "var(--dim)", fontSize: 14, margin: 0 }}>Chat is quiet — say hello! 👋</p>}
        {messages.map((m) => {
          if (m.kind === "gift" && m.gift) {
            return (
              <div key={m._id} style={{ background: "rgba(163,230,53,0.10)", border: "1px solid var(--accent-dark)", borderRadius: 10, padding: "6px 9px", fontSize: 14 }}>
                <span style={{ fontSize: 18 }}>{m.gift.emoji}</span> <strong>@{m.from?.username}</strong> sent <strong>{m.gift.name}</strong> · 🪙 {m.gift.coins}
              </div>
            );
          }
          if (m.kind === "system") {
            return (
              <div key={m._id} style={{ color: "var(--dim)", fontSize: 13 }}>
                {m.text}
              </div>
            );
          }
          return (
            <div key={m._id} style={{ fontSize: 14.5, lineHeight: 1.35 }}>
              <strong style={{ color: "var(--accent)" }}>@{m.from?.username}</strong> <span>{m.text}</span>
            </div>
          );
        })}
      </div>
      <form onSubmit={submit} style={{ display: "flex", gap: 8, paddingTop: 8 }}>
        <input className="input" placeholder={placeholder || "Write a message…"} value={text} onChange={(e) => setText(e.target.value)} maxLength={500} disabled={disabled} />
        <button className="btn btn-primary" type="submit" disabled={disabled || !text.trim()}>
          Send
        </button>
      </form>
    </div>
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
    <div style={{ marginTop: 10, flexShrink: 0 }}>
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
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <h2 style={{ margin: "2px 0 12px" }}>🔴 Live now</h2>
        <button className="btn btn-primary" onClick={onGoLive} style={{ marginBottom: 10 }}>
          📹 Go Live
        </button>
      </div>
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
        Viewers tumhe gifts bhej sakte hain — har gift ke aadhe (50%) coins tumhare balance me aayenge.
      </p>
    </div>
  );
}

// ---- broadcast room -----------------------------------------------------------------

function BroadcastRoom({ me, session, stream, onDone }) {
  const videoRef = useRef(null);
  const matchVideoRef = useRef(null);
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
    if (matchVideoRef.current) matchVideoRef.current.srcObject = null;
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
      if (kind === "match-peer" && matchVideoRef.current && e.streams[0]) {
        matchVideoRef.current.srcObject = e.streams[0];
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

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", maxWidth: 640, margin: "0 auto", padding: "12px 14px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <LiveBadge />
        <strong style={{ flex: 1, minWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.title}</strong>
        <span className="chip">👀 {room.viewerCount}</span>
        <span className="chip">⏱ {formatDuration(elapsed)}</span>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10, flexShrink: 0 }}>
        <div style={{ position: "relative", background: "#000", borderRadius: 16, overflow: "hidden", flex: 1, aspectRatio: match ? undefined : "16/10", height: match ? 230 : undefined }}>
          <video ref={videoRef} autoPlay muted playsInline style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          <div style={{ position: "absolute", left: 10, bottom: 10, background: "rgba(0,0,0,0.65)", borderRadius: 10, padding: "6px 10px", fontSize: 14 }}>
            🎁 Gifts earned: <strong>🪙 {earned}</strong> ({giftCount} gift{giftCount === 1 ? "" : "s"})
          </div>
          {match && (
            <div style={{ position: "absolute", left: 10, top: 10, background: "rgba(0,0,0,0.65)", borderRadius: 10, padding: "4px 8px", fontSize: 13 }}>
              Tum · @{me.username}
            </div>
          )}
          {lastGift && !match && (
            <div key={`${lastGift.key}-${giftCount}`} style={{ position: "absolute", right: 10, top: 10, fontSize: 44 }}>
              {lastGift.emoji}
            </div>
          )}
        </div>
        {match && (
          <div style={{ position: "relative", background: "#000", borderRadius: 16, overflow: "hidden", flex: 1, height: 230 }}>
            <video ref={matchVideoRef} autoPlay playsInline style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            <div style={{ position: "absolute", left: 10, top: 10, background: "rgba(224,36,94,0.8)", borderRadius: 10, padding: "4px 8px", fontSize: 13 }}>
              ⚔️ @{opponent?.user?.username}
            </div>
          </div>
        )}
      </div>
      {match && <MatchBar match={match} />}
      <MatchResultBanner result={matchResult} myUserId={me.id} />
      <Notice text={room.authError} bad />

      {!match && (
        <div style={{ marginTop: 10, flexShrink: 0 }}>
          {incomingInvite ? (
            <div style={{ background: "rgba(224,36,94,0.12)", border: "1px solid #e0245e", borderRadius: 12, padding: "10px 12px" }}>
              <div style={{ fontSize: 15 }}>
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
          ) : pendingInviteTo ? (
            <p style={{ color: "var(--dim)", fontSize: 14, margin: 0 }}>⚔️ Challenge bhej diya hai — jawab ka intezar karo…</p>
          ) : (
            <>
              <button className="btn" onClick={toggleChallenge}>
                ⚔️ PK Match challenge
              </button>
              {showChallenge && (
                <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
                  {others.length === 0 && <p style={{ color: "var(--dim)", fontSize: 14, margin: 0 }}>Abhi koi aur broadcaster live nahi hai.</p>}
                  {others.map((l) => (
                    <div key={l.id} style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--border)", borderRadius: 12, padding: "8px 10px" }}>
                      <Avatar user={l.broadcaster} size={34} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <strong style={{ fontSize: 14 }}>@{l.broadcaster?.username}</strong>
                        <div style={{ color: "var(--dim)", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.title}</div>
                      </div>
                      <button className="btn btn-primary btn-small" onClick={() => sendInvite(l)}>
                        ⚔️ Challenge
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 120, display: "flex", flexDirection: "column", marginTop: 6 }}>
        <ChatPanel messages={room.messages} onSend={room.sendChat} disabled={!room.connected} placeholder="Viewers se baat karo…" />
      </div>
      <button className="btn btn-danger" onClick={endLive} disabled={ending} style={{ marginTop: 10, padding: "12px 16px", fontSize: 16 }}>
        {ending ? "Ending…" : "⏹ End Live"}
      </button>
    </div>
  );
}

// ---- watch room -----------------------------------------------------------------

function WatchRoom({ me, session, refreshMe, onBack }) {
  const videoRef = useRef(null);
  const matchVideoRef = useRef(null);
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
  const [muted, setMuted] = useState(true);
  // PK match state
  const [match, setMatch] = useState(null);
  const [matchResult, setMatchResult] = useState(null);

  const room = useLiveRoom(session.id, {
    onJoined: (msg) => {
      if (msg.broadcasterPeerId) mainPeerRef.current = msg.broadcasterPeerId;
    },
    onBroadcasterJoined: (msg) => {
      if (msg.matchId) matchPeerRef.current = msg.peerId;
      else mainPeerRef.current = msg.peerId;
    },
    onSignal: async (msg) => {
      if (!msg.data) return;
      if (msg.data.kind === "offer" && msg.data.description) {
        const kind = msg.from === mainPeerRef.current ? "main" : "match";
        await answerOffer(msg.from, msg.data.description, kind, { relayOnly: !!msg.data.relay });
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
    onEnded: () => closeAllPcs(),
  });
  const { sockRef } = room;

  const loadDetail = useCallback(async () => {
    const res = await call("getLive", { live_session_id: session.id });
    if (res.ok) {
      setDetail(res);
      setBalance(res.my_coin_balance);
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
    },
    []
  );

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
    if (matchVideoRef.current) matchVideoRef.current.srcObject = null;
  }

  function showVideoFailure(kind) {
    setVideoStatus("");
    if (kind === "main") setVideoError("Video connection nahi ban saka — is network par direct (P2P) connection mushkil hai. Chat phir bhi chal raha hai.");
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
    pc.ontrack = (e) => {
      const video = kind === "main" ? videoRef.current : matchVideoRef.current;
      if (video && e.streams[0]) {
        video.srcObject = e.streams[0];
        if (kind === "main") video.play().catch(() => setNeedsTap(true));
        else video.play().catch(() => {});
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
    <div style={{ height: "100%", display: "flex", flexDirection: "column", maxWidth: 640, margin: "0 auto", padding: "12px 14px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <button className="btn btn-small" onClick={onBack}>
          ← Leave
        </button>
        <LiveBadge />
        <strong style={{ flex: 1, minWidth: 100, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.title}</strong>
        <span className="chip">👀 {room.viewerCount}</span>
        <span className="chip">🪙 {balance}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
        <Avatar user={broadcaster} size={30} />
        <span style={{ fontSize: 14 }}>
          {broadcaster?.display_name} <span style={{ color: "var(--dim)" }}>@{broadcaster?.username}</span>
        </span>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10, flexShrink: 0 }}>
        <div style={{ position: "relative", background: "#000", borderRadius: 16, overflow: "hidden", flex: 1, aspectRatio: match ? undefined : "16/10", height: match ? 230 : undefined }}>
          <video ref={videoRef} autoPlay playsInline muted={muted} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          {room.ended ? (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.7)", fontSize: 18, fontWeight: 700 }}>
              📴 {ENDED_TEXT}
            </div>
          ) : needsTap ? (
            <button
              onClick={() => {
                videoRef.current?.play().catch(() => {});
                setNeedsTap(false);
              }}
              style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.45)", color: "#fff", border: "none", fontSize: 20, fontWeight: 700 }}
            >
              ▶ Tap to play
            </button>
          ) : null}
          <button onClick={() => setMuted((m) => !m)} style={{ position: "absolute", right: 10, bottom: 10, background: "rgba(0,0,0,0.6)", border: "none", borderRadius: 10, padding: "6px 10px", fontSize: 16 }} aria-label="Sound">
            {muted ? "🔇" : "🔊"}
          </button>
          {match && (
            <div style={{ position: "absolute", left: 10, top: 10, background: "rgba(0,0,0,0.65)", borderRadius: 10, padding: "4px 8px", fontSize: 13 }}>
              @{broadcaster?.username}
            </div>
          )}
        </div>
        {match && (
          <div style={{ position: "relative", background: "#000", borderRadius: 16, overflow: "hidden", flex: 1, height: 230 }}>
            <video ref={matchVideoRef} autoPlay playsInline style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            <div style={{ position: "absolute", left: 10, top: 10, background: "rgba(224,36,94,0.8)", borderRadius: 10, padding: "4px 8px", fontSize: 13 }}>
              ⚔️ @{matchOpponent?.user?.username}
            </div>
          </div>
        )}
      </div>
      {match && <MatchBar match={match} />}
      <MatchResultBanner result={matchResult} myUserId={me.id} />
      <Notice text={videoStatus} />
      <Notice text={videoError} bad />
      <Notice text={room.authError} bad />
      <Notice text={error} bad />
      <Notice text={notice} />

      {!room.ended && gifts.length > 0 && (
        <div style={{ marginTop: 4, flexShrink: 0 }}>
          <div style={{ fontSize: 13, color: "var(--dim)", marginBottom: 6 }}>
            🎁 Gift bhejo — aadhe coins broadcaster ko jayenge{match ? ", aur poori value uski PK score me judegi" : ""}. Tumhara balance: <strong style={{ color: "var(--text)" }}>🪙 {balance}</strong>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
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
      )}

      <div style={{ flex: 1, minHeight: 110, display: "flex", flexDirection: "column", marginTop: 6 }}>
        <ChatPanel messages={room.messages} onSend={room.sendChat} disabled={!room.connected || room.ended} placeholder="Chat me kuch likho…" />
      </div>
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
          <span style={{ color: "var(--dim)" }}>💰 Tumhari kamai (50%)</span>
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
