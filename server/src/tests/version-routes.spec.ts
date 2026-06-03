import { describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { SU_ORIEL_VERSION } from "../generated/version.js";

describe("version routes", () => {
  it("exposes generated version info", async () => {
    const app = buildApp({ enableFileWatcher: false });
    const response = await app.inject({ method: "GET", url: "/api/version" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(SU_ORIEL_VERSION);
  });

  it("includes version info in health response", async () => {
    const app = buildApp({ enableFileWatcher: false });
    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      version: SU_ORIEL_VERSION
    });
  });
});
