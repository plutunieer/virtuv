// Speicher: JSON-Dateien in <projekt>/.urs/ — eine eingefrorene Datei je Version, git-fähig.
// MCP-Prozess und Web-Server schreiben beide hierher; jede Lesen-Ändern-Schreiben-Folge läuft unter einer Sperre.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { aenderungen, offen as offenLogik, smartVerfehlt, zuordnungsFehler } from "./logik.ts";
import { Arbeit, MAX_WOERTER_ANFORDERUNG, Projekt, SmartPruefung, UrsInhalt, Version, woerter } from "./schema.ts";

export class UrsFehler extends Error {}

const vDatei = (n: number) => `v${String(n).padStart(3, "0")}.json`;
export const ursOrdner = (pfad: string) => join(pfad, ".urs");

export function schreibe(datei: string, daten: unknown) {
  const tmp = `${datei}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(daten, null, 2) + "\n");
  renameSync(tmp, datei);
}
export const lies = (datei: string): unknown => JSON.parse(readFileSync(datei, "utf8"));

/** Sperre über ein Verzeichnis (mkdir ist atomar). Hängt eine Sperre länger als 10 s, gilt sie als verwaist. */
export function gesperrt<T>(ort: string, f: () => T): T {
  mkdirSync(ort, { recursive: true });
  const lock = join(ort, ".lock");
  const warte = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; ; i++) {
    try { mkdirSync(lock); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const alter = Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (alter > 10_000) { try { rmdirSync(lock); } catch { /* anderer war schneller */ } continue; }
      if (i > 200) throw new UrsFehler("Speicher ist gerade belegt, bitte nochmal versuchen");
      Atomics.wait(warte, 0, 0, 25);
    }
  }
  try { return f(); } finally { try { rmdirSync(lock); } catch { /* schon als verwaist entfernt */ } }
}

// ---------- Verzeichnis der Projekte (id → Ordner) ----------
// Der Browser kennt nur ids, nie Pfade. Nur hier eingetragene Ordner werden angefasst.

export const appHome = () => process.env.URS_APP_HOME ?? join(homedir(), ".urs-app");
const registerDatei = () => join(appHome(), "projekte.json");

function register(): Record<string, string> {
  const d = registerDatei();
  return existsSync(d) ? (lies(d) as Record<string, string>) : {};
}

export function projektId(pfad: string) {
  const slug = basename(pfad).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "projekt";
  return `${slug}-${createHash("sha256").update(pfad).digest("hex").slice(0, 6)}`;
}

export function anmelden(pfad: string): string {
  if (!isAbsolute(pfad)) throw new UrsFehler(`Projektordner muss ein absoluter Pfad sein: ${pfad}`);
  const p = resolve(pfad);
  if (!existsSync(p) || !statSync(p).isDirectory()) throw new UrsFehler(`Ordner gibt es nicht: ${p}`);
  const id = projektId(p);
  gesperrt(appHome(), () => {
    const r = register();
    if (r[id] !== p) schreibe(registerDatei(), { ...r, [id]: p });
  });
  return id;
}

/** Projekt aus der Übersicht nehmen (U26): nur der Eintrag im Verzeichnis fällt weg — Ordner und .urs/ bleiben unangetastet. */
export function abmelden(id: string): boolean {
  return gesperrt(appHome(), () => {
    const r = register();
    if (!Object.hasOwn(r, id)) return false;
    delete r[id];
    schreibe(registerDatei(), r);
    return true;
  });
}

export function pfadVon(id: string): string | null {
  const r = register();
  return Object.hasOwn(r, id) && typeof r[id] === "string" ? r[id] : null;
}

/** Alle eingetragenen Ordner, auch ohne URS — für die Startseite der Werkbank. */
export function alleOrdner() {
  return Object.entries(register()).flatMap(([id, pfad]) => {
    if (!existsSync(pfad)) return [];
    let p: Projekt | null = null;
    try { p = ladeProjekt(pfad); } catch { /* kaputte projekt.json: Ordner trotzdem zeigen, ohne Stand */ }
    return [{ id, pfad, name: p?.name ?? basename(pfad), version: p?.aktuelleVersion ?? null, status: p?.status ?? null, ohneOrdner: ohneOrdner(pfad) }];
  });
}

// ---------- Planen ohne Ordner (U77–U79) ----------
// Ein neuer Chat plant in einem eigenen Ordner der App. Gebaut wird erst, wenn der Nutzer einen echten Ordner wählt;
// dann zieht der Plan (.urs/) dorthin um.

const entwurfsOrdner = () => join(appHome(), "entwuerfe");

/** Echter Pfad (Verknüpfungen aufgelöst), sonst der normalisierte. */
const echt = (pfad: string) => { try { return realpathSync(pfad); } catch { return resolve(pfad); } };

/** Liegt der Ordner bei den Plänen ohne Projektordner? */
export const ohneOrdner = (pfad: string) => echt(pfad).startsWith(echt(entwurfsOrdner()) + sep);

/** Neuen Plan ohne Ordner anlegen (U77). Liefert die Projekt-id. */
export function neuerEntwurf(): string {
  mkdirSync(entwurfsOrdner(), { recursive: true });
  const d = new Date();
  const zeit = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const pfad = mkdtempSync(join(entwurfsOrdner(), `plan-${zeit}-`));
  return anmelden(pfad);
}

/** Prüft den gewählten Zielordner für den Umzug; liefert ihn als vollen Pfad. Wirft, wenn er nicht taugt. */
export function umzugsZiel(altPfad: string, zielRoh: string): string {
  if (!ohneOrdner(altPfad)) throw new UrsFehler("Dieser Chat hat schon einen Ordner");
  if (!isAbsolute(zielRoh)) throw new UrsFehler(`Projektordner muss ein absoluter Pfad sein: ${zielRoh}`);
  const ziel = resolve(zielRoh);
  if (!existsSync(ziel) || !statSync(ziel).isDirectory()) throw new UrsFehler(`Ordner gibt es nicht: ${ziel}`);
  // Nicht in die Ablage der App (dort liegen Projektliste und Freigabe-Nachweise) — auch nicht über eine Verknüpfung.
  const home = echt(appHome());
  if (echt(ziel) === home || echt(ziel).startsWith(home + sep)) throw new UrsFehler("Bitte einen eigenen Projektordner wählen");
  if (existsSync(ursOrdner(ziel))) throw new UrsFehler(`Dieser Ordner hat schon einen Ablauf: ${ziel} — bitte einen anderen wählen`);
  return ziel;
}

/**
 * Plan ohne Ordner in den gewählten Ordner umziehen (U79): .urs/ wandert dorthin, der Freigabe-Nachweis gilt weiter,
 * der Plan-Ordner fällt aus der Übersicht. Hat der Zielordner schon einen Ablauf, wird nichts überschrieben.
 */
export function umziehen(altPfad: string, zielRoh: string): string {
  const ziel = umzugsZiel(altPfad, zielRoh);
  const alt = resolve(altPfad);
  type Nachweise = Record<string, { version: number; pruefsumme: string }>;
  const nachweise = (f: (alle: Nachweise) => void) => gesperrt(appHome(), () => {
    const d = freigabenDatei();
    const alle = existsSync(d) ? (lies(d) as Nachweise) : {};
    f(alle); schreibe(d, alle);
  });
  // Vorher: der Nachweis gilt auch am Ziel (ein alter Eintrag dort fällt weg). Scheitert das, ist noch nichts verschoben.
  nachweise((alle) => { if (alle[alt]) alle[ziel] = alle[alt]; else delete alle[ziel]; });
  if (existsSync(ursOrdner(alt))) {
    gesperrt(ursOrdner(alt), () => {
      try { renameSync(ursOrdner(alt), ursOrdner(ziel)); } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
        // Anderes Laufwerk: kopieren (nie etwas überschreiben), dann das Original unter derselben Sperre entfernen.
        // Erst den Zielordner selbst anlegen: gibt es ihn inzwischen (fremder Plan), scheitert das — dann nichts aufräumen.
        try { mkdirSync(ursOrdner(ziel)); } catch (f) { nachweise((alle) => { delete alle[ziel]; }); throw f; }
        try {
          cpSync(ursOrdner(alt), ursOrdner(ziel), { recursive: true, force: false, errorOnExist: true, filter: (q) => !q.endsWith(`${sep}.lock`) });
        } catch (f) {
          // Halbe Kopie wieder weg (den Ordner haben wir eben selbst angelegt), Nachweis am Ziel zurücknehmen — der Plan bleibt im Entwurf.
          rmSync(ursOrdner(ziel), { recursive: true, force: true });
          nachweise((alle) => { delete alle[ziel]; });
          throw f;
        }
        rmSync(ursOrdner(alt), { recursive: true, force: true });
      }
    });
    // Die Sperre lag im alten Ordner und ist mitgewandert.
    try { rmdirSync(join(ursOrdner(ziel), ".lock")); } catch { /* keine da */ }
  }
  // Ab hier liegt der Plan im Ziel: nur noch anmelden und aufräumen, nichts mehr zurückdrehen.
  const id = anmelden(ziel);
  try { nachweise((alle) => { delete alle[alt]; }); } catch { /* alter Eintrag stört nicht: der Ordner ist abgemeldet */ }
  try { abmelden(projektId(alt)); } catch { /* bleibt als leere Kachel */ }
  try { rmdirSync(alt); } catch { /* nicht leer: bleibt liegen */ }
  return id;
}

/** Leeren Plan ohne Ordner wegräumen (Chat geschlossen, noch kein Ablauf) — sonst sammeln sich leere Kacheln. */
/** Nur ganz leere Ordner — liegt etwas darin (auch ohne Ablauf), bleibt der Plan in der Übersicht. */
export function leerenEntwurfEntfernen(id: string): boolean {
  const pfad = pfadVon(id);
  if (!pfad || !ohneOrdner(pfad) || !existsSync(pfad) || readdirSync(pfad).length) return false;
  try { rmdirSync(pfad); } catch { return false; }
  abmelden(id);
  return true;
}

export function alleProjekte() {
  return Object.entries(register()).flatMap(([id, pfad]) => {
    const p = ladeProjekt(pfad);
    return p ? [{ id, name: p.name, status: p.status, version: p.aktuelleVersion }] : [];
  });
}

// ---------- Lesen ----------

export function ladeProjekt(pfad: string): Projekt | null {
  const d = join(ursOrdner(pfad), "projekt.json");
  return existsSync(d) ? Projekt.parse(lies(d)) : null;
}

function mussProjekt(pfad: string): Projekt {
  const p = ladeProjekt(pfad);
  if (!p) throw new UrsFehler("Für diesen Ordner gibt es noch keine URS. Zuerst urs_submit aufrufen.");
  return p;
}

export function ladeVersion(pfad: string, n: number): Version {
  const d = join(ursOrdner(pfad), vDatei(n));
  if (!Number.isInteger(n) || !existsSync(d)) throw new UrsFehler(`Version ${n} gibt es nicht`);
  return Version.parse(lies(d));
}

const versionsDateien = (pfad: string) =>
  existsSync(ursOrdner(pfad)) ? readdirSync(ursOrdner(pfad)).filter((f) => /^v\d{3,}\.json$/.test(f)) : [];

export function versionen(pfad: string) {
  return versionsDateien(pfad)
    .map((f) => {
      const v = Version.parse(lies(join(ursOrdner(pfad), f)));
      return { version: v.version, erstellt: v.erstellt, freigegeben: v.freigegeben ?? null };
    })
    .sort((a, b) => a.version - b.version);
}

function frischeArbeit(v: Version): Arbeit {
  return {
    version: v.version,
    knoten: v.inhalt.knoten.map((k) => ({ ...k, anforderungen: [...k.anforderungen] })),
    kanten: v.inhalt.kanten.map((k) => ({ ...k })),
    positionen: {},
    fest: [],
    kommentare: [],
    antworten: {},
  };
}

export function ladeArbeit(pfad: string): Arbeit {
  const p = mussProjekt(pfad);
  const d = join(ursOrdner(pfad), "arbeit.json");
  const a = existsSync(d) ? Arbeit.parse(lies(d)) : null;
  return a && a.version === p.aktuelleVersion ? a : frischeArbeit(ladeVersion(pfad, p.aktuelleVersion));
}

/** Fingerabdruck der Rückmeldung (ohne Positionen). Ändert sich, sobald der Nutzer etwas Inhaltliches tut. */
export function stand(a: Arbeit): string {
  const { knoten, kanten, kommentare, antworten } = a;
  return createHash("sha256").update(JSON.stringify({ knoten, kanten, kommentare, antworten })).digest("hex").slice(0, 12);
}

// ---------- Claude: neue Version ----------

/**
 * Prüfungen gegen die bisherige Version: U-Nummern nie neu vergeben, Rückmeldung des Nutzers bekannt (stand).
 * Liefert die bisherige Arbeitskopie (oder null beim ersten Mal). Ohne Sperre — submit ruft sie unter der Sperre.
 */
function vorpruefenOhneSperre(pfad: string, inhalt: UrsInhalt, bekannterStand?: string): Arbeit | null {
  const alt = ladeProjekt(pfad);
  if (!alt) return null;
  const vorherInhalt = ladeVersion(pfad, alt.aktuelleVersion).inhalt;
  // U-Nummern werden nie neu vergeben: jede frühere Nummer bleibt, gestrichen bleibt gestrichen.
  const jetzt = new Map(inhalt.anforderungen.map((a) => [a.id, a]));
  const fehler: string[] = [];
  for (const a of vorherInhalt.anforderungen) {
    const b = jetzt.get(a.id);
    if (!b) fehler.push(`${a.id} fehlt (wegfallen lassen = gestrichen: true)`);
    else if (a.gestrichen && !b.gestrichen) fehler.push(`${a.id} ist gestrichen und darf nicht neu vergeben werden`);
  }
  if (fehler.length) throw new UrsFehler(fehler.join("; "));
  const vorher = ladeArbeit(pfad);
  const hatRueckmeldung = vorher.kommentare.length > 0 || Object.keys(vorher.antworten).length > 0 ||
    offenLogik(vorherInhalt, vorher).aenderungen > 0;
  if (alt.status === "entwurf" && hatRueckmeldung && bekannterStand !== stand(vorher)) {
    throw new UrsFehler("Der Nutzer hat inzwischen etwas geändert. Zuerst urs_get_feedback aufrufen und einarbeiten.");
  }
  return vorher;
}

/** Billige Prüfungen vor der teuren SMART-Prüfung (mcp.ts) — dieselben laufen in submit noch einmal unter der Sperre. */
export function vorpruefen(pfad: string, roh: unknown, bekannterStand?: string): UrsInhalt {
  const inhalt = pruefeInhalt(roh);
  vorpruefenOhneSperre(pfad, inhalt, bekannterStand);
  return inhalt;
}

/**
 * Neue URS prüfen: Schema und — nur für neue Versionen, alte bleiben lesbar — genau ein Knoten je Anforderung (U52)
 * sowie höchstens 12 Wörter je gültiger Anforderung (U48; gestrichene behalten ihren alten Text).
 */
export function pruefeInhalt(roh: unknown): UrsInhalt {
  const inhalt = UrsInhalt.parse(roh);
  const fehler = zuordnungsFehler(inhalt);
  if (fehler.length) throw new UrsFehler(`Ungültige URS (jede Anforderung an genau einem Knoten, U52): ${fehler.join("; ")}`);
  const zuLang = inhalt.anforderungen.filter((a) => !a.gestrichen && woerter(a.text) > MAX_WOERTER_ANFORDERUNG);
  if (zuLang.length) {
    throw new UrsFehler(`Anforderung zu lang (höchstens ${MAX_WOERTER_ANFORDERUNG} Wörter, U48): ` +
      zuLang.map((a) => `${a.id} hat ${woerter(a.text)}`).join("; ") +
      " — kürzen, auch bereits freigegebene; die Änderung muss neu freigegeben werden.");
  }
  return inhalt;
}

/**
 * Legt eine neue Version an. Gibt es Rückmeldung des Nutzers, muss `bekannterStand` (aus urs_get_feedback)
 * zum aktuellen Stand passen — sonst hat der Nutzer inzwischen etwas geändert, das Claude noch nicht kennt.
 */
/** erledigteKommentare: ids von Kommentaren, die Claude eingearbeitet hat — sie wandern nicht in die neue Version (U24). */
/** smart: Ergebnis der unabhängigen SMART-Prüfung (U50) — ohne bleibt die Freigabe gesperrt (U55). */
export function submit(pfad: string, roh: unknown, bekannterStand?: string, erledigteKommentare: string[] = [],
  smart?: SmartPruefung): { version: number } {
  const inhalt = pruefeInhalt(roh);
  return gesperrt(ursOrdner(pfad), () => {
    const alt = ladeProjekt(pfad);
    const hoechste = Math.max(0, ...versionsDateien(pfad).map((f) => Number(f.slice(1, -5))));
    const n = hoechste + 1;

    const vorher = vorpruefenOhneSperre(pfad, inhalt, bekannterStand);

    const version: Version = { version: n, erstellt: new Date().toISOString(), inhalt, ...(smart ? { smart } : {}) };
    writeFileSync(join(ursOrdner(pfad), vDatei(n)), JSON.stringify(version, null, 2) + "\n", { flag: "wx" });

    // Offene Kommentare wandern mit; Antworten nur, wenn dieselbe Frage (gleicher Text) noch da ist.
    const neu = frischeArbeit(version);
    if (vorher && alt) {
      const altFragen = new Map(ladeVersion(pfad, alt.aktuelleVersion).inhalt.fragen.map((f) => [f.id, f.text]));
      const ids = new Set(inhalt.knoten.map((k) => k.id));
      const erledigt = new Set(erledigteKommentare);
      neu.kommentare = vorher.kommentare
        .filter((k) => !k.erledigt && !erledigt.has(k.id))
        .map((k) => ({ ...k, knoten: k.knoten && ids.has(k.knoten) ? k.knoten : null }));
      // Von Hand gesetzte Plätze bleiben für Knoten, die es weiter gibt (U44).
      neu.fest = (vorher.fest ?? []).filter((id) => ids.has(id) && vorher!.positionen[id]);
      neu.positionen = Object.fromEntries(neu.fest.map((id) => [id, vorher!.positionen[id]]));
      neu.antworten = Object.fromEntries(Object.entries(vorher.antworten)
        .filter(([id]) => inhalt.fragen.some((f) => f.id === id && f.text === altFragen.get(id))));
    }
    schreibe(join(ursOrdner(pfad), "arbeit.json"), neu);

    schreibe(join(ursOrdner(pfad), "projekt.json"), {
      name: inhalt.name,
      status: "entwurf",
      aktuelleVersion: n,
      freigegebeneVersion: alt?.freigegebeneVersion ?? null,
    } satisfies Projekt);
    return { version: n };
  });
}

// ---------- Rückmeldung des Nutzers ----------

/** Was die Freigabe noch blockiert. Alles 0 = Freigabe möglich. */
export function offen(pfad: string) {
  const p = mussProjekt(pfad);
  const v = ladeVersion(pfad, p.aktuelleVersion);
  return offenLogik(v.inhalt, ladeArbeit(pfad), v.smart);
}

export function speichereArbeit(pfad: string, roh: unknown): void {
  const a = Arbeit.parse(roh);
  gesperrt(ursOrdner(pfad), () => {
    const p = mussProjekt(pfad);
    if (p.status === "freigegeben") throw new UrsFehler("Version ist freigegeben und eingefroren");
    if (a.version !== p.aktuelleVersion) throw new UrsFehler("Veraltet: es gibt eine neuere Version");
    schreibe(join(ursOrdner(pfad), "arbeit.json"), a);
  });
}

export function verwerfen(pfad: string): void {
  gesperrt(ursOrdner(pfad), () => {
    const p = mussProjekt(pfad);
    if (p.status === "freigegeben") throw new UrsFehler("Version ist freigegeben und eingefroren");
    const a = ladeArbeit(pfad);
    const f = frischeArbeit(ladeVersion(pfad, p.aktuelleVersion));
    schreibe(join(ursOrdner(pfad), "arbeit.json"), { ...a, knoten: f.knoten, kanten: f.kanten });
  });
}

export function feedback(pfad: string) {
  const p = mussProjekt(pfad);
  const v = ladeVersion(pfad, p.aktuelleVersion);
  const a = ladeArbeit(pfad);
  const text = new Map([...v.inhalt.knoten, ...a.knoten].map((k) => [k.id, k.text]));
  return {
    version: p.aktuelleVersion,
    status: p.status,
    stand: stand(a),
    offeneKommentare: a.kommentare.filter((k) => !k.erledigt).map((k) => ({
      id: k.id,
      knoten: k.knoten,
      knotenText: k.knoten ? text.get(k.knoten) ?? null : null,
      text: k.text,
      zeit: k.zeit,
    })),
    antworten: v.inhalt.fragen.filter((f) => a.antworten[f.id]?.trim())
      .map((f) => ({ frage: f.id, text: f.text, antwort: a.antworten[f.id] })),
    unbeantworteteFragen: v.inhalt.fragen.filter((f) => !a.antworten[f.id]?.trim()),
    aenderungen: aenderungen(v.inhalt, a),
  };
}

// ---------- Freigabe (nur über den Knopf im Browser) ----------

export function freigeben(pfad: string, version: number): void {
  gesperrt(ursOrdner(pfad), () => {
    const p = mussProjekt(pfad);
    if (p.status === "freigegeben") throw new UrsFehler("Schon freigegeben");
    if (version !== p.aktuelleVersion) throw new UrsFehler("Veraltet: es gibt eine neuere Version");
    const o = offen(pfad);
    const v = ladeVersion(pfad, version);
    const grund = [
      o.kommentare && `${o.kommentare} Kommentar(e) offen`,
      o.fragen && `${o.fragen} Frage(n) offen`,
      o.aenderungen && `${o.aenderungen} Änderung(en) noch nicht von Claude übernommen`,
      o.smart && (v.smart ? `SMART verfehlt oder ungeprüft: ${smartVerfehlt(v.inhalt, v.smart).join(", ")}`
        : "SMART ungeprüft (Version von vor der SMART-Prüfung) — Claude soll die URS neu einreichen"),
    ].filter(Boolean);
    if (grund.length) throw new UrsFehler(grund.join(", "));
    const a = ladeArbeit(pfad);
    if (a.version !== version) throw new UrsFehler("Die Diagrammpositionen gehören nicht zur aktuellen Version");
    const positionen = Object.fromEntries(v.inhalt.knoten.map((knoten, index) =>
      [knoten.id, a.positionen[knoten.id] ?? { x: 130, y: 12 + index * 90 }]));
    const jetzt = new Date().toISOString();
    schreibe(join(ursOrdner(pfad), vDatei(version)), { ...v, positionen, freigegeben: jetzt });
    schreibe(join(ursOrdner(pfad), "projekt.json"), { ...p, status: "freigegeben", freigegebeneVersion: version });
    freigabeMerken(pfad, version);
  });
}

// ---------- Freigabe-Nachweis außerhalb des Projekts ----------
// .urs/ liegt im Projektordner und kann aus einem fremden Repo kommen oder von Claude beschrieben werden.
// Gebaut wird nur, wenn die Freigabe auch in ~/.urs-app/freigaben.json steht — mit Prüfsumme der freigegebenen Version.

const freigabenDatei = () => join(appHome(), "freigaben.json");
const pruefsumme = (pfad: string, version: number) =>
  createHash("sha256").update(readFileSync(join(ursOrdner(pfad), vDatei(version)))).digest("hex");

function freigabeMerken(pfad: string, version: number) {
  gesperrt(appHome(), () => {
    const d = freigabenDatei();
    const alle = existsSync(d) ? (lies(d) as Record<string, { version: number; pruefsumme: string }>) : {};
    schreibe(d, { ...alle, [resolve(pfad)]: { version, pruefsumme: pruefsumme(pfad, version) } });
  });
}

/** Ist die aktuelle Version wirklich vom Nutzer in dieser App freigegeben (nicht nur in projekt.json behauptet)? */
export function freigabeBestaetigt(pfad: string): boolean {
  try {
    const p = ladeProjekt(pfad);
    if (!p || p.status !== "freigegeben") return false;
    const d = freigabenDatei();
    const eintrag = existsSync(d) ? (lies(d) as Record<string, { version: number; pruefsumme: string }>)[resolve(pfad)] : undefined;
    return !!eintrag && eintrag.version === p.aktuelleVersion && eintrag.pruefsumme === pruefsumme(pfad, p.aktuelleVersion);
  } catch { return false; }
}

export function freigegeben(pfad: string): Version {
  const p = mussProjekt(pfad);
  if (p.status !== "freigegeben") {
    const hinweis = p.freigegebeneVersion
      ? ` Version ${p.freigegebeneVersion} war freigegeben, aber Version ${p.aktuelleVersion} ist ein neuer Entwurf.`
      : "";
    throw new UrsFehler(`Nicht freigegeben – nicht bauen.${hinweis} Der Nutzer muss im Browser auf „Freigeben“ klicken.`);
  }
  return ladeVersion(pfad, p.aktuelleVersion);
}
