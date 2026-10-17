// Reine Logik ohne Dateizugriff — genutzt vom Server und von der Oberfläche.
import type { Aenderungen, Arbeit, Kante, SmartPruefung, UrsInhalt } from "./schema.ts";

const kanteSchluessel = (k: Kante) => `${k.von}→${k.nach}→${k.bedingung ?? ""}`;

/** Was der Nutzer in seiner Arbeitskopie gegenüber Claudes Version geändert hat. */
export function aenderungen(inhalt: UrsInhalt, a: Arbeit): Aenderungen {
  const vk = new Map(inhalt.knoten.map((k) => [k.id, k]));
  const ak = new Map(a.knoten.map((k) => [k.id, k]));
  const vKanten = new Set(inhalt.kanten.map(kanteSchluessel));
  const aKanten = new Set(a.kanten.map(kanteSchluessel));
  return {
    neueKnoten: a.knoten.filter((k) => !vk.has(k.id)),
    geloeschteKnoten: inhalt.knoten.filter((k) => !ak.has(k.id)).map((k) => ({ id: k.id, text: k.text })),
    umbenannt: a.knoten.flatMap((k) => {
      const alt = vk.get(k.id);
      return alt && alt.text !== k.text ? [{ id: k.id, vorher: alt.text, nachher: k.text }] : [];
    }),
    neueKanten: a.kanten.filter((k) => !vKanten.has(kanteSchluessel(k))),
    geloeschteKanten: inhalt.kanten.filter((k) => !aKanten.has(kanteSchluessel(k))),
  };
}

export const anzahlAenderungen = (x: Aenderungen) =>
  x.neueKnoten.length + x.geloeschteKnoten.length + x.umbenannt.length + x.neueKanten.length + x.geloeschteKanten.length;

/** Anforderungen, die die SMART-Prüfung nicht bestanden haben oder nie geprüft wurden (U55). */
export const smartVerfehlt = (inhalt: UrsInhalt, smart: SmartPruefung | undefined) =>
  inhalt.anforderungen.filter((x) => !x.gestrichen && smart?.[x.id]?.ok !== true).map((x) => x.id);

/** Was die Freigabe noch blockiert. Alles 0 = Freigabe möglich. */
export function offen(inhalt: UrsInhalt, a: Arbeit, smart?: SmartPruefung) {
  return {
    kommentare: a.kommentare.filter((k) => !k.erledigt).length,
    fragen: inhalt.fragen.filter((f) => !a.antworten[f.id]?.trim()).length,
    aenderungen: anzahlAenderungen(aenderungen(inhalt, a)),
    smart: smartVerfehlt(inhalt, smart).length,
  };
}

/** Jede gültige Anforderung hängt an genau einem Knoten (U52). Liefert die Verstöße, leer = in Ordnung. */
export function zuordnungsFehler(inhalt: UrsInhalt): string[] {
  const wo = new Map<string, string[]>();
  for (const k of inhalt.knoten) for (const id of new Set(k.anforderungen)) wo.set(id, [...(wo.get(id) ?? []), k.id]);
  return inhalt.anforderungen.filter((x) => !x.gestrichen).flatMap((x) => {
    const k = wo.get(x.id) ?? [];
    return k.length === 0 ? [`${x.id} hängt an keinem Knoten`]
      : k.length > 1 ? [`${x.id} hängt an mehreren Knoten (${k.join(", ")}) — genau einer`] : [];
  });
}

/**
 * Was ist noch nicht freigegeben (Marke „neu“, U31)? Neu ist eine Anforderung, die in der zuletzt freigegebenen
 * Version fehlt, dort gestrichen war oder anders lautete; ein Knoten, der fehlte, anders hieß oder eine neue
 * Anforderung trägt. Gibt es noch keine Freigabe, ist alles neu. nichtsNeu: ältere Version oder schon freigegeben.
 * basis = null bei vorhandener Freigabe heißt „noch nicht geladen“ → (noch) nichts markieren statt alles.
 */
export function neuSeitFreigabe(inhalt: UrsInhalt | null, knoten: { id: string; text: string; anforderungen: string[] }[],
  nichtsNeu: boolean, freigegebeneNr: number | null, basis: UrsInhalt | null): { u: Set<string>; knoten: Set<string> } {
  const u = new Set<string>(), k = new Set<string>();
  if (!inhalt || nichtsNeu || (freigegebeneNr !== null && !basis)) return { u, knoten: k };
  const alteU = new Map((basis?.anforderungen ?? []).filter((a) => !a.gestrichen).map((a) => [a.id, a.text]));
  for (const a of inhalt.anforderungen) if (!a.gestrichen && alteU.get(a.id) !== a.text) u.add(a.id);
  const alteK = new Map((basis?.knoten ?? []).map((x) => [x.id, x.text]));
  for (const x of knoten) if (alteK.get(x.id) !== x.text || x.anforderungen.some((id) => u.has(id))) k.add(x.id);
  return { u, knoten: k };
}
