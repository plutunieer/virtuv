// Baut das Claude-Code-Plugin (U70–U74): bündelt MCP-Server und Web-Server (esbuild) und kopiert die Oberfläche nach plugin/.
// Danach läuft plugin/ ohne npm install. Aufruf: npm run plugin
import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const AUS = "plugin";
delete process.env.URS_APP_BUILD; // Kennung der laufenden Mac-App gilt nicht für das Plugin

// Plugin-Version = App-Version.
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = `${AUS}/.claude-plugin/plugin.json`;
const m = JSON.parse(readFileSync(manifest, "utf8"));
if (m.version !== version) writeFileSync(manifest, JSON.stringify({ ...m, version }, null, 2) + "\n");

execFileSync("npx", ["vite", "build"], { stdio: "inherit" }); // Oberfläche → web/dist
rmSync(`${AUS}/dist`, { recursive: true, force: true });
rmSync(`${AUS}/web`, { recursive: true, force: true });
cpSync("web/dist", `${AUS}/web/dist`, { recursive: true }); // server.mjs sucht sie unter ../web/dist

// Das eingebaute Terminal gibt es nur in der App — node-pty (nativ) kommt nicht ins Plugin.
const ohneTerminal = {
  name: "ohne-terminal",
  setup(b) {
    b.onResolve({ filter: /^node-pty$/ }, () => ({ path: "node-pty", namespace: "ohne-terminal" }));
    b.onLoad({ filter: /.*/, namespace: "ohne-terminal" }, () => ({
      contents: "export default { spawn() { throw new Error('Das Terminal gibt es nur in der Virtuv-App.'); } };",
    }));
  },
};
await build({
  entryPoints: { mcp: "src/mcp.ts", server: "src/server.ts" }, outdir: `${AUS}/dist`, outExtension: { ".js": ".mjs" },
  bundle: true, platform: "node", format: "esm", target: "node20", logLevel: "info", plugins: [ohneTerminal],
  // Gebündelte Pakete nutzen teils require — in ESM bereitstellen.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
console.log(`Plugin ${version} gebaut: ${AUS}/`);
