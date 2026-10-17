// Freigeben kann nur der Nutzer (U53): Claude darf die URS-Dateien (.urs/), den Freigabe-Nachweis (~/.urs-app)
// und die Freigabe-Schnittstelle nicht anfassen. Eine Hürde gegen Versehen, kein harter Schutz (gleicher Nutzer).
// Exit 2 = Werkzeug wird blockiert, die Meldung geht an Claude.
import { homedir } from "node:os";
import { resolve, sep } from "node:path";

let eingabe = "";
for await (const teil of process.stdin) eingabe += teil;
const daten = JSON.parse(eingabe || "{}");
const werkzeug = daten.tool_name, e = daten.tool_input ?? {}, cwd = daten.cwd ?? process.cwd();

const app = resolve(homedir(), ".urs-app") + sep;
const geschuetzt = (p) => {
  const voll = resolve(cwd, String(p));
  return voll.split(sep).includes(".urs") || (voll + sep).startsWith(app);
};

let grund = "";
if (werkzeug === "Bash") {
  const befehl = String(e.command ?? "");
  // Nur Schreibendes blockieren — Lesen (Log, grep, git log) bleibt frei.
  const anfrage = /\b(curl|wget|http|fetch)\b/.test(befehl) && /\/freigeben\b/.test(befehl);
  const schreibt = /(>|\brm\b|\bmv\b|\bcp\b|sed\s+-i|\btee\b|writeFile|\bgit\s+(checkout|restore)\b)/.test(befehl);
  if (anfrage || (schreibt && /freigaben\.json|\.urs\//.test(befehl))) grund = "Approving is the user's job — use the Approve button in the browser.";
} else if (geschuetzt(e.file_path ?? e.notebook_path ?? "")) {
  grund = "Plan files (.urs/) change only through the Virtuv tools (urs_submit) — never edit them directly.";
}
if (grund) {
  process.stderr.write(`Virtuv: ${grund}\n`);
  process.exit(2);
}
