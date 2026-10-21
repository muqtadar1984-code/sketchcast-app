/**
 * The Fix Agent's route (/api/library/fixes, migration 0151), RUN (not
 * scanned): admins only; approve / reject is ONE update guarded on
 * status = 'proposed' and read back (no row → 409, no audit); on / off merges
 * {enabled} into platform_settings 'fix_agent'; a database without 0151 is a
 * 409 naming the migration. Nothing else is written — never `jobs`.
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
