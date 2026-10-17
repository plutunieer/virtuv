import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ladeBeispiele, ladeChats, merkeFrage, speichereBeispiel } from "../src/chat.ts";
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
  schreibeInTerminal: vi.fn(() => "aus"),
}));

const PORT = 18893;
const ORIGIN = `http://127.0.0.1:${PORT}`;
let server: Server;
let appHomeDir: string;
let projektDir: string;
let id: string;

type Antwort = { status: number; text: string; json: any; headers: Record<string, string | string[] | undefined> }; // eslint-disable-line @typescript-eslint/no-explicit-any
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
        ok({ status: res.statusCode ?? 0, text: body, json, headers: res.headers });
      });
    });
    req.on("error", nein);
    req.end(o.body === undefined ? undefined : JSON.stringify(o.body));
  });
}
const JSON_KOPF = { "content-type": "application/json" };
const post = (pfad: string, body: unknown, headers: Record<string, string> = {}) =>
  roh({ pfad, methode: "POST", body, headers: { ...JSON_KOPF, origin: ORIGIN, ...headers } });

beforeAll(async () => {
  appHomeDir = mkdtempSync(join(tmpdir(), "urs-home-"));
  projektDir = mkdtempSync(join(tmpdir(), "urs-proj-"));
  process.env.URS_APP_HOME = appHomeDir;
  id = anmelden(projektDir);
  submit(projektDir, ursMitZweiPunkten());
  server = await starteServer(PORT);
});

afterAll(() => {
  server.close();
  server.closeAllConnections();
  for (const d of [appHomeDir, projektDir]) rmSync(d, { recursive: true, force: true });
  delete process.env.URS_APP_HOME;
});

beforeEach(() => {
  rmSync(join(projektDir, ".urs", "chats.json"), { force: true });
  vi.mocked(schreibeInTerminal).mockReset().mockReturnValue("aus");
});

describe("POST /api/p/:id/frage", () => {
  it("läuft das Terminal nicht: 409, nichts gespeichert", async () => {
    const res = await post(`/api/p/${id}/frage`, { knoten: "k1", text: "Warum?" });
    expect(res.status).toBe(409);
    expect(res.json.fehler).toMatch(/Claude läuft links gerade nicht/);
    expect(ladeChats(projektDir)).toEqual({});
  });

  it("wartet Claude links auf eine Antwort: 409, nichts gespeichert", async () => {
    vi.mocked(schreibeInTerminal).mockReturnValue("wartet");
    const res = await post(`/api/p/${id}/frage`, { knoten: "k1", text: "Warum?" });
    expect(res.status).toBe(409);
    expect(res.json.fehler).toMatch(/wartet links/);
    expect(ladeChats(projektDir)).toEqual({});
  });

  it("läuft das Terminal: schreibt den Blocktext ins Terminal, speichert die Frage, 200", async () => {
    vi.mocked(schreibeInTerminal).mockReturnValue("ok");
    const res = await post(`/api/p/${id}/frage`, { knoten: "k2", text: "Warum so?" });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
    expect(schreibeInTerminal).toHaveBeenCalledTimes(1);
    const [tid, text] = vi.mocked(schreibeInTerminal).mock.calls[0];
    expect(tid).toBe(id);
    expect(text).toContain("knoten_id k2");
    expect(text).toContain("Warum so?");
    expect(ladeChats(projektDir).k2[0]).toMatchObject({ wer: "ich", text: "Warum so?" });
  });

  it("lehnt ohne Origin ab (403): kein Terminal-Aufruf, nichts gespeichert", async () => {
    vi.mocked(schreibeInTerminal).mockReturnValue("ok");
    const res = await roh({ pfad: `/api/p/${id}/frage`, methode: "POST", body: { knoten: "k1", text: "Hi" }, headers: JSON_KOPF });
    expect(res.status).toBe(403);
    expect(schreibeInTerminal).not.toHaveBeenCalled();
    expect(ladeChats(projektDir)).toEqual({});
  });

  it("lehnt einen fremden Origin ab (403)", async () => {
    vi.mocked(schreibeInTerminal).mockReturnValue("ok");
    expect((await post(`/api/p/${id}/frage`, { knoten: "k1", text: "Hi" }, { origin: "http://evil.example.com" })).status).toBe(403);
    expect(schreibeInTerminal).not.toHaveBeenCalled();
  });

  it("unbekannter Block: 409, nichts ins Terminal", async () => {
    vi.mocked(schreibeInTerminal).mockReturnValue("ok");
    const res = await post(`/api/p/${id}/frage`, { knoten: "nope", text: "Hi" });
    expect(res.status).toBe(409);
    expect(schreibeInTerminal).not.toHaveBeenCalled();
    expect(ladeChats(projektDir)).toEqual({});
  });

  it("leere Frage: 409; fehlendes Feld: 400; beides ohne Terminal-Aufruf", async () => {
    vi.mocked(schreibeInTerminal).mockReturnValue("ok");
    expect((await post(`/api/p/${id}/frage`, { knoten: "k1", text: "  " })).status).toBe(409);
    expect((await post(`/api/p/${id}/frage`, { text: "Hi" })).status).toBe(400);
    expect(schreibeInTerminal).not.toHaveBeenCalled();
  });
});

describe("POST /api/p/:id/chat/erledigt", () => {
  it("schließt eine offene Frage ab; ohne Origin 403", async () => {
    merkeFrage(projektDir, "k1", "Frage");
    const ohne = await roh({ pfad: `/api/p/${id}/chat/erledigt`, methode: "POST", body: { knoten: "k1" }, headers: JSON_KOPF });
    expect(ohne.status).toBe(403);
    expect((await post(`/api/p/${id}/chat/erledigt`, { knoten: "k1" })).status).toBe(200);
    expect(ladeChats(projektDir).k1.map((n) => n.wer)).toEqual(["ich", "claude"]);
  });
});

describe("GET /api/p/:id/chat", () => {
  it("liefert { chats, beispiele }", async () => {
    const nr = speichereBeispiel(projektDir, "Chart", "<p>x</p>", "k1");
    const res = await roh({ pfad: `/api/p/${id}/chat` });
    expect(res.status).toBe(200);
    expect(Object.keys(res.json).sort()).toEqual(["beispiele", "chats"]);
    expect(res.json.chats).toEqual(ladeChats(projektDir));
    expect(res.json.beispiele).toEqual(ladeBeispiele(projektDir));
    expect(res.json.beispiele.some((b: { nr: number; titel: string }) => b.nr === nr && b.titel === "Chart")).toBe(true);
  });
});

describe("GET /api/p/:id/beispiel/:nr", () => {
  it("liefert das HTML mit sandbox-CSP und Schutz-Headern (auch ohne Origin)", async () => {
    const html = "<html><body><svg></svg>Hallo</body></html>";
    const nr = speichereBeispiel(projektDir, "Sicht", html);
    const res = await roh({ pfad: `/api/p/${id}/beispiel/${nr}` });
    expect(res.status).toBe(200);
    expect(res.text).toBe(html);
    expect(String(res.headers["content-type"])).toMatch(/^text\/html/);
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("sandbox");
    expect(csp).toContain("default-src 'none'");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it.each(["9999", "abc", "0"])("unbekannte Nummer %s: 409", async (nr) => {
    const res = await roh({ pfad: `/api/p/${id}/beispiel/${nr}` });
    expect(res.status).toBe(409);
    expect(res.json.fehler).toMatch(/gibt es nicht/);
  });
});

describe("POST /api/p/:id/ping", () => {
  it("nimmt {typ:'beispiel', nr} ohne Origin an (200)", async () => {
    const res = await roh({ pfad: `/api/p/${id}/ping`, methode: "POST", body: { typ: "beispiel", nr: 3 }, headers: JSON_KOPF });
    expect(res.status).toBe(200);
    expect(res.json).toHaveProperty("zuschauer");
  });

  it("meldet {typ:'beispiel', nr} an die offene Seite (WebSocket)", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?p=${id}`, { headers: { origin: ORIGIN } });
    const meldungen: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    ws.on("message", (d) => meldungen.push(JSON.parse(String(d))));
    await new Promise<void>((ok, nein) => { ws.once("open", () => ok()); ws.once("error", nein); });
    try {
      const res = await roh({ pfad: `/api/p/${id}/ping`, methode: "POST", body: { typ: "beispiel", nr: 7 }, headers: JSON_KOPF });
      expect(res.json.zuschauer).toBe(1);
      await vi.waitFor(() => expect(meldungen).toContainEqual({ typ: "beispiel", nr: 7 }));
      await roh({ pfad: `/api/p/${id}/ping`, methode: "POST", body: { typ: "chat" }, headers: JSON_KOPF });
      await vi.waitFor(() => expect(meldungen).toContainEqual({ typ: "chat" }));
      // Müll im Körper fällt auf "neu" zurück, nie ein Fehler.
      const muell = await roh({ pfad: `/api/p/${id}/ping`, methode: "POST", body: { typ: "quatsch" }, headers: JSON_KOPF });
      expect(muell.status).toBe(200);
      await vi.waitFor(() => expect(meldungen).toContainEqual({ typ: "neu" }));
    } finally {
      ws.close();
    }
  });
});
