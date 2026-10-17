import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeBefehl, claudeUmgebung } from "../src/claude.ts";

const gesichert = { ...process.env };
const zuruecksetzen = () => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, gesichert);
};
beforeEach(zuruecksetzen);
afterEach(zuruecksetzen);

describe("claudeUmgebung: Variablen", () => {
  it("entfernt ANTHROPIC_*, CLAUDECODE und CLAUDE_CODE_*", () => {
    process.env.ANTHROPIC_API_KEY = "geheim";
    process.env.ANTHROPIC_BASE_URL = "http://x";
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    process.env.CLAUDE_CODE_SSE_PORT = "123";
    const env = claudeUmgebung();
    for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"]) {
      expect(env, k).not.toHaveProperty(k);
    }
  });

  it("behält alles andere, auch ähnlich klingende Namen", () => {
    process.env.TEST_BEHALTEN = "ja";
    process.env.MEIN_ANTHROPIC_X = "ja";
    process.env.CLAUDE_ANDERES = "ja";
    expect(claudeUmgebung()).toMatchObject({ TEST_BEHALTEN: "ja", MEIN_ANTHROPIC_X: "ja", CLAUDE_ANDERES: "ja" });
  });

  it("verändert process.env nicht", () => {
    process.env.ANTHROPIC_API_KEY = "geheim";
    claudeUmgebung({ NEU: "1" });
    expect(process.env.ANTHROPIC_API_KEY).toBe("geheim");
    expect(process.env.NEU).toBeUndefined();
  });

  it("gibt den App-Schlüssel nie an Claude weiter, andere URS_APP_*-Variablen bleiben", () => {
    process.env.URS_APP_SCHLUESSEL = "freigabe-geheim";
    process.env.URS_APP_PORT = "4711";
    for (const env of [claudeUmgebung(), claudeUmgebung({ NEU: "1" })]) {
      expect(env).not.toHaveProperty("URS_APP_SCHLUESSEL");
      expect(Object.values(env)).not.toContain("freigabe-geheim");
      expect(env.URS_APP_PORT).toBe("4711");
    }
    expect(process.env.URS_APP_SCHLUESSEL).toBe("freigabe-geheim");
  });

  it("extra ergänzt und überschreibt", () => {
    process.env.TERM = "dumb";
    expect(claudeUmgebung({ TERM: "xterm-256color", URS_APP_KEIN_BROWSER: "1" }))
      .toMatchObject({ TERM: "xterm-256color", URS_APP_KEIN_BROWSER: "1" });
  });

  it("enthält nur Strings (keine undefined-Werte)", () => {
    expect(Object.values(claudeUmgebung()).every((v) => typeof v === "string")).toBe(true);
  });
});

describe("claudeUmgebung: PATH", () => {
  const lokal = join(homedir(), ".local", "bin");

  it("ergänzt ~/.local/bin, Homebrew und /usr/local/bin hinter dem bisherigen PATH", () => {
    process.env.PATH = "/usr/bin";
    const teile = claudeUmgebung().PATH.split(delimiter);
    expect(teile[0]).toBe("/usr/bin");
    expect(teile).toEqual(expect.arrayContaining([lokal, "/opt/homebrew/bin", "/usr/local/bin"]));
  });

  it("lässt den PATH unverändert, wenn ~/.local/bin schon drin ist", () => {
    process.env.PATH = ["/usr/bin", lokal].join(delimiter);
    expect(claudeUmgebung().PATH).toBe(process.env.PATH);
  });

  it("legt einen PATH an, wenn gar keiner gesetzt ist", () => {
    delete process.env.PATH;
    expect(claudeUmgebung().PATH.split(delimiter)).toEqual([lokal, "/opt/homebrew/bin", "/usr/local/bin"]);
  });
});

describe("claudeBefehl", () => {
  const mitFake = (unterordner: string, modus: number, f: (datei: string) => void) => {
    const basis = mkdtempSync(join(tmpdir(), "urs-bin-"));
    const dir = join(basis, unterordner);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "claude"), "#!/bin/sh\n");
      chmodSync(join(dir, "claude"), modus);
      process.env.PATH = [dir, process.env.PATH ?? ""].join(delimiter);
      f(join(dir, "claude"));
    } finally {
      rmSync(basis, { recursive: true, force: true });
    }
  };

  it("liefert den vollen Pfad der ersten ausführbaren claude-Datei im PATH", () => {
    mitFake("bin", 0o755, (datei) => expect(claudeBefehl()).toBe(datei));
  });

  it("überspringt eine nicht ausführbare claude-Datei", () => {
    mitFake("bin", 0o644, (datei) => expect(claudeBefehl()).not.toBe(datei));
  });

  it("nimmt nie ein claude aus node_modules", () => {
    mitFake("node_modules/.bin", 0o755, (datei) => expect(claudeBefehl()).not.toBe(datei));
  });
});
