// Einrichtungs-Prüfung: Ist die Claude-CLI da und angemeldet? Ohne beides kann die Werkbank nicht planen.
import { execFile } from "node:child_process";
import { claudeBefehl, claudeUmgebung } from "./claude.ts";

export type Einrichtung = { claude: boolean; angemeldet: boolean; abo: boolean; hinweis: string };

let letzte: { zeit: number; ergebnis: Promise<Einrichtung> } | null = null;

/** Wie pruefeEinrichtung, aber höchstens alle 3 s ein Aufruf der CLI (eine Webseite soll keine Prozess-Flut auslösen). */
export function pruefeEinrichtungGepuffert(): Promise<Einrichtung> {
  if (!letzte || Date.now() - letzte.zeit > 3_000) letzte = { zeit: Date.now(), ergebnis: pruefeEinrichtung() };
  return letzte.ergebnis;
}

/** Fragt `claude auth status` (JSON). Nie über einen API-Schlüssel — der wird aus der Umgebung entfernt. */
export function pruefeEinrichtung(): Promise<Einrichtung> {
  let befehl: string;
  try { befehl = claudeBefehl(); } catch {
    return Promise.resolve({ claude: false, angemeldet: false, abo: false, hinweis: "Claude Code ist nicht installiert." });
  }
  return new Promise((ok) => {
    execFile(befehl, ["auth", "status", "--json"], { env: claudeUmgebung(), timeout: 15_000 }, (err, stdout) => {
      try {
        const j = (JSON.parse(stdout) ?? {}) as { loggedIn?: boolean; authMethod?: string };
        const angemeldet = !!j.loggedIn;
        const abo = angemeldet && j.authMethod === "claude.ai";
        ok({
          claude: true, angemeldet, abo,
          hinweis: !angemeldet ? "Claude Code ist installiert, aber nicht angemeldet."
            : !abo ? "Claude Code ist nicht mit einem Claude-Abo angemeldet." : "Alles bereit.",
        });
      } catch {
        ok({ claude: true, angemeldet: false, abo: false, hinweis: err ? `Claude Code antwortet nicht: ${err.message.split("\n")[0]}` : "Antwort von Claude Code nicht lesbar." });
      }
    });
  });
}
