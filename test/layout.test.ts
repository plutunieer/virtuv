// Fließbild-Anordnung (U40, U41, U44): anordnen → verlegen → befunde, reines Node.
import { describe, expect, it } from "vitest";
import type { Kante, KnotenTyp } from "../src/schema.ts";
import { GROESSE, anordnen, befunde, kantenId, verlegen, type PlatzKnoten, type Route } from "../web/layout.ts";

type K = { id: string; typ: KnotenTyp; text: string };
type P = { x: number; y: number };

const kn = (id: string, typ: KnotenTyp = "schritt"): K => ({ id, typ, text: id });
const platzieren = (knoten: K[], pos: Record<string, P>): PlatzKnoten[] => knoten.map((n) => ({ ...n, ...pos[n.id] }));
const box = (n: PlatzKnoten) => ({ x: n.x, y: n.y, ...GROESSE[n.typ] });
const beruehren = (a: PlatzKnoten, b: PlatzKnoten, rand = 0) => {
  const p = box(a), q = box(b);
  return p.x < q.x + q.w + rand && p.x + p.w + rand > q.x && p.y < q.y + q.h + rand && p.y + p.h + rand > q.y;
};

/** Ganze Kette wie in der App: anordnen → verlegen → befunde. */
async function durchlauf(knoten: K[], kanten: Kante[], fest: Record<string, P> = {}) {
  const pos = await anordnen(knoten, kanten, fest);
  const platz = platzieren(knoten, pos);
  const routen = verlegen(platz, kanten);
  return { pos, platz, routen, b: befunde(platz, kanten, routen) };
}

function pruefeSauber(knoten: K[], kanten: Kante[], r: Awaited<ReturnType<typeof durchlauf>>) {
  expect(r.b).toEqual([]);
  expect(Object.keys(r.pos).sort()).toEqual(knoten.map((n) => n.id).sort());
  // jeder Pfeil hat einen Weg, nur rechtwinklig
  expect(r.routen.size).toBe(kanten.length);
  for (const k of kanten) {
    const route = r.routen.get(kantenId(k));
    expect(route, kantenId(k)).toBeDefined();
    expect(route!.punkte.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < route!.punkte.length; i++) {
      const a = route!.punkte[i - 1], b = route!.punkte[i];
      expect(a.x === b.x || a.y === b.y, `schräges Stück bei ${kantenId(k)}`).toBe(true);
    }
    if (k.bedingung) expect(route!.label?.text, `Beschriftung ${kantenId(k)}`).toBe(k.bedingung);
  }
  // kein Knoten überdeckt einen anderen
  for (let i = 0; i < r.platz.length; i++) for (let j = i + 1; j < r.platz.length; j++) {
    expect(beruehren(r.platz[i], r.platz[j]), `${r.platz[i].id} / ${r.platz[j].id}`).toBe(false);
  }
}

describe("Fließbild: anordnen + verlegen + befunde liefern keine Befunde", () => {
  it("gerade Kette", async () => {
    const knoten = [kn("a", "start"), kn("b"), kn("c", "nutzer"), kn("d", "speicher"), kn("e", "ende")];
    const kanten: Kante[] = [{ von: "a", nach: "b" }, { von: "b", nach: "c" }, { von: "c", nach: "d" }, { von: "d", nach: "e" }];
    pruefeSauber(knoten, kanten, await durchlauf(knoten, kanten));
  });

  it("Entscheidung mit ja/nein und Rückweg", async () => {
    const knoten = [kn("start", "start"), kn("frage", "entscheidung"), kn("a"), kn("b"), kn("ende", "ende")];
    const kanten: Kante[] = [
      { von: "start", nach: "frage" },
      { von: "frage", nach: "a", bedingung: "ja" },
      { von: "frage", nach: "b", bedingung: "nein" },
      { von: "a", nach: "ende" },
      { von: "b", nach: "frage" }, // Rückweg
    ];
    pruefeSauber(knoten, kanten, await durchlauf(knoten, kanten));
  });

  it("Knoten mit 4 Ausgängen", async () => {
    const knoten = [kn("start", "start"), kn("hub", "entscheidung"), kn("a"), kn("b"), kn("c"), kn("d"), kn("ende", "ende")];
    const kanten: Kante[] = [
      { von: "start", nach: "hub" },
      { von: "hub", nach: "a", bedingung: "eins" },
      { von: "hub", nach: "b", bedingung: "zwei" },
      { von: "hub", nach: "c", bedingung: "drei" },
      { von: "hub", nach: "d", bedingung: "vier" },
      { von: "a", nach: "ende" }, { von: "b", nach: "ende" }, { von: "c", nach: "ende" }, { von: "d", nach: "ende" },
    ];
    pruefeSauber(knoten, kanten, await durchlauf(knoten, kanten));
  });

  it("großer Ablauf mit 35 Knoten und mehreren Entscheidungen", async () => {
    const knoten: K[] = Array.from({ length: 35 }, (_, i) =>
      kn(`n${i}`, i === 0 ? "start" : i === 34 ? "ende" : i % 5 === 0 ? "entscheidung" : "schritt"));
    const kanten: Kante[] = [];
    for (let i = 0; i < 34; i++) {
      if (i > 0 && i % 5 === 0 && i + 2 <= 34) {
        kanten.push({ von: `n${i}`, nach: `n${i + 1}`, bedingung: "ja" }, { von: `n${i}`, nach: `n${i + 2}`, bedingung: "nein" });
      } else kanten.push({ von: `n${i}`, nach: `n${i + 1}` });
    }
    pruefeSauber(knoten, kanten, await durchlauf(knoten, kanten));
  }, 60_000);
});

describe("Fließbild: feste Knoten (U44)", () => {
  const knoten = [kn("a", "start"), kn("b"), kn("c"), kn("d", "ende")];
  const kanten: Kante[] = [{ von: "a", nach: "b" }, { von: "b", nach: "c" }, { von: "c", nach: "d" }];

  it("ein fester Knoten behält exakt seinen Platz, auch genau dort, wo sonst ein anderer stünde", async () => {
    const frei = await anordnen(knoten, kanten);
    const fest = { b: { ...frei.c } }; // b sitzt jetzt auf dem Platz von c → c muss ausweichen
    const pos = await anordnen(knoten, kanten, fest);
    expect(pos.b).toEqual(frei.c);
    const platz = platzieren(knoten, pos);
    const b = platz.find((n) => n.id === "b")!;
    for (const n of platz) if (n.id !== "b") expect(beruehren(b, n), `${n.id} überdeckt b`).toBe(false);
  });

  it("mehrere feste Knoten weit weg vom Rest bleiben exakt stehen; freie überdecken sie nicht", async () => {
    const fest = { a: { x: -400, y: 0 }, d: { x: 600, y: 900 } };
    const pos = await anordnen(knoten, kanten, fest);
    expect(pos.a).toEqual(fest.a);
    expect(pos.d).toEqual(fest.d);
    const platz = platzieren(knoten, pos);
    for (const f of ["a", "d"]) {
      const fn = platz.find((n) => n.id === f)!;
      for (const n of platz) if (n.id !== f) expect(beruehren(fn, n), `${n.id} überdeckt ${f}`).toBe(false);
    }
    expect(Object.keys(pos).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("feste Knoten, die es nicht (mehr) gibt, werden ignoriert", async () => {
    const pos = await anordnen(knoten, kanten, { gibtsNicht: { x: 5, y: 5 } });
    expect(Object.keys(pos).sort()).toEqual(["a", "b", "c", "d"]);
  });
});

describe("Fließbild: befunde() erkennt Fehler (handgebaute Routen)", () => {
  const A: PlatzKnoten = { id: "a", typ: "schritt", text: "A", x: 0, y: 0 };

  it("Knoten, die sich überdecken", () => {
    const B: PlatzKnoten = { id: "b", typ: "schritt", text: "B", x: 50, y: 10 };
    const b = befunde([A, B], [], new Map());
    expect(b.some((t) => t.includes("überdecken sich"))).toBe(true);
  });

  it("Knoten mit zu wenig Abstand (unter 8 px) zählen auch", () => {
    const B: PlatzKnoten = { id: "b", typ: "schritt", text: "B", x: 0, y: 52 + 4 };
    expect(befunde([A, B], [], new Map()).some((t) => t.includes("überdecken sich"))).toBe(true);
  });

  it("sauber platzierte Knoten ohne Pfeile: keine Befunde", () => {
    const B: PlatzKnoten = { id: "b", typ: "schritt", text: "B", x: 0, y: 200 };
    expect(befunde([A, B], [], new Map())).toEqual([]);
  });

  it("Pfeil durch einen fremden Knoten", () => {
    const B: PlatzKnoten = { id: "b", typ: "schritt", text: "B", x: 0, y: 400 };
    const C: PlatzKnoten = { id: "c", typ: "schritt", text: "C", x: 0, y: 200 };
    const kanten: Kante[] = [{ von: "a", nach: "b" }];
    const routen = new Map<string, Route>([[kantenId(kanten[0]), { punkte: [{ x: 100, y: 52 }, { x: 100, y: 400 }] }]]);
    const b = befunde([A, B, C], kanten, routen);
    expect(b.some((t) => t.includes("läuft durch") && t.includes("„C“"))).toBe(true);
  });

  it("Pfeil, der um den fremden Knoten herumläuft: kein Befund", () => {
    const B: PlatzKnoten = { id: "b", typ: "schritt", text: "B", x: 0, y: 400 };
    const C: PlatzKnoten = { id: "c", typ: "schritt", text: "C", x: 0, y: 200 };
    const kanten: Kante[] = [{ von: "a", nach: "b" }];
    const routen = new Map<string, Route>([[kantenId(kanten[0]), {
      punkte: [{ x: 100, y: 52 }, { x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 380 }, { x: 100, y: 380 }, { x: 100, y: 400 }],
    }]]);
    expect(befunde([A, B, C], kanten, routen)).toEqual([]);
  });

  it("Pfeil ohne Weg", () => {
    const B: PlatzKnoten = { id: "b", typ: "schritt", text: "B", x: 0, y: 200 };
    const b = befunde([A, B], [{ von: "a", nach: "b" }], new Map());
    expect(b.some((t) => t.includes("findet keinen freien Weg"))).toBe(true);
  });

  it("Beschriftung ohne freien Platz", () => {
    const B: PlatzKnoten = { id: "b", typ: "schritt", text: "B", x: 0, y: 200 };
    const kanten: Kante[] = [{ von: "a", nach: "b", bedingung: "ja" }];
    const routen = new Map<string, Route>([[kantenId(kanten[0]), { punkte: [{ x: 100, y: 52 }, { x: 100, y: 200 }] }]]);
    expect(befunde([A, B], kanten, routen).some((t) => t.includes("findet keinen freien Platz"))).toBe(true);
  });

  it("zwei Pfeile mit verschiedenen Zielen liegen aufeinander", () => {
    const B: PlatzKnoten = { id: "b", typ: "schritt", text: "B", x: 0, y: 500 };
    const C: PlatzKnoten = { id: "c", typ: "schritt", text: "C", x: 0, y: 1000 };
    const kanten: Kante[] = [{ von: "a", nach: "b" }, { von: "a", nach: "c" }];
    const routen = new Map<string, Route>([
      [kantenId(kanten[0]), { punkte: [{ x: 100, y: 52 }, { x: 100, y: 500 }] }],
      [kantenId(kanten[1]), { punkte: [{ x: 100, y: 52 }, { x: 100, y: 300 }] }],
    ]);
    const b = befunde([A, B, C], kanten, routen);
    expect(b.some((t) => t.includes("liegen aufeinander"))).toBe(true);
  });

  it("zwei Pfeile zum selben Ziel dürfen zusammenlaufen", () => {
    const B: PlatzKnoten = { id: "b", typ: "schritt", text: "B", x: 300, y: 0 };
    const C: PlatzKnoten = { id: "c", typ: "schritt", text: "C", x: 150, y: 400 };
    const kanten: Kante[] = [{ von: "a", nach: "c" }, { von: "b", nach: "c" }];
    const routen = new Map<string, Route>([
      [kantenId(kanten[0]), { punkte: [{ x: 100, y: 52 }, { x: 100, y: 200 }, { x: 250, y: 200 }, { x: 250, y: 400 }] }],
      [kantenId(kanten[1]), { punkte: [{ x: 400, y: 52 }, { x: 400, y: 200 }, { x: 250, y: 200 }, { x: 250, y: 400 }] }],
    ]);
    expect(befunde([A, B, C], kanten, routen)).toEqual([]);
  });

  it("Beschriftung, die einen Knoten überdeckt", () => {
    const B: PlatzKnoten = { id: "b", typ: "schritt", text: "B", x: 0, y: 200 };
    const kanten: Kante[] = [{ von: "a", nach: "b", bedingung: "ja" }];
    const routen = new Map<string, Route>([[kantenId(kanten[0]), {
      punkte: [{ x: 100, y: 52 }, { x: 100, y: 200 }],
      label: { x: 50, y: 10, w: 40, h: 18, text: "ja" }, // liegt auf A
    }]]);
    expect(befunde([A, B], kanten, routen).some((t) => t.includes("überdeckt"))).toBe(true);
  });
});
