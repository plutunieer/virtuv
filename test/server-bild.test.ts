// Server-Wege fürs Fließbild-Bild (U38) und für Screenshots (U39): bild, bild-antwort, bild-ablegen, frage mit bilder.
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { starteServer } from "../src/server.ts";
import { anmelden, submit } from "../src/store.ts";
import { schreibeInTerminal } from "../src/terminal.ts";
import { ursMitZweiPunkten } from "./fixtures.ts";

// Kein echtes claude: das Terminal ist komplett gespielt.
vi.mock("../src/terminal.ts", () => ({
  verbindeTerminal: vi.fn(),
  beendeTerminals: vi.fn(),
  chatSchliessen: vi.fn(),
  GUELTIGER_CHAT: /^[a-z0-9-]{1,40}$/,
  beendeTerminal: vi.fn(),
  phaseAbgleichen: vi.fn(),
  anzahlTerminals: vi.fn(() => 0),
  schreibeInTerminal: vi.fn(() => "ok"),
}));

const PORT = 18896;
const ORIGIN = `http://127.0.0.1:${PORT}`;
let server: Server;
let appHomeDir: string;
let projektDir: string;
let leerDir: string;
let id: string;
let leerId: string;
let vorherHome: string | undefined;

type Antwort = { status: number; text: string; json: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
function roh(o: { pfad: string; methode?: string; headers?: Record<string, string>; body?: unknown }) {
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
const JSON_KOPF = { "content-type": "application/json" };
const post = (pfad: string, body: unknown) => roh({ pfad, methode: "POST", body, headers: { ...JSON_KOPF, origin: ORIGIN } });
const get = (pfad: string, headers?: Record<string, string>) => roh({ pfad, headers });
const antworten = (projekt: string, b: { anfrage?: string; version: number; pngs: string[]; befunde: string[] }) =>
  post(`/api/p/${projekt}/bild-antwort?anfrage=${b.anfrage}`, b);

// Echter PNG-Dateianfang, sonst lehnt die Ablage ab.
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fake")]);
const PNG_B64 = PNG_BYTES.toString("base64");
const PNG_URL = `data:image/png;base64,${PNG_B64}`;

const offeneWs: WebSocket[] = [];
/** Offene Seite spielen: verbindet sich wie die Werkbank und ruft bei {typ:"bild"} den Handler auf. */
async function zuschauerOeffnen(projektId: string, beiBild: (m: { typ: string; nr?: number; anfrage?: string }) => void | Promise<void>) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?p=${projektId}`, { headers: { origin: ORIGIN } });
  offeneWs.push(ws);
  ws.on("message", (d) => {
    const m = JSON.parse(String(d));
    if (m.typ === "bild") void beiBild(m);
  });
  await new Promise<void>((ok, nein) => { ws.once("open", () => ok()); ws.once("error", nein); });
  return ws;
}

beforeAll(async () => {
  appHomeDir = mkdtempSync(join(tmpdir(), "urs-home-"));
  projektDir = mkdtempSync(join(tmpdir(), "urs-proj-"));
  leerDir = mkdtempSync(join(tmpdir(), "urs-leer-"));
  vorherHome = process.env.URS_APP_HOME;
  process.env.URS_APP_HOME = appHomeDir;
  id = anmelden(projektDir);
  submit(projektDir, ursMitZweiPunkten());
  leerId = anmelden(leerDir);
  submit(leerDir, ursMitZweiPunkten());
  server = await starteServer(PORT);
});

afterAll(() => {
  server.close();
  server.closeAllConnections();
  for (const d of [appHomeDir, projektDir, leerDir]) rmSync(d, { recursive: true, force: true });
  if (vorherHome === undefined) delete process.env.URS_APP_HOME; else process.env.URS_APP_HOME = vorherHome;
});

beforeEach(() => {
  vi.mocked(schreibeInTerminal).mockReset().mockReturnValue("ok");
});

afterEach(async () => {
  for (const ws of offeneWs.splice(0)) {
    await new Promise<void>((ok) => { if (ws.readyState === ws.CLOSED) return ok(); ws.once("close", () => ok()); ws.close(); });
  }
});

describe("GET /api/p/:id/bild", () => {
  it("ohne offenes Fenster: 409 nach der Wartezeit (ohne Schlüssel erreichbar)", async () => {
    const t0 = Date.now();
    const res = await get(`/api/p/${leerId}/bild`);
    expect(res.status).toBe(409);
    expect(res.json.fehler).toMatch(/in keinem Fenster offen/);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(5000); // Fenster bekommt ~6 s Zeit zum Verbinden
  }, 20_000);

  it("Abruf aus einer fremden Webseite (Sec-Fetch-Site: cross-site) wird abgelehnt", async () => {
    const res = await get(`/api/p/${id}/bild`, { "sec-fetch-site": "cross-site" });
    expect(res.status).toBe(403);
  });

  it("eine Version, die es nicht gibt, wird abgelehnt", async () => {
    const res = await get(`/api/p/${id}/bild?version=99`);
    expect(res.status).toBe(409);
    expect(res.json.fehler).toMatch(/gibt es nicht/);
  });

  it("mit offenem Fenster: Anfrage kommt als {typ:'bild'} an, die Antwort wird zurückgegeben", async () => {
    const gesehen: { typ: string; nr?: number; anfrage?: string }[] = [];
    await zuschauerOeffnen(id, async (m) => {
      gesehen.push(m);
      await antworten(id, { anfrage: m.anfrage, version: 1, pngs: [PNG_URL, PNG_URL], befunde: ["Knoten „A“ und „B“ überdecken sich"] });
    });
    const res = await get(`/api/p/${id}/bild`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ version: 1, pngs: [PNG_B64, PNG_B64], befunde: ["Knoten „A“ und „B“ überdecken sich"] });
    expect(gesehen).toHaveLength(1);
    expect(gesehen[0].anfrage).toMatch(/^[0-9a-f-]{36}$/);
    expect(gesehen[0].nr).toBe(1); // ohne ?version= gilt die aktuelle Version
  });

  it("gleichzeitige Anfragen teilen sich eine Bild-Runde (das Fenster zeichnet nur einmal)", async () => {
    let anzahl = 0;
    await zuschauerOeffnen(id, async (m) => {
      anzahl++;
      await new Promise((r) => setTimeout(r, 100));
      await antworten(id, { anfrage: m.anfrage, version: 1, pngs: [PNG_URL], befunde: [] });
    });
    const [a, b, c] = await Promise.all([get(`/api/p/${id}/bild`), get(`/api/p/${id}/bild`), get(`/api/p/${id}/bild`)]);
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    expect(anzahl).toBe(1);
  });

  it("die erste Antwort gilt, wenn mehrere Fenster offen sind", async () => {
    await zuschauerOeffnen(id, async (m) => {
      await antworten(id, { anfrage: m.anfrage, version: 1, pngs: [PNG_URL], befunde: ["erste"] });
    });
    await zuschauerOeffnen(id, async (m) => {
      await new Promise((r) => setTimeout(r, 200));
      await antworten(id, { anfrage: m.anfrage, version: 1, pngs: [PNG_URL], befunde: ["zweite"] });
    });
    const res = await get(`/api/p/${id}/bild`);
    expect(res.status).toBe(200);
    expect(res.json.befunde).toEqual(["erste"]);
  });
});

describe("POST /api/p/:id/bild-antwort", () => {
  const gut = { anfrage: "00000000-0000-4000-8000-000000000000", version: 1, pngs: [PNG_URL], befunde: [] };

  it("eine unbekannte Anfrage wird verworfen, ohne den Körper zu lesen", async () => {
    const res = await antworten(id, gut);
    expect(res.status).toBe(200);
    expect(res.json.verworfen).toBe(true);
  });

  it("ungültige Antworten auf eine wartende Anfrage werden abgelehnt (400), eine gültige zählt danach", async () => {
    const status: Record<string, number> = {};
    await zuschauerOeffnen(id, async (m) => {
      const a = m.anfrage!;
      const faelle: Record<string, unknown> = {
        "Version 0": { ...gut, anfrage: a, version: 0 },
        "Version keine ganze Zahl": { ...gut, anfrage: a, version: 1.5 },
        "kein PNG": { ...gut, anfrage: a, pngs: ["data:image/svg+xml;base64,AAAA"] },
        "fremde Zeichen": { ...gut, anfrage: a, pngs: ["data:image/png;base64,<script>"] },
        "keine Bilder": { ...gut, anfrage: a, pngs: [] },
        "zu viele Befunde": { ...gut, anfrage: a, befunde: Array.from({ length: 201 }, () => "x") },
        "zu langer Befund": { ...gut, anfrage: a, befunde: ["x".repeat(501)] },
      };
      for (const [name, body] of Object.entries(faelle)) status[name] = (await post(`/api/p/${id}/bild-antwort?anfrage=${a}`, body)).status;
      await antworten(id, { ...gut, anfrage: a });
    });
    const res = await get(`/api/p/${id}/bild`);
    expect(res.status).toBe(200);
    expect(Object.values(status).every((s) => s === 400), JSON.stringify(status)).toBe(true);
  });

  it("verlangt wie alle ändernden Anfragen einen Origin (403 ohne)", async () => {
    const res = await roh({ pfad: `/api/p/${id}/bild-antwort?anfrage=${gut.anfrage}`, methode: "POST", body: gut, headers: JSON_KOPF });
    expect(res.status).toBe(403);
  });
});

describe("POST /api/p/:id/bild-ablegen", () => {
  it("legt das Bild als Datei im Bilder-Ordner ab und liefert den Pfad", async () => {
    const res = await post(`/api/p/${id}/bild-ablegen`, { daten: PNG_URL });
    expect(res.status).toBe(200);
    const pfad: string = res.json.pfad;
    expect(realpathSync(pfad).startsWith(realpathSync(join(appHomeDir, "bilder")))).toBe(true);
    expect(pfad).toMatch(/screenshot-[\w-]+\.png$/);
    expect(readFileSync(pfad).equals(PNG_BYTES)).toBe(true);
    expect(existsSync(pfad)).toBe(true);
  });

  it("lehnt Nicht-Bilder ab (409), legt nichts ab", async () => {
    const res = await post(`/api/p/${id}/bild-ablegen`, { daten: "data:text/html;base64,PGI+" });
    expect(res.status).toBe(409);
    expect(res.json.fehler).toMatch(/Nur Bilder/);
  });

  it("lehnt einen Body ohne daten ab (400)", async () => {
    expect((await post(`/api/p/${id}/bild-ablegen`, {})).status).toBe(400);
    expect((await post(`/api/p/${id}/bild-ablegen`, { daten: "" })).status).toBe(400);
  });
});

describe("POST /api/p/:id/frage mit bilder", () => {
  it("ein abgelegtes Bild landet als Pfad im Terminal-Text, die gespeicherte Frage nennt den Anhang", async () => {
    const { pfad } = (await post(`/api/p/${id}/bild-ablegen`, { daten: PNG_URL })).json;
    const res = await post(`/api/p/${id}/frage`, { knoten: "k1", text: "Schau mal", bilder: [pfad] });
    expect(res.status).toBe(200);
    expect(schreibeInTerminal).toHaveBeenCalledTimes(1);
    const text = vi.mocked(schreibeInTerminal).mock.calls[0][1] as string;
    expect(text).toContain("Schau mal");
    expect(text).toContain(realpathSync(pfad));
    const chats = JSON.parse(readFileSync(join(projektDir, ".urs", "chats.json"), "utf8"));
    expect(JSON.stringify(chats)).toContain("📎 1 Screenshot");
  });

  it("nur Bild ohne Text ist erlaubt", async () => {
    const { pfad } = (await post(`/api/p/${id}/bild-ablegen`, { daten: PNG_URL })).json;
    const res = await post(`/api/p/${id}/frage`, { knoten: "k1", text: "", bilder: [pfad] });
    expect(res.status).toBe(200);
    expect(vi.mocked(schreibeInTerminal).mock.calls[0][1] as string).toContain("(siehe Screenshot)");
  });

  it("ein fremder Pfad wird abgelehnt (409), ins Terminal geht nichts", async () => {
    const res = await post(`/api/p/${id}/frage`, { knoten: "k1", text: "Lies das", bilder: ["/etc/passwd"] });
    expect(res.status).toBe(409);
    expect(res.json.fehler).toMatch(/Unbekanntes Bild/);
    expect(schreibeInTerminal).not.toHaveBeenCalled();
  });

  it("mehr als 10 Bilder: 400", async () => {
    const res = await post(`/api/p/${id}/frage`, { knoten: "k1", text: "x", bilder: Array.from({ length: 11 }, () => "/x.png") });
    expect(res.status).toBe(400);
    expect(schreibeInTerminal).not.toHaveBeenCalled();
  });
});
