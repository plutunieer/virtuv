// Ansicht der Werkbank: welche Spalten sichtbar sind und wie breit (U14, U15, U20–U23).
// Gilt für alle Fenster gemeinsam und bleibt nach einem Neustart erhalten (localStorage).
import { useSyncExternalStore } from "react";

export type Spaltenname = "leiste" | "term" | "seite";
export type Ansicht = { sichtbar: Record<Spaltenname, boolean>; breite: Record<Spaltenname, number> };

const SPEICHER = "urs-werkbank-ansicht";
export const STANDARD_BREITE: Record<Spaltenname, number> = { leiste: 250, term: 520, seite: 340 };
export const GRENZEN: Record<Spaltenname, [number, number]> = { leiste: [170, 420], term: [260, 1400], seite: [240, 640] };
const STANDARD: Ansicht = { sichtbar: { leiste: true, term: true, seite: true }, breite: { ...STANDARD_BREITE } };

function laden(): Ansicht {
  try {
    const g = JSON.parse(localStorage.getItem(SPEICHER) ?? "null") as Partial<Ansicht> | null;
    if (g) {
      const breite = { ...STANDARD.breite };
      for (const k of Object.keys(breite) as Spaltenname[]) {
        const w = Number(g.breite?.[k]);
        if (Number.isFinite(w)) breite[k] = Math.max(GRENZEN[k][0], Math.min(GRENZEN[k][1], w));
      }
      const sichtbar = { ...STANDARD.sichtbar };
      for (const k of Object.keys(sichtbar) as Spaltenname[]) if (typeof g.sichtbar?.[k] === "boolean") sichtbar[k] = g.sichtbar[k];
      return { sichtbar, breite };
    }
  } catch { /* privater Modus o. Ä. */ }
  return STANDARD;
}

let stand = laden();
const hoerer = new Set<() => void>();
// Ein anderes Fenster hat die Ansicht geändert → übernehmen.
addEventListener("storage", (e) => { if (e.key === SPEICHER) { stand = laden(); for (const h of hoerer) h(); } });

function setzen(neu: Ansicht) {
  stand = neu;
  try { localStorage.setItem(SPEICHER, JSON.stringify(neu)); } catch { /* egal */ }
  for (const h of hoerer) h();
}

export const umschalten = (s: Spaltenname) => setzen({ ...stand, sichtbar: { ...stand.sichtbar, [s]: !stand.sichtbar[s] } });
export const zeigen = (s: Spaltenname) => { if (!stand.sichtbar[s]) setzen({ ...stand, sichtbar: { ...stand.sichtbar, [s]: true } }); };
export const breiteSetzen =(s: Spaltenname, px: number) => {
  const [min, max] = GRENZEN[s];
  setzen({ ...stand, breite: { ...stand.breite, [s]: Math.round(Math.max(min, Math.min(max, px))) } });
};
export const breiteZuruecksetzen = (s: Spaltenname) => breiteSetzen(s, STANDARD_BREITE[s]);

export function useAnsicht(): Ansicht {
  return useSyncExternalStore((h) => { hoerer.add(h); return () => hoerer.delete(h); }, () => stand);
}
