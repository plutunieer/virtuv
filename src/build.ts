// Kennung des aktuellen Codes (Server + Oberfläche). Unterscheidet sich, sobald eine Datei geändert oder neu gebaut wurde.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WURZEL = join(dirname(fileURLToPath(import.meta.url)), "..");

export function buildKennung(): string {
  if (process.env.URS_APP_BUILD) return process.env.URS_APP_BUILD; // Mac-App: beim Bauen festgelegt
  const h = createHash("sha256");
  // dist: gebündeltes Plugin (dist/*.mjs)
  for (const ort of ["src", "dist", "web/dist/assets"]) {
    const d = join(WURZEL, ort);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).sort()) if (/\.(ts|m?js|css)$/.test(f)) h.update(f).update(readFileSync(join(d, f)));
  }
  return h.digest("hex").slice(0, 12);
}
