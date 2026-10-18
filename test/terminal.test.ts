import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { entschaerfen, gewuenschtePhase, wartetAufAntwort, werkbankArgumente } from "../src/terminal.ts";
import { freigeben, submit } from "../src/store.ts";
import { minimaleUrs, submitOk } from "./fixtures.ts";

// Erkennung von Auswahl-Rückfragen — dann darf die Werkbank kein Enter ins Terminal schicken.
describe("wartetAufAntwort", () => {
  it("erkennt die Erlauben-Frage von Claude Code (auch mit Farbcodes)", () => {
    expect(wartetAufAntwort("viel Text\n\x1b[1mDo you want to proceed?\x1b[0m\n❯ 1. Yes\n  2. No\nEsc to cancel")).toBe(true);
  });

  it("erkennt die Rückfrage am Ende des Plan-Modus", () => {
    expect(wartetAufAntwort("Plan fertig.\nWould you like to proceed?\n❯ 1. Yes")).toBe(true);
  });

  it("erkennt die Vertrauen-Frage", () => {
    expect(wartetAufAntwort("❯ No, exit\n  Yes, I trust this folder\n Enter to confirm · Esc to cancel")).toBe(true);
  });

  it("normaler Eingabe-Prompt: wartet nicht", () => {
    expect(wartetAufAntwort("Antwort fertig.\n───\n❯ \n───\n  ⏵⏵ auto mode on (shift+tab to cycle)")).toBe(false);
  });

  it("eine beantwortete Rückfrage zählt nicht, wenn danach die normale Eingabezeile kam", () => {
    expect(wartetAufAntwort("Do you want to proceed?\n❯ 1. Yes\nEsc to cancel\n⏺ Erledigt.\n❯ \n  ⏵⏵ auto mode on (shift+tab to cycle)")).toBe(false);
  });

  it("eine alte, längst überschriebene Rückfrage weit oben zählt nicht", () => {
    expect(wartetAufAntwort("Do you want to proceed?\n" + "x".repeat(2000) + "\n❯ ")).toBe(false);
  });

  it("erkennt die Vertrauen-Frage, wenn Wortabstände als Cursor-Sprung (ESC[1C) kommen", () => {
    const sprung = (s: string) => s.replace(/ /g, "\x1b[1C");
    const puffer =
      "Accessing workspace:\r\r\n\r\r\n/private/tmp/x/trust-probe\r\r\n\r\r\n" +
      sprung("Quick safety check: Is this a project you created or one you trust?") + "\r\r\n" +
      "\x1b[36m❯\x1b[1C\x1b[39mNo,\x1b[1Cexit\r\r\n" +
      sprung("  Yes, I trust this folder") + "\r\r\n\r\r\n" +
      sprung("Enter to confirm · Esc to cancel") + "\r\r\n";
    expect(wartetAufAntwort(puffer)).toBe(true);
  });

  it("Vertrauen-Frage aus dem echten Mitschnitt (ohne Leerzeichen, mit Rest-Steuerfolge am Ende) wird erkannt", () => {
    const echt =
      "Accessingworkspace:\r\r\n\r\r\n/private/tmp/x/trust-probe\r\r\n\r\r\n" +
      "Quicksafetycheck:Isthisaprojectyoucreatedoroneyoutrust?...\r\r\n" +
      "❯No,exit\r\r\nYes,Itrustthisfolder\r\r\n\r\r\nEntertoconfirm·Esctocancel\r\r\n\u001b[>0q";
    expect(wartetAufAntwort(echt)).toBe(true);
  });

  it("Vertrauen-Frage mit Cursor-Sprüngen zählt nicht mehr, wenn danach die normale Eingabezeile kam", () => {
    const sprung = (s: string) => s.replace(/ /g, "\x1b[1C");
    const puffer =
      sprung("❯ No, exit\r\n  Yes, I trust this folder\r\n Enter to confirm · Esc to cancel") + "\r\n" +
      "\x1b[2J\x1b[H" +
      "───\r\n❯\x1b[1C\r\n───\r\n" +
      "\x1b[1C\x1b[1C?\x1b[1Cfor\x1b[1Cshortcuts";
    expect(wartetAufAntwort(puffer)).toBe(false);
  });

  it("Erlauben-Frage mit Cursor-Sprüngen wird erkannt, normale Eingabezeile mit Cursor-Sprüngen allein nicht", () => {
    const sprung = (s: string) => s.replace(/ /g, "\x1b[1C");
    expect(wartetAufAntwort(sprung("Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\nEsc to cancel"))).toBe(true);
    expect(wartetAufAntwort(sprung("Fertig.\r\n❯ \r\n  ? for shortcuts"))).toBe(false);
  });
});

// Startargumente: normales Claude Code mit den eigenen Einstellungen (U25) — nur helles Schema, URS-Werkzeuge, Anweisung.
describe("werkbankArgumente", () => {
  const args = werkbankArgumente();
  const wert = (a: string[], option: string): string => {
    const i = a.indexOf(option);
    expect(i, `${option} fehlt`).toBeGreaterThanOrEqual(0);
    return a[i + 1];
  };

  it("genau --settings, --mcp-config und --append-system-prompt, sonst nichts", () => {
    expect(args.filter((a) => a.startsWith("--")).sort()).toEqual(["--append-system-prompt", "--mcp-config", "--settings"]);
    expect(args).toHaveLength(6);
  });

  it("keine Sperren mehr: keine Werkzeugliste, eigene Einstellungen, eigene Zusatzprogramme, Slash-Befehle erlaubt", () => {
    for (const o of ["--tools", "--setting-sources", "--strict-mcp-config", "--disable-slash-commands", "--permission-mode"]) {
      expect(args, o).not.toContain(o);
    }
  });

  it("--settings: helles Theme, URS-Werkzeuge ohne Rückfrage, .urs nie direkt schreiben", () => {
    const s = JSON.parse(wert(args, "--settings"));
    expect(s.theme).toBe("light");
    expect(s.permissions.allow).toEqual(["mcp__urs-werkbank"]);
    expect(s.permissions.deny).toEqual(["Edit(**/.urs/**)", "Edit(~/.urs-app/**)"]);
  });

  it("--mcp-config: Server urs-app, Node + absoluter Pfad zu src/mcp.ts, Datei existiert", () => {
    const cfg = JSON.parse(wert(args, "--mcp-config"));
    expect(Object.keys(cfg.mcpServers)).toEqual(["urs-werkbank"]);
    const server = cfg.mcpServers["urs-werkbank"];
    expect(server.command).toBe(process.execPath);
    const pfad: string = server.args[0];
    expect(isAbsolute(pfad)).toBe(true);
    expect(pfad).toBe(resolve(dirname(fileURLToPath(import.meta.url)), "../src/mcp.ts"));
    expect(existsSync(pfad)).toBe(true);
    expect(server.env).toMatchObject({ URS_APP_IN_WERKBANK: "1", URS_APP_KEIN_BROWSER: "1" });
  });

  it("Planen-Anweisung: wie gewohnt arbeiten, aber erst URS, Bauen erst nach Freigabe", () => {
    const text = wert(args, "--append-system-prompt");
    expect(text).toContain("wie gewohnt");
    expect(text).toContain("urs_submit");
    expect(text).toMatch(/erst nach der Freigabe gebaut/);
  });
});

describe("entschaerfen", () => {
  it("lässt Eingaben unverändert (auch ! # / und Shift+Tab) — wie in jedem Terminal", () => {
    for (const d of ["!ls", "# merken", "/help", "\x1b[Z", "hallo\r", "\x1b[A"]) expect(entschaerfen(d)).toBe(d);
  });

  it("entfernt nur Ctrl+Z (hielte Claude ohne Shell darüber an)", () => {
    expect(entschaerfen("a\x1ab")).toBe("ab");
  });
});

// Phase: Bauen genau dann, wenn die aktuelle Version nachweislich in dieser App freigegeben ist. Kein echtes claude.
describe("gewuenschtePhase", () => {
  let projektDir: string;
  let appHomeDir: string;

  beforeEach(() => {
    appHomeDir = mkdtempSync(join(tmpdir(), "urs-home-"));
    process.env.URS_APP_HOME = appHomeDir;
    projektDir = mkdtempSync(join(tmpdir(), "urs-proj-"));
  });
  afterEach(() => {
    rmSync(projektDir, { recursive: true, force: true });
    rmSync(appHomeDir, { recursive: true, force: true });
    delete process.env.URS_APP_HOME;
  });

  it("Ordner ohne URS: planen", () => { expect(gewuenschtePhase(projektDir)).toBe("planen"); });

  it("Entwurf: planen", () => {
    submit(projektDir, minimaleUrs());
    expect(gewuenschtePhase(projektDir)).toBe("planen");
  });

  it("nach der Freigabe: bauen", () => {
    submitOk(projektDir, minimaleUrs());
    freigeben(projektDir, 1);
    expect(gewuenschtePhase(projektDir)).toBe("bauen");
  });

  it("neue Version nach der Freigabe: wieder planen", () => {
    submitOk(projektDir, minimaleUrs());
    freigeben(projektDir, 1);
    submit(projektDir, minimaleUrs());
    expect(gewuenschtePhase(projektDir)).toBe("planen");
  });

  it("projekt.json behauptet „freigegeben“ ohne Freigabe in dieser App (fremdes Repo): planen", () => {
    submit(projektDir, minimaleUrs());
    writeFileSync(join(projektDir, ".urs", "projekt.json"),
      JSON.stringify({ name: "X", status: "freigegeben", aktuelleVersion: 1, freigegebeneVersion: 1 }));
    expect(gewuenschtePhase(projektDir)).toBe("planen");
  });

  it("freigegebene Version nachträglich verändert (Prüfsumme passt nicht): planen", () => {
    submitOk(projektDir, minimaleUrs());
    freigeben(projektDir, 1);
    writeFileSync(join(projektDir, ".urs", "v001.json"), "{}");
    expect(gewuenschtePhase(projektDir)).toBe("planen");
  });

  it("kaputte projekt.json: planen (kein Wurf)", () => {
    mkdirSync(join(projektDir, ".urs"));
    writeFileSync(join(projektDir, ".urs", "projekt.json"), "{kaputt");
    expect(() => gewuenschtePhase(projektDir)).not.toThrow();
    expect(gewuenschtePhase(projektDir)).toBe("planen");
  });
});

describe('werkbankArgumente("bauen")', () => {
  const bauen = werkbankArgumente("bauen");
  const planen = werkbankArgumente("planen");
  const wert = (a: string[], option: string): string => a[a.indexOf(option) + 1];

  it('ohne Argument = planen', () => { expect(werkbankArgumente()).toEqual(planen); });

  it("Bau-Anweisung nennt BAUEN und urs_get_approved; Plan-Anweisung nicht", () => {
    expect(wert(bauen, "--append-system-prompt")).toMatch(/BAUEN[\s\S]*urs_get_approved/);
    expect(wert(planen, "--append-system-prompt")).not.toContain("BAUEN");
  });

  it("gleiche Optionen wie beim Planen, nur die Anweisung unterscheidet sich", () => {
    expect(bauen).toHaveLength(planen.length);
    const unterschiede = bauen.map((a, i) => (a === planen[i] ? null : i)).filter((i) => i !== null) as number[];
    expect(unterschiede.map((i) => bauen[i - 1])).toEqual(["--append-system-prompt"]);
  });
});

describe("Bau-Ablauf in der Anweisung (U61–U69) und Längenregel (U48)", () => {
  const prompt = (phase: "planen" | "bauen") => {
    const a = werkbankArgumente(phase);
    return a[a.indexOf("--append-system-prompt") + 1];
  };

  it("Bau-Anweisung: Ablauf Code → Review → Test → Commit", () => {
    expect(prompt("bauen")).toContain("Code → Review → Test → Commit");
  });

  it("Bau-Anweisung: unabhängiger Prüfer, der den Code nicht geschrieben hat", () => {
    expect(prompt("bauen")).toContain("nicht geschrieben");
  });

  it("Bau-Anweisung: bei „nicht bestanden“ kein Commit", () => {
    expect(prompt("bauen")).toContain("kein Commit");
  });

  it("Bau-Anweisung: eigener Zweig, nie direkt auf main, git push", () => {
    const t = prompt("bauen");
    expect(t).toContain("eigenen Zweig");
    expect(t).toContain("nie direkt auf main");
    expect(t).toContain("git push");
  });

  it("Bau-Anweisung: Zusammenführen nach main nur mit ausdrücklicher Zustimmung", () => {
    expect(prompt("bauen")).toMatch(/Zusammenführen in den Standardzweig nur nach ausdrücklicher Zustimmung/);
  });

  it("Plan-Anweisung: kein git push, aber höchstens 12 Wörter je Anforderung", () => {
    const t = prompt("planen");
    expect(t).not.toContain("git push");
    expect(t).toContain("höchstens 12 Wörter");
  });
});

// U119: Claude wird angewiesen, so kurz wie möglich zu antworten — in App (beide Phasen) und Plugin.
describe("Kürze-Anweisung (U119)", () => {
  const SATZ = "Answer as briefly as possible.";
  const prompt = (phase: "planen" | "bauen", ohneOrdner?: boolean) => {
    const a = werkbankArgumente(phase, ohneOrdner);
    const i = a.indexOf("--append-system-prompt");
    expect(i, "--append-system-prompt fehlt").toBeGreaterThanOrEqual(0);
    return a[i + 1];
  };

  it("planen (mit Projektordner): Anweisung enthält den Kürze-Satz", () => {
    expect(prompt("planen", false)).toContain(SATZ);
  });

  it("planen (ohne Projektordner): Anweisung enthält den Kürze-Satz", () => {
    expect(prompt("planen", true)).toContain(SATZ);
  });

  it("bauen: Anweisung enthält den Kürze-Satz", () => {
    expect(prompt("bauen")).toContain(SATZ);
  });

  it("Plugin: plugin/skills/plan/SKILL.md enthält den Kürze-Satz", () => {
    const wurzel = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const skill = readFileSync(join(wurzel, "plugin", "skills", "plan", "SKILL.md"), "utf8");
    expect(skill).toContain(SATZ);
  });
});
