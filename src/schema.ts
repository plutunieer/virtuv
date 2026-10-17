// Datenmodell der URS. Grundlage: _standards/URS-STIL.html (U-Nummern, ein Satz je Anforderung).
// Anforderungen: höchstens 12 Wörter (U48, geprüft in store.ts nur für neue Versionen — alte bleiben lesbar);
// SMART prüft ein unabhängiger Prüfer (smart.ts, U50).
import { z } from "zod";

export const woerter = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

export const MAX_WOERTER_KNOTEN = 4;
export const MAX_WOERTER_ANFORDERUNG = 12;

export const KnotenTyp = z.enum(["start", "ende", "schritt", "entscheidung", "speicher", "nutzer"]);
export type KnotenTyp = z.infer<typeof KnotenTyp>;

export const Anforderung = z.object({
  id: z.string().regex(/^U[1-9]\d*$/, "Nummer im Format U1, U2 …"),
  text: z.string().min(1)
    .refine((s) => !s.includes("\n"), "Ein Satz, keine Zeilenumbrüche"),
  prio: z.enum(["muss", "soll", "kann"]).default("muss"),
  // Status/Beleg gehören NICHT hierher: sie ändern sich nach der Freigabe und kommen in Phase 3 in eine eigene Datei.
  gestrichen: z.boolean().optional(),
});
export type Anforderung = z.infer<typeof Anforderung>;

const knotenText = z.string().min(1)
  .refine((s) => woerter(s) <= MAX_WOERTER_KNOTEN, `Knoten: höchstens ${MAX_WOERTER_KNOTEN} Wörter`);

export const Knoten = z.object({
  id: z.string().min(1),
  typ: KnotenTyp,
  text: knotenText,
  anforderungen: z.array(z.string()).min(1, "Jeder Knoten braucht mindestens eine U-Nummer"),
});
export type Knoten = z.infer<typeof Knoten>;

export const Kante = z.object({
  von: z.string().min(1),
  nach: z.string().min(1),
  bedingung: z.string().optional(),
});
export type Kante = z.infer<typeof Kante>;

export const Frage = z.object({ id: z.string().min(1), text: z.string().min(1) });
export type Frage = z.infer<typeof Frage>;

/** Was Claude per urs_submit schickt. */
export const UrsInhalt = z.object({
  name: z.string().min(1),
  zweck: z.string().min(1),
  zielgruppe: z.string().optional(),
  anforderungen: z.array(Anforderung).min(1),
  knoten: z.array(Knoten).min(1),
  kanten: z.array(Kante),
  fragen: z.array(Frage).default([]),
  sicherheit: z.array(z.string()).default([]),
  nichtEnthalten: z.array(z.string()).default([]),
}).superRefine((u, ctx) => {
  const doppelt = (ids: string[], wo: string) => {
    const s = new Set<string>();
    for (const id of ids) {
      if (s.has(id)) ctx.addIssue({ code: "custom", message: `${wo}: ${id} doppelt` });
      s.add(id);
    }
    return s;
  };
  const uIds = doppelt(u.anforderungen.map((a) => a.id), "Anforderung");
  const kIds = doppelt(u.knoten.map((k) => k.id), "Knoten");
  doppelt(u.fragen.map((f) => f.id), "Frage");
  const gestrichen = new Set(u.anforderungen.filter((a) => a.gestrichen).map((a) => a.id));
  for (const k of u.knoten) for (const a of k.anforderungen) {
    if (!uIds.has(a)) ctx.addIssue({ code: "custom", message: `Knoten ${k.id}: ${a} gibt es nicht` });
    else if (gestrichen.has(a)) ctx.addIssue({ code: "custom", message: `Knoten ${k.id}: ${a} ist gestrichen` });
  }
  for (const e of u.kanten) {
    if (!kIds.has(e.von)) ctx.addIssue({ code: "custom", message: `Pfeil: Knoten ${e.von} gibt es nicht` });
    if (!kIds.has(e.nach)) ctx.addIssue({ code: "custom", message: `Pfeil: Knoten ${e.nach} gibt es nicht` });
  }
});
export type UrsInhalt = z.infer<typeof UrsInhalt>;

export const Status = z.enum(["entwurf", "freigegeben"]);
export type Status = z.infer<typeof Status>;

export const Projekt = z.object({
  name: z.string(),
  status: Status,
  aktuelleVersion: z.number().int().positive(),
  freigegebeneVersion: z.number().int().positive().nullable(),
});
export type Projekt = z.infer<typeof Projekt>;

/** Ergebnis der unabhängigen SMART-Prüfung je Anforderung (U50, U54). */
export const SmartErgebnis = z.object({ ok: z.boolean(), grund: z.string() });
export type SmartErgebnis = z.infer<typeof SmartErgebnis>;
export const SmartPruefung = z.record(z.string(), SmartErgebnis);
export type SmartPruefung = z.infer<typeof SmartPruefung>;

export const Version = z.object({
  version: z.number().int().positive(),
  erstellt: z.string(),
  inhalt: UrsInhalt,
  // Fehlt bei Versionen von vor U50 — die gelten als ungeprüft (U55).
  smart: SmartPruefung.optional(),
  freigegeben: z.string().optional(),
  positionen: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).optional(),
});
export type Version = z.infer<typeof Version>;

// Arbeitskopie des Nutzers: seine Änderungen, Kommentare und Antworten zur aktuellen Version.
export const ArbeitsKnoten = z.object({
  id: z.string().min(1),
  typ: KnotenTyp,
  text: z.string(),
  anforderungen: z.array(z.string()),
});
export type ArbeitsKnoten = z.infer<typeof ArbeitsKnoten>;

export const Kommentar = z.object({
  id: z.string().min(1),
  knoten: z.string().nullable(),
  text: z.string().min(1),
  zeit: z.string(),
  erledigt: z.boolean(),
});
export type Kommentar = z.infer<typeof Kommentar>;

export const Arbeit = z.object({
  version: z.number().int().positive(),
  knoten: z.array(ArbeitsKnoten),
  kanten: z.array(Kante),
  positionen: z.record(z.string(), z.object({ x: z.number(), y: z.number() })),
  // Von Hand verschobene Knoten (U44): ihr Platz bleibt, auch in der nächsten Version. „Aufräumen“ leert die Liste (U45).
  fest: z.array(z.string()).optional(),
  kommentare: z.array(Kommentar),
  antworten: z.record(z.string(), z.string()),
});
export type Arbeit = z.infer<typeof Arbeit>;

export type Aenderungen = {
  neueKnoten: ArbeitsKnoten[];
  geloeschteKnoten: { id: string; text: string }[];
  umbenannt: { id: string; vorher: string; nachher: string }[];
  neueKanten: Kante[];
  geloeschteKanten: Kante[];
};

// Punkt-Chat (Werkbank): Nachrichten je Knoten, Claudes Antwort kann EINEN Änderungsvorschlag enthalten.
export const Vorschlag = z.discriminatedUnion("art", [
  z.object({ art: z.literal("umbenennen"), text: z.string().min(1) }),
  z.object({ art: z.literal("neuer_schritt"), text: z.string().min(1), typ: z.enum(["schritt", "entscheidung", "nutzer", "speicher"]) }),
  z.object({ art: z.literal("loeschen") }),
  z.object({ art: z.literal("hinweis"), text: z.string().min(1) }),
]);
export type Vorschlag = z.infer<typeof Vorschlag>;

export const Nachricht = z.object({
  id: z.string(),
  wer: z.enum(["ich", "claude"]),
  text: z.string(),
  zeit: z.string(),
  fehler: z.boolean().optional(),
  vorschlag: Vorschlag.optional(),
  vorschlagStatus: z.enum(["offen", "ok", "nein"]).optional(),
  // Name des Punkts beim Vorschlag — passt er nicht mehr (neue Version, umbenannt), ist der Vorschlag veraltet.
  knotenText: z.string().optional(),
});
export type Nachricht = z.infer<typeof Nachricht>;

// Beispiel, das Claude im Gespräch zeigt (urs_beispiel_zeigen): eigenständige HTML-Datei in .urs/beispiele/.
export const Beispiel = z.object({
  nr: z.number().int().positive(),
  titel: z.string(),
  knoten: z.string().nullable(),
  zeit: z.string(),
});
export type Beispiel = z.infer<typeof Beispiel>;
