/**
 * The Board's manifest fetch (sk-board-bridge.ts httpManifestFetch).
 * Production 2026-10-30: the Board POSTed /api/sk/manifest with the id only in
 * the query string, the route reads the JSON body, every build died as a 400
 * before its audit row, and no lesson map was ever built from the Board.
 * Run: node node_modules/vitest/vitest.mjs run src/app/present/__tests__/manifest-fetch.test.ts
 */
import { describe, expect, it, vi } from "vitest";
import { httpManifestFetch, loadManifest } from "../sk-board-bridge";

const GEN = "eef426bd-523b-4fed-827c-95421263d89a";
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("httpManifestFetch", () => {
  it("POST carries {generationId} as a JSON body (the route reads the body)", async () => {
    const f = vi.fn(async () => reply(200, { status: "building" }));
    const r = await httpManifestFetch(f as unknown as typeof fetch)(GEN, "POST");
    expect(r).toEqual({ status: "building" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/sk/manifest?generationId=${GEN}`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ generationId: GEN });
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("GET sends no body; 404 reads as missing; another error throws", async () => {
    const f = vi.fn(async () => reply(404, { error: "Not available." }));
    expect(await httpManifestFetch(f as unknown as typeof fetch)(GEN, "GET")).toEqual({ status: "missing" });
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].body).toBeUndefined();
    const bad = vi.fn(async () => reply(400, { error: "generationId is required." }));
    await expect(httpManifestFetch(bad as unknown as typeof fetch)(GEN, "POST")).rejects.toThrow("manifest 400");
  });

  it("missing → one POST with the body → building → polled to ready", async () => {
    const seen: Array<{ method: string; body: unknown }> = [];
    const answers = [{ status: "missing" }, { status: "building" }, { status: "building" }, { status: "ready", manifest: { generation_id: GEN, segments: [] } }];
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push({ method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : null });
      return reply(200, answers.shift());
    });
    const r = await loadManifest(httpManifestFetch(f as unknown as typeof fetch), GEN, { sleep: async () => {}, now: () => 0 });
    expect(r.status).toBe("ready");
    expect(seen.map((s) => s.method)).toEqual(["GET", "POST", "GET", "GET"]);
    expect(seen[1].body).toEqual({ generationId: GEN });
  });
});
