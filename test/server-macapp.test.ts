import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { starteServer } from "../src/server.ts";
import { anmelden } from "../src/store.ts";

vi.mock("../src/terminal.ts", () => ({
  verbindeTerminal: vi.fn((ws: WebSocket) => ws.close()), beendeTerminals: vi.fn(),
  chatSchliessen: vi.fn(),
  GUELTIGER_CHAT: /^[a-z0-9-]{1,40}$/,
  beendeTerminal: vi.fn(),
  phaseAbgleichen: vi.fn(), anzahlTerminals: vi.fn(() => 0),
  schreibeInTerminal: vi.fn(() => "aus"), terminalLaeuft: vi.fn(() => false),
}));

// Server wie in der Mac-App: mit Schlüssel und ohne Fern-Beenden.
const PORT = 18895, ORIGIN = `http://127.0.0.1:${PORT}`, SCHLUESSEL = "a".repeat(64);
let server: Server, appHomeDir: string, ordner: string, id: string;

function roh(pfad: string, o: { methode?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; json: any }>((ok, nein) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const req = httpRequest({ hostname: "127.0.0.1", port: PORT, path: pfad, method: o.methode ?? "GET",
      headers: { host: `127.0.0.1:${PORT}`, ...o.headers } }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch { /* */ } ok({ status: res.statusCode ?? 0, json: j }); });
    });
    req.on("error", nein); req.end(o.body);
  });
}

beforeAll(async () => {
  appHomeDir = mkdtempSync(join(tmpdir(), "urs-home-"));
  ordner = mkdtempSync(join(tmpdir(), "urs-proj-"));
  process.env.URS_APP_HOME = appHomeDir;
  id = anmelden(ordner);
  server = await starteServer(PORT, { macApp: true, schluessel: SCHLUESSEL });
});
afterAll(() => {
  server.close(); server.closeAllConnections();
  for (const d of [appHomeDir, ordner]) rmSync(d, { recursive: true, force: true });
  delete process.env.URS_APP_HOME;
});

describe("Mac-App-Server: Schlüssel", () => {
  it("ohne Schlüssel: /api gesperrt (403), auch Lesen — nur Gesundheits-Check und „neue Version“ gehen", async () => {
    expect((await roh("/api/ordner")).status).toBe(403);
    expect((await roh(`/api/p/${id}/chat`)).status).toBe(403);
    expect((await roh("/api/gesund")).status).toBe(200);
    expect((await roh(`/api/p/${id}/ping`, { methode: "POST", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(200);
  });

  it("freigeben ohne Schlüssel geht nicht, auch mit gefälschter Herkunft", async () => {
    const r = await roh(`/api/p/${id}/freigeben`, { methode: "POST", body: '{"version":1}', headers: { "content-type": "application/json", origin: ORIGIN } });
    expect(r.status).toBe(403);
  });

  it("falscher Schlüssel (gleich lang oder anders lang): 403", async () => {
    expect((await roh("/api/ordner", { headers: { "x-urs-schluessel": "b".repeat(64) } })).status).toBe(403);
    expect((await roh("/api/ordner", { headers: { cookie: "urs_schluessel=kurz" } })).status).toBe(403);
  });

  it("richtiger Schlüssel per Kopfzeile oder Cookie: erlaubt", async () => {
    expect((await roh("/api/ordner", { headers: { "x-urs-schluessel": SCHLUESSEL } })).status).toBe(200);
    expect((await roh("/api/ordner", { headers: { cookie: `x=1; urs_schluessel=${SCHLUESSEL}` } })).status).toBe(200);
  });

  it("/api/gesund meldet art mac-app", async () => {
    expect((await roh("/api/gesund", { headers: { "x-urs-schluessel": SCHLUESSEL } })).json).toMatchObject({ art: "mac-app" });
  });

  it("Terminal-Verbindung ohne Schlüssel wird abgewiesen, mit Schlüssel angenommen", async () => {
    const verbinde = (headers: Record<string, string>) => new Promise<string>((ok) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/term?p=${id}`, { headers: { origin: ORIGIN, ...headers } });
      ws.once("open", () => { ws.close(); ok("offen"); });
      ws.once("error", () => ok("abgewiesen"));
      ws.once("close", () => ok("abgewiesen"));
    });
    expect(await verbinde({})).toBe("abgewiesen");
    expect(await verbinde({ cookie: `urs_schluessel=${SCHLUESSEL}` })).toBe("offen");
  });
});

describe("Mac-App-Server: kein Fern-Beenden", () => {
  it("/api/beenden ist auch mit Schlüssel gesperrt und der Server läuft weiter", async () => {
    const r = await roh("/api/beenden", { methode: "POST", body: "{}", headers: { "content-type": "application/json", "x-urs-schluessel": SCHLUESSEL } });
    expect(r.status).toBe(403);
    await new Promise((x) => setTimeout(x, 150));
    expect((await roh("/api/gesund", { headers: { "x-urs-schluessel": SCHLUESSEL } })).status).toBe(200);
  });
});
