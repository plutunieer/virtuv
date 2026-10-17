import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

// Versionsnummer aus package.json — steht oben links in der App (U46).
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  root: "web",
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 3000 },
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:8812", "/ws": { target: "ws://127.0.0.1:8812", ws: true } },
  },
});
