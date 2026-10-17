/**
 * The translate sweep route, RUN (not scanned): GET and POST {dryRun} answer
 * the ready / not-ready lists from the five reads; POST queues up to `limit`
 * ready kits through translate-job.ts (mocked — a live pair is "already
 * queued", never new), audits each queued kit on its topic with the whole
 * sweep, and never writes anything else. Refusals: a non-member, a member
 * without `generate`, a bad language or limit, generation switched off (a
 * dry run still answers).
 *
 * It lives beside catalogue-routes.test.ts, not under /api/library: that
 * test scans every .ts file there as a route.
 *
 * Run: npx vitest run src/utils/__tests__/catalogue-translate-route.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createAdminClient: vi.fn(), isLibraryMemberRequest: vi.fn(), enqueueTranslateJob: vi.fn() }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/utils/library-access", () => ({ isLibraryMemberRequest: mocks.isLibraryMemberRequest }));
vi.mock("@/app/api/library/topics/[id]/kit/translate-job", () => ({ enqueueTranslateJob: mocks.enqueueTranslateJob }));

import { GET, POST } from "@/app/api/library/translate/route";

type Row = Record<string, unknown>;

/** The slice of the query builder the sweep route uses — select with in /
 *  eq / limit filters over in-memory tables, rpc over a named result, and
 *  insert (the audit rows). Every write is recorded. */
class FakeDb {
  writes: { table: string; row: Row }[] = [];
  constructor(
    public tables: Record<string, Row[]>,
    public rpcs: Record<string, Row[]> = {},
  ) {}
  from(table: string) {
    return new Query(this, table);
  }
  async rpc(name: string) {
    return { data: this.rpcs[name] ?? [], error: null };
  }
}

class Query {
  private filters: ((r: Row) => boolean)[] = [];
  private inserted: Row[] | null = null;
  constructor(
    private db: FakeDb,
    private table: string,
  ) {}
  select() {
    return this;
  }
  insert(row: Row) {
    this.inserted = [row];
    return this;
  }
  eq(col: string, v: unknown) {
    this.filters.push((r) => r[col] === v);
    return this;
  }
  in(col: string, vs: unknown[]) {
    this.filters.push((r) => vs.includes(r[col]));
    return this;
  }
  limit() {
    return this;
  }
  private run() {
    if (this.inserted) {
      for (const row of this.inserted) this.db.writes.push({ table: this.table, row });
      return { data: this.inserted, error: null };
    }
    return { data: (this.db.tables[this.table] ?? []).filter((r) => this.filters.every((f) => f(r))), error: null };
  }
  then<A, B>(ok?: ((v: { data: Row[]; error: null }) => A) | null, no?: ((e: unknown) => B) | null) {
    return Promise.resolve(this.run()).then(ok, no);
  }
}

const MEMBER = "55555555-5555-4555-8555-555555555555";
const T = (n: number) => `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}`;
const K = (n: number) => `a${n}a${n}a${n}a${n}-a${n}a${n}-4a${n}a-8a${n}a-a${n}a${n}a${n}a${n}a${n}a${n}`;

/** Three current English kits: circle (maths, oldest), cells (science),
 *  angles (maths) — plus a Malay translation of cells (never a source). */
function seed(over: { kits?: Row[]; publications?: Row[]; jobs?: Row[]; topics?: Row[] } = {}) {
  return new FakeDb(
    {
      topics: over.topics ?? [
        { id: T(1), title: "Area of a circle", subject: "Mathematics", status: "published", bank_maturity: "good" },
        { id: T(2), title: "Cells", subject: "Science", status: "published", bank_maturity: "strong" },
        { id: T(3), title: "Angles", subject: "Mathematics", status: "published", bank_maturity: "basic" },
      ],
      topic_kits: over.kits ?? [
        { id: K(1), topic_id: T(1), language: "en", status: "approved", source_kit_id: null, translation_status: null, supersede_reason: null, judge_score: null, created_at: "2026-10-01T00:00:00Z" },
        { id: K(2), topic_id: T(2), language: "en", status: "approved", source_kit_id: null, translation_status: null, supersede_reason: null, judge_score: null, created_at: "2026-10-02T00:00:00Z" },
        { id: K(3), topic_id: T(3), language: "en", status: "approved", source_kit_id: null, translation_status: null, supersede_reason: null, judge_score: null, created_at: "2026-10-03T00:00:00Z" },
        // an OLDER English kit of the circle topic, still approved: not current, never a source
        { id: K(7), topic_id: T(1), language: "en", status: "approved", source_kit_id: null, translation_status: null, supersede_reason: "cosmetic", judge_score: null, created_at: "2026-09-01T00:00:00Z" },
        { id: K(8), topic_id: T(2), language: "ms", status: "approved", source_kit_id: K(2), translation_status: "approved", supersede_reason: null, judge_score: null, created_at: "2026-10-05T00:00:00Z" },
      ],
      topic_publications: over.publications ?? [
        { topic_kit_id: K(1), part: 1, privacy: "public", youtube_video_id: "v1", superseded_by: null },
        { topic_kit_id: K(2), part: 1, privacy: "public", youtube_video_id: "v2", superseded_by: null },
        { topic_kit_id: K(3), part: 1, privacy: "public", youtube_video_id: "v3", superseded_by: null },
        { topic_kit_id: K(7), part: 1, privacy: "unlisted", youtube_video_id: "v7", superseded_by: "p1" },
      ],
      jobs: over.jobs ?? [],
      platform_audit_log: [],
    },
    {
      catalogue_current_kits: [
        { topic_id: T(1), language: "en", topic_kit_id: K(1) },
        { topic_id: T(2), language: "en", topic_kit_id: K(2) },
        { topic_id: T(3), language: "en", topic_kit_id: K(3) },
        { topic_id: T(2), language: "ms", topic_kit_id: K(8) },
      ],
    },
  );
}

async function post(db: FakeDb, body: unknown) {
  mocks.createAdminClient.mockReturnValue(db);
  const res = await POST(new Request("http://localhost/api/library/translate", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function get(db: FakeDb, qs = "") {
  mocks.createAdminClient.mockReturnValue(db);
  const res = await GET(new Request(`http://localhost/api/library/translate${qs}`));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const kitIds = (rows: unknown) => (rows as { kitId: string }[]).map((r) => r.kitId);

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FEATURE_CATALOGUE_GENERATE = "true";
  mocks.isLibraryMemberRequest.mockResolvedValue({ id: MEMBER, email: "editor@sketchcast.app", role: "editor" });
  mocks.enqueueTranslateJob.mockImplementation(async (_admin: unknown, opts: { sourceKitId: string }) => ({ ok: true, jobId: `job-${opts.sourceKitId.slice(0, 2)}`, existing: false }));
});

describe("the dry run", () => {
  it("GET answers the ready list in sweep order and the not-ready list with reasons, for Arabic by default", async () => {
    const { status, json } = await get(seed());
    expect(status).toBe(200);
    expect(json.language).toBe("ar");
    expect(kitIds(json.ready)).toEqual([K(1), K(2), K(3)]);
    expect((json.ready as Row[])[0]).toMatchObject({ topicId: T(1), title: "Area of a circle", subject: "Mathematics", bankMaturity: "good" });
    expect(json.notReady).toEqual([]);
    expect(json.defaultLimit).toBe(5);
    expect(mocks.enqueueTranslateJob).not.toHaveBeenCalled();
  });

  it("GET ?language= picks the language; a live translation or job in it holds the kit with the reason", async () => {
    const db = seed({
      jobs: [
        { id: "j1", type: "kit_translate", status: "queued", params: { source_kit_id: K(3), language: "ms" } },
        // another job type, a finished one: never a hold
        { id: "j2", type: "topic_publish", status: "queued", params: { source_kit_id: K(1), language: "ms" } },
        { id: "j3", type: "kit_translate", status: "done", params: { source_kit_id: K(1), language: "ms" } },
      ],
    });
    const { json } = await get(db, "?language=ms");
    expect(json.language).toBe("ms");
    expect(kitIds(json.ready)).toEqual([K(1)]);
    expect((json.notReady as Row[]).map((n) => [n.kitId, n.code])).toEqual([
      [K(3), "queued"],
      [K(2), "translation_live"],
    ]);
  });

  it("POST {dryRun: true} answers the same shape and queues nothing — even with generation switched off", async () => {
    process.env.FEATURE_CATALOGUE_GENERATE = "false";
    const db = seed();
    const { status, json } = await post(db, { language: "ar", dryRun: true });
    expect(status).toBe(200);
    expect(kitIds(json.ready)).toEqual([K(1), K(2), K(3)]);
    expect(mocks.enqueueTranslateJob).not.toHaveBeenCalled();
    expect(db.writes).toEqual([]);
  });

  it("refuses English and an unknown language", async () => {
    expect((await get(seed(), "?language=en")).status).toBe(400);
    expect((await get(seed(), "?language=xx")).status).toBe(400);
    expect((await post(seed(), { language: "en" })).status).toBe(400);
  });
});

describe("the sweep", () => {
  it("queues the first `limit` ready kits through translate-job.ts, audits each on its topic, and reports the rest as remaining", async () => {
    const db = seed();
    const { status, json } = await post(db, { language: "ar", limit: 2 });
    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, language: "ar", queued: [K(1), K(2)], alreadyQueued: [], skipped: [], remaining: 1, notReady: [] });
    expect(mocks.enqueueTranslateJob).toHaveBeenCalledTimes(2);
    expect(mocks.enqueueTranslateJob).toHaveBeenNthCalledWith(1, db, { sourceKitId: K(1), topicId: T(1), language: "ar" });
    expect(mocks.enqueueTranslateJob).toHaveBeenNthCalledWith(2, db, { sourceKitId: K(2), topicId: T(2), language: "ar" });
    // the only writes: one audit row per queued kit, on its topic, carrying the sweep
    expect(db.writes.map((w) => w.table)).toEqual(["platform_audit_log", "platform_audit_log"]);
    expect(db.writes[0].row).toMatchObject({ actor_id: MEMBER, action: "library_kit_translate_sweep", target_kind: "topic", target_id: T(1) });
    expect(db.writes[0].row.detail).toEqual({
      kit_id: K(1),
      language: "ar",
      job_id: `job-${K(1).slice(0, 2)}`,
      job_existing: false,
      sweep: { language: "ar", requested: 2, ready: 3, queued: [K(1), K(2)], already_queued: [], skipped: [] },
    });
    expect(db.writes[1].row).toMatchObject({ target_id: T(2) });
  });

  it("defaults the limit to 5 and refuses a limit that is not a whole number in range", async () => {
    const db = seed();
    const { json } = await post(db, { language: "ar" });
    expect(json.queued).toEqual([K(1), K(2), K(3)]);
    expect(json.remaining).toBe(0);
    expect((await post(seed(), { language: "ar", limit: 0 })).status).toBe(400);
    expect((await post(seed(), { language: "ar", limit: 2.5 })).status).toBe(400);
    expect((await post(seed(), { language: "ar", limit: 1000 })).status).toBe(400);
    expect((await post(seed(), { language: "ar", limit: "3" })).json.queued).toHaveLength(3);
  });

  it("a live pair from translate-job.ts is already queued, not new — and still audited with job_existing", async () => {
    mocks.enqueueTranslateJob.mockImplementation(async (_admin: unknown, opts: { sourceKitId: string }) => (opts.sourceKitId === K(2) ? { ok: true, jobId: "job-live", existing: true } : { ok: true, jobId: "job-new", existing: false }));
    const db = seed();
    const { json } = await post(db, { language: "ar", limit: 3 });
    expect(json.queued).toEqual([K(1), K(3)]);
    expect(json.alreadyQueued).toEqual([K(2)]);
    const cells = db.writes.find((w) => w.row.target_id === T(2))!;
    expect(cells.row.detail).toMatchObject({ job_id: "job-live", job_existing: true });
  });

  it("a database error on one enqueue is skipped with its message; the others still queue", async () => {
    mocks.enqueueTranslateJob.mockImplementation(async (_admin: unknown, opts: { sourceKitId: string }) => (opts.sourceKitId === K(1) ? { ok: false, error: { message: "boom" } } : { ok: true, jobId: "job", existing: false }));
    const db = seed();
    const { status, json } = await post(db, { language: "ar", limit: 3 });
    expect(status).toBe(200);
    expect(json.skipped).toEqual([{ kitId: K(1), why: "boom" }]);
    expect(json.queued).toEqual([K(2), K(3)]);
    expect(db.writes).toHaveLength(2);
  });

  it("never queues a kit that is not ready, and says why", async () => {
    const db = seed({
      publications: [
        { topic_kit_id: K(1), part: 1, privacy: "private", youtube_video_id: "v1", superseded_by: null },
        { topic_kit_id: K(2), part: 1, privacy: "public", youtube_video_id: "v2", superseded_by: null },
      ],
    });
    const { json } = await post(db, { language: "ar", limit: 5 });
    expect(json.queued).toEqual([K(2)]);
    expect((json.notReady as Row[]).map((n) => [n.kitId, n.code])).toEqual([
      [K(3), "video_missing"],
      [K(1), "video_not_public"],
    ]);
  });

  it("refuses with generation switched off (409) before any enqueue", async () => {
    process.env.FEATURE_CATALOGUE_GENERATE = "false";
    const db = seed();
    const { status, json } = await post(db, { language: "ar" });
    expect(status).toBe(409);
    expect(json.error).toMatch(/FEATURE_CATALOGUE_GENERATE/);
    expect(mocks.enqueueTranslateJob).not.toHaveBeenCalled();
    expect(db.writes).toEqual([]);
  });
});

describe("the guard", () => {
  it("a non-member is a 404 on both handlers, before anything is read", async () => {
    mocks.isLibraryMemberRequest.mockResolvedValue(null);
    expect((await get(seed())).status).toBe(404);
    expect((await post(seed(), { language: "ar" })).status).toBe(404);
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("a reviewer (no `generate`) is a 404 too", async () => {
    mocks.isLibraryMemberRequest.mockResolvedValue({ id: MEMBER, email: "r@sketchcast.app", role: "reviewer" });
    expect((await get(seed())).status).toBe(404);
    expect((await post(seed(), { language: "ar" })).status).toBe(404);
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("invalid JSON is a 400", async () => {
    expect((await post(seed(), "{not json")).status).toBe(400);
  });
});
