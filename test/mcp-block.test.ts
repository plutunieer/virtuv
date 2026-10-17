import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { beispielHtml, ladeBeispiele, ladeChats } from "../src/chat.ts";
import { submit } from "../src/store.ts";
import { ursMitZweiPunkten } from "./fixtures.ts";

// Eigener, freier Port; dort lauscht ein Fake, der die Meldungen der Werkzeuge sammelt (kein echter URS-Server).
const PORT = 18898;
process.env.URS_APP_PORT = String(PORT);
process.env.URS_APP_KEIN_BROWSER = "1";

let projektDir: string;
let appHomeDir: string;
let fake: Server;
let pings: { url: string; body: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeAll(async () => {
  fake = createServer((req, res) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => {
      let body: unknown = null;
      try { body = JSON.parse(s); } catch { /* egal */ }
      pings.push({ url: req.url ?? "", body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((ok) => fake.listen(PORT, "127.0.0.1", ok));
});

afterAll(() => {
  fake.close();
  fake.closeAllConnections();
  delete process.env.URS_APP_PORT;
  delete process.env.URS_APP_KEIN_BROWSER;
});

beforeEach(() => {
  pings = [];
  appHomeDir = mkdtempSync(join(tmpdir(), "urs-home-"));
  projektDir = mkdtempSync(join(tmpdir(), "urs-proj-"));
  process.env.URS_APP_HOME = appHomeDir;
  submit(projektDir, ursMitZweiPunkten());
});

afterEach(() => {
  rmSync(projektDir, { recursive: true, force: true });
  rmSync(appHomeDir, { recursive: true, force: true });
  delete process.env.URS_APP_HOME;
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

describe("urs_vorschlag", () => {
  it("legt den Vorschlag offen am Block ab und meldet {typ:'chat'}", async () => {
    const res = await (await verbundenerClient()).callTool({
      name: "urs_vorschlag",
      arguments: {
        projekt_ordner: projektDir, knoten_id: "k2",
        vorschlag: { art: "umbenennen", text: "Neuer Name" }, begruendung: "Klarer so.",
      },
    });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain("Vorschlag liegt am Block");
    expect(ladeChats(projektDir).k2[0]).toMatchObject({
      wer: "claude", text: "Klarer so.", vorschlag: { art: "umbenennen", text: "Neuer Name" },
      vorschlagStatus: "offen", knotenText: "Zweiter",
    });
    expect(pings).toHaveLength(1);
    expect(pings[0].url).toMatch(/^\/api\/p\/[^/]+\/ping$/);
    expect(pings[0].body).toEqual({ typ: "chat" });
  });

  it("unbekannter Block: isError, nichts abgelegt, kein Ping", async () => {
    const res = await (await verbundenerClient()).callTool({
      name: "urs_vorschlag",
      arguments: { projekt_ordner: projektDir, knoten_id: "gibt-es-nicht", vorschlag: { art: "loeschen" } },
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/gibt es nicht/);
    expect(ladeChats(projektDir)).toEqual({});
    expect(pings).toHaveLength(0);
  });

  it("zu langer Name oder fehlender typ: isError mit klarer Meldung, nichts abgelegt", async () => {
    const client = await verbundenerClient();
    const lang = await client.callTool({
      name: "urs_vorschlag",
      arguments: { projekt_ordner: projektDir, knoten_id: "k1", vorschlag: { art: "umbenennen", text: "a b c d e" } },
    });
    expect(lang.isError).toBe(true);
    const ohneTyp = await client.callTool({
      name: "urs_vorschlag",
      arguments: { projekt_ordner: projektDir, knoten_id: "k1", vorschlag: { art: "neuer_schritt", text: "Neu" } },
    });
    expect(ohneTyp.isError).toBe(true);
    expect(text(ohneTyp)).toMatch(/neuer_schritt braucht text und typ/);
    expect(ladeChats(projektDir)).toEqual({});
  });

  it("ungültige Art wird schon vom Werkzeug-Schema abgelehnt", async () => {
    const res = await (await verbundenerClient()).callTool({
      name: "urs_vorschlag",
      arguments: { projekt_ordner: projektDir, knoten_id: "k1", vorschlag: { art: "sprengen" } },
    }).catch(() => ({ isError: true }));
    expect(res.isError).toBe(true);
    expect(ladeChats(projektDir)).toEqual({});
  });
});

describe("urs_beispiel_zeigen", () => {
  it("speichert das Beispiel und meldet {typ:'beispiel', nr}", async () => {
    const html = "<html><body><svg></svg></body></html>";
    const res = await (await verbundenerClient()).callTool({
      name: "urs_beispiel_zeigen",
      arguments: { projekt_ordner: projektDir, titel: "Umsatz pro Woche", html, knoten_id: "k1" },
    });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain("Beispiel 1 gespeichert");
    expect(ladeBeispiele(projektDir)).toMatchObject([{ nr: 1, titel: "Umsatz pro Woche", knoten: "k1" }]);
    expect(beispielHtml(projektDir, 1)).toBe(html);
    expect(pings).toHaveLength(1);
    expect(pings[0].body).toEqual({ typ: "beispiel", nr: 1 });
  });

  it("zweiter Aufruf bekommt Nummer 2", async () => {
    const client = await verbundenerClient();
    const args = { projekt_ordner: projektDir, titel: "T", html: "<p>x</p>" };
    await client.callTool({ name: "urs_beispiel_zeigen", arguments: args });
    const res = await client.callTool({ name: "urs_beispiel_zeigen", arguments: args });
    expect(text(res)).toContain("Beispiel 2 gespeichert");
  });

  it("unbekannter Block: isError, nichts gespeichert, kein Ping", async () => {
    const res = await (await verbundenerClient()).callTool({
      name: "urs_beispiel_zeigen",
      arguments: { projekt_ordner: projektDir, titel: "T", html: "<p>x</p>", knoten_id: "gibt-es-nicht" },
    });
    expect(res.isError).toBe(true);
    expect(ladeBeispiele(projektDir)).toEqual([]);
    expect(pings).toHaveLength(0);
  });

  it("leeres HTML: isError, nichts gespeichert", async () => {
    const res = await (await verbundenerClient()).callTool({
      name: "urs_beispiel_zeigen", arguments: { projekt_ordner: projektDir, titel: "T", html: "  " },
    });
    expect(res.isError).toBe(true);
    expect(ladeBeispiele(projektDir)).toEqual([]);
  });
});

describe("Werkbank: nur der geöffnete Ordner", () => {
  it("lehnt einen fremden projekt_ordner ab, solange URS_APP_IN_WERKBANK gesetzt ist", async () => {
    process.env.URS_APP_IN_WERKBANK = "1";
    try {
      const res = await (await verbundenerClient()).callTool({
        name: "urs_beispiel_zeigen", arguments: { projekt_ordner: projektDir, titel: "T", html: "<p>x</p>" },
      });
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(/nur im geöffneten Ordner/);
      expect(ladeBeispiele(projektDir)).toEqual([]);
    } finally {
      delete process.env.URS_APP_IN_WERKBANK;
    }
  });
});
