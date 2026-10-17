// Sprache der Oberfläche (U57, U58): startet auf Englisch, der Nutzer kann umstellen.
// Bewusst nicht gespeichert — nach einem Neustart wieder Englisch (U59 gestrichen).
// Texte stehen paarweise im Code: t("Deutsch", "English") — so kann keiner fehlen.
import { useSyncExternalStore } from "react";

export type Sprache = "en" | "de";
export const SPRACHEN: { id: Sprache; name: string }[] = [{ id: "en", name: "English" }, { id: "de", name: "Deutsch" }];

let sprache: Sprache = "en";
const hoerer = new Set<() => void>();

export function spracheSetzen(s: Sprache) {
  if (s === sprache) return;
  sprache = s;
  document.documentElement.lang = s;
  for (const h of hoerer) h();
}

export const aktuelleSprache = () => sprache;
/** Text in der aktuellen Sprache (außerhalb von React, z. B. in Bestätigungsfragen). */
export const tx = (de: string, en: string) => (sprache === "de" ? de : en);

/** Hook: Komponente zeichnet neu, wenn die Sprache wechselt. Liefert t(de, en). */
export function useT() {
  const s = useSyncExternalStore((h) => { hoerer.add(h); return () => hoerer.delete(h); }, () => sprache);
  return (de: string, en: string) => (s === "de" ? de : en);
}
export function useSprache(): Sprache {
  return useSyncExternalStore((h) => { hoerer.add(h); return () => hoerer.delete(h); }, () => sprache);
}
