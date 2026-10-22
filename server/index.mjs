// Zoomly server (Node 20+).
// - POST /api/<actionName>  -> runs the matching action from actions.mjs (JSON)
// - POST /api/upload        -> multipart media upload (video or photo) to Cloudinary
// - GET  /api/health        -> liveness check (used by Render)
// - Serves the built Vite client from ../client/dist for everything else.
import express from "express";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Actions } from "./actions.mjs";
import { initDb } from "./db.mjs";
import { uploadToCloudinary } from "./cloudinary.mjs";
import { cloudinaryConfig } from "./config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "zoomly", media_configured: cloudinaryConfig().configured });
});

// Media upload: multipart form with fields `token`, `kind` ("video"|"image")
// and the file in `file`. The file is forwarded straight to Cloudinary —
// it is never written to this server's disk. Returns the hosted URL, which
// the client then saves via createPost (video) or setAvatar (image).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB max (videos)
});

app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    const token = req.body?.token;
    const kind = req.body?.kind === "image" ? "image" : "video";
    if (!token) return res.status(401).json({ ok: false, message: "Please sign in." });
    // Reuse the getMe action as the auth check so upload auth matches the API.
    const me = await Actions.getMe({ token });
    if (!me.ok) return res.status(401).json({ ok: false, message: "Please sign in." });
    if (!req.file) return res.status(400).json({ ok: false, message: "No file was uploaded." });
    if (kind === "image" && req.file.size > 10 * 1024 * 1024) {
      return res.status(400).json({ ok: false, message: "Profile photo must be under 10 MB." });
    }
    const result = await uploadToCloudinary(req.file.buffer, { kind, filename: req.file.originalname });
    if (!result.ok) return res.status(503).json(result);
    return res.json({ ok: true, url: result.url, public_id: result.publicId, thumbnail_url: result.thumbnailUrl });
  } catch (err) {
    console.error("[upload] failed:", err && err.message ? err.message : err);
    return res.status(500).json({ ok: false, message: "Upload failed. Please try again." });
  }
});

app.post("/api/:action", async (req, res) => {
  const name = req.params.action;
  const handler = Actions[name];
  if (typeof handler !== "function") {
    return res.status(404).json({ ok: false, message: "Unknown action." });
  }
  try {
    const result = await handler(req.body ?? {});
    res.json(result ?? { ok: false, message: "Empty response." });
  } catch (err) {
    console.error(`[api] action "${name}" threw:`, err && err.message ? err.message : err);
    res.status(500).json({ ok: false, message: "Something went wrong. Please try again." });
  }
});

const clientDir = path.join(__dirname, "..", "client", "dist");
app.use(express.static(clientDir, { maxAge: "1h", index: false }));
// SPA fallback: every non-API route serves the client.
app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(path.join(clientDir, "index.html"));
});

async function main() {
  await initDb();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[server] Zoomly listening on port ${PORT}`);
    if (!cloudinaryConfig().configured) {
      console.log("[server] WARNING: CLOUDINARY_* env vars are not set — video/photo uploads will fail with a 'not configured' message until they are.");
    }
  });
}

main().catch((err) => {
  console.error("[server] failed to start:", err && err.message ? err.message : err);
  process.exit(1);
});
