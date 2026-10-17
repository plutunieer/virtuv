import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pruefeEinrichtungGepuffert } from "../src/einrichtung.ts";
import { starteServer } from "../src/server.ts";
import { anmelden, ladeArbeit, speichereArbeit, submit } from "../src/store.ts";
import { terminalLaeuft } from "../src/terminal.ts";
import { minimaleUrs, ursMitZweiPunkten } from "./fixtures.ts";

// Kein echtes claude: Terminal und Einrichtungs-Prüfung sind gespielt.
vi.mock("../src/terminal.ts", () => ({
  verbindeTerminal: vi.fn(),
  beendeTerminals: vi.fn(),
  chatSchliessen: vi.fn(),
  GUELTIGER_CHAT: /^[a-z0-9-]{1,40}$/,
  beendeTerminal: vi.fn(),
  phaseAbgleichen: vi.fn(),
  anzahlTerminals: vi.fn(() => 0),
  schreibeInTerminal: vi.fn(() => "aus"),
  terminalLaeuft: vi.fn(() => false),
}));
vi.mock("../src/einrichtung.ts", () => ({ pruefeEinrichtungGepuffert: vi.fn() }));

const PORT = 18894;
let server: Server;
let appHomeDir: string;
const aufraeumen: string[] = [];

type Antwort = { status: number; json: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
function roh(pfad: string, headers: Record<string, string> = {}) {
  return new Promise<Antwort>((ok, nein) => {
    const req = httpRequest({
      hostname: "127.0.0.1", port: PORT, path: pfad, method: "GET",
      headers: { host: `127.0.0.1:${PORT}`, ...headers },
    }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        let json: unknown = null;
        try { json = JSON.parse(body); } catch { /* kein JSON */ }
        ok({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("error", nein);
    req.end();
  });
}

const neuerOrdner = (name = "proj") => {
  const d = mkdtempSync(join(tmpdir(), `urs-${name}-`));
  aufraeumen.push(d);
  return d;
};

type Zeile = {
  id: string; pfad: string; name: string; version: number | null; status: string | null;
  fragen: number; anzahl: number; bloecke: string[]; laeuft: boolean;
};
const uebersicht = async () => (await roh("/api/uebersicht")).json as Zeile[];

beforeAll(async () => {
  appHomeDir = mkdtempSync(join(tmpdir(), "urs-home-"));
  process.env.URS_APP_HOME = appHomeDir;
  server = await starteServer(PORT);
});

afterAll(() => {
  server.close();
  server.closeAllConnections();
  for (const d of [appHomeDir, ...aufraeumen]) rmSync(d, { recursive: true, force: true });
  delete process.env.URS_APP_HOME;
});

beforeEach(() => {
  vi.mocked(terminalLaeuft).mockReset().mockReturnValue(false);
  vi.mocked(pruefeEinrichtungGepuffert).mockReset();
});

describe("GET /api/uebersicht", () => {
  it("Ordner ohne URS: fragen 0, anzahl 0, bloecke [], version/status null", async () => {
    const d = neuerOrdner("ohne");
    const id = anmelden(d);
    const z = (await uebersicht()).find((o) => o.id === id)!;
    expect(z).toMatchObject({ pfad: d, version: null, status: null, fragen: 0, anzahl: 0, bloecke: [], laeuft: false });
  });

  it("Ordner mit URS: Felder aus alleOrdner plus anzahl und bloecke (ohne Fragen: 0)", async () => {
    const d = neuerOrdner("mit");
    const id = anmelden(d);
    submit(d, ursMitZweiPunkten());
    const z = (await uebersicht()).find((o) => o.id === id)!;
    expect(z).toMatchObject({
      pfad: d, name: "Testprojekt", version: 1, status: "entwurf",
      fragen: 0, anzahl: 2, bloecke: ["Start", "Zweiter"], laeuft: false,
    });
  });

  it("fragen zählt nur unbeantwortete (leer und nur Leerzeichen gelten als offen)", async () => {
    const d = neuerOrdner("fragen");
    const id = anmelden(d);
    submit(d, minimaleUrs({ fragen: [{ id: "F1", text: "Eins?" }, { id: "F2", text: "Zwei?" }, { id: "F3", text: "Drei?" }] }));
    expect((await uebersicht()).find((o) => o.id === id)!.fragen).toBe(3);
    const a = ladeArbeit(d);
    speichereArbeit(d, { ...a, antworten: { F1: "ja", F2: "   " } });
    expect((await uebersicht()).find((o) => o.id === id)!.fragen).toBe(2);
  });

  it("bloecke: höchstens 6 (die ersten, in Reihenfolge), anzahl ist die volle Zahl", async () => {
    const d = neuerOrdner("viele");
    const id = anmelden(d);
    const knoten = Array.from({ length: 8 }, (_, i) => ({
      id: `k${i + 1}`, typ: (i === 0 ? "start" : "schritt") as "start" | "schritt", text: `Block ${i + 1}`, anforderungen: [`U${i + 1}`],
    }));
    submit(d, minimaleUrs({ anforderungen: knoten.map((_, i) => ({ id: `U${i + 1}`, text: `Satz ${i + 1}.`, prio: "muss" as const })), knoten }));
    const z = (await uebersicht()).find((o) => o.id === id)!;
    expect(z.anzahl).toBe(8);
    expect(z.bloecke).toEqual(["Block 1", "Block 2", "Block 3", "Block 4", "Block 5", "Block 6"]);
  });

  it("laeuft kommt aus terminalLaeuft(id) — je Ordner einzeln", async () => {
    const idA = anmelden(neuerOrdner("lauf"));
    const idB = anmelden(neuerOrdner("steht"));
    vi.mocked(terminalLaeuft).mockImplementation((tid: string) => tid === idA);
    const liste = await uebersicht();
    expect(liste.find((o) => o.id === idA)!.laeuft).toBe(true);
    expect(liste.find((o) => o.id === idB)!.laeuft).toBe(false);
  });

  it("kaputte arbeit.json: Eintrag bleibt in der Liste, fragen 0, bloecke []", async () => {
    const d = neuerOrdner("kaputt");
    const id = anmelden(d);
    submit(d, ursMitZweiPunkten());
    writeFileSync(join(d, ".urs", "arbeit.json"), "{ das ist kaputt");
    const res = await roh("/api/uebersicht");
    expect(res.status).toBe(200);
    expect((res.json as Zeile[]).find((o) => o.id === id)).toMatchObject({ fragen: 0, anzahl: 0, bloecke: [], version: 1 });
  });

  it("kaputte projekt.json reißt die Liste nicht mit: Ordner ohne Stand, andere Projekte bleiben", async () => {
    const gut = neuerOrdner("gut");
    const idGut = anmelden(gut);
    submit(gut, ursMitZweiPunkten());
    const schlecht = neuerOrdner("schlecht");
    const idSchlecht = anmelden(schlecht);
    submit(schlecht, ursMitZweiPunkten());
    writeFileSync(join(schlecht, ".urs", "projekt.json"), "kaputt");
    const res = await roh("/api/uebersicht");
    expect(res.status).toBe(200);
    const liste = res.json as Zeile[];
    expect(liste.find((o) => o.id === idSchlecht)).toMatchObject({ version: null, status: null });
    expect(liste.find((o) => o.id === idGut)).toMatchObject({ version: 1 });
  });

  it("lässt Ordner weg, die es nicht mehr gibt (wie /api/ordner)", async () => {
    const d = neuerOrdner("weg");
    const id = anmelden(d);
    rmSync(d, { recursive: true, force: true });
    expect((await uebersicht()).some((o) => o.id === id)).toBe(false);
  });

  it("fremder Host: 403", async () => {
    expect((await roh("/api/uebersicht", { host: "evil.example.com:9999" })).status).toBe(403);
  });
});

describe("GET /api/einrichtung", () => {
  it("liefert JSON mit genau den vier Feldern aus der Prüfung (auch ohne Origin)", async () => {
    const e = { claude: true, angemeldet: true, abo: true, hinweis: "Alles bereit." };
    vi.mocked(pruefeEinrichtungGepuffert).mockResolvedValue(e);
    const res = await roh("/api/einrichtung");
    expect(res.status).toBe(200);
    expect(res.json).toEqual(e);
  });

  it("fremder Host: 403, Prüfung läuft nicht", async () => {
    expect((await roh("/api/einrichtung", { host: "evil.example.com:9999" })).status).toBe(403);
    expect(pruefeEinrichtungGepuffert).not.toHaveBeenCalled();
  });
});
