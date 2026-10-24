import { useEffect } from "react";

// Monetag MultiTag loader, fully gated on server config (GET /api/health).
// With no tag URL configured (the default), this loads NOTHING: no script
// tag is injected, no network request is made, and nothing visible changes
// anywhere in the app. When the owner later sets MONETAG_TAG_URL on Render
// (no client rebuild needed — the value is read from /api/health), the
// publisher's single MultiTag script is injected exactly once per page
// load. No ad format (popunder, push, vignette, ...) is configured or
// enabled in code — formats are controlled entirely in the publisher's
// Monetag dashboard. Never hard-code a real tag URL here — it lives only
// in Render env vars. The URL must be https; anything else is ignored.

// Module-level guard: the tag must be injected at most once per page
// load, even if App mounts/unmounts across auth transitions.
let injectedUrl = null;

export default function MonetagLoader() {
  useEffect(() => {
    let alive = true;
    fetch("/api/health")
      .then((r) => r.json())
      .then((h) => {
        if (!alive) return;
        const url = typeof h.monetag_tag_url === "string" ? h.monetag_tag_url.trim() : "";
        if (!url || !url.startsWith("https://")) return;
        if (injectedUrl === url) return;
        const s = document.createElement("script");
        s.async = true;
        s.src = url;
        document.head.appendChild(s);
        injectedUrl = url;
      })
      .catch(() => {
        // Health unreachable (server waking up): load nothing, never an error.
      });
    return () => {
      alive = false;
    };
  }, []);

  return null;
}
