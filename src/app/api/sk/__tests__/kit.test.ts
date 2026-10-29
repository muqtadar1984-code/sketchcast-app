/**
 * SK S3 slice B — the student kit routes (/api/sk/kit, /items, /answer, /turn)
 * over the product → kit map world (the REAL ProductKits + SupabaseEntitlements
 * on the in-memory fake): refusals with a plain reason (not entitled / not
 * mapped / no kit), a chapter with three kits, the video signed ONLY after
 * canOpenKit, caption_only passed through, the "preparing" state and the
 * build-on-POST, practice items without answer keys, marking, and the kit
 * turn's replay guard (one model call, one sk_usage row, per eventId).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));

import { GET as getKit, POST as buildKit } from "@/app/api/sk/kit/route";
import { GET as getItems } from "@/app/api/sk/kit/items/route";
import { POST as answer } from "@/app/api/sk/kit/answer/route";
import { POST as turn } from "@/app/api/sk/kit/turn/route";
import { StubProvider } from "@/utils/assistant/providers/stub";
import { SupabaseEntitlements } from "@/sk/entitlement";
import { SupabaseItemBank } from "@/sk/items-supabase";
import type { KitReply } from "@/sk/kit-player";
import { __setKitDepsForTests, KIT_VIDEO_TTL_S, type KitAdmin, type KitDeps } from "@/sk/kit-server";
import type { ReadResult } from "@/sk/manifest/store";
import { ProductKits } from "@/sk/product-kits";
import { SupabaseSessionStore } from "@/sk/store-supabase";
import { BLOOD, CELLS, ELSEWHERE, ITEM_MCQ, ITEM_OFFMAP, ITEM_TF, kitManifest, kitWorld, OWNER, PRODUCT, RESP, SLUG, STRANGER, STUDENT, T0, TRANSPORT, UNMAPPED } from "@/sk/__tests__/kit-fixtures";
import type { FakeDb } from "@/sk/__tests__/fake-supabase";

const signedIn = (id: string | null) => mocks.createClient.mockResolvedValue({ auth: { getUser: async () => ({ data: { user: id ? { id } : null } }) } });
const get = (q: Record<string, string>) => new Request(`http://x/api/sk/kit?${new URLSearchParams(q).toString()}`);
const post = (body: unknown) => new Request("http://x/api/sk/kit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
let n = 0;
const eid = () => `0192f5c0-0000-7000-8000-${String(++n).padStart(12, "0")}`;

type World = { db: FakeDb; adminMade: ReturnType<typeof vi.fn>; sign: ReturnType<typeof vi.fn>; read: ReturnType<typeof vi.fn>; derive: ReturnType<typeof vi.fn>; teacher: StubProvider };

function install(opts: { read?: ReadResult["status"]; derive?: ReadResult["status"] } = {}): World {
  const db = kitWorld();
  const sign = vi.fn(async (path: string, ttl: number) => ({ data: { signedUrl: `https://signed.example/${path}?ttl=${ttl}` }, error: null }));
  const admin: KitAdmin = { from: (t: string) => db.from(t), storage: { from: () => ({ createSignedUrl: sign }) } };
  const adminMade = vi.fn(() => admin);
  const result = (status: ReadResult["status"]): ReadResult => (status === "ready" ? { status: "ready", manifest: kitManifest(), builtAt: new Date(T0).toISOString() } : { status });
  const read = vi.fn(async () => result(opts.read ?? "ready"));
  const derive = vi.fn(async () => result(opts.derive ?? "ready"));
  const teacher = new StubProvider([{ text: ["A cell is the smallest unit of life."] }]);
  const entitlements = new SupabaseEntitlements(db);
  const deps: Partial<KitDeps> = {
    kits: new ProductKits(db, entitlements, () => new Date(T0)),
    admin: adminMade,
    read,
    derive,
    items: () => new SupabaseItemBank(db),
    store: new SupabaseSessionStore(db, { now: () => T0, pollMs: 1, inflightTimeoutMs: 500 }),
    entitlements,
    teacherProvider: teacher,
    now: () => T0,
  };
  __setKitDepsForTests(deps);
  return { db, adminMade, sign, read, derive, teacher };
}

beforeEach(() => {
  process.env.FEATURE_SK = "true";
  signedIn(STUDENT);
});
afterEach(() => {
  __setKitDepsForTests(null);
  delete process.env.FEATURE_SK;
  vi.clearAllMocks();
});

describe("gate", () => {
  it("404 with FEATURE_SK off, 401 signed out, 400 on a malformed query", async () => {
    install();
    delete process.env.FEATURE_SK;
    expect((await getKit(get({ product: SLUG, chapter: "1" }))).status).toBe(404);
    process.env.FEATURE_SK = "true";
    signedIn(null);
    expect((await getKit(get({ product: SLUG, chapter: "1" }))).status).toBe(401);
    signedIn(STUDENT);
    expect((await getKit(get({ product: "../x", chapter: "1" }))).status).toBe(400);
    expect((await getKit(get({ product: SLUG, chapter: "1", kit: "not-a-uuid" }))).status).toBe(400);
  });
});

describe("refusals, with a plain reason — and no admin client, no signing", () => {
  it("not entitled → 403 not_entitled", async () => {
    const w = install();
    signedIn(STRANGER);
    const res = await getKit(get({ product: SLUG, chapter: "1" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "You don't have access to this book.", reason: "not_entitled" });
    expect(w.adminMade).not.toHaveBeenCalled();
    expect(w.sign).not.toHaveBeenCalled();
  });
  it("a kit that is not this chapter's → 404 not_mapped (unmapped, another product's, another chapter's)", async () => {
    const w = install();
    for (const kit of [UNMAPPED, ELSEWHERE, BLOOD]) {
      const res = await getKit(get({ product: SLUG, chapter: "1", kit }));
      expect(res.status).toBe(404);
      expect(((await res.json()) as { reason: string }).reason).toBe("not_mapped");
    }
    expect(w.adminMade).not.toHaveBeenCalled();
    expect(w.sign).not.toHaveBeenCalled();
  });
  it("a chapter with no kit → 404 no_kit; an unknown book → 404 unknown_product", async () => {
    const w = install();
    const res = await getKit(get({ product: SLUG, chapter: "3" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "This chapter has no lesson yet.", reason: "no_kit" });
    expect(((await (await getKit(get({ product: "no-such-book", chapter: "1" }))).json()) as { reason: string }).reason).toBe("unknown_product");
    expect(w.sign).not.toHaveBeenCalled();
  });
});

describe("the kit", () => {
  it("a chapter with three kits lists them in order and opens the first; ?kit= opens another", async () => {
    install();
    const r = (await (await getKit(get({ product: SLUG, chapter: "8" }))).json()) as Extract<KitReply, { status: "ready" }>;
    expect(r.kits.map((k) => k.generationId)).toEqual([BLOOD, RESP, TRANSPORT]);
    expect(r.kit.generationId).toBe(BLOOD);
    const r2 = (await (await getKit(get({ product: PRODUCT, chapter: "8", kit: RESP }))).json()) as Extract<KitReply, { status: "ready" }>;
    expect(r2.kit.generationId).toBe(RESP);
    expect(r2.kit.title).toBe("The Human Respiratory System");
  });

  it("signs the kit's video parts in part order, short-lived, only after canOpenKit", async () => {
    const w = install();
    const res = await getKit(get({ product: SLUG, chapter: "1" }));
    expect(res.status).toBe(200);
    const r = (await res.json()) as Extract<KitReply, { status: "ready" }>;
    expect(r.status).toBe("ready");
    expect(r.kit.videos).toEqual([
      { part: 1, url: `https://signed.example/${OWNER}/${CELLS}/lesson.mp4?ttl=${KIT_VIDEO_TTL_S}` },
      { part: 2, url: `https://signed.example/${OWNER}/${CELLS}/lesson_part2.mp4?ttl=${KIT_VIDEO_TTL_S}` },
    ]);
    expect(r.kit.videoUrl).toBe(r.kit.videos[0]!.url);
    expect(KIT_VIDEO_TTL_S).toBeLessThanOrEqual(3600);
    expect(w.sign).toHaveBeenCalledTimes(2); // the deck is not signed for the player
    expect(w.adminMade).toHaveBeenCalled();
  });

  it("passes caption_only through, with heading and points, and never the narration", async () => {
    install();
    const r = (await (await getKit(get({ product: SLUG, chapter: "1" }))).json()) as Extract<KitReply, { status: "ready" }>;
    expect(r.kit.segments[1]).toMatchObject({ key: "p1:s002", heading: "Plant and animal cells", points: ["Plant cells have a wall", "Animal cells have none"], visual: { kind: "caption_only", caption_only: true } });
    expect(r.kit.segments[0]!.visual).toEqual({ kind: "frame", caption_only: false });
    expect(r.kit.segments[0]!.practise).toBe(2);
    expect(JSON.stringify(r)).not.toContain("narration");
  });

  it("first open: GET says preparing (nothing built, nothing signed); POST builds the map and answers ready", async () => {
    const w = install({ read: "missing" });
    const p = (await (await getKit(get({ product: SLUG, chapter: "1" }))).json()) as KitReply;
    expect(p).toEqual({ status: "preparing", kits: [{ generationId: CELLS, label: "Cells", title: "Cells · Cells" }], kit: { generationId: CELLS, title: "Cells · Cells" } });
    expect(w.derive).not.toHaveBeenCalled();
    expect(w.sign).not.toHaveBeenCalled();
    const b = (await (await buildKit(post({ product: SLUG, chapter: "1" }))).json()) as KitReply;
    expect(w.derive).toHaveBeenCalledWith(expect.anything(), CELLS);
    expect(b.status).toBe("ready");
  });

  it("a build still running answers preparing; a failed map answers unavailable", async () => {
    install({ read: "building", derive: "building" });
    expect(((await (await buildKit(post({ product: SLUG, chapter: "1" }))).json()) as KitReply).status).toBe("preparing");
    __setKitDepsForTests(null);
    install({ read: "failed" });
    expect(await (await getKit(get({ product: SLUG, chapter: "1" }))).json()).toMatchObject({ status: "unavailable", reason: "map_failed" });
  });

  it("a POST from an unentitled user builds nothing", async () => {
    const w = install({ read: "missing" });
    signedIn(STRANGER);
    expect((await buildKit(post({ product: SLUG, chapter: "1" }))).status).toBe(403);
    expect(w.derive).not.toHaveBeenCalled();
  });
});

describe("practise and marking", () => {
  const itemsReq = (segment: string) => new Request(`http://x/api/sk/kit/items?${new URLSearchParams({ product: SLUG, chapter: "1", segment }).toString()}`);
  const answerReq = (body: Record<string, unknown>) => new Request("http://x/api/sk/kit/answer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ product: SLUG, chapter: "1", eventId: eid(), ...body }) });

  it("serves the section's bank items with every marking field stripped", async () => {
    install();
    const res = await getItems(itemsReq("p1:s001"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string; type: string; options?: string[] }[] };
    expect(body.items.map((i) => [i.id, i.type])).toEqual([
      [ITEM_MCQ, "mcq"],
      [ITEM_TF, "true_false"],
    ]);
    expect(body.items[0]!.options).toEqual(["A cell", "An atom"]);
    expect(JSON.stringify(body)).not.toMatch(/"answer"|"key"/);
    expect(((await (await getItems(itemsReq("p1:s002"))).json()) as { items: unknown[] }).items).toEqual([]);
  });

  it("marks an answer on a kit item and records it; refuses an item that is not the kit's; a 4th try is refused (slice C writes)", async () => {
    const w = install();
    expect(await (await answer(answerReq({ itemId: ITEM_MCQ, response: "A cell" }))).json()).toMatchObject({ outcome: "correct", score: 1, max: 1, attemptNo: 1, triesLeft: 0, rungs: [], reveal: null });
    expect(await (await answer(answerReq({ itemId: ITEM_TF, response: false }))).json()).toMatchObject({ outcome: "incorrect", attemptNo: 1, triesLeft: 2 });
    expect((await answer(answerReq({ itemId: ITEM_OFFMAP, response: true }))).status).toBe(404);
    // The client's attemptNo is ignored: the server counts (2, then 3, then no tries left).
    expect(await (await answer(answerReq({ itemId: ITEM_TF, response: false, attemptNo: 1 }))).json()).toMatchObject({ attemptNo: 2, triesLeft: 1 });
    expect(await (await answer(answerReq({ itemId: ITEM_TF, response: false, attemptNo: 1 }))).json()).toMatchObject({ attemptNo: 3, triesLeft: 0, reveal: { answer: "true" } });
    expect((await answer(answerReq({ itemId: ITEM_TF, response: true, attemptNo: 1 }))).status).toBe(409);
    expect(w.db.rows("item_attempts").map((r) => [r.item_id, r.attempt_no])).toEqual([
      [ITEM_MCQ, 1],
      [ITEM_TF, 1],
      [ITEM_TF, 2],
      [ITEM_TF, 3],
    ]);
    // These fixture items carry no article objective: recorded, no objective mastery.
    expect(w.db.rows("item_attempts").every((r) => r.objective_key === null)).toBe(true);
    expect(w.db.rows("sk_objective_mastery")).toEqual([]);
    expect(w.db.rows("sk_usage")).toEqual([]);
  });

  it("practice for an unentitled user is refused", async () => {
    install();
    signedIn(STRANGER);
    expect((await getItems(itemsReq("p1:s001"))).status).toBe(403);
    expect((await answer(answerReq({ itemId: ITEM_MCQ, response: "A cell" }))).status).toBe(403);
  });
});

describe("the kit turn (explain)", () => {
  const turnReq = (body: Record<string, unknown>) => new Request("http://x/api/sk/kit/turn", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ product: SLUG, chapter: "1", segment: "p1:s001", ...body }) });
  const frames = async (res: Response) =>
    (await res.text())
      .split("\n\n")
      .filter(Boolean)
      .map((c) => ({ event: /^event: (.*)$/m.exec(c)![1]!, data: JSON.parse(c.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n")) as unknown }));

  it("one model turn, metered once; the same eventId replays without a second call or a second count", async () => {
    const w = install();
    const id = eid();
    const a = await frames(await turn(turnReq({ eventId: id })));
    expect(a.filter((e) => e.event === "text").map((e) => e.data)).toEqual(["A cell is the smallest unit of life."]);
    expect(a.find((e) => e.event === "done")!.data).toMatchObject({ metered: { live_turns: 1 } });
    const b = await frames(await turn(turnReq({ eventId: id })));
    expect(b.find((e) => e.event === "done")!.data).toMatchObject({ replayed: true });
    expect(w.teacher.calls).toHaveLength(1);
    expect(w.db.rows("sk_usage")).toEqual([expect.objectContaining({ user_id: STUDENT, product_id: PRODUCT, live_turns: 1 })]);
  });

  it("refused for an unentitled user before any model call; 400 without an eventId", async () => {
    const w = install();
    expect((await turn(turnReq({}))).status).toBe(400);
    signedIn(STRANGER);
    expect((await turn(turnReq({ eventId: eid() }))).status).toBe(403);
    expect(w.teacher.calls).toHaveLength(0);
  });

  it("409 preparing while the map is not ready — nothing is taught from it", async () => {
    const w = install({ read: "building" });
    const res = await turn(turnReq({ eventId: eid() }));
    expect(res.status).toBe(409);
    expect(w.teacher.calls).toHaveLength(0);
  });
});
