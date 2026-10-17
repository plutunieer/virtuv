import { describe, expect, it } from "vitest";
import { neuSeitFreigabe } from "../src/logik.ts";
import { minimaleUrs } from "./fixtures.ts";

const knotenVon = (inhalt: ReturnType<typeof minimaleUrs>) => inhalt.knoten;

/** Aktueller Stand: U1 (unverändert), U2 (neu), Knoten k1 → U1, k2 → U2. */
const aktuell = () =>
  minimaleUrs({
    anforderungen: [
      { id: "U1", text: "Erster Satz.", prio: "muss" },
      { id: "U2", text: "Zweiter Satz.", prio: "muss" },
    ],
    knoten: [
      { id: "k1", typ: "start", text: "Start", anforderungen: ["U1"] },
      { id: "k2", typ: "schritt", text: "Zweiter", anforderungen: ["U2"] },
    ],
  });

/** Freigegebener Stand: nur U1 und k1, beide identisch zum aktuellen. */
const freigegeben = () =>
  minimaleUrs({
    anforderungen: [{ id: "U1", text: "Erster Satz.", prio: "muss" }],
    knoten: [{ id: "k1", typ: "start", text: "Start", anforderungen: ["U1"] }],
  });

describe("neuSeitFreigabe()", () => {
  it("ohne Freigabe ist alles neu, nur Gestrichenes nicht", () => {
    const inhalt = aktuell();
    inhalt.anforderungen.push({ id: "U3", text: "Weg.", prio: "muss", gestrichen: true });
    const r = neuSeitFreigabe(inhalt, knotenVon(inhalt), false, null, null);
    expect([...r.u].sort()).toEqual(["U1", "U2"]);
    expect([...r.knoten].sort()).toEqual(["k1", "k2"]);
  });

  it("markiert nichts, wenn nichtsNeu gesetzt ist (alte Version oder schon freigegeben)", () => {
    const inhalt = aktuell();
    const r = neuSeitFreigabe(inhalt, knotenVon(inhalt), true, null, null);
    expect(r.u.size).toBe(0);
    expect(r.knoten.size).toBe(0);
  });

  it("markiert nichts, solange die Basis einer vorhandenen Freigabe noch nicht geladen ist", () => {
    const inhalt = aktuell();
    const r = neuSeitFreigabe(inhalt, knotenVon(inhalt), false, 3, null);
    expect(r.u.size).toBe(0);
    expect(r.knoten.size).toBe(0);
  });

  it("markiert nichts, wenn inhalt null ist", () => {
    const r = neuSeitFreigabe(null, [], false, null, null);
    expect(r.u.size).toBe(0);
    expect(r.knoten.size).toBe(0);
  });

  it("Anforderung ist neu, wenn sie in der Basis fehlt; unveränderte nicht", () => {
    const inhalt = aktuell();
    const r = neuSeitFreigabe(inhalt, knotenVon(inhalt), false, 1, freigegeben());
    expect([...r.u]).toEqual(["U2"]);
  });

  it("Anforderung ist neu, wenn sie in der Basis gestrichen war oder anders lautete", () => {
    const inhalt = aktuell();
    const basis = freigegeben();
    basis.anforderungen = [
      { id: "U1", text: "Früher anders.", prio: "muss" },
      { id: "U2", text: "Zweiter Satz.", prio: "muss", gestrichen: true },
    ];
    const r = neuSeitFreigabe(inhalt, knotenVon(inhalt), false, 1, basis);
    expect([...r.u].sort()).toEqual(["U1", "U2"]);
  });

  it("gestrichene aktuelle Anforderung ist nie neu, auch wenn sie in der Basis fehlt", () => {
    const inhalt = aktuell();
    inhalt.anforderungen[1].gestrichen = true;
    const r = neuSeitFreigabe(inhalt, knotenVon(inhalt), false, 1, freigegeben());
    expect(r.u.has("U2")).toBe(false);
  });

  it("Knoten ist neu bei fehlendem Eintrag, anderem Text oder neuer Anforderung; sonst nicht", () => {
    const inhalt = aktuell();
    inhalt.knoten.push(
      { id: "k3", typ: "schritt", text: "Umbenannt", anforderungen: ["U1"] },
      { id: "k4", typ: "schritt", text: "Mit neuer U", anforderungen: ["U1", "U2"] },
    );
    const basis = freigegeben();
    basis.knoten.push(
      { id: "k3", typ: "schritt", text: "Alter Name", anforderungen: ["U1"] },
      { id: "k4", typ: "schritt", text: "Mit neuer U", anforderungen: ["U1"] },
    );
    const r = neuSeitFreigabe(inhalt, knotenVon(inhalt), false, 1, basis);
    // k1 unverändert; k2 fehlt in Basis; k3 Text anders; k4 trägt neue U2
    expect([...r.knoten].sort()).toEqual(["k2", "k3", "k4"]);
  });
});
