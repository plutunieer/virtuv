// Web-App: liefert die Oberfläche aus, nimmt Kommentare/Änderungen/Freigabe an, meldet neue Versionen live.
// Nur auf 127.0.0.1 erreichbar.
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { z, ZodError } from "zod";
import { MAX_BILD, legeBildAb } from "./bilder.ts";
import { buildKennung } from "./build.ts";
import { beispielHtml, blockFrage, gespraechBeenden, ladeBeispiele, ladeChats, merkeFrage, vorschlagEntscheiden } from "./chat.ts";
import { pruefeEinrichtungGepuffert } from "./einrichtung.ts";
import {
  GUELTIGER_CHAT, anzahlTerminals, beendeTerminal, chatSchliessen, beendeTerminals, hinweisAnChats, phaseAbgleichen,
  schreibeInTerminal, hatChats, terminalLaeuft, umziehenTerminal, umzugAbgebrochen, umzugFertig, verbindeTerminal,
} from "./terminal.ts";
import {
  UrsFehler, abmelden, alleOrdner, alleProjekte, anmelden, freigeben, ladeArbeit, ladeProjekt, ladeVersion,
  leerenEntwurfEntfernen, neuerEntwurf, offen, ohneOrdner, pfadVon, projektId, speichereArbeit, umziehen, umzugsZiel, versionen, verwerfen,
} from "./store.ts";

export const PORT = Number(process.env.URS_APP_PORT ?? 8812);
const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "dist");
// Kein Einbetten in fremde Seiten (Klick-Falle auf „Freigeben“).
const SCHUTZ = {
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'; default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "base-uri 'none'; form-action 'none'; object-src 'none'",
};
const TYPEN: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};

/** Ordner wie gewählt (Namen dürfen mit Leerzeichen enden, U36), sonst ohne Leerraum am Rand (eingetippt); ~ = Heimordner. */
function gewaehlterPfad(roh: string) {
  const ausbauen = (s: string) => s.replace(/^~(?=$|\/)/, homedir());
  const genau = ausbauen(roh);
  return existsSync(genau) ? genau : ausbauen(roh.trim());
}

/**
 * macApp: läuft in der Mac-App — /api/beenden ist dann gesperrt (sonst könnte jedes lokale Programm die App beenden).
 * schluessel: gesetzt (Mac-App) → jede /api-Anfrage und jede Live-Verbindung braucht ihn (Cookie urs_schluessel
 * oder Kopfzeile x-urs-schluessel). Hält andere Programme auf dem Mac fern; im Browser-Betrieb ohne Schlüssel.
 */
export function starteServer(port = PORT, opt: { macApp?: boolean; schluessel?: string } = {}) {
  const build = buildKennung();
  const erlaubt = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const zuschauer = new Map<string, Set<WebSocket>>();
  const umzugLaeuft = new Set<string>(); // Plan-ids und Zielordner, die gerade umziehen (U79) — kein zweiter Umzug gleichzeitig

  // typ "neu": URS/Arbeitskopie geändert · "chat": Block-Fragen/Vorschläge geändert · "beispiel": Beispiel nr anzeigen
  // "bild": Seite soll das Fließbild als Bild schicken (anfrage, nr = mindestens diese Version)
  type Meldung = { typ: "neu" | "chat" | "beispiel" | "bild"; nr?: number; anfrage?: string };
  const melde = (id: string, m: Meldung["typ"] | Meldung = "neu") => {
    const n = typeof m === "string" ? { typ: m } : m;
    const t = JSON.stringify(n);
    for (const ws of zuschauer.get(id) ?? []) ws.send(t);
    // Freigabe oder neue Version → Terminal wechselt zwischen Planen und Bauen.
    if (n.typ === "neu") { const pfad = pfadVon(id); if (pfad) phaseAbgleichen(id, pfad); }
  };

  // Fließbild-Bild (U38): Claude fragt per GET an, die offene Seite zeichnet das Bild und schickt es zurück.
  // Gleichzeitige Anfragen für dasselbe Projekt und dieselbe Version teilen sich eine Bild-Runde.
  type Bild = { version: number; pngs: string[]; befunde: string[] };
  const bildWartet = new Map<string, { id: string; version: number; fertig: (b: Bild) => void }>();
  const bildLaeuft = new Map<string, Promise<Bild | null>>(); // "id#version" → laufende Runde

  const json = (res: ServerResponse, code: number, daten: unknown) => {
    res.writeHead(code, { ...SCHUTZ, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(daten));
  };

  class ZuGross extends Error {}
  const koerper = (req: IncomingMessage, grenze = 5_000_000) => new Promise<unknown>((ok, nein) => {
    let s = "";
    req.on("data", (c) => { s += c; if (s.length > grenze) { nein(new ZuGross()); req.destroy(); } });
    req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { nein(new UrsFehler(`Kein gültiges JSON: ${e}`)); } });
    req.on("error", nein);
  });

  // Schutz gegen fremde Webseiten, die an localhost schicken (DNS-Rebinding, Cross-Site-Anfragen).
  // Ändernde Anfragen brauchen den Absender der eigenen Seite — ein einfaches curl ohne Origin reicht nicht.
  const herkunftOk = (req: IncomingMessage, mussOrigin: boolean) => {
    if (!erlaubt.has(req.headers.host ?? "")) return false;
    const o = req.headers.origin;
    if (!o) return !mussOrigin;
    return o.startsWith("http://") && erlaubt.has(o.slice(7));
  };

  const schluesselOk = (req: IncomingMessage) => {
    if (!opt.schluessel) return true;
    const kopf = req.headers["x-urs-schluessel"];
    const keks = /(?:^|;\s*)urs_schluessel=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    const gegeben = typeof kopf === "string" ? kopf : keks ?? "";
    const a = Buffer.from(gegeben), b = Buffer.from(opt.schluessel);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const teile = url.pathname.split("/").filter(Boolean);
      // Ohne Origin erlaubt: nur Lesen, der Hinweis „neue Version“ (ping) und das Beenden eines alten Servers.
      const ohneOrigin = req.method === "GET" || url.pathname === "/api/beenden" || teile[3] === "ping";
      if (!herkunftOk(req, !ohneOrigin)) return json(res, 403, { fehler: "Nicht erlaubt" });

      if (teile[0] === "api") {
        // Ohne Schlüssel nur der harmlose Gesundheits-Check und der Hinweis „neue Version“ (vom MCP-Prozess, der keinen Schlüssel hat).
        // Ebenso das Fließbild-Bild (nur lesen): es zeigt nur das Diagramm, das ohnehin als Datei im Projekt liegt.
        const ohneSchluessel = teile[1] === "gesund" || (teile[3] === "ping" && req.method === "POST") ||
          (teile[3] === "bild" && req.method === "GET");
        if (!ohneSchluessel && !schluesselOk(req)) return json(res, 403, { fehler: "Nicht erlaubt" });
        if (req.method !== "GET" && !(req.headers["content-type"] ?? "").startsWith("application/json")) {
          return json(res, 415, { fehler: "Nur JSON" });
        }
        if (teile[1] === "gesund") {
          return json(res, 200, { ok: true, app: "urs-app", build, terminals: anzahlTerminals(), art: opt.macApp ? "mac-app" : "server" });
        }
        if (teile[1] === "beenden" && req.method === "POST") {
          if (opt.macApp) return json(res, 403, { fehler: "Die Mac-App lässt sich nur über ihr Menü beenden" });
          json(res, 200, { ok: true });
          setTimeout(() => { beendeTerminals(); process.exit(0); }, 50);
          return;
        }
        if (teile[1] === "projekte") return json(res, 200, alleProjekte());
        if (teile[1] === "ordner" && req.method === "GET") return json(res, 200, alleOrdner());
        if (teile[1] === "einrichtung" && req.method === "GET") return json(res, 200, await pruefeEinrichtungGepuffert());
        if (teile[1] === "uebersicht" && req.method === "GET") {
          // Für linke Leiste und Kacheln: je Projekt Stand, offene Fragen, die ersten Blöcke, läuft Claude?
          return json(res, 200, alleOrdner().map((o) => {
            let fragen = 0, bloecke: string[] = [], anzahl = 0;
            try {
              if (o.version) {
                const a = ladeArbeit(o.pfad);
                fragen = offen(o.pfad).fragen;
                anzahl = a.knoten.length;
                bloecke = a.knoten.slice(0, 6).map((k) => k.text);
              }
            } catch { /* kaputte URS-Dateien: Kachel trotzdem zeigen */ }
            return { ...o, fragen, anzahl, bloecke, laeuft: terminalLaeuft(o.id) };
          }));
        }
        if (teile[1] === "entfernen" && req.method === "POST") {
          // Aus der Übersicht nehmen (U26) — löscht nichts, beendet nur das Terminal dieses Projekts.
          const b = z.object({ id: z.string().min(1).max(200) }).parse(await koerper(req));
          if (!abmelden(b.id)) return json(res, 404, { fehler: "Projekt unbekannt" });
          beendeTerminal(b.id);
          for (const ws of zuschauer.get(b.id) ?? []) ws.close(); // Live-Verbindungen zum entfernten Projekt
          zuschauer.delete(b.id);
          return json(res, 200, { ok: true });
        }
        if (teile[1] === "oeffnen" && req.method === "POST") {
          // Werkbank: Ordner eintragen, damit dort Claude laufen und die URS liegen darf.
          const b = z.object({ pfad: z.string().min(1).max(1000) }).parse(await koerper(req));
          return json(res, 200, { id: anmelden(gewaehlterPfad(b.pfad)) });
        }
        if (teile[1] === "neuer-entwurf" && req.method === "POST") {
          // Neuer Chat ohne Ordner (U77): plant sofort in einem Ablageordner der App.
          return json(res, 200, { id: neuerEntwurf() });
        }
        if (teile[1] !== "p" || !teile[2]) return json(res, 404, { fehler: "Unbekannt" });

        const id = teile[2];
        const pfad = pfadVon(id);
        if (!pfad) return json(res, 404, { fehler: "Projekt unbekannt" });
        const was = teile[3];

        if (req.method === "GET" && !was) {
          const p = ladeProjekt(pfad);
          if (!p) return json(res, 404, { fehler: "Noch keine URS" });
          return json(res, 200, {
            id, projekt: p, versionen: versionen(pfad),
            aktuell: ladeVersion(pfad, p.aktuelleVersion), arbeit: ladeArbeit(pfad), offen: offen(pfad),
          });
        }
        if (req.method === "GET" && was === "v" && teile[4]) return json(res, 200, ladeVersion(pfad, Number(teile[4])));
        if (req.method === "PUT" && was === "arbeit") { speichereArbeit(pfad, await koerper(req)); melde(id); return json(res, 200, { ok: true }); }
        if (req.method === "POST" && was === "verwerfen") { verwerfen(pfad); melde(id); return json(res, 200, { ok: true }); }
        if (req.method === "POST" && was === "freigeben") {
          const b = z.object({ version: z.number().int() }).parse(await koerper(req));
          freigeben(pfad, b.version); melde(id);
          // Ohne Ordner wird nicht gebaut (U78): Claude wartet, bis der Nutzer einen Ordner wählt.
          if (ohneOrdner(pfad)) hinweisAnChats(id, "Freigegeben — oben „Ordner wählen“, dann baut Claude dort");
          return json(res, 200, { ok: true });
        }
        if (req.method === "GET" && was === "beispiel" && teile[4]) {
          // Beispiel von Claude: eigenes HTML, nur im Vorschau-Fenster der eigenen Seite, ohne Netz und ohne Zugriff auf die App.
          const html = beispielHtml(pfad, Number(teile[4]));
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "SAMEORIGIN",
            "content-security-policy": "sandbox allow-scripts; frame-ancestors 'self'; default-src 'none'; " +
              "style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:",
          });
          return res.end(html);
        }
        if (req.method === "POST" && was === "chat-schliessen") {
          // Chat schließen (× in der Liste) — direkt beim Server, damit es auch ohne offene Terminal-Verbindung greift.
          const b = z.object({ chat: z.string().regex(GUELTIGER_CHAT) }).parse(await koerper(req));
          chatSchliessen(id, b.chat);
          // Plan ohne Ordner und noch ohne Ablauf: nichts zu behalten — keine leere Kachel zurücklassen.
          if (!hatChats(id) && leerenEntwurfEntfernen(id)) zuschauer.delete(id);
          return json(res, 200, { ok: true });
        }
        if (req.method === "POST" && was === "umziehen") {
          // Plan ohne Ordner → gewählter Ordner (U79). Erst die Chats beenden (Gespräch gespeichert), dann .urs/ verschieben.
          const b = z.object({ pfad: z.string().min(1).max(1000) }).parse(await koerper(req));
          const ziel = umzugsZiel(pfad, gewaehlterPfad(b.pfad)); // erst prüfen, dann die Chats anhalten
          // Je Plan und je Zielordner nur ein Umzug zur selben Zeit.
          if (umzugLaeuft.has(id) || umzugLaeuft.has(ziel)) throw new UrsFehler("Der Plan zieht gerade schon um");
          umzugLaeuft.add(id); umzugLaeuft.add(ziel);
          try {
            const chats = await umziehenTerminal(id, pfad, projektId(ziel), ziel);
            let neu: string;
            // umziehen dreht nach dem Verschieben nichts mehr zurück — ein Fehler hier heißt: der Plan liegt noch im Entwurf.
            try { neu = umziehen(pfad, ziel); } catch (e) { umzugAbgebrochen(id, chats); throw e; }
            umzugFertig(id, neu, chats);
            for (const ws of zuschauer.get(id) ?? []) ws.close();
            zuschauer.delete(id);
            melde(neu); // Fenster und Chats, die den Zielordner schon offen haben, sehen den Plan
            return json(res, 200, { id: neu });
          } finally { umzugLaeuft.delete(id); umzugLaeuft.delete(ziel); }
        }
        if (req.method === "GET" && was === "bild") {
          // Nur der MCP-Prozess (Node, ohne Schlüssel) — Abrufe aus Webseiten (<img> o. ä.) tragen Sec-Fetch-Site.
          const site = req.headers["sec-fetch-site"];
          if (site && site !== "none" && site !== "same-origin") return json(res, 403, { fehler: "Nicht erlaubt" });
          // Ohne Angabe: die aktuelle Version. Mehr als die aktuelle gibt es nicht.
          const aktuell = ladeProjekt(pfad)?.aktuelleVersion ?? 0;
          const gewuenscht = Number(url.searchParams.get("version") ?? 0) || aktuell;
          if (gewuenscht > aktuell) throw new UrsFehler(`Version ${gewuenscht} gibt es nicht`);
          const schluessel = `${id}#${gewuenscht}`;
          let runde = bildLaeuft.get(schluessel);
          if (!runde) {
            runde = (async () => {
              // Ein Fenster, das sich gerade erst öffnet oder neu verbindet, bekommt bis zu 6 s Zeit.
              for (let i = 0; i < 24 && !zuschauer.get(id)?.size; i++) await new Promise((r) => setTimeout(r, 250));
              if (!zuschauer.get(id)?.size) throw new UrsFehler("Das Fließbild ist gerade in keinem Fenster offen");
              const anfrage = crypto.randomUUID();
              return new Promise<Bild | null>((fertig) => {
                const t = setTimeout(() => { bildWartet.delete(anfrage); fertig(null); }, 15_000);
                bildWartet.set(anfrage, { id, version: gewuenscht, fertig: (b) => { clearTimeout(t); bildWartet.delete(anfrage); fertig(b); } });
                melde(id, { typ: "bild", anfrage, nr: gewuenscht });
              });
            })().finally(() => bildLaeuft.delete(schluessel));
            bildLaeuft.set(schluessel, runde);
          }
          const bild = await runde;
          if (!bild) throw new UrsFehler("Das Fenster hat kein Bild geliefert (Zeitüberschreitung)");
          return json(res, 200, bild);
        }
        if (req.method === "POST" && was === "bild-antwort") {
          // Erst prüfen, ob überhaupt jemand wartet — sonst gar nicht erst Megabytes einlesen.
          const w = bildWartet.get(url.searchParams.get("anfrage") ?? "");
          if (!w || w.id !== id) { req.resume(); return json(res, 200, { ok: true, verworfen: true }); }
          const b = z.object({
            anfrage: z.string().uuid(), version: z.number().int().positive(),
            pngs: z.array(z.string().regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/)).min(1).max(12),
            befunde: z.array(z.string().max(500)).max(200),
          }).parse(await koerper(req, 25_000_000));
          // Erst eine Seite, die mindestens die angefragte Version zeigt — eine noch alte Seite antwortet zu früh.
          if (b.anfrage === url.searchParams.get("anfrage") && b.version >= w.version) {
            w.fertig({ version: b.version, pngs: b.pngs.map((p) => p.slice(p.indexOf(",") + 1)), befunde: b.befunde });
          }
          return json(res, 200, { ok: true });
        }
        if (req.method === "POST" && was === "bild-ablegen") {
          // Screenshot aus Terminal oder Block-Feld (U39) → Datei, Claude bekommt den Pfad.
          const b = z.object({ daten: z.string().min(1) }).parse(await koerper(req, Math.ceil(MAX_BILD * 1.4) + 1000));
          return json(res, 200, { pfad: legeBildAb(b.daten) });
        }
        if (req.method === "POST" && was === "frage") {
          // Frage am Block → als Eingabe ins Claude-Terminal links; besprochen wird dort.
          const b = z.object({
            knoten: z.string().min(1), text: z.string(), chat: z.string().regex(GUELTIGER_CHAT).optional(),
            bilder: z.array(z.string().max(1000)).max(10).optional(),
          }).parse(await koerper(req));
          const { frage, terminalText } = blockFrage(pfad, b.knoten, b.text, b.bilder);
          const r = schreibeInTerminal(id, terminalText, b.chat); // in den Chat, der gerade zu sehen ist
          // Im Plugin gibt es kein eingebautes Terminal — gefragt wird direkt in Claude Code.
          if (r === "aus" && process.env.URS_APP_PLUGIN) throw new UrsFehler("Block questions need the Virtuv app. In the plugin, ask Claude in your terminal.");
          if (r === "aus") throw new UrsFehler("Claude läuft links gerade nicht — erst „Neu starten“ drücken");
          if (r === "wartet") throw new UrsFehler("Claude wartet links auf deine Antwort — erst dort antworten, dann nochmal senden");
          const anhang = b.bilder?.length ? `\n📎 ${b.bilder.length} Screenshot${b.bilder.length > 1 ? "s" : ""}` : "";
          merkeFrage(pfad, b.knoten, frage + anhang); // erst speichern, wenn die Frage im Terminal angekommen ist
          melde(id, "chat"); return json(res, 200, { ok: true });
        }
        if (was === "chat") {
          if (req.method === "GET") return json(res, 200, { chats: ladeChats(pfad), beispiele: ladeBeispiele(pfad) });
          if (req.method === "POST" && teile[4] === "erledigt") {
            const b = z.object({ knoten: z.string().min(1) }).parse(await koerper(req));
            gespraechBeenden(pfad, b.knoten); melde(id, "chat"); return json(res, 200, { ok: true });
          }
          if (req.method === "POST" && teile[4] === "vorschlag") {
            const b = z.object({ knoten: z.string().min(1), nachricht: z.string().min(1), status: z.enum(["ok", "nein"]) }).parse(await koerper(req));
            vorschlagEntscheiden(pfad, b.knoten, b.nachricht, b.status); melde(id, "chat"); return json(res, 200, { ok: true });
          }
        }
        if (req.method === "POST" && was === "ping") {
          // Vom MCP-Prozess: neue Version, neuer Vorschlag oder ein Beispiel zum Anzeigen.
          const b = z.object({ typ: z.enum(["neu", "chat", "beispiel"]).default("neu"), nr: z.number().int().positive().optional() })
            .catch({ typ: "neu" }).parse(await koerper(req).catch(() => ({})));
          melde(id, b); return json(res, 200, { zuschauer: zuschauer.get(id)?.size ?? 0 });
        }
        return json(res, 404, { fehler: "Unbekannt" });
      }

      // Oberfläche (Einzelseiten-App): unbekannte Pfade → index.html
      let datei = normalize(join(WEB, url.pathname));
      if (!datei.startsWith(WEB + sep) || !existsSync(datei) || statSync(datei).isDirectory()) datei = join(WEB, "index.html");
      if (!existsSync(datei)) { res.writeHead(500); return res.end("Oberfläche fehlt: npm run build"); }
      res.writeHead(200, { ...SCHUTZ, "content-type": TYPEN[extname(datei)] ?? "application/octet-stream" });
      res.end(readFileSync(datei));
    } catch (e) {
      if (e instanceof ZuGross) return json(res, 413, { fehler: "Zu groß" });
      if (e instanceof UrsFehler) return json(res, 409, { fehler: e.message });
      if (e instanceof ZodError) return json(res, 400, { fehler: e.issues.map((i) => i.message).join("; ") });
      console.error(e);
      json(res, 500, { fehler: "Interner Fehler" });
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const wssTerm = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });
  server.on("upgrade", (req, sock, kopf) => {
    const url = new URL(req.url ?? "/", "http://x");
    const id = url.searchParams.get("p");
    const pfad = id ? pfadVon(id) : null;
    // Terminal: führt Befehle auf dem Mac aus — nur von der eigenen Seite (Origin + Host geprüft).
    if (!schluesselOk(req)) return sock.destroy();
    if (url.pathname === "/term" && id && pfad && herkunftOk(req, true)) {
      const chat = url.searchParams.get("c") ?? "1"; // mehrere Chats je Projekt (U27)
      if (!GUELTIGER_CHAT.test(chat)) return sock.destroy();
      const nurBestehend = url.searchParams.get("hg") === "1"; // Hintergrund-Chat: nie selbst starten
      return wssTerm.handleUpgrade(req, sock, kopf, (ws) => verbindeTerminal(ws, id, pfad, chat, nurBestehend));
    }
    if (url.pathname !== "/ws" || !id || !pfad || !herkunftOk(req, true)) return sock.destroy();
    wss.handleUpgrade(req, sock, kopf, (ws) => {
      ws.on("error", () => ws.terminate());
      if (!zuschauer.has(id)) zuschauer.set(id, new Set());
      zuschauer.get(id)!.add(ws);
      ws.on("close", () => zuschauer.get(id)?.delete(ws));
    });
  });

  return new Promise<typeof server>((ok, nein) => {
    server.once("error", nein);
    server.listen(port, "127.0.0.1", () => ok(server));
  });
}

// Direkt gestartet (nicht in der Mac-App gebündelt, dort teilen alle Module dieselbe import.meta.url).
if (!(globalThis as { ursAppGebuendelt?: boolean }).ursAppGebuendelt && process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.on("exit", beendeTerminals);
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(0));
  starteServer().then(
    () => console.log(`URS-App läuft: http://127.0.0.1:${PORT} · Werkbank: http://127.0.0.1:${PORT}/w`),
    (e) => { console.error(e.code === "EADDRINUSE" ? `Port ${PORT} ist schon belegt.` : e); process.exit(1); },
  );
}
