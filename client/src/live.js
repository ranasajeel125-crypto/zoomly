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

// Public Google STUN servers only (no TURN in v1): most home/mobile
// networks connect fine; some strict NATs will fail — the UI says so and
// chat keeps working.
export const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

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
