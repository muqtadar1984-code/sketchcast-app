/**
 * The Fix Agent's route (/api/library/fixes, migration 0151), RUN (not
 * scanned): admins only; approve / reject is ONE update guarded on
 * status = 'proposed' and read back (no row → 409, no audit); on / off merges
 * {enabled} into platform_settings 'fix_agent'; a database without 0151 is a
 * 409 naming the migration; the bulk actions (approve_many / reject_many /
 * retry_many) are the single action's guarded update per id, answering
 * {done, skipped} with ONE audit row, and a 400 (nothing written) for any bad
 * id. Nothing else is written — never `jobs`.
 *
 * It lives here, not under /api/library: catalogue-routes.test.ts scans every
 * .ts file there as a route.
 *
 * Run: npx vitest run src/utils/__tests__/fixes-route.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createAdminClient: vi.fn(), isLibraryMemberRequest: vi.fn() }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/utils/library-access", () => ({ isLibraryMemberRequest: mocks.isLibraryMemberRequest }));

import { POST } from "@/app/api/library/fixes/route";

type Row = Record<string, unknown>;
type Err = { code?: string; message: string } | null;

/** The slice of the query builder the route uses: select / update / insert
 *  with eq filters, maybeSingle, and a thenable. Every write is recorded. */
class FakeDb {
  writes: { table: string; op: "update" | "insert"; row: Row; filters: [string, unknown][] }[] = [];
  constructor(
    public tables: Record<string, Row[]>,
    public errors: Record<string, Err> = {},
  ) {}
  from(table: string) {
    return new Query(this, table);
  }
}

class Query {
  private filters: [string, unknown][] = [];
  private op: "select" | "update" | "insert" = "select";
  private payload: Row | null = null;
  private single = false;
  constructor(
    private db: FakeDb,
    private table: string,
  ) {}
  select() {
    return this;
  }
  update(row: Row) {
    this.op = "update";
    this.payload = row;
    return this;
  }
  insert(row: Row) {
    this.op = "insert";
    this.payload = row;
    return this;
  }
  eq(col: string, v: unknown) {
    this.filters.push([col, v]);
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }
  limit() {
    return this;
  }
  private run(): { data: unknown; error: Err } {
    const error = this.db.errors[this.table] ?? null;
    if (error) return { data: null, error };
    const rows = this.db.tables[this.table] ?? [];
    if (this.op === "insert") {
      this.db.writes.push({ table: this.table, op: "insert", row: this.payload!, filters: [] });
      rows.push(this.payload!);
      return { data: [this.payload], error: null };
    }
    const matched = rows.filter((r) => this.filters.every(([c, v]) => r[c] === v));
    if (this.op === "update") {
      this.db.writes.push({ table: this.table, op: "update", row: this.payload!, filters: this.filters });
      for (const r of matched) Object.assign(r, this.payload);
    }
    return { data: this.single ? (matched[0] ?? null) : matched, error: null };
  }
  then<A, B>(ok?: ((v: { data: unknown; error: Err }) => A) | null, no?: ((e: unknown) => B) | null) {
    return Promise.resolve(this.run()).then(ok, no);
  }
}

const ADMIN = "55555555-5555-4555-8555-555555555555";
const CASE = "11111111-1111-4111-8111-111111111111";

function seed(status = "proposed", over: { settings?: Row[]; errors?: Record<string, Err> } = {}) {
  return new FakeDb(
    {
      fix_cases: [{ id: CASE, status, round: 2, decided_by: null, decision_note: null }],
      platform_settings: over.settings ?? [{ key: "fix_agent", value: { enabled: false, summary_email: "f@sketchcast.app" } }],
      platform_audit_log: [],
    },
    over.errors,
  );
}

async function post(db: FakeDb, body: unknown) {
  mocks.createAdminClient.mockReturnValue(db);
  const res = await POST(new Request("http://localhost/api/library/fixes", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const audits = (db: FakeDb) => db.writes.filter((w) => w.table === "platform_audit_log").map((w) => w.row);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isLibraryMemberRequest.mockResolvedValue({ id: ADMIN, email: "founder@sketchcast.app", role: "admin" });
});

describe("the guard", () => {
  it("answers 404 to anyone the publish check refuses, and asks for `publish`", async () => {
    mocks.isLibraryMemberRequest.mockResolvedValue(null);
    const db = seed();
    const { status } = await post(db, { action: "approve", id: CASE });
    expect(status).toBe(404);
    expect(mocks.isLibraryMemberRequest).toHaveBeenCalledWith("publish");
    expect(db.writes).toEqual([]);
  });

  it("refuses bad JSON, an unknown action and a bad id", async () => {
    expect((await post(seed(), "{nope")).status).toBe(400);
    expect((await post(seed(), { action: "delete", id: CASE })).status).toBe(400);
    const db = seed();
    const r = await post(db, { action: "approve", id: "not-a-uuid" });
    expect(r.status).toBe(400);
    expect((await post(db, { action: "reject" })).status).toBe(400);
    expect(db.writes).toEqual([]);
  });
});

describe("approve / reject", () => {
  it("approves a proposal in one guarded update and audits it with the round", async () => {
    const db = seed();
    const { status, json } = await post(db, { action: "approve", id: CASE.toUpperCase() });
    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, action: "approve", id: CASE, status: "approved" });
    const updates = db.writes.filter((w) => w.op === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe("fix_cases");
    expect(updates[0].filters).toEqual([
      ["id", CASE],
      ["status", "proposed"],
    ]);
    expect(Object.keys(updates[0].row).sort()).toEqual(["decided_at", "decided_by", "decision_note", "status", "updated_at"]);
    expect(updates[0].row).toMatchObject({ status: "approved", decided_by: ADMIN, decision_note: null });
    expect(audits(db)).toEqual([
      { actor_id: ADMIN, action: "library_fix_case_approve", target_kind: "fix_case", target_id: CASE, detail: { note: null, round: 2 } },
    ]);
    // the worker queues the retry — the route never touches jobs
    expect(db.writes.some((w) => w.table === "jobs")).toBe(false);
  });

  it("rejects with a trimmed, capped note", async () => {
    const db = seed();
    const { status } = await post(db, { action: "reject", id: CASE, note: `  ${"n".repeat(600)}  ` });
    expect(status).toBe(200);
    const note = (db.tables.fix_cases[0].decision_note as string) ?? "";
    expect(db.tables.fix_cases[0].status).toBe("rejected");
    expect(note).toHaveLength(500);
    expect(audits(db)[0]).toMatchObject({ action: "library_fix_case_reject", detail: { note, round: 2 } });
  });

  it("answers 409 and audits nothing when the case no longer waits for a decision", async () => {
    const db = seed("approved");
    const { status, json } = await post(db, { action: "approve", id: CASE });
    expect(status).toBe(409);
    expect(json.error).toBe("This case is no longer waiting for a decision.");
    expect(db.tables.fix_cases[0].status).toBe("approved");
    expect(audits(db)).toEqual([]);
  });

  it("names migration 0151 when fix_cases is missing", async () => {
    const db = seed("proposed", { errors: { fix_cases: { code: "PGRST205", message: "Could not find the table 'public.fix_cases' in the schema cache" } } });
    const { status, json } = await post(db, { action: "approve", id: CASE });
    expect(status).toBe(409);
    expect(json.migration).toBe("0151_fix_agent.sql");
    expect(audits(db)).toEqual([]);
  });
});

describe("on / off", () => {
  it("merges {enabled} into the setting, keeps the other keys, and audits the press", async () => {
    const db = seed();
    const on = await post(db, { action: "on" });
    expect(on.status).toBe(200);
    expect(db.tables.platform_settings[0].value).toEqual({ enabled: true, summary_email: "f@sketchcast.app" });
    expect(audits(db)).toEqual([
      { actor_id: ADMIN, action: "library_fix_agent_on", target_kind: "platform_setting", target_id: null, detail: { key: "fix_agent", patch: { enabled: true } } },
    ]);
    const off = await post(db, { action: "off" });
    expect(off.status).toBe(200);
    expect(db.tables.platform_settings[0].value).toEqual({ enabled: false, summary_email: "f@sketchcast.app" });
    expect(audits(db).map((a) => a.action)).toEqual(["library_fix_agent_on", "library_fix_agent_off"]);
    // only the setting and the audit rows were written
    expect(new Set(db.writes.map((w) => w.table))).toEqual(new Set(["platform_settings", "platform_audit_log"]));
  });

  it("answers 409 with the migration when the setting is not seeded", async () => {
    const db = seed("proposed", { settings: [] });
    const { status, json } = await post(db, { action: "on" });
    expect(status).toBe(409);
    expect(json.migration).toBe("0151_fix_agent.sql");
    expect(db.writes).toEqual([]);
  });
});

describe("retry after it needed you", () => {
  const CASE2 = "22222222-2222-4222-8222-222222222222";
  function stuck() {
    return new FakeDb({
      fix_cases: [
        { id: CASE, status: "needs_founder", round: 2, applied_job_id: "job-1", proposal: { note: "n" }, history: [{ round: 1 }], outcome: { error: "again" } },
        { id: CASE2, status: "needs_founder", round: 1, applied_job_id: null, proposal: {}, history: [] },
        { id: "33333333-3333-4333-8333-333333333333", status: "proposed", round: 1 },
      ],
      platform_settings: [],
      platform_audit_log: [],
    });
  }

  it("sends one case back to 'approved' with its last proposal, the ended round in history", async () => {
    const db = stuck();
    const { status, json } = await post(db, { action: "retry", id: CASE });
    expect(status).toBe(200);
    expect(json.retried).toBe(1);
    const row = db.tables.fix_cases[0];
    expect(row.status).toBe("approved");
    expect(row.applied_job_id).toBeNull();
    expect(row.proposal).toEqual({ note: "n" });
    expect(row.decided_by).toBe(ADMIN);
    expect(row.history).toEqual([{ round: 1 }, expect.objectContaining({ round: 2, applied_job_id: "job-1", outcome: { error: "again" } })]);
    const upd = db.writes.find((w) => w.table === "fix_cases" && w.op === "update")!;
    expect(upd.filters).toEqual([["id", CASE], ["status", "needs_founder"]]);
    expect(audits(db)).toEqual([expect.objectContaining({ action: "library_fix_case_retry", target_id: CASE })]);
    expect(db.writes.some((w) => w.table === "jobs")).toBe(false);
  });

  it("retries every case that needs you, and nothing else", async () => {
    const db = stuck();
    const { json } = await post(db, { action: "retry_all" });
    expect(json.retried).toBe(2);
    expect(db.tables.fix_cases.map((r) => r.status)).toEqual(["approved", "approved", "proposed"]);
  });

  it("answers 409 for a case that is not waiting for you", async () => {
    const db = stuck();
    const r = await post(db, { action: "retry", id: "33333333-3333-4333-8333-333333333333" });
    expect(r.status).toBe(409);
    expect(db.writes.filter((w) => w.op === "update")).toEqual([]);
  });
});

describe("bulk actions (the board's Approve all / selection bar)", () => {
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  function board() {
    return new FakeDb({
      fix_cases: [
        { id: A, status: "proposed", round: 1 },
        { id: B, status: "proposed", round: 1 },
        { id: C, status: "needs_founder", round: 2, applied_job_id: "job-c", proposal: { note: "n" }, history: [], outcome: { error: "again" } },
        { id: D, status: "approved", round: 1 },
      ],
      platform_settings: [],
      platform_audit_log: [],
    });
  }
  const caseUpdates = (db: FakeDb) => db.writes.filter((w) => w.table === "fix_cases" && w.op === "update");

  it("approves each id in its own guarded update, skips the ones that moved on, and audits ONE row", async () => {
    const db = board();
    const { status, json } = await post(db, { action: "approve_many", ids: [A, B.toUpperCase(), C, D, A] });
    expect(status).toBe(200);
    // duplicates dropped: A, B, C, D — C needs you and D is approved already
    expect(json).toEqual({ ok: true, action: "approve_many", done: 2, skipped: 2 });
    expect(db.tables.fix_cases.map((r) => r.status)).toEqual(["approved", "approved", "needs_founder", "approved"]);
    const ups = caseUpdates(db);
    expect(ups).toHaveLength(4);
    for (const [i, id] of [A, B, C, D].entries()) {
      expect(ups[i].filters).toEqual([
        ["id", id],
        ["status", "proposed"],
      ]);
      expect(Object.keys(ups[i].row).sort()).toEqual(["decided_at", "decided_by", "decision_note", "status", "updated_at"]);
    }
    expect(audits(db)).toEqual([
      { actor_id: ADMIN, action: "library_fix_case_approve_many", target_kind: "fix_case", target_id: null, detail: { ids: [A, B], count: 2 } },
    ]);
    expect(db.writes.some((w) => w.table === "jobs")).toBe(false);
  });

  it("rejects with the trimmed note on every row, and puts it in the audit", async () => {
    const db = board();
    const { status, json } = await post(db, { action: "reject_many", ids: [A, B], note: "  not like this  " });
    expect(status).toBe(200);
    expect(json).toMatchObject({ done: 2, skipped: 0 });
    expect(db.tables.fix_cases.slice(0, 2).map((r) => [r.status, r.decision_note])).toEqual([
      ["rejected", "not like this"],
      ["rejected", "not like this"],
    ]);
    expect(audits(db)).toEqual([expect.objectContaining({ action: "library_fix_case_reject_many", detail: { ids: [A, B], count: 2, note: "not like this" } })]);
  });

  it("retries only the cases that need you, read then guarded update, history kept", async () => {
    const db = board();
    const { status, json } = await post(db, { action: "retry_many", ids: [C, A] });
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true, action: "retry_many", done: 1, skipped: 1 });
    const row = db.tables.fix_cases[2];
    expect(row).toMatchObject({ status: "approved", applied_job_id: null, decided_by: ADMIN, proposal: { note: "n" } });
    expect(row.history).toEqual([expect.objectContaining({ round: 2, applied_job_id: "job-c", outcome: { error: "again" } })]);
    expect(db.tables.fix_cases[0].status).toBe("proposed");
    const ups = caseUpdates(db);
    // A was never read in needs_founder, so it was never updated
    expect(ups).toHaveLength(1);
    expect(ups[0].filters).toEqual([
      ["id", C],
      ["status", "needs_founder"],
    ]);
    expect(audits(db)).toEqual([expect.objectContaining({ action: "library_fix_case_retry_many", target_id: null, detail: { ids: [C], count: 1 } })]);
    expect(db.writes.some((w) => w.table === "jobs")).toBe(false);
  });

  it("audits the press even when every id was skipped", async () => {
    const db = board();
    const { json } = await post(db, { action: "approve_many", ids: [D] });
    expect(json).toMatchObject({ done: 0, skipped: 1 });
    expect(audits(db)).toEqual([expect.objectContaining({ action: "library_fix_case_approve_many", detail: { ids: [], count: 0 } })]);
  });

  it("answers 400 and writes nothing for a bad id, no ids, an empty list or more than 100", async () => {
    const many = Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    for (const body of [
      { action: "approve_many", ids: [A, "not-a-uuid"] },
      { action: "reject_many", ids: [A, 7] },
      { action: "retry_many" },
      { action: "approve_many", ids: [] },
      { action: "approve_many", ids: A },
      { action: "approve_many", ids: many },
    ]) {
      const db = board();
      const r = await post(db, body);
      expect(r.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(db.writes).toEqual([]);
    }
    // exactly 100 is fine
    const db = board();
    expect((await post(db, { action: "approve_many", ids: many.slice(0, 100) })).status).toBe(200);
  });

  it("names migration 0151 when fix_cases is missing, and audits nothing", async () => {
    const db = new FakeDb({ fix_cases: [], platform_audit_log: [] }, { fix_cases: { code: "42P01", message: 'relation "fix_cases" does not exist' } });
    const { status, json } = await post(db, { action: "retry_many", ids: [A] });
    expect(status).toBe(409);
    expect(json.migration).toBe("0151_fix_agent.sql");
    expect(audits(db)).toEqual([]);
  });

  it("answers 404 to a non-admin before reading anything", async () => {
    mocks.isLibraryMemberRequest.mockResolvedValue(null);
    const db = board();
    expect((await post(db, { action: "approve_many", ids: [A] })).status).toBe(404);
    expect(db.writes).toEqual([]);
  });
});
