// Screenshot-Ablage (U39): nur echte Bilder, nur Pfade aus dem eigenen Bilder-Ordner.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_BILD, bilderOrdner, legeBildAb, pruefeBildPfad } from "../src/bilder.ts";
import { UrsFehler } from "../src/store.ts";

let appHomeDir: string;
let fremdDir: string;
let vorherHome: string | undefined;

beforeEach(() => {
  appHomeDir = mkdtempSync(join(tmpdir(), "urs-home-"));
  fremdDir = mkdtempSync(join(tmpdir(), "urs-fremd-"));
  vorherHome = process.env.URS_APP_HOME;
  process.env.URS_APP_HOME = appHomeDir;
});

afterEach(() => {
  rmSync(appHomeDir, { recursive: true, force: true });
  rmSync(fremdDir, { recursive: true, force: true });
  if (vorherHome === undefined) delete process.env.URS_APP_HOME; else process.env.URS_APP_HOME = vorherHome;
});

// Dateianfänge echter Bilder (danach beliebige Bytes).
const ANFANG: Record<string, Buffer> = {
  "image/png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]),
  "image/jpeg": Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]),
  "image/gif": Buffer.from("GIF89a\x01\x02", "latin1"),
  "image/webp": Buffer.concat([Buffer.from("RIFF"), Buffer.from([4, 0, 0, 0]), Buffer.from("WEBPVP8 ")]),
};
const bytes = ANFANG["image/png"];
const url = (mime: string, daten: Buffer = ANFANG[mime] ?? bytes) => `data:${mime};base64,${daten.toString("base64")}`;
const dateienImOrdner = () => (existsSync(bilderOrdner()) ? readdirSync(bilderOrdner()) : []);
const gross = (n: number) => Buffer.concat([bytes, Buffer.alloc(n - bytes.length, 1)]);

describe("legeBildAb", () => {
  it.each([
    ["image/png", ".png"], ["image/jpeg", ".jpg"], ["image/gif", ".gif"], ["image/webp", ".webp"],
  ])("legt %s als Datei %s im Bilder-Ordner ab", (mime, endung) => {
    const pfad = legeBildAb(url(mime));
    expect(pfad.startsWith(bilderOrdner() + sep)).toBe(true);
    expect(bilderOrdner()).toBe(join(appHomeDir, "bilder"));
    expect(extname(pfad)).toBe(endung);
    expect(basename(pfad)).toMatch(/^screenshot-[\w-]+\.(png|jpg|gif|webp)$/);
    expect(readFileSync(pfad).equals(ANFANG[mime])).toBe(true);
  });

  it("zwei Bilder bekommen verschiedene Dateinamen", () => {
    expect(legeBildAb(url("image/png"))).not.toBe(legeBildAb(url("image/png")));
  });

  it.each([
    ["SVG", url("image/svg+xml")],
    ["HTML", url("text/html")],
    ["anderer Typ", url("application/pdf")],
    ["kein data:-URL", "/etc/passwd"],
    ["ohne base64", "data:image/png,abc"],
    ["kaputtes base64", "data:image/png;base64,@@@"],
    ["nichts nach dem Komma", "data:image/png;base64,"],
    ["leerer Text", ""],
    ["Anhängsel hinter dem Bild", url("image/png") + "\n<script>"],
    ["Pfadtrick im Typ", "data:image/png/../../x;base64,AAAA"],
    ["Inhalt passt nicht zum Typ (Text als PNG)", url("image/png", Buffer.from("kein Bild, nur Text"))],
    ["JPEG-Inhalt als PNG angegeben", url("image/png", ANFANG["image/jpeg"])],
  ])("lehnt ab: %s", (_name, daten) => {
    expect(() => legeBildAb(daten)).toThrow(UrsFehler);
    expect(dateienImOrdner()).toEqual([]);
  });

  it("lehnt ein leeres Bild ab", () => {
    expect(() => legeBildAb("data:image/png;base64,====")).toThrow(/Leeres Bild/);
    expect(dateienImOrdner()).toEqual([]);
  });

  it("lehnt ein zu großes Bild ab und legt nichts ab", () => {
    expect(() => legeBildAb(url("image/png", gross(MAX_BILD + 1)))).toThrow(/zu groß/);
    expect(dateienImOrdner()).toEqual([]);
  });

  it("nimmt ein Bild genau an der Grenze an", () => {
    const pfad = legeBildAb(url("image/png", gross(MAX_BILD)));
    expect(readFileSync(pfad).length).toBe(MAX_BILD);
  });
});

describe("pruefeBildPfad", () => {
  it("akzeptiert eine selbst abgelegte Datei und liefert den echten Pfad", () => {
    const pfad = legeBildAb(url("image/png"));
    expect(pruefeBildPfad(pfad)).toBe(realpathSync(pfad));
  });

  it("lehnt ab, solange es den Bilder-Ordner noch gar nicht gibt", () => {
    expect(() => pruefeBildPfad("/etc/passwd")).toThrow(UrsFehler);
    expect(() => pruefeBildPfad(join(appHomeDir, "bilder", "screenshot-x.png"))).toThrow(/Unbekanntes Bild/);
  });

  it("lehnt eine nicht vorhandene Datei im Bilder-Ordner ab", () => {
    legeBildAb(url("image/png"));
    expect(() => pruefeBildPfad(join(bilderOrdner(), "screenshot-gibtsnicht.png"))).toThrow(/Unbekanntes Bild/);
  });

  it("lehnt eine fremde Datei außerhalb des Ordners ab, auch mit passendem Namen", () => {
    legeBildAb(url("image/png"));
    const fremd = join(fremdDir, "screenshot-x.png");
    writeFileSync(fremd, bytes);
    expect(() => pruefeBildPfad(fremd)).toThrow(/Unbekanntes Bild/);
    expect(() => pruefeBildPfad("/etc/hosts")).toThrow(UrsFehler);
  });

  it("lehnt ../-Tricks ab", () => {
    legeBildAb(url("image/png"));
    writeFileSync(join(appHomeDir, "screenshot-x.png"), bytes); // liegt eine Ebene über bilder/
    expect(() => pruefeBildPfad(join(bilderOrdner(), "..", "screenshot-x.png"))).toThrow(/Unbekanntes Bild/);
    expect(() => pruefeBildPfad(`${bilderOrdner()}/../../${basename(fremdDir)}/x.png`)).toThrow(UrsFehler);
  });

  it("lehnt einen Symlink im Bilder-Ordner ab, der nach außen zeigt", () => {
    legeBildAb(url("image/png"));
    const ziel = join(fremdDir, "geheim.png");
    writeFileSync(ziel, bytes);
    const link = join(bilderOrdner(), "screenshot-link.png");
    symlinkSync(ziel, link);
    expect(() => pruefeBildPfad(link)).toThrow(/Unbekanntes Bild/);
  });

  it("lehnt einen Symlink auf einen anderen Ordner ab (Ordner-Link)", () => {
    legeBildAb(url("image/png"));
    writeFileSync(join(fremdDir, "screenshot-y.png"), bytes);
    const linkOrdner = join(bilderOrdner(), "unter");
    symlinkSync(fremdDir, linkOrdner);
    expect(() => pruefeBildPfad(join(linkOrdner, "screenshot-y.png"))).toThrow(/Unbekanntes Bild/);
  });

  it("lehnt Dateien im Ordner ab, die nicht wie ein abgelegter Screenshot heißen", () => {
    legeBildAb(url("image/png"));
    for (const name of ["notizen.txt", "id_rsa", "screenshot-a.svg", "screenshot-a.png.sh"]) {
      const datei = join(bilderOrdner(), name);
      writeFileSync(datei, "x");
      expect(() => pruefeBildPfad(datei), name).toThrow(/Unbekanntes Bild/);
    }
  });

  it("lehnt einen Nachbarordner mit ähnlichem Namen ab (bilder-evil)", () => {
    legeBildAb(url("image/png"));
    const evil = join(appHomeDir, "bilder-evil");
    mkdirSync(evil);
    const datei = join(evil, "screenshot-x.png");
    writeFileSync(datei, bytes);
    expect(() => pruefeBildPfad(datei)).toThrow(/Unbekanntes Bild/);
  });

  it("lehnt einen Ordner statt einer Datei ab", () => {
    legeBildAb(url("image/png"));
    const ordnerName = join(bilderOrdner(), "screenshot-ordner.png");
    mkdirSync(ordnerName);
    expect(() => pruefeBildPfad(ordnerName)).toThrow(UrsFehler);
  });
});
