// Das Fließbild als PNG für Claude (U38): aus denselben Formen (Form), Plätzen und Pfeilwegen gezeichnet,
// die auch auf dem Bildschirm stehen — inklusive Marke „neu“, offener Kommentare und ausgewähltem Knoten.
// Eigene SVG statt Bildschirmfoto: braucht keine Bildschirmfreigabe und zeigt nie etwas anderes als das Fließbild.
import { renderToStaticMarkup } from "react-dom/server";
import { tx } from "./sprache.ts";
import { Form } from "./Knoten.tsx";
import { GROESSE, pfad, type PlatzKnoten, type Route } from "./layout.ts";

export type BildKnoten = PlatzKnoten & { neu?: boolean; offen?: number; links?: boolean; gewaehlt?: boolean };

const SCHRIFT = 'system-ui,-apple-system,"Segoe UI",sans-serif';
const TINTE = "#132038";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Text wie auf dem Bildschirm umbrechen (13 px, 14 px Rand links und rechts; Rauten sind innen schmaler). */
function zeilen(text: string, breite: number): string[] {
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.font = `13px ${SCHRIFT}`;
  const aus: string[] = [];
  for (const wort of text.split(/\s+/).filter(Boolean)) {
    const probe = aus.length ? `${aus[aus.length - 1]} ${wort}` : wort;
    if (aus.length && ctx.measureText(probe).width <= breite) aus[aus.length - 1] = probe; else aus.push(wort);
  }
  return aus;
}

export function fliessbildSvg(knoten: BildKnoten[], routen: Map<string, Route>, ausgewaehlteKanten = new Set<string>()) {
  const xs: number[] = [], ys: number[] = [];
  for (const k of knoten) { xs.push(k.x - 12, k.x + GROESSE[k.typ].w + 12); ys.push(k.y - 12, k.y + GROESSE[k.typ].h + 12); }
  for (const r of routen.values()) {
    for (const p of r.punkte) { xs.push(p.x); ys.push(p.y); }
    if (r.label) { xs.push(r.label.x, r.label.x + r.label.w); ys.push(r.label.y, r.label.y + r.label.h); }
  }
  const rand = 24, x0 = Math.min(...xs) - rand, y0 = Math.min(...ys) - rand;
  const w = Math.ceil(Math.max(...xs) + rand - x0), h = Math.ceil(Math.max(...ys) + rand - y0);

  let teile = "";
  for (const [id, r] of routen) {
    const gewaehlt = ausgewaehlteKanten.has(id); // wie auf dem Bildschirm: ausgewählt = blau und dicker
    teile += `<path d="${pfad(r.punkte)}" fill="none" stroke="${gewaehlt ? "#1769e0" : TINTE}" stroke-width="${gewaehlt ? 2.4 : 1.6}" marker-end="url(#${gewaehlt ? "pfeil-blau" : "pfeil"})"/>`;
    if (r.label) {
      const l = r.label;
      teile += `<rect x="${l.x}" y="${l.y}" width="${l.w}" height="${l.h}" rx="4" fill="#fff" stroke="#c9d3e0"/>` +
        `<text x="${l.x + l.w / 2}" y="${l.y + l.h / 2}" text-anchor="middle" dominant-baseline="central" font-size="12" fill="${TINTE}">${esc(l.text)}</text>`;
    }
  }
  for (const k of knoten) {
    const g = GROESSE[k.typ];
    teile += `<g transform="translate(${k.x},${k.y})">${renderToStaticMarkup(<Form typ={k.typ} w={g.w} h={g.h} gewaehlt={!!k.gewaehlt} />)}`;
    const z = zeilen(k.text ?? "", k.typ === "entscheidung" ? g.w * 0.62 : g.w - 28);
    z.forEach((t, i) => {
      const y = g.h / 2 + (i - (z.length - 1) / 2) * 16.25;
      teile += `<text x="${g.w / 2}" y="${y}" text-anchor="middle" dominant-baseline="central" font-size="13" fill="${TINTE}">${esc(t)}</text>`;
    });
    if (k.offen) teile += `<circle cx="1" cy="1" r="10" fill="#e0b64a"/><text x="1" y="1" text-anchor="middle" dominant-baseline="central" font-size="11" font-weight="700" fill="${TINTE}">${k.offen}</text>`;
    if (k.links) teile += `<circle cx="${g.w - 1}" cy="1" r="10" fill="#1769e0"/><text x="${g.w - 1}" y="1" text-anchor="middle" dominant-baseline="central" font-size="10" font-weight="700" fill="#fff">◀</text>`;
    if (k.neu) teile += `<rect x="${g.w + 8 - 34}" y="${g.h + 10 - 18}" width="34" height="18" rx="5" fill="#e3f6ea" stroke="#9ad3ae"/>` +
      `<text x="${g.w + 8 - 17}" y="${g.h + 10 - 9}" text-anchor="middle" dominant-baseline="central" font-size="11" font-weight="800" fill="#145c2e">${esc(tx("neu", "new"))}</text>`;
    teile += "</g>";
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${x0} ${y0} ${w} ${h}" font-family='${SCHRIFT}'>` +
    `<defs><marker id="pfeil" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="12.5" markerHeight="12.5" markerUnits="userSpaceOnUse" orient="auto-start-reverse">` +
    `<path d="M0,0 L10,5 L0,10 z" fill="${TINTE}"/></marker>` +
    `<marker id="pfeil-blau" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="12.5" markerHeight="12.5" markerUnits="userSpaceOnUse" orient="auto-start-reverse">` +
    `<path d="M0,0 L10,5 L0,10 z" fill="#1769e0"/></marker></defs>` +
    `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="#fff"/>${teile}</svg>`;
  return { svg, w, h };
}

/**
 * SVG → PNG (data:-URLs). Etwas größer als auf dem Bildschirm, damit die Schrift lesbar bleibt.
 * Hohe Abläufe kommen als mehrere Bilder (Abschnitte von oben nach unten, leicht überlappend) —
 * ein einziges Bild würde so weit verkleinert, dass die Schrift nicht mehr zu lesen ist.
 */
export async function fliessbildPng(knoten: BildKnoten[], routen: Map<string, Route>, ausgewaehlteKanten?: Set<string>): Promise<string[]> {
  if (!knoten.length) throw new Error("Fließbild ist leer");
  const { svg, w, h } = fliessbildSvg(knoten, routen, ausgewaehlteKanten);
  const img = new Image();
  await new Promise<void>((ok, nein) => {
    img.onload = () => ok(); img.onerror = () => nein(new Error("Bild ließ sich nicht zeichnen"));
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });
  const ABSCHNITT = 1800, UEBERLAPPUNG = 150, MAX_ABSCHNITTE = 12; // so viele nimmt der Server an
  const massstab = Math.min(Math.max(0.6, Math.min(1.25, 1800 / w, 16000 / h)), (MAX_ABSCHNITTE * (ABSCHNITT - UEBERLAPPUNG)) / h);
  const W = Math.round(w * massstab), H = Math.round(h * massstab);
  const aus: string[] = [];
  for (let y = 0; y < H; y += ABSCHNITT - UEBERLAPPUNG) {
    const hoehe = Math.min(ABSCHNITT, H - y);
    const c = document.createElement("canvas");
    c.width = W; c.height = hoehe;
    c.getContext("2d")!.drawImage(img, 0, y / massstab, w, hoehe / massstab, 0, 0, W, hoehe);
    aus.push(c.toDataURL("image/png"));
    if (y + hoehe >= H) break;
  }
  return aus;
}
