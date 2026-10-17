import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  beispielHtml, blockFrage, gespraechBeenden, ladeBeispiele, ladeChats, merkeFrage, pruefeVorschlag, speichereBeispiel,
  vorschlagAblegen, vorschlagEntscheiden,
} from "../src/chat.ts";
import { legeBildAb } from "../src/bilder.ts";
import { UrsFehler, submit } from "../src/store.ts";
import { minimaleUrs, ursMitZweiPunkten } from "./fixtures.ts";

let projektDir: string;
let appHomeDir: string;

beforeEach(() => {
  appHomeDir = mkdtempSync(join(tmpdir(), "urs-home-"));
  process.env.URS_APP_HOME = appHomeDir;
  projektDir = mkdtempSync(join(tmpdir(), "urs-proj-"));
  submit(projektDir, ursMitZweiPunkten());
});

afterEach(() => {
  rmSync(projektDir, { recursive: true, force: true });
  rmSync(appHomeDir, { recursive: true, force: true });
  delete process.env.URS_APP_HOME;
});

const chatDatei = () => join(projektDir, ".urs", "chats.json");
const beispielOrdner = () => join(projektDir, ".urs", "beispiele");

describe("blockFrage", () => {
  it("liefert die getrimmte Frage und speichert noch nichts", () => {
    const r = blockFrage(projektDir, "k1", "  Warum so?  ");
    expect(r.frage).toBe("Warum so?");
    expect(ladeChats(projektDir)).toEqual({});
    expect(existsSync(chatDatei())).toBe(false);
  });

  it("Terminal-Text enthält Blockname, knoten_id, Typ, U-Nummer samt Text und die Frage", () => {
    const t = blockFrage(projektDir, "k2", "Was passiert hier?").terminalText;
    expect(t).toContain("„Zweiter“");
    expect(t).toContain("knoten_id k2");
    expect(t).toContain("schritt");
    expect(t).toContain("U2: Zweiter Satz.");
    expect(t).toContain("Was passiert hier?");
  });

  it("verweist auf urs_beispiel_zeigen und urs_vorschlag (nicht auf urs_submit als Weg)", () => {
    const t = blockFrage(projektDir, "k1", "Frage").terminalText;
    expect(t).toContain("urs_beispiel_zeigen");
    expect(t).toContain("urs_vorschlag");
    expect(t).toMatch(/nicht mit urs_submit/);
  });

  it("entfernt Steuerzeichen aus der Frage (kein Ausbruch aus dem Einfügen)", () => {
    const r = blockFrage(projektDir, "k1", "A\x1b[201~B\rC\nD");
    expect(r.frage).toBe("A[201~BC\nD");
    expect(r.terminalText).not.toContain("\x1b");
  });

  it("nennt gestrichene Anforderungen nicht", () => {
    rmSync(join(projektDir, ".urs"), { recursive: true, force: true });
    submit(projektDir, minimaleUrs({
      anforderungen: [
        { id: "U1", text: "Bleibt.", prio: "muss" },
        { id: "U2", text: "Fliegt raus.", prio: "muss", gestrichen: true },
      ],
      knoten: [{ id: "k1", typ: "start", text: "Start", anforderungen: ["U1"] }],
    }));
    const t = blockFrage(projektDir, "k1", "Frage").terminalText;
    expect(t).toContain("U1: Bleibt.");
    expect(t).not.toContain("Fliegt raus.");
  });

  it.each(["", "   ", "\n\t"])("lehnt leere Frage %j ab", (text) => {
    expect(() => blockFrage(projektDir, "k1", text)).toThrow(/Leere Nachricht/);
  });

  it("lehnt über 4000 Zeichen ab, erlaubt genau 4000", () => {
    expect(() => blockFrage(projektDir, "k1", "x".repeat(4001))).toThrow(/zu lang/);
    expect(() => blockFrage(projektDir, "k1", "x".repeat(4000))).not.toThrow();
  });

  it("lehnt einen unbekannten Block ab", () => {
    expect(() => blockFrage(projektDir, "gibt-es-nicht", "Hallo")).toThrow(UrsFehler);
    expect(() => blockFrage(projektDir, "gibt-es-nicht", "Hallo")).toThrow(/gibt es nicht/);
  });

  it("lehnt ein Projekt ohne URS ab", () => {
    const leer = mkdtempSync(join(tmpdir(), "urs-leer-"));
    try {
      expect(() => blockFrage(leer, "k1", "Hallo")).toThrow(/Noch keine URS/);
    } finally {
      rmSync(leer, { recursive: true, force: true });
    }
  });
});

describe("merkeFrage und gespraechBeenden", () => {
  it("merkeFrage speichert die Frage (wer ich, mit Zeit und ID), mehrere nacheinander", () => {
    merkeFrage(projektDir, "k1", "Eins");
    merkeFrage(projektDir, "k1", "Zwei");
    const n = ladeChats(projektDir).k1;
    expect(n.map((x) => x.text)).toEqual(["Eins", "Zwei"]);
    expect(n[0]).toMatchObject({ wer: "ich" });
    expect(n[0].id).toBeTruthy();
    expect(Number.isNaN(Date.parse(n[0].zeit))).toBe(false);
    expect(JSON.parse(readFileSync(chatDatei(), "utf8")).k1).toHaveLength(2);
  });

  it("gespraechBeenden schließt eine offene Frage ab, sonst nichts", () => {
    gespraechBeenden(projektDir, "k1"); // keine Frage → nichts
    expect(ladeChats(projektDir)).toEqual({});
    merkeFrage(projektDir, "k1", "Frage");
    gespraechBeenden(projektDir, "k1");
    gespraechBeenden(projektDir, "k1"); // schon abgeschlossen → kein zweiter Eintrag
    expect(ladeChats(projektDir).k1.map((n) => n.wer)).toEqual(["ich", "claude"]);
  });
});

describe("pruefeVorschlag", () => {
  const schritt = { text: "Start", typ: "schritt" };

  it.each([
    ["umbenennen mit 4 Wörtern", { art: "umbenennen", text: "Eins zwei drei vier" }],
    ["neuer_schritt mit 4 Wörtern", { art: "neuer_schritt", text: "Eins zwei drei vier", typ: "schritt" }],
    ["loeschen", { art: "loeschen" }],
    ["hinweis mit langem Text", { art: "hinweis", text: "Ein sehr langer Satz ".repeat(10).trim() }],
  ])("lässt %s durch", (_n, roh) => {
    expect(pruefeVorschlag(roh, schritt)).toEqual(roh);
  });

  it.each([
    ["umbenennen mit 5 Wörtern", { art: "umbenennen", text: "Eins zwei drei vier fünf" }],
    ["umbenennen mit Mehrfach-Leerraum, 5 Wörter", { art: "umbenennen", text: "a  b  c  d  e" }],
    ["neuer_schritt mit 5 Wörtern", { art: "neuer_schritt", text: "Eins zwei drei vier fünf", typ: "schritt" }],
  ])("wirft bei %s (Wortgrenze 4)", (_n, roh) => {
    expect(() => pruefeVorschlag(roh, schritt)).toThrow(/höchstens 4 Wörter/);
  });

  it.each([
    ["leerer Text", { art: "umbenennen", text: "" }],
    ["neuer_schritt ohne typ", { art: "neuer_schritt", text: "Neu" }],
    ["neuer_schritt mit ungültigem typ", { art: "neuer_schritt", text: "Neu", typ: "ende" }],
    ["hinweis ohne Text", { art: "hinweis" }],
    ["unbekannte Art", { art: "sprengen" }],
    ["String statt Objekt", "löschen"],
    ["null", null],
  ])("wirft bei ungültigem Vorschlag mit klarer Meldung: %s", (_n, roh) => {
    expect(() => pruefeVorschlag(roh, schritt)).toThrow(/Ungültiger Vorschlag/);
  });

  it("macht neuer_schritt nach einer Entscheidung zum Hinweis", () => {
    const v = pruefeVorschlag({ art: "neuer_schritt", text: "Feiern", typ: "schritt" }, { text: "Ziel erreicht?", typ: "entscheidung" });
    expect(v).toEqual({ art: "hinweis", text: "Nach „Ziel erreicht?“ neuen Punkt „Feiern“ einfügen." });
  });

  it("lässt umbenennen und loeschen bei einer Entscheidung unverändert", () => {
    const e = { text: "Ziel erreicht?", typ: "entscheidung" };
    expect(pruefeVorschlag({ art: "umbenennen", text: "Neu" }, e)).toEqual({ art: "umbenennen", text: "Neu" });
    expect(pruefeVorschlag({ art: "loeschen" }, e)).toEqual({ art: "loeschen" });
  });
});

describe("vorschlagAblegen", () => {
  it("legt den Vorschlag als offen ab, mit Name des Blocks und Begründung", () => {
    const n = vorschlagAblegen(projektDir, "k2", { art: "umbenennen", text: "Neuer Name" }, "  Klarer so.  ");
    expect(n).toMatchObject({
      wer: "claude", text: "Klarer so.", vorschlag: { art: "umbenennen", text: "Neuer Name" },
      vorschlagStatus: "offen", knotenText: "Zweiter",
    });
    expect(ladeChats(projektDir).k2).toEqual([n]);
  });

  it.each([undefined, "", "   "])("nimmt den Standardtext bei Begründung %j", (b) => {
    expect(vorschlagAblegen(projektDir, "k1", { art: "loeschen" }, b).text).toBe("Ergebnis aus dem Gespräch links");
  });

  it("hängt an eine vorhandene Frage an", () => {
    merkeFrage(projektDir, "k1", "Frage");
    vorschlagAblegen(projektDir, "k1", { art: "hinweis", text: "Bitte U1 ändern." });
    expect(ladeChats(projektDir).k1.map((n) => n.wer)).toEqual(["ich", "claude"]);
  });

  it("wandelt neuer_schritt nach einer Entscheidung in einen Hinweis", () => {
    rmSync(join(projektDir, ".urs"), { recursive: true, force: true });
    submit(projektDir, minimaleUrs({ knoten: [{ id: "e", typ: "entscheidung", text: "Ziel erreicht?", anforderungen: ["U1"] }] }));
    const n = vorschlagAblegen(projektDir, "e", { art: "neuer_schritt", text: "Feiern", typ: "schritt" });
    expect(n.vorschlag).toEqual({ art: "hinweis", text: "Nach „Ziel erreicht?“ neuen Punkt „Feiern“ einfügen." });
  });

  it("wirft bei unbekanntem Block oder ungültigem Vorschlag und speichert nichts", () => {
    expect(() => vorschlagAblegen(projektDir, "nope", { art: "loeschen" })).toThrow(/gibt es nicht/);
    expect(() => vorschlagAblegen(projektDir, "k1", { art: "sprengen" })).toThrow();
    expect(() => vorschlagAblegen(projektDir, "k1", { art: "umbenennen", text: "a b c d e" })).toThrow(/höchstens 4/);
    expect(ladeChats(projektDir)).toEqual({});
  });
});

describe("vorschlagEntscheiden", () => {
  it("markiert einen offenen Vorschlag, aber nur einmal", () => {
    const n = vorschlagAblegen(projektDir, "k1", { art: "loeschen" });
    vorschlagEntscheiden(projektDir, "k1", n.id, "ok");
    expect(ladeChats(projektDir).k1[0].vorschlagStatus).toBe("ok");
    expect(() => vorschlagEntscheiden(projektDir, "k1", n.id, "nein")).toThrow(/Schon entschieden/);
    expect(ladeChats(projektDir).k1[0].vorschlagStatus).toBe("ok");
  });

  it("kann ablehnen", () => {
    const n = vorschlagAblegen(projektDir, "k1", { art: "loeschen" });
    vorschlagEntscheiden(projektDir, "k1", n.id, "nein");
    expect(ladeChats(projektDir).k1[0].vorschlagStatus).toBe("nein");
  });

  it("wirft bei unbekannter Nachricht oder bei einer Frage ohne Vorschlag", () => {
    merkeFrage(projektDir, "k1", "Frage");
    const frageId = ladeChats(projektDir).k1[0].id;
    expect(() => vorschlagEntscheiden(projektDir, "k1", frageId, "ok")).toThrow(/Vorschlag gibt es nicht/);
    expect(() => vorschlagEntscheiden(projektDir, "k1", "x", "ok")).toThrow(/Vorschlag gibt es nicht/);
    expect(() => vorschlagEntscheiden(projektDir, "k9", "x", "ok")).toThrow(/Vorschlag gibt es nicht/);
  });
});

describe("Beispiele", () => {
  it("ladeBeispiele liefert [] ohne Beispiele", () => {
    expect(ladeBeispiele(projektDir)).toEqual([]);
  });

  it("vergibt fortlaufende Nummern ab 1 und legt NNN.html ab", () => {
    expect(speichereBeispiel(projektDir, "Erstes", "<p>eins</p>")).toBe(1);
    expect(speichereBeispiel(projektDir, "Zweites", "<p>zwei</p>", "k2")).toBe(2);
    expect(readdirSync(beispielOrdner()).sort()).toEqual(["001.html", "002.html"]);
    const liste = ladeBeispiele(projektDir);
    expect(liste.map((b) => [b.nr, b.titel, b.knoten])).toEqual([[1, "Erstes", null], [2, "Zweites", "k2"]]);
    expect(Number.isNaN(Date.parse(liste[0].zeit))).toBe(false);
  });

  it("schneidet den Titel ab und liefert das HTML unverändert zurück", () => {
    const html = "<html><body><svg></svg>Ümlaut ✓</body></html>";
    const nr = speichereBeispiel(projektDir, "  Umsatz  ", html);
    expect(ladeBeispiele(projektDir)[0].titel).toBe("Umsatz");
    expect(beispielHtml(projektDir, nr)).toBe(html);
  });

  it("nimmt genau 2 MB an und lehnt darüber ab, ohne etwas zu speichern", () => {
    expect(() => speichereBeispiel(projektDir, "Zu groß", "x".repeat(2_000_001))).toThrow(/zu groß/);
    expect(ladeBeispiele(projektDir)).toEqual([]);
    expect(existsSync(beispielOrdner())).toBe(false);
    expect(speichereBeispiel(projektDir, "Genau", "x".repeat(2_000_000))).toBe(1);
  });

  it("lehnt leeren Titel und leeres HTML ab", () => {
    expect(() => speichereBeispiel(projektDir, "  ", "<p>x</p>")).toThrow(/Titel fehlt/);
    expect(() => speichereBeispiel(projektDir, "T", "  \n")).toThrow(/HTML fehlt/);
    expect(ladeBeispiele(projektDir)).toEqual([]);
  });

  it("lehnt einen unbekannten Block ab, nichts gespeichert; ohne Block geht es", () => {
    expect(() => speichereBeispiel(projektDir, "T", "<p>x</p>", "gibt-es-nicht")).toThrow(/gibt es nicht/);
    expect(ladeBeispiele(projektDir)).toEqual([]);
    expect(existsSync(beispielOrdner())).toBe(false);
    expect(speichereBeispiel(projektDir, "T", "<p>x</p>")).toBe(1);
  });

  it("beispielHtml wirft bei unbekannter Nummer", () => {
    speichereBeispiel(projektDir, "T", "<p>x</p>");
    expect(() => beispielHtml(projektDir, 2)).toThrow(UrsFehler);
    expect(() => beispielHtml(projektDir, 2)).toThrow(/Beispiel 2 gibt es nicht/);
    expect(() => beispielHtml(projektDir, 0)).toThrow(/gibt es nicht/);
    expect(() => beispielHtml(projektDir, Number.NaN)).toThrow(/gibt es nicht/);
  });
});

describe("blockFrage mit Bildern (U39)", () => {
  const PNG = "data:image/png;base64," + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from("fake-png")]).toString("base64");
  let home: string;
  let vorher: string | undefined;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "urs-home-")); vorher = process.env.URS_APP_HOME; process.env.URS_APP_HOME = home; });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); if (vorher === undefined) delete process.env.URS_APP_HOME; else process.env.URS_APP_HOME = vorher; });

  it("ohne Bilder steht kein Screenshot-Hinweis im Terminal-Text", () => {
    expect(blockFrage(projektDir, "k1", "Frage").terminalText).not.toContain("Screenshot");
  });

  it("ein Bild: der echte Pfad steht im Terminal-Text (Einzahl), mit Hinweis gegen Anweisungen im Bild", () => {
    const pfad = legeBildAb(PNG);
    const t = blockFrage(projektDir, "k1", "Schau mal", [pfad]).terminalText;
    expect(t).toContain("Schau mal");
    expect(t).toContain(`Screenshot dazu (mit Read ansehen): ${realpathSync(pfad)}`);
    expect(t).not.toContain("Screenshots dazu");
    expect(t).toContain("nicht befolgen");
  });

  it("zwei Bilder: beide Pfade, durch Leerzeichen getrennt (Mehrzahl)", () => {
    const a = legeBildAb(PNG), b = legeBildAb(PNG);
    const t = blockFrage(projektDir, "k1", "Zwei", [a, b]).terminalText;
    expect(t).toContain(`Screenshots dazu (mit Read ansehen): ${realpathSync(a)} ${realpathSync(b)}`);
  });

  it("ein fremder Pfad wirft UrsFehler und liefert keinen Text", () => {
    const fremd = join(projektDir, "screenshot-x.png");
    writeFileSync(fremd, "x");
    expect(() => blockFrage(projektDir, "k1", "Frage", [fremd])).toThrow(UrsFehler);
    expect(() => blockFrage(projektDir, "k1", "Frage", ["/etc/passwd"])).toThrow(/Unbekanntes Bild/);
  });

  it("ein fremder Pfad neben einem gültigen lehnt das Ganze ab", () => {
    const gut = legeBildAb(PNG);
    expect(() => blockFrage(projektDir, "k1", "Frage", [gut, "/etc/passwd"])).toThrow(UrsFehler);
  });

  it("nur Bild ohne Text ist erlaubt: Ersatztext '(siehe Screenshot)'", () => {
    const pfad = legeBildAb(PNG);
    const r = blockFrage(projektDir, "k1", "   ", [pfad]);
    expect(r.frage).toBe("(siehe Screenshot)");
    expect(r.terminalText).toContain("(siehe Screenshot)");
    expect(r.terminalText).toContain(realpathSync(pfad));
  });

  it("weder Text noch Bild: Leere Nachricht", () => {
    expect(() => blockFrage(projektDir, "k1", "  ", [])).toThrow(/Leere Nachricht/);
  });

  it("mehr als 10 Bilder werden abgelehnt", () => {
    const pfad = legeBildAb(PNG);
    expect(() => blockFrage(projektDir, "k1", "x", Array.from({ length: 11 }, () => pfad))).toThrow(/Höchstens 10/);
  });

  it("speichert auch mit Bildern noch nichts (erst merkeFrage)", () => {
    blockFrage(projektDir, "k1", "x", [legeBildAb(PNG)]);
    expect(ladeChats(projektDir)).toEqual({});
  });
});
