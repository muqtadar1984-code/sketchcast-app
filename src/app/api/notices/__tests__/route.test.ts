/**
 * POST /api/notices through the shared builder (utils/notice-row.ts): the
 * gates and refusals in their old order, the composer's messages, and the
 * inserted row = buildNoticeRow's (is_notice true, created_by the caller, no
 * sk_action_id). RLS 42501 → 403, CHECK 23514 → 400.
 * Run: node node_modules/vitest/vitest.mjs run src/app/api/notices
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), noticesEnabledFor: vi.fn() }));
vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/utils/flags", () => ({ noticesEnabledFor: mocks.noticesEnabledFor }));

import { POST } from "@/app/api/notices/route";
import { buildNoticeRow, validateNotice } from "@/utils/notice-row";

const USER = "11111111-1111-4111-8111-111111111111";
const SCHOOL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type World = { role?: string | null; schoolId?: string | null; scopes?: unknown[]; insertError?: { code?: string; message?: string } | null };
function session(w: World) {
  const inserts: Array<Record<string, unknown>> = [];
  const reads: string[] = [];
  const from = (table: string) => {
    reads.push(table);
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "limit"]) b[m] = () => b;
    b.maybeSingle = async () => ({ data: table === "profiles" ? { role: w.role ?? null, school_id: w.schoolId ?? null } : null, error: null });
    b.insert = (row: Record<string, unknown>) => {
      inserts.push(row);
      return { select: () => ({ single: async () => (w.insertError ? { data: null, error: w.insertError } : { data: { id: "ev-1" }, error: null }) }) };
    };
    b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: table === "coordinator_scope" ? (w.scopes ?? []) : [], error: null }).then(res);
    return b;
  };
  return { inserts, reads, from, auth: { getUser: async () => ({ data: { user: { id: USER } } }) } };
}

const req = (body: unknown) => new Request("http://x/api/notices", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
const GOOD = { title: "Sports day", body: "Wear house colours.", audience: "school", startsAt: "2099-01-05T01:00:00.000Z" };

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FEATURE_NOTICES;
  process.env.FEATURE_NOTICES = "true";
  mocks.noticesEnabledFor.mockResolvedValue(true);
});
afterEach(() => {
  if (saved === undefined) delete process.env.FEATURE_NOTICES;
  else process.env.FEATURE_NOTICES = saved;
  vi.clearAllMocks();
});

describe("POST /api/notices", () => {
  it("404 when FEATURE_NOTICES is off, before any session", async () => {
    process.env.FEATURE_NOTICES = "false";
    expect((await POST(req(GOOD))).status).toBe(404);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
  it("a shape error is a 400 with the composer's message, before any standing read", async () => {
    const s = session({ role: "school_admin", schoolId: SCHOOL });
    mocks.createClient.mockResolvedValue(s);
    const r = await POST(req({ ...GOOD, title: "" }));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "A notice needs a title." });
    expect(s.reads).toEqual([]);
    expect((await POST(req("{nope"))).status).toBe(400);
  });
  it("the principal publishes: the inserted row is the shared builder's", async () => {
    const s = session({ role: "school_admin", schoolId: SCHOOL });
    mocks.createClient.mockResolvedValue(s);
    const r = await POST(req(GOOD));
    expect(await r.json()).toEqual({ ok: true, id: "ev-1" });
    const v = validateNotice(GOOD);
    if (!v.ok) throw new Error(v.error);
    expect(s.inserts).toEqual([buildNoticeRow(v.fields, { schoolId: SCHOOL, createdBy: USER })]);
    expect(s.inserts[0]).toMatchObject({ is_notice: true, created_by: USER, all_day: false });
    expect(s.inserts[0]).not.toHaveProperty("sk_action_id");
  });
  it("a teacher with a coordinator scope publishes; without one, 403", async () => {
    mocks.createClient.mockResolvedValue(session({ role: "teacher", schoolId: SCHOOL, scopes: [{ grade: "5" }] }));
    expect((await POST(req(GOOD))).status).toBe(200);
    const teacher = session({ role: "teacher", schoolId: SCHOOL, scopes: [] });
    mocks.createClient.mockResolvedValue(teacher);
    expect((await POST(req(GOOD))).status).toBe(403);
    expect(teacher.inserts).toEqual([]);
  });
  it("students and schoolless accounts are refused; the tenant gate answers 404", async () => {
    mocks.createClient.mockResolvedValue(session({ role: "student", schoolId: SCHOOL }));
    expect((await POST(req(GOOD))).status).toBe(403);
    mocks.createClient.mockResolvedValue(session({ role: "school_admin", schoolId: null }));
    expect((await POST(req(GOOD))).status).toBe(403);
    mocks.noticesEnabledFor.mockResolvedValue(false);
    mocks.createClient.mockResolvedValue(session({ role: "school_admin", schoolId: SCHOOL }));
    expect((await POST(req(GOOD))).status).toBe(404);
  });
  it("RLS 42501 → 403; CHECK 23514 → 400; anything else → 500", async () => {
    mocks.createClient.mockResolvedValue(session({ role: "school_admin", schoolId: SCHOOL, insertError: { code: "42501", message: "rls" } }));
    expect((await POST(req(GOOD))).status).toBe(403);
    mocks.createClient.mockResolvedValue(session({ role: "school_admin", schoolId: SCHOOL, insertError: { code: "23514", message: "check" } }));
    expect((await POST(req(GOOD))).status).toBe(400);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.createClient.mockResolvedValue(session({ role: "school_admin", schoolId: SCHOOL, insertError: { code: "XX000", message: "boom" } }));
    expect((await POST(req(GOOD))).status).toBe(500);
    err.mockRestore();
  });
});
