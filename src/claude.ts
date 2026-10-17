// Aufruf der lokalen Claude-CLI: läuft übers Abo, nie über einen API-Schlüssel.
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * Umgebung für Claude-Unterprozesse. Entfernt ANTHROPIC_* (sonst rechnet die CLI über die API ab)
 * und die Kennzeichen einer aufrufenden Claude-Code-Sitzung (sonst verweigert die CLI den Start).
 */
export function claudeUmgebung(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith("ANTHROPIC_") || k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
    if (k === "URS_APP_SCHLUESSEL") continue; // App-Schlüssel nie an Claude: sonst könnte es selbst freigeben (U53)
    env[k] = v;
  }
  const lokal = join(homedir(), ".local", "bin");
  const pfade = (env.PATH ?? "").split(delimiter).filter(Boolean);
  if (!pfade.includes(lokal)) env.PATH = [...pfade, lokal, "/opt/homebrew/bin", "/usr/local/bin"].join(delimiter);
  return { ...env, ...extra };
}

/** Vollständiger Pfad der claude-CLI (der Server hat oft einen knappen PATH). Nie aus node_modules. */
export function claudeBefehl(): string {
  for (const d of claudeUmgebung().PATH.split(delimiter)) {
    if (!isAbsolute(d) || d.includes("node_modules")) continue; // ein Paket darf kein eigenes „claude“ unterschieben
    const p = join(d, "claude");
    try { accessSync(p, constants.X_OK); return p; } catch { /* weiter suchen */ }
  }
  throw new Error("claude-CLI nicht gefunden (erwartet z. B. in ~/.local/bin)");
}
