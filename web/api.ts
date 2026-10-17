import type { Arbeit, Beispiel, Nachricht, Projekt, Version } from "../src/schema.ts";

export type { Nachricht };
export type Chats = { chats: Record<string, Nachricht[]>; beispiele: Beispiel[] };
export type Ordner = { id: string; pfad: string; name: string; version: number | null; status: string | null; ohneOrdner: boolean };
export type Uebersicht = Ordner & { fragen: number; anzahl: number; bloecke: string[]; laeuft: boolean };
export type Einrichtung = { claude: boolean; angemeldet: boolean; abo: boolean; hinweis: string };

export type Daten = {
  id: string;
  projekt: Projekt;
  versionen: { version: number; erstellt: string; freigegeben: string | null }[];
  aktuell: Version;
  arbeit: Arbeit;
};

async function anfrage<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, headers: { "content-type": "application/json" } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { fehler?: string }).fehler ?? `Fehler ${r.status}`);
  return j as T;
}

export const api = {
  projekte: () => anfrage<{ id: string; name: string; status: string; version: number }[]>("/api/projekte"),
  laden: (id: string) => anfrage<Daten>(`/api/p/${id}`),
  version: (id: string, n: number) => anfrage<Version>(`/api/p/${id}/v/${n}`),
  speichern: (id: string, a: Arbeit) => anfrage(`/api/p/${id}/arbeit`, { method: "PUT", body: JSON.stringify(a) }),
  verwerfen: (id: string) => anfrage(`/api/p/${id}/verwerfen`, { method: "POST", body: "{}" }),
  freigeben: (id: string, version: number) =>
    anfrage(`/api/p/${id}/freigeben`, { method: "POST", body: JSON.stringify({ version }) }),
  ordner: () => anfrage<Ordner[]>("/api/ordner"),
  uebersicht: () => anfrage<Uebersicht[]>("/api/uebersicht"),
  einrichtung: () => anfrage<Einrichtung>("/api/einrichtung"),
  entfernen: (id: string) => anfrage<{ ok: boolean }>("/api/entfernen", { method: "POST", body: JSON.stringify({ id }) }),
  oeffnen: (pfad: string) => anfrage<{ id: string }>("/api/oeffnen", { method: "POST", body: JSON.stringify({ pfad }) }),
  neuerEntwurf: () => anfrage<{ id: string }>("/api/neuer-entwurf", { method: "POST", body: "{}" }),
  umziehen: (id: string, pfad: string) => anfrage<{ id: string }>(`/api/p/${id}/umziehen`, { method: "POST", body: JSON.stringify({ pfad }) }),
  chats: (id: string) => anfrage<Chats>(`/api/p/${id}/chat`),
  erledigt: (id: string, knoten: string) =>
    anfrage(`/api/p/${id}/chat/erledigt`, { method: "POST", body: JSON.stringify({ knoten }) }),
  chatSchliessen: (id: string, chat: string) =>
    anfrage(`/api/p/${id}/chat-schliessen`, { method: "POST", body: JSON.stringify({ chat }) }),
  frage: (id: string, knoten: string, text: string, chat?: string, bilder?: string[]) =>
    anfrage(`/api/p/${id}/frage`, { method: "POST", body: JSON.stringify({ knoten, text, chat, bilder }) }),
  bildAntwort: (id: string, b: { anfrage: string; version: number; pngs: string[]; befunde: string[] }) =>
    anfrage(`/api/p/${id}/bild-antwort?anfrage=${encodeURIComponent(b.anfrage)}`, { method: "POST", body: JSON.stringify(b) }),
  bildAblegen: (id: string, daten: string) =>
    anfrage<{ pfad: string }>(`/api/p/${id}/bild-ablegen`, { method: "POST", body: JSON.stringify({ daten }) }),
  vorschlag: (id: string, knoten: string, nachricht: string, status: "ok" | "nein") =>
    anfrage(`/api/p/${id}/chat/vorschlag`, { method: "POST", body: JSON.stringify({ knoten, nachricht, status }) }),
};

/**
 * Live-Verbindung: ruft bei jeder neuen Version / Änderung neu("neu"), bei Block-Fragen/Vorschlägen neu("chat"),
 * bei einem neuen Beispiel neu("beispiel", nr) auf, bei einer Bild-Anfrage neu("bild", version, anfrage),
 * nach einem Verbindungsabbruch neu() ohne Typ (dann alles neu laden).
 */
export function live(id: string, neu: (typ?: "neu" | "chat" | "beispiel" | "bild", nr?: number, anfrage?: string) => void) {
  let ws: WebSocket | null = null;
  let aus = false;
  const verbinden = () => {
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?p=${encodeURIComponent(id)}`);
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(String(e.data)) as { typ?: string; nr?: number; anfrage?: string };
        if (m.typ === "bild") neu("bild", m.nr, m.anfrage);
        else if (m.typ === "beispiel") neu("beispiel", m.nr); else neu(m.typ === "chat" ? "chat" : "neu");
      } catch { neu(); }
    };
    ws.onclose = () => { if (!aus) setTimeout(() => { neu(); verbinden(); }, 2000); };
  };
  verbinden();
  return () => { aus = true; ws?.close(); };
}

/** Datei (Screenshot) → data:-URL, z. B. für die Ablage oder eine Vorschau. */
export const alsDatenUrl = (f: Blob) => new Promise<string>((ok, nein) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result)); r.onerror = () => nein(r.error);
  r.readAsDataURL(f);
});

/** Bilder aus einem Einfüge- oder Ablege-Ereignis (Cmd+V, Hineinziehen). */
export function bilderAus(d: DataTransfer | null): File[] {
  if (!d) return [];
  const aus = [...d.files].filter((f) => f.type.startsWith("image/"));
  if (aus.length) return aus;
  return [...d.items].filter((i) => i.kind === "file" && i.type.startsWith("image/")).map((i) => i.getAsFile()).filter((f): f is File => !!f);
}
