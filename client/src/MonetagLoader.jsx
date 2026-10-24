import { useEffect } from "react";

// Monetag tag loader, fully gated on server config (GET /api/health).
// With no tag URL configured (the default), this loads NOTHING: no script
// tag is injected, no network request is made, and nothing visible changes
// anywhere in the app. When the owner later sets MONETAG_TAG_URL on Render
// (no client rebuild needed — the value is read from /api/health), the
// tag script(s) are injected exactly once per page load. MONETAG_TAG_URL
// may hold a single tag URL or a comma-separated list of them (one per
// Monetag zone, e.g. the individual In-Page Push and Vignette zones — the
// MultiTag is deliberately NOT used, so no popunder is ever enabled).
// Each injected script tag carries its zone BOTH ways: the ?z= query in
// its src AND a data-zone attribute with the same zone id, because the
// tag script bytes are identical regardless of zone and the zone must be
// read from the tag at runtime. No ad format is configured or enabled in
// code — formats are controlled entirely in the publisher's Monetag
// dashboard. Never hard-code a real tag URL here — it lives only in
// Render env vars. A URL must be https; anything else is ignored.

// Module-level guard: the tags must be injected at most once per page
// load, even if App mounts/unmounts across auth transitions.
let injectedKey = null;

export default function MonetagLoader() {
  useEffect(() => {
    let alive = true;
    fetch("/api/health")
      .then((r) => r.json())
      .then((h) => {
        if (!alive) return;
        const raw = typeof h.monetag_tag_url === "string" ? h.monetag_tag_url : "";
        const urls = [...new Set(
          raw.split(",").map((u) => u.trim()).filter((u) => u.startsWith("https://")),
        )];
        if (urls.length === 0) return;
        const key = urls.join(",");
        if (injectedKey === key) return;
        for (const url of urls) {
          const s = document.createElement("script");
          s.async = true;
          s.setAttribute("data-cfasync", "false");
          try {
            const zone = new URL(url).searchParams.get("z");
            if (zone) s.setAttribute("data-zone", zone);
          } catch {
            // Malformed URL slipped past the https check: inject without
            // data-zone rather than failing the whole batch.
          }
          s.src = url;
          document.head.appendChild(s);
        }
        injectedKey = key;
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
