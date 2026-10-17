// Mac-App „Virtuv“ (U60, früher „URS Werkbank“): startet den Werkbank-Server im App-Prozess und zeigt ihn in einem eigenen Fenster.
// Beim Beenden werden alle Claude-Terminals mit beendet.
// Mit dem Schalter --urs-mcp läuft dieselbe App stattdessen unsichtbar als MCP-Server (URS-Werkzeuge für Claude) —
// so braucht es den Electron-Node-Modus nicht, der per Fuse gesperrt ist.
import { randomBytes } from "node:crypto";
import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

declare const URS_BUILD: string; // beim Bündeln eingesetzt

const HIER = dirname(fileURLToPath(import.meta.url));
const ERSTER_PORT = 8822; // eigener Bereich: kommt dem Browser-Betrieb (8812) nicht in die Quere

// Server- und MCP-Modul nicht als eigenständiges Programm starten lassen (gleiche import.meta.url im Bündel).
(globalThis as { ursAppGebuendelt?: boolean }).ursAppGebuendelt = true;
process.env.URS_APP_BUILD = URS_BUILD;

// Gespeicherte Ansicht und Chats (localStorage) liegen weiter im alten Ordner „URS Werkbank“ — sonst wären sie nach der
// Umbenennung in „Virtuv“ (U60) weg. Muss vor app.whenReady passieren. Ein ausdrückliches --user-data-dir (z. B. für
// eine Testkopie neben der laufenden App) hat Vorrang.
if (!app.commandLine.hasSwitch("user-data-dir")) app.setPath("userData", join(app.getPath("appData"), "URS Werkbank"));

if (process.argv.includes("--urs-mcp")) {
  // ---------- Unsichtbarer MCP-Server für das Claude-Terminal ----------
  app.dock?.hide();
  const { baueMcp } = await import("../src/mcp.ts");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const transport = new StdioServerTransport();
  transport.onclose = () => app.exit(0);
  process.stdin.on("end", () => app.exit(0));
  await baueMcp().connect(transport);
} else {
  starteApp();
}

function starteApp() {
  process.env.URS_APP_KEIN_BROWSER = "1";
  // Startargumente, mit denen das Claude-Terminal die App als MCP-Server aufruft.
  process.env.URS_APP_MCP_ARGS = JSON.stringify(app.isPackaged ? ["--urs-mcp"] : [app.getAppPath(), "--urs-mcp"]);
  // Zufallsschlüssel je Start: nur dieses Fenster (Cookie) kennt ihn — nie in die Umgebung, sonst erbt ihn Claude im Terminal (U53).
  const schluessel = randomBytes(32).toString("hex");

  let fenster: BrowserWindow | null = null;
  let basis = "";
  let beenden: (() => void) | null = null;

  async function starteServer() {
    const { starteServer: start } = await import("../src/server.ts");
    const { beendeTerminals } = await import("../src/terminal.ts");
    beenden = beendeTerminals;
    for (let port = ERSTER_PORT; port < ERSTER_PORT + 20; port++) {
      process.env.URS_APP_PORT = String(port);
      try { await start(port, { macApp: true, schluessel }); return port; } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
      }
    }
    throw new Error(`Kein freier Port zwischen ${ERSTER_PORT} und ${ERSTER_PORT + 19}`);
  }

  /** Eigene Seite? Genaue Herkunft vergleichen (nicht startsWith — „127.0.0.1:8822.evil.com“). */
  const eigen = (url: string) => { try { return new URL(url).origin === basis; } catch { return false; } };
  /** Nur Web-Adressen nach außen öffnen — keine file:, smb: oder Adressen anderer Programme. */
  const extern = (url: string) => { try { if (/^https?:$/.test(new URL(url).protocol)) shell.openExternal(url); } catch { /* ungültig */ } };

  async function oeffneFenster(port: number) {
    basis = `http://127.0.0.1:${port}`;
    await session.defaultSession.cookies.set({ url: basis, name: "urs_schluessel", value: schluessel, httpOnly: true, sameSite: "strict" });
    fenster = new BrowserWindow({
      width: 1500, height: 950, minWidth: 900, minHeight: 600, title: "Virtuv", backgroundColor: "#f7fafd",
      webPreferences: { preload: join(HIER, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false }, // Bild für Claude auch im Hintergrund
    });
    fenster.webContents.setWindowOpenHandler(({ url }) => { extern(url); return { action: "deny" }; });
    fenster.webContents.on("will-navigate", (e, url) => { if (!eigen(url)) { e.preventDefault(); extern(url); } });
    fenster.loadURL(`${basis}/w`);
    fenster.on("closed", () => { fenster = null; });
  }

  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  app.on("second-instance", () => { if (fenster) { if (fenster.isMinimized()) fenster.restore(); fenster.focus(); } });

  // Keine weiteren Fenster, keine eingebetteten Fremdseiten.
  app.on("web-contents-created", (_e, wc) => {
    wc.setWindowOpenHandler(({ url }) => { extern(url); return { action: "deny" }; });
    wc.on("will-attach-webview", (e) => e.preventDefault());
  });

  ipcMain.handle("ordner-waehlen", async (e, sprache: unknown) => {
    const de = sprache === "de"; // Sprache der Oberfläche (U57, U58)
    if (!e.senderFrame || !eigen(e.senderFrame.url)) return null; // nur aus dem eigenen Fenster
    const r = await dialog.showOpenDialog(fenster ?? undefined!, {
      title: de ? "Projektordner wählen" : "Choose project folder", buttonLabel: de ? "Öffnen" : "Open", properties: ["openDirectory", "createDirectory"],
    });
    return r.canceled ? null : r.filePaths[0] ?? null;
  });

  app.whenReady().then(async () => {
    // Kein Kamera-, Mikrofon-, Standort- … Zugriff; nur in die Zwischenablage schreiben (Knopf „Kopieren“).
    session.defaultSession.setPermissionRequestHandler((_wc, recht, ok) => ok(recht === "clipboard-sanitized-write"));
    try { await oeffneFenster(await starteServer()); } catch (e) {
      dialog.showErrorBox("Virtuv startet nicht / does not start", String((e as Error).message));
      app.quit();
    }
  });

  // Fenster zu = App zu: keine Claude-Prozesse laufen im Hintergrund weiter.
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => beenden?.());
}
