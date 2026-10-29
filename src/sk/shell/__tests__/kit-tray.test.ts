/**
 * S2 job tray + the next greeting (kit-tray.ts), on the SAME read and rule as
 * lesson.status (prepare.ts recentKits + kitState):
 * - trayKits: own rows only, sk_action_id rows only, the 7-day window, at most
 *   3 newest first, the state mapping, the Library link navigate builds;
 * - kitNotices: a finished kit → one line, once; a failed kit → its line; at
 *   most 2; a slow or failing read is skipped (and logged), never thrown;
 * - the memory blob records the announced ids (bounded) and the signed note
 *   carries them across conversations; the offer lasts one turn;
 * - offerAnswer: yes / open it / no in the launch locales.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/kit-tray.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KIT_TRAY_MAX, kitNotices, noticesFor, trayKits } from "../kit-tray";
import { kitState, recentKits, lessonStatus } from "@/sk/capabilities/prepare";
import { SK_MEMORY_MAX_ANNOUNCED, freshMemory, openAnnounced, rememberAnnounced, rememberTurn, sealAnnounced, sealMemory, verifyMemory } from "../memory";
import { offerAnswer } from "../offer";
import { NOW, OTHER_TEACHER_ID, TEACHER_ID, fakeSession, makeCtx } from "./fixtures";

const BOOK = "b0000000-0000-4000-8000-000000000031";
const saved = process.env.SK_SHELL_SECRET;
beforeEach(() => {
  process.env.SK_SHELL_SECRET = "kit-tray-test-secret-of-adequate-length";
});
afterEach(() => {
  if (saved === undefined) delete process.env.SK_SHELL_SECRET;
  else process.env.SK_SHELL_SECRET = saved;
});

const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const DOCS = ["worksheet", "quiz", "answer_key", "notes", "exam_paper", "deck"];

/** One SK-started kit: the presentation + six pieces, under one action id. */
function kit(action: string, chapter: number, startedHoursAgo: number, statuses: { lesson: string; docs?: string[] }, over: Record<string, unknown> = {}) {
  const docs = statuses.docs ?? DOCS.map(() => statuses.lesson);
  return [
    { id: `${action}-p`, kind: "presentation", status: statuses.lesson, title: null, chapter_ref: String(chapter), book_id: BOOK, owner_id: TEACHER_ID, params: {}, created_at: ago(startedHoursAgo), sk_action_id: action, ...over },
    ...DOCS.map((kind, i) => ({ id: `${action}-${kind}`, kind, status: docs[i], title: null, chapter_ref: String(chapter), book_id: BOOK, owner_id: TEACHER_ID, params: {}, created_at: ago(startedHoursAgo), sk_action_id: action, ...over })),
  ];
}
const books = [
  {
    id: BOOK,
    title: "Biology",
    chapters: [
      { num: 0, title: "Cell Structure" },
      { num: 1, title: "Cell Division" },
      { num: 2, title: "Specialised Cells" },
      { num: 3, title: "Transport" },
      { num: 4, title: "Enzymes" },
    ],
  },
];
const ctx = makeCtx();
const deps = (generations: Record<string, unknown>[]) => ({ session: fakeSession({ generations, books }), now: NOW });

describe("kitState — the one rule (lesson.status, tray, greeting)", () => {
  it.each([
    [{ done: 0, inProgress: 7, lesson: "queued" }, "making"],
    [{ done: 2, inProgress: 5, lesson: "processing" }, "partial"],
    [{ done: 7, inProgress: 0, lesson: "done" }, "ready"],
    [{ done: 6, inProgress: 0, lesson: "done" }, "ready"], // a piece failed, the lesson is there
    [{ done: 3, inProgress: 3, lesson: "error" }, "failed"], // the lesson failing fails the kit
    [{ done: 0, inProgress: 0, lesson: "error" }, "failed"],
  ])("%o → %s", (k, want) => {
    expect(kitState(k)).toBe(want);
  });
  it("lesson.status reports the same state per kit", async () => {
    const r = await lessonStatus.handler(ctx, {}, deps(kit("a1", 2, 1, { lesson: "processing", docs: ["done", "done", "queued", "queued", "queued", "queued"] })));
    expect(r.facts?.[0]).toMatchObject({ kind: "kit", title: "Specialised Cells", state: "partial", ready: 2, total: 7 });
  });
});

describe("trayKits", () => {
  it("own rows only, sk_action_id rows only, the 7-day window, at most 3, newest first", async () => {
    const rows = [
      ...kit("a1", 0, 30, { lesson: "done" }),
      ...kit("a2", 1, 20, { lesson: "error" }),
      ...kit("a3", 2, 2, { lesson: "processing", docs: ["done", "done", "queued", "processing", "queued", "queued"] }),
      ...kit("a4", 3, 1, { lesson: "queued" }),
      // Another teacher's kit (RLS leaked it): never shown.
      ...kit("x1", 4, 0.5, { lesson: "done" }, { owner_id: OTHER_TEACHER_ID }),
      // A Library-started kit of hers (no sk_action_id): not SK's, not shown.
      ...kit("lib", 4, 0.2, { lesson: "done" }, { sk_action_id: null }),
      // Older than 7 days: out of the window.
      ...kit("old", 4, 24 * 8, { lesson: "done" }),
    ];
    const d = deps(rows);
    const tray = await trayKits(ctx, d);
    expect(tray.length).toBe(KIT_TRAY_MAX);
    expect(tray.map((k) => k.id)).toEqual(["a4-p", "a3-p", "a2-p"]);
    expect(tray.map((k) => [k.title, k.state, k.ready, k.total])).toEqual([
      ["Transport", "making", 0, 7],
      ["Specialised Cells", "partial", 2, 7],
      ["Cell Division", "failed", 0, 7],
    ]);
    // The Library location, built by navigate: the book's row opened.
    expect(tray[0].href).toBe(`/dashboard?book=${BOOK}`);
    // The read asks for SK rows of hers in the window (the in-code checks above are the guard).
    expect(d.session.log).toEqual(expect.arrayContaining([`generations.eq("owner_id","${TEACHER_ID}")`, 'generations.not("sk_action_id","is",null)']));
    expect(d.session.log.some((l) => l.startsWith('generations.gte("created_at"'))).toBe(true);
  });
  it("a ready kit maps to ready", async () => {
    expect((await trayKits(ctx, deps(kit("a1", 2, 1, { lesson: "done" }))))[0]).toMatchObject({ state: "ready", ready: 7, total: 7 });
  });
  it("nothing for a context without lesson.status (a student, a parent hat)", async () => {
    const rows = kit("a1", 2, 1, { lesson: "done" });
    expect(await trayKits(makeCtx({ role: "student", hat: null }), deps(rows))).toEqual([]);
    expect(await trayKits(makeCtx({ hat: "parent" }), deps(rows))).toEqual([]);
  });
  it("0169 missing: the tray is empty (no fallback to Library kits)", async () => {
    const session = {
      rpc: async () => ({ data: null, error: null }),
      from: () => {
        const b: Record<string, unknown> = {};
        for (const m of ["select", "eq", "not", "gte", "order", "limit", "in"]) b[m] = () => b;
        b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { code: "42703", message: 'column "sk_action_id" does not exist' } }).then(res);
        return b;
      },
    };
    expect(await recentKits(ctx, { session, now: NOW }, 3, { skOnly: true })).toEqual([]);
    expect(await trayKits(ctx, { session, now: NOW })).toEqual([]);
  });
});

describe("kitNotices — the next greeting", () => {
  const ready = kit("a1", 2, 1, { lesson: "done" });
  it("a finished kit → one line, with a kit entity and the offer to open it", async () => {
    const n = await kitNotices(ctx, deps(ready), []);
    expect(n.lines).toEqual(["Your kit for Specialised Cells is ready — want me to open it?"]);
    expect(n.ids).toEqual(["a1-p"]);
    expect(n.entities).toEqual([{ kind: "kit", id: "a1-p", label: "Specialised Cells", via: "greeting", ids: [BOOK, "2"] }]);
    expect(n.offer).toEqual({ target: "library", bookId: BOOK, label: "Specialised Cells" });
  });
  it("…and never again once announced", async () => {
    const first = await kitNotices(ctx, deps(ready), []);
    const again = await kitNotices(ctx, deps(ready), first.ids);
    expect(again.lines).toEqual([]);
    expect(again.offer).toBeNull();
  });
  it("a failed kit → the failed line, no offer", async () => {
    const n = await kitNotices(ctx, deps(kit("a2", 2, 1, { lesson: "error" })), []);
    expect(n.lines).toEqual(["The kit for Specialised Cells didn't finish — ask me to try again, or check the Library."]);
    expect(n.offer).toBeNull();
  });
  it("a kit still being made is not announced", async () => {
    expect((await kitNotices(ctx, deps(kit("a3", 2, 1, { lesson: "processing" })), [])).lines).toEqual([]);
  });
  it("at most 2 lines; the offer is the first READY kit", async () => {
    const rows = [...kit("a1", 0, 3, { lesson: "done" }), ...kit("a2", 1, 2, { lesson: "done" }), ...kit("a3", 2, 1, { lesson: "error" })];
    const n = await kitNotices(ctx, deps(rows), []);
    expect(n.lines).toEqual([
      "The kit for Specialised Cells didn't finish — ask me to try again, or check the Library.",
      "Your kit for Cell Division is ready — want me to open it?",
    ]);
    expect(n.ids).toEqual(["a3-p", "a2-p"]);
    expect(n.offer?.label).toBe("Cell Division");
    // The third is said the NEXT time (it was not announced).
    expect((await kitNotices(ctx, deps(rows), n.ids)).lines).toEqual(["Your kit for Cell Structure is ready — want me to open it?"]);
  });
  it("in the teacher's language", async () => {
    const n = await kitNotices(makeCtx({ locale: "ms" }), deps(ready), []);
    expect(n.lines).toEqual(["Kit anda untuk Specialised Cells sudah siap — mahu saya bukakannya?"]);
  });
  it("a slow read is skipped after the time box and logged — the greeting is not held", async () => {
    const logs: string[] = [];
    const session = { rpc: async () => ({ data: null, error: null }), from: () => ({ select: () => ({ eq: () => ({ not: () => ({ gte: () => ({ order: () => ({ limit: () => new Promise(() => {}) }) }) }) }) }) }) };
    const t0 = Date.now();
    const n = await kitNotices(ctx, { session, now: NOW }, [], { timeoutMs: 30, log: (m) => logs.push(m) });
    expect(n).toEqual({ lines: [], ids: [], entities: [], offer: null });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(logs).toEqual(["sk-shell.greeting kit notices skipped: timeout"]);
  });
  it("a failing read is skipped and logged, never thrown", async () => {
    const logs: string[] = [];
    const session = {
      rpc: async () => ({ data: null, error: null }),
      from: () => {
        throw new Error("connection reset");
      },
    };
    const n = await kitNotices(ctx, { session, now: NOW }, [], { log: (m, d) => logs.push(`${m} ${d}`) });
    expect(n.lines).toEqual([]);
    expect(logs).toEqual(["sk-shell.greeting kit notices skipped: error connection reset"]);
  });
  it("noticesFor is pure over recentKits' shape", () => {
    const n = noticesFor(ctx, [{ presentationId: "p", bookId: BOOK, chapterRef: "2", title: "X", total: 7, done: 7, failed: 0, inProgress: 0, lesson: "done", startedAt: NOW.toISOString(), viaSk: false }], []);
    expect(n.lines).toEqual([]); // not SK-started → never announced
  });
});

describe("the memory blob records what was announced", () => {
  it("rememberAnnounced: newest first, de-duplicated, bounded, round-trips the seal", () => {
    const mem = rememberAnnounced(freshMemory(ctx, NOW), { ids: ["a1-p"], prior: ["z9-p"], offer: { target: "library", bookId: BOOK, label: "Specialised Cells" } });
    expect(mem.announced).toEqual(["a1-p", "z9-p"]);
    const back = verifyMemory(sealMemory(mem));
    expect(back?.announced).toEqual(["a1-p", "z9-p"]);
    expect(back?.offer).toEqual({ target: "library", bookId: BOOK, label: "Specialised Cells" });
    const many = rememberAnnounced(mem, { ids: Array.from({ length: 40 }, (_, i) => `k${i}`) });
    expect(many.announced?.length).toBe(SK_MEMORY_MAX_ANNOUNCED);
    expect(many.announced?.[0]).toBe("k0");
    expect(sealMemory(many).length).toBeLessThan(64_000);
    // No new notice: a stale offer is cleared, the list kept.
    expect(rememberAnnounced(mem, { ids: [] }).offer).toBeUndefined();
    expect(rememberAnnounced(mem, { ids: [] }).announced).toEqual(["a1-p", "z9-p"]);
  });
  it("the offer lasts ONE turn; the announced list survives turns", () => {
    const mem = rememberAnnounced(freshMemory(ctx, NOW), { ids: ["a1-p"], offer: { target: "library", bookId: BOOK, label: "x" } });
    const next = rememberTurn(mem, { user: "how are my classes", assistant: "…" }, NOW);
    expect(next.offer).toBeUndefined();
    expect(next.announced).toEqual(["a1-p"]);
  });
  it("a forged announced list or offer does not survive verification", () => {
    const blob = sealMemory({ ...freshMemory(ctx, NOW), announced: ["ok-1", "bad id with spaces", 7 as unknown as string], offer: { target: "board", bookId: "x" } as never });
    const m = verifyMemory(blob);
    expect(m?.announced).toEqual(["ok-1"]);
    expect(m?.offer).toBeUndefined();
  });
  it("the long-lived note: signed, bound to the user, ids only", () => {
    const note = sealAnnounced(TEACHER_ID, ["a1-p", "a2-p"]);
    expect(openAnnounced(note, TEACHER_ID)).toEqual(["a1-p", "a2-p"]);
    expect(openAnnounced(note, OTHER_TEACHER_ID)).toEqual([]);
    const [payload, sig] = note.split(".");
    expect(openAnnounced(`${payload}x.${sig}`, TEACHER_ID)).toEqual([]);
    expect(Buffer.from(payload, "base64url").toString("utf8")).toBe(JSON.stringify({ v: 1, uid: TEACHER_ID, ids: ["a1-p", "a2-p"] }));
  });
});

describe("offerAnswer", () => {
  it.each(["yes", "Yes!", "open it", "Open it.", "ok", "ya", "boleh", "buka", "نعم", "افتحها", "open the kit"])("%s → yes", (t) => {
    expect(offerAnswer(t)).toBe("yes");
  });
  it.each(["no", "No thanks", "not now", "tidak", "لا"])("%s → no", (t) => {
    expect(offerAnswer(t)).toBe("no");
  });
  it.each(["how's the kit going?", "open the board", "mark the next one", ""])("%s → not an answer", (t) => {
    expect(offerAnswer(t)).toBeNull();
  });
});
