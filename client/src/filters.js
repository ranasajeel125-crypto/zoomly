// Face filters for Zoomly LIVE broadcasters (the host and a seated
// guest). The broadcaster picks a filter; viewers see it too, because
// the filter is rendered INTO the published video, not just previewed.
//
// How it works: the camera stream is drawn onto a canvas with a CSS
// filter applied, and the canvas's captureStream() video track — plus
// the camera's original audio tracks — is the stream that gets
// published to peers and shown in the local preview. Switching filters
// only changes what the canvas draws with; the published track is never
// replaced, so a mid-broadcast switch cannot drop or renegotiate the
// broadcast.
//
// These are colour/beauty filters. Face-tracked AR stickers (dog ears
// or sunglasses that follow the face) are NOT part of this — they need
// a face-landmark engine and are a separate future job.
//
// Fallback: browsers that cannot process the camera this way (no
// canvas captureStream, or a 2d context without filter support — e.g.
// older Safari) get createVideoProcessor() === null, and the caller
// publishes the raw camera exactly as before. Filters must never block
// going live.
//
// The chosen filter persists (localStorage) like the sound preference:
// a broadcaster's next live starts with the filter they last picked.
const KEY = "zoomly_live_filter";

export const LIVE_FILTERS = [
  { key: "normal", label: "Normal", css: "" },
  // Beauty is drawn by the processor as a blend (sharp base + blurred,
  // brightened copy at low alpha) for a soft-skin look; its `css` here
  // is the single-pass approximation used if blending is unavailable.
  { key: "beauty", label: "Beauty", css: "brightness(1.07) contrast(0.96) saturate(1.08)" },
  { key: "bright", label: "Bright", css: "brightness(1.24) contrast(1.03) saturate(1.05)" },
  { key: "warm", label: "Warm", css: "sepia(0.34) saturate(1.22) contrast(0.99) brightness(1.03)" },
  { key: "cool", label: "Cool", css: "saturate(0.88) contrast(1.03) brightness(1.06) hue-rotate(14deg)" },
  { key: "vivid", label: "Vivid", css: "saturate(1.55) contrast(1.08)" },
  { key: "bw", label: "B&W", css: "grayscale(1) contrast(1.06)" },
];

export function filterByKey(key) {
  return LIVE_FILTERS.find((f) => f.key === key) ?? LIVE_FILTERS[0];
}

export function getLiveFilter() {
  try {
    const v = localStorage.getItem(KEY);
    return LIVE_FILTERS.some((f) => f.key === v) ? v : "normal";
  } catch {
    return "normal";
  }
}

export function setLiveFilter(key) {
  try {
    if (LIVE_FILTERS.some((f) => f.key === key)) localStorage.setItem(KEY, key);
  } catch {
    /* storage unavailable (private mode) — the choice just won't persist */
  }
}

// True when this browser can run the canvas pipeline: canvas
// captureStream exists AND the 2d context actually applies `filter`
// (it silently ignores the property in some browsers, so we set a
// value and read it back).
export function filtersSupported() {
  try {
    if (typeof document === "undefined" || typeof MediaStream === "undefined") return false;
    const canvas = document.createElement("canvas");
    if (typeof canvas.captureStream !== "function") return false;
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    ctx.filter = "blur(2px)";
    return ctx.filter === "blur(2px)";
  } catch {
    return false;
  }
}

// Runs a camera stream through the filter canvas.
// Returns { stream, filter, setFilter(key), stop(), halt(),
// setOnStall(fn), framesDrawn, sourceStream } — or null when processing
// is unavailable/failed, in which case the caller publishes the raw
// source stream unchanged.
//
// `stream` carries the processed video track + the source's audio
// tracks (audio is passed through untouched). stop() cancels the draw
// loop, stops the processed track, and stops the source VIDEO track it
// consumed (nothing else can use that feed once the processor is gone);
// the source's audio tracks ride inside `stream`, so the caller's usual
// stream cleanup stops them. halt() is the gentler stop: it ends
// processing and the canvas track but leaves the raw camera track
// running — used when the room swaps its senders to the raw track
// after a stall (see setOnStall).
//
// Real-world failure this guards against: on some phones the canvas
// pipeline never produces a frame (the detached <video> never starts
// presenting frames, or requestAnimationFrame is throttled to zero),
// which would otherwise publish a silent black rectangle forever. The
// draw loop therefore runs on THREE schedulers (video frame callbacks,
// RAF, and a plain timer watchdog), and if no frame has been drawn for
// a few seconds the stall hook fires so the room can fall back to the
// raw camera track (replaceTrack — no renegotiation needed).
export function createVideoProcessor(sourceStream, initialKey = "normal") {
  try {
    const videoTrack = sourceStream?.getVideoTracks?.()[0];
    if (!videoTrack || !filtersSupported()) return null;

    const settings = videoTrack.getSettings?.() ?? {};
    const canvas = document.createElement("canvas");
    canvas.width = settings.width || 640;
    canvas.height = settings.height || 480;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.srcObject = new MediaStream([videoTrack]);
    const sizeFromVideo = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }
    };
    video.addEventListener("loadedmetadata", sizeFromVideo);
    video.play().catch(() => {});

    let currentKey = filterByKey(initialKey).key;
    let stopped = false;
    let raf = 0;
    let vfcHandle = 0;
    let watchdog = 0;
    let framesDrawn = 0;
    let lastDrawAt = 0;
    const startedAt = Date.now();
    let stallFired = false;
    let onStall = null;

    const drawFrame = () => {
      const w = canvas.width;
      const h = canvas.height;
      if (currentKey === "beauty") {
        // Soft skin: a sharp, gently brightened base with a blurred
        // copy blended over it at low alpha smooths skin texture
        // without washing out the whole picture.
        ctx.globalAlpha = 1;
        ctx.filter = "brightness(1.06) saturate(1.06)";
        ctx.drawImage(video, 0, 0, w, h);
        ctx.globalAlpha = 0.38;
        ctx.filter = "blur(3px) brightness(1.1)";
        ctx.drawImage(video, 0, 0, w, h);
        ctx.globalAlpha = 1;
        ctx.filter = "none";
      } else {
        ctx.globalAlpha = 1;
        ctx.filter = filterByKey(currentKey).css || "none";
        ctx.drawImage(video, 0, 0, w, h);
        ctx.filter = "none";
      }
    };

    const tryDraw = () => {
      if (stopped) return;
      try {
        if (video.readyState >= 2) {
          if (video.videoWidth > 0 && canvas.width !== video.videoWidth) sizeFromVideo();
          drawFrame();
          framesDrawn += 1;
          lastDrawAt = Date.now();
        }
      } catch {
        /* a transient draw error must not kill the loop */
      }
    };

    // Scheduler 1: animation frames (the normal path).
    const draw = () => {
      if (stopped) return;
      tryDraw();
      raf = requestAnimationFrame(draw);
    };
    draw();
    // Scheduler 2: the video element's own frame callbacks — these fire
    // per presented camera frame even where page RAF is throttled.
    const pumpVideoFrames = () => {
      if (stopped) return;
      tryDraw();
      if (typeof video.requestVideoFrameCallback === "function") {
        vfcHandle = video.requestVideoFrameCallback(pumpVideoFrames);
      }
    };
    if (typeof video.requestVideoFrameCallback === "function") pumpVideoFrames();
    // Scheduler 3 + stall watchdog: a plain timer that redraws when the
    // other schedulers have gone quiet, re-kicks a paused video element,
    // and reports a stall when frames simply never come.
    watchdog = setInterval(() => {
      if (stopped) return;
      const now = Date.now();
      if (now - lastDrawAt > 350) {
        if (video.paused && video.readyState >= 2) video.play().catch(() => {});
        tryDraw();
      }
      const quietFor = now - Math.max(startedAt, lastDrawAt);
      if (!stallFired && quietFor > 3000 && videoTrack.readyState === "live") {
        stallFired = true;
        try {
          onStall?.();
        } catch {
          /* the hook must never break the processor */
        }
      }
    }, 400);

    let outTrack = null;
    try {
      const captured = canvas.captureStream(settings.frameRate || 30);
      outTrack = captured.getVideoTracks()[0] ?? null;
    } catch {
      outTrack = null;
    }
    if (!outTrack) {
      stopped = true;
      cancelAnimationFrame(raf);
      clearInterval(watchdog);
      try {
        video.pause();
      } catch {
        /* ignore */
      }
      video.srcObject = null;
      return null;
    }

    const stream = new MediaStream([outTrack, ...sourceStream.getAudioTracks()]);
    const halt = () => {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(raf);
      clearInterval(watchdog);
      if (vfcHandle && typeof video.cancelVideoFrameCallback === "function") {
        try {
          video.cancelVideoFrameCallback(vfcHandle);
        } catch {
          /* ignore */
        }
      }
      try {
        outTrack.stop();
      } catch {
        /* ignore */
      }
      try {
        video.pause();
      } catch {
        /* ignore */
      }
      video.srcObject = null;
    };
    return {
      stream,
      sourceStream,
      get filter() {
        return currentKey;
      },
      get framesDrawn() {
        return framesDrawn;
      },
      setFilter(key) {
        if (LIVE_FILTERS.some((f) => f.key === key)) currentKey = key;
      },
      setOnStall(fn) {
        onStall = typeof fn === "function" ? fn : null;
      },
      halt,
      stop() {
        halt();
        try {
          videoTrack.stop();
        } catch {
          /* ignore */
        }
      },
    };
  } catch {
    return null;
  }
}
