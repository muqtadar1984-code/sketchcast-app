/**
 * The kit route's `regenerate` action, RUN (not scanned): which article the
 * new kit is built from.
 *
 * WHY IT EXISTS. On 2026-10-02 the topic `photosynthesis` sat in_review with a
 * kit built from article v1 when the reviewer approved v2 (v1 → superseded).
 * From there the portal had no way to a kit from v2: Generate refused (the
 * topic already has a kit — "regenerate it from the kit panel"), Regenerate
 * refused (the kit's article is superseded — "generate a new kit from the
 * approved version"), Reject leaves the topic in_review, and the kit could not
 * be approved either. The two refusals pointed at each other.
 *
 * Regenerate now builds from the topic's APPROVED article whenever the old
 * kit's own article no longer is it (kitRegenerateSource) — decision 13 is
 * kept, because the new kit never carries a superseded version. Pinned here:
 *   (a) the kit's article superseded, another version approved → the new kit,
 *       its five generations and the bank job all carry the APPROVED id, and
 *       the audit row shows the article changed;
 *   (b) no approved article at all → still a 409, and nothing is written;
 *   (c) the kit's article still approved → exactly what it did before.
 *
 * It lives beside catalogue-routes.test.ts, not under /api/library: that test
 * scans every .ts file there as a route.
 *
 * Run: npx vitest run src/utils/__tests__/catalogue-kit-regenerate.test.ts
 */
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createAdminClient: vi.fn(), isLibraryMemberRequest: vi.fn(), enqueueQuestionsJob: vi.fn() }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/utils/library-access", () => ({ isLibraryMemberRequest: mocks.isLibraryMemberRequest }));
vi.mock("@/app/api/library/topics/[id]/kit/questions-job", () => ({ enqueueQuestionsJob: mocks.enqueueQuestionsJob }));

import { POST } from "@/app/api/library/topics/[id]/kit/route";
import { KIT_CREATION_KINDS } from "../catalogue/kit";

type Row = Record<string, unknown>;

/** The slice of the Supabase query builder the kit route's generate /
 *  regenerate path uses, over in-memory tables: filters are applied, an
 *  UPDATE reports the rows it hit (so the guarded topic move is real), and
 *  every write is recorded so a refusal can assert nothing was written. */
class FakeDb {
  writes: { op: "insert" | "update" | "delete"; table: string }[] = [];
  constructor(public tables: Record<string, Row[]>) {}
  rows(table: string): Row[] {
    return (this.tables[table] ??= []);
  }
  from(table: string) {
    return new Query(this, table);
  }
}

class Query {
  private op: "select" | "insert" | "update" | "delete" = "select";
  private payload: Row | Row[] | null = null;
  private filters: ((r: Row) => boolean)[] = [];
  constructor(private db: FakeDb, private table: string) {}
  select() {
    return this;
  }
  insert(rows: Row | Row[]) {
    this.op = "insert";
    this.payload = rows;
    return this;
  }
  update(row: Row) {
    this.op = "update";
    this.payload = row;
    return this;
  }
  delete() {
    this.op = "delete";
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
  private run(): { data: Row[]; error: null } {
    const list = this.db.rows(this.table);
    const hit = () => list.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "insert") {
      const added = (Array.isArray(this.payload) ? this.payload : [this.payload!]).map((r) => ({ id: randomUUID(), ...r }));
      list.push(...added);
      this.db.writes.push({ op: "insert", table: this.table });
      return { data: added, error: null };
    }
    if (this.op === "update") {
      const rows = hit();
      for (const r of rows) Object.assign(r, this.payload);
      this.db.writes.push({ op: "update", table: this.table });
      return { data: rows, error: null };
    }
    if (this.op === "delete") {
      const rows = hit();
      this.db.tables[this.table] = list.filter((r) => !rows.includes(r));
      this.db.writes.push({ op: "delete", table: this.table });
      return { data: rows, error: null };
    }
    return { data: hit(), error: null };
  }
  async maybeSingle() {
    return { data: this.run().data[0] ?? null, error: null };
  }
  async single() {
    return { data: this.run().data[0], error: null };
  }
  then<A, B>(ok?: ((v: { data: Row[]; error: null }) => A) | null, no?: ((e: unknown) => B) | null) {
    return Promise.resolve(this.run()).then(ok, no);
  }
}

const TOPIC = "11111111-1111-4111-8111-111111111111";
const KIT = "22222222-2222-4222-8222-222222222222";
const V1 = "33333333-3333-4333-8333-333333333333";
const V2 = "44444444-4444-4444-8444-444444444444";
const MEMBER = "55555555-5555-4555-8555-555555555555";
const OWNER = "66666666-6666-4666-8666-666666666666";

const article = (id: string, version: number, status: string): Row => ({ id, topic_id: TOPIC, language: "en", version, status });

/** A topic in review holding ONE reviewed kit built from article v1. */
function seed(articles: Row[], kitStatus = "in_review") {
  return new FakeDb({
    topics: [{ id: TOPIC, title: "Photosynthesis", status: "in_review" }],
    topic_articles: articles,
    topic_kits: [{ id: KIT, topic_id: TOPIC, article_id: V1, language: "en", source_kit_id: null, teacher_avatar: "male", status: kitStatus }],
    topic_curriculum_map: [],
    generations: [],
    platform_audit_log: [],
  });
}

async function regenerate(db: FakeDb) {
  mocks.createAdminClient.mockReturnValue(db);
  const res = await POST(
    new Request(`http://localhost/api/library/topics/${TOPIC}/kit`, { method: "POST", body: JSON.stringify({ action: "regenerate", kitId: KIT }) }),
    { params: Promise.resolve({ id: TOPIC }) },
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const newKit = (db: FakeDb) => db.rows("topic_kits").find((k) => k.id !== KIT) ?? null;
const auditDetail = (db: FakeDb) => {
  const row = db.rows("platform_audit_log").find((r) => r.action === "library_kit_regenerate");
  return (row?.detail ?? null) as Record<string, unknown> | null;
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FEATURE_CATALOGUE_GENERATE = "true";
  process.env.CATALOGUE_OWNER_ID = OWNER;
  mocks.isLibraryMemberRequest.mockResolvedValue({ id: MEMBER, email: "editor@sketchcast.app", role: "editor" });
  mocks.enqueueQuestionsJob.mockResolvedValue({ ok: true, jobId: "job-1", existing: false });
});

describe("kit route — regenerate picks the APPROVED article", () => {
  it("(a) the kit's article is superseded and a newer version is approved: the new kit is built from the approved one", async () => {
    const db = seed([article(V1, 1, "superseded"), article(V2, 2, "approved")]);
    const { status, json } = await regenerate(db);

    expect(status).toBe(200);
    const kit = newKit(db)!;
    expect(kit).toMatchObject({ topic_id: TOPIC, article_id: V2, source_kit_id: KIT, teacher_avatar: "male", status: "generating" });
    expect(json.kitId).toBe(kit.id);
    // the status machine's reopening, and the old kit kept as history
    expect(db.rows("topics")[0].status).toBe("generating");
    expect(db.rows("topic_kits").find((k) => k.id === KIT)).toMatchObject({ article_id: V1, status: "in_review" });
    // every piece the worker builds names the approved article (decision 13)
    const gens = db.rows("generations");
    expect(gens.map((g) => g.kind)).toEqual([...KIT_CREATION_KINDS]);
    for (const g of gens) expect(g.params).toMatchObject({ catalogue: true, topic_id: TOPIC, kit_id: kit.id, article_id: V2 });
    expect(gens.every((g) => g.owner_id === OWNER)).toBe(true);
    // …and so does the bank job
    expect(mocks.enqueueQuestionsJob).toHaveBeenCalledWith(db, { topicId: TOPIC, articleId: V2, language: "en" });
    // the trail shows the article changed
    expect(auditDetail(db)).toMatchObject({ kit_id: kit.id, article_id: V2, source_article_id: V1, article_changed: true, source_kit_id: KIT, from: "in_review", to: "generating" });
  });

  it("(a) the same for a REJECTED kit — the state Reject leaves the topic in", async () => {
    const db = seed([article(V1, 1, "superseded"), article(V2, 2, "approved")], "rejected");
    const { status } = await regenerate(db);
    expect(status).toBe(200);
    expect(newKit(db)).toMatchObject({ article_id: V2, source_kit_id: KIT });
    expect(auditDetail(db)).toMatchObject({ article_id: V2, source_article_id: V1, article_changed: true });
  });

  it("(a) the kit's article row is gone but a version is approved: built from the approved one", async () => {
    const db = seed([article(V2, 2, "approved")]);
    const { status } = await regenerate(db);
    expect(status).toBe(200);
    expect(newKit(db)).toMatchObject({ article_id: V2 });
    expect(auditDetail(db)).toMatchObject({ article_id: V2, source_article_id: V1, article_changed: true });
  });

  it("(b) no approved article at all: still a 409, and nothing is written", async () => {
    // v2 is only under review — a kit is never built from an unapproved version
    const db = seed([article(V1, 1, "superseded"), article(V2, 2, "in_review")]);
    const { status, json } = await regenerate(db);

    expect(status).toBe(409);
    expect(json.error).toMatch(/built from \(v1\) is superseded, and the topic has no approved article — approve an article version first/);
    expect(json.articleStatus).toBe("superseded");
    expect(db.writes).toEqual([]);
    expect(newKit(db)).toBeNull();
    expect(db.rows("topics")[0].status).toBe("in_review");
    expect(db.rows("generations")).toEqual([]);
    expect(mocks.enqueueQuestionsJob).not.toHaveBeenCalled();
  });

  it("(b) an approved article in ANOTHER language is not the kit's source", async () => {
    const db = seed([article(V1, 1, "superseded"), { ...article(V2, 1, "approved"), language: "ar" }]);
    const { status } = await regenerate(db);
    expect(status).toBe(409);
    expect(db.writes).toEqual([]);
  });

  it("(c) the kit's article is still the approved version: unchanged — the same article, nothing marked as changed", async () => {
    const db = seed([article(V1, 1, "approved")]);
    const { status } = await regenerate(db);

    expect(status).toBe(200);
    const kit = newKit(db)!;
    expect(kit).toMatchObject({ article_id: V1, source_kit_id: KIT, teacher_avatar: "male", status: "generating" });
    expect(db.rows("topics")[0].status).toBe("generating");
    for (const g of db.rows("generations")) expect(g.params).toMatchObject({ article_id: V1 });
    expect(mocks.enqueueQuestionsJob).toHaveBeenCalledWith(db, { topicId: TOPIC, articleId: V1, language: "en" });
    expect(auditDetail(db)).toMatchObject({ article_id: V1, source_article_id: V1, article_changed: false });
  });

  it("the kit and topic rules still come first: an approved kit is not regenerated, whatever its article", async () => {
    const db = seed([article(V1, 1, "superseded"), article(V2, 2, "approved")], "approved");
    const { status, json } = await regenerate(db);
    expect(status).toBe(409);
    expect(json.error).toMatch(/reject it first/);
    expect(db.writes).toEqual([]);
  });
});
