// Fließbild-Anordnung (U40, U41, U44):
// 1. anordnen  — ELK „layered“ von oben nach unten; von Hand gesetzte Knoten (fest) bleiben, die übrigen weichen ihnen aus.
// 2. verlegen  — jeder Pfeil läuft rechtwinklig um alle Knoten herum (Wegsuche auf einem Raster), Beschriftung frei daneben.
// 3. befunde   — prüft das Ergebnis: überdeckt irgendetwas etwas anderes? Leer = sauber.
import ElkModul from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk-api.js";
import type { Kante, KnotenTyp } from "../src/schema.ts";

export const GROESSE: Record<KnotenTyp, { w: number; h: number }> = {
  start: { w: 180, h: 44 }, ende: { w: 180, h: 44 },
  schritt: { w: 200, h: 52 }, nutzer: { w: 200, h: 52 }, speicher: { w: 190, h: 56 },
  entscheidung: { w: 180, h: 80 },
};

export const kantenId = (k: Kante) => `${k.von}→${k.nach}→${k.bedingung ?? ""}`;

type Punkt = { x: number; y: number };
type Box = { x: number; y: number; w: number; h: number };
export type PlatzKnoten = { id: string; typ: KnotenTyp; text?: string; x: number; y: number };
export type Route = { punkte: Punkt[]; label?: Box & { text: string } };
/** zuGross: Fläche zu groß für die Wegsuche — alle Pfeile nur als gerade Notlinien. */
export type Routen = Map<string, Route> & { zuGross?: boolean };

// Im Browser (Vite) ist der Import die Klasse, in Node (Tests) steckt sie unter .default.
const ELK = ((ElkModul as unknown as { default?: unknown }).default ?? ElkModul) as new () => { layout: (graph: ElkNode) => Promise<ElkNode> };
const elk = new ELK();
const ABSTAND = 60; // Mindestabstand zwischen Knoten — Platz für einen Pfeil dazwischen
const ueberlappt = (a: Box, b: Box, rand = 0) =>
  a.x < b.x + b.w + rand && a.x + a.w + rand > b.x && a.y < b.y + b.h + rand && a.y + a.h + rand > b.y;
const box = (k: { typ: KnotenTyp; x: number; y: number }): Box => ({ x: k.x, y: k.y, ...GROESSE[k.typ] });
const raster = (n: number) => Math.round(n / 10) * 10;

/** Positionen für alle Knoten. fest = von Hand gesetzte Plätze, die bleiben (U44). */
export async function anordnen(knoten: { id: string; typ: KnotenTyp }[], kanten: Kante[], fest: Record<string, Punkt> = {}) {
  const ids = new Set(knoten.map((k) => k.id));
  const g = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.spacing.nodeNode": "60",
      "elk.layered.spacing.nodeNodeBetweenLayers": "70",
      // Reihenfolge, in der Claude die Knoten nennt = Ablaufrichtung; Pfeile zurück gelten als Rückwege.
      "elk.layered.cycleBreaking.strategy": "MODEL_ORDER",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
    },
    children: knoten.map((k) => ({ id: k.id, width: GROESSE[k.typ].w, height: GROESSE[k.typ].h })),
    edges: kanten.filter((k) => ids.has(k.von) && ids.has(k.nach) && k.von !== k.nach)
      .map((k, i) => ({ id: `e${i}`, sources: [k.von], targets: [k.nach] })),
  });
  // Mittelpunkte aufs Raster — dann docken Pfeile genau in der Mitte an, ohne Mini-Knick.
  const pos: Record<string, Punkt> = {};
  for (const c of g.children ?? []) {
    const w = c.width ?? 0, h = c.height ?? 0;
    pos[c.id] = { x: raster((c.x ?? 0) + w / 2) - w / 2, y: raster((c.y ?? 0) + h / 2) - h / 2 };
  }
  const typ = new Map(knoten.map((k) => [k.id, k.typ]));

  // Gerade Ketten (A → B → C, ohne Abzweig) stehen mittig untereinander — ausgerichtet am Knoten der Kette,
  // an dem am meisten weitere Pfeile hängen. So bleibt eine Verzweigung über ihren Zweigen zentriert.
  const vorw = kanten.filter((k) => pos[k.von] && pos[k.nach] && k.von !== k.nach && pos[k.nach].y > pos[k.von].y);
  const raus = (id: string) => vorw.filter((k) => k.von === id), rein = (id: string) => vorw.filter((k) => k.nach === id);
  const grad = (id: string) => kanten.filter((k) => k.von === id || k.nach === id).length;
  const weiter = (id: string) => { const r = raus(id); return r.length === 1 && rein(r[0].nach).length === 1 ? r[0].nach : null; };
  const mitte = (id: string) => pos[id].x + GROESSE[typ.get(id)!].w / 2;
  const inKette = new Set<string>();
  for (const k of knoten) {
    const vor = rein(k.id);
    if (inKette.has(k.id) || (vor.length === 1 && weiter(vor[0].von) === k.id)) continue; // nicht Anfang einer Kette
    const kette = [k.id];
    for (let n = weiter(k.id); n && !inKette.has(n) && !kette.includes(n); n = weiter(n)) kette.push(n);
    kette.forEach((id) => inKette.add(id));
    if (kette.length < 2) continue;
    // Anker: wo sich der Ablauf verzweigt, sonst wo die meisten Pfeile hängen. Passt die Kette dort nicht hin, bleibt sie.
    const kandidaten = [...kette].sort((a, b) => raus(b).length - raus(a).length || grad(b) - grad(a));
    for (const anker of kandidaten) {
      const ziel = new Map(kette.map((id) => [id, mitte(anker) - GROESSE[typ.get(id)!].w / 2]));
      const passt = kette.every((id) => {
        const b = { x: ziel.get(id)!, y: pos[id].y, ...GROESSE[typ.get(id)!] };
        return !Object.keys(pos).some((o) => !kette.includes(o) && ueberlappt(b, box({ typ: typ.get(o)!, ...pos[o] }), ABSTAND));
      });
      if (passt) { for (const id of kette) pos[id].x = ziel.get(id)!; break; }
    }
  }

  // Feste Knoten an ihren Platz; die übrigen in Ablauf-Reihenfolge so verschieben, dass nichts überdeckt wird.
  const gesetzt: Box[] = [];
  for (const k of knoten) if (fest[k.id]) { pos[k.id] = { ...fest[k.id] }; gesetzt.push(box({ typ: k.typ, ...pos[k.id] })); }
  const frei = knoten.filter((k) => !fest[k.id]).sort((a, b) => pos[a.id].y - pos[b.id].y || pos[a.id].x - pos[b.id].x);
  for (const k of frei) {
    const b = box({ typ: typ.get(k.id)!, ...pos[k.id] });
    for (let i = 0; i < 200; i++) {
      const stoss = gesetzt.find((o) => ueberlappt(b, o, ABSTAND));
      if (!stoss) break;
      b.x = Math.ceil((stoss.x + stoss.w + ABSTAND + b.w / 2) / 10) * 10 - b.w / 2; // Mitte bleibt auf dem Raster
    }
    pos[k.id] = { x: b.x, y: b.y };
    gesetzt.push(b);
  }
  return pos;
}

// ---------- Pfeile verlegen ----------

const S = 10;            // Rasterweite in px
const RAND = 14;         // so weit bleiben Pfeile von fremden Knoten weg
const KNICK = 10;        // Kosten je Knick — wenige Knicke = ruhiges Bild
const DECKUNG = 40;      // Kosten, wenn ein Pfeil auf einem anderen liegt
const KREUZUNG = 4;
const MAX_ZELLEN = 400_000; // Rasterpunkte; darüber würde die Wegsuche zu viel Speicher und Zeit brauchen
type Seite = 0 | 1 | 2 | 3; // oben, rechts, unten, links
const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
const STRAFE_RAUS: Record<Seite, number> = { 0: 14, 1: 4, 2: 0, 3: 4 };
const STRAFE_REIN: Record<Seite, number> = { 0: 0, 1: 4, 2: 14, 3: 4 };

class Haufen {
  private a: [number, number][] = [];
  get leer() { return this.a.length === 0; }
  rein(f: number, s: number) {
    const a = this.a; a.push([f, s]);
    for (let i = a.length - 1; i > 0;) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  raus(): [number, number] {
    const a = this.a, top = a[0], last = a.pop()!;
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

/** Rechtwinklige Wege für alle Pfeile, die keinen fremden Knoten berühren. */
export function verlegen(knoten: PlatzKnoten[], kanten: Kante[]): Routen {
  const routen: Routen = new Map<string, Route>();
  const boxen = new Map(knoten.map((k) => [k.id, box(k)]));
  if (!knoten.length) return routen;
  // Ursprung aufs 10-px-Raster, damit die (gerasterten) Knotenmitten genau auf Rasterpunkten liegen.
  const ox = Math.floor(Math.min(...[...boxen.values()].map((b) => b.x)) / S) * S - 120;
  const oy = Math.floor(Math.min(...[...boxen.values()].map((b) => b.y)) / S) * S - 120;
  const breite = Math.ceil((Math.max(...[...boxen.values()].map((b) => b.x + b.w)) + 120 - ox) / S) + 1;
  const hoehe = Math.ceil((Math.max(...[...boxen.values()].map((b) => b.y + b.h)) + 120 - oy) / S) + 1;
  const n = breite * hoehe;
  if (n > MAX_ZELLEN) { routen.zuGross = true; return routen; } // riesige Fläche (Knoten weit weggezogen): lieber gerade Notlinien als Einfrieren
  const gesperrt = new Uint8Array(n);
  for (const b of boxen.values()) {
    for (let gy = Math.max(0, Math.floor((b.y - RAND - oy) / S)); gy <= Math.min(hoehe - 1, Math.ceil((b.y + b.h + RAND - oy) / S)); gy++) {
      for (let gx = Math.max(0, Math.floor((b.x - RAND - ox) / S)); gx <= Math.min(breite - 1, Math.ceil((b.x + b.w + RAND - ox) / S)); gx++) {
        const px = ox + gx * S, py = oy + gy * S;
        if (px > b.x - RAND && px < b.x + b.w + RAND && py > b.y - RAND && py < b.y + b.h + RAND) gesperrt[gy * breite + gx] = 1;
      }
    }
  }
  // Belegung: wer liegt schon wo (waagerecht / senkrecht), mit Ziel — Pfeile zum selben Ziel dürfen zusammenlaufen.
  const belegtH = new Map<number, Set<string>>(), belegtV = new Map<number, Set<string>>();
  // "knoten:seite" → wie viele Pfeile dort hinaus- bzw. hineingehen. Rein und raus an derselben Seite wäre verwirrend.
  const portBelegt = new Map<string, { raus: number; rein: number }>();
  const belegung = (id: string, s: Seite) => portBelegt.get(`${id}:${s}`) ?? { raus: 0, rein: 0 };

  // Andockpunkt am Knoten und erster freier Rasterpunkt davor. Oben und unten gibt es drei Andockstellen
  // (Mitte, links, rechts), damit mehrere Pfeile nicht aufeinanderliegen. Bei Rauten liegen die äußeren
  // auf den schrägen Kanten (Viertel der Breite, Viertel der Höhe) — so hat auch eine Entscheidung mit vier Ausgängen Platz.
  const raute = new Set(knoten.filter((k) => k.typ === "entscheidung").map((k) => k.id));
  const ports = (id: string, b: Box) => ([0, 1, 2, 3] as Seite[]).flatMap((s) =>
    (s % 2 === 0 ? [0, -1, 1] : [0]).map((o) => ({ s, o, ...port(b, s, o, raute.has(id)) }))).filter((p) => p.ok);
  const port = (b: Box, s: Seite, o: number, schraeg: boolean) => {
    const cx = b.x + b.w / 2 + o * b.w / 4, cy = b.y + b.h / 2;
    const gx = s === 1 ? Math.ceil((b.x + b.w + RAND - ox) / S) : s === 3 ? Math.floor((b.x - RAND - ox) / S) : Math.round((cx - ox) / S);
    const gy = s === 2 ? Math.ceil((b.y + b.h + RAND - oy) / S) : s === 0 ? Math.floor((b.y - RAND - oy) / S) : Math.round((cy - oy) / S);
    const px = ox + gx * S, py = oy + gy * S;
    // Raute: Randpunkt bei x liegt |x - Mitte| / (w/2) · h/2 von der Spitze entfernt.
    const einzug = schraeg && o ? Math.abs(px - (b.x + b.w / 2)) / (b.w / 2) * (b.h / 2) : 0;
    const an: Punkt = s === 0 ? { x: px, y: b.y + einzug } : s === 2 ? { x: px, y: b.y + b.h - einzug }
      : s === 1 ? { x: b.x + b.w, y: py } : { x: b.x, y: py };
    const ok = gx >= 0 && gy >= 0 && gx < breite && gy < hoehe && !gesperrt[gy * breite + gx];
    return { gx, gy, an, ok };
  };

  // Kurze Vorwärtspfeile zuerst, Rückwege zuletzt — die suchen sich dann ihren Weg außen herum.
  const liste = kanten.filter((k) => boxen.has(k.von) && boxen.has(k.nach) && k.von !== k.nach)
    .map((k) => {
      const a = boxen.get(k.von)!, b = boxen.get(k.nach)!;
      return { k, rueck: b.y + b.h / 2 < a.y + a.h / 2 - 5, d: Math.abs(a.x - b.x) + Math.abs(a.y - b.y) };
    })
    .sort((p, q) => Number(p.rueck) - Number(q.rueck) || p.d - q.d);

  const g = new Float64Array(n * 4), von = new Int32Array(n * 4);
  for (const { k } of liste) {
    const a = boxen.get(k.von)!, b = boxen.get(k.nach)!;
    const ziele = ports(k.nach, b), starts = ports(k.von, a);
    if (!ziele.length || !starts.length) continue;
    const h = (gx: number, gy: number) => Math.min(...ziele.map((z) => Math.abs(z.gx - gx) + Math.abs(z.gy - gy)));
    const zielAn = new Map<number, (typeof ziele)[number]>();
    for (const z of ziele) if (!zielAn.has(z.gy * breite + z.gx)) zielAn.set(z.gy * breite + z.gx, z);
    g.fill(Infinity); von.fill(-1);
    const q = new Haufen();
    for (const st of starts) {
      const zelle = st.gy * breite + st.gx, z = zelle * 4 + st.s;
      const b0 = belegung(k.von, st.s);
      const schon = [...(belegtH.get(zelle) ?? []), ...(belegtV.get(zelle) ?? [])].some((ziel) => ziel !== k.nach);
      const kosten = STRAFE_RAUS[st.s] + Math.abs(st.o) * 3 + b0.raus * (k.bedingung ? 60 : 8) + b0.rein * 50 + (schon ? DECKUNG : 0);
      if (kosten < g[z]) { g[z] = kosten; q.rein(kosten + h(st.gx, st.gy), z); }
    }
    let bestes = Infinity, ende = -1;
    while (!q.leer) {
      const [f, z] = q.raus();
      if (f >= bestes) break;
      const zelle = z >> 2, r = (z & 3) as Seite, gz = g[z];
      if (f - h(zelle % breite, Math.floor(zelle / breite)) > gz + 1e-9) continue; // veralteter Eintrag
      const ziel = zielAn.get(zelle);
      if (ziel) {
        const hinein = ((ziel.s + 2) % 4) as Seite; // Richtung in den Knoten hinein
        const gesamt = gz + (r === hinein ? 0 : KNICK) + STRAFE_REIN[ziel.s] + Math.abs(ziel.o) * 3 + belegung(k.nach, ziel.s).raus * 50;
        if (gesamt < bestes) { bestes = gesamt; ende = z; }
      }
      const x = zelle % breite, y = Math.floor(zelle / breite);
      for (let nr = 0 as Seite; nr < 4; nr = (nr + 1) as Seite) {
        if (nr === ((r + 2) % 4)) continue; // nicht umkehren
        const nx = x + DX[nr], ny = y + DY[nr];
        if (nx < 0 || ny < 0 || nx >= breite || ny >= hoehe) continue;
        const nz = ny * breite + nx;
        if (gesperrt[nz] && !zielAn.has(nz)) continue;
        const gleich = (nr % 2 === 0 ? belegtV : belegtH).get(nz), quer = (nr % 2 === 0 ? belegtH : belegtV).get(nz);
        let kosten = 1 + (nr === r ? 0 : KNICK);
        if (gleich && [...gleich].some((ziel) => ziel !== k.nach)) kosten += DECKUNG;
        if (quer) kosten += KREUZUNG;
        const neu = gz + kosten, nzs = nz * 4 + nr;
        if (neu < g[nzs]) { g[nzs] = neu; von[nzs] = z; q.rein(neu + h(nx, ny), nzs); }
      }
    }
    if (ende < 0) continue;

    // Weg zurückverfolgen, Rasterpunkte merken.
    const zellen: number[] = [];
    for (let z = ende; z >= 0; z = von[z]) zellen.push(z);
    zellen.reverse();
    const erste = zellen[0] >> 2, letzte = zellen.at(-1)! >> 2;
    const st = starts.find((s) => s.gy * breite + s.gx === erste && s.s === (zellen[0] & 3))!;
    const zi = zielAn.get(letzte)!;
    const bv = belegung(k.von, st.s), bn = belegung(k.nach, zi.s);
    portBelegt.set(`${k.von}:${st.s}`, { ...bv, raus: bv.raus + 1 });
    portBelegt.set(`${k.nach}:${zi.s}`, { ...bn, rein: bn.rein + 1 });
    for (let i = 0; i < zellen.length; i++) {
      const zelle = zellen[i] >> 2, r = zellen[i] & 3;
      const karte = r % 2 === 0 ? belegtV : belegtH;
      if (!karte.has(zelle)) karte.set(zelle, new Set());
      karte.get(zelle)!.add(k.nach);
    }
    const roh: Punkt[] = [st.an, ...zellen.map((z) => ({ x: ox + ((z >> 2) % breite) * S, y: oy + Math.floor((z >> 2) / breite) * S })), zi.an];
    routen.set(kantenId(k), { punkte: vereinfachen(roh) });
  }

  // Beschriftungen (ja / nein …) nah am Anfang des Pfeils, wo sie weder Knoten noch andere Beschriftungen berühren.
  const knotenBoxen = [...boxen.values()];
  const labels: Box[] = [];
  for (const { k } of liste) {
    const r = routen.get(kantenId(k));
    if (!r || !k.bedingung) continue;
    const w = k.bedingung.length * 7 + 12, hh = 18;
    const laenge = r.punkte.slice(1).reduce((s, p, i) => s + Math.abs(p.x - r.punkte[i].x) + Math.abs(p.y - r.punkte[i].y), 0);
    // Erst mittig auf dem Pfeil, sonst daneben; jeweils vom Anfang des Pfeils her die erste freie Stelle.
    // Knoten samt Marken („neu“ unten rechts, Zähler oben) — auch die darf eine Beschriftung nicht verdecken.
    const frei = (l: Box, strenge: boolean) => !knotenBoxen.some((b) => ueberlappt(l, { x: b.x - 10, y: b.y - 10, w: b.w + 20, h: b.h + 22 }, 3)) && !labels.some((o) => ueberlappt(l, o, 3)) &&
      (!strenge || ![...routen].some(([id, o]) => id !== kantenId(k) && strecken(o.punkte).some((st) => ueberlappt(l, st, 2))));
    // Notfalls (sehr enge Abläufe) über einer fremden Linie — befunde() meldet das dann.
    suche: for (const [versatz, strenge] of [[0, true], [1, true], [-1, true], [0, false]] as const) {
      for (let d = 16; d < laenge - 8; d += 4) {
        const p = punktBei(r.punkte, d), senkrecht = richtungBei(r.punkte, d) === "v";
        const dx = senkrecht ? versatz * (w / 2 + 4) : 0, dy = senkrecht ? 0 : versatz * (hh / 2 + 4);
        const l = { x: p.x - w / 2 + dx, y: p.y - hh / 2 + dy, w, h: hh };
        if (!frei(l, strenge)) continue;
        r.label = { ...l, text: k.bedingung };
        labels.push(l);
        break suche;
      }
    }
    // Gar kein Platz: trotzdem mittig zeigen (befunde() meldet die Überdeckung) — eine fehlende Beschriftung wäre schlimmer.
    if (!r.label) {
      const p = punktBei(r.punkte, laenge / 2);
      r.label = { x: p.x - w / 2, y: p.y - hh / 2, w, h: hh, text: k.bedingung };
      labels.push(r.label);
    }
  }
  return routen;
}

/** Teilstrecken eines Wegs als (flache) Kästen. */
const strecken = (p: Punkt[]): Box[] => p.slice(1).map((q, i) => ({
  x: Math.min(p[i].x, q.x), y: Math.min(p[i].y, q.y), w: Math.abs(q.x - p[i].x), h: Math.abs(q.y - p[i].y),
}));

/** Nur Eckpunkte behalten. */
function vereinfachen(p: Punkt[]): Punkt[] {
  const r: Punkt[] = [];
  for (const q of p) {
    const a = r.at(-2), b = r.at(-1);
    if (b && b.x === q.x && b.y === q.y) continue;
    if (a && b && ((a.x === b.x && b.x === q.x) || (a.y === b.y && b.y === q.y))) r[r.length - 1] = q;
    else r.push(q);
  }
  return r;
}

function richtungBei(p: Punkt[], d: number): "h" | "v" {
  for (let i = 1; i < p.length; i++) {
    const l = Math.abs(p[i].x - p[i - 1].x) + Math.abs(p[i].y - p[i - 1].y);
    if (d <= l) return p[i].x === p[i - 1].x ? "v" : "h";
    d -= l;
  }
  return "v";
}

function punktBei(p: Punkt[], d: number): Punkt {
  for (let i = 1; i < p.length; i++) {
    const l = Math.abs(p[i].x - p[i - 1].x) + Math.abs(p[i].y - p[i - 1].y);
    if (d <= l) { const t = l ? d / l : 0; return { x: p[i - 1].x + (p[i].x - p[i - 1].x) * t, y: p[i - 1].y + (p[i].y - p[i - 1].y) * t }; }
    d -= l;
  }
  return p.at(-1)!;
}

/** SVG-Pfad mit leicht abgerundeten Ecken. */
export function pfad(p: Punkt[], radius = 8): string {
  if (p.length < 2) return "";
  let d = `M${p[0].x},${p[0].y}`;
  for (let i = 1; i < p.length - 1; i++) {
    const a = p[i - 1], b = p[i], c = p[i + 1];
    const r = Math.min(radius, (Math.abs(b.x - a.x) + Math.abs(b.y - a.y)) / 2, (Math.abs(c.x - b.x) + Math.abs(c.y - b.y)) / 2);
    const e1 = { x: b.x - Math.sign(b.x - a.x) * r, y: b.y - Math.sign(b.y - a.y) * r };
    const e2 = { x: b.x + Math.sign(c.x - b.x) * r, y: b.y + Math.sign(c.y - b.y) * r };
    d += ` L${e1.x},${e1.y} Q${b.x},${b.y} ${e2.x},${e2.y}`;
  }
  const z = p.at(-1)!;
  return d + ` L${z.x},${z.y}`;
}

// ---------- Prüfen ----------

/** Was im Bild etwas anderes überdeckt (U40). Leer = sauber. */
export function befunde(knoten: PlatzKnoten[], kanten: Kante[], routen: Routen): string[] {
  const name = (id: string) => `„${knoten.find((k) => k.id === id)?.text ?? id}“`;
  const aus: string[] = [];
  if (routen.zuGross) aus.push("Fläche zu groß (Knoten weit auseinandergezogen) — Pfeile nur als gerade Linien; „Aufräumen“ hilft");
  for (const k of kanten) if (k.von === k.nach) aus.push(`Pfeil von ${name(k.von)} auf sich selbst wird nicht gezeichnet`);
  const b = knoten.map((k) => ({ id: k.id, ...box(k) }));
  for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) {
    if (ueberlappt(b[i], b[j], 8)) aus.push(`Knoten ${name(b[i].id)} und ${name(b[j].id)} überdecken sich`);
  }
  const labels: { k: Kante; l: Box }[] = [];
  for (const k of kanten) {
    if (!knoten.some((x) => x.id === k.von) || !knoten.some((x) => x.id === k.nach) || k.von === k.nach) continue;
    const r = routen.get(kantenId(k));
    if (!r) { if (!routen.zuGross) aus.push(`Pfeil ${name(k.von)} → ${name(k.nach)} findet keinen freien Weg`); continue; }
    for (let i = 1; i < r.punkte.length; i++) {
      const p = r.punkte[i - 1], q = r.punkte[i];
      const s = { x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), w: Math.abs(q.x - p.x), h: Math.abs(q.y - p.y) };
      for (const o of b) {
        if (o.id === k.von || o.id === k.nach) continue;
        if (ueberlappt(s, { x: o.x + 1, y: o.y + 1, w: o.w - 2, h: o.h - 2 })) {
          aus.push(`Pfeil ${name(k.von)} → ${name(k.nach)} läuft durch ${name(o.id)}`);
          break;
        }
      }
    }
    // Zwei Pfeile auf derselben Linie (außer sie laufen zum selben Ziel zusammen) sind nicht auseinanderzuhalten.
    for (const [andereId, o] of routen) {
      const ok = kanten.find((x) => kantenId(x) === andereId);
      if (!ok || andereId === kantenId(k) || ok.nach === k.nach || kantenId(ok) < kantenId(k)) continue;
      if (deckenSich(r.punkte, o.punkte)) aus.push(`Pfeile ${name(k.von)} → ${name(k.nach)} und ${name(ok.von)} → ${name(ok.nach)} liegen aufeinander`);
    }
    if (k.bedingung && !r.label) aus.push(`Beschriftung „${k.bedingung}“ an ${name(k.von)} findet keinen freien Platz`);
    if (r.label) {
      for (const o of b) if (ueberlappt(r.label, o)) aus.push(`Beschriftung „${k.bedingung}“ überdeckt ${name(o.id)}`);
      for (const [id, o] of routen) {
        const ok = kanten.find((x) => kantenId(x) === id);
        if (ok && id !== kantenId(k) && strecken(o.punkte).some((st) => ueberlappt(r.label!, st))) {
          aus.push(`Beschriftung „${k.bedingung}“ liegt auf dem Pfeil ${name(ok.von)} → ${name(ok.nach)}`);
        }
      }
      for (const o of labels) if (ueberlappt(r.label, o.l)) aus.push(`Beschriftungen „${k.bedingung}“ und „${o.k.bedingung}“ überdecken sich`);
      labels.push({ k, l: r.label });
    }
  }
  return [...new Set(aus)];
}

/** Liegen zwei Wege ein Stück weit auf derselben Linie? */
function deckenSich(a: Punkt[], b: Punkt[]): boolean {
  for (let i = 1; i < a.length; i++) for (let j = 1; j < b.length; j++) {
    const p = a[i - 1], q = a[i], u = b[j - 1], v = b[j];
    if (p.x === q.x && u.x === v.x && p.x === u.x) {
      if (Math.min(Math.max(p.y, q.y), Math.max(u.y, v.y)) - Math.max(Math.min(p.y, q.y), Math.min(u.y, v.y)) > 2) return true;
    } else if (p.y === q.y && u.y === v.y && p.y === u.y) {
      if (Math.min(Math.max(p.x, q.x), Math.max(u.x, v.x)) - Math.max(Math.min(p.x, q.x), Math.min(u.x, v.x)) > 2) return true;
    }
  }
  return false;
}

/** Pfeile ohne gefundenen Weg als gerade Notlinie Mitte → Mitte — gleich auf Bildschirm und im Bild. */
export function mitNotlinien(knoten: PlatzKnoten[], kanten: Kante[], routen: Map<string, Route>): Map<string, Route> {
  const aus = new Map(routen);
  const mitte = (id: string) => { const k = knoten.find((x) => x.id === id); return k && { x: k.x + GROESSE[k.typ].w / 2, y: k.y + GROESSE[k.typ].h / 2 }; };
  for (const k of kanten) {
    const a = mitte(k.von), b = mitte(k.nach);
    if (!a || !b || k.von === k.nach || aus.has(kantenId(k))) continue;
    const label = k.bedingung ? { x: (a.x + b.x) / 2 - (k.bedingung.length * 7 + 12) / 2, y: (a.y + b.y) / 2 - 9, w: k.bedingung.length * 7 + 12, h: 18, text: k.bedingung } : undefined;
    aus.set(kantenId(k), { punkte: [a, b], label });
  }
  return aus;
}
