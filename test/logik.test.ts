import { describe, expect, it } from "vitest";
import { aenderungen, offen, smartVerfehlt, zuordnungsFehler } from "../src/logik.ts";
import type { Arbeit } from "../src/schema.ts";
import { minimaleUrs, smartOk } from "./fixtures.ts";

const frischeArbeit = (): Arbeit => ({
  version: 1,
  knoten: [{ id: "k1", typ: "start", text: "Start", anforderungen: ["U1"] }],
  kanten: [],
  positionen: {},
  kommentare: [],
  antworten: {},
});

describe("aenderungen()", () => {
  it("erkennt neue, gelöschte und umbenannte Knoten sowie neue/gelöschte Kanten", () => {
    const inhalt = minimaleUrs({
      knoten: [
        { id: "k1", typ: "start", text: "Start", anforderungen: ["U1"] },
        { id: "k2", typ: "ende", text: "Ende", anforderungen: ["U1"] },
      ],
      kanten: [{ von: "k1", nach: "k2" }],
    });
    const arbeit: Arbeit = {
      version: 1,
      knoten: [
        { id: "k1", typ: "start", text: "Anfang", anforderungen: ["U1"] },
        { id: "k3", typ: "schritt", text: "Neu", anforderungen: ["U1"] },
      ],
      kanten: [{ von: "k1", nach: "k3" }],
      positionen: {},
      kommentare: [],
      antworten: {},
    };
    const diff = aenderungen(inhalt, arbeit);
    expect(diff.neueKnoten.map((k) => k.id)).toEqual(["k3"]);
    expect(diff.geloeschteKnoten).toEqual([{ id: "k2", text: "Ende" }]);
    expect(diff.umbenannt).toEqual([{ id: "k1", vorher: "Start", nachher: "Anfang" }]);
    expect(diff.neueKanten).toEqual([{ von: "k1", nach: "k3" }]);
    expect(diff.geloeschteKanten).toEqual([{ von: "k1", nach: "k2" }]);
  });

  it("meldet keine Änderungen bei identischem Stand", () => {
    const diff = aenderungen(minimaleUrs(), frischeArbeit());
    expect(diff).toEqual({ neueKnoten: [], geloeschteKnoten: [], umbenannt: [], neueKanten: [], geloeschteKanten: [] });
  });
});

describe("offen()", () => {
  it("zählt unerledigte Kommentare, unbeantwortete Fragen und offene Änderungen", () => {
    const inhalt = minimaleUrs({ fragen: [{ id: "f1", text: "Wie genau?" }] });
    const arbeit: Arbeit = {
      ...frischeArbeit(),
      knoten: [{ id: "k1", typ: "start", text: "Anfang", anforderungen: ["U1"] }],
      kommentare: [
        { id: "c1", knoten: "k1", text: "offen", zeit: "t", erledigt: false },
        { id: "c2", knoten: "k1", text: "erledigt", zeit: "t", erledigt: true },
      ],
      antworten: {},
    };
    expect(offen(inhalt, arbeit)).toEqual({ kommentare: 1, fragen: 1, aenderungen: 1, smart: 1 });
  });

  it("meldet alles auf 0, wenn nichts mehr offen ist", () => {
    const inhalt = minimaleUrs({ fragen: [{ id: "f1", text: "Wie genau?" }] });
    expect(offen(inhalt, { ...frischeArbeit(), antworten: { f1: "So." } }, smartOk(inhalt))).toEqual({ kommentare: 0, fragen: 0, aenderungen: 0, smart: 0 });
  });
});

describe("zuordnungsFehler() (U52)", () => {
  const u = (id: string, gestrichen = false) => ({ id, text: "Satz.", prio: "muss" as const, ...(gestrichen ? { gestrichen } : {}) });
  const k = (id: string, anf: string[]) => ({ id, typ: "schritt" as const, text: id, anforderungen: anf });

  it("liefert nichts, wenn jede U an genau einem Knoten hängt", () => {
    expect(zuordnungsFehler(minimaleUrs({ anforderungen: [u("U1"), u("U2")], knoten: [k("k1", ["U1"]), k("k2", ["U2"])] }))).toEqual([]);
  });
  it("meldet eine U ohne Knoten", () => {
    const f = zuordnungsFehler(minimaleUrs({ anforderungen: [u("U1"), u("U2")], knoten: [k("k1", ["U1"])] }));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatch(/U2 hängt an keinem Knoten/);
  });
  it("meldet eine U an mehreren Knoten mit den Knoten-ids", () => {
    const f = zuordnungsFehler(minimaleUrs({ anforderungen: [u("U1")], knoten: [k("k1", ["U1"]), k("k2", ["U1"])] }));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatch(/U1 hängt an mehreren Knoten \(k1, k2\)/);
  });
  it("ignoriert gestrichene Anforderungen (an keinem oder mehreren Knoten)", () => {
    expect(zuordnungsFehler(minimaleUrs({ anforderungen: [u("U1"), u("U2", true)], knoten: [k("k1", ["U1"])] }))).toEqual([]);
    expect(zuordnungsFehler(minimaleUrs({
      anforderungen: [u("U1"), u("U2", true)], knoten: [k("k1", ["U1", "U2"]), k("k2", ["U2"])],
    }))).toEqual([]);
  });
  it("doppelte Nennung im selben Knoten zählt als ein Knoten", () => {
    expect(zuordnungsFehler(minimaleUrs({ anforderungen: [u("U1")], knoten: [k("k1", ["U1", "U1"])] }))).toEqual([]);
  });
  it("meldet jeden Verstoß einzeln (U1 mehrfach, U2 und U3 ohne Knoten)", () => {
    expect(zuordnungsFehler(minimaleUrs({
      anforderungen: [u("U1"), u("U2"), u("U3")], knoten: [k("k1", ["U1"]), k("k2", ["U1"])],
    }))).toHaveLength(3);
  });
});

describe("offen().smart (U55)", () => {
  const inhalt = minimaleUrs({
    anforderungen: [
      { id: "U1", text: "A.", prio: "muss" }, { id: "U2", text: "B.", prio: "muss" },
      { id: "U3", text: "C.", prio: "muss", gestrichen: true },
    ],
    knoten: [
      { id: "k1", typ: "start", text: "Start", anforderungen: ["U1"] },
      { id: "k2", typ: "schritt", text: "Zwei", anforderungen: ["U2"] },
    ],
  });
  const arbeit = (): Arbeit => ({ ...frischeArbeit(), knoten: inhalt.knoten });

  it("ohne smart: alle gültigen Anforderungen zählen als offen, gestrichene nicht", () => {
    expect(offen(inhalt, arbeit()).smart).toBe(2);
    expect(smartVerfehlt(inhalt, undefined)).toEqual(["U1", "U2"]);
  });
  it("zählt verfehlte und fehlende Ergebnisse", () => {
    expect(offen(inhalt, arbeit(), { U1: { ok: true, grund: "" }, U2: { ok: false, grund: "vage" } }).smart).toBe(1);
    expect(offen(inhalt, arbeit(), { U1: { ok: true, grund: "" } }).smart).toBe(1);
  });
  it("0, wenn alle bestanden", () => {
    expect(offen(inhalt, arbeit(), smartOk(inhalt)).smart).toBe(0);
  });
});
