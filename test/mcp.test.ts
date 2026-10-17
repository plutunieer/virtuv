import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildKennung } from "../src/build.ts";
import { setzePruefer, type Pruefer } from "../src/smart.ts";
import * as store from "../src/store.ts";
import { gefragt, minimaleUrs, submitOk, ursMitZweiPunkten } from "./fixtures.ts";

// Ersatz-Server auf URS_APP_PORT: sonst startet urs_submit nach dem Anlegen den echten Server (sichereServer).
let ersatz: Server;
beforeAll(async () => {
  ersatz = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/api/gesund")) res.end(JSON.stringify({ app: "urs-app", build: buildKennung(), terminals: 0 }));
    else if (req.url?.includes("/ping")) res.end(JSON.stringify({ zuschauer: 1 }));
    else { res.statusCode = 404; res.end(JSON.stringify({ fehler: "kein Bild im Test" })); }
  });
  await new Promise<void>((ok) => ersatz.listen(18899, "127.0.0.1", ok));
});
afterAll(() => new Promise<void>((ok) => ersatz.close(() => ok())));

// Die echte Claude-CLI darf in keinem Test laufen: der Standard-Prüfer wirft.
let altPruefer: Pruefer;
beforeEach(() => { altPruefer = setzePruefer(async () => { throw new Error("echter Prüfer im Test aufgerufen"); }); });
afterEach(() => { setzePruefer(altPruefer); });

let projektDir: string;
let appHomeDir: string;

beforeEach(() => {
  appHomeDir = mkdtempSync(join(tmpdir(), "urs-home-"));
  projektDir = mkdtempSync(join(tmpdir(), "urs-proj-"));
  process.env.URS_APP_HOME = appHomeDir;
  process.env.URS_APP_PORT = "18899";
  process.env.URS_APP_KEIN_BROWSER = "1";
});

afterEach(() => {
  rmSync(projektDir, { recursive: true, force: true });
  rmSync(appHomeDir, { recursive: true, force: true });
  delete process.env.URS_APP_HOME;
  delete process.env.URS_APP_PORT;
  delete process.env.URS_APP_KEIN_BROWSER;
});

async function verbundenerClient() {
  const { baueMcp } = await import("../src/mcp.ts");
  const mcp = baueMcp();
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}
const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as Array<{ text: string }>)[0].text;

describe("MCP-Werkzeuge", () => {
  it("bietet genau diese Werkzeuge an, KEIN Freigeben-Werkzeug", async () => {
    const { tools } = await (await verbundenerClient()).listTools();
    expect(tools.map((t) => t.name).sort())
      .toEqual(["urs_beispiel_zeigen", "urs_bild_ansehen", "urs_get_approved", "urs_get_feedback", "urs_submit", "urs_vorschlag"]);
  });

  it("urs_submit meldet eine ungültige URS als Fehler", async () => {
    const res = await (await verbundenerClient()).callTool({
      name: "urs_submit",
      arguments: { projekt_ordner: projektDir, urs: { ...minimaleUrs(), anforderungen: [] } },
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("Ungültige URS");
  });

  it("urs_get_feedback liefert offene Kommentare der aktuellen Version", async () => {
    store.submit(projektDir, minimaleUrs());
    store.speichereArbeit(projektDir, {
      ...store.ladeArbeit(projektDir),
      kommentare: [{ id: "c1", knoten: "k1", text: "Bitte prüfen", zeit: "t", erledigt: false }],
    });
    const res = await (await verbundenerClient()).callTool({ name: "urs_get_feedback", arguments: { projekt_ordner: projektDir } });
    const daten = JSON.parse(text(res));
    expect(daten.version).toBe(1);
    expect(daten.offeneKommentare).toHaveLength(1);
    expect(daten.offeneKommentare[0].knotenText).toBe("Start");
    expect(daten.stand).toMatch(/^[0-9a-f]{12}$/);
  });

  it("urs_get_approved schlägt vor Freigabe fehl und liefert danach die Version", async () => {
    submitOk(projektDir, minimaleUrs());
    const client = await verbundenerClient();
    expect((await client.callTool({ name: "urs_get_approved", arguments: { projekt_ordner: projektDir } })).isError).toBe(true);
    store.freigeben(projektDir, 1);
    const nachher = await client.callTool({ name: "urs_get_approved", arguments: { projekt_ordner: projektDir } });
    expect(nachher.isError).toBeFalsy();
    expect(JSON.parse(text(nachher)).version).toBe(1);
  });

  describe("urs_submit mit SMART-Prüfung (U50–U54)", () => {
    const rufe = (urs: unknown) => verbundenerClient().then((c) =>
      c.callTool({ name: "urs_submit", arguments: { projekt_ordner: projektDir, urs } }));

    it("U52-Verstoß: Fehler, Prüfer wird nicht gefragt, keine Version", async () => {
      let anzahl = 0;
      setzePruefer(async () => { anzahl++; return { ergebnisse: [] }; });
      const u = ursMitZweiPunkten();
      u.knoten[1].anforderungen = ["U1"];
      const res = await rufe(u);
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(/U52|genau einem Knoten/);
      expect(anzahl).toBe(0);
      expect(store.ladeProjekt(projektDir)).toBeNull();
    });

    it("U-Nummer fehlt in der Folgeversion: Fehler vor der teuren Prüfung", async () => {
      submitOk(projektDir, ursMitZweiPunkten());
      let anzahl = 0;
      setzePruefer(async () => { anzahl++; return { ergebnisse: [] }; });
      const res = await rufe(minimaleUrs());
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(/U2 fehlt/);
      expect(anzahl).toBe(0);
    });

    it("SMART verfehlt: isError mit Grund, keine neue Version", async () => {
      setzePruefer(async (_a, aufgabe) => ({ ergebnisse: gefragt(aufgabe).map((id) => ({ id, ok: true, grund: "ok" })) }));
      expect((await rufe(ursMitZweiPunkten())).isError).toBeFalsy();
      expect(store.ladeProjekt(projektDir)).toMatchObject({ aktuelleVersion: 1 });

      setzePruefer(async () => ({ ergebnisse: [{ id: "U2", ok: false, grund: "zu vage, besser: X" }] }));
      const u = ursMitZweiPunkten();
      u.anforderungen[1].text = "Irgendwie schnell.";
      const res = await rufe(u);
      expect(res.isError).toBe(true);
      expect(text(res)).toContain("SMART-Prüfung nicht bestanden");
      expect(text(res)).toContain("U2: zu vage, besser: X");
      expect(text(res)).not.toContain("U1:");
      expect(store.ladeProjekt(projektDir)).toMatchObject({ aktuelleVersion: 1 });
      expect(existsSync(join(projektDir, ".urs", "v002.json"))).toBe(false);
    });

    it("Prüfer fällt aus: isError, keine Version", async () => {
      const res = await rufe(ursMitZweiPunkten());
      expect(res.isError).toBe(true);
      expect(store.ladeProjekt(projektDir)).toBeNull();
    });

    it("alles ok: Version mit smart gespeichert; Folgeversion fragt nur Geändertes", async () => {
      const liste: string[][] = [];
      setzePruefer(async (_a, aufgabe) => {
        const ids = gefragt(aufgabe);
        liste.push(ids);
        return { ergebnisse: ids.map((id) => ({ id, ok: true, grund: `ok ${id}` })) };
      });
      const res = await rufe(ursMitZweiPunkten());
      expect(res.isError).toBeFalsy();
      expect(text(res)).toContain("Version 1 angelegt");
      expect(store.ladeVersion(projektDir, 1).smart).toEqual({ U1: { ok: true, grund: "ok U1" }, U2: { ok: true, grund: "ok U2" } });
      expect(store.offen(projektDir).smart).toBe(0);

      const u = ursMitZweiPunkten();
      u.anforderungen[1].text = "Zweiter Satz, neu.";
      expect((await rufe(u)).isError).toBeFalsy();
      expect(liste).toEqual([["U1", "U2"], ["U2"]]);
      expect(store.ladeVersion(projektDir, 2).smart).toMatchObject({ U1: { grund: "ok U1" }, U2: { grund: "ok U2" } });
    });
  });
});
