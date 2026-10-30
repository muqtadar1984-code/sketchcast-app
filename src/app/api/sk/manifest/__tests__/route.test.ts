/**
 * /api/sk/manifest — gate, owner check and the two shapes it answers with.
 * Run: node node_modules/vitest/vitest.mjs run src/app/api/sk/manifest/__tests__/route.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkActionRow } from "@/sk/shell/types";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  skEnabled: vi.fn(() => true),
  skShellEnabledFor: vi.fn(async () => true),
  presentAllowed: vi.fn(() => false),
  readManifest: vi.fn(),
  deriveAndStore: vi.fn(),
  audit: [] as SkActionRow[],
}));
vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/utils/flags", () => ({ skEnabled: mocks.skEnabled, skShellEnabledFor: mocks.skShellEnabledFor, presentAllowed: mocks.presentAllowed }));
vi.mock("@/sk/manifest/store", () => ({ readManifest: mocks.readManifest }));
vi.mock("@/sk/manifest/service", () => ({ deriveAndStore: mocks.deriveAndStore }));
vi.mock("@/sk/shell/audit", () => ({
  auditSinkFor: () => ({ record: (r: SkActionRow) => void mocks.audit.push(r) }),
  recordSafely: async (sink: { record: (r: SkActionRow) => void }, r: SkActionRow) => sink.record(r),
}));

import { GET, POST } from "@/app/api/sk/manifest/route";

const GEN = "eef426bd-523b-4fed-827c-95421263d89a";
const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const USER = { id: ME, email: "t@school.example", email_confirmed_at: "2026-01-01T00:00:00Z" };

/* eslint-disable @typescript-eslint/no-explicit-any */
function session(user: typeof USER | null, role = "teacher") {
  return {
    auth: { getUser: async () => ({ data: { user } }) },
    from: (table: string) => {
      const b: any = {};
      for (const m of ["select", "eq"]) b[m] = () => b;
      b.maybeSingle = async () => ({ data: table === "profiles" ? { role, school_id: "school-1" } : null, error: null });
      return b;
    },
  };
}
function adminWith(ownerId: string | null) {
  const log: string[] = [];
  const admin = {
    log,
    from: (table: string) => {
      const b: any = {};
      for (const m of ["select", "eq"]) b[m] = (...a: unknown[]) => (log.push(`${table}.${m}(${a.map((x) => JSON.stringify(x)).join(",")})`), b);
      b.maybeSingle = async () => ({ data: table === "generations" && ownerId ? { owner_id: ownerId } : null, error: null });
      return b;
    },
  };
  return admin;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const get = (qs: string) => GET(new Request(`http://x/api/sk/manifest${qs}`));
const post = (body: unknown) => POST(new Request("http://x/api/sk/manifest", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } }));

beforeEach(() => {
  mocks.skEnabled.mockReturnValue(true);
  mocks.skShellEnabledFor.mockResolvedValue(true);
  mocks.presentAllowed.mockReturnValue(false);
  mocks.createClient.mockResolvedValue(session(USER));
  mocks.createAdminClient.mockReturnValue(adminWith(ME));
  mocks.readManifest.mockResolvedValue({ status: "ready", manifest: { generation_id: GEN, segments: [] }, builtAt: "2026-10-28T09:00:00Z" });
  mocks.deriveAndStore.mockResolvedValue({ status: "ready", manifest: { generation_id: GEN, segments: [] }, builtAt: "2026-10-28T09:00:00Z", stats: { segments: 1 } });
  mocks.audit.length = 0;
});
afterEach(() => vi.clearAllMocks());

describe("gate", () => {
  it("404 when the SK flag is off — before any session or admin work", async () => {
    mocks.skEnabled.mockReturnValue(false);
    const res = await get(`?generationId=${GEN}`);
    expect(res.status).toBe(404);
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect((await post({ generationId: GEN })).status).toBe(404);
  });

  it("401 when signed out", async () => {
    mocks.createClient.mockResolvedValue(session(null));
    expect((await get(`?generationId=${GEN}`)).status).toBe(401);
    expect((await post({ generationId: GEN })).status).toBe(401);
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("404 when the Shell is not enabled for this user (role/tenant gate)", async () => {
    mocks.skShellEnabledFor.mockResolvedValue(false);
    expect((await get(`?generationId=${GEN}`)).status).toBe(404);
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("400 on a missing or malformed generationId", async () => {
    expect((await get("")).status).toBe(400);
    expect((await get("?generationId=nope")).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post("not json")).status).toBe(400);
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });
});

describe("owner check", () => {
  it("404 when the generation does not exist (no existence leak)", async () => {
    mocks.createAdminClient.mockReturnValue(adminWith(null));
    expect((await get(`?generationId=${GEN}`)).status).toBe(404);
    expect(mocks.readManifest).not.toHaveBeenCalled();
  });

  it("403 when the caller is not the owner and not staff; both verbs", async () => {
    mocks.createAdminClient.mockReturnValue(adminWith(OTHER));
    expect((await get(`?generationId=${GEN}`)).status).toBe(403);
    expect((await post({ generationId: GEN })).status).toBe(403);
    expect(mocks.readManifest).not.toHaveBeenCalled();
    expect(mocks.deriveAndStore).not.toHaveBeenCalled();
    expect(mocks.audit).toEqual([]);
  });

  it("PRESENT_ALLOWED_EMAILS staff pass the owner check on someone else's kit", async () => {
    mocks.createAdminClient.mockReturnValue(adminWith(OTHER));
    mocks.presentAllowed.mockReturnValue(true);
    const res = await get(`?generationId=${GEN}`);
    expect(res.status).toBe(200);
    expect(mocks.presentAllowed).toHaveBeenCalledWith(USER);
  });

  it("500 when the admin client cannot be built", async () => {
    mocks.createAdminClient.mockImplementation(() => {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
    });
    const res = await get(`?generationId=${GEN}`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Service unavailable." });
  });
});

describe("GET", () => {
  it("answers with the read result as is — ready carries the manifest", async () => {
    const res = await get(`?generationId=${GEN}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready", manifest: { generation_id: GEN, segments: [] }, builtAt: "2026-10-28T09:00:00Z" });
    expect(mocks.readManifest).toHaveBeenCalledWith(expect.anything(), GEN);
  });

  it.each([
    [{ status: "building" }],
    [{ status: "stale", reason: "artifacts update at …" }],
    [{ status: "failed", reason: "too large: 61 segments > 60" }],
    [{ status: "missing" }],
  ])("passes %o through with 200 (the Board polls on it)", async (r) => {
    mocks.readManifest.mockResolvedValue(r);
    const res = await get(`?generationId=${GEN}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(r);
  });

  it("500 (no stack) when the read throws", async () => {
    mocks.readManifest.mockRejectedValue(new Error("sk_manifests read failed: boom"));
    const res = await get(`?generationId=${GEN}`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Could not read the manifest." });
  });
});

describe("POST", () => {
  it("derives for the owner, strips stats, and audits one manifest.build row (kind job, tier queued)", async () => {
    const res = await post({ generationId: GEN });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready", manifest: { generation_id: GEN, segments: [] }, builtAt: "2026-10-28T09:00:00Z" });
    expect(mocks.deriveAndStore).toHaveBeenCalledWith(expect.anything(), GEN);
    expect(mocks.audit).toHaveLength(1);
    expect(mocks.audit[0]).toMatchObject({
      actor_id: ME,
      school_id: "school-1",
      role: "teacher",
      action: "manifest.build",
      tier: "queued",
      kind: "job",
      params: { generationId: GEN },
      ok: true,
      result: { status: "ready" },
      generation_id: GEN,
      session_id: null,
      turn_id: null,
    });
    expect(typeof mocks.audit[0].ms).toBe("number");
  });

  it("a failed derivation is audited ok=false with the reason, and returned", async () => {
    mocks.deriveAndStore.mockResolvedValue({ status: "failed", reason: "not_done: generation status is processing, not done" });
    const res = await post({ generationId: GEN });
    expect(await res.json()).toEqual({ status: "failed", reason: "not_done: generation status is processing, not done" });
    expect(mocks.audit[0]).toMatchObject({ ok: false, error: "not_done: generation status is processing, not done", result: { status: "failed", reason: "not_done: generation status is processing, not done" } });
  });

  it("the id in the query string (the Board's shape until 2026-10-31) still derives and audits", async () => {
    const res = await POST(new Request(`http://x/api/sk/manifest?generationId=${GEN}`, { method: "POST" }));
    expect(res.status).toBe(200);
    expect(mocks.deriveAndStore).toHaveBeenCalledWith(expect.anything(), GEN);
    expect(mocks.audit).toHaveLength(1);
    expect(mocks.audit[0]).toMatchObject({ action: "manifest.build", generation_id: GEN });
  });

  it("building (someone else's claim) is ok=true", async () => {
    mocks.deriveAndStore.mockResolvedValue({ status: "building" });
    expect(await (await post({ generationId: GEN })).json()).toEqual({ status: "building" });
    expect(mocks.audit[0].ok).toBe(true);
  });
});
