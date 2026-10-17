import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { starteServer } from "../src/server.ts";
import { anmelden, freigabeBestaetigt, freigeben, neuerEntwurf, pfadVon, projektId } from "../src/store.ts";
import { hinweisAnChats, umziehenTerminal, umzugAbgebrochen, umzugFertig } from "../src/terminal.ts";
import { minimaleUrs, submitOk } from "./fixtures.ts";

// Kein echtes claude: das Terminal ist nur ein Spion.
vi.mock("../src/terminal.ts", () => ({
  verbindeTerminal: vi.fn(),
  beendeTerminals: vi.fn(),
  chatSchliessen: vi.fn(),
  GUELTIGER_CHAT: /^[a-z0-9-]{1,40}$/,
  beendeTerminal: vi.fn(),
  phaseAbgleichen: vi.fn(),
  anzahlTerminals: vi.fn(() => 0),
  terminalLaeuft: vi.fn(() => false),
  hatChats: vi.fn(() => false),
  hinweisAnChats: vi.fn(),
  umziehenTerminal: vi.fn(async () => []),
  umzugAbgebrochen: vi.fn(),
  umzugFertig: vi.fn(),
}));

const PORT = 18893;
const ORIGIN = `http://127.0.0.1:${PORT}`;
let server: Server;
let appHomeDir: string;
const aufraeumen: string[] = [];

type Antwort = { status: number; text: string; json: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
function rohAnfrage(o: { pfad: string; methode?: string; headers?: Record<string, string>; body?: unknown }) {
  return new Promise<Antwort>((ok, nein) => {
    const req = httpRequest({
      hostname: "127.0.0.1", port: PORT, path: o.pfad, method: o.methode ?? "GET",
      headers: { host: `127.0.0.1:${PORT}`, ...o.headers },
    }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        let json: unknown = null;
        try { json = JSON.parse(body); } catch { /* kein JSON */ }
        ok({ status: res.statusCode ?? 0, text: body, json });
      });
    });
    req.on("error", nein);
    req.end(o.body === undefined ? undefined : JSON.stringify(o.body));
  });
}
const post = (pfad: string, body: unknown, headers: Record<string, string> = {}) =>
  rohAnfrage({ pfad, methode: "POST", body, headers: { "content-type": "application/json", origin: ORIGIN, ...headers } });

const neuerOrdner = (name = "ziel") => {
  const d = mkdtempSync(join(tmpdir(), `urs-${name}-`));
  aufraeumen.push(d);
  return d;
};
type Zeile = { id: string; ohneOrdner: boolean; version: number | null };
const uebersicht = async () => (await rohAnfrage({ pfad: "/api/uebersicht" })).json as Zeile[];

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
  vi.mocked(umziehenTerminal).mockReset().mockImplementation(async () => []);
  vi.mocked(umzugFertig).mockClear();
  vi.mocked(umzugAbgebrochen).mockClear();
  vi.mocked(hinweisAnChats).mockClear();
});

describe("U77: POST /api/neuer-entwurf", () => {
  it("liefert eine id, die auf einen Ordner unter entwuerfe zeigt", async () => {
    const res = await post("/api/neuer-entwurf", {});
    expect(res.status).toBe(200);
    expect(typeof res.json.id).toBe("string");
    const pfad = pfadVon(res.json.id)!;
    expect(pfad.startsWith(join(appHomeDir, "entwuerfe") + "/")).toBe(true);
    expect(existsSync(pfad)).toBe(true);
  });

  it("/api/uebersicht zeigt den Entwurf mit ohneOrdner=true, einen normalen Ordner mit false", async () => {
    const { json: { id } } = await post("/api/neuer-entwurf", {});
    const normal = anmelden(neuerOrdner("normal"));
    const liste = await uebersicht();
    expect(liste.find((o) => o.id === id)).toMatchObject({ ohneOrdner: true, version: null });
    expect(liste.find((o) => o.id === normal)).toMatchObject({ ohneOrdner: false });
  });

  it("lehnt ohne Origin ab (403) und legt nichts an", async () => {
    const vorher = (await uebersicht()).length;
    const res = await rohAnfrage({ pfad: "/api/neuer-entwurf", methode: "POST", body: {}, headers: { "content-type": "application/json" } });
    expect(res.status).toBe(403);
    expect((await uebersicht()).length).toBe(vorher);
  });
});

describe("U78: POST /api/p/:id/freigeben", () => {
  it("Entwurf: gibt frei und zeigt in den Chats den Ordner-wählen-Hinweis", async () => {
    const id = neuerEntwurf();
    submitOk(pfadVon(id)!, minimaleUrs());
    const res = await post(`/api/p/${id}/freigeben`, { version: 1 });
    expect(res.status).toBe(200);
    expect(hinweisAnChats).toHaveBeenCalledTimes(1);
    expect(vi.mocked(hinweisAnChats).mock.calls[0][0]).toBe(id);
    expect(vi.mocked(hinweisAnChats).mock.calls[0][1]).toMatch(/Ordner wählen/);
  });

  it("normaler Ordner: gibt frei, aber kein Ordner-Hinweis", async () => {
    const d = neuerOrdner("normal");
    const id = anmelden(d);
    submitOk(d, minimaleUrs());
    expect((await post(`/api/p/${id}/freigeben`, { version: 1 })).status).toBe(200);
    expect(freigabeBestaetigt(d)).toBe(true);
    expect(hinweisAnChats).not.toHaveBeenCalled();
  });
});

describe("U79: POST /api/p/:id/umziehen", () => {
  /** Freigegebener Entwurf mit Ablauf. */
  const entwurf = () => {
    const id = neuerEntwurf();
    const pfad = pfadVon(id)!;
    submitOk(pfad, minimaleUrs());
    freigeben(pfad, 1);
    return { id, pfad };
  };

  it("zieht um: liefert die neue id, .urs liegt im Ziel, Entwurf weg, Nachweis folgt", async () => {
    const { id, pfad } = entwurf();
    const ziel = neuerOrdner();
    const res = await post(`/api/p/${id}/umziehen`, { pfad: ziel });
    expect(res.status).toBe(200);
    expect(res.json.id).toBe(projektId(ziel));
    expect(existsSync(join(ziel, ".urs", "v001.json"))).toBe(true);
    expect(pfadVon(id)).toBeNull();
    expect(existsSync(pfad)).toBe(false);
    expect(freigabeBestaetigt(ziel)).toBe(true);
    expect(umzugAbgebrochen).not.toHaveBeenCalled();
    expect(umzugFertig).toHaveBeenCalledWith(id, projektId(ziel), []);
    const liste = await uebersicht();
    expect(liste.some((o) => o.id === id)).toBe(false);
    expect(liste.find((o) => o.id === res.json.id)).toMatchObject({ ohneOrdner: false, version: 1 });
  });

  it("ruft umziehenTerminal mit alten und neuen Werten auf, solange .urs noch im Entwurf liegt", async () => {
    const { id, pfad } = entwurf();
    const ziel = neuerOrdner();
    let ursNochImEntwurf: boolean | null = null;
    vi.mocked(umziehenTerminal).mockImplementation(async () => { ursNochImEntwurf = existsSync(join(pfad, ".urs")); return []; });
    await post(`/api/p/${id}/umziehen`, { pfad: ziel });
    expect(umziehenTerminal).toHaveBeenCalledTimes(1);
    expect(umziehenTerminal).toHaveBeenCalledWith(id, pfad, projektId(ziel), ziel);
    expect(ursNochImEntwurf).toBe(true);
  });

  it("scheitert der Umzug nach dem Anhalten der Chats: umzugAbgebrochen, Fehlerstatus, Entwurf unverändert", async () => {
    const { id, pfad } = entwurf();
    const ziel = neuerOrdner();
    // Zwischen Prüfung und Verschieben taucht im Ziel ein Ablauf auf.
    vi.mocked(umziehenTerminal).mockImplementation(async () => { submitOk(ziel, minimaleUrs({ name: "Dazwischen" })); return []; });
    const res = await post(`/api/p/${id}/umziehen`, { pfad: ziel });
    expect(res.status).toBe(409);
    expect(umziehenTerminal).toHaveBeenCalledTimes(1);
    expect(umzugAbgebrochen).toHaveBeenCalledWith(id, []);
    expect(umzugFertig).not.toHaveBeenCalled();
    expect(pfadVon(id)).toBe(pfad);
    expect(existsSync(join(pfad, ".urs", "v001.json"))).toBe(true);
    expect(freigabeBestaetigt(pfad)).toBe(true);
  });

  it.each([
    ["Ziel hat schon .urs", (): string => { const z = neuerOrdner(); submitOk(z, minimaleUrs()); return z; }],
    ["Ziel fehlt", (): string => join(appHomeDir, "gibt-es-nicht")],
    ["Ziel liegt in entwuerfe", (): string => pfadVon(neuerEntwurf())!],
    ["Ziel relativ", (): string => "irgendwo/relativ"],
  ] as const)("%s: Fehler, Chats werden gar nicht erst angehalten, nichts verändert", async (_n, ziel) => {
    const { id, pfad } = entwurf();
    const res = await post(`/api/p/${id}/umziehen`, { pfad: ziel() });
    expect(res.status).toBe(409);
    expect(umziehenTerminal).not.toHaveBeenCalled();
    expect(umzugAbgebrochen).not.toHaveBeenCalled();
    expect(pfadVon(id)).toBe(pfad);
    expect(existsSync(join(pfad, ".urs", "v001.json"))).toBe(true);
  });

  it("Quelle ist ein normaler Ordner: Fehler, nichts verändert", async () => {
    const quelle = neuerOrdner("quelle");
    const qid = anmelden(quelle);
    submitOk(quelle, minimaleUrs());
    const res = await post(`/api/p/${qid}/umziehen`, { pfad: neuerOrdner() });
    expect(res.status).toBe(409);
    expect(umziehenTerminal).not.toHaveBeenCalled();
    expect(existsSync(join(quelle, ".urs", "v001.json"))).toBe(true);
    expect(pfadVon(qid)).toBe(quelle);
  });

  it.each([["pfad fehlt", {}], ["leerer pfad", { pfad: "" }], ["pfad ist Zahl", { pfad: 5 }]])("liefert 400 bei %s", async (_n, body) => {
    const { id } = entwurf();
    expect((await post(`/api/p/${id}/umziehen`, body)).status).toBe(400);
    expect(umziehenTerminal).not.toHaveBeenCalled();
  });

  it("ohne Origin: 403, nichts passiert", async () => {
    const { id, pfad } = entwurf();
    const res = await rohAnfrage({ pfad: `/api/p/${id}/umziehen`, methode: "POST", body: { pfad: neuerOrdner() }, headers: { "content-type": "application/json" } });
    expect(res.status).toBe(403);
    expect(umziehenTerminal).not.toHaveBeenCalled();
    expect(pfadVon(id)).toBe(pfad);
  });
});

describe("POST /api/p/:id/chat-schliessen auf leerem Entwurf", () => {
  it("entfernt einen Entwurf ohne .urs aus der Übersicht", async () => {
    const id = neuerEntwurf();
    const pfad = pfadVon(id)!;
    expect((await uebersicht()).some((o) => o.id === id)).toBe(true);
    const res = await post(`/api/p/${id}/chat-schliessen`, { chat: "abc123" });
    expect(res.status).toBe(200);
    expect((await uebersicht()).some((o) => o.id === id)).toBe(false);
    expect(pfadVon(id)).toBeNull();
    expect(existsSync(pfad)).toBe(false);
  });

  it("behält einen Entwurf mit Ablauf", async () => {
    const id = neuerEntwurf();
    submitOk(pfadVon(id)!, minimaleUrs());
    await post(`/api/p/${id}/chat-schliessen`, { chat: "abc123" });
    expect((await uebersicht()).some((o) => o.id === id)).toBe(true);
  });

  it("behält einen normalen Ordner ohne Ablauf", async () => {
    const d = neuerOrdner("normal");
    const id = anmelden(d);
    await post(`/api/p/${id}/chat-schliessen`, { chat: "abc123" });
    expect(pfadVon(id)).toBe(d);
    expect((await uebersicht()).some((o) => o.id === id)).toBe(true);
  });
});
