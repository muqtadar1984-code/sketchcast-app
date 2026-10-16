/**
 * /api/catalogue/file — the signed-in download of a catalogue document
 * (Phase C). What is pinned:
 *   * the ORDER of refusals: a malformed request before any read; the account's
 *     eligibility (release switch, suspension, role) before the kit lookup; a
 *     non-catalogue id and a locked topic both before any storage path is read;
 *   * only document kinds are served — never the video, never questions_json;
 *   * the filename is the Library's own (docDownloadName), so a worksheet saves
 *     as Worksheet.docx, its key as the answer-key name, the deck as Deck.pptx;
 *   * the handler: 401 before the service role is built, a short signed URL,
 *     a 302 that is never cached, and a catalogue_events 'download' row.
 *
 * Run: node node_modules/vitest/vitest.mjs run src/app/api/catalogue
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), createAdminClient: vi.fn() }));
vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));

import { GET } from "@/app/api/catalogue/file/route";
import { CATALOGUE_URL_TTL_SECONDS, pieceKindIn, resolveCatalogueFileWith, SERVED_KINDS, type CatalogueStore } from "@/app/api/catalogue/logic";
import { docDownloadName } from "@/utils/download-name";

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TOPIC = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const KIT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const WORKSHEET = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const DECK = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const LESSON = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const STRANGER_GEN = "99999999-9999-4999-8999-999999999999";

type Row = Record<string, unknown>;

/** A minimal store: rpc answers by name, tables filter by eq/in. Records
 * which tables were read so a refusal can prove nothing was looked up. */
/** The fake is structurally a CatalogueStore; TS cannot prove the hand-rolled thenable matches PromiseLike, so call sites cast. */
const cs = (s: Store): CatalogueStore => s as unknown as CatalogueStore;

class Store {
  reads: string[] = [];
  constructor(
    public rpcs: Record<string, { data: unknown; error?: unknown }>,
    public tables: Record<string, Row[]>,
  ) {}
  rpc(name: string) {
    const r = this.rpcs[name] ?? { data: null, error: { message: `no rpc ${name}` } };
    return Promise.resolve({ data: r.data, error: r.error ?? null });
  }
  from(table: string) {
    this.reads.push(table);
    const rows = this.tables[table] ?? [];
    const filters: Array<[string, unknown]> = [];
    const result = () => ({ data: rows.filter((r) => filters.every(([c, v]) => r[c] === v)) });
    const chain = {
      eq: (c: string, v: unknown) => {
        filters.push([c, v]);
        return chain;
      },
      then: <A, B>(ok?: ((v: { data: Row[] | null }) => A) | null, no?: ((e: unknown) => B) | null) => Promise.resolve(result()).then(ok, no),
    };
    return {
      select: () => ({
        eq: chain.eq,
        in: (c: string, vs: unknown[]) => Promise.resolve({ data: rows.filter((r) => vs.includes(r[c])) }),
      }),
    };
  }
}

const kitRow = { id: KIT, topic_id: TOPIC, presentation_generation_id: LESSON, doc_generation_ids: { worksheet: WORKSHEET, deck: DECK, lesson_plan: "" } };
const art = (gen: string, kind: string, path: string) => ({ generation_id: gen, kind, storage_path: path });

const unlockedStore = (over: Partial<ConstructorParameters<typeof Store>[0]> = {}) =>
  new Store(
    {
      catalogue_ineligible_reason: { data: null },
      catalogue_current_kits: { data: [{ topic_id: TOPIC, language: "en", topic_kit_id: KIT }] },
      ...over,
    },
    {
      topic_kits: [kitRow],
      catalogue_unlocks: [{ id: "u1", user_id: USER, topic_id: TOPIC }],
      artifacts: [
        art(WORKSHEET, "docx", "sys/w/worksheet.docx"),
        art(WORKSHEET, "answer_key_docx", "sys/w/worksheet_key.docx"),
        art(WORKSHEET, "questions_json", "sys/w/questions.json"),
        art(DECK, "deck_pptx", "sys/d/deck.pptx"),
        art(LESSON, "video_mp4", "sys/l/video.mp4"),
      ],
    },
  );

describe("resolveCatalogueFileWith", () => {
  it("serves a worksheet's docx with the Library's download name", async () => {
    const r = await resolveCatalogueFileWith(cs(unlockedStore()), USER, WORKSHEET, "docx");
    expect(r).toEqual({ ok: true, path: "sys/w/worksheet.docx", filename: docDownloadName("worksheet", "docx"), topicId: TOPIC, genKind: "worksheet" });
    expect((r as { filename: string }).filename).toBe("Worksheet.docx");
  });

  it("serves the answer key and the deck under their own names", async () => {
    const key = await resolveCatalogueFileWith(cs(unlockedStore()), USER, WORKSHEET, "answer_key_docx");
    expect(key.ok && key.filename).toBe(docDownloadName("worksheet", "answer_key_docx"));
    const deck = await resolveCatalogueFileWith(cs(unlockedStore()), USER, DECK, "deck_pptx");
    expect(deck.ok && deck.path).toBe("sys/d/deck.pptx");
    expect(deck.ok && deck.filename).toBe("Deck.pptx");
  });

  it("never serves the video or the marking scheme, even when the file exists", async () => {
    for (const [gen, kind] of [
      [LESSON, "video_mp4"],
      [WORKSHEET, "questions_json"],
      [WORKSHEET, "script_json"],
    ] as const) {
      const s = unlockedStore();
      const r = await resolveCatalogueFileWith(cs(s), USER, gen, kind);
      expect(r).toEqual({ ok: false, status: 404, error: "No such file." });
      expect(s.reads).toEqual([]); // refused before any read
    }
    expect([...SERVED_KINDS].sort()).toEqual(["answer_key_docx", "deck_pptx", "docx"]);
  });

  it("refuses a malformed id before reading anything", async () => {
    const s = unlockedStore();
    expect(await resolveCatalogueFileWith(cs(s), USER, "not-a-uuid", "docx")).toMatchObject({ ok: false, status: 404 });
    expect(s.reads).toEqual([]);
  });

  it("refuses an ineligible account before the kit lookup — the release switch, suspension and the role rule all arrive as a reason", async () => {
    for (const reason of ["coming_soon", "suspended", "forbidden_role"]) {
      const s = unlockedStore({ catalogue_ineligible_reason: { data: reason } });
      const r = await resolveCatalogueFileWith(cs(s), USER, WORKSHEET, "docx");
      expect(r).toMatchObject({ ok: false, status: 403 });
      expect(s.reads).toEqual([]);
    }
  });

  it("refuses a generation that is not a piece of a current kit, without reading unlocks or artifacts", async () => {
    const s = unlockedStore();
    const r = await resolveCatalogueFileWith(cs(s), USER, STRANGER_GEN, "docx");
    expect(r).toEqual({ ok: false, status: 404, error: "No such file." });
    expect(s.reads).toEqual(["topic_kits"]);
  });

  it("refuses a locked topic before any storage path is read", async () => {
    const s = unlockedStore();
    s.tables.catalogue_unlocks = [{ id: "u2", user_id: "someone-else", topic_id: TOPIC }];
    const r = await resolveCatalogueFileWith(cs(s), USER, WORKSHEET, "docx");
    expect(r).toEqual({ ok: false, status: 403, error: "Unlock this kit first." });
    expect(s.reads).toEqual(["topic_kits", "catalogue_unlocks"]);
  });

  it("answers 503, not 403, when the database itself cannot be asked", async () => {
    const s = unlockedStore({ catalogue_ineligible_reason: { data: null, error: { message: "down" } } });
    expect(await resolveCatalogueFileWith(cs(s), USER, WORKSHEET, "docx")).toMatchObject({ ok: false, status: 503 });
  });

  it("404s a piece the kit holds but whose file was never written", async () => {
    const s = unlockedStore();
    s.tables.artifacts = s.tables.artifacts.filter((a) => a.generation_id !== DECK);
    expect(await resolveCatalogueFileWith(cs(s), USER, DECK, "deck_pptx")).toMatchObject({ ok: false, status: 404 });
  });

  it("pieceKindIn reads the presentation column and the document map, and ignores blanks", () => {
    expect(pieceKindIn(kitRow, LESSON)).toBe("presentation");
    expect(pieceKindIn(kitRow, WORKSHEET)).toBe("worksheet");
    expect(pieceKindIn(kitRow, "")).toBeNull(); // the lesson_plan slot is "" — never a match
    expect(pieceKindIn(kitRow, STRANGER_GEN)).toBeNull();
  });
});

describe("GET /api/catalogue/file", () => {
  beforeEach(() => {
    mocks.createClient.mockReset();
    mocks.createAdminClient.mockReset();
  });

  const req = (gen: string, kind: string) => new Request(`https://app.test/api/catalogue/file?gen=${gen}&kind=${kind}`);

  it("401s a signed-out caller before the service role is built", async () => {
    mocks.createClient.mockResolvedValue({ auth: { getUser: async () => ({ data: { user: null } }) } });
    const res = await GET(req(WORKSHEET, "docx"));
    expect(res.status).toBe(401);
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("302s to a short-lived signed URL carrying the download name, never cached, and records the download", async () => {
    mocks.createClient.mockResolvedValue({ auth: { getUser: async () => ({ data: { user: { id: USER } } }) } });
    const store = unlockedStore();
    const inserted: Row[] = [];
    const signed = vi.fn(async () => ({ data: { signedUrl: "https://storage.test/signed" } }));
    mocks.createAdminClient.mockReturnValue({
      rpc: store.rpc.bind(store),
      from: (table: string) =>
        table === "catalogue_events" ? { insert: async (row: Row) => (inserted.push(row), { error: null }) } : store.from(table),
      storage: { from: () => ({ createSignedUrl: signed }) },
    });
    const res = await GET(req(WORKSHEET, "docx"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://storage.test/signed");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(signed).toHaveBeenCalledWith("sys/w/worksheet.docx", CATALOGUE_URL_TTL_SECONDS, { download: "Worksheet.docx" });
    expect(CATALOGUE_URL_TTL_SECONDS).toBeLessThanOrEqual(600);
    expect(inserted).toEqual([{ user_id: USER, topic_id: TOPIC, event: "download", meta: { generation_id: WORKSHEET, kind: "worksheet", artifact: "docx" } }]);
  });

  it("relays the resolver's refusal and never signs", async () => {
    mocks.createClient.mockResolvedValue({ auth: { getUser: async () => ({ data: { user: { id: USER } } }) } });
    const store = unlockedStore();
    store.tables.catalogue_unlocks = [];
    const signed = vi.fn();
    mocks.createAdminClient.mockReturnValue({ rpc: store.rpc.bind(store), from: store.from.bind(store), storage: { from: () => ({ createSignedUrl: signed }) } });
    const res = await GET(req(WORKSHEET, "docx"));
    expect(res.status).toBe(403);
    expect(signed).not.toHaveBeenCalled();
  });
});
