// Terminal der Werkbank: je Projekt ein echtes `claude` in einem Pseudo-Terminal, im Browser per WebSocket.
// Die Sitzung überlebt ein Neuladen der Seite; die letzte Ausgabe wird beim Verbinden nachgeliefert.
// Ohne Zuschauer wird eine Sitzung nach LEERLAUF_MS beendet, damit sich keine Claude-Prozesse ansammeln.
import { copyFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pty, { type IPty } from "node-pty";
import type { WebSocket } from "ws";
import { claudeBefehl, claudeUmgebung } from "./claude.ts";
import { randomUUID } from "node:crypto";
import { freigabeBestaetigt, ohneOrdner } from "./store.ts";
import { MAX_WOERTER_ANFORDERUNG } from "./schema.ts";

/** Planen bis zur Freigabe, danach Bauen — im selben Terminal (U16–U18). */
export type Phase = "planen" | "bauen";
/**
 * Bauen genau dann, wenn die aktuelle Version freigegeben ist — und zwar nachweislich in dieser App
 * (Prüfsumme in ~/.urs-app), nicht nur laut projekt.json. Jede neue Version (Entwurf) heißt wieder Planen.
 * Ohne gewählten Ordner wird nie gebaut (U78).
 */
export function gewuenschtePhase(pfad: string): Phase {
  return !ohneOrdner(pfad) && freigabeBestaetigt(pfad) ? "bauen" : "planen";
}

const MAX_PUFFER = 200_000;
// MCP-Server (URS-Werkzeuge): im Browser-Betrieb `node src/mcp.ts`; in der Mac-App startet sich die App selbst
// mit eigenem Schalter (URS_APP_MCP_ARGS, z. B. ["--urs-mcp"]) — ohne den Electron-Node-Modus, der gesperrt ist.
const mcpArgumente = (): string[] =>
  process.env.URS_APP_MCP_ARGS ? JSON.parse(process.env.URS_APP_MCP_ARGS) : [join(dirname(fileURLToPath(import.meta.url)), "mcp.ts")];
/**
 * Was der MCP-Prozess sicher braucht — ausdrücklich gesetzt, nicht darauf verlassen, dass claude es weiterreicht.
 * Den App-Schlüssel gar nicht — weder in der Startzeile noch in der Umgebung (Gesundheits-Check und „neue Version“ brauchen ihn nicht).
 */
const mcpUmgebung = (): Record<string, string> => Object.fromEntries(
  ["URS_APP_PORT", "URS_APP_BUILD", "URS_APP_HOME"].flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : []))
    .concat([["URS_APP_IN_WERKBANK", "1"], ["URS_APP_KEIN_BROWSER", "1"]]),
);

// Claude arbeitet in der Werkbank wie normales Claude Code (eigene Einstellungen, alle Werkzeuge) — mit einer Regel:
// jedes Vorhaben zuerst als Ablauf planen, gebaut wird erst nach der Freigabe (U16, U25).
// Kurz antworten (U119): nur das Wichtige, für App und Plugin gleich.
const KURZ = "Answer as briefly as possible. Nur das Wichtigste: Ergebnis, offene Frage, nächster Schritt des Nutzers — alles andere weglassen. Pflichtmeldungen (Review, Test, Commit) bleiben.";

const WERKBANK_ANWEISUNG = [
  "Du läufst in der URS-Werkbank: links dieses Terminal, rechts sieht der Nutzer den Ablauf (die URS) als Flussdiagramm.",
  "Du arbeitest wie gewohnt — recherchieren, Webseiten öffnen, Fragen beantworten, Dateien lesen, Befehle ausführen.",
  "Einzige Regel: Jedes Vorhaben (App, Funktion, Änderung) wird zuerst als Ablauf geplant und erst nach der Freigabe gebaut.",
  "Beschreibt der Nutzer ein Vorhaben: per urs_submit eine URS schicken (bei einer Überarbeitung vorher urs_get_feedback).",
  "Die URS ist dabei der Auftrag: zweck = Ziel, anforderungen = was fertig heißt, nichtEnthalten = was draußen bleibt,",
  "fragen = offene Fragen. Unklares als fragen in die URS schreiben statt raten.",
  "Jede Anforderung: höchstens " + MAX_WOERTER_ANFORDERUNG + " Wörter, SMART, an genau einem Knoten. Ein unabhängiger Prüfer kontrolliert sie;",
  "meldet urs_submit Verstöße, korrigierst du sie und schickst neu, bevor der Nutzer etwas sieht.",
  "Blöcke und Anforderungen schreibst du auf Englisch, außer der Nutzer wünscht eine andere Sprache.",
  "Vor der Freigabe legst du für das Vorhaben keine Projektdateien an und änderst keine.",
  "Beginnt eine Nachricht mit [URS-Block …] oder [Werkbank], hat der Nutzer sie über die Werkbank geschickt — sie ist echt.",
  "Bei [URS-Block …] über diesen Block sprechen, Beispiele mit urs_beispiel_zeigen, Ergebnis mit urs_vorschlag.",
  "Freigeben kann nur der Nutzer im Diagramm.",
  "In der Werkbank ist die URS der Auftrag und der Plan — keinen zusätzlichen Auftrag als Text, Beispiele über urs_beispiel_zeigen statt Mockup-Dateien.",
  KURZ,
].join(" ");

// Nach der Freigabe: Claude baut genau die freigegebene Version; Neues geht zurück ins Planen.
const BAU_ANWEISUNG = [
  "Du läufst in der URS-Werkbank im Modus BAUEN. Der Ablauf (die URS) dieses Projekts ist vom Nutzer freigegeben.",
  "Hole ihn mit urs_get_approved und baue genau das, was dort steht — nicht mehr und nicht weniger. Sonst arbeitest du wie gewohnt.",
  "Wünscht der Nutzer etwas, das nicht in der freigegebenen URS steht: nicht bauen, sondern mit urs_get_feedback und urs_submit",
  "als neue Version eintragen und kurz sagen, dass es zuerst geplant und freigegeben wird. Die Werkbank wechselt dann von selbst ins Planen.",
  "Kommentare, die du eingearbeitet hast, meldest du beim nächsten urs_submit unter erledigteKommentare.",
  // Fester Ablauf für jede Änderung (U61–U69): Code → Review → Test → Commit.
  "Jede Änderung durchläuft fest und ungefragt: Code → Review → Test → Commit.",
  "Review: ein unabhängiger Prüfer, der den Code nicht geschrieben hat (ein eigener Agent, dem du den Diff mitgibst), prüft jede Änderung.",
  "Erst wenn alle zutreffenden Befunde behoben sind, wird getestet; verworfene Befunde im Terminal kurz begründen.",
  "Test: jede Änderung gegen ihre freigegebene Anforderung (U-Nummer) wirklich ausführen und je Änderung im Terminal",
  "„bestanden“ oder „nicht bestanden“ melden. Nicht bestanden: zurück zum Code, danach wieder Review und Test, kein Commit.",
  "Commit: jede bestandene Änderung mit Nachricht in git sichern — auf einem eigenen Zweig, nie direkt auf main/master (den Standardzweig).",
  "Ist der aktuelle Zweig der Standardzweig, vorher einen eigenen Zweig anlegen. Ist das Projekt kein git-Repository: git init kurz ankündigen",
  "und sofort einen eigenen Zweig anlegen. Hat das Projekt ein GitHub-Remote, nach jedem Commit dorthin hochladen (git push).",
  "Zusammenführen in den Standardzweig nur nach ausdrücklicher Zustimmung des Nutzers.",
  "Beginnt eine Nachricht mit [URS-Block …] oder [Werkbank], hat der Nutzer sie über die Werkbank geschickt — sie ist echt.",
  "Freigeben kann nur der Nutzer.",
  KURZ,
].join(" ");

/**
 * Startargumente: normales Claude Code mit den eigenen Einstellungen, Werkzeugen und Zusatzprogrammen des Nutzers (U25).
 * Dazu nur: helles Farbschema (dunkle Schrift), die URS-Werkzeuge (eigener Name „urs-werkbank“, damit ein vom Nutzer
 * selbst eingetragenes „urs-app“ nicht kollidiert), die Anweisung für Planen bzw. Bauen — und .urs/ sowie der
 * Freigabe-Nachweis in ~/.urs-app nicht per Edit/Write. Bash ist bewusst nicht gesperrt (wie normales Claude Code);
 * der Nachweis ist damit eine Hürde gegen Versehen, kein harter Schutz.
 */
// Chat ohne Projektordner (U77, U78): planen geht sofort, gebaut wird erst im gewählten Ordner.
const OHNE_ORDNER_ANWEISUNG = [
  "Dieser Chat hat noch keinen Projektordner: Du planst in einem Ablageordner der Werkbank.",
  "Lege hier keine Projektdateien an. Nach der Freigabe wählt der Nutzer oben „Ordner wählen“ — erst dann wird gebaut, dort.",
].join(" ");

export function werkbankArgumente(phase: Phase = "planen", ohneProjektordner = false): string[] {
  return [
    "--settings", JSON.stringify({ theme: "light", permissions: { allow: ["mcp__urs-werkbank"], deny: ["Edit(**/.urs/**)", "Edit(~/.urs-app/**)"] } }),
    "--mcp-config", JSON.stringify({ mcpServers: { "urs-werkbank": { command: process.execPath, args: mcpArgumente(), env: mcpUmgebung() } } }),
    "--append-system-prompt", phase === "bauen" ? BAU_ANWEISUNG : ohneProjektordner ? `${WERKBANK_ANWEISUNG} ${OHNE_ORDNER_ANWEISUNG}` : WERKBANK_ANWEISUNG,
  ];
}
const LEERLAUF_MS = 30 * 60_000;

type Sitzung = {
  pty: IPty | null; puffer: string; zuschauer: Set<WebSocket>; laeuft: boolean; leerlauf?: NodeJS.Timeout;
  phase: Phase; letzteAusgabe: number; wechsel?: NodeJS.Timeout; eingabeOffen: boolean; letzteEingabe: number; letzteAktiv: number;
  titel: string;
};
// Kennung des Werkbank-Gesprächs je Projekt: beim Phasenwechsel genau dieses fortsetzen (--resume),
// nicht „das letzte in diesem Ordner“ (--continue) — das könnte eine fremde Claude-Sitzung sein.
const gespraeche = new Map<string, string>();
// Nach dem Umzug in den gewählten Ordner (U79): beim nächsten Start dieses Chats das Gespräch fortsetzen.
const fortsetzen = new Set<string>();
// Projekte, die gerade umziehen oder umgezogen sind: dort startet kein Claude mehr (ein Fenster könnte neu verbinden).
const umgezogeneProjekte = new Set<string>();
// Fertig umgezogen: alte Plan-id → neue Projekt-id. Ein Fenster, das noch die alte kennt, erfährt so die neue.
const umzugNach = new Map<string, string>();
// Umzug abgebrochen: diese Chats setzen ihr Gespräch beim nächsten Start im alten Plan fort (ohne Umzugs-Hinweis).
const weiterNachAbbruch = new Set<string>();
// Nach dem Umzug eines freigegebenen Plans baut nur ein Chat (der zuletzt benutzte) — nie zwei im selben Ordner.
const bauNachUmzug = new Set<string>();
// Mehrere Chats je Projekt (wie Tabs in Warp, U27): jede Sitzung heißt „<projektId>#<chat>“.
export const GUELTIGER_CHAT = /^[a-z0-9-]{1,40}$/;
const chatSchluessel = (projektId: string, chat: string) => `${projektId}#${chat}`;
const schluesselVon = (projektId: string) => [...sitzungen.keys()].filter((k) => k.startsWith(`${projektId}#`));
const sitzungen = new Map<string, Sitzung>();
// Zuletzt gemeldete Fenstergröße je Projekt — ein Neustart (Phasenwechsel) startet gleich in der richtigen Größe.
const groessen = new Map<string, { cols: number; rows: number }>();

const sende = (s: Sitzung, nachricht: object) => {
  const t = JSON.stringify(nachricht);
  for (const ws of s.zuschauer) if (ws.readyState === ws.OPEN) ws.send(t);
};

/** Eingaben unverändert durchreichen — wie in jedem Terminal. Nur Ctrl+Z nicht: ohne Shell darüber hielte es Claude an. */
export const entschaerfen = (d: string) => d.replace(/\x1a/g, "");

/** Puffer kürzen — an einer Zeilengrenze, damit keine halbe Steuerzeichen-Folge vorne stehen bleibt. */
function kuerze(puffer: string) {
  if (puffer.length <= MAX_PUFFER) return puffer;
  const rest = puffer.slice(-MAX_PUFFER);
  const nl = rest.indexOf("\n");
  return nl >= 0 ? rest.slice(nl + 1) : rest;
}

/** Fenstertitel, den Claude Code setzt (OSC 0/2) — wird wie in Warp zum Namen des Chats. Ohne Spinner-Zeichen davor. */
function titelAus(d: string): string | null {
  let t: string | null = null;
  for (const m of d.matchAll(/\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g)) t = m[1];
  if (t === null) return null;
  return t.replace(/^[^\p{L}\p{N}]+/u, "").trim().slice(0, 80);
}

function ausgabe(s: Sitzung, d: string) {
  s.letzteAusgabe = Date.now();
  const t = titelAus(d);
  if (t && t !== s.titel && !/^claude( code)?$/i.test(t)) { s.titel = t; sende(s, { typ: "titel", titel: t }); }
  s.puffer = kuerze(s.puffer + d);
  sende(s, { typ: "aus", d });
}

/** Ohne Zuschauer: nach LEERLAUF_MS ohne Ausgabe beenden. Jede Ausgabe startet die Frist neu — arbeitet Claude noch, bleibt es. */
function leerlaufStarten(id: string, s: Sitzung) {
  clearTimeout(s.leerlauf);
  if (!s.zuschauer.size) s.leerlauf = setTimeout(() => { if (!s.zuschauer.size && sitzungen.get(id) === s) beende(id); }, LEERLAUF_MS);
}

/** node-pty wirft, wenn der Prozess gerade endet (vor onExit) — darf den Server nicht beenden. */
function sicher(f: () => void) { try { f(); } catch { /* Prozess schon weg */ } }

/**
 * weiter: Gespräch fortsetzen (Phasenwechsel) — das Gespräch bleibt erhalten.
 * rueckfall: Fortsetzen ist gescheitert, dies ist der frische Ersatzstart.
 */
function starte(id: string, pfad: string, zuschauer = new Set<WebSocket>(), weiter = false, rueckfall = false): Sitzung {
  const phase = gewuenschtePhase(pfad);
  const umgezogen = fortsetzen.delete(id) && !rueckfall;
  weiter ||= umgezogen || (weiterNachAbbruch.delete(id) && !rueckfall);
  // Nach einem Umzug baut nur der eine dafür bestimmte Chat — auch wenn sein Fortsetzen scheitert und er frisch startet.
  const darfBauen = !umgezogen || bauNachUmzug.has(id);
  const s: Sitzung = { pty: null, puffer: "", zuschauer, laeuft: false, phase, letzteAusgabe: Date.now(), eingabeOffen: false, letzteEingabe: 0, letzteAktiv: 0, titel: "" };
  const bisher = gespraeche.get(id);
  const gespraech = weiter && bisher ? ["--resume", bisher] : (() => { const g = randomUUID(); gespraeche.set(id, g); return ["--session-id", g]; })();
  sitzungen.set(id, s);
  if (!existsSync(pfad)) { ausgabe(s, `\x1b[1m[Ordner gibt es nicht mehr: ${pfad}]\x1b[0m\r\n`); return s; }
  try {
    // Planen oder Bauen (siehe werkbankArgumente); helles Farbschema, weil weiße Schrift für den Nutzer nicht lesbar ist.
    s.pty = pty.spawn(claudeBefehl(), [...werkbankArgumente(phase, ohneOrdner(pfad)), ...gespraech], {
      name: "xterm-256color", cols: groessen.get(id)?.cols ?? 100, rows: groessen.get(id)?.rows ?? 30, cwd: pfad,
      // URS_APP_KEIN_BROWSER: urs_submit öffnet keinen zusätzlichen Tab — die Werkbank zeigt die URS selbst.
      // URS_APP_IN_WERKBANK: urs_submit ersetzt den Webserver nie (sonst beendet Claude sein eigenes Terminal).
      env: claudeUmgebung({
        URS_APP_KEIN_BROWSER: "1", URS_APP_IN_WERKBANK: "1", TERM: "xterm-256color", COLORTERM: "truecolor",
        // Damit die URS-Werkzeuge den richtigen Server erreichen (die Mac-App kann einen anderen Port nehmen).
        ...mcpUmgebung(),
        // Den App-Schlüssel bekommt Claude bewusst NICHT — sonst könnte es beim Bauen per curl selbst „freigeben“.
      }),
    });
  } catch (e) {
    ausgabe(s, `\x1b[1m[Claude startet nicht: ${(e as Error).message}]\x1b[0m\r\n`);
    return s;
  }
  s.laeuft = true;
  if (rueckfall) ausgabe(s, "\x1b[1m[Das bisherige Gespräch ließ sich nicht fortsetzen — Claude startet neu]\x1b[0m\r\n");
  // Frisch gestartet und schon freigegeben (z. B. App neu geöffnet): Hinweis statt selbst loszulegen.
  else if (phase === "bauen" && !weiter) ausgabe(s, "\x1b[1m[Freigegeben — schreib z. B. „bau jetzt“, dann setzt Claude den freigegebenen Ablauf um]\x1b[0m\r\n");
  // Umgezogen in den gewählten Ordner (U79): ist der Plan schon freigegeben, geht es gleich ans Bauen (U78).
  if (umgezogen) {
    ausgabe(s, `\x1b[1m[Plan liegt jetzt in ${pfad} — das Gespräch geht weiter]\x1b[0m\r\n`);
    if (phase === "bauen" && bauNachUmzug.delete(id)) baueAuftrag(id, s);
  }
  const p = s.pty;
  p.onData((d) => { ausgabe(s, d); if (!s.zuschauer.size) leerlaufStarten(id, s); });
  const gestartet = Date.now();
  p.onExit(({ exitCode }) => {
    if (sitzungen.get(id) !== s) return; // durch Neustart ersetzt
    // Fortsetzen gescheitert (z. B. „No conversation found“ — die Meldung kommt oft erst nach dem Ende an):
    // endet ein fortgesetztes Claude gleich wieder mit Fehler, frisch im neuen Modus starten.
    if (weiter && exitCode !== 0 && Date.now() - gestartet < 15_000) {
      const neu = starte(id, pfad, s.zuschauer, false, true);
      sende(neu, { typ: "status", laeuft: neu.laeuft });
      sende(neu, { typ: "phase", phase: neu.phase });
      if (neu.phase === "bauen" && darfBauen) baueAuftrag(id, neu);
      return;
    }
    s.laeuft = false;
    ausgabe(s, "\r\n\x1b[1m[Claude beendet — Knopf „Neu starten“]\x1b[0m\r\n");
    sende(s, { typ: "status", laeuft: false });
  });
  return s;
}

function beende(id: string) {
  const s = sitzungen.get(id);
  if (!s) return;
  sitzungen.delete(id);
  clearTimeout(s.leerlauf);
  clearTimeout(s.wechsel);
  if (s.laeuft) sicher(() => s.pty?.kill());
}

/** Hängt einen Browser an einen Chat des Projekts; startet Claude, falls es für diesen Chat noch keine Sitzung gibt. */
/** nurBestehend: Hintergrund-Chat — nur an eine laufende Sitzung hängen, nie selbst ein Claude starten. */
export function verbindeTerminal(ws: WebSocket, projektId: string, pfad: string, chat = "1", nurBestehend = false) {
  const id = chatSchluessel(projektId, chat);
  ws.on("error", () => ws.terminate()); // z. B. zu große Nachricht — darf den Server nicht beenden
  if (umgezogeneProjekte.has(projektId) || (nurBestehend && !sitzungen.get(id))) {
    ws.send(JSON.stringify({ typ: "status", laeuft: false }));
    // Plan ist umgezogen (U79): das Fenster soll den Chat beim neuen Projekt öffnen.
    const neu = umzugNach.get(projektId);
    if (neu) ws.send(JSON.stringify({ typ: "umzug", id: neu }));
    ws.close(); return;
  }
  const s = sitzungen.get(id) ?? starte(id, pfad);
  clearTimeout(s.leerlauf);
  s.zuschauer.add(ws);
  ws.send(JSON.stringify({ typ: "aus", d: s.puffer, wiedergabe: true }));
  ws.send(JSON.stringify({ typ: "status", laeuft: s.laeuft }));
  ws.send(JSON.stringify({ typ: "phase", phase: s.phase }));
  if (s.titel) ws.send(JSON.stringify({ typ: "titel", titel: s.titel }));

  ws.on("message", (roh) => {
    let m: { typ?: string; d?: unknown; cols?: unknown; rows?: unknown };
    try { m = JSON.parse(String(roh)); } catch { return; }
    const akt = sitzungen.get(id);
    if (!akt) return;
    if (m.typ === "ein" && typeof m.d === "string" && akt.laeuft) {
      const d = m.d;
      // Halb getippte Eingabe? Dann wartet ein Phasenwechsel, damit sie nicht verloren geht.
      if (/\r$/.test(d) && !d.endsWith("\x1b\r")) akt.eingabeOffen = false;
      else if (d === "\x15" || d === "\x03" || d === "\x1b") akt.eingabeOffen = false;
      else if (/[^\x00-\x1f\x7f]/.test(d.replace(/\x1b(\[[0-?]*[ -\/]*[@-~]|O.)/g, ""))) { akt.eingabeOffen = true; akt.letzteEingabe = Date.now(); }
      akt.letzteAktiv = Date.now();
      sicher(() => akt.pty?.write(entschaerfen(d)));
    }
    else if (m.typ === "groesse" && Number.isInteger(m.cols) && Number.isInteger(m.rows)) {
      const cols = Math.min(500, Math.max(10, m.cols as number)), rows = Math.min(200, Math.max(4, m.rows as number));
      groessen.set(id, { cols, rows });
      if (akt.laeuft) sicher(() => akt.pty?.resize(cols, rows));
    } else if (m.typ === "schliessen") {
      // Chat geschlossen (wie einen Tab in Warp): dieses Claude beenden, alle Fenster dieses Chats trennen.
      const zuschauer = [...akt.zuschauer];
      beende(id);
      for (const w of zuschauer) w.close();
    } else if (m.typ === "neustart") {
      const zuschauer = akt.zuschauer;
      beende(id);
      const neu = starte(id, pfad, zuschauer);
      sende(neu, { typ: "leeren" });
      if (neu.puffer) sende(neu, { typ: "aus", d: neu.puffer });
      sende(neu, { typ: "status", laeuft: neu.laeuft });
      sende(neu, { typ: "phase", phase: neu.phase });
    }
  });
  ws.on("close", () => {
    const akt = sitzungen.get(id);
    if (!akt) return;
    akt.zuschauer.delete(ws);
    leerlaufStarten(id, akt);
  });
}

/**
 * Schickt einen Text an einen Chat des Projekts: den angegebenen, sonst den zuletzt benutzten laufenden.
 */
export function schreibeInTerminal(projektId: string, text: string, chat?: string): "ok" | "aus" | "wartet" {
  // Ist ein Chat angegeben, nur dorthin — nie still in einen anderen, den man gerade nicht sieht.
  if (chat) return schreibeInSitzung(chatSchluessel(projektId, chat), text);
  const laufend = schluesselVon(projektId).filter((k) => sitzungen.get(k)?.laeuft);
  const ziel = laufend.sort((a, b) => (sitzungen.get(b)!.letzteAktiv - sitzungen.get(a)!.letzteAktiv))[0];
  return ziel ? schreibeInSitzung(ziel, text) : "aus";
}

/**
 * Schickt einen Text als Eingabe an das laufende Claude (als Einfügen, damit Zeilenumbrüche nicht vorzeitig absenden)
 * und drückt danach Enter. Ohne laufendes Terminal: Fehler.
 */
function schreibeInSitzung(id: string, text: string): "ok" | "aus" | "wartet" {
  const s = sitzungen.get(id);
  if (!s?.laeuft || !s.pty) return "aus";
  // Zeigt Claude gerade eine Auswahl/Rückfrage, würde unser Enter sie bestätigen — dann nichts schicken.
  if (wartetAufAntwort(s.puffer)) return "wartet";
  // Alle Steuerzeichen raus (auch aus Blocknamen/Anforderungen): sonst könnte der Text das Einfügen beenden
  // und den Rest als Tastendrücke ausführen lassen.
  const sauber = entschaerfen(text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ""));
  const p = s.pty;
  try { p.write(`\x1b[200~${sauber}\x1b[201~`); } catch { return "aus"; }
  // Direkt vor dem Enter nochmal prüfen: ist inzwischen eine Rückfrage aufgegangen, nicht bestätigen.
  setTimeout(() => { if (!wartetAufAntwort(s.puffer)) sicher(() => p.write("\r")); }, 300);
  return "ok";
}

/** Steht am Ende der Ausgabe eine Auswahl-Rückfrage von Claude Code (Erlauben?, Vertrauen?)? */
export function wartetAufAntwort(puffer: string) {
  // Ohne Steuerfolgen und ohne Leerraum vergleichen: Claude Code setzt Wortabstände oft als Cursor-Sprung statt als Leerzeichen
  // („Entertoconfirm“) — sonst bliebe z. B. die Frage „Diesem Ordner vertrauen?“ unerkannt und unser Enter hieße „No, exit“.
  const ende = puffer.slice(-3000).replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\s+/g, "");
  // Die Rückfrage bleibt nach der Antwort im Puffer stehen — sie zählt nur, wenn danach keine normale Eingabezeile kam.
  const letzte = (re: RegExp) => Math.max(-1, ...[...ende.matchAll(re)].map((m) => m.index ?? -1));
  const frage = letzte(/Doyouwanttoproceed|Wouldyouliketoproceed|Entertoconfirm|Esctocancel/gi);
  const eingabe = letzte(/shift\+tabtocycle|forshortcuts|esctointerrupt/gi);
  return frage >= 0 && frage > eingabe && ende.length - frage < 1000;
}

/**
 * Passt die Sitzung an den Stand der URS an: freigegeben → Bauen, neue Version → Planen.
 * Gewechselt wird erst in Ruhe (keine Ausgabe, keine Rückfrage, keine halb getippte Eingabe);
 * Claude startet dann mit --resume neu — das Gespräch bleibt. Nach einer Freigabe bekommt Claude den Auftrag zu bauen.
 */
export function phaseAbgleichen(projektId: string, pfad: string) {
  for (const k of schluesselVon(projektId)) phaseAbgleichenSitzung(k, pfad);
}

function phaseAbgleichenSitzung(id: string, pfad: string) {
  const s = sitzungen.get(id);
  if (!s?.laeuft || s.wechsel) return;
  if (s.phase === gewuenschtePhase(pfad)) return;
  const pruefen = () => {
    const akt = sitzungen.get(id);
    if (akt !== s || !s.laeuft) return;
    const ziel = gewuenschtePhase(pfad);
    if (s.phase === ziel) { s.wechsel = undefined; return; }
    // Nur in Ruhe wechseln: Claude gibt nichts aus, keine Rückfrage offen, keine halb getippte Eingabe
    // (die zählt nur 20 s nach der letzten Taste — sonst könnte eine falsch erkannte Eingabe den Wechsel ewig aufhalten).
    const tippt = s.eingabeOffen && Date.now() - s.letzteEingabe < 20_000;
    if (Date.now() - s.letzteAusgabe < 2500 || wartetAufAntwort(s.puffer) || tippt) { s.wechsel = setTimeout(pruefen, 1000); return; }
    const hinweis = ziel === "bauen" ? "Freigegeben — Claude wechselt ins BAUEN, das Gespräch bleibt" : "Neue Version — Claude wechselt ins PLANEN, das Gespräch bleibt";
    ausgabe(s, `\r\n\x1b[1m[${hinweis}]\x1b[0m\r\n`);
    const zuschauer = s.zuschauer, altPty = s.pty;
    // Erst neu starten, wenn der alte Prozess sein Gespräch fertig gespeichert hat (Notgrenze 3 s).
    let weiter = false;
    const platzhalter: Sitzung = { ...s, pty: null, laeuft: false, wechsel: undefined, leerlauf: undefined };
    const neuStarten = () => {
      if (weiter) return;
      weiter = true;
      const jetzt = sitzungen.get(id);
      if (!jetzt) return; // inzwischen beendet (z. B. aus der Übersicht entfernt) — nicht neu starten
      // Hat inzwischen jemand anders ein Claude gestartet, das zuerst beenden — nie zwei gleichzeitig.
      if (jetzt !== platzhalter) beende(id);
      const neu = starte(id, pfad, zuschauer, true);
      sende(neu, { typ: "status", laeuft: neu.laeuft });
      sende(neu, { typ: "phase", phase: neu.phase });
      if (ziel === "bauen") baueAuftrag(id, neu);
      phaseAbgleichenSitzung(id, pfad); // falls sich der Stand in der Lücke nochmal geändert hat
    };
    altPty?.onExit(neuStarten);
    setTimeout(neuStarten, 3000);
    beende(id);
    // Platzhalter in der Lücke: ein neu verbundenes Fenster startet so kein eigenes Claude.
    sitzungen.set(id, platzhalter);
  };
  s.wechsel = setTimeout(pruefen, 500);
}

/** Nach der Freigabe: sobald Claude bereit ist, den Bau-Auftrag schicken (der Nutzer hat mit „Freigeben“ zugestimmt). */
function baueAuftrag(id: string, s: Sitzung) {
  const start = Date.now();
  const versuch = () => {
    if (sitzungen.get(id) !== s || !s.laeuft) return;
    const bereit = Date.now() - s.letzteAusgabe > 3000 && Date.now() - start > 4000;
    const r = bereit ? schreibeInSitzung(id, "[Werkbank] Der Ablauf ist freigegeben. Hol ihn mit urs_get_approved und bau ihn jetzt Schritt für Schritt.") : "wartet";
    if (r === "ok" || r === "aus") return;
    if (Date.now() - start < 60_000) { setTimeout(versuch, 500); return; }
    ausgabe(s, "\r\n\x1b[1m[Bau-Auftrag nicht gesendet — schreib selbst „bau jetzt“]\x1b[0m\r\n");
  };
  setTimeout(versuch, 1000);
}

/** Alle Chats eines Projekts beenden (z. B. wenn es aus der Übersicht entfernt wird) — offene Fenster erfahren es. */
export function beendeTerminal(projektId: string) {
  for (const id of schluesselVon(projektId)) {
    const s = sitzungen.get(id)!;
    sende(s, { typ: "aus", d: "\r\n\x1b[1m[Projekt aus der Übersicht entfernt — Terminal beendet]\x1b[0m\r\n" });
    sende(s, { typ: "status", laeuft: false });
    const zuschauer = [...s.zuschauer];
    beende(id);
    for (const ws of zuschauer) ws.close();
  }
}

/** Einen Chat schließen (wie einen Tab): dieses Claude beenden, alle Fenster dieses Chats trennen. */
export function chatSchliessen(projektId: string, chat: string) {
  const id = chatSchluessel(projektId, chat);
  const s = sitzungen.get(id);
  if (s) { const zuschauer = [...s.zuschauer]; beende(id); for (const w of zuschauer) w.close(); }
  gespraeche.delete(id); groessen.delete(id);
}

/** Ordner von Claude Code für die Gespräche eines Arbeitsordners (echter Pfad; jedes Zeichen außer Buchstaben/Ziffern wird „-“). */
const gespraechsOrdner = (pfad: string) => {
  let p = resolve(pfad);
  try { p = realpathSync(p); } catch { /* gibt es nicht (mehr) */ }
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects", p.replace(/[^a-zA-Z0-9]/g, "-"));
};

/** Beendet ein Claude und wartet, bis es weg ist (sein Gespräch ist dann gespeichert). Hängt es, hart beenden. */
function endeAbwarten(p: IPty) {
  return new Promise<void>((ok) => {
    let fertig = false, hart: NodeJS.Timeout | undefined, notfall: NodeJS.Timeout | undefined;
    const ende = () => { if (!fertig) { fertig = true; clearTimeout(hart); clearTimeout(notfall); ok(); } };
    p.onExit(ende);
    sicher(() => p.kill());
    hart = setTimeout(() => { if (!fertig) sicher(() => p.kill("SIGKILL")); notfall = setTimeout(ende, 1000); }, 3000);
  });
}

/** Ein Chat beim Umzug: altes und neues Kennzeichen, sein Gespräch und ob er nach dem Umzug bauen soll. */
export type UmzugChat = { altK: string; neuK: string; gespraech: string; groesse?: { cols: number; rows: number }; zuletzt: boolean };

/**
 * Plan ohne Ordner zieht um (U79), Schritt 1: die Chats des Plans enden (Gespräch gespeichert), ihre Gesprächsdateien
 * werden in den neuen Ordner kopiert. Neue Verbindungen zum Plan werden abgewiesen. Noch wird nichts auf das neue
 * Projekt umgestellt — das macht umzugFertig erst, wenn .urs/ verschoben ist (sonst umzugAbgebrochen).
 * Auch Chats, deren Claude wegen Leerlauf schon beendet ist, ziehen mit (sie stehen nur noch in gespraeche).
 */
export async function umziehenTerminal(altId: string, altPfad: string, neuId: string, neuPfad: string): Promise<UmzugChat[]> {
  umgezogeneProjekte.add(altId);
  const praefix = `${altId}#`;
  const schluessel = [...new Set([...sitzungen.keys(), ...gespraeche.keys()].filter((k) => k.startsWith(praefix)))];
  // Der zuletzt benutzte Chat bekommt nach dem Umzug den Bau-Auftrag (falls freigegeben).
  const zuletzt = schluessel.filter((k) => sitzungen.has(k)).sort((a, b) => sitzungen.get(b)!.letzteAktiv - sitzungen.get(a)!.letzteAktiv)[0] ?? schluessel[0];
  const chats: UmzugChat[] = [];
  const enden: Promise<void>[] = [];
  for (const k of schluessel) {
    const g = gespraeche.get(k);
    if (g) chats.push({ altK: k, neuK: chatSchluessel(neuId, k.slice(praefix.length)), gespraech: g, groesse: groessen.get(k), zuletzt: k === zuletzt });
    const s = sitzungen.get(k);
    if (s) {
      const zuschauer = [...s.zuschauer];
      sitzungen.delete(k); clearTimeout(s.leerlauf); clearTimeout(s.wechsel);
      if (s.laeuft && s.pty) enden.push(endeAbwarten(s.pty));
      for (const w of zuschauer) w.close(); // das Fenster verbindet neu und erfährt dann die neue id (verbindeTerminal)
    }
    gespraeche.delete(k); groessen.delete(k);
  }
  await Promise.all(enden);
  // Gesprächsdateien mitnehmen — sonst findet --resume sie im neuen Ordner nicht (dann startet Claude frisch, siehe starte).
  const von = gespraechsOrdner(altPfad), nach = gespraechsOrdner(neuPfad);
  for (const c of chats) {
    const datei = `${c.gespraech}.jsonl`;
    try { mkdirSync(nach, { recursive: true }); if (existsSync(join(von, datei))) copyFileSync(join(von, datei), join(nach, datei)); } catch { /* dann frisch */ }
  }
  return chats;
}

/**
 * Schritt 2 nach geglücktem Umzug: die Chats gehören jetzt zum neuen Projekt und setzen ihr Gespräch dort fort.
 * Gebaut wird nur von einem Chat — und gar nicht, wenn im Zielordner schon ein Claude läuft (der baut dann).
 */
export function umzugFertig(altId: string, neuId: string, chats: UmzugChat[]) {
  umzugNach.set(altId, neuId);
  const zielLaeuft = schluesselVon(neuId).some((k) => sitzungen.get(k)?.laeuft);
  for (const c of chats) {
    gespraeche.set(c.neuK, c.gespraech); fortsetzen.add(c.neuK);
    if (c.groesse) groessen.set(c.neuK, c.groesse);
    if (c.zuletzt && !zielLaeuft) bauNachUmzug.add(c.neuK);
  }
}

/** Umzug gescheitert, bevor der Plan verschoben war: er bleibt, wo er war — seine Chats setzen dort ihr Gespräch fort. */
export function umzugAbgebrochen(altId: string, chats: UmzugChat[]) {
  umgezogeneProjekte.delete(altId);
  for (const c of chats) {
    if (sitzungen.has(c.altK)) continue;
    gespraeche.set(c.altK, c.gespraech); weiterNachAbbruch.add(c.altK);
    if (c.groesse) groessen.set(c.altK, c.groesse);
  }
}

/** Hat das Projekt noch irgendeinen Chat (laufend oder per Leerlauf beendet)? */
export const hatChats = (projektId: string) =>
  [...sitzungen.keys(), ...gespraeche.keys()].some((k) => k.startsWith(`${projektId}#`));

/** Hinweis in alle laufenden Chats eines Projekts schreiben (nur Anzeige, keine Eingabe an Claude). */
export function hinweisAnChats(projektId: string, text: string) {
  for (const k of schluesselVon(projektId)) ausgabe(sitzungen.get(k)!, `\r\n\x1b[1m[${text}]\x1b[0m\r\n`);
}

/** Läuft in irgendeinem Chat des Projekts ein Claude? */
export const terminalLaeuft = (projektId: string) => schluesselVon(projektId).some((k) => sitzungen.get(k)?.laeuft);

export const anzahlTerminals = () => [...sitzungen.values()].filter((s) => s.laeuft).length;

/** Beim Beenden des Servers alle Claude-Prozesse mitnehmen. */
export function beendeTerminals() {
  for (const id of [...sitzungen.keys()]) beende(id);
}
