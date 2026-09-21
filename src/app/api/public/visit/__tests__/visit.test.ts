import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const inserted: unknown[] = [];
vi.mock("@/utils/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({ insert: async (row: unknown) => { inserted.push(row); return { error: null }; } }),
  }),
}));

import { OPTIONS, POST } from "../route";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0";

function post(body: string, headers: Record<string, string>) {
  return new Request("https://app.sketchcast.app/api/public/visit", { method: "POST", body, headers });
}

describe("the visit beacon", () => {
  beforeEach(() => { inserted.length = 0; vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("VISIT_HASH_SECRET", "salt"); });
  afterEach(() => vi.unstubAllEnvs());

  it("records a visit from the marketing site with the host from Origin, not the body", async () => {
    const res = await POST(post(JSON.stringify({ p: "/pricing?ref=x", r: "https://www.google.com/" }), {
      origin: "https://sketchcast.app", "user-agent": UA, "x-real-ip": "203.0.113.9", "x-vercel-ip-country": "MY",
    }));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://sketchcast.app");
    expect(inserted).toHaveLength(1);
    const row = inserted[0] as Record<string, unknown>;
    expect(row).toMatchObject({ host: "sketchcast.app", path: "/pricing", ref_host: "google.com", country: "MY", device: "desktop" });
    expect(String(row.visitor)).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(row)).not.toContain("203.0.113.9");
  });

  it("counts the website only — the app, console and library are not visits", async () => {
    for (const origin of ["https://app.sketchcast.app", "https://console.sketchcast.app", "https://library.sketchcast.app"]) {
      const res = await POST(post(JSON.stringify({ p: "/dashboard" }), { origin, "user-agent": UA }));
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect(inserted).toHaveLength(0);
  });

  it("drops a crawler and an unknown origin, both silently", async () => {
    const bot = await POST(post("{}", { origin: "https://sketchcast.app", "user-agent": "Googlebot/2.1" }));
    expect(bot.status).toBe(204);
    const other = await POST(post("{}", { origin: "https://evil.example", "user-agent": UA }));
    expect(other.status).toBe(204);
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    const none = await POST(post("{}", { "user-agent": UA }));
    expect(none.status).toBe(204);
    expect(inserted).toHaveLength(0);
  });

  it("survives a junk body", async () => {
    await POST(post("not json", { origin: "https://sketchcast.app", "user-agent": UA }));
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ path: "/" });
  });

  it("answers a preflight for an allow-listed origin only", async () => {
    const ok = await OPTIONS(new Request("https://app.sketchcast.app/api/public/visit", { method: "OPTIONS", headers: { origin: "https://www.sketchcast.app" } }));
    expect(ok.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    const no = await OPTIONS(new Request("https://app.sketchcast.app/api/public/visit", { method: "OPTIONS", headers: { origin: "https://evil.example" } }));
    expect(no.headers.get("access-control-allow-origin")).toBeNull();
  });
});
