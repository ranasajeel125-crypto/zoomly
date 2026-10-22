// Cloudinary media uploads (videos + profile photos).
// Signed uploads done with plain fetch + SHA-1 signatures — no SDK needed.
// If the CLOUDINARY_* env vars are missing, uploads fail with a clear error:
// media is NEVER written to the server's local disk (ephemeral on Render).
import crypto from "node:crypto";
import { cloudinaryConfig } from "./config.mjs";

function sign(params, apiSecret) {
  const toSign = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return crypto.createHash("sha1").update(toSign + apiSecret).digest("hex");
}

// Upload a file buffer. kind: "video" | "image".
// Returns { url, publicId, thumbnailUrl } on success or { ok:false, message }.
export async function uploadToCloudinary(buffer, { kind, filename }) {
  const cfg = cloudinaryConfig();
  if (!cfg.configured) {
    return {
      ok: false,
      message: "Media uploads are not configured on this server yet. The owner must set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET (free Cloudinary account) before videos or photos can be uploaded.",
    };
  }
  const resourceType = kind === "video" ? "video" : "image";
  const folder = kind === "video" ? "zoomly/videos" : "zoomly/avatars";
  const timestamp = Math.floor(Date.now() / 1000);
  const params = { folder, timestamp };
  const signature = sign(params, cfg.apiSecret);

  const form = new FormData();
  form.append("file", new Blob([buffer]), filename || (kind === "video" ? "video.mp4" : "photo.jpg"));
  form.append("api_key", cfg.apiKey);
  form.append("timestamp", String(timestamp));
  form.append("folder", folder);
  form.append("signature", signature);

  let res;
  try {
    res = await fetch(`https://api.cloudinary.com/v1_1/${cfg.cloudName}/${resourceType}/upload`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(120000),
    });
  } catch {
    return { ok: false, message: "Could not reach the media storage service. Please try again." };
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.secure_url) {
    return { ok: false, message: data?.error?.message || `Media upload failed (HTTP ${res.status}).` };
  }
  let thumbnailUrl = null;
  if (kind === "video" && data.public_id) {
    // Cloudinary can derive a poster frame from the video at 1 second.
    thumbnailUrl = `https://res.cloudinary.com/${cfg.cloudName}/video/upload/so_1/${data.public_id}.jpg`;
  }
  return { ok: true, url: data.secure_url, publicId: data.public_id, thumbnailUrl };
}

// Best-effort delete of a previously uploaded asset (used when a post or DP
// is removed). Failures are ignored — the DB stays the source of truth.
export async function destroyFromCloudinary(publicId, kind) {
  const cfg = cloudinaryConfig();
  if (!cfg.configured || !publicId) return;
  const resourceType = kind === "video" ? "video" : "image";
  const timestamp = Math.floor(Date.now() / 1000);
  const params = { public_id: publicId, timestamp };
  const signature = sign(params, cfg.apiSecret);
  const form = new FormData();
  form.append("public_id", publicId);
  form.append("api_key", cfg.apiKey);
  form.append("timestamp", String(timestamp));
  form.append("signature", signature);
  try {
    await fetch(`https://api.cloudinary.com/v1_1/${cfg.cloudName}/${resourceType}/destroy`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    /* best effort */
  }
}
