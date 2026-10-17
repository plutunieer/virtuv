// Werkbank-Oberfläche wie Warp: links alle Chats (wie Tabs in Warp), rechts Fenster (nebeneinander/übereinander) oder Kacheln.
// Strg+T / Cmd+T oder „+“ öffnet einen neuen Chat ohne Ordnerwahl (U77); die anderen laufen weiter (U27).
// Der Ordner wird erst zum Bauen gewählt (U78), der Plan zieht dann mit (U79). Projekte stehen in den Kacheln.
import { useCallback, useEffect, useRef, useState } from "react";
import { umschalten, useAnsicht } from "./ansicht.ts";
import { api, type Einrichtung, type Uebersicht } from "./api.ts";
import { Griff } from "./Griff.tsx";
import { TerminalFeld, Werkbank, chatUid } from "./Werkbank.tsx";
import { SPRACHEN, aktuelleSprache, spracheSetzen, tx, useSprache, useT, type Sprache } from "./sprache.ts";

/** Ein Chat = eine Claude-Sitzung in einem Projektordner (wie ein Tab in Warp). */
// name: selbst vergebener Name (Doppelklick, U33); sonst heißt der Chat wie sein Projekt (U32).
type Chat = { projektId: string; chat: string; name?: string };
const uidVon = (c: Chat) => chatUid(c.projektId, c.chat);
// Jede Spalte hat eine feste Kennung — sonst baut React beim Teilen/Schließen die Fenster daneben neu auf.
type Spalte = { key: string; ids: string[] }; // ids = Chat-Kennungen „<projektId>#<chat>“
type Layout = { chats: Chat[]; spalten: Spalte[]; aktiv: string | null; ansicht: "fenster" | "kacheln" };
const neueSpalte = (ids: string[]): Spalte => ({ key: crypto.randomUUID(), ids });
const SPEICHER = "urs-werkbank-layout";
const LEER: Layout = { chats: [], spalten: [], aktiv: null, ansicht: "kacheln" };

/** Mac-App: Brücke aus preload.cjs. Im Browser fehlt sie — dann Pfad eintippen. */
const mac = (window as unknown as { urs?: { istApp: boolean; ordnerWaehlen: (sprache: Sprache) => Promise<string | null> } }).urs;

function ladeLayout(): Layout {
  try {
    const l = JSON.parse(localStorage.getItem(SPEICHER) ?? "null") as (Partial<Layout> & { spalten?: Spalte[] }) | null;
    if (l && Array.isArray(l.spalten) && l.spalten.every((s) => s && Array.isArray(s.ids))) {
      for (const s of l.spalten) s.key ??= crypto.randomUUID();
      // Ältere Speicherung (Fenster = Projekte, ohne Chats): jedes offene Projekt wird zu „Chat 1“.
      if (!Array.isArray(l.chats)) {
        l.chats = l.spalten.flatMap((s) => s.ids).map((pid) => ({ projektId: pid, chat: "1" }));
        for (const s of l.spalten) s.ids = s.ids.map((pid) => chatUid(pid, "1"));
        l.aktiv = l.aktiv ? chatUid(l.aktiv, "1") : null;
      }
      return { chats: l.chats, spalten: l.spalten, aktiv: l.aktiv ?? null, ansicht: l.ansicht ?? "kacheln" };
    }
  } catch { /* privater Modus o. Ä. */ }
  return LEER;
}

export function Shell() {
  const t = useT();
  const [einrichtung, setEinrichtung] = useState<Einrichtung | null>(null);
  const pruefen = useCallback(() => { setEinrichtung(null); api.einrichtung().then(setEinrichtung, () => setEinrichtung({ claude: false, angemeldet: false, abo: false, hinweis: tx("Server antwortet nicht.", "Server not responding.") })); }, []);
  useEffect(pruefen, [pruefen]);
  if (!einrichtung) return <div className="leerseite">{t("Prüfe Claude Code …", "Checking Claude Code …")}</div>;
  // Ohne Abo (z. B. mit API-Schlüssel angemeldet) nicht starten: das würde extra kosten.
  if (!einrichtung.claude || !einrichtung.angemeldet || !einrichtung.abo) return <EinrichtungsSeite e={einrichtung} nochmal={pruefen} />;
  return <Arbeitsflaeche />;
}

function EinrichtungsSeite({ e, nochmal }: { e: Einrichtung; nochmal: () => void }) {
  const t = useT();
  const befehl = "curl -fsSL https://claude.ai/install.sh | bash";
  return <div className="leerseite einrichtung">
    <h1>{t("Fast fertig", "Almost done")}</h1>
    <p>{t("Virtuv plant deine App mit ", "Virtuv plans your app with ")}<b>Claude Code</b>{t(" und deinem eigenen Claude-Abo.", " and your own Claude subscription.")} {e.hinweis}</p>
    <ol>
      <li className={e.claude ? "erledigt" : ""}><b>{t("Claude Code installieren", "Install Claude Code")}</b>{e.claude ? " ✓" : <>
        <div>{t("Programm „Terminal“ öffnen, diese Zeile einfügen, Enter:", "Open the “Terminal” app, paste this line, press Enter:")}</div>
        <div className="zeile"><code>{befehl}</code><button onClick={() => navigator.clipboard?.writeText(befehl)}>{t("Kopieren", "Copy")}</button></div>
      </>}</li>
      <li className={e.abo ? "erledigt" : ""}><b>{t("Mit deinem Claude-Abo anmelden", "Sign in with your Claude subscription")}</b>{e.abo ? " ✓" : <>
        <div>{t("Im Terminal ", "In the terminal type ")}<code>claude</code>{t(" eintippen, Enter, und mit deinem Claude-Konto (Pro oder Max) anmelden.", ", press Enter and sign in with your Claude account (Pro or Max).")}
          {e.angemeldet && <>{t(" Du bist gerade anders angemeldet (z. B. mit API-Schlüssel) — dann zuerst ", " You are signed in differently (e.g. with an API key) — first run ")}<code>claude auth logout</code>.</>}</div>
      </>}</li>
    </ol>
    <div className="zeile"><button className="haupt" onClick={nochmal}>{t("Erneut prüfen", "Check again")}</button>
      <a href="https://docs.claude.com/en/docs/claude-code/setup" target="_blank" rel="noreferrer">{t("Hilfe zur Installation", "Installation help")}</a></div>
  </div>;
}

function Arbeitsflaeche() {
  const t = useT();
  const sprache = useSprache();
  const [layout, setLayoutRoh] = useState<Layout>(ladeLayout);
  const setLayout = useCallback((f: (l: Layout) => Layout) => setLayoutRoh((alt) => {
    const neu = f(alt);
    try { localStorage.setItem(SPEICHER, JSON.stringify(neu)); } catch { /* egal */ }
    return neu;
  }), []);
  const [projekte, setProjekte] = useState<Uebersicht[]>([]);
  const [laeuft, setLaeuft] = useState<Record<string, boolean>>({}); // je Chat: läuft Claude?
  const [suche, setSuche] = useState("");
  const [meldung, setMeldung] = useState("");
  const [ladeFehler, setLadeFehler] = useState("");
  const melde = (t: string) => { setMeldung(t); setTimeout(() => setMeldung(""), 4000); };

  // Übersicht alle 3 s auffrischen (Projekte, offene Fragen, Stand).
  const laden = useCallback(() => {
    api.uebersicht().then((p) => { setProjekte(p); setLadeFehler(""); }, (e) => setLadeFehler(String(e.message)));
  }, []);
  useEffect(() => { laden(); const t = setInterval(laden, 3000); return () => clearInterval(t); }, [laden]);

  // Gerade angelegte oder umgezogene Projekte: eine noch laufende ältere Abfrage kennt sie nicht — nicht wegräumen.
  const frisch = useRef(new Map<string, number>());
  const frischMerken = (id: string) => frisch.current.set(id, Date.now());

  // Chats zu Projekten, die es nicht mehr gibt, aus Liste und Fenstern nehmen.
  useEffect(() => {
    if (!projekte.length) return;
    const da = new Set(projekte.map((p) => p.id));
    for (const [id, zeit] of frisch.current) if (Date.now() - zeit < 10_000) da.add(id); else frisch.current.delete(id);
    if (layout.chats.some((c) => !da.has(c.projektId))) {
      setLayout((l) => {
        const chats = l.chats.filter((c) => da.has(c.projektId));
        const ok = new Set(chats.map(uidVon));
        const spalten = l.spalten.map((s) => ({ ...s, ids: s.ids.filter((u) => ok.has(u)) })).filter((s) => s.ids.length);
        return { ...l, chats, spalten, aktiv: l.aktiv && ok.has(l.aktiv) ? l.aktiv : spalten[0]?.ids[0] ?? null };
      });
    }
  }, [projekte]); // eslint-disable-line react-hooks/exhaustive-deps

  // Zustand (läuft Claude?) meldet jedes Terminal selbst.
  useEffect(() => {
    const info = (e: Event) => {
      const { uid, laeuft: l } = (e as CustomEvent<{ uid: string; laeuft?: boolean }>).detail;
      if (l !== undefined) setLaeuft((alt) => (alt[uid] === l ? alt : { ...alt, [uid]: l }));
    };
    window.addEventListener("urs-chat-info", info);
    return () => window.removeEventListener("urs-chat-info", info);
  }, []);

  const offen = layout.spalten.flatMap((s) => s.ids);
  const projekt = (pid: string) => projekte.find((p) => p.id === pid);
  const chatVon = (uid: string) => layout.chats.find((c) => uidVon(c) === uid);
  // Plan ohne Ordner und noch ohne Ablauf: „Neuer Plan“ statt des Namens des Ablageordners.
  const chatName = (c: Chat) => { const p = projekt(c.projektId); return c.name || (p?.ohneOrdner && !p.version ? t("Neuer Plan", "New plan") : p?.name) || "…"; };
  const [umbenennen, setUmbenennen] = useState<string | null>(null); // uid des Chats, dessen Name gerade bearbeitet wird
  const nameSetzen = (uid: string, name: string) => {
    setUmbenennen(null);
    const n = name.trim().slice(0, 80);
    setLayout((l) => ({ ...l, chats: l.chats.map((c) => (uidVon(c) === uid ? { ...c, name: n || undefined } : c)) }));
  };

  /** Chat zeigen: ist er in einem Fenster, dorthin; sonst ersetzt er den Chat im aktiven Fenster (wie ein Tab-Wechsel). */
  const zeigen = (uid: string) => setLayout((l) => {
    if (l.spalten.some((s) => s.ids.includes(uid))) return { ...l, aktiv: uid, ansicht: "fenster" };
    if (!l.spalten.length || !l.aktiv) return { ...l, spalten: [...l.spalten, neueSpalte([uid])], aktiv: uid, ansicht: "fenster" };
    const alt = l.aktiv;
    return { ...l, spalten: l.spalten.map((s) => ({ ...s, ids: s.ids.map((u) => (u === alt ? uid : u)) })), aktiv: uid, ansicht: "fenster" };
  });

  /** Ordner wählen: Mac-Dialog (App) bzw. Pfad eintippen (Browser). */
  const ordnerFragen = async () => (mac ? await mac.ordnerWaehlen(aktuelleSprache()) : prompt(tx("Pfad des Projektordners:", "Path of the project folder:"), "~/Documents/"));

  /** Neues Projekt in einem gewählten Ordner (Kachel „Neues Projekt“). Liefert die id. */
  const neuesProjekt = async (): Promise<string | null> => {
    const pfad = await ordnerFragen();
    if (!pfad) return null;
    try { const { id } = await api.oeffnen(pfad); laden(); return id; }
    catch (e) { melde(String((e as Error).message)); return null; }
  };

  /** Plan ohne Ordner (U77): startet sofort, der Ordner kommt erst zum Bauen dazu. */
  const neuerPlan = async (): Promise<string | null> => {
    try { const { id } = await api.neuerEntwurf(); frischMerken(id); laden(); return id; }
    catch (e) { melde(String((e as Error).message)); return null; }
  };

  /** Chats eines umgezogenen Plans hängen ab jetzt am neuen Projekt (gleicher Chat, gleiches Gespräch). */
  const umgezogen = useCallback((pid: string, neu: string) => {
    frischMerken(neu);
    setLayout((l) => {
      if (!l.chats.some((c) => c.projektId === pid)) return l;
      const um = (u: string) => (u.startsWith(`${pid}#`) ? chatUid(neu, u.slice(pid.length + 1)) : u);
      return { ...l, chats: l.chats.map((c) => (c.projektId === pid ? { ...c, projektId: neu } : c)),
        spalten: l.spalten.map((s) => ({ ...s, ids: s.ids.map(um) })), aktiv: l.aktiv ? um(l.aktiv) : null };
    });
    laden();
  }, [setLayout, laden]);
  // Umzug aus einem anderen Fenster (oder vom Server gemeldet): hier genauso umziehen.
  useEffect(() => {
    const beiUmzug = (e: Event) => { const { alt, neu } = (e as CustomEvent<{ alt: string; neu: string }>).detail; umgezogen(alt, neu); };
    window.addEventListener("urs-chat-umzug", beiUmzug);
    return () => window.removeEventListener("urs-chat-umzug", beiUmzug);
  }, [umgezogen]);

  /**
   * Plan ohne Ordner in einen gewählten Ordner umziehen (U79): Chats dieses Plans hängen danach am neuen Projekt,
   * das Gespräch geht dort weiter. Ist der Plan schon freigegeben, baut Claude danach (U78).
   */
  const ordnerZuweisen = async (pid: string) => {
    const pfad = await ordnerFragen();
    if (!pfad) return;
    try {
      umgezogen(pid, (await api.umziehen(pid, pfad)).id);
    } catch (e) { melde(String((e as Error).message)); }
  };

  /**
   * Neuer Chat. Strg+T / Cmd+T / „+“ starten sofort einen Plan ohne Ordner (U77) und übernehmen nie das Projekt
   * des aktiven Chats. Nur „Neuer Chat in diesem Projekt“ im Fenstermenü und die Kacheln geben projektId mit.
   */
  const neuerChat = useCallback(async (projektId?: string, ziel?: { bei: string; wo: "rechts" | "unten" }) => {
    const pid = projektId ?? await neuerPlan();
    if (!pid) return;
    const c: Chat = { projektId: pid, chat: crypto.randomUUID().slice(0, 8) };
    const uid = uidVon(c);
    setLayout((alt) => {
      const chats = [...alt.chats, c];
      if (ziel) {
        const si = alt.spalten.findIndex((s) => s.ids.includes(ziel.bei));
        const spalten = alt.spalten.map((s) => ({ ...s, ids: [...s.ids] }));
        if (si < 0) spalten.push(neueSpalte([uid]));
        else if (ziel.wo === "rechts") spalten.splice(si + 1, 0, neueSpalte([uid]));
        else spalten[si].ids.splice(spalten[si].ids.indexOf(ziel.bei) + 1, 0, uid);
        return { ...alt, chats, spalten, aktiv: uid, ansicht: "fenster" };
      }
      if (!alt.spalten.length || !alt.aktiv) return { ...alt, chats, spalten: [...alt.spalten, neueSpalte([uid])], aktiv: uid, ansicht: "fenster" };
      const a = alt.aktiv;
      return { ...alt, chats, spalten: alt.spalten.map((s) => ({ ...s, ids: s.ids.map((u) => (u === a ? uid : u)) })), aktiv: uid, ansicht: "fenster" };
    });
  }, [setLayout]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Chat schließen (wie einen Tab): Claude dieses Chats endet, die anderen laufen weiter. */
  const chatSchliessen = (uid: string) => {
    const c = chatVon(uid);
    if (c) api.chatSchliessen(c.projektId, c.chat).catch((e) => melde(String(e.message)));
    setLayout((l) => {
      const spalten = l.spalten.map((s) => ({ ...s, ids: s.ids.filter((u) => u !== uid) })).filter((s) => s.ids.length);
      const chats = l.chats.filter((c) => uidVon(c) !== uid);
      return { ...l, chats, spalten, aktiv: l.aktiv === uid ? spalten[0]?.ids[0] ?? null : l.aktiv, ansicht: spalten.length ? l.ansicht : "kacheln" };
    });
  };
  /** Fenster schließen: der Chat läuft weiter und bleibt links in der Liste. */
  const fensterSchliessen = (uid: string) => setLayout((l) => {
    const spalten = l.spalten.map((s) => ({ ...s, ids: s.ids.filter((u) => u !== uid) })).filter((s) => s.ids.length);
    return { ...l, spalten, aktiv: l.aktiv === uid ? spalten[0]?.ids[0] ?? null : l.aktiv, ansicht: spalten.length ? l.ansicht : "kacheln" };
  });
  /** Projekt öffnen (Kachel): letzten Chat dieses Projekts zeigen, sonst einen neuen starten. */
  const projektOeffnen = (pid: string) => {
    const letzter = [...layout.chats].reverse().find((c) => c.projektId === pid);
    if (letzter) zeigen(uidVon(letzter)); else neuerChat(pid);
  };

  // Tastenkürzel überall in der Werkbank — auch im Terminal (dort gibt TerminalFeld sie nicht an Claude weiter):
  // Strg+T / Cmd+T neuer Chat (U27), Strg+W schließt den aktiven Chat, Strg+Tab nächster Chat, Cmd+1–9 Chat 1–9 (U35).
  const tastenRef = useRef({ neuerChat, chatSchliessen, zeigen, layout });
  tastenRef.current = { neuerChat, chatSchliessen, zeigen, layout };
  useEffect(() => {
    const taste = (e: KeyboardEvent) => {
      const { neuerChat, chatSchliessen, zeigen, layout: l } = tastenRef.current;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && !e.altKey && k === "t") { e.preventDefault(); neuerChat(); return; }
      if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && k === "w") {
        // In Eingabefeldern (Suche, Kommentar, Frage) bleibt Strg+W beim Feld; im Terminal schließt es den Chat (U35).
        const ziel = e.target as HTMLElement | null;
        if (ziel && (ziel.tagName === "INPUT" || (ziel.tagName === "TEXTAREA" && !ziel.closest(".xterm")))) return;
        e.preventDefault();
        if (l.ansicht === "fenster" && l.aktiv) chatSchliessen(l.aktiv);
        return;
      }
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "Tab") {
        e.preventDefault();
        if (!l.chats.length) return;
        // In der Projekt-Ansicht zuerst den zuletzt aktiven Chat zeigen statt gleich weiterzuspringen.
        if (l.ansicht !== "fenster" && l.aktiv && l.chats.some((c) => uidVon(c) === l.aktiv)) { zeigen(l.aktiv); return; }
        const i = l.chats.findIndex((c) => uidVon(c) === l.aktiv);
        const n = l.chats.length, schritt = e.shiftKey ? -1 : 1;
        zeigen(uidVon(l.chats[((i < 0 ? -schritt : i) + schritt + n) % n]));
        return;
      }
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        const c = l.chats[Number(e.key) - 1];
        e.preventDefault();
        if (c) zeigen(uidVon(c));
      }
    };
    window.addEventListener("keydown", taste, true);
    return () => window.removeEventListener("keydown", taste, true);
  }, []);

  const ansicht = useAnsicht();
  const q = suche.toLowerCase();
  const liste = layout.chats.filter((c) => chatName(c).toLowerCase().includes(q) || (projekt(c.projektId)?.name ?? "").toLowerCase().includes(q));
  /** Aus der Übersicht nehmen (U26): Ordner und Dateien bleiben; die Chats des Projekts enden. */
  const entfernen = async (p: Uebersicht) => {
    if (!confirm(t(`„${p.name}“ aus der Übersicht entfernen?\n\nOrdner und Dateien bleiben erhalten. Mit „+ Neues Projekt“ kannst du ihn jederzeit wieder hinzufügen.`,
      `Remove “${p.name}” from the overview?\n\nFolder and files are kept. You can add it again anytime with “+ New project”.`))) return;
    try {
      await api.entfernen(p.id);
      setLayout((l) => {
        const chats = l.chats.filter((c) => c.projektId !== p.id);
        const ok = new Set(chats.map(uidVon));
        const spalten = l.spalten.map((s) => ({ ...s, ids: s.ids.filter((u) => ok.has(u)) })).filter((s) => s.ids.length);
        return { ...l, chats, spalten, aktiv: l.aktiv && ok.has(l.aktiv) ? l.aktiv : spalten[0]?.ids[0] ?? null };
      });
      laden();
    } catch (e) { melde(String((e as Error).message)); }
  };
  const offeneProjekte = [...new Set(offen.map((u) => chatVon(u)?.projektId).filter(Boolean) as string[])];
  // Chats ohne Fenster bleiben im Hintergrund verbunden — Claude arbeitet weiter, der Titel bleibt aktuell (wie Tabs in Warp).
  // In der Projekt-Ansicht sind keine Fenster zu sehen — dann laufen alle Chats im Hintergrund weiter.
  const sichtbarOffen = layout.ansicht === "fenster" ? offen : [];
  const hintergrund = layout.chats.filter((c) => !sichtbarOffen.includes(uidVon(c)));

  return <div className="shell">
    <div className="shell-kopf">
      <b>Virtuv</b><span className="app-version" title={t("Version der App", "App version")}>{__APP_VERSION__}</span>
      <div className="umschalter">
        <button className={layout.ansicht === "fenster" ? "an" : ""} disabled={!offen.length} onClick={() => setLayout((l) => ({ ...l, ansicht: "fenster" }))}>▥ {t("Fenster", "Windows")}</button>
        <button className={layout.ansicht === "kacheln" ? "an" : ""} onClick={() => setLayout((l) => ({ ...l, ansicht: "kacheln" }))}>▦ {t("Projekte", "Projects")}</button>
      </div>
      <span className="meta">{layout.chats.length} Chat{layout.chats.length === 1 ? "" : "s"} · {t("neuer Chat: Strg+T / ⌘T", "new chat: Ctrl+T / ⌘T")}</span>
      <span className="sp" />
      {/* Sprache der Oberfläche (U58) — startet auf Englisch (U57). */}
      <select className="sprache" aria-label={t("Sprache", "Language")} title={t("Sprache", "Language")} value={sprache}
        onChange={(e) => spracheSetzen(e.target.value as Sprache)}>
        {SPRACHEN.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </div>
    <div className="shell-haupt">
      {!ansicht.sichtbar.leiste ? (
        <nav className="leiste eingeklappt">
          <button className="einklappen" title={t("Chat-Liste einblenden", "Show chat list")} onClick={() => umschalten("leiste")}>»</button>
        </nav>
      ) : <>
      <nav className="leiste" style={{ width: ansicht.breite.leiste }}>
        <div className="leiste-kopf">
          <span>Chats</span>
          <button className="einklappen" title={t("Chat-Liste ausblenden", "Hide chat list")} onClick={() => umschalten("leiste")}>«</button>
        </div>
        <div className="leiste-suche">
          <input type="text" value={suche} placeholder={t("Chats suchen …", "Search chats …")} onChange={(e) => setSuche(e.target.value)} />
          <button title={t("Neuer Chat (Strg+T / ⌘T)", "New chat (Ctrl+T / ⌘T)")} onClick={() => neuerChat()}>+</button>
        </div>
        <div className="liste">
          {liste.map((c) => {
            const uid = uidVon(c), p = projekt(c.projektId);
            // div statt <button>: beim Umbenennen steckt ein Eingabefeld darin (in einem Knopf nicht erlaubt).
            return <div key={uid} role="button" tabIndex={0} className={`eintrag${layout.ansicht === "fenster" && layout.aktiv === uid ? " aktiv" : ""}`}
              onClick={(e) => { if (e.detail < 2) zeigen(uid); }} onDoubleClick={() => setUmbenennen(uid)}
              onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); zeigen(uid); } }}
              title={`${p?.pfad ?? ""}\n${t("Doppelklick: umbenennen", "Double-click: rename")}`}>
              <span className={`punkt${laeuft[uid] ? " laeuft" : ""}`} title={laeuft[uid] ? t("Claude läuft", "Claude running") : t("Claude aus", "Claude stopped")} />
              <span className="eintrag-text">
                {umbenennen === uid
                  ? <NamensFeld name={chatName(c)} fertig={(n) => nameSetzen(uid, n)} abbrechen={() => setUmbenennen(null)} />
                  : <span className="name">{chatName(c)}</span>}
              </span>
              <span className="entfernen" role="button" title={t("Chat schließen (Strg+W)", "Close chat (Ctrl+W)")}
                onClick={(e) => { e.stopPropagation(); chatSchliessen(uid); }}>×</span>
            </div>;
          })}
          {!liste.length && <div className="meta leer-liste">{layout.chats.length ? t("Nichts gefunden.", "Nothing found.") : t("Noch kein Chat — mit + oder Strg+T / ⌘T starten.", "No chat yet — start one with + or Ctrl+T / ⌘T.")}</div>}
        </div>
      </nav>
      <Griff spalte="leiste" />
      </>}
      <main className="shell-rechts">
        {layout.ansicht === "fenster" && offen.length > 0 ? (
          <div className="fenster">
            {layout.spalten.map((spalte) => <div className="spalte" key={spalte.key}>
              {spalte.ids.map((uid) => {
                const c = chatVon(uid);
                if (!c) return null;
                return <Pane key={uid} c={c} name={chatName(c)} projekt={projekt(c.projektId)} laeuft={!!laeuft[uid]}
                  ordnerWaehlen={() => ordnerZuweisen(c.projektId)}
                  aktiv={layout.aktiv === uid} waehlen={() => setLayout((l) => (l.aktiv === uid ? l : { ...l, aktiv: uid }))}
                  frei={layout.chats.filter((x) => !offen.includes(uidVon(x)))} chatName={chatName}
                  teilen={(wo, ziel) => {
                    if (ziel) setLayout((l) => {
                      const si = l.spalten.findIndex((s) => s.ids.includes(uid));
                      const spalten = l.spalten.map((s) => ({ ...s, ids: [...s.ids] }));
                      if (si < 0) spalten.push(neueSpalte([ziel]));
                      else if (wo === "rechts") spalten.splice(si + 1, 0, neueSpalte([ziel]));
                      else spalten[si].ids.splice(spalten[si].ids.indexOf(uid) + 1, 0, ziel);
                      return { ...l, spalten, aktiv: ziel };
                    });
                    else neuerChat(c.projektId, { bei: uid, wo });
                  }}
                  schliessen={() => fensterSchliessen(uid)} />;
              })}
            </div>)}
          </div>
        ) : (
          <Kacheln projekte={projekte} offen={offeneProjekte} oeffnen={projektOeffnen} entfernen={entfernen}
            neu={async () => { const id = await neuesProjekt(); if (id) neuerChat(id); }} />
        )}
      </main>
    </div>
    <div className="hintergrund" aria-hidden="true">
      {hintergrund.map((c) => <TerminalFeld key={uidVon(c)} id={c.projektId} chat={c.chat} pfad="" kompakt hintergrund />)}
    </div>
    {meldung && <div className="hinweis">{meldung}</div>}
    {ladeFehler && <div className="hinweis">{t("Übersicht nicht erreichbar", "Overview unreachable")}: {ladeFehler}</div>}
  </div>;
}

/** Eingabefeld zum Umbenennen eines Chats: Enter/Klick daneben = übernehmen, Esc = abbrechen. */
function NamensFeld({ name, fertig, abbrechen }: { name: string; fertig: (n: string) => void; abbrechen: () => void }) {
  const [text, setText] = useState(name);
  const ref = useRef<HTMLInputElement>(null);
  const erledigt = useRef(false);
  useEffect(() => { ref.current?.select(); }, []);
  const ende = (ok: boolean) => { if (erledigt.current) return; erledigt.current = true; if (ok) fertig(text); else abbrechen(); };
  return <input ref={ref} className="name-eingabe" value={text} maxLength={80} aria-label={tx("Chatname", "Chat name")}
    onChange={(e) => setText(e.target.value)} onBlur={() => ende(true)}
    onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
    onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") ende(true); if (e.key === "Escape") ende(false); }} />;
}

function Pane({ c, name, projekt, laeuft, aktiv, waehlen, frei, chatName, teilen, schliessen, ordnerWaehlen }: {
  c: Chat; name: string; projekt?: Uebersicht; laeuft: boolean; aktiv: boolean; waehlen: () => void; frei: Chat[]; ordnerWaehlen: () => void;
  chatName: (c: Chat) => string; teilen: (wo: "rechts" | "unten", ziel: string | null) => void; schliessen: () => void;
}) {
  const t = useT();
  const [menue, setMenue] = useState<"rechts" | "unten" | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menue) return;
    const zu = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setMenue(null); };
    document.addEventListener("mousedown", zu);
    return () => document.removeEventListener("mousedown", zu);
  }, [menue]);
  return <section className={`pane${aktiv ? " aktiv" : ""}`} onMouseDown={waehlen}>
    <div className="pane-kopf" ref={ref}>
      <span className={`punkt${laeuft ? " laeuft" : ""}`} />
      <b title={projekt?.pfad}>{name}</b>
      {/* Plan ohne Ordner (U77–U79): Ordner jederzeit wählbar; nach der Freigabe ist er der nächste Schritt (U78). */}
      {projekt?.ohneOrdner && (projekt.status === "freigegeben"
        ? <button className="haupt" title={t("Freigegeben — wähle den Projektordner, dann baut Claude dort", "Approved — choose the project folder, then Claude builds there")} onClick={ordnerWaehlen}>📁 {t("Ordner wählen, dann bauen", "Choose folder to build")}</button>
        : <button title={t("Ohne Ordner wird nur geplant. Der Plan zieht in den gewählten Ordner um.", "Without a folder Claude only plans. The plan moves into the chosen folder.")} onClick={ordnerWaehlen}>📁 {t("Ordner wählen", "Choose folder")}</button>)}
      {projekt?.version != null && !(projekt.ohneOrdner && projekt.status === "freigegeben") && (projekt.status === "freigegeben"
        ? <span className="phase bauen" title={t("Freigegeben: Claude baut genau diese Version", "Approved: Claude builds exactly this version")}>🔨 {t("Bauen", "Build")}</span>
        : <span className="phase planen" title={t("Claude plant zuerst den Ablauf, gebaut wird nach der Freigabe", "Claude plans the flow first; building starts after approval")}>✎ {t("Planen", "Plan")}</span>)}
      <button title={t("Chat rechts daneben öffnen", "Open chat to the right")} onClick={() => setMenue(menue === "rechts" ? null : "rechts")}>⇥ {t("rechts", "right")}</button>
      <button title={t("Chat darunter öffnen", "Open chat below")} onClick={() => setMenue(menue === "unten" ? null : "unten")}>⤓ {t("unten", "below")}</button>
      <button title={t("Fenster schließen (der Chat läuft weiter und bleibt links in der Liste)", "Close window (the chat keeps running and stays in the list)")} onClick={schliessen}>✕</button>
      {menue && <div className="menue">
        <div className="meta">{menue === "rechts" ? t("Rechts daneben öffnen:", "Open to the right:") : t("Darunter öffnen:", "Open below:")}</div>
        <button className="neu" onClick={() => { setMenue(null); teilen(menue, null); }}>＋ {t("Neuer Chat in diesem Projekt", "New chat in this project")}</button>
        {frei.map((x) => <button key={uidVon(x)} onClick={() => { setMenue(null); teilen(menue, uidVon(x)); }}>{chatName(x)}</button>)}
      </div>}
    </div>
    <div className="pane-inhalt"><Werkbank id={c.projektId} chat={c.chat} kompakt /></div>
  </section>;
}

function Kacheln({ projekte, offen, oeffnen, entfernen, neu }: {
  projekte: Uebersicht[]; offen: string[]; oeffnen: (id: string) => void; entfernen: (p: Uebersicht) => void; neu: () => void;
}) {
  const t = useT();
  return <div className="kacheln"><div className="raster">
    {projekte.map((p) => <button key={p.id} className="kachel" onClick={() => oeffnen(p.id)} title={p.pfad}>
      <span className="kachel-kopf">
        <span className={`punkt${p.laeuft ? " laeuft" : ""}`} />
        <b>{p.ohneOrdner && !p.version ? t("Neuer Plan", "New plan") : p.name}</b>
        {p.ohneOrdner && <span className="badge b-entwurf" title={t("Plan ohne Projektordner", "Plan without a project folder")}>{t("ohne Ordner", "no folder")}</span>}
        {p.version && <span className={`badge ${p.status === "freigegeben" ? "b-frei" : "b-entwurf"}`}>{p.status === "freigegeben" ? t("freigegeben", "approved") : t("Entwurf", "draft")}</span>}
        <span className="entfernen" role="button" title={t("Aus der Übersicht entfernen (löscht nichts)", "Remove from overview (deletes nothing)")}
          onClick={(e) => { e.stopPropagation(); entfernen(p); }}>×</span>
      </span>
      <span className="mini"><MiniDiagramm bloecke={p.bloecke} /></span>
      <span className="zahlen">
        {p.version ? <><span><b>{p.anzahl}</b> {t("Blöcke", "blocks")}</span><span><b>{p.fragen}</b> {t("offene Fragen", "open questions")}</span></> : <span>{t("noch kein Ablauf", "no flow yet")}</span>}
        {offen.includes(p.id) && <span className="im-fenster">● {t("im Fenster", "in a window")}</span>}
      </span>
    </button>)}
    <button className="kachel neu-kachel" onClick={neu}>+ {t("Neues Projekt (Ordner wählen …)", "New project (choose folder …)")}</button>
  </div></div>;
}

/** Vorschau der ersten Blöcke als kleine senkrechte Kette. */
function MiniDiagramm({ bloecke }: { bloecke: string[] }) {
  if (!bloecke.length) return <svg viewBox="0 0 260 120" width="100%" height="100%"><text x="130" y="64" fontSize="12" textAnchor="middle" fill="#4a5a74">{tx("leer", "empty")}</text></svg>;
  const h = 120, dy = (h - 16) / bloecke.length, bh = Math.min(22, dy * 0.62);
  return <svg viewBox={`0 0 260 ${h}`} width="100%" height="100%">
    {bloecke.map((t, i) => {
      const y = 8 + i * dy;
      return <g key={i}>
        {i < bloecke.length - 1 && <line x1="130" y1={y + bh} x2="130" y2={y + dy} stroke="#132038" strokeWidth="1" />}
        <rect x="55" y={y} width="150" height={bh} rx={i === 0 ? bh / 2 : 3} fill="#fff" stroke="#132038" strokeWidth="1" />
        <text x="130" y={y + bh / 2} fontSize={Math.min(10.5, bh * 0.5)} textAnchor="middle" dominantBaseline="middle" fill="#132038">
          {t.length > 26 ? t.slice(0, 25) + "…" : t}</text>
      </g>;
    })}
  </svg>;
}
