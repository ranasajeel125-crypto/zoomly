// WebSocket client for Zoomly LIVE (/ws on the same origin).
//
// The socket carries WebRTC signaling (offer/answer/ICE relayed by the
// server), live chat, viewer counts and gift events. Media itself is
// peer-to-peer (WebRTC) and never passes through the server.
//
// Usage:
//   const sock = openLiveSocket({
//     onAuth: ({ peerId, user }) => {},
//     onMessage: (msg) => {},   // every server message
//     onClose: () => {},
//   });
//   sock.join(sessionId); sock.chat("hi"); sock.signal(peerId, data);
//   sock.close();
import { getToken } from "./api.js";

// ICE servers for the WebRTC peer connections. The server is the source
// of truth (server/config.mjs): startLive/getLive return the list as
// `ice_servers` and the app adopts it via setIceServers(), so TURN
// credentials can be rotated server-side without a client release. This
// built-in copy is only a fallback for peers set up before that response
// arrives, and must match the server's list.
//
// STUN alone cannot connect peers behind carrier-grade NAT (most mobile
// data), so the list includes TURN relays (Metered Open Relay) next to
// Google STUN. When a direct connection still fails, Live.jsx retries
// the peer once with iceTransportPolicy "relay" (TURN-only).
export const FALLBACK_ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:openrelay.metered.ca:80" },
  { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turns:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
];

let activeIceServers = FALLBACK_ICE_SERVERS;

export function setIceServers(list) {
  if (Array.isArray(list) && list.length > 0) activeIceServers = list;
}

export function getIceServers() {
  return activeIceServers;
}

// RTCPeerConnection configuration; relayOnly forces all media through a
// TURN relay (the retry path for networks where direct P2P fails).
export function peerConnectionConfig(relayOnly = false) {
  const config = { iceServers: activeIceServers };
  if (relayOnly) config.iceTransportPolicy = "relay";
  return config;
}

// Debug aid: after a peer connects, log which ICE candidate type won
// (host = same LAN, srflx = direct NAT traversal, relay = via TURN) so
// connection problems can be diagnosed from the browser console.
export async function logSelectedCandidatePair(pc, label = "peer") {
  try {
    const stats = await pc.getStats();
    let selectedId = null;
    stats.forEach((r) => {
      if (r.type === "transport" && r.selectedCandidatePairId) selectedId = r.selectedCandidatePairId;
    });
    let pair = null;
    stats.forEach((r) => {
      if (r.type !== "candidate-pair") return;
      if (selectedId ? r.id === selectedId : r.state === "succeeded" && r.nominated) pair = r;
    });
    if (!pair) return;
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    console.info(`[zoomly-live] ${label}: connected via ${local?.candidateType ?? "?"} candidate (remote: ${remote?.candidateType ?? "?"})`);
  } catch {
    /* stats are best-effort diagnostics */
  }
}

export function openLiveSocket(handlers = {}) {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
  let peerId = null;
  let closed = false;

  const api = {
    get peerId() {
      return peerId;
    },
    get ready() {
      return ws.readyState === WebSocket.OPEN;
    },
    send(obj) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify(obj));
        } catch {
          /* socket is going away */
        }
      }
    },
    join(liveSessionId) {
      api.send({ type: "join", liveSessionId });
    },
    leave() {
      api.send({ type: "leave" });
    },
    chat(text) {
      api.send({ type: "chat", text });
    },
    signal(to, data) {
      api.send({ type: "signal", to, data });
    },
    close() {
      closed = true;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
  };

  ws.onopen = () => {
    // First message must authenticate with the app's session token.
    api.send({ type: "auth", token: getToken() });
  };
  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "auth-ok") {
      peerId = msg.peerId;
      handlers.onAuth?.(msg);
    }
    if (msg.type === "auth-error") {
      handlers.onAuthError?.(msg);
    }
    handlers.onMessage?.(msg);
  };
  ws.onclose = () => {
    if (!closed) handlers.onClose?.();
  };
  ws.onerror = () => {
    /* onclose follows and does the reporting */
  };

  return api;
}
