// Viewer sound preference, shared by every video player in the app
// (Home/For You feed, Watch, the upload preview, and the Live watch
// screen).
//
// The rule: sound is ON by default everywhere. A video is only ever
// muted because the VIEWER muted it — and that choice persists
// (localStorage) as their preference for every player from then on.
// Browsers may still force a muted autoplay before the user's first
// interaction with the page; players detect that, start muted, and show
// a tappable "🔊 Sound on" overlay instead of staying silent — the
// stored preference itself is never changed by that fallback.
const KEY = "zoomly_muted";

export function viewerMuted() {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setViewerMuted(muted) {
  try {
    localStorage.setItem(KEY, muted ? "1" : "0");
  } catch {
    /* storage unavailable (private mode) — the choice just won't persist */
  }
}
