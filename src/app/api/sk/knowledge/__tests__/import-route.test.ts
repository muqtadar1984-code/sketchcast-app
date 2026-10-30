// SK S7 K1 — POST /api/sk/knowledge/import ("Import now") is founder-only:
// signed out → 401, anyone not in FOUNDER_EMAILS → 404 (not probeable), the
// founder → the poll's result. The poll is mocked here; it is tested in
// src/sk/knowledge/__tests__/release.test.ts.
// Run: node node_modules/vitest/vitest.mjs run src/app/api/sk/knowledge/__tests__/import-route.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: null as null | { id: string; email: string }, poll: vi.fn() }));
vi.mock("@/utils/supabase/server", () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: mocks.user } }) } }) }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: () => ({ admin: true }) }));
vi.mock("@/sk/knowledge/release", () => ({ pollReleases: mocks.poll }));

import { POST } from "@/app/api/sk/knowledge/import/route";

beforeEach(() => {
  process.env.FOUNDER_EMAILS = "founder@sketchcast.app";
  mocks.poll.mockResolvedValue({ status: "waiting_for_0174", live: 0 });
});
afterEach(() => {
  delete process.env.FOUNDER_EMAILS;
  mocks.user = null;
  vi.clearAllMocks();
});

describe("POST /api/sk/knowledge/import", () => {
  it("signed out → 401, no poll", async () => {
    const res = await POST();
    expect(res.status).toBe(401);
    expect(mocks.poll).not.toHaveBeenCalled();
  });
  it("a signed-in non-founder (even a staff address) → 404, no poll", async () => {
    mocks.user = { id: "u2", email: "teacher@sketchcast.app" };
    const res = await POST();
    expect(res.status).toBe(404);
    expect(mocks.poll).not.toHaveBeenCalled();
  });
  it("the founder (any case) → runs the poll with the service-role client and returns its result", async () => {
    mocks.user = { id: "u1", email: "Founder@SketchCast.app" };
    const res = await POST();
    expect(res.status).toBe(200);
    expect(mocks.poll).toHaveBeenCalledWith({ admin: true });
    expect(await res.json()).toEqual({ status: "waiting_for_0174", live: 0 });
  });
  it("a poll failure → 500 with the message, logged", async () => {
    mocks.user = { id: "u1", email: "founder@sketchcast.app" };
    mocks.poll.mockRejectedValue(new Error("sk_book_products read failed: boom"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "sk_book_products read failed: boom" });
    expect(err).toHaveBeenCalled();
  });
});
