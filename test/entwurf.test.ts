import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  alleOrdner, anmelden, freigabeBestaetigt, freigeben, ladeArbeit, leerenEntwurfEntfernen, neuerEntwurf, ohneOrdner,
  pfadVon, projektId, umziehen,
} from "../src/store.ts";
import { gewuenschtePhase } from "../src/terminal.ts";
import { minimaleUrs, submitOk } from "./fixtures.ts";

let appHomeDir: string;
const aufraeumen: string[] = [];

beforeEach(() => {
  appHomeDir = mkdtempSync(join(tmpdir(), "urs-home-"));
  process.env.URS_APP_HOME = appHomeDir;
});

afterEach(() => {
  for (const d of [appHomeDir, ...aufraeumen.splice(0)]) rmSync(d, { recursive: true, force: true });
  delete process.env.URS_APP_HOME;
});

const normalerOrdner = (name = "ziel") => {
  const d = mkdtempSync(join(tmpdir(), `urs-${name}-`));
  aufraeumen.push(d);
  return d;
};
const entwuerfe = () => join(appHomeDir, "entwuerfe");

/** Entwurf mit Ablauf (Version 1, Entwurf-Status). */
const entwurfMitUrs = () => {
  const id = neuerEntwurf();
  const pfad = pfadVon(id)!;
  submitOk(pfad, minimaleUrs());
  return { id, pfad };
};

describe("U77: neuerEntwurf", () => {
  it("legt einen angemeldeten Ordner unter <appHome>/entwuerfe an", () => {
    const id = neuerEntwurf();
    const pfad = pfadVon(id);
    expect(pfad).not.toBeNull();
    expect(pfad!.startsWith(entwuerfe() + "/")).toBe(true);
    expect(existsSync(pfad!)).toBe(true);
    expect(ohneOrdner(pfad!)).toBe(true);
    expect(id).toBe(projektId(pfad!));
  });

  it("zwei Entwürfe bekommen verschiedene Ordner und ids", () => {
    const a = neuerEntwurf(), b = neuerEntwurf();
    expect(a).not.toBe(b);
    expect(pfadVon(a)).not.toBe(pfadVon(b));
  });

  it("alleOrdner meldet ohneOrdner=true für Entwürfe, false für normale Ordner", () => {
    const e = neuerEntwurf();
    const n = anmelden(normalerOrdner("normal"));
    const liste = alleOrdner();
    expect(liste.find((o) => o.id === e)!.ohneOrdner).toBe(true);
    expect(liste.find((o) => o.id === n)!.ohneOrdner).toBe(false);
  });
});

describe("ohneOrdner", () => {
  it("ist false für normale Ordner und für den Ablageordner selbst", () => {
    expect(ohneOrdner(normalerOrdner())).toBe(false);
    mkdirSync(entwuerfe(), { recursive: true });
    expect(ohneOrdner(entwuerfe())).toBe(false);
  });

  it("erkennt keinen Ordner, dessen Name nur mit 'entwuerfe' beginnt", () => {
    const aehnlich = join(appHomeDir, "entwuerfe-alt");
    mkdirSync(aehnlich);
    expect(ohneOrdner(aehnlich)).toBe(false);
  });
});

describe("U78: gewuenschtePhase", () => {
  it("Entwurf bleibt nach freigeben() beim Planen", () => {
    const { pfad } = entwurfMitUrs();
    freigeben(pfad, 1);
    expect(freigabeBestaetigt(pfad)).toBe(true); // Nachweis gilt, trotzdem kein Bauen
    expect(gewuenschtePhase(pfad)).toBe("planen");
  });

  it("normaler Ordner wechselt nach freigeben() auf Bauen (Gegenprobe)", () => {
    const d = normalerOrdner();
    submitOk(d, minimaleUrs());
    expect(gewuenschtePhase(d)).toBe("planen");
    freigeben(d, 1);
    expect(gewuenschtePhase(d)).toBe("bauen");
  });
});

describe("U79: umziehen", () => {
  it("verschiebt .urs (Versionen, Arbeit), meldet den Entwurf ab, räumt den leeren Ordner weg, liefert die id des Ziels", () => {
    const { id, pfad } = entwurfMitUrs();
    const ziel = normalerOrdner();
    const arbeitVorher = ladeArbeit(pfad);

    const neu = umziehen(pfad, ziel);

    expect(neu).toBe(projektId(ziel));
    expect(pfadVon(neu)).toBe(ziel);
    expect(existsSync(join(ziel, ".urs", "v001.json"))).toBe(true);
    expect(existsSync(join(ziel, ".urs", "arbeit.json"))).toBe(true);
    expect(existsSync(join(ziel, ".urs", "projekt.json"))).toBe(true);
    expect(ladeArbeit(ziel)).toEqual(arbeitVorher);
    expect(pfadVon(id)).toBeNull();
    expect(alleOrdner().some((o) => o.id === id)).toBe(false);
    expect(existsSync(pfad)).toBe(false);
  });

  it("lässt keine Sperre (.lock) im neuen .urs zurück", () => {
    const { pfad } = entwurfMitUrs();
    const ziel = normalerOrdner();
    umziehen(pfad, ziel);
    expect(readdirSync(join(ziel, ".urs"))).not.toContain(".lock");
  });

  it("der Freigabe-Nachweis zieht mit: Ziel ist bestätigt freigegeben und baut", () => {
    const { pfad } = entwurfMitUrs();
    freigeben(pfad, 1);
    const ziel = normalerOrdner();
    umziehen(pfad, ziel);
    expect(freigabeBestaetigt(ziel)).toBe(true);
    expect(gewuenschtePhase(ziel)).toBe("bauen");
    expect(freigabeBestaetigt(pfad)).toBe(false); // alter Pfad hat keinen Nachweis mehr
  });

  it("nicht freigegebener Entwurf bleibt nach dem Umzug im Planen", () => {
    const { pfad } = entwurfMitUrs();
    const ziel = normalerOrdner();
    umziehen(pfad, ziel);
    expect(freigabeBestaetigt(ziel)).toBe(false);
    expect(gewuenschtePhase(ziel)).toBe("planen");
  });

  it("Entwurf ganz ohne .urs lässt sich umziehen (nur Anmeldung wechselt)", () => {
    const id = neuerEntwurf();
    const pfad = pfadVon(id)!;
    const ziel = normalerOrdner();
    expect(umziehen(pfad, ziel)).toBe(projektId(ziel));
    expect(pfadVon(id)).toBeNull();
    expect(existsSync(join(ziel, ".urs"))).toBe(false);
  });

  it("lässt den Entwurfsordner liegen, wenn noch fremde Dateien darin sind, meldet ihn aber ab", () => {
    const { id, pfad } = entwurfMitUrs();
    mkdirSync(join(pfad, "fremd"));
    const neu = umziehen(pfad, normalerOrdner());
    expect(pfadVon(id)).toBeNull();
    expect(existsSync(join(pfad, "fremd"))).toBe(true);
    expect(pfadVon(neu)).not.toBeNull();
  });

  describe("Verweigerung (nichts verändert)", () => {
    /** Zustand von Entwurf und Registrierung, der sich nicht ändern darf. */
    const unveraendert = (id: string, pfad: string) => {
      expect(pfadVon(id)).toBe(pfad);
      expect(existsSync(join(pfad, ".urs", "v001.json"))).toBe(true);
      expect(existsSync(join(pfad, ".urs", "arbeit.json"))).toBe(true);
    };

    it("Ziel hat schon .urs: wirft, Ziel-.urs und Entwurf bleiben wie sie waren", () => {
      const { id, pfad } = entwurfMitUrs();
      freigeben(pfad, 1);
      const ziel = normalerOrdner();
      submitOk(ziel, minimaleUrs({ name: "Fremdes Projekt" }));
      const zielArbeit = ladeArbeit(ziel);

      expect(() => umziehen(pfad, ziel)).toThrow(/schon einen Ablauf/);

      unveraendert(id, pfad);
      expect(ladeArbeit(ziel)).toEqual(zielArbeit);
      expect(pfadVon(projektId(ziel))).toBeNull(); // Ziel wurde nicht angemeldet
      expect(freigabeBestaetigt(pfad)).toBe(true); // Nachweis blieb beim Entwurf
    });

    it("Ziel liegt in entwuerfe: wirft", () => {
      const { id, pfad } = entwurfMitUrs();
      const innen = join(entwuerfe(), "anderer-plan");
      mkdirSync(innen);
      expect(() => umziehen(pfad, innen)).toThrow(/eigenen Projektordner/);
      unveraendert(id, pfad);
    });

    it("Ziel ist der Ablageordner entwuerfe selbst: wirft", () => {
      const { id, pfad } = entwurfMitUrs();
      expect(() => umziehen(pfad, entwuerfe())).toThrow(/eigenen Projektordner/);
      unveraendert(id, pfad);
    });

    it("Ziel ist ein anderer Entwurf: wirft", () => {
      const { id, pfad } = entwurfMitUrs();
      const anderer = pfadVon(neuerEntwurf())!;
      expect(() => umziehen(pfad, anderer)).toThrow(/eigenen Projektordner/);
      unveraendert(id, pfad);
    });

    it("Ziel ist die Ablage der App selbst: wirft", () => {
      const { id, pfad } = entwurfMitUrs();
      expect(() => umziehen(pfad, appHomeDir)).toThrow(/eigenen Projektordner/);
      unveraendert(id, pfad);
    });

    it("Ziel fehlt: wirft", () => {
      const { id, pfad } = entwurfMitUrs();
      expect(() => umziehen(pfad, join(appHomeDir, "gibt-es-nicht"))).toThrow(/gibt es nicht/);
      unveraendert(id, pfad);
    });

    it("Ziel ist eine Datei: wirft", () => {
      const { id, pfad } = entwurfMitUrs();
      expect(() => umziehen(pfad, join(pfad, ".urs", "v001.json"))).toThrow(/gibt es nicht/);
      unveraendert(id, pfad);
    });

    it("Ziel ist relativ: wirft", () => {
      const { id, pfad } = entwurfMitUrs();
      expect(() => umziehen(pfad, "irgendwo/relativ")).toThrow(/absolut/);
      unveraendert(id, pfad);
    });

    it("Quelle ist kein Entwurf: wirft, nichts wandert", () => {
      const quelle = normalerOrdner("quelle");
      submitOk(quelle, minimaleUrs());
      const qid = anmelden(quelle);
      const ziel = normalerOrdner();
      expect(() => umziehen(quelle, ziel)).toThrow(/schon einen Ordner/);
      expect(existsSync(join(quelle, ".urs", "v001.json"))).toBe(true);
      expect(existsSync(join(ziel, ".urs"))).toBe(false);
      expect(pfadVon(qid)).toBe(quelle);
    });
  });
});

describe("leerenEntwurfEntfernen", () => {
  it("entfernt einen Entwurf ohne .urs: abgemeldet, Ordner weg, true", () => {
    const id = neuerEntwurf();
    const pfad = pfadVon(id)!;
    expect(leerenEntwurfEntfernen(id)).toBe(true);
    expect(pfadVon(id)).toBeNull();
    expect(existsSync(pfad)).toBe(false);
    expect(alleOrdner().some((o) => o.id === id)).toBe(false);
  });

  it("behält einen Entwurf mit .urs: false, nichts verändert", () => {
    const { id, pfad } = entwurfMitUrs();
    expect(leerenEntwurfEntfernen(id)).toBe(false);
    expect(pfadVon(id)).toBe(pfad);
    expect(existsSync(join(pfad, ".urs", "v001.json"))).toBe(true);
  });

  it("ignoriert normale Ordner: false, bleibt angemeldet, Ordner bleibt", () => {
    const d = normalerOrdner("normal");
    const id = anmelden(d);
    expect(leerenEntwurfEntfernen(id)).toBe(false);
    expect(pfadVon(id)).toBe(d);
    expect(existsSync(d)).toBe(true);
  });

  it("unbekannte id: false", () => {
    expect(leerenEntwurfEntfernen("gibt-es-nicht")).toBe(false);
  });

  it("behält einen Entwurf, in dem schon etwas liegt (nichts geht verloren)", () => {
    const id = neuerEntwurf();
    const pfad = pfadVon(id)!;
    mkdirSync(join(pfad, "notiz"));
    expect(leerenEntwurfEntfernen(id)).toBe(false);
    expect(pfadVon(id)).toBe(pfad);
    expect(existsSync(join(pfad, "notiz"))).toBe(true);
  });
});
