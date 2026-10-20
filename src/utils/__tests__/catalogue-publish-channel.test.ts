/**
 * The publish route, RUN (not scanned), for the channel rule of 2026-10-20:
 * a translation is uploaded only to its OWN language's channel. A Malay kit
 * with no Malay channel is a 409 with the no-channel sentence and queues
 * nothing; the same kit is queued once the worker's poll has seen a Malay
 * channel within a day; an Arabic kit (channel live) and an English kit (no
 * check) are queued as before; a stale channel row (two days old) does not
 * count; a re-word uploads nothing and is never refused for the channel.
 *
 * It lives beside catalogue-routes.test.ts, not under /api/library: that
 * test scans every .ts file there as a route.
 *
 * Run: npx vitest run src/utils/__tests__/catalogue-publish-channel.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createAdminClient: vi.fn(), isLibraryMemberRequest: vi.fn() }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/utils/library-access", () => ({ isLibraryMemberRequest: mocks.isLibraryMemberRequest }));
// Next resolves "server-only" itself; outside Next it is an empty module
vi.mock("server-only", () => ({}));

import { POST } from "@/app/api/library/topics/[id]/publish/route";
import { noChannelWhy } from "@/utils/catalogue/youtube-channels";

type Row = Record<string, unknown>;

/** The slice of the query builder the publish route uses, over in-memory
 *  tables. Every insert is recorded. */
class FakeDb {
  writes: { table: string; row: Row }[] = [];
  constructor(public tables: Record<string, Row[]>) {}
  from(table: string) {
    return new Query(this, table);
  }
}

class Query {
  private filters: ((r: Row) => boolean)[] = [];
  private inserted: Row | null = null;
  private one: "maybe" | "single" | null = null;
  constructor(
    private db: FakeDb,
    private table: string,
  ) {}
  select() {
    return this;
  }
  insert(row: Row) {
    this.inserted = { id: `${this.table}-new`, ...row };
    return this;
  }
  eq(col: string, v: unknown) {
    const path = col.split("->>");
    this.filters.push((r) => (path.length === 2 ? (r[path[0]] as Row | null)?.[path[1]] : r[col]) === v);
    return this;
  }
  in(col: string, vs: unknown[]) {
    this.filters.push((r) => vs.includes(r[col]));
    return this;
  }
  gte(col: string, v: string) {
    this.filters.push((r) => String(r[col] ?? "") >= v);
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }
  maybeSingle() {
    this.one = "maybe";
    return this;
  }
  single() {
    this.one = "single";
    return this;
  }
  private run() {
    if (this.inserted) {
      this.db.writes.push({ table: this.table, row: this.inserted });
      return { data: this.inserted, error: null };
    }
    const rows = (this.db.tables[this.table] ?? []).filter((r) => this.filters.every((f) => f(r)));
    return { data: this.one ? (rows[0] ?? null) : rows, error: null };
  }
  then<A, B>(ok?: ((v: { data: unknown; error: null }) => A) | null, no?: ((e: unknown) => B) | null) {
    return Promise.resolve(this.run()).then(ok, no);
  }
}

const ADMIN = "55555555-5555-4555-8555-555555555555";
const TOPIC = "11111111-1111-4111-8111-111111111111";
const ARTICLE = "33333333-3333-4333-8333-333333333333";
const KIT = { en: "aaaaaaaa-0000-4000-8000-000000000001", ar: "aaaaaaaa-0000-4000-8000-000000000002", ms: "aaaaaaaa-0000-4000-8000-000000000003" };
const recent = () => new Date(Date.now() - 30 * 60_000).toISOString();
const old = () => new Date(Date.now() - 48 * 3600_000 - 60_000).toISOString();

function seed(channels: Row[], publications: Row[] = []) {
  const kit = (id: string, language: string) => ({
    id,
    topic_id: TOPIC,
    article_id: ARTICLE,
    language,
    status: "approved",
    translation_status: language === "en" ? null : "approved",
    part_plan: [{ part: 1 }],
  });
  return new FakeDb({
    topics: [{ id: TOPIC, title: "Circle", summary: "", status: "video_approved", bank_maturity: "good" }],
    topic_kits: [kit(KIT.en, "en"), kit(KIT.ar, "ar"), kit(KIT.ms, "ms")],
    topic_articles: [{ id: ARTICLE, status: "approved" }],
    topic_publications: publications,
    youtube_channel_stats: channels,
    jobs: [],
    platform_audit_log: [],
  });
}

async function post(db: FakeDb, body: Row) {
  mocks.createAdminClient.mockReturnValue(db);
  const res = await POST(new Request(`http://localhost/api/library/topics/${TOPIC}/publish`, { method: "POST", body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: TOPIC }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const jobs = (db: FakeDb) => db.writes.filter((w) => w.table === "jobs");

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FEATURE_CATALOGUE_PUBLISH = "true";
  delete process.env.YOUTUBE_COMPLIANCE_AUDIT_PASSED;
  mocks.isLibraryMemberRequest.mockResolvedValue({ id: ADMIN, email: "admin@sketchcast.app", role: "admin" });
});

const CHANNELS = () => [
  { channel_language: "en", title: "Sketchcast-AI", captured_at: recent() },
  { channel_language: "ar", title: "SketchCast بالعربية", captured_at: recent() },
];

describe("publish route: a translation goes only to its own language's channel", () => {
  it("refuses a Malay kit while no Malay channel exists — 409, nothing queued", async () => {
    const db = seed(CHANNELS());
    const r = await post(db, { action: "publish", kitId: KIT.ms });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe(noChannelWhy("Malay"));
    expect(r.json.channels).toEqual(["en", "ar"]);
    expect(jobs(db)).toEqual([]);
  });

  it("queues the Malay kit once the poll has seen a Malay channel", async () => {
    const db = seed([...CHANNELS(), { channel_language: "ms", title: "SketchCast Melayu", captured_at: recent() }]);
    const r = await post(db, { action: "publish", kitId: KIT.ms });
    expect(r.status).toBe(200);
    expect(jobs(db)).toHaveLength(1);
    expect(jobs(db)[0].row.params).toMatchObject({ kit_id: KIT.ms, language: "ms", privacy: "private" });
  });

  it("a channel last polled two days ago does not count", async () => {
    const db = seed([...CHANNELS(), { channel_language: "ms", title: "gone", captured_at: old() }]);
    expect((await post(db, { action: "publish", kitId: KIT.ms })).status).toBe(409);
  });

  it("Arabic (channel live) and English (never checked) queue as before", async () => {
    const ar = seed(CHANNELS());
    expect((await post(ar, { action: "publish", kitId: KIT.ar })).status).toBe(200);
    const en = seed([]);
    expect((await post(en, { action: "publish", kitId: KIT.en })).status).toBe(200);
    expect(jobs(en)[0].row.params).toMatchObject({ language: "en" });
  });

  it("a re-word uploads nothing and is not refused for the channel", async () => {
    const db = seed(CHANNELS(), [
      { id: "p1", topic_kit_id: KIT.ms, part: 1, channel_language: "en", youtube_video_id: "yt-ms", privacy: "private", playlist_ids: [], captions_uploaded: [], thumbnail_set: true, published_at: recent(), error: null },
    ]);
    const r = await post(db, { action: "rewords", kitId: KIT.ms });
    expect(r.status).toBe(200);
    expect(jobs(db)[0].row.params).toMatchObject({ action: "rewords" });
  });
});
