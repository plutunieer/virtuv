import {
  BaseEdge, ConnectionMode, MarkerType, ReactFlow, ReactFlowProvider, useNodesState, useReactFlow,
  type Connection, type Edge, type EdgeChange, type EdgeProps, type NodeChange,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { offen as berechneOffen, neuSeitFreigabe } from "../src/logik.ts";
import type { Arbeit, ArbeitsKnoten, Beispiel, Kante, KnotenTyp, SmartErgebnis, SmartPruefung, UrsInhalt, Version } from "../src/schema.ts";
import { umschalten, useAnsicht, zeigen } from "./ansicht.ts";
import { alsDatenUrl, api, bilderAus, live, type Chats, type Daten, type Nachricht } from "./api.ts";
import { Griff } from "./Griff.tsx";
import { UrsKnoten, type KnotenNode } from "./Knoten.tsx";
import { GROESSE, anordnen, befunde, kantenId, mitNotlinien, pfad, verlegen, type PlatzKnoten, type Route } from "./layout.ts";
import { aktuelleSprache, tx, useT } from "./sprache.ts";

type KantenDaten = { punkte: { x: number; y: number }[]; label?: Route["label"] };
/** Pfeil entlang des vorab verlegten Wegs (U40) — mit Beschriftung auf freiem Platz. */
function RoutenKante({ id, data, markerEnd, style }: EdgeProps<Edge<KantenDaten>>) {
  if (!data?.punkte.length) return null;
  const l = data.label;
  return <>
    <BaseEdge id={id} path={pfad(data.punkte)} markerEnd={markerEnd} style={style} />
    {l && <g className="kanten-text">
      <rect x={l.x} y={l.y} width={l.w} height={l.h} rx={4} />
      <text x={l.x + l.w / 2} y={l.y + l.h / 2} textAnchor="middle" dominantBaseline="central">{l.text}</text>
    </g>}
  </>;
}

const knotenTypen = { urs: UrsKnoten };
const kantenTypen = { route: RoutenKante };
const PINCH_TEMPO = 0.006; // Standard von React Flow ist 0.02 — kleiner = langsamer
const LEER: never[] = [];
const TYP_NAME = (typ: KnotenTyp) => ({
  start: tx("Start", "Start"), ende: tx("Ende", "End"), schritt: tx("Schritt", "Step"), nutzer: tx("Nutzer-Aktion", "User action"),
  speicher: tx("Datenspeicher", "Data store"), entscheidung: tx("Entscheidung", "Decision"),
})[typ];
const zeit = (iso: string) => new Date(iso).toLocaleString(aktuelleSprache() === "de" ? "de-DE" : "en-GB", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

// Pfeil an der passenden Seite ansetzen: nach unten → unten/oben, sonst seitlich.
function griffe(a: { x: number; y: number; typ: KnotenTyp }, b: { x: number; y: number; typ: KnotenTyp }) {
  const ay = a.y + GROESSE[a.typ].h / 2, by = b.y + GROESSE[b.typ].h / 2;
  const ax = a.x + GROESSE[a.typ].w / 2, bx = b.x + GROESSE[b.typ].w / 2;
  if (by - ay > 30) return { sourceHandle: "b", targetHandle: "t" };
  if (ay - by > 30 && Math.abs(bx - ax) < 60) return { sourceHandle: "r", targetHandle: "r" };
  return bx >= ax ? { sourceHandle: "r", targetHandle: "l" } : { sourceHandle: "l", targetHandle: "r" };
}

export function ProjektSeite({ id, eingebettet = false, chat = "1" }: { id: string; eingebettet?: boolean; chat?: string }) {
  return <ReactFlowProvider><Projekt id={id} eingebettet={eingebettet} chat={chat} /></ReactFlowProvider>;
}

function Projekt({ id, eingebettet, chat }: { id: string; eingebettet: boolean; chat: string }) {
  const [daten, setDaten] = useState<Daten | null>(null);
  const [arbeit, setArbeit] = useState<Arbeit | null>(null);
  const [alt, setAlt] = useState<Version | null>(null); // ältere Version, nur ansehen
  const [gewaehlt, setGewaehlt] = useState<string | null>(null);
  const [frischId, setFrischId] = useState<string | null>(null); // gerade angelegter Knoten
  const fokusErledigt = useCallback(() => setFrischId(null), []);
  const [meldung, setMeldung] = useState("");
  const [fehler, setFehler] = useState("");
  const rf = useReactFlow();
  const t = useT();

  // Aktueller Stand in einer Ref, damit schnelle Änderungen hintereinander nicht auf altem Stand aufbauen.
  const arbeitRef = useRef<Arbeit | null>(null);
  const warteschlange = useRef<Promise<unknown>>(Promise.resolve());
  const offeneSpeicher = useRef(0);

  const laden = useCallback(async () => {
    if (offeneSpeicher.current > 0) return; // eigene Speicherung läuft noch — deren Ergebnis ist aktueller
    try {
      const d = await api.laden(id);
      if (offeneSpeicher.current > 0) return;
      arbeitRef.current = d.arbeit;
      setDaten(d); setArbeit(d.arbeit); setFehler("");
    } catch (e) { setFehler(String((e as Error).message)); }
  }, [id]);
  // Punkt-Chats: eigener Stand, damit eine Chat-Antwort nicht die ganze URS neu lädt.
  const ansicht = useAnsicht();
  // Ändert sich die Breite der Diagramm-Fläche (Spalte ein-/ausgeblendet, Breite gezogen, Fenster geteilt),
  // die Ansicht um die halbe Änderung mitschieben — so bleibt das Diagramm mittig statt aus dem Bild zu rutschen.
  const flaecheRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = flaecheRef.current;
    if (!el) return;
    let alt = el.getBoundingClientRect().width;
    const ro = new ResizeObserver(() => {
      const neu = el.getBoundingClientRect().width;
      if (alt > 0 && neu > 0 && Math.abs(neu - alt) > 1) {
        const { x, y, zoom } = rf.getViewport();
        rf.setViewport({ x: x + (neu - alt) / 2, y, zoom });
      }
      alt = neu;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [rf, daten !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  const [chats, setChats] = useState<Chats>({ chats: {}, beispiele: [] });
  // Bild-Anfragen von Claude (U38): werden beantwortet, sobald die angefragte Version fertig angeordnet ist.
  const bildAnfragen = useRef<{ anfrage: string; version: number; zeit: number }[]>([]);
  const [bildTick, setBildTick] = useState(0);
  const [vorschau, setVorschau] = useState<number | null>(null); // Nummer des offenen Beispiels
  const ladeChats = useCallback(() => api.chats(id).then(setChats, () => {}), [id]);
  useEffect(() => {
    laden(); ladeChats();
    return live(id, (typ, nr, anfrage) => {
      if (typ === "bild") {
        // Höchstens 10 wartende Anfragen; der Server wartet ohnehin nur 15 s.
        if (anfrage) { bildAnfragen.current = [...bildAnfragen.current.slice(-9), { anfrage, version: nr ?? 0, zeit: Date.now() }]; setBildTick((t) => t + 1); }
        laden(); // falls die Meldung „neue Version“ verpasst wurde (Fenster hat sich gerade erst verbunden)
        return;
      }
      if (typ === "beispiel") { ladeChats().then(() => { if (nr) setVorschau(nr); }); return; }
      if (typ !== "chat") laden();
      if (typ !== "neu") ladeChats();
    });
  }, [id, laden, ladeChats]);

  const hinweis = (t: string) => { setMeldung(t); setTimeout(() => setMeldung(""), 2500); };

  const freigegeben = daten?.projekt.status === "freigegeben";
  const nurAnsehen = !!alt || freigegeben;
  const inhalt: UrsInhalt | null = alt?.inhalt ?? daten?.aktuell.inhalt ?? null;
  const knotenListe: ArbeitsKnoten[] = alt ? alt.inhalt.knoten : arbeit?.knoten ?? LEER;
  const kantenListe: Kante[] = alt ? alt.inhalt.kanten : arbeit?.kanten ?? LEER;
  const kommentare = alt ? LEER : arbeit?.kommentare ?? LEER;

  // Marke „neu“ (U31): alles, was in der zuletzt freigegebenen Version noch nicht (so) stand.
  const freigegebeneNr = daten?.projekt.freigegebeneVersion ?? null;
  const [basis, setBasis] = useState<{ nr: number; inhalt: UrsInhalt } | null>(null);
  useEffect(() => {
    if (!freigegebeneNr) return;
    let ab = false;
    api.version(id, freigegebeneNr).then((v) => { if (!ab) setBasis({ nr: freigegebeneNr, inhalt: v.inhalt }); },
      (e) => { if (!ab) hinweis(`${tx("Marke „neu“ nicht verfügbar", "“New” marker unavailable")}: ${(e as Error).message}`); });
    return () => { ab = true; };
  }, [id, freigegebeneNr]);
  const neu = useMemo(() => neuSeitFreigabe(inhalt, knotenListe, !!alt || freigegeben, freigegebeneNr,
    basis?.nr === freigegebeneNr ? basis.inhalt : null), [inhalt, knotenListe, alt, freigegeben, freigegebeneNr, basis]);

  /** Änderung auf den neuesten Stand anwenden und der Reihe nach speichern. true = gespeichert. */
  const aendern = useCallback((f: (a: Arbeit) => Arbeit): Promise<boolean> => {
    if (!arbeitRef.current) return Promise.resolve(false);
    const neu = f(arbeitRef.current);
    arbeitRef.current = neu;
    setArbeit(neu);
    offeneSpeicher.current++;
    const ergebnis = warteschlange.current
      .then(() => api.speichern(id, neu))
      .then(() => true, (e) => { hinweis(String((e as Error).message)); return false; })
      .finally(() => { if (--offeneSpeicher.current === 0) laden(); });
    warteschlange.current = ergebnis;
    return ergebnis;
  }, [id, laden]);

  /** „Änderungen zurücksetzen“ — in derselben Warteschlange, damit kein späteres Speichern es rückgängig macht. */
  const zuruecksetzen = useCallback(() => {
    arbeitRef.current = null; // bis zum Neuladen keine Änderungen auf altem Stand
    offeneSpeicher.current++;
    warteschlange.current = warteschlange.current
      .then(() => api.verwerfen(id))
      .catch((e) => { hinweis(String((e as Error).message)); })
      .finally(() => { if (--offeneSpeicher.current === 0) laden(); });
  }, [id, laden]);

  // Positionen (U41, U44): bei jeder Änderung am Ablauf neu anordnen; von Hand verschobene Knoten (fest) bleiben stehen.
  const [pos, setPos] = useState<Record<string, { x: number; y: number }>>({});
  const [angeordnet, setAngeordnet] = useState(""); // für welchen Stand pos gilt
  const angezeigteVersion = useRef<string | null>(null);
  const startZeigen = useCallback((positionen: Record<string, { x: number; y: number }>) => {
    const start = knotenListe.find((k) => k.id === "input") ?? knotenListe[0];
    const p = start && positionen[start.id];
    const canvas = flaecheRef.current?.querySelector(".react-flow")?.getBoundingClientRect();
    if (!start || !p || !canvas?.width) return;
    const zoom = Math.min(1, (canvas.width - 32) / GROESSE[start.typ].w);
    rf.setViewport({
      x: canvas.width / 2 - (p.x + GROESSE[start.typ].w / 2) * zoom,
      y: 24 - p.y * zoom,
      zoom,
    }, { duration: 250 });
  }, [knotenListe, rf]);
  const layoutSchluessel = knotenListe.map((k) => `${k.id}:${k.typ}`).join("|") + "#" + (alt?.version ?? "a");
  const festPos = useMemo(() => {
    const p: Record<string, { x: number; y: number }> = {};
    if (!alt) for (const id of arbeit?.fest ?? []) if (arbeit?.positionen[id]) p[id] = arbeit.positionen[id];
    return p;
  }, [alt, arbeit?.fest, arbeit?.positionen]);
  const startNachAnordnen = useRef(false); // nach „Aufräumen“ zum Start springen
  const anordnungsStand = layoutSchluessel + "#" + kantenListe.map(kantenId).join("|") + "#" + JSON.stringify(festPos);
  useEffect(() => {
    if (!knotenListe.length) return;
    let ab = false;
    anordnen(knotenListe, kantenListe, festPos).then((p) => {
      if (ab) return;
      setPos(p); setAngeordnet(anordnungsStand);
      if (startNachAnordnen.current) { startNachAnordnen.current = false; setTimeout(() => startZeigen(p), 50); }
      const gespeichert = arbeitRef.current?.positionen ?? {};
      const anders = Object.entries(p).some(([k, v]) => gespeichert[k]?.x !== v.x || gespeichert[k]?.y !== v.y);
      if (!nurAnsehen && anders) aendern((a) => ({ ...a, positionen: { ...a.positionen, ...p } }));
    }, (e) => { if (!ab) hinweis(`${tx("Anordnen fehlgeschlagen", "Layout failed")}: ${(e as Error).message}`); });
    return () => { ab = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anordnungsStand]);

  // Pfeile um die Knoten herum verlegen (U40) und prüfen, ob irgendetwas etwas überdeckt.
  const platz: PlatzKnoten[] = useMemo(() => knotenListe.filter((k) => pos[k.id])
    .map((k) => ({ id: k.id, typ: k.typ, text: k.text, ...pos[k.id] })), [knotenListe, pos]);
  // Nur neu verlegen, wenn sich Plätze oder Pfeile wirklich ändern — nicht bei jedem Neuladen (Kommentar, Speichern …).
  const geometrie = platz.map((k) => `${k.id}:${k.typ}:${k.x}:${k.y}`).join("|") + "#" + kantenListe.map(kantenId).join("|");
  const rohRouten = useMemo(() => verlegen(platz, kantenListe), [geometrie]); // eslint-disable-line react-hooks/exhaustive-deps
  const routen = useMemo(() => mitNotlinien(platz, kantenListe, rohRouten), [rohRouten]); // eslint-disable-line react-hooks/exhaustive-deps

  const offenJeKnoten = useMemo(() => {
    const m = new Map<string, number>();
    for (const k of kommentare) if (!k.erledigt && k.knoten) m.set(k.knoten, (m.get(k.knoten) ?? 0) + 1);
    return m;
  }, [kommentare]);

  // Blöcke, über die gerade links gesprochen wird: letzte Nachricht ist eine Frage des Nutzers.
  const linksOffen = useMemo(() => new Set(Object.entries(chats.chats)
    .filter(([, n]) => n.length && n[n.length - 1].wer === "ich").map(([k]) => k)), [chats]);

  const [nodes, setNodes, onNodesChangeBasis] = useNodesState<KnotenNode>([]);
  useEffect(() => {
    setNodes(knotenListe.filter((k) => pos[k.id]).map((k) => ({
      id: k.id, type: "urs", position: pos[k.id], selected: k.id === gewaehlt,
      data: { typ: k.typ, text: k.text, offen: offenJeKnoten.get(k.id) ?? 0, links: linksOffen.has(k.id), neu: neu.knoten.has(k.id) },
    })));
  }, [knotenListe, pos, gewaehlt, offenJeKnoten, linksOffen, neu, setNodes]);

  // Zwei-Finger-Zoom (Trackpad) langsamer als der Standard: eigene Behandlung statt zoomOnPinch.
  useEffect(() => {
    const flaeche = document.querySelector<HTMLElement>(".flaeche .react-flow");
    if (!flaeche) return;
    const beiRad = (e: WheelEvent) => {
      if (!e.ctrlKey) return; // Trackpad-Pinch kommt als Rad-Ereignis mit ctrlKey
      e.preventDefault(); e.stopPropagation();
      const { x, y, zoom } = rf.getViewport();
      const neu = Math.min(2, Math.max(0.2, zoom * Math.pow(2, -e.deltaY * PINCH_TEMPO)));
      const r = flaeche.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top; // Punkt unter den Fingern bleibt stehen
      rf.setViewport({ x: px - ((px - x) * neu) / zoom, y: py - ((py - y) * neu) / zoom, zoom: neu });
    };
    flaeche.addEventListener("wheel", beiRad, { passive: false, capture: true });
    return () => flaeche.removeEventListener("wheel", beiRad, { capture: true });
  }, [rf, daten !== null]);

  // Bild für Claude (U38): erst, wenn die angefragte Version angezeigt und fertig angeordnet ist.
  useEffect(() => {
    if (!bildAnfragen.current.length || !daten || angeordnet !== anordnungsStand || nodes.length !== knotenListe.length) return;
    const gezeigt = alt?.version ?? daten.projekt.aktuelleVersion;
    bildAnfragen.current = bildAnfragen.current.filter((a) => Date.now() - a.zeit < 16_000); // abgelaufene verwerfen
    const jetzt = bildAnfragen.current.filter((a) => gezeigt >= a.version);
    if (!jetzt.length) return;
    bildAnfragen.current = bildAnfragen.current.filter((a) => !jetzt.includes(a));
    const bildKnoten = platz.map((k) => ({
      ...k, neu: neu.knoten.has(k.id), offen: offenJeKnoten.get(k.id) ?? 0, links: linksOffen.has(k.id), gewaehlt: k.id === gewaehlt,
    }));
    const auswahl = new Set(kantenAuswahl);
    (async () => {
      try {
        const { fliessbildPng } = await import("./bild.tsx"); // erst bei Bedarf laden
        const pngs = await fliessbildPng(bildKnoten, routen, auswahl);
        const b = befunde(platz, kantenListe, rohRouten);
        for (const a of jetzt) await api.bildAntwort(id, { anfrage: a.anfrage, version: gezeigt, pngs, befunde: b });
      } catch (e) { hinweis(`${tx("Bild für Claude", "Image for Claude")}: ${(e as Error).message}`); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bildTick, daten, alt, angeordnet, anordnungsStand, nodes.length, knotenListe.length, platz, routen, kantenListe, id]);

  // Lange Flussdiagramme beginnen lesbar beim Start. Die Gesamtansicht bleibt bewusst optional.
  useEffect(() => {
    if (angezeigteVersion.current === layoutSchluessel ||
        nodes.length !== knotenListe.length || !knotenListe.every((k) => pos[k.id])) return;
    const timer = setTimeout(() => {
      startZeigen(pos);
      angezeigteVersion.current = layoutSchluessel;
    }, 50);
    return () => clearTimeout(timer);
  }, [layoutSchluessel, knotenListe, nodes.length, pos, startZeigen]);

  const onNodesChange = (c: NodeChange<KnotenNode>[]) => onNodesChangeBasis(nurAnsehen ? c.filter((x) => x.type === "select") : c.filter((x) => x.type !== "remove"));

  // Pfeil-Auswahl selbst führen (die Pfeile kommen aus der Arbeitskopie, nicht aus React Flow).
  const [kantenAuswahl, setKantenAuswahl] = useState<Set<string>>(new Set());
  const onEdgesChange = (c: EdgeChange[]) => setKantenAuswahl((alt) => {
    const neu = new Set(alt);
    for (const x of c) if (x.type === "select") { if (x.selected) neu.add(x.id); else neu.delete(x.id); }
    return neu;
  });

  const edges: Edge<KantenDaten>[] = useMemo(() => kantenListe.flatMap((k) => {
    const a = knotenListe.find((n) => n.id === k.von), b = knotenListe.find((n) => n.id === k.nach);
    const pa = nodes.find((n) => n.id === k.von)?.position ?? pos[k.von];
    const pb = nodes.find((n) => n.id === k.nach)?.position ?? pos[k.nach];
    if (!a || !b || !pa || !pb) return [];
    // Während ein Knoten gezogen wird, gerade Linie; danach wird der Weg neu verlegt.
    const bewegt = pa !== pos[k.von] && (pa.x !== pos[k.von]?.x || pa.y !== pos[k.von]?.y) ||
      pb !== pos[k.nach] && (pb.x !== pos[k.nach]?.x || pb.y !== pos[k.nach]?.y);
    const mitte = (p: { x: number; y: number }, t: KnotenTyp) => ({ x: p.x + GROESSE[t].w / 2, y: p.y + GROESSE[t].h / 2 });
    const r = bewegt ? undefined : routen.get(kantenId(k));
    const auswahl = kantenAuswahl.has(kantenId(k));
    return [{
      id: kantenId(k), selected: auswahl, source: k.von, target: k.nach, type: "route",
      ...griffe({ ...pa, typ: a.typ }, { ...pb, typ: b.typ }),
      data: r ?? { punkte: [mitte(pa, a.typ), mitte(pb, b.typ)] },
      markerEnd: { type: MarkerType.ArrowClosed, color: auswahl ? "#1769e0" : "#132038" },
      style: { stroke: auswahl ? "#1769e0" : "#132038", strokeWidth: auswahl ? 2.4 : 1.6 },
    }];
  }), [kantenListe, knotenListe, nodes, pos, routen, kantenAuswahl]);

  if (fehler === "Noch keine URS" && eingebettet) return <div className="leerseite leer-urs">
    <h2>{t("Noch keine URS", "No URS yet")}</h2><p>{t("Links deine App-Idee eintippen, z. B. „mach mir eine URS für eine Rezept-App“. Das Diagramm erscheint dann hier.",
      "Type your app idea on the left, e.g. “make me a URS for a recipe app”. The diagram appears here.")}</p>
  </div>;
  if (fehler) return <div className="leerseite">{fehler} · <a href={eingebettet ? "/w" : "/"}>{t("alle Projekte", "all projects")}</a></div>;
  if (!daten || !arbeit || !inhalt) return <div className="leerseite">{t("lädt …", "loading …")}</div>;

  // Freigabe-Sperre (U7, U55): offene Kommentare, Fragen, Änderungen und SMART-Verstöße.
  const o = berechneOffen(daten.aktuell.inhalt, arbeit, daten.aktuell.smart);
  const grund = [o.kommentare && t(`${o.kommentare} Kommentar${o.kommentare > 1 ? "e" : ""}`, `${o.kommentare} comment${o.kommentare > 1 ? "s" : ""}`),
    o.fragen && t(`${o.fragen} Frage${o.fragen > 1 ? "n" : ""}`, `${o.fragen} question${o.fragen > 1 ? "s" : ""}`),
    o.aenderungen && t(`${o.aenderungen} Änderung${o.aenderungen > 1 ? "en" : ""} für Claude`, `${o.aenderungen} change${o.aenderungen > 1 ? "s" : ""} for Claude`),
    o.smart && (daten.aktuell.smart
      ? t(`${o.smart} Anforderung${o.smart > 1 ? "en" : ""} nicht SMART`, `${o.smart} requirement${o.smart > 1 ? "s" : ""} not SMART`)
      : t("SMART ungeprüft — Claude soll die URS neu einreichen", "SMART not checked — ask Claude to resubmit the URS"))].filter(Boolean);
  // SMART-Ergebnis der angezeigten Version (U54) — bei älteren Versionen deren eigenes.
  const smart = alt ? alt.smart : daten.aktuell.smart;


  const neuerKnoten = (typ: KnotenTyp) => {
    const kid = `n-${Date.now().toString(36)}`;
    // Rechts neben das Diagramm, auf Höhe der Bildmitte — so überdeckt der neue Knoten nichts.
    const box = document.querySelector(".react-flow")!.getBoundingClientRect();
    const mitte = rf.screenToFlowPosition({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
    const rechts = Math.max(...knotenListe.map((k) => (pos[k.id]?.x ?? 0) + GROESSE[k.typ].w), 0);
    const p = { x: rechts + 80, y: mitte.y - GROESSE[typ].h / 2 };
    aendern((a) => ({
      ...a, knoten: [...a.knoten, { id: kid, typ, text: tx("Neu", "New"), anforderungen: [] }],
      positionen: { ...a.positionen, [kid]: p },
    }));
    setPos((alt) => ({ ...alt, [kid]: p }));
    setGewaehlt(kid); setFrischId(kid);
  };

  const loeschen = (ids: string[]) => {
    if (!ids.length) return Promise.resolve(false);
    const weg = new Set(ids);
    setGewaehlt(null);
    return aendern((a) => ({
      ...a,
      knoten: a.knoten.filter((k) => !weg.has(k.id)),
      kanten: a.kanten.filter((k) => !weg.has(k.von) && !weg.has(k.nach)),
      kommentare: a.kommentare.map((k) => (k.knoten && weg.has(k.knoten) ? { ...k, knoten: null } : k)),
    }));
  };

  const verbinden = (c: Connection) => {
    if (!c.source || !c.target || c.source === c.target) return;
    const von = knotenListe.find((k) => k.id === c.source);
    const bedingung = von?.typ === "entscheidung" ? prompt(tx("Bedingung (z. B. ja / nein):", "Condition (e.g. yes / no):"))?.trim() || undefined : undefined;
    const neu: Kante = { von: c.source, nach: c.target, ...(bedingung ? { bedingung } : {}) };
    aendern((a) => (a.kanten.some((k) => kantenId(k) === kantenId(neu)) ? a : { ...a, kanten: [...a.kanten, neu] }));
  };

  // „Aufräumen“ (U45): alle von Hand gesetzten Plätze vergessen, das ganze Fließbild ordnet sich neu.
  const aufraeumen = async () => {
    if (!arbeit.fest?.length) { startZeigen(pos); return; } // nichts von Hand gesetzt — Bild ist schon aufgeräumt
    startNachAnordnen.current = true;
    await aendern((a) => ({ ...a, fest: [] }));
  };

  const freigabe = async () => {
    if (!confirm(t(`Version ${daten.projekt.aktuelleVersion} freigeben? Danach ist sie eingefroren.`, `Approve version ${daten.projekt.aktuelleVersion}? It will be frozen afterwards.`))) return;
    try { await api.freigeben(id, daten.projekt.aktuelleVersion); await laden(); } catch (e) { hinweis(String((e as Error).message)); }
  };

  const versionWaehlen = async (n: number) => {
    setGewaehlt(null);
    if (n === daten.projekt.aktuelleVersion) { setAlt(null); return; }
    setAlt(await api.version(id, n));
  };

  const knoten = knotenListe.find((k) => k.id === gewaehlt) ?? null;

  /**
   * Vorschlag aus dem Punkt-Chat in die Arbeitskopie übernehmen — Claude arbeitet ihn danach per urs_get_feedback ein.
   * Erst speichern, dann als übernommen markieren: scheitert das Speichern, bleibt der Vorschlag offen.
   */
  const vorschlagUebernehmen = async (kid: string, n: Nachricht) => {
    const v = n.vorschlag;
    const alt = knotenListe.find((k) => k.id === kid);
    if (!v || !alt || nurAnsehen) return;
    let gespeichert: boolean;
    if (v.art === "umbenennen") {
      gespeichert = await aendern((a) => ({ ...a, knoten: a.knoten.map((k) => (k.id === kid ? { ...k, text: v.text } : k)) }));
    } else if (v.art === "loeschen") {
      gespeichert = await loeschen([kid]);
    } else if (v.art === "hinweis") {
      gespeichert = await aendern((a) => ({ ...a, kommentare: [...a.kommentare, {
        id: crypto.randomUUID(), knoten: kid, text: `${tx("Vorschlag aus dem Chat", "Suggestion from the chat")}: ${v.text}`, zeit: new Date().toISOString(), erledigt: false,
      }] }));
    } else {
      // Neuer Punkt direkt danach: die bisherigen Pfeile gehen ab dem neuen Punkt weiter (außer bei Entscheidungen mit ja/nein).
      // Ohne gespeicherte Position ordnet das Diagramm sich danach automatisch neu an.
      const nid = `n-${Date.now().toString(36)}`;
      gespeichert = await aendern((a) => {
        const kanten = alt.typ === "entscheidung" ? a.kanten : a.kanten.map((k) => (k.von === kid ? { ...k, von: nid } : k));
        return { ...a, knoten: [...a.knoten, { id: nid, typ: v.typ, text: v.text, anforderungen: [...alt.anforderungen] }],
          kanten: [...kanten, { von: kid, nach: nid }] };
      });
      if (gespeichert) setGewaehlt(nid);
    }
    if (!gespeichert) return;
    // Markieren; bei einem Netzfehler einmal nachversuchen, sonst bliebe der Vorschlag offen und doppelt übernehmbar.
    const markieren = () => api.vorschlag(id, kid, n.id, "ok");
    await markieren().catch(markieren).then(ladeChats, (e) => hinweis(String(e.message)));
  };
  const vorschlagAblehnen = (kid: string, n: Nachricht) => { api.vorschlag(id, kid, n.id, "nein").catch((e) => hinweis(String(e.message))); };

  return (
    <div className={`seite${nurAnsehen ? " gesperrt" : ""}${knoten ? " mit-auswahl" : ""}`}>
      <header>
        <h1>{eingebettet ? inhalt.name : <a href="/">{inhalt.name}</a>}</h1>
        <select value={alt?.version ?? daten.projekt.aktuelleVersion} onChange={(e) => versionWaehlen(Number(e.target.value))}>
          {[...daten.versionen].reverse().map((v) => (
            <option key={v.version} value={v.version}>Version {v.version} · {zeit(v.erstellt)}{v.freigegeben ? t(" · freigegeben", " · approved") : ""}</option>
          ))}
        </select>
        {alt ? <span className="badge b-alt">{t("nur ansehen", "view only")}</span>
          : freigegeben ? <span className="badge b-frei">{t("Freigegeben", "Approved")}</span>
          : <span className="badge b-entwurf">{t("Entwurf · wartet auf dich", "Draft · waiting for you")}</span>}
        <span className="sp" />
        {!nurAnsehen && <>
          <span className="grund">{grund.length ? `${t("Noch offen", "Still open")}: ${grund.join(", ")}` : t("Alles erledigt", "All done")}</span>
          {o.aenderungen > 0 && <button onClick={zuruecksetzen}>{t("Änderungen zurücksetzen", "Reset changes")}</button>}
          <button className="haupt" disabled={grund.length > 0} onClick={freigabe}>{t("Freigeben", "Approve")}</button>
        </>}
      </header>
      {freigegeben && !alt && <div className="frei-banner">✓ {t(`Version ${daten.projekt.aktuelleVersion} freigegeben`, `Version ${daten.projekt.aktuelleVersion} approved`)}</div>}
      <div className="koerper">
        <div className="flaeche" ref={flaecheRef}>
          {!nurAnsehen && <div className="werkzeuge">
            <button onClick={() => neuerKnoten("schritt")}>+ {TYP_NAME("schritt")}</button>
            <button onClick={() => neuerKnoten("entscheidung")}>+ {TYP_NAME("entscheidung")}</button>
            <button onClick={() => neuerKnoten("nutzer")}>+ {TYP_NAME("nutzer")}</button>
            <button onClick={() => neuerKnoten("speicher")}>+ {TYP_NAME("speicher")}</button>
            <button onClick={aufraeumen} title={t("Ganzes Fließbild neu ordnen — auch von Hand verschobene Knoten", "Re-arrange the whole flowchart — including nodes moved by hand")}>{t("Aufräumen", "Tidy up")}</button>
          </div>}
          <div className="ansicht-werkzeuge">
            <button onClick={() => startZeigen(pos)}>{t("Start zeigen", "Show start")}</button>
            <button onClick={() => rf.fitView({ padding: 0.15 })}>{t("Gesamtansicht", "Fit view")}</button>
            <button title={t("Vergrößern", "Zoom in")} aria-label={t("Vergrößern", "Zoom in")} onClick={() => rf.zoomIn()}>+</button>
            <button title={t("Verkleinern", "Zoom out")} aria-label={t("Verkleinern", "Zoom out")} onClick={() => rf.zoomOut()}>−</button>
            <span>{t("Scrollen: Ablauf folgen · Ziehen: verschieben", "Scroll: follow the flow · Drag: move")}</span>
            <span className="sp-flex" />
            {eingebettet && <button className={ansicht.sichtbar.term ? "" : "an"} title={t("Terminal links aus-/einblenden", "Hide/show terminal on the left")}
              onClick={() => umschalten("term")}>{ansicht.sichtbar.term ? "◧ Terminal" : t("◧ Terminal zeigen", "◧ Show terminal")}</button>}
            <button className={ansicht.sichtbar.seite ? "" : "an"} title={t("Seitenfeld rechts aus-/einblenden", "Hide/show side panel")}
              onClick={() => umschalten("seite")}>{ansicht.sichtbar.seite ? t("Seitenfeld ◨", "Side panel ◨") : t("Seitenfeld zeigen ◨", "Show side panel ◨")}</button>
          </div>
          <ReactFlow
            nodes={nodes} edges={edges} nodeTypes={knotenTypen} edgeTypes={kantenTypen}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
            onNodeClick={(_, n) => {
              setGewaehlt(n.id);
              zeigen("seite"); // Block angeklickt → Seitenfeld aufklappen (U29)
            }}
            onPaneClick={() => setGewaehlt(null)}
            onNodeDragStop={(_, __, bewegt) => {
              if (nurAnsehen) return;
              // Von Hand gesetzt → bleibt dort (U44). Mitte aufs Raster, damit Pfeile genau mittig andocken.
              const p = { ...pos };
              const raster = (v: number) => Math.round(v / 10) * 10;
              for (const n of bewegt) {
                const g = GROESSE[(n.data as { typ: KnotenTyp }).typ];
                p[n.id] = { x: raster(n.position.x + g.w / 2) - g.w / 2, y: raster(n.position.y + g.h / 2) - g.h / 2 };
              }
              setPos(p);
              aendern((a) => ({ ...a, positionen: { ...a.positionen, ...p }, fest: [...new Set([...(a.fest ?? []), ...bewegt.map((n) => n.id)])] }));
            }}
            onNodesDelete={(ns) => loeschen(ns.map((n) => n.id))}
            onEdgesDelete={(es) => {
              const weg = new Set(es.map((e) => e.id));
              aendern((a) => ({ ...a, kanten: a.kanten.filter((k) => !weg.has(kantenId(k))) }));
            }}
            onConnect={verbinden}
            connectionMode={ConnectionMode.Loose}
            nodesDraggable={!nurAnsehen} nodesConnectable={!nurAnsehen} edgesFocusable={!nurAnsehen}
            deleteKeyCode={nurAnsehen ? null : ["Delete", "Backspace"]}
            minZoom={0.2} maxZoom={2} panOnScroll zoomOnScroll={false} zoomOnPinch={false}
            proOptions={{ hideAttribution: true }}
          />
          {vorschau !== null && chats.beispiele.find((b) => b.nr === vorschau) &&
            <Vorschau projektId={id} beispiel={chats.beispiele.find((b) => b.nr === vorschau)!} schliessen={() => setVorschau(null)} />}
        </div>
        {ansicht.sichtbar.seite && <Griff spalte="seite" rechts />}
        {/* Eingeklappt: schmaler Streifen mit « zum Aufklappen — wie bei der Chat-Liste links (U15). */}
        {!ansicht.sichtbar.seite && <div className="seite-eingeklappt">
          <button className="einklappen" title={t("Seitenfeld einblenden", "Show side panel")} onClick={() => umschalten("seite")}>«</button>
        </div>}
        <aside style={{ width: ansicht.breite.seite, display: ansicht.sichtbar.seite ? undefined : "none" }}>
          <button className="einklappen seite-zu" title={t("Seitenfeld ausblenden", "Hide side panel")} onClick={() => umschalten("seite")}>»</button>
          {knoten ? (
            <KnotenPanel key={knoten.id} knoten={knoten} inhalt={inhalt} neuU={neu.u} smart={smart} nurAnsehen={nurAnsehen}
              fokus={frischId === knoten.id} fokusErledigt={fokusErledigt}
              umbenennen={(t) => aendern((a) => ({ ...a, knoten: a.knoten.map((k) => (k.id === knoten.id ? { ...k, text: t } : k)) }))}
              loeschen={() => loeschen([knoten.id])}
              aendern={aendern} kommentare={kommentare.filter((k) => k.knoten === knoten.id)}
              chat={<PunktChat projektId={id} chatId={chat} knotenId={knoten.id} name={knoten.text} nachrichten={chats.chats[knoten.id] ?? LEER}
                beispiele={chats.beispiele.filter((b) => b.knoten === knoten.id)} zeigeBeispiel={setVorschau} nurAnsehen={nurAnsehen} meldung={hinweis} neuLaden={ladeChats}
                uebernehmen={(n) => vorschlagUebernehmen(knoten.id, n)} ablehnen={(n) => vorschlagAblehnen(knoten.id, n)} />} />
          ) : (
            <><Allgemein inhalt={inhalt} neuU={neu.u} smart={smart} nurAnsehen={nurAnsehen} aendern={aendern}
              kommentare={kommentare.filter((k) => k.knoten === null)} />
            <BeispielListe beispiele={chats.beispiele.filter((b) => !b.knoten || !knotenListe.some((k) => k.id === b.knoten))} zeigen={setVorschau} /></>
          )}
          <Fragen inhalt={inhalt} arbeit={arbeit} nurAnsehen={nurAnsehen} aendern={aendern} />
        </aside>
      </div>
      {meldung && <div className="hinweis">{meldung}</div>}
    </div>
  );
}

type Aendern = (f: (a: Arbeit) => Arbeit) => void;

function KnotenPanel({ knoten, inhalt, neuU, smart, nurAnsehen, fokus, fokusErledigt, umbenennen, loeschen, aendern, kommentare, chat }: {
  knoten: ArbeitsKnoten; inhalt: UrsInhalt; neuU: Set<string>; smart?: SmartPruefung; nurAnsehen: boolean; fokus: boolean; fokusErledigt: () => void;
  umbenennen: (t: string) => void; loeschen: () => void; aendern: Aendern; kommentare: Arbeit["kommentare"]; chat: React.ReactNode;
}) {
  const t = useT();
  const [text, setText] = useState(knoten.text);
  useEffect(() => setText(knoten.text), [knoten.text]);
  // Nur direkt nach dem Anlegen springt der Cursor ins Namensfeld — sonst bleibt die Entf-Taste fürs Löschen.
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (fokus && !nurAnsehen) { ref.current?.select(); fokusErledigt(); } }, [fokus, nurAnsehen, fokusErledigt]);
  const fertig = () => { const t = text.trim(); if (t && t !== knoten.text) umbenennen(t); else setText(knoten.text); };
  const anf = knoten.anforderungen.map((id) => inhalt.anforderungen.find((a) => a.id === id)).filter((a) => a && !a.gestrichen);
  return <>
    <h2>{TYP_NAME(knoten.typ)}</h2>
    {nurAnsehen ? <div className="titel">{knoten.text}</div> : <>
      <input ref={ref} className="titel-eingabe" value={text} onChange={(e) => setText(e.target.value)}
        onBlur={fertig} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
      <div className="zeile"><button onClick={loeschen}>{t("Löschen", "Delete")}</button></div>
    </>}
    <div className="anforderungen">
      {anf.map((a) => <AnfKarte key={a!.id} a={a!} neu={neuU.has(a!.id)} smart={smart?.[a!.id]} />)}
    </div>
    {chat}
    <KommentarListe knotenId={knoten.id} kommentare={kommentare} nurAnsehen={nurAnsehen} aendern={aendern} />
  </>;
}

const VORSCHLAG_TEXT = (v: NonNullable<Nachricht["vorschlag"]>, alt: string) =>
  v.art === "umbenennen" ? tx(`Umbenennen: „${alt}“ → „${v.text}“`, `Rename: “${alt}” → “${v.text}”`)
    : v.art === "neuer_schritt" ? tx(`Neuer ${TYP_NAME(v.typ)} danach: „${v.text}“`, `New ${TYP_NAME(v.typ)} after it: “${v.text}”`)
    : v.art === "loeschen" ? tx(`Punkt „${alt}“ löschen`, `Delete “${alt}”`)
    : `${tx("Hinweis an Claude", "Note to Claude")}: ${v.text}`;

/** Frage zum Block: wird links im Terminal besprochen. Hier bleiben nur Fragen, Beispiele und am Ende der Vorschlag. */
function PunktChat({ projektId, chatId, knotenId, name, nachrichten, beispiele, zeigeBeispiel, nurAnsehen, meldung, neuLaden, uebernehmen, ablehnen }: {
  projektId: string; chatId: string; knotenId: string; name: string; nachrichten: Nachricht[]; beispiele: Beispiel[]; zeigeBeispiel: (nr: number) => void;
  nurAnsehen: boolean; meldung: (t: string) => void; neuLaden: () => unknown;
  uebernehmen: (n: Nachricht) => Promise<void>; ablehnen: (n: Nachricht) => void;
}) {
  const t = useT();
  const [text, setText] = useState("");
  const [inArbeit, setInArbeit] = useState<string | null>(null); // gegen Doppelklick auf „Übernehmen“
  const annehmen = async (n: Nachricht) => {
    if (inArbeit) return;
    setInArbeit(n.id);
    try { await uebernehmen(n); } finally { setInArbeit(null); }
  };
  const [sendet, setSendet] = useState(false);
  // Screenshots fürs Block-Feld (U39): per Cmd+V oder Hineinziehen, als Datei abgelegt, Claude bekommt den Pfad.
  const [bilder, setBilder] = useState<{ pfad: string; vorschau: string }[]>([]);
  const bilderNehmen = async (d: DataTransfer | null, e: React.SyntheticEvent) => {
    const dateien = bilderAus(d);
    // Andere Dateien nicht vom Browser öffnen lassen (sonst verlässt das Fenster die Werkbank).
    if (!dateien.length) { if (e.type === "drop" && d && [...d.items].some((i) => i.kind === "file")) { e.preventDefault(); meldung(t("Nur Bilder (Screenshots) lassen sich hier ablegen", "Only images (screenshots) can be dropped here")); } return; }
    e.preventDefault();
    for (const f of dateien) {
      try {
        const vorschau = await alsDatenUrl(f);
        const { pfad } = await api.bildAblegen(projektId, vorschau);
        setBilder((b) => [...b, { pfad, vorschau }]);
      } catch (er) { meldung(String((er as Error).message)); }
    }
  };
  const ende = useRef<HTMLDivElement>(null);
  useEffect(() => { ende.current?.scrollIntoView({ block: "nearest" }); }, [nachrichten.length]);
  const senden = async () => {
    const t = text.trim(); if ((!t && !bilder.length) || sendet) return;
    setSendet(true);
    try {
      await api.frage(projektId, knotenId, t, chatId, bilder.map((b) => b.pfad)); setText(""); setBilder([]); neuLaden();
      window.dispatchEvent(new CustomEvent("urs-terminal-fokus", { detail: `${projektId}#${chatId}` })); // links weiterreden
    } catch (e) { meldung(String((e as Error).message)); }
    finally { setSendet(false); }
  };
  return <>
    <h2>{t("Frage an Claude", "Ask Claude")}</h2>
    {nachrichten.map((n) => <div key={n.id}>
      <div className={`msg ${n.wer}${n.fehler ? " fehler" : ""}`}>
        <div className="wer">{n.wer === "ich" ? t("Du", "You") : n.fehler ? t("Fehler", "Error") : "Claude"}</div>{n.text}
        {n.wer === "ich" && <div className="links-hinweis">◀ {t("Antwort links im Terminal", "Answer in the terminal on the left")}
          {n === nachrichten[nachrichten.length - 1] && <> · <a href="#" onClick={(e) => {
            e.preventDefault(); api.erledigt(projektId, knotenId).then(neuLaden, (er) => meldung(String(er.message)));
          }}>{t("erledigt, keine Änderung", "done, no change")}</a></>}</div>}
      </div>
      {n.vorschlag && <div className={`vorschlag ${n.vorschlagStatus ?? ""}`}>
        <b>{t("Ergebnis aus dem Gespräch", "Result of the conversation")}</b>{VORSCHLAG_TEXT(n.vorschlag, n.knotenText ?? name)}
        {n.vorschlagStatus === "offen" && n.knotenText && n.knotenText !== name ? <div className="zeile">
          <span className="meta">{t("Veraltet — der Block hat sich inzwischen geändert.", "Outdated — the block has changed since.")}</span><button disabled={!!inArbeit} onClick={() => ablehnen(n)}>{t("Verwerfen", "Discard")}</button>
        </div> : n.vorschlagStatus === "offen" ? (nurAnsehen ? <div className="meta">{t("Nur ansehen — nicht übernehmbar.", "View only — cannot be applied.")}</div> : <div className="zeile">
          <button className="haupt" disabled={!!inArbeit} onClick={() => annehmen(n)}>{t("Übernehmen", "Apply")}</button>
          <button disabled={!!inArbeit} onClick={() => ablehnen(n)}>{t("Ablehnen", "Reject")}</button>
        </div>) : <div className="meta">{n.vorschlagStatus === "ok" ? t("✓ übernommen — Claude baut es in die nächste Version ein", "✓ applied — Claude adds it to the next version") : t("abgelehnt", "rejected")}</div>}
      </div>}
    </div>)}
    <BeispielListe beispiele={beispiele} zeigen={zeigeBeispiel} />
    <div ref={ende} />
    {bilder.length > 0 && <div className="bild-anhaenge">
      {bilder.map((b) => <span key={b.pfad} className="bild-anhang">
        <img src={b.vorschau} alt="Screenshot" />
        <button title={t("Screenshot entfernen", "Remove screenshot")} onClick={() => setBilder((x) => x.filter((y) => y.pfad !== b.pfad))}>×</button>
      </span>)}
    </div>}
    <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={t("Frage zu diesem Block … (Antwort kommt links)", "Question about this block … (answer on the left)")}
      onPaste={(e) => bilderNehmen(e.clipboardData, e)}
      onDragOver={(e) => { if ([...e.dataTransfer.items].some((i) => i.kind === "file")) e.preventDefault(); }}
      onDrop={(e) => bilderNehmen(e.dataTransfer, e)}
      onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); senden(); } }} />
    <div className="zeile"><button className="haupt" onClick={senden} disabled={(!text.trim() && !bilder.length) || sendet}>{t("Links besprechen", "Discuss on the left")}</button></div>
  </>;
}

function BeispielListe({ beispiele, zeigen }: { beispiele: Beispiel[]; zeigen: (nr: number) => void }) {
  const t = useT();
  if (!beispiele.length) return null;
  return <div className="beispiele">
    {beispiele.map((b) => <button key={b.nr} className="beispiel-knopf" onClick={() => zeigen(b.nr)}>📊 {t("Beispiel ansehen", "View example")}: {b.titel}</button>)}
  </div>;
}

/** Vorschau-Fenster für Claudes Beispiele: abgeschottet (sandbox), ohne Zugriff auf die App. */
function Vorschau({ projektId, beispiel, schliessen }: { projektId: string; beispiel: Beispiel; schliessen: () => void }) {
  const t = useT();
  return <div className="vorschau">
    <div className="vorschau-kopf"><b>{beispiel.titel}</b><span className="meta">{t("Beispiel von Claude", "Example from Claude")} · {zeit(beispiel.zeit)}</span>
      <button onClick={schliessen}>{t("Schließen", "Close")}</button></div>
    <iframe title={beispiel.titel} sandbox="allow-scripts" src={`/api/p/${encodeURIComponent(projektId)}/beispiel/${beispiel.nr}`} />
  </div>;
}

/** Eine Anforderung als Karte; noch nicht freigegeben → Marke „neu“ (U31); darunter das SMART-Ergebnis (U54). */
function AnfKarte({ a, neu, smart }: { a: UrsInhalt["anforderungen"][number]; neu: boolean; smart?: SmartErgebnis }) {
  const t = useT();
  return <div className={`karte${neu ? " ist-neu" : ""}`}><span className="u-tag">{a.id}</span>{a.text}{neu && <span className="marke-neu">{t("neu", "new")}</span>}
    <div className={`smart ${!smart ? "ungeprueft" : smart.ok ? "ok" : "verfehlt"}`}>
      {!smart ? t("SMART: nicht geprüft", "SMART: not checked") : smart.ok ? t("✓ SMART erfüllt", "✓ SMART met") : t("✗ SMART verfehlt", "✗ SMART not met")}
      {smart?.grund && <span className="smart-grund"> — {smart.grund}</span>}
    </div>
  </div>;
}

function Allgemein({ inhalt, neuU, smart, nurAnsehen, aendern, kommentare }: {
  inhalt: UrsInhalt; neuU: Set<string>; smart?: SmartPruefung; nurAnsehen: boolean; aendern: Aendern; kommentare: Arbeit["kommentare"];
}) {
  const t = useT();
  const anf = inhalt.anforderungen.filter((a) => !a.gestrichen);
  return <>
    <h2>{t("Zweck", "Purpose")}</h2><div>{inhalt.zweck}</div>
    {anf.length > 0 && <><h2>{t("Anforderungen", "Requirements")}</h2><div className="anforderungen">{anf.map((a) => <AnfKarte key={a.id} a={a} neu={neuU.has(a.id)} smart={smart?.[a.id]} />)}</div></>}
    {inhalt.sicherheit.length > 0 && <><h2>{t("Darf nicht", "Must not")}</h2><ul>{inhalt.sicherheit.map((s, i) => <li key={i}>{s}</li>)}</ul></>}
    {inhalt.nichtEnthalten.length > 0 && <><h2>{t("Nicht enthalten", "Not included")}</h2><ul>{inhalt.nichtEnthalten.map((s, i) => <li key={i}>{s}</li>)}</ul></>}
    <KommentarListe knotenId={null} kommentare={kommentare} nurAnsehen={nurAnsehen} aendern={aendern} />
  </>;
}

function KommentarListe({ knotenId, kommentare, nurAnsehen, aendern }: {
  knotenId: string | null; kommentare: Arbeit["kommentare"]; nurAnsehen: boolean; aendern: Aendern;
}) {
  const t = useT();
  const [neu, setNeu] = useState("");
  const abhaken = (kid: string) => aendern((a) => ({ ...a, kommentare: a.kommentare.map((k) => (k.id === kid ? { ...k, erledigt: !k.erledigt } : k)) }));
  const speichern = () => {
    const t = neu.trim(); if (!t) return;
    aendern((a) => ({ ...a, kommentare: [...a.kommentare, { id: crypto.randomUUID(), knoten: knotenId, text: t, zeit: new Date().toISOString(), erledigt: false }] }));
    setNeu("");
  };
  if (nurAnsehen && !kommentare.length) return null;
  return <>
    <h2>{t("Kommentare", "Comments")}</h2>
    {kommentare.map((k) => (
      <div key={k.id} className={`komm${k.erledigt ? " erledigt" : ""}`}>
        <div className="txt">{k.text}</div>
        <div className="meta">{zeit(k.zeit)} · <label><input type="checkbox" checked={k.erledigt} disabled={nurAnsehen} onChange={() => abhaken(k.id)} /> {t("erledigt", "done")}</label></div>
      </div>
    ))}
    {!nurAnsehen && <>
      <textarea value={neu} onChange={(e) => setNeu(e.target.value)} placeholder={t("Kommentar …", "Comment …")} />
      <div className="zeile"><button onClick={speichern} disabled={!neu.trim()}>{t("Speichern", "Save")}</button></div>
    </>}
  </>;
}

function Fragen({ inhalt, arbeit, nurAnsehen, aendern }: { inhalt: UrsInhalt; arbeit: Arbeit; nurAnsehen: boolean; aendern: Aendern }) {
  const t = useT();
  const [entwurf, setEntwurf] = useState<Record<string, string>>({});
  if (!inhalt.fragen.length) return null;
  return <>
    <h2>{t("Fragen", "Questions")}</h2>
    {inhalt.fragen.map((f) => {
      const bearbeiten = f.id in entwurf;
      const antwort = bearbeiten ? undefined : arbeit.antworten[f.id];
      return (
        <div key={f.id} className={`karte ${antwort ? "beantwortet" : "unbeantwortet"}`}>
          <div>{f.text}</div>
          {antwort ? <div className="meta">{t("Antwort", "Answer")}: {antwort}{!nurAnsehen && <> · <a href="#" onClick={(e) => {
            e.preventDefault(); setEntwurf({ ...entwurf, [f.id]: antwort });
          }}>{t("ändern", "change")}</a></>}</div>
            : !nurAnsehen && <>
              <input type="text" value={entwurf[f.id] ?? ""} placeholder={t("Antwort", "Answer")} onChange={(e) => setEntwurf({ ...entwurf, [f.id]: e.target.value })} />
              <div className="zeile"><button disabled={!entwurf[f.id]?.trim()} onClick={() => {
                const t = entwurf[f.id].trim();
                aendern((a) => ({ ...a, antworten: { ...a.antworten, [f.id]: t } }));
                const r = { ...entwurf }; delete r[f.id]; setEntwurf(r);
              }}>{t("Speichern", "Save")}</button></div>
            </>}
        </div>
      );
    })}
  </>;
}

export function Liste() {
  const t = useT();
  const [p, setP] = useState<Awaited<ReturnType<typeof api.projekte>> | null>(null);
  useEffect(() => { api.projekte().then(setP); }, []);
  return <div className="leerseite">
    <h1>Virtuv</h1>
    {!p ? t("lädt …", "loading …") : !p.length ? <p>{t("Noch keine URS. In Claude Code eine App-Idee beschreiben.", "No URS yet. Describe an app idea in Claude Code.")}</p>
      : <ul>{p.map((x) => <li key={x.id}><a href={`/p/${x.id}`}>{x.name}</a> · Version {x.version} · {x.status === "freigegeben" ? t("freigegeben", "approved") : t("Entwurf", "draft")}</li>)}</ul>}
  </div>;
}
