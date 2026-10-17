import { describe, expect, it } from "vitest";
import { Knoten, UrsInhalt } from "../src/schema.ts";
import { minimaleUrs } from "./fixtures.ts";

describe("Schema: Wortgrenzen", () => {
  it("lässt eine gültige Mindest-URS durch", () => {
    expect(() => UrsInhalt.parse(minimaleUrs())).not.toThrow();
  });

  it("lehnt Knoten-Text über 4 Wörtern ab", () => {
    const u = minimaleUrs({
      knoten: [{ id: "k1", typ: "start", text: "Ein Zwei Drei Vier Fünf", anforderungen: ["U1"] }],
    });
    expect(() => UrsInhalt.parse(u)).toThrow(/höchstens 4 Wörter/i);
  });

  it("U48: Anforderungs-Text ist nicht mehr auf 20 Wörter begrenzt (SMART prüft der unabhängige Prüfer)", () => {
    const lang = Array.from({ length: 40 }, (_, i) => `Wort${i}`).join(" ");
    const u = minimaleUrs({ anforderungen: [{ id: "U1", text: lang, prio: "muss" }] });
    expect(() => UrsInhalt.parse(u)).not.toThrow();
  });
});

describe("Schema: mindestens eine U-Nummer je Knoten", () => {
  it("lehnt einen Knoten ohne anforderungen ab", () => {
    const r = Knoten.safeParse({ id: "k1", typ: "start", text: "Start", anforderungen: [] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => /mindestens eine U-Nummer/i.test(i.message))).toBe(true);
  });
});

describe("Schema: hängende Verweise", () => {
  it("lehnt einen Knoten ab, der auf eine unbekannte U-Nummer verweist", () => {
    const u = minimaleUrs({ knoten: [{ id: "k1", typ: "start", text: "Start", anforderungen: ["U1", "U9"] }] });
    const r = UrsInhalt.safeParse(u);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => /U9 gibt es nicht/.test(i.message))).toBe(true);
  });

  it("lehnt eine Kante ab, die auf einen unbekannten Knoten verweist", () => {
    const r = UrsInhalt.safeParse(minimaleUrs({ kanten: [{ von: "k1", nach: "k99" }] }));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => /Knoten k99 gibt es nicht/.test(i.message))).toBe(true);
  });

  it("lehnt einen Knoten ab, der auf eine gestrichene U-Nummer verweist", () => {
    const u = minimaleUrs({
      anforderungen: [
        { id: "U1", text: "Erste Anforderung.", prio: "muss", gestrichen: true },
        { id: "U2", text: "Zweite Anforderung.", prio: "muss" },
      ],
      knoten: [{ id: "k1", typ: "start", text: "Start", anforderungen: ["U1", "U2"] }],
    });
    const r = UrsInhalt.safeParse(u);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => /U1 ist gestrichen/.test(i.message))).toBe(true);
  });
});

describe("Schema: doppelte ids", () => {
  it("lehnt doppelte Anforderungs-ids ab", () => {
    const u = minimaleUrs({
      anforderungen: [
        { id: "U1", text: "Erste.", prio: "muss" },
        { id: "U1", text: "Zweite.", prio: "muss" },
      ],
    });
    const r = UrsInhalt.safeParse(u);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => /Anforderung: U1 doppelt/.test(i.message))).toBe(true);
  });

  it("lehnt doppelte Knoten-ids ab", () => {
    const u = minimaleUrs({
      knoten: [
        { id: "k1", typ: "start", text: "Start", anforderungen: ["U1"] },
        { id: "k1", typ: "ende", text: "Ende", anforderungen: ["U1"] },
      ],
    });
    const r = UrsInhalt.safeParse(u);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => /Knoten: k1 doppelt/.test(i.message))).toBe(true);
  });
});
