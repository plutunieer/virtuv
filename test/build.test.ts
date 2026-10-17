import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildKennung } from "../src/build.ts";

let vorher: string | undefined;
beforeEach(() => { vorher = process.env.URS_APP_BUILD; delete process.env.URS_APP_BUILD; });
afterEach(() => {
  if (vorher === undefined) delete process.env.URS_APP_BUILD; else process.env.URS_APP_BUILD = vorher;
});

describe("buildKennung", () => {
  it("URS_APP_BUILD überschreibt die berechnete Kennung unverändert", () => {
    process.env.URS_APP_BUILD = "app-build-42";
    expect(buildKennung()).toBe("app-build-42");
  });

  it("ohne URS_APP_BUILD: 12 Hex-Zeichen aus dem Code, stabil bei gleichem Stand", () => {
    const k = buildKennung();
    expect(k).toMatch(/^[0-9a-f]{12}$/);
    expect(buildKennung()).toBe(k);
  });

  it("leere URS_APP_BUILD zählt als nicht gesetzt (Fallback auf Berechnung)", () => {
    process.env.URS_APP_BUILD = "";
    expect(buildKennung()).toMatch(/^[0-9a-f]{12}$/);
  });
});
