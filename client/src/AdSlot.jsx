import { useEffect, useState } from "react";

// AdSense banner slot, fully gated on server config (GET /api/health).
// With no publisher ID configured (the default), this renders NOTHING:
// no script is loaded, no empty box, no layout change, no extra scroll
// stop — the feed is byte-for-byte identical to before this component.
// To activate later (no client rebuild needed): set ADSENSE_CLIENT_ID
// (e.g. ca-pub-XXXXXXXXXXXXXXXX) and ADSENSE_AD_SLOT on Render, then
// restart the service. The client ID alone loads the script (Auto Ads
// can use it); the manual responsive unit below additionally needs the
// ad-slot ID, so the unit itself renders only when both are present.
// Never hard-code a real ID here — it lives only in Render env vars.

// Module-level guard: the AdSense script must be injected at most once
// per page load, even if the feed mounts/unmounts across tab switches.
let scriptLoadedFor = null;

export default function AdSlot() {
  const [cfg, setCfg] = useState(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/health")
      .then((r) => r.json())
      .then((h) => {
        if (alive) setCfg({ clientId: h.adsense_client_id || null, adSlot: h.adsense_ad_slot || null });
      })
      .catch(() => {
        // Health unreachable (server waking up): stay invisible, never an error box.
        if (alive) setCfg({ clientId: null, adSlot: null });
      });
    return () => {
      alive = false;
    };
  }, []);

  const clientId = cfg?.clientId;
  const adSlot = cfg?.adSlot;

  useEffect(() => {
    if (!clientId || scriptLoadedFor === clientId) return;
    const s = document.createElement("script");
    s.async = true;
    s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(clientId)}`;
    s.crossOrigin = "anonymous";
    document.head.appendChild(s);
    scriptLoadedFor = clientId;
  }, [clientId]);

  useEffect(() => {
    if (!clientId || !adSlot) return;
    // Standard AdSense pattern: pushing onto the queue works even before
    // the script finishes loading; the ins below is already committed.
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch {
      // AdSense not ready — the unit stays empty, never an error box.
    }
  }, [clientId, adSlot]);

  if (!clientId || !adSlot) return null;

  return (
    <div style={{ scrollSnapAlign: "start", padding: "14px 12px 24px" }}>
      <ins
        className="adsbygoogle"
        style={{ display: "block" }}
        data-ad-client={clientId}
        data-ad-slot={adSlot}
        data-ad-format="auto"
        data-full-width-responsive="true"
      />
    </div>
  );
}
