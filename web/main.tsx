import "@xyflow/react/dist/style.css";
import "./style.css";
import { createRoot } from "react-dom/client";
import { Liste, ProjektSeite } from "./App.tsx";
import { Shell } from "./Shell.tsx";
import { Werkbank } from "./Werkbank.tsx";

const m = location.pathname.match(/^\/p\/([^/]+)/);
const w = location.pathname.match(/^\/w(?:\/([^/]+))?\/?$/);
createRoot(document.getElementById("root")!).render(
  m ? <ProjektSeite id={decodeURIComponent(m[1])} />
    : w ? (w[1] ? <Werkbank id={decodeURIComponent(w[1])} /> : <Shell />)
    : <Liste />,
);
