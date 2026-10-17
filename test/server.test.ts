import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { starteServer } from "../src/server.ts";
import { anmelden } from "../src/store.ts";

const PORT = 18891;
const BASIS = `http://127.0.0.1:${PORT}`;
let server: Server;
let appHomeDir: string;

function rohAnfrage(o: { pfad?: string; methode?: string; host?: string; headers?: Record<string, string>; body?: string }) {
  return new Promise<{ status: number; text: string }>((ok, nein) => {
    const req = httpRequest({
      hostname: "127.0.0.1", port: PORT, path: o.pfad ?? "/api/gesund", method: o.methode ?? "GET",
      headers: { host: o.host ?? `127.0.0.1:${PORT}`, ...o.headers },
    }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => ok({ status: res.statusCode ?? 0, text: body }));
    });
    req.on("error", nein);
    req.end(o.body);
  });
}

beforeAll(async () => {
  appHomeDir = mkdtempSync(join(tmpdir(), "urs-home-"));
  process.env.URS_APP_HOME = appHomeDir;
  server = await starteServer(PORT);
});

afterAll(() => {
  server.close();
  rmSync(appHomeDir, { recursive: true, force: true });
  delete process.env.URS_APP_HOME;
});

describe("Web-Server: Schutz gegen fremde Anfragen", () => {
  it("beantwortet /api/gesund normal bei passendem Host", async () => {
    const res = await fetch(`${BASIS}/api/gesund`);
    expect(res.status).toBe(200);
    const daten = await res.json();
    expect(daten).toMatchObject({ ok: true, app: "urs-app" });
    expect(daten.build).toMatch(/^[0-9a-f]{12}$/);
  });

  it("lehnt eine Anfrage mit fremdem Host-Header ab (403)", async () => {
    expect((await rohAnfrage({ host: "evil.example.com:9999" })).status).toBe(403);
  });

  it("lehnt eine Anfrage mit fremdem Origin-Header ab (403)", async () => {
    expect((await rohAnfrage({ headers: { origin: "http://evil.example.com" } })).status).toBe(403);
  });

  it("lehnt POST ohne JSON-Content-Type ab (415)", async () => {
    const res = await rohAnfrage({ pfad: "/api/p/irgendeine-id/ping", methode: "POST", headers: { "content-type": "text/plain" } });
    expect(res.status).toBe(415);
  });
});

describe("Web-Server: weitere Schutzmaßnahmen", () => {
  it("setzt X-Frame-Options: DENY", async () => {
    expect((await fetch(`${BASIS}/api/gesund`)).headers.get("x-frame-options")).toBe("DENY");
  });

  it("lehnt eine ändernde Anfrage ohne Origin ab (403), auch mit richtigem Host", async () => {
    const res = await rohAnfrage({ pfad: "/api/p/irgendeine-id/verwerfen", methode: "POST", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(403);
  });

  it("erlaubt /api/p/:id/ping auch ohne Origin (kein 403)", async () => {
    const res = await rohAnfrage({ pfad: "/api/p/irgendeine-id/ping", methode: "POST", headers: { "content-type": "application/json" } });
    expect(res.status).not.toBe(403);
  });

  it("liefert 404 für /api/p/__proto__ statt eines geerbten Objekt-Werts", async () => {
    expect((await rohAnfrage({ pfad: "/api/p/__proto__" })).status).toBe(404);
  });

  it("prüft den freigeben-Body und liefert 400 bei Unsinn", async () => {
    const projekt2 = mkdtempSync(join(tmpdir(), "urs-proj2-"));
    const id = anmelden(projekt2);
    const res = await rohAnfrage({
      pfad: `/api/p/${id}/freigeben`, methode: "POST", body: JSON.stringify({ version: "nicht-zahl" }),
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${PORT}` },
    });
    expect(res.status).toBe(400);
    rmSync(projekt2, { recursive: true, force: true });
  });
});
