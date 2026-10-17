import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  UrsFehler, abmelden, alleOrdner, anmelden, feedback, freigeben, freigegeben, ladeArbeit, ladeProjekt, ladeVersion, offen, pfadVon,
  pruefeInhalt, speichereArbeit, stand, submit, verwerfen,
} from "../src/store.ts";
import { minimaleUrs, smartOk, submitOk, ursMitZweiPunkten } from "./fixtures.ts";

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

/** Neue Version so, wie Claude sie nach urs_get_feedback schickt (mit bekanntem Stand). */
const ueberarbeiten = (u = minimaleUrs()) => submit(projektDir, u, stand(ladeArbeit(projektDir)));

describe("Versionierung", () => {
  it("legt Version 1 als Entwurf an", () => {
    expect(submit(projektDir, minimaleUrs()).version).toBe(1);
    expect(ladeProjekt(projektDir)).toMatchObject({ status: "entwurf", aktuelleVersion: 1 });
  });

  it("lehnt Version 2 ab, wenn eine U-Nummer aus Version 1 einfach fehlt", () => {
    submit(projektDir, minimaleUrs());
    expect(() => submit(projektDir, minimaleUrs({
      anforderungen: [{ id: "U2", text: "Andere.", prio: "muss" }],
      knoten: [{ id: "k1", typ: "start", text: "Start", anforderungen: ["U2"] }],
    }))).toThrow(/U1 fehlt/);
  });

  it("gestrichene U-Nummer darf nicht wiederbelebt werden", () => {
    const u = (gestrichen = false) => [
      { id: "U1", text: "Erste.", prio: "muss" as const, ...(gestrichen ? { gestrichen } : {}) },
      { id: "U2", text: "Zweite.", prio: "muss" as const },
    ];
    const k1 = { id: "k1", typ: "start" as const, text: "Start", anforderungen: ["U1"] };
    const k2 = { id: "k2", typ: "schritt" as const, text: "Zwei", anforderungen: ["U2"] };
    submit(projektDir, minimaleUrs({ anforderungen: u(), knoten: [k1, k2] }));
    submit(projektDir, minimaleUrs({ anforderungen: u(true), knoten: [k2] }));
    expect(() => submit(projektDir, minimaleUrs({ anforderungen: u(), knoten: [k1, k2] })))
      .toThrow(/U1 ist gestrichen und darf nicht neu vergeben werden/);
  });

  it("übernimmt offene Kommentare, verliert den Knoten wenn er gelöscht wurde; erledigte fallen weg", () => {
    submit(projektDir, minimaleUrs());
    speichereArbeit(projektDir, {
      ...ladeArbeit(projektDir),
      kommentare: [
        { id: "c1", knoten: "k1", text: "offen, Knoten fällt weg", zeit: "t", erledigt: false },
        { id: "c2", knoten: "k1", text: "erledigt", zeit: "t", erledigt: true },
      ],
    });
    ueberarbeiten(minimaleUrs({ knoten: [{ id: "k2", typ: "start", text: "Start", anforderungen: ["U1"] }] }));
    expect(ladeArbeit(projektDir).kommentare).toEqual([
      { id: "c1", knoten: null, text: "offen, Knoten fällt weg", zeit: "t", erledigt: false },
    ]);
  });

  it("übernimmt Antworten nur für Fragen, die es noch gibt", () => {
    submit(projektDir, minimaleUrs({ fragen: [{ id: "f1", text: "Frage 1" }, { id: "f2", text: "Frage 2" }] }));
    speichereArbeit(projektDir, { ...ladeArbeit(projektDir), antworten: { f1: "Antwort 1", f2: "Antwort 2" } });
    ueberarbeiten(minimaleUrs({ fragen: [{ id: "f1", text: "Frage 1" }] }));
    expect(ladeArbeit(projektDir).antworten).toEqual({ f1: "Antwort 1" });
  });
});

describe("Freigabe-Regeln", () => {
  it("blockiert bei offenem Kommentar", () => {
    submit(projektDir, minimaleUrs());
    speichereArbeit(projektDir, {
      ...ladeArbeit(projektDir),
      kommentare: [{ id: "c1", knoten: "k1", text: "offen", zeit: "t", erledigt: false }],
    });
    expect(() => freigeben(projektDir, 1)).toThrow(/Kommentar/);
  });

  it("blockiert bei unbeantworteter Frage", () => {
    submit(projektDir, minimaleUrs({ fragen: [{ id: "f1", text: "Wie genau?" }] }));
    expect(() => freigeben(projektDir, 1)).toThrow(/Frage/);
  });

  it("blockiert bei nicht übernommenen Nutzer-Änderungen", () => {
    submit(projektDir, minimaleUrs());
    speichereArbeit(projektDir, {
      ...ladeArbeit(projektDir),
      knoten: [{ id: "k1", typ: "start", text: "Anders", anforderungen: ["U1"] }],
    });
    expect(() => freigeben(projektDir, 1)).toThrow(/Änderung/);
  });

  it("gibt frei, wenn nichts mehr offen ist, und friert die Version ein", () => {
    submitOk(projektDir, minimaleUrs());
    expect(offen(projektDir)).toEqual({ kommentare: 0, fragen: 0, aenderungen: 0, smart: 0 });
    freigeben(projektDir, 1);
    expect(ladeProjekt(projektDir)).toMatchObject({ status: "freigegeben", freigegebeneVersion: 1 });
    expect(() => speichereArbeit(projektDir, ladeArbeit(projektDir))).toThrow(/eingefroren/);
    expect(() => verwerfen(projektDir)).toThrow(/eingefroren/);
    expect(() => freigeben(projektDir, 1)).toThrow(/Schon freigegeben/);
  });

  it("speichert das freigegebene Layout vor einem späteren Entwurf in der Version", () => {
    submitOk(projektDir, ursMitZweiPunkten());
    const approvedPositions = { k1: { x: 41, y: 73 }, k2: { x: 301, y: 415 } };
    speichereArbeit(projektDir, { ...ladeArbeit(projektDir), positionen: approvedPositions });
    freigeben(projektDir, 1);
    const approvedFile = join(projektDir, ".urs", "v001.json");
    const approvedBytes = readFileSync(approvedFile, "utf8");
    expect(JSON.parse(approvedBytes).positionen).toEqual(approvedPositions);

    submit(projektDir, ursMitZweiPunkten());
    const draftPositions = { k1: { x: 10, y: 10 }, k2: { x: 20, y: 20 } };
    speichereArbeit(projektDir, { ...ladeArbeit(projektDir), positionen: draftPositions });
    expect(ladeArbeit(projektDir).positionen).toEqual(draftPositions);
    expect(readFileSync(approvedFile, "utf8")).toBe(approvedBytes);
    expect(JSON.parse(readFileSync(approvedFile, "utf8")).positionen).toEqual(approvedPositions);
  });

  it("lehnt Freigabe/Speichern einer veralteten Version ab", () => {
    submit(projektDir, minimaleUrs());
    submit(projektDir, minimaleUrs());
    expect(() => freigeben(projektDir, 1)).toThrow(/Veraltet/);
    expect(() => speichereArbeit(projektDir, { ...ladeArbeit(projektDir), version: 1 })).toThrow(/Veraltet/);
  });

  it("freigegeben(): Fehler vor Freigabe, danach die Version", () => {
    submitOk(projektDir, minimaleUrs());
    expect(() => freigegeben(projektDir)).toThrow(UrsFehler);
    freigeben(projektDir, 1);
    const v = freigegeben(projektDir);
    expect(v.version).toBe(1);
    expect(v.freigegeben).toBeTruthy();
  });

  it("neuer Submit nach Freigabe setzt auf Entwurf zurück, freigegeben() schlägt wieder fehl", () => {
    submitOk(projektDir, minimaleUrs());
    freigeben(projektDir, 1);
    submit(projektDir, minimaleUrs());
    expect(ladeProjekt(projektDir)).toMatchObject({ status: "entwurf", aktuelleVersion: 2, freigegebeneVersion: 1 });
    expect(() => freigegeben(projektDir)).toThrow(/Version 1 war freigegeben/);
  });
});

describe("bekannterStand blockiert blinde Überschreibung", () => {
  it("lehnt submit ab, wenn Rückmeldung da ist und bekannterStand nicht passt", () => {
    submit(projektDir, minimaleUrs());
    speichereArbeit(projektDir, {
      ...ladeArbeit(projektDir),
      kommentare: [{ id: "c1", knoten: "k1", text: "Bitte prüfen", zeit: "t", erledigt: false }],
    });
    expect(() => submit(projektDir, minimaleUrs(), "falscher-stand")).toThrow(/inzwischen etwas geändert/);
  });

  it("lässt submit zu, wenn bekannterStand zum aktuellen Stand passt", () => {
    submit(projektDir, minimaleUrs());
    speichereArbeit(projektDir, {
      ...ladeArbeit(projektDir),
      kommentare: [{ id: "c1", knoten: "k1", text: "Bitte prüfen", zeit: "t", erledigt: false }],
    });
    expect(() => submit(projektDir, minimaleUrs(), feedback(projektDir).stand)).not.toThrow();
  });

  it("braucht keinen bekannterStand, wenn es keine Rückmeldung gibt", () => {
    submit(projektDir, minimaleUrs());
    expect(() => submit(projektDir, minimaleUrs())).not.toThrow();
  });
});

describe("Antworten wandern nur bei gleicher Frage-id UND gleichem Fragetext mit", () => {
  it("verliert die Antwort, wenn sich der Fragetext ändert", () => {
    submit(projektDir, minimaleUrs({ fragen: [{ id: "f1", text: "Frage A" }] }));
    speichereArbeit(projektDir, { ...ladeArbeit(projektDir), antworten: { f1: "Antwort" } });
    submit(projektDir, minimaleUrs({ fragen: [{ id: "f1", text: "Frage A geändert" }] }), feedback(projektDir).stand);
    expect(ladeArbeit(projektDir).antworten).toEqual({});
  });

  it("behält die Antwort, wenn id und Text unverändert sind", () => {
    submit(projektDir, minimaleUrs({ fragen: [{ id: "f1", text: "Frage A" }] }));
    speichereArbeit(projektDir, { ...ladeArbeit(projektDir), antworten: { f1: "Antwort" } });
    submit(projektDir, minimaleUrs({ fragen: [{ id: "f1", text: "Frage A" }] }), feedback(projektDir).stand);
    expect(ladeArbeit(projektDir).antworten).toEqual({ f1: "Antwort" });
  });
});

describe("Versionsnummer = höchste vorhandene Datei + 1", () => {
  it("überschreibt eine vorhandene v001.json nicht, auch ohne projekt.json", () => {
    const ordner = join(projektDir, ".urs");
    mkdirSync(ordner, { recursive: true });
    const fremdeVersion = { version: 1, erstellt: "2020-01-01T00:00:00.000Z", inhalt: minimaleUrs() };
    writeFileSync(join(ordner, "v001.json"), JSON.stringify(fremdeVersion));
    expect(submit(projektDir, minimaleUrs()).version).toBe(2);
    expect(JSON.parse(readFileSync(join(ordner, "v001.json"), "utf8"))).toEqual(fremdeVersion);
  });
});

describe("submit mit erledigteKommentare", () => {
  const kommentare = [
    { id: "c1", knoten: "k1", text: "eins", zeit: "t", erledigt: false },
    { id: "c2", knoten: "k1", text: "zwei", zeit: "t", erledigt: false },
    { id: "c3", knoten: "k1", text: "drei", zeit: "t", erledigt: false },
  ];
  const mitKommentaren = () => {
    submit(projektDir, minimaleUrs());
    speichereArbeit(projektDir, { ...ladeArbeit(projektDir), kommentare });
  };
  const ids = () => ladeArbeit(projektDir).kommentare.map((k) => k.id);

  it("ohne Angabe wandern alle offenen Kommentare mit", () => {
    mitKommentaren();
    submit(projektDir, minimaleUrs(), feedback(projektDir).stand);
    expect(ids()).toEqual(["c1", "c2", "c3"]);
  });

  it("genannte ids wandern nicht mit, die übrigen bleiben unverändert", () => {
    mitKommentaren();
    submit(projektDir, minimaleUrs(), feedback(projektDir).stand, ["c1", "c3"]);
    expect(ladeArbeit(projektDir).kommentare).toEqual([kommentare[1]]);
  });

  it("unbekannte ids stören nicht und lassen nichts anderes verschwinden", () => {
    mitKommentaren();
    expect(() => submit(projektDir, minimaleUrs(), feedback(projektDir).stand, ["gibt-es-nicht", "c2"])).not.toThrow();
    expect(ids()).toEqual(["c1", "c3"]);
  });

  it("falscher bekannterStand blockiert weiterhin, auch mit erledigteKommentare", () => {
    mitKommentaren();
    expect(() => submit(projektDir, minimaleUrs(), "falscher-stand", ["c1"])).toThrow(/inzwischen etwas geändert/);
    expect(ids()).toEqual(["c1", "c2", "c3"]);
  });
});

describe("abmelden (Projekt aus der Übersicht nehmen)", () => {
  it("entfernt nur den Registereintrag, Ordner und .urs bleiben", () => {
    submit(projektDir, minimaleUrs());
    const id = anmelden(projektDir);
    expect(abmelden(id)).toBe(true);
    expect(pfadVon(id)).toBeNull();
    expect(alleOrdner().some((o) => o.id === id)).toBe(false);
    expect(existsSync(join(projektDir, ".urs", "v001.json"))).toBe(true);
    expect(ladeProjekt(projektDir)).toMatchObject({ status: "entwurf", aktuelleVersion: 1 });
  });

  it("lässt andere Projekte im Register unberührt", () => {
    const anderer = mkdtempSync(join(tmpdir(), "urs-proj2-"));
    try {
      const id = anmelden(projektDir);
      const idAnderer = anmelden(anderer);
      abmelden(id);
      expect(pfadVon(idAnderer)).toBe(anderer);
    } finally { rmSync(anderer, { recursive: true, force: true }); }
  });

  it("liefert false bei unbekannter id (auch __proto__/toString) und ändert nichts", () => {
    const id = anmelden(projektDir);
    for (const x of ["gibt-es-nicht", "__proto__", "toString"]) expect(abmelden(x)).toBe(false);
    expect(pfadVon(id)).toBe(projektDir);
  });

  it("zweites Abmelden derselben id: false", () => {
    const id = anmelden(projektDir);
    expect(abmelden(id)).toBe(true);
    expect(abmelden(id)).toBe(false);
  });

  it("erneutes anmelden(pfad) liefert dieselbe id, und die URS ist wieder da", () => {
    submit(projektDir, minimaleUrs());
    const id = anmelden(projektDir);
    abmelden(id);
    expect(anmelden(projektDir)).toBe(id);
    expect(alleOrdner().find((o) => o.id === id)).toMatchObject({ pfad: projektDir, version: 1, status: "entwurf" });
  });
});

describe("feste Knoten wandern in die neue Version (U44)", () => {
  const start = { id: "k1", typ: "start" as const, text: "Start", anforderungen: ["U1"] };
  const zwei = { id: "k2", typ: "schritt" as const, text: "Zwei", anforderungen: ["U2"] };
  const drei = { id: "k3", typ: "schritt" as const, text: "Drei", anforderungen: ["U3"] };
  const anf = (n: number, gestrichen = false) => ({ id: `U${n}`, text: `Satz ${n}.`, prio: "muss" as const, ...(gestrichen ? { gestrichen } : {}) });
  const mitDrei = () => minimaleUrs({ anforderungen: [anf(1), anf(2), anf(3)], knoten: [start, zwei, drei], kanten: [{ von: "k1", nach: "k2" }, { von: "k2", nach: "k3" }] });
  const ohneDrei = () => minimaleUrs({ anforderungen: [anf(1), anf(2), anf(3, true)], knoten: [start, zwei], kanten: [{ von: "k1", nach: "k2" }] });

  it("eine frische erste Version hat keine festen Knoten", () => {
    submit(projektDir, mitDrei());
    expect(ladeArbeit(projektDir).fest ?? []).toEqual([]);
  });

  it("fest und die Positionen fester Knoten bleiben; nicht feste Positionen fallen weg", () => {
    submit(projektDir, mitDrei());
    speichereArbeit(projektDir, {
      ...ladeArbeit(projektDir),
      positionen: { k1: { x: 10, y: 20 }, k2: { x: 30, y: 40 }, k3: { x: 50, y: 60 } },
      fest: ["k1", "k3"],
    });
    ueberarbeiten(mitDrei());
    const a = ladeArbeit(projektDir);
    expect(a.fest).toEqual(["k1", "k3"]);
    expect(a.positionen).toEqual({ k1: { x: 10, y: 20 }, k3: { x: 50, y: 60 } });
  });

  it("gelöschte Knoten fallen aus fest und positionen heraus", () => {
    submit(projektDir, mitDrei());
    speichereArbeit(projektDir, {
      ...ladeArbeit(projektDir),
      positionen: { k1: { x: 10, y: 20 }, k2: { x: 30, y: 40 }, k3: { x: 50, y: 60 } },
      fest: ["k1", "k3"],
    });
    ueberarbeiten(ohneDrei());
    const a = ladeArbeit(projektDir);
    expect(a.fest).toEqual(["k1"]);
    expect(a.positionen).toEqual({ k1: { x: 10, y: 20 } });
  });

  it("ein als fest markierter Knoten ohne gespeicherte Position fällt heraus", () => {
    submit(projektDir, mitDrei());
    speichereArbeit(projektDir, { ...ladeArbeit(projektDir), positionen: { k1: { x: 1, y: 2 } }, fest: ["k1", "k2"] });
    ueberarbeiten(mitDrei());
    const a = ladeArbeit(projektDir);
    expect(a.fest).toEqual(["k1"]);
    expect(a.positionen).toEqual({ k1: { x: 1, y: 2 } });
  });

  it("ohne fest-Feld in der alten Arbeitskopie (ältere Daten) wird fest leer", () => {
    submit(projektDir, mitDrei());
    const alt = { ...ladeArbeit(projektDir), positionen: { k1: { x: 1, y: 2 } } } as Record<string, unknown>;
    delete alt.fest;
    speichereArbeit(projektDir, alt);
    ueberarbeiten(mitDrei());
    const a = ladeArbeit(projektDir);
    expect(a.fest ?? []).toEqual([]);
    expect(a.positionen).toEqual({});
  });
});

describe("U52: genau ein Knoten je Anforderung (nur neue Versionen)", () => {
  it("submit lehnt eine U an zwei Knoten ab und legt nichts an", () => {
    const u = minimaleUrs({
      knoten: [
        { id: "k1", typ: "start", text: "Start", anforderungen: ["U1"] },
        { id: "k2", typ: "schritt", text: "Zwei", anforderungen: ["U1"] },
      ],
    });
    expect(() => submit(projektDir, u)).toThrow(/U52.*U1 hängt an mehreren Knoten/);
    expect(ladeProjekt(projektDir)).toBeNull();
    expect(existsSync(join(projektDir, ".urs", "v001.json"))).toBe(false);
  });

  it("submit lehnt eine U ohne Knoten ab", () => {
    const u = minimaleUrs({ anforderungen: [{ id: "U1", text: "A.", prio: "muss" }, { id: "U2", text: "B.", prio: "muss" }] });
    expect(() => submit(projektDir, u)).toThrow(/U2 hängt an keinem Knoten/);
  });

  it("alte Versionen mit Mehrfachzuordnung bleiben lesbar; die Folgeversion ist wieder gültig", () => {
    submit(projektDir, ursMitZweiPunkten());
    const datei = join(projektDir, ".urs", "v001.json");
    const alt = JSON.parse(readFileSync(datei, "utf8"));
    alt.inhalt.knoten[1].anforderungen = ["U1"]; // wie früher: dieselbe U an beiden Knoten
    alt.inhalt.anforderungen = [alt.inhalt.anforderungen[0], { ...alt.inhalt.anforderungen[1], gestrichen: true }];
    writeFileSync(datei, JSON.stringify(alt));
    expect(ladeVersion(projektDir, 1).inhalt.knoten[1].anforderungen).toEqual(["U1"]);
    const neu = ursMitZweiPunkten();
    neu.anforderungen[1] = { ...neu.anforderungen[1], gestrichen: true };
    neu.knoten = [neu.knoten[0]];
    neu.kanten = [];
    expect(submit(projektDir, neu).version).toBe(2);
  });
});

describe("U55: Freigabe braucht bestandene SMART-Prüfung", () => {
  const meldung = () => { try { freigeben(projektDir, 1); return ""; } catch (e) { return (e as Error).message; } };

  it("sperrt ohne smart (Version von vor der Prüfung) und sagt, was zu tun ist", () => {
    submit(projektDir, minimaleUrs());
    expect(offen(projektDir).smart).toBe(1);
    expect(meldung()).toMatch(/SMART ungeprüft.*neu einreichen/);
    expect(ladeProjekt(projektDir)).toMatchObject({ status: "entwurf" });
  });

  it("sperrt bei verfehltem smart und nennt nur die verfehlte U", () => {
    submit(projektDir, ursMitZweiPunkten(), undefined, [], { U1: { ok: true, grund: "" }, U2: { ok: false, grund: "vage" } });
    const m = meldung();
    expect(m).toContain("U2");
    expect(m).not.toContain("U1");
  });

  it("sperrt, wenn für eine gültige U das Ergebnis fehlt", () => {
    submit(projektDir, ursMitZweiPunkten(), undefined, [], { U1: { ok: true, grund: "" } });
    expect(meldung()).toMatch(/SMART.*U2/);
  });

  it("gibt frei, wenn alle gültigen ok sind; gestrichene brauchen kein Ergebnis", () => {
    const u = minimaleUrs({
      anforderungen: [{ id: "U1", text: "A.", prio: "muss" }, { id: "U2", text: "B.", prio: "muss", gestrichen: true }],
    });
    submit(projektDir, u, undefined, [], { U1: { ok: true, grund: "ok" } });
    freigeben(projektDir, 1);
    expect(ladeProjekt(projektDir)).toMatchObject({ status: "freigegeben" });
  });

  it("U54: smart wird in der Version gespeichert", () => {
    const u = ursMitZweiPunkten();
    submit(projektDir, u, undefined, [], smartOk(u));
    expect(ladeVersion(projektDir, 1).smart).toEqual({ U1: { ok: true, grund: "ok" }, U2: { ok: true, grund: "ok" } });
  });
});

describe("Anforderungslänge (U48)", () => {
  const mitWoertern = (n: number, teil: { gestrichen?: boolean } = {}) =>
    minimaleUrs({ anforderungen: [{ id: "U1", text: Array.from({ length: n }, (_, i) => `w${i + 1}`).join(" "), prio: "muss", ...teil }] });

  it("genau 12 Wörter sind erlaubt", () => {
    expect(() => pruefeInhalt(mitWoertern(12))).not.toThrow();
  });

  it("13 Wörter werden mit UrsFehler abgelehnt (Meldung nennt Grenze, U-Nummer und Anzahl)", () => {
    const fehler = (() => { try { pruefeInhalt(mitWoertern(13)); } catch (e) { return e; } })();
    expect(fehler).toBeInstanceOf(UrsFehler);
    expect((fehler as Error).message).toContain("höchstens 12 Wörter");
    expect((fehler as Error).message).toContain("U1 hat 13");
  });

  it("mehrfache Leerzeichen und Zeilenumbrüche zählen nicht als eigene Wörter", () => {
    const text = Array.from({ length: 12 }, (_, i) => `w${i}`).join("   ");
    expect(() => pruefeInhalt(minimaleUrs({ anforderungen: [{ id: "U1", text: `  ${text}  `, prio: "muss" }] }))).not.toThrow();
  });

  it("gestrichene Anforderung mit langem Text bleibt erlaubt", () => {
    const lang = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
    const u = minimaleUrs({
      anforderungen: [{ id: "U1", text: "Kurz.", prio: "muss" }, { id: "U2", text: lang, prio: "muss", gestrichen: true }],
    });
    expect(() => pruefeInhalt(u)).not.toThrow();
  });

  it("nennt mehrere zu lange Anforderungen, aber nicht die kurzen", () => {
    const lang = Array.from({ length: 13 }, (_, i) => `w${i}`).join(" ");
    const u = minimaleUrs({
      anforderungen: [
        { id: "U1", text: lang, prio: "muss" },
        { id: "U2", text: "Kurz.", prio: "muss" },
        { id: "U3", text: lang + " x", prio: "muss" },
      ],
      knoten: [
        { id: "k1", typ: "start", text: "Start", anforderungen: ["U1"] },
        { id: "k2", typ: "schritt", text: "Zwei", anforderungen: ["U2"] },
        { id: "k3", typ: "schritt", text: "Drei", anforderungen: ["U3"] },
      ],
    });
    expect(() => pruefeInhalt(u)).toThrow(/U1 hat 13; U3 hat 14/);
  });

  it("submit mit 13-Wörter-Anforderung legt keine Versionsdatei an", () => {
    expect(() => submit(projektDir, mitWoertern(13))).toThrow(UrsFehler);
    expect(existsSync(join(projektDir, ".urs", "v001.json"))).toBe(false);
  });
});
