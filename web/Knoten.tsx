// Ein Knoten im Diagramm: Form je Typ, Kernaussage, Zahl offener Kommentare, Marke „neu“ (U31).
// U-Nummern stehen nicht am Knoten, sondern erst nach Klick im Seitenfeld (U42).
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { KnotenTyp } from "../src/schema.ts";
import { GROESSE } from "./layout.ts";
import { useT } from "./sprache.ts";

export type KnotenDaten = { typ: KnotenTyp; text: string; offen: number; links?: boolean; neu?: boolean };
export type KnotenNode = Node<KnotenDaten, "urs">;

export const FUELLUNG: Record<KnotenTyp, string> = {
  start: "#e8f7ef", ende: "#e8f7ef", schritt: "#fff", nutzer: "#eef5ff", speicher: "#f3f5f8", entscheidung: "#fff8e6",
};

export function Form({ typ, w, h, gewaehlt }: { typ: KnotenTyp; w: number; h: number; gewaehlt: boolean }) {
  const p = { fill: FUELLUNG[typ], stroke: gewaehlt ? "#1769e0" : "#132038", strokeWidth: gewaehlt ? 3 : 1.6 };
  const i = 2; // Innenabstand, damit der Rand nicht abgeschnitten wird
  switch (typ) {
    case "start": case "ende":
      return <rect {...p} x={i} y={i} width={w - 2 * i} height={h - 2 * i} rx={(h - 2 * i) / 2} />;
    case "entscheidung":
      return <polygon {...p} points={`${w / 2},${i} ${w - i},${h / 2} ${w / 2},${h - i} ${i},${h / 2}`} />;
    case "nutzer":
      return <rect {...p} x={i} y={i} width={w - 2 * i} height={h - 2 * i} rx={12} />;
    case "speicher":
      return <path {...p} d={`M${i} ${i + 8}q${w / 2 - i} -14 ${w - 2 * i} 0v${h - 16 - 2 * i}q${-(w / 2 - i)} 14 ${-(w - 2 * i)} 0z M${i} ${i + 8}q${w / 2 - i} 14 ${w - 2 * i} 0`} />;
    default:
      return <rect {...p} x={i} y={i} width={w - 2 * i} height={h - 2 * i} rx={4} />;
  }
}

export function UrsKnoten({ data, selected }: NodeProps<KnotenNode>) {
  const t = useT();
  const { w, h } = GROESSE[data.typ];
  return (
    <div className="knoten" style={{ width: w, height: h }}>
      <svg width={w} height={h} className="form"><Form typ={data.typ} w={w} h={h} gewaehlt={!!selected} /></svg>
      <div className="knoten-text">{data.text}</div>
      {data.offen > 0 && <div className="knoten-offen" title={t("offene Kommentare", "open comments")}>{data.offen}</div>}
      {data.neu && <span className="marke-neu" title={t("Noch nicht freigegeben", "Not yet approved")}>{t("neu", "new")}</span>}
      {data.links && <div className="knoten-links" title={t("Wird links im Terminal besprochen", "Being discussed in the terminal")}>◀</div>}
      <Handle type="source" position={Position.Top} id="t" />
      <Handle type="source" position={Position.Bottom} id="b" />
      <Handle type="source" position={Position.Left} id="l" />
      <Handle type="source" position={Position.Right} id="r" />
    </div>
  );
}
