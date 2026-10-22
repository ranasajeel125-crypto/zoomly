import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    // Local dev: forward API calls to the Express server on :3000.
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
