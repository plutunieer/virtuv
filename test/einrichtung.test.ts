import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeBefehl } from "../src/claude.ts";
import { pruefeEinrichtung } from "../src/einrichtung.ts";

// claudeBefehl bleibt echt (Fake-Skript im PATH), lässt sich aber einmalig zum Werfen bringen.
// Nötig, weil claudeUmgebung() immer ~/.local/bin, Homebrew und /usr/local/bin anhängt — dort könnte ein echtes claude liegen.
vi.mock("../src/claude.ts", async (original) => {
  const echt = await original<typeof import("../src/claude.ts")>();
  return { ...echt, claudeBefehl: vi.fn(echt.claudeBefehl) };
});

const gesichert = { ...process.env };
const zuruecksetzen = () => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, gesichert);
};
let basis: string;
let bin: string;

beforeEach(() => {
  zuruecksetzen();
  basis = mkdtempSync(join(tmpdir(), "urs-einr-"));
  bin = join(basis, "bin");
  mkdirSync(bin);
});
afterEach(() => {
  zuruecksetzen();
  rmSync(basis, { recursive: true, force: true });
});

/** Fake-claude als erster Eintrag im PATH. Schreibt Argumente und ANTHROPIC_API_KEY in Dateien daneben. */
function fakeClaude(stdout: string, exitCode = 0) {
  const skript = [
    "#!/bin/sh",
    `echo "$@" > '${join(basis, "args")}'`,
    `printf '%s' "$ANTHROPIC_API_KEY" > '${join(basis, "key")}'`,
    `printf '%s' '${stdout}'`,
    `exit ${exitCode}`,
    "",
  ].join("\n");
  writeFileSync(join(bin, "claude"), skript);
  chmodSync(join(bin, "claude"), 0o755);
  process.env.PATH = [bin, process.env.PATH ?? ""].join(delimiter);
}

describe("pruefeEinrichtung: claude fehlt", () => {
  it("liefert claude:false, nicht angemeldet, kein Abo, mit Hinweis — und startet nichts", async () => {
    vi.mocked(claudeBefehl).mockImplementationOnce(() => { throw new Error("claude-CLI nicht gefunden"); });
    const e = await pruefeEinrichtung();
    expect(e).toMatchObject({ claude: false, angemeldet: false, abo: false });
    expect(e.hinweis).toMatch(/nicht installiert/);
  });
});

describe("pruefeEinrichtung: claude auth status --json", () => {
  it("loggedIn true + authMethod claude.ai: angemeldet und Abo", async () => {
    fakeClaude('{"loggedIn":true,"authMethod":"claude.ai"}');
    expect(await pruefeEinrichtung()).toEqual({ claude: true, angemeldet: true, abo: true, hinweis: "Alles bereit." });
  });

  it("ruft genau `auth status --json` auf", async () => {
    fakeClaude('{"loggedIn":true,"authMethod":"claude.ai"}');
    await pruefeEinrichtung();
    expect(readFileSync(join(basis, "args"), "utf8").trim()).toBe("auth status --json");
  });

  it("entfernt ANTHROPIC_API_KEY aus der Umgebung des Unterprozesses (nie über die API)", async () => {
    process.env.ANTHROPIC_API_KEY = "geheim-nicht-weitergeben";
    fakeClaude('{"loggedIn":true,"authMethod":"claude.ai"}');
    await pruefeEinrichtung();
    expect(readFileSync(join(basis, "key"), "utf8")).toBe("");
  });

  it("loggedIn true, aber anderer authMethod (API-Schlüssel): angemeldet, aber kein Abo", async () => {
    fakeClaude('{"loggedIn":true,"authMethod":"api_key"}');
    const e = await pruefeEinrichtung();
    expect(e).toMatchObject({ claude: true, angemeldet: true, abo: false });
    expect(e.hinweis).toMatch(/Abo/);
  });

  it("loggedIn false: nicht angemeldet, kein Abo (auch wenn authMethod claude.ai dasteht)", async () => {
    fakeClaude('{"loggedIn":false,"authMethod":"claude.ai"}');
    const e = await pruefeEinrichtung();
    expect(e).toMatchObject({ claude: true, angemeldet: false, abo: false });
    expect(e.hinweis).toMatch(/nicht angemeldet/);
  });

  it("loggedIn false mit Exit-Code 1: JSON zählt, nicht der Exit-Code", async () => {
    fakeClaude('{"loggedIn":false}', 1);
    const e = await pruefeEinrichtung();
    expect(e).toMatchObject({ claude: true, angemeldet: false, abo: false });
    expect(e.hinweis).toMatch(/nicht angemeldet/);
  });

  it("kaputtes JSON bei Exit 0: nicht angemeldet, Hinweis 'nicht lesbar'", async () => {
    fakeClaude("das ist kein json");
    const e = await pruefeEinrichtung();
    expect(e).toMatchObject({ claude: true, angemeldet: false, abo: false });
    expect(e.hinweis).toMatch(/nicht lesbar/);
  });

  it("leere Ausgabe: nicht angemeldet, kein Absturz", async () => {
    fakeClaude("");
    expect(await pruefeEinrichtung()).toMatchObject({ claude: true, angemeldet: false, abo: false });
  });

  it('JSON "null": nicht angemeldet, kein Absturz', async () => {
    fakeClaude("null");
    expect(await pruefeEinrichtung()).toMatchObject({ claude: true, angemeldet: false, abo: false });
  });

  it("Fehler ohne Ausgabe (Exit 1): nicht angemeldet, Hinweis 'antwortet nicht'", async () => {
    fakeClaude("", 1);
    const e = await pruefeEinrichtung();
    expect(e).toMatchObject({ claude: true, angemeldet: false, abo: false });
    expect(e.hinweis).toMatch(/antwortet nicht/);
  });
});
