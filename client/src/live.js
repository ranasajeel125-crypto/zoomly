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
// arrives, and mirrors the server's list.
//
// STUN alone cannot connect peers behind carrier-grade NAT (most mobile
// data), so the list includes TURN relays next to Google STUN. When a
// direct connection still fails, Live.jsx retries the peer once with
// iceTransportPolicy "relay" (TURN-only).
//
// The relay is Metered's Open Relay STATIC-AUTH host: its credentials
// use coturn's REST scheme — username "<expiry-unix>:zoomly", credential
// base64(HMAC-SHA1(secret, username)) — minted fresh (here for the
// fallback, and on the server for the adopted list). The old anonymous
// openrelayproject/openrelayproject credentials no longer allocate:
// Metered's Open Relay page now requires a signed-up account for that
// host. The static-auth secret below is the one Metered itself
// publishes for this host, so embedding it discloses nothing private.
const TURN_HOST = "staticauth.openrelay.metered.ca";
const TURN_SECRET = "openrelayprojectsecret";

// -- tiny synchronous SHA-1 / HMAC-SHA1 (needed to mint the credentials
// above synchronously; WebCrypto is async-only). Verified byte-identical
// to node:crypto HMAC-SHA1 on test vectors.
function sha1Bytes(input) {
  const msg = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const ml = msg.length;
  const total = (((ml + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[ml] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 4, ml * 8, false);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Int32Array(80);
  const rotl = (x, n) => (x << n) | (x >>> (32 - n));
  for (let chunk = 0; chunk < total; chunk += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getInt32(chunk + i * 4, false);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const tmp = (rotl(a, 5) + f + e + k + w[i]) | 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = tmp;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  const out = new Uint8Array(20);
  const odv = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((h, i) => odv.setInt32(i * 4, h, false));
  return out;
}

function hmacSha1Base64(keyStr, msgStr) {
  const enc = new TextEncoder();
  let key = enc.encode(keyStr);
  if (key.length > 64) key = sha1Bytes(key);
  const block = new Uint8Array(64);
  block.set(key);
  const msgBytes = enc.encode(msgStr);
  const inner = new Uint8Array(64 + msgBytes.length);
  for (let i = 0; i < 64; i++) inner[i] = block[i] ^ 0x36;
  inner.set(msgBytes, 64);
  const innerHash = sha1Bytes(inner);
  const outer = new Uint8Array(64 + 20);
  for (let i = 0; i < 64; i++) outer[i] = block[i] ^ 0x5c;
  outer.set(innerHash, 64);
  const digest = sha1Bytes(outer);
  let bin = "";
  for (const b of digest) bin += String.fromCharCode(b);
  return btoa(bin);
}

function mintFallbackIceServers() {
  const expiry = Math.floor(Date.now() / 1000) + 6 * 60 * 60;
  const username = `${expiry}:zoomly`;
  const auth = { username, credential: hmacSha1Base64(TURN_SECRET, username) };
  return {
    mintedFor: expiry,
    list: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:openrelay.metered.ca:80" },
      { urls: `turn:${TURN_HOST}:80`, ...auth },
      { urls: `turn:${TURN_HOST}:443`, ...auth },
      { urls: `turn:${TURN_HOST}:443?transport=tcp`, ...auth },
      { urls: `turns:${TURN_HOST}:443?transport=tcp`, ...auth },
    ],
  };
}

let fallbackMint = mintFallbackIceServers();
export const FALLBACK_ICE_SERVERS = fallbackMint.list;

function fallbackIceServers() {
  // Re-mint when the cached credentials are within an hour of expiring.
  if (fallbackMint.mintedFor - Math.floor(Date.now() / 1000) < 3600) {
    fallbackMint = mintFallbackIceServers();
  }
  return fallbackMint.list;
}

let activeIceServers = null; // null = no server list adopted yet

export function setIceServers(list) {
  if (Array.isArray(list) && list.length > 0) activeIceServers = list;
}

export function getIceServers() {
  return activeIceServers ?? fallbackIceServers();
}

// RTCPeerConnection configuration; relayOnly forces all media through a
// TURN relay (the retry path for networks where direct P2P fails).
export function peerConnectionConfig(relayOnly = false) {
  const config = { iceServers: getIceServers() };
  if (relayOnly) config.iceTransportPolicy = "relay";
  return config;
}

// ICE diagnostics: fire-and-forget report of a peer connection's FINAL
// outcome to the server (which logs it), so real-world failures — and
// which path finally worked — are visible in the server log instead of
// only in a phone's browser console nobody can read. Never awaited,
// never retried, failures are swallowed by design.
export function reportIce({ role, kind, state, via, relay } = {}) {
  try {
    const token = getToken();
    if (!token || !state) return;
    void fetch("/api/iceReport", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        role: String(role ?? "peer").slice(0, 24),
        kind: kind ? String(kind).slice(0, 24) : undefined,
        state: String(state).slice(0, 32),
        via: via ? String(via).slice(0, 16) : undefined,
        relay: typeof relay === "boolean" ? relay : undefined,
      }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* diagnostics must never break the room */
  }
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
    reportIce({ role: label, state: "connected", via: local?.candidateType ?? "?", relay: local?.candidateType === "relay" });
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
