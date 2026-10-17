import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { starteServer } from "../src/server.ts";
import { anmelden, pfadVon, projektId, submit } from "../src/store.ts";
import { beendeTerminal, verbindeTerminal } from "../src/terminal.ts";
import { ursMitZweiPunkten } from "./fixtures.ts";

// Das Terminal startet ein echtes claude in einem Pseudo-Terminal — hier nur ein Spion, nie die echte Datei.
vi.mock("../src/terminal.ts", () => ({
  verbindeTerminal: vi.fn(),
  beendeTerminals: vi.fn(),
  chatSchliessen: vi.fn(),
  GUELTIGER_CHAT: /^[a-z0-9-]{1,40}$/,
  beendeTerminal: vi.fn(),
  phaseAbgleichen: vi.fn(),
  anzahlTerminals: vi.fn(() => 0),
}));

const PORT = 18892;
const ORIGIN = `http://127.0.0.1:${PORT}`;
let server: Server;
let appHomeDir: string;
let fakeHome: string;
let homeVorher: string | undefined;
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

/** POST mit passendem Origin und JSON — so wie die eigene Seite. */
const post = (pfad: string, body: unknown, headers: Record<string, string> = {}) =>
  rohAnfrage({ pfad, methode: "POST", body, headers: { "content-type": "application/json", origin: ORIGIN, ...headers } });

const neuerOrdner = (name = "proj") => {
  const d = mkdtempSync(join(tmpdir(), `urs-${name}-`));
  aufraeumen.push(d);
  return d;
};

beforeAll(async () => {
  appHomeDir = mkdtempSync(join(tmpdir(), "urs-home-"));
  fakeHome = mkdtempSync(join(tmpdir(), "urs-fakehome-"));
  homeVorher = process.env.HOME;
  process.env.URS_APP_HOME = appHomeDir;
  process.env.HOME = fakeHome; // damit "~" in den Tests auf einen Wegwerf-Ordner zeigt
  server = await starteServer(PORT);
});

afterAll(() => {
  server.close();
  server.closeAllConnections();
  for (const d of [appHomeDir, fakeHome, ...aufraeumen]) rmSync(d, { recursive: true, force: true });
  delete process.env.URS_APP_HOME;
  if (homeVorher === undefined) delete process.env.HOME; else process.env.HOME = homeVorher;
});

beforeEach(() => { vi.mocked(verbindeTerminal).mockClear(); });

describe("GET /api/ordner", () => {
  it("liefert eingetragene Ordner mit und ohne URS (auch ohne Origin)", async () => {
    const ohne = neuerOrdner("ohne");
    const mit = neuerOrdner("mit");
    const idOhne = anmelden(ohne);
    const idMit = anmelden(mit);
    submit(mit, ursMitZweiPunkten());

    const res = await rohAnfrage({ pfad: "/api/ordner" });
    expect(res.status).toBe(200);
    const liste = res.json as { id: string; pfad: string; name: string; version: number | null; status: string | null }[];
    expect(liste.find((o) => o.id === idOhne)).toMatchObject({ pfad: ohne, version: null, status: null });
    expect(liste.find((o) => o.id === idOhne)!.name).toBe(ohne.split("/").pop());
    expect(liste.find((o) => o.id === idMit)).toMatchObject({ pfad: mit, name: "Testprojekt", version: 1, status: "entwurf" });
  });

  it("lässt Ordner weg, die es nicht mehr gibt", async () => {
    const weg = neuerOrdner("weg");
    const id = anmelden(weg);
    rmSync(weg, { recursive: true, force: true });
    const liste = (await rohAnfrage({ pfad: "/api/ordner" })).json as { id: string }[];
    expect(liste.some((o) => o.id === id)).toBe(false);
  });

  it("lehnt einen fremden Host ab (403)", async () => {
    expect((await rohAnfrage({ pfad: "/api/ordner", headers: { host: "evil.example.com:9999" } })).status).toBe(403);
  });
});

describe("POST /api/oeffnen", () => {
  it("trägt einen absoluten Ordner ein und liefert die ID", async () => {
    const d = neuerOrdner();
    const res = await post("/api/oeffnen", { pfad: d });
    expect(res.status).toBe(200);
    expect(res.json.id).toBe(projektId(d));
    expect(pfadVon(res.json.id)).toBe(d);
  });

  it("ersetzt ~/ durch das Home-Verzeichnis und schneidet Leerraum ab", async () => {
    mkdirSync(join(fakeHome, "meinprojekt"));
    const res = await post("/api/oeffnen", { pfad: "  ~/meinprojekt  " });
    expect(res.status).toBe(200);
    expect(pfadVon(res.json.id)).toBe(join(fakeHome, "meinprojekt"));
  });

  it("öffnet einen Ordner, dessen Name mit Leerzeichen endet (U36)", async () => {
    mkdirSync(join(fakeHome, "FINE Tune LLM "));
    const res = await post("/api/oeffnen", { pfad: join(fakeHome, "FINE Tune LLM ") });
    expect(res.status).toBe(200);
    expect(pfadVon(res.json.id)).toBe(join(fakeHome, "FINE Tune LLM "));
  });

  it("öffnet einen Ordner, dessen Name mit Leerzeichen beginnt (U36)", async () => {
    mkdirSync(join(fakeHome, " vorne"));
    const res = await post("/api/oeffnen", { pfad: join(fakeHome, " vorne") });
    expect(res.status).toBe(200);
    expect(pfadVon(res.json.id)).toBe(join(fakeHome, " vorne"));
  });

  it("bevorzugt den exakten Namen, wenn es auch die Variante ohne Leerzeichen gibt (U36)", async () => {
    mkdirSync(join(fakeHome, "dopp"));
    mkdirSync(join(fakeHome, "dopp "));
    const mit = await post("/api/oeffnen", { pfad: join(fakeHome, "dopp ") });
    expect(pfadVon(mit.json.id)).toBe(join(fakeHome, "dopp "));
    const ohne = await post("/api/oeffnen", { pfad: join(fakeHome, "dopp") });
    expect(pfadVon(ohne.json.id)).toBe(join(fakeHome, "dopp"));
    expect(mit.json.id).not.toBe(ohne.json.id);
  });

  it("öffnet ~/Ordner mit Leerzeichen am Ende (U36)", async () => {
    mkdirSync(join(fakeHome, "tilde "));
    const res = await post("/api/oeffnen", { pfad: "~/tilde " });
    expect(res.status).toBe(200);
    expect(pfadVon(res.json.id)).toBe(join(fakeHome, "tilde "));
  });

  it("schneidet eingetippten Leerraum auch bei absolutem Pfad ab, wenn der Ordner so nicht existiert", async () => {
    const d = neuerOrdner();
    const res = await post("/api/oeffnen", { pfad: `  ${d}  ` });
    expect(res.status).toBe(200);
    expect(pfadVon(res.json.id)).toBe(d);
  });

  it("meldet 409 und trägt nichts ein, wenn weder die exakte noch die getrimmte Variante existiert", async () => {
    const res = await post("/api/oeffnen", { pfad: join(fakeHome, "nirgends ") });
    expect(res.status).toBe(409);
    expect(pfadVon(projektId(join(fakeHome, "nirgends ")))).toBeNull();
    expect(pfadVon(projektId(join(fakeHome, "nirgends")))).toBeNull();
  });

  it("versteht ~ allein als Home-Verzeichnis", async () => {
    const res = await post("/api/oeffnen", { pfad: "~" });
    expect(res.status).toBe(200);
    expect(pfadVon(res.json.id)).toBe(fakeHome);
  });

  it("meldet einen nicht existierenden Ordner als Fehler (409) und trägt nichts ein", async () => {
    const res = await post("/api/oeffnen", { pfad: "~/gibt-es-nicht" });
    expect(res.status).toBe(409);
    expect(res.json.fehler).toMatch(/Ordner gibt es nicht/);
    expect(pfadVon(projektId(join(fakeHome, "gibt-es-nicht")))).toBeNull();
  });

  it("lehnt einen relativen Pfad ab (409)", async () => {
    const res = await post("/api/oeffnen", { pfad: "irgendwo/relativ" });
    expect(res.status).toBe(409);
    expect(res.json.fehler).toMatch(/absolut/);
  });

  it("expandiert nur ~ am Anfang, nicht ~name (bleibt relativ → 409)", async () => {
    expect((await post("/api/oeffnen", { pfad: "~meinprojekt" })).status).toBe(409);
  });

  it("lehnt eine Datei statt eines Ordners ab (409)", async () => {
    expect((await post("/api/oeffnen", { pfad: join(import.meta.dirname, "server-werkbank.test.ts") })).status).toBe(409);
  });

  it.each([
    ["leerer Pfad", { pfad: "" }],
    ["Pfad fehlt", {}],
    ["Pfad ist eine Zahl", { pfad: 5 }],
    ["Pfad über 1000 Zeichen", { pfad: "/" + "a".repeat(1000) }],
  ])("liefert 400 bei %s", async (_n, body) => {
    expect((await post("/api/oeffnen", body)).status).toBe(400);
  });

  it("lehnt ohne Origin ab (403) und trägt nichts ein", async () => {
    const d = neuerOrdner();
    const res = await rohAnfrage({ pfad: "/api/oeffnen", methode: "POST", body: { pfad: d }, headers: { "content-type": "application/json" } });
    expect(res.status).toBe(403);
    expect(pfadVon(projektId(d))).toBeNull();
  });

  it("lehnt einen fremden Origin ab (403)", async () => {
    expect((await post("/api/oeffnen", { pfad: neuerOrdner() }, { origin: "http://evil.example.com" })).status).toBe(403);
  });
});

describe("WebSocket /term", () => {
  /** "offen" = Verbindung steht, "abgewiesen" = Fehler/Schließen vor dem Öffnen. */
  const verbinde = (pfad: string, headers: Record<string, string> = {}) =>
    new Promise<"offen" | "abgewiesen">((ok) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}${pfad}`, { headers });
      ws.once("open", () => { ws.close(); ok("offen"); });
      ws.once("error", () => ok("abgewiesen"));
      ws.once("close", () => ok("abgewiesen"));
    });

  let id: string;
  beforeEach(() => { id = anmelden(neuerOrdner("term")); });

  it("weist eine Verbindung ohne Origin ab und startet kein Terminal", async () => {
    expect(await verbinde(`/term?p=${id}`)).toBe("abgewiesen");
    expect(verbindeTerminal).not.toHaveBeenCalled();
  });

  it("weist einen fremden Origin ab", async () => {
    expect(await verbinde(`/term?p=${id}`, { origin: "http://evil.example.com" })).toBe("abgewiesen");
    expect(verbindeTerminal).not.toHaveBeenCalled();
  });

  it("weist eine Verbindung mit fremdem Host ab, auch bei richtigem Origin", async () => {
    expect(await verbinde(`/term?p=${id}`, { origin: ORIGIN, host: "evil.example.com:9999" })).toBe("abgewiesen");
    expect(verbindeTerminal).not.toHaveBeenCalled();
  });

  it("weist ein unbekanntes Projekt und fehlendes p ab", async () => {
    expect(await verbinde("/term?p=gibt-es-nicht", { origin: ORIGIN })).toBe("abgewiesen");
    expect(await verbinde("/term", { origin: ORIGIN })).toBe("abgewiesen");
    expect(verbindeTerminal).not.toHaveBeenCalled();
  });

  it("weist /ws ohne Origin weiterhin ab", async () => {
    expect(await verbinde(`/ws?p=${id}`)).toBe("abgewiesen");
  });

  it("Gegenprobe: mit richtigem Origin und bekanntem Projekt wird das (gespielte) Terminal verbunden", async () => {
    expect(await verbinde(`/term?p=${id}`, { origin: ORIGIN })).toBe("offen");
    expect(verbindeTerminal).toHaveBeenCalledTimes(1);
    expect(vi.mocked(verbindeTerminal).mock.calls[0][1]).toBe(id);
    expect(vi.mocked(verbindeTerminal).mock.calls[0][2]).toBe(pfadVon(id));
  });
});

describe("POST /api/entfernen", () => {
  const ordnerIds = async () => ((await rohAnfrage({ pfad: "/api/ordner" })).json as { id: string }[]).map((o) => o.id);
  beforeEach(() => { vi.mocked(beendeTerminal).mockClear(); });

  it("entfernt das Projekt: 200, fehlt danach in /api/ordner, Terminal beendet, Ordner bleibt", async () => {
    const d = neuerOrdner("entf");
    const id = anmelden(d);
    submit(d, ursMitZweiPunkten());
    expect(await ordnerIds()).toContain(id);
    const res = await post("/api/entfernen", { id });
    expect(res.status).toBe(200);
    expect(await ordnerIds()).not.toContain(id);
    expect(beendeTerminal).toHaveBeenCalledWith(id);
    expect(existsSync(join(d, ".urs", "v001.json"))).toBe(true);
  });

  it("Roundtrip: nach /api/oeffnen ist das Projekt mit URS wieder da", async () => {
    const d = neuerOrdner("zurueck");
    const id = anmelden(d);
    submit(d, ursMitZweiPunkten());
    await post("/api/entfernen", { id });
    expect((await post("/api/oeffnen", { pfad: d })).json.id).toBe(id);
    const liste = (await rohAnfrage({ pfad: "/api/ordner" })).json as { id: string; version: number | null }[];
    expect(liste.find((o) => o.id === id)).toMatchObject({ version: 1 });
  });

  it("unbekannte id: 404, kein Terminal beendet", async () => {
    expect((await post("/api/entfernen", { id: "gibt-es-nicht" })).status).toBe(404);
    expect(beendeTerminal).not.toHaveBeenCalled();
  });

  it("ohne Origin oder mit fremdem Origin: 403, nichts entfernt", async () => {
    const id = anmelden(neuerOrdner());
    expect((await rohAnfrage({ pfad: "/api/entfernen", methode: "POST", body: { id }, headers: { "content-type": "application/json" } })).status).toBe(403);
    expect((await post("/api/entfernen", { id }, { origin: "http://evil.example.com" })).status).toBe(403);
    expect(pfadVon(id)).not.toBeNull();
    expect(beendeTerminal).not.toHaveBeenCalled();
  });

  it.each([["id fehlt", {}], ["leere id", { id: "" }], ["id ist eine Zahl", { id: 5 }], ["id über 200 Zeichen", { id: "a".repeat(201) }]])(
    "liefert 400 bei %s und ändert nichts", async (_n, body) => {
      const id = anmelden(neuerOrdner());
      expect((await post("/api/entfernen", body)).status).toBe(400);
      expect(pfadVon(id)).not.toBeNull();
    });
});
