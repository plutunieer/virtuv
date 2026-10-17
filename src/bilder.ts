// Screenshots aus Terminal und Block-Feld (U39): landen als Datei in ~/.urs-app/bilder/, Claude bekommt den Pfad.
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { UrsFehler, appHome } from "./store.ts";

export const MAX_BILD = 15_000_000; // Bytes je Bild
const ENDUNG: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

export const bilderOrdner = () => join(appHome(), "bilder");

/** data:image/…;base64,… → Datei. Gibt den absoluten Pfad zurück. */
export function legeBildAb(datenUrl: string): string {
  const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(datenUrl);
  if (!m) throw new UrsFehler("Nur Bilder (PNG, JPEG, GIF, WebP)");
  const daten = Buffer.from(m[2], "base64");
  if (!daten.length) throw new UrsFehler("Leeres Bild");
  if (daten.length > MAX_BILD) throw new UrsFehler("Bild zu groß (höchstens 15 MB)");
  // Inhalt muss zum Typ passen (Dateianfang), nicht nur die Angabe des Browsers.
  const anfang = daten.subarray(0, 12);
  const echt = m[1] === "image/png" ? anfang.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    : m[1] === "image/jpeg" ? anfang.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
    : m[1] === "image/gif" ? anfang.subarray(0, 4).toString("latin1") === "GIF8"
    : anfang.subarray(0, 4).toString("latin1") === "RIFF" && anfang.subarray(8, 12).toString("latin1") === "WEBP";
  if (!echt) throw new UrsFehler("Nur Bilder (PNG, JPEG, GIF, WebP)");
  mkdirSync(bilderOrdner(), { recursive: true, mode: 0o700 });
  const zeit = new Date().toISOString().replace(/[:.]/g, "-");
  const pfad = join(bilderOrdner(), `screenshot-${zeit}-${crypto.randomUUID().slice(0, 8)}.${ENDUNG[m[1]]}`);
  writeFileSync(pfad, daten, { mode: 0o600 });
  return pfad;
}

/** Nur Bilder, die hier abgelegt wurden — sonst könnte man Claude beliebige Pfade unterschieben. */
export function pruefeBildPfad(pfad: string): string {
  const ordner = existsSync(bilderOrdner()) ? realpathSync(bilderOrdner()) : null;
  const echt = existsSync(pfad) ? realpathSync(pfad) : null;
  if (!ordner || !echt || !echt.startsWith(ordner + sep) || !statSync(echt).isFile() || !/^screenshot-[\w-]+\.(png|jpg|gif|webp)$/.test(echt.slice(ordner.length + 1))) {
    throw new UrsFehler("Unbekanntes Bild");
  }
  return echt;
}
