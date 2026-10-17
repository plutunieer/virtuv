// Trennlinie zum Ziehen: ändert die Breite einer Spalte mit der Maus (U22). Doppelklick = Standardbreite.
import { useRef } from "react";
import { breiteSetzen, breiteZuruecksetzen, useAnsicht, type Spaltenname } from "./ansicht.ts";
import { useT } from "./sprache.ts";

/** rechts: die Spalte liegt rechts von der Linie (Ziehen nach links macht sie breiter). */
export function Griff({ spalte, rechts = false }: { spalte: Spaltenname; rechts?: boolean }) {
  const t = useT();
  const ansicht = useAnsicht();
  const ref = useRef<HTMLDivElement>(null);
  const ziehen = (e: React.PointerEvent) => {
    e.preventDefault();
    const start = e.clientX, alt = ansicht.breite[spalte];
    const el = ref.current!;
    el.setPointerCapture(e.pointerId);
    el.classList.add("zieht");
    document.body.classList.add("zieht-breite");
    const bewegen = (m: PointerEvent) => breiteSetzen(spalte, alt + (rechts ? start - m.clientX : m.clientX - start));
    const los = () => {
      el.classList.remove("zieht");
      document.body.classList.remove("zieht-breite");
      el.removeEventListener("pointermove", bewegen);
      el.removeEventListener("pointerup", los);
      el.removeEventListener("pointercancel", los);
    };
    el.addEventListener("pointermove", bewegen);
    el.addEventListener("pointerup", los);
    el.addEventListener("pointercancel", los);
  };
  return <div ref={ref} className="griff" role="separator" aria-orientation="vertical"
    title={t("Ziehen: Breite ändern · Doppelklick: zurücksetzen", "Drag: change width · Double-click: reset")}
    onPointerDown={ziehen} onDoubleClick={() => breiteZuruecksetzen(spalte)} />;
}
