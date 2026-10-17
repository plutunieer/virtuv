// Baut die Mac-App: bündelt das Electron-Hauptprogramm (enthält auch den MCP-Server, esbuild), dann .dmg (electron-builder).
// Aufruf: npm run app        (nur bündeln: npm run app -- --nur-buendeln)
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { build } from "esbuild";
import { buildKennung } from "../src/build.ts";

const AUS = "electron-dist";
// Läuft der Bau im Terminal der Werkbank, steht dort die Kennung der laufenden App — die gilt nicht für den Neubau.
delete process.env.URS_APP_BUILD;

// Jeder Neubau braucht eine höhere Versionsnummer als alle schon gebauten (U47) — sonst sind sie nicht zu unterscheiden.
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const zahl = (v) => v.split(".").map(Number);
const groesser = (a, b) => { const x = zahl(a), y = zahl(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
const gebaut = existsSync("release") ? readdirSync("release").map((f) => /-(\d+\.\d+\.\d+)-arm64\.dmg$/.exec(f)?.[1]).filter(Boolean) : [];
const hoechste = gebaut.reduce((m, v) => (groesser(v, m) ? v : m), "0.0.0");
if (!process.argv.includes("--nur-buendeln") && !groesser(version, hoechste)) {
  console.error(`Version ${version} ist nicht höher als die schon gebaute ${hoechste}. Bitte in package.json erhöhen.`);
  process.exit(1);
}
mkdirSync(AUS, { recursive: true });
execFileSync("npx", ["vite", "build"], { stdio: "inherit" }); // Oberfläche → web/dist
const kennung = buildKennung(); // nach dem Oberflächen-Bau: Code + Oberfläche
const gemeinsam = {
  bundle: true, platform: "node", format: "esm", target: "node24", sourcemap: false, logLevel: "info",
  external: ["electron", "node-pty"],
  // Gebündelte Pakete nutzen teils require — in ESM bereitstellen.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
};
await build({ ...gemeinsam, entryPoints: ["electron/main.ts"], outfile: `${AUS}/main.mjs`, define: { URS_BUILD: JSON.stringify(kennung) } });
copyFileSync("electron/preload.cjs", `${AUS}/preload.cjs`);
console.log(`Gebündelt (Kennung ${kennung}).`);
if (!process.argv.includes("--nur-buendeln")) execFileSync("npx", ["electron-builder", "--mac", "dmg", "--arm64"], { stdio: "inherit" });
