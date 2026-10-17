// Werkbank („Warp mit URS“): links ein Chat (echtes Claude Code im Projektordner), rechts die URS des Ordners.
// Ein Projekt kann mehrere Chats haben — wie Tabs in Warp (U27); jeder Chat ist eine eigene Claude-Sitzung.
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { ProjektSeite } from "./App.tsx";
import { useAnsicht } from "./ansicht.ts";
import { Griff } from "./Griff.tsx";
import { alsDatenUrl, api, bilderAus, type Ordner } from "./api.ts";
import { tx, useT } from "./sprache.ts";

/** Kennung eines Chats: „<projektId>#<chat>“. */
export const chatUid = (id: string, chat: string) => `${id}#${chat}`;

export function Werkbank({ id, chat = "1", kompakt = false }: { id: string; chat?: string; kompakt?: boolean }) {
  const [ordner, setOrdner] = useState<Ordner | null>(null);
  useEffect(() => { api.ordner().then((l) => setOrdner(l.find((o) => o.id === id) ?? null), () => {}); }, [id]);
  const ansicht = useAnsicht();
  // Ausgeblendet bleibt das Terminal verbunden (Claude arbeitet weiter), es ist nur nicht zu sehen (U21).
  return <div className={`werkbank${kompakt ? " kompakt" : ""}`}>
    <div className="term-spalte" style={{ width: ansicht.breite.term, display: ansicht.sichtbar.term ? undefined : "none" }}>
      <TerminalFeld id={id} chat={chat} pfad={ordner?.pfad ?? ""} kompakt={kompakt} />
    </div>
    {ansicht.sichtbar.term && <Griff spalte="term" />}
    <div className="urs-spalte"><ProjektSeite id={id} chat={chat} eingebettet /></div>
  </div>;
}

// Helle Farben, dunkle Schrift. minimumContrastRatio dunkelt zu helle Farben zusätzlich ab.
const THEMA = {
  background: "#fbfcfe", foreground: "#132038", cursor: "#1769e0", cursorAccent: "#fbfcfe", selectionBackground: "#cfe0f8",
  black: "#132038", red: "#b42318", green: "#0b6b3a", yellow: "#8a5b12", blue: "#1769e0", magenta: "#7a2a8f", cyan: "#0e6f7f", white: "#4a5a74",
  brightBlack: "#4a5a74", brightRed: "#b42318", brightGreen: "#0b6b3a", brightYellow: "#8a5b12", brightBlue: "#134a94",
  brightMagenta: "#7a2a8f", brightCyan: "#0e6f7f", brightWhite: "#132038",
};

/** Meldet den Zustand eines Chats an die Liste links (Shell). */
const melden = (uid: string, info: { laeuft?: boolean }) =>
  window.dispatchEvent(new CustomEvent("urs-chat-info", { detail: { uid, ...info } }));

/** hintergrund: Chat ohne Fenster — nur an ein laufendes Claude hängen (Titel/Zustand), nie selbst eins starten. */
export function TerminalFeld({ id, chat = "1", pfad, kompakt, hintergrund = false }: { id: string; chat?: string; pfad: string; kompakt: boolean; hintergrund?: boolean }) {
  const t = useT();
  const uid = chatUid(id, chat);
  const ref = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const sendenRef = useRef<(m: object) => void>(() => {});
  const [laeuft, setLaeuft] = useState(true);
  const [phase, setPhase] = useState<"planen" | "bauen">("planen");
  const [verbunden, setVerbunden] = useState(false);

  useEffect(() => {
    const term = new Terminal({
      fontFamily: 'ui-monospace, Menlo, "SF Mono", monospace', fontSize: 13, lineHeight: 1.15,
      cursorBlink: true, minimumContrastRatio: 4.5, theme: THEMA, scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current!);
    const sichtbar = () => !!ref.current && !ref.current.closest(".hintergrund") && !!ref.current.offsetParent;
    const senden = (m: object) => { if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(m)); };
    sendenRef.current = senden;
    // Beim Nachspielen alter Ausgabe beantwortet xterm darin enthaltene Rückfragen — die dürfen nicht als Tastendruck zu Claude.
    let wiedergabe = 0;
    // Nur sichtbare Terminals bestimmen die Größe — ein verstecktes würde Claude sonst auf seine Breite umstellen.
    const groesse = () => { if (!sichtbar()) return; try { fit.fit(); } catch { /* noch unsichtbar */ } senden({ typ: "groesse", cols: term.cols, rows: term.rows }); };

    let aus = false;
    const verbinden = () => {
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/term?p=${encodeURIComponent(id)}&c=${encodeURIComponent(chat)}${hintergrund ? "&hg=1" : ""}`);
      wsRef.current = ws;
      ws.onopen = () => { setVerbunden(true); term.reset(); groesse(); }; // Server schickt die bisherige Ausgabe neu
      ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data)) as { typ: string; d?: string; laeuft?: boolean; wiedergabe?: boolean; phase?: "planen" | "bauen"; titel?: string; id?: string };
        // Plan ist in einen Ordner umgezogen (U79): nicht mehr mit dem alten Plan verbinden, die Liste zieht den Chat um.
        if (m.typ === "umzug" && m.id) { aus = true; window.dispatchEvent(new CustomEvent("urs-chat-umzug", { detail: { alt: id, neu: m.id } })); return; }
        if (m.typ === "phase" && m.phase) setPhase(m.phase);
        if (m.typ === "status") melden(uid, { laeuft: !!m.laeuft });
        if (m.typ === "aus" && m.d && m.wiedergabe) { wiedergabe++; term.write(m.d, () => { wiedergabe--; }); }
        else if (m.typ === "aus" && m.d) term.write(m.d);
        else if (m.typ === "leeren") term.reset();
        else if (m.typ === "status") setLaeuft(!!m.laeuft);
      };
      ws.onclose = () => { setVerbunden(false); if (!aus && !hintergrund) setTimeout(verbinden, 1500); };
    };
    // Während der Wiedergabe nur xterms automatische Antworten (Steuerfolgen ESC[ / ESC] / ESC P …) verwerfen,
    // echte Tastendrücke und eine einzelne ESC-Taste durchlassen.
    // Shift+Enter = neue Zeile statt Abschicken (U13): Claude Code versteht ESC+Enter als Zeilenumbruch.
    term.attachCustomKeyEventHandler((e) => {
      // Chat-Kürzel fängt die Werkbank selbst ab (Shell) — hier nur nicht an Claude geben:
      // Strg+T / Cmd+T neuer Chat (U27), Strg+W schließen, Strg+Tab wechseln, Cmd+1–9 springen (U35).
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "t") return false;
      if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "w") return false;
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "Tab") return false;
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) return false;
      if (e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.type === "keydown") senden({ typ: "ein", d: "\x1b\r" });
        return false;
      }
      return true;
    });
    // Screenshots ins Terminal (U39): Cmd+V oder Hineinziehen → als Datei ablegen, den Pfad an Claude geben.
    // Claude Code erkennt einen eingefügten Bildpfad und hängt das Bild an.
    const bildEinfuegen = async (d: DataTransfer | null, e: Event) => {
      const dateien = bilderAus(d);
      if (!dateien.length) {
        // Andere Dateien nicht vom Browser öffnen lassen (sonst verlässt das Fenster die Werkbank).
        if (e.type === "drop" && [...(d?.items ?? [])].some((i) => i.kind === "file")) { e.preventDefault(); term.write(`\r\n\x1b[33m${tx("Nur Bilder (Screenshots) lassen sich hier ablegen.", "Only images (screenshots) can be dropped here.")}\x1b[0m\r\n`); }
        return;
      }
      e.preventDefault(); e.stopPropagation();
      for (const f of dateien) {
        try {
          const { pfad } = await api.bildAblegen(id, await alsDatenUrl(f));
          if (!/^\/[^\x00-\x1f\x7f\s]+$/.test(pfad)) throw new Error(tx("Ablageort enthält Leer- oder Steuerzeichen", "Storage path contains spaces or control characters"));
          term.paste(pfad + " ");
        }
        catch (er) { term.write(`\r\n\x1b[31mScreenshot: ${(er as Error).message}\x1b[0m\r\n`); }
      }
      term.focus();
    };
    const beiEinfuegen = (e: ClipboardEvent) => { bildEinfuegen(e.clipboardData, e); };
    const beiZiehen = (e: DragEvent) => { if ([...(e.dataTransfer?.items ?? [])].some((i) => i.kind === "file")) e.preventDefault(); };
    const beiAblegen = (e: DragEvent) => { bildEinfuegen(e.dataTransfer, e); };
    const feld = ref.current!;
    feld.addEventListener("paste", beiEinfuegen, true);
    feld.addEventListener("dragover", beiZiehen);
    feld.addEventListener("drop", beiAblegen);
    const ein = term.onData((d) => { if (!wiedergabe || !(d.length > 1 && d.startsWith("\x1b"))) senden({ typ: "ein", d }); });
    // Nach einer Frage am Block rechts: Cursor ins Terminal, damit man links direkt weiterschreiben kann.

    const fokus = (e: Event) => { if ((e as CustomEvent<string>).detail === uid && sichtbar()) term.focus(); };
    window.addEventListener("urs-terminal-fokus", fokus);
    const ro = new ResizeObserver(groesse);
    ro.observe(ref.current!);
    verbinden();
    if (sichtbar()) term.focus(); // nur sichtbare Chats holen sich den Cursor
    return () => {
      aus = true; wsRef.current?.close(); ein.dispose(); ro.disconnect();
      feld.removeEventListener("paste", beiEinfuegen, true); feld.removeEventListener("dragover", beiZiehen); feld.removeEventListener("drop", beiAblegen);
      window.removeEventListener("urs-terminal-fokus", fokus); term.dispose();
    };
  }, [id, chat, uid, hintergrund]);

  return <>
    <div className="term-kopf">
      <span className={`punkt${laeuft && verbunden ? "" : " aus"}`} />
      <span>Claude Code{laeuft ? "" : t(" · beendet", " · stopped")}{verbunden ? "" : t(" · verbindet …", " · connecting …")}</span>
      <span className={`phase ${phase}`} title={phase === "bauen" ? t("Claude baut die freigegebene Version", "Claude builds the approved version") : t("Claude plant nur den Ablauf", "Claude only plans the flow")}>
        {phase === "bauen" ? `🔨 ${t("Bauen", "Build")}` : `✎ ${t("Planen", "Plan")}`}</span>
      {!kompakt && <span className="term-pfad" title={pfad}>{pfad}</span>}
      <span className="sp" />
      {!kompakt && <a href="/w">{t("Ordner wechseln", "Change folder")}</a>}
      {!laeuft && verbunden && <button onClick={() => sendenRef.current({ typ: "neustart" })}>{t("Wieder starten", "Restart")}</button>}
    </div>
    <div className="term-inhalt" ref={ref} />
  </>;
}
