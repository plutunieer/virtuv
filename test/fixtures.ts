import type { SmartPruefung, UrsInhalt } from "../src/schema.ts";
import { submit } from "../src/store.ts";

/** Kleinstmögliche gültige URS als Ausgangspunkt für Tests. */
export function minimaleUrs(teil: Partial<UrsInhalt> = {}): UrsInhalt {
  return {
    name: "Testprojekt",
    zweck: "Kurzer Zweck",
    anforderungen: [{ id: "U1", text: "Kurzer Satz.", prio: "muss" }],
    knoten: [{ id: "k1", typ: "start", text: "Start", anforderungen: ["U1"] }],
    kanten: [],
    fragen: [],
    sicherheit: [],
    nichtEnthalten: [],
    ...teil,
  };
}

/** URS mit zwei Punkten (k1 Start → k2 Zweiter), z. B. für Chat-Tests. */
export function ursMitZweiPunkten(): UrsInhalt {
  return minimaleUrs({
    anforderungen: [
      { id: "U1", text: "Kurzer Satz.", prio: "muss" },
      { id: "U2", text: "Zweiter Satz.", prio: "muss" },
    ],
    knoten: [
      { id: "k1", typ: "start", text: "Start", anforderungen: ["U1"] },
      { id: "k2", typ: "schritt", text: "Zweiter", anforderungen: ["U2"] },
    ],
    kanten: [{ von: "k1", nach: "k2" }],
  });
}

/** SMART-Ergebnis „alles bestanden“ für alle gültigen Anforderungen (U50). */
export const smartOk = (inhalt: UrsInhalt): SmartPruefung =>
  Object.fromEntries(inhalt.anforderungen.filter((a) => !a.gestrichen).map((a) => [a.id, { ok: true, grund: "ok" }]));

/** submit mit bestandener SMART-Prüfung — für alles, was danach freigeben() ruft (U55). */
export const submitOk = (pfad: string, inhalt: UrsInhalt, stand?: string, erledigt: string[] = []) =>
  submit(pfad, inhalt, stand, erledigt, smartOk(inhalt));

/** Promise, das der Test selbst auflöst/ablehnt — hält eine „Claude-Antwort“ an, bis der Test es will. */
export function aufschiebbar<T>() {
  let ok!: (v: T) => void;
  let nein!: (e: Error) => void;
  const promise = new Promise<T>((a, b) => { ok = a; nein = b; });
  return { promise, ok, nein };
}

/** ids, die der SMART-Prüfer unter „Zu prüfen:“ bekommen hat (Aufbau der Aufgabe in src/smart.ts). */
export const gefragt = (aufgabe: string) =>
  aufgabe.split("Zu prüfen:\n")[1].split("\n</urs>")[0].split("\n").map((z) => z.split(":")[0]);
