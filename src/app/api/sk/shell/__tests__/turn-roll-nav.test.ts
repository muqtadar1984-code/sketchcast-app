/**
 * The roll and the highlight in MODEL routing — production 2026-10-30 (the
 * founder, Biology ch2 adopted kit, the roll at "30 / 54": the video's slides
 * on pages 4–25, the deck on 27–54):
 *   - the eight utterances of that session, each through its tool, to the
 *     right roll page / deck slide / video slide (the stub plays the tool
 *     call prompt rule 15 asks for; the route turns it into the Board event);
 *   - the system prompt carries the ROLL (page on screen, count, ranges);
 *   - "Explain this part" on a highlighted DECK page of the adopted kit: no
 *     model round to choose the tool, the sibling deck's slide text, ONE
 *     grounded call; the model's own explain_selection is a hand-off;
 *   - a highlight on a video slide's frame / on a blank page;
 *   - tool-call markup (`<invoke …>`) never reaches the bubble or memory.
 * Stub providers only — no paid model call.
 * Run: node node_modules/vitest/vitest.mjs run src/app/api/sk/shell/__tests__/turn-roll-nav.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StubTurn } from "@/utils/assistant/providers/stub";
import type { GenerateOpts, StreamEvent } from "@/utils/assistant/provider";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  cookies: {} as Record<string, string>,
  queue: [] as unknown[][],
  constructed: [] as string[],
  opts: [] as GenerateOpts[],
  manifest: { status: "missing" } as unknown,
}));
vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => (mocks.cookies[n] ? { value: mocks.cookies[n] } : undefined) }) }));
vi.mock("@/utils/platform-admin", () => ({ founderEmails: () => [], staffUserIds: async () => new Set<string>() }));
vi.mock("@/sk/manifest/store", async () => {
  const real = await vi.importActual<typeof import("@/sk/manifest/store")>("@/sk/manifest/store");
  return { ...real, readManifest: async () => mocks.manifest };
});
vi.mock("@/utils/assistant/providers/anthropic", async () => {
  const { StubProvider } = await import("@/utils/assistant/providers/stub");
  return {
    AnthropicProvider: class extends StubProvider {
      constructor(model: string) {
        super((mocks.queue.shift() ?? [{ text: ["(unscripted)"] }]) as StubTurn[]);
        mocks.constructed.push(model);
      }
      async *stream(opts: GenerateOpts): AsyncGenerator<StreamEvent, void, void> {
        mocks.opts.push(opts);
        yield* super.stream(opts);
      }
    },
  };
});

import { POST } from "@/app/api/sk/shell/turn/route";
import { __setDocsAdminForTests } from "@/sk/capabilities/documents";
import { sayFor } from "@/sk/capabilities/board";
import { COULD_NOT_DO } from "@/sk/shell/markup";
import { openMemory } from "@/sk/shell/memory";
import { SCHOOL_ID, TEACHER_ID, fakeAdmin, fakeManifest, fakeSession, readEvents } from "@/sk/shell/__tests__/fixtures";

const ENV = ["FEATURE_SK", "SK_ROLES", "SK_ALLOWED_EMAILS", "FEATURE_SK_SHELL_ALL_SCHOOLS", "SK_SHELL_CONSUMER", "SK_SHELL_SECRET", "FEATURE_ROLE_HATS", "SK_SHELL_MODEL", "SK_FAST_MODEL", "SK_AUDIT", "SK_ROUTING", "SK_MODEL_FIRST_EMAILS", "PRESENT_ALLOWED_EMAILS"];
const saved: Record<string, string | undefined> = {};
const USER = { id: TEACHER_ID, email: "t@school.example", email_confirmed_at: "2026-01-01T00:00:00Z" };

// The adopted kit: her copy of a catalogue kit — the lesson (the video) and
// its SIBLING deck piece, linked by the catalogue topic kit.
const PRES = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DECK = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TOPIC_KIT = "77777777-7777-4777-8777-777777777777";
// Registered by its own row (0166), not at the folder's default path.
const MAP_PATH = `${TEACHER_ID}/${DECK}/deck_pages/map.json`;
const genRow = (id: string, kind: string) => ({
  id,
  kind,
  title: "Biology ch2: Cells",
  owner_id: TEACHER_ID,
  book_id: null,
  chapter_ref: null,
  params: { catalogue_ref: { topic_kit_id: TOPIC_KIT } },
  status: "done",
  withdrawn_at: null,
  removed_at: null,
  created_at: "2026-10-30T19:00:00Z",
});
const DECK_SLIDES = Array.from({ length: 28 }, (_, i) => {
  const n = i + 1;
  if (n === 4) return { n, png: "slide_04.png", w: 1920, h: 1080, title: "Parts of a light microscope", text: "Eyepiece, objective lens, stage and mirror", notes: "Point to each part as you name it.", words: [], blocks: [] };
  if (n === 7)
    return {
      n,
      png: "slide_07.png",
      w: 1920,
      h: 1080,
      title: "Focusing the microscope",
      text: "The coarse focus knob brings the specimen into rough focus",
      notes: "Use the fine focus knob after the coarse one, at high power.",
      words: ["The", "coarse", "focus", "knob", "brings", "the", "specimen", "into", "rough", "focus"].map((t, j) => ({ t, b: [j * 0.08, 0.3, j * 0.08 + 0.07, 0.36] })),
      blocks: [],
    };
  return { n, png: `slide_${String(n).padStart(2, "0")}.png`, w: 1920, h: 1080, title: `Slide ${n}`, text: "", notes: "", words: [], blocks: [] };
});
const MAP = { v: 1, renderer: "libreoffice", slides: DECK_SLIDES };

/** An in-memory table: select / eq (json paths too) / in / is / order / limit, awaitable or maybeSingle. */
/* eslint-disable @typescript-eslint/no-explicit-any */
function tableOf(rows: Array<Record<string, unknown>>) {
  const get = (r: Record<string, unknown>, col: string): unknown => col.split(/->>?/).reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), r);
  const q = (filters: Array<(r: Record<string, unknown>) => boolean>, lim = Infinity): any => {
    const hit = () => rows.filter((r) => filters.every((f) => f(r))).slice(0, lim);
    const b: any = {
      select: () => b,
      order: () => b,
      eq: (c: string, v: unknown) => q([...filters, (r) => get(r, c) === v], lim),
      in: (c: string, vs: unknown[]) => q([...filters, (r) => vs.includes(get(r, c))], lim),
      is: (c: string, v: unknown) => q([...filters, (r) => (get(r, c) ?? null) === v], lim),
      limit: (n: number) => q(filters, n),
      maybeSingle: async () => ({ data: hit()[0] ?? null, error: null }),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve({ data: hit(), error: null }).then(res, rej),
    };
    return b;
  };
  return q([]);
}
const TABLES = {
  generations: [genRow(PRES, "presentation"), genRow(DECK, "deck")],
  artifacts: [
    { generation_id: PRES, kind: "script_json", storage_path: `${TEACHER_ID}/${PRES}/script.json` },
    { generation_id: DECK, kind: "deck_pptx", storage_path: `${TEACHER_ID}/${DECK}/deck.pptx` },
    { generation_id: DECK, kind: "deck_pages_json", storage_path: MAP_PATH },
  ],
};
let downloads: string[] = [];
const storage = {
  from: () => ({
    download: async (path: string) => {
      downloads.push(path);
      return path === MAP_PATH ? { data: { text: async () => JSON.stringify(MAP) }, error: null } : { data: null, error: new Error("not found") };
    },
  }),
};
/** The route's admin client: the shared fake (audit, plan) plus the kit's tables and the map. */
function routeAdmin(opts: { artifacts?: boolean } = {}) {
  const base = fakeAdmin("school");
  const hidden = opts.artifacts === false ? new Set(["artifacts"]) : new Set<string>();
  return { ...base, from: (t: string) => (t in TABLES ? tableOf(hidden.has(t) ? [] : TABLES[t as keyof typeof TABLES]) : base.from(t)), storage };
}
/** kit-docs' admin (documents.ts), the same rows. */
const docsAdmin = () => ({ from: (t: string) => tableOf((TABLES as Record<string, Array<Record<string, unknown>>>)[t] ?? []), storage }) as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

// The session HER reads go through: the deck row is NOT readable directly
// (the adopted copy's deck is reached through the kit) — the sibling path.
const sessionTables = () => ({
  profiles: [{ role: "teacher", school_id: SCHOOL_ID }],
  schools: [{ config: {} }],
  coordinator_scope: [],
  parent_links: [],
  classes: [{ id: "c7b", name: "7B", teacher_id: TEACHER_ID, school_id: SCHOOL_ID }],
  enrollments: [],
  books: [],
  generations: [],
});

// The Board: the video's 22 slides (slide 4 is "Measuring tiny cells"), the
// roll at page 30 of 54 — video slides 1–22 on pages 4–25, deck 1–28 on 27–54.
const SEGMENTS = Array.from({ length: 22 }, (_, k) => ({ k, id: `s${k + 1}`, heading: k === 3 ? "Measuring tiny cells" : `Video heading ${k + 1}` }));
const ROLL = [
  { kind: "video", from: 4, to: 25, first: 1, last: 22 },
  { kind: "deck", from: 27, to: 54, first: 1, last: 28 },
];
const BOARD = { sessionId: "sess-1", manifestId: "man-1", generationId: PRES, k: 21, t: 219.9, paused: true, rollPage: 29, rollCount: 54, roll: ROLL, rollAt: { kind: "deck", n: 4 }, deck: "loaded", segments: SEGMENTS };

type Ev = Record<string, unknown> & { type: string };
const req = (body: unknown) => new Request("http://x/api/sk/shell/turn", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
async function say(text: string, board: Record<string, unknown> = BOARD, memory?: string): Promise<{ ev: Ev[]; text: string; done: Ev; board: Ev | undefined; tools: string[] }> {
  const body = { turnId: `t-${Math.random().toString(36).slice(2)}`, text, modality: "text", collector: { path: "/present", locale: "en", board }, ...(memory ? { memory } : {}) };
  const ev = (await readEvents(await POST(req(body)))) as Ev[];
  return {
    ev,
    done: ev.find((e) => e.type === "done")!,
    text: ev.filter((e) => e.type === "text").map((e) => e.text).join(""),
    board: ev.find((e) => e.type === "board"),
    tools: ev.filter((e) => e.type === "tool").map((e) => String(e.name)),
  };
}
/** The model's one tool call, then its line once the result is back. */
const plays = (name: string, args: Record<string, unknown>, line: string) => mocks.queue.push([{ toolCalls: [{ id: "c1", name: name.replace(/\./g, "__"), args }] }, { text: [line] }]);
const SONNET = "claude-sonnet-5-5";

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.FEATURE_SK = "true";
  process.env.SK_ROLES = "teacher";
  process.env.FEATURE_SK_SHELL_ALL_SCHOOLS = "true";
  process.env.SK_SHELL_SECRET = "route-test-secret-of-adequate-length";
  process.env.FEATURE_ROLE_HATS = "true";
  process.env.SK_AUDIT = "db";
  process.env.SK_ROUTING = "model";
  mocks.cookies = { sc_hat: "teacher" };
  mocks.queue = [];
  mocks.constructed = [];
  mocks.opts = [];
  mocks.manifest = { status: "missing" };
  downloads = [];
  mocks.createAdminClient.mockReturnValue(routeAdmin());
  mocks.createClient.mockResolvedValue(fakeSession(sessionTables(), { user: USER }));
  __setDocsAdminForTests(docsAdmin);
  vi.spyOn(console, "info").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  __setDocsAdminForTests(null);
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("the roll in the model's prompt", () => {
  it("the context names the page on screen, the count and each range; rule 15 tells page / deck / video apart", async () => {
    plays("board.page", { to: "next" }, "Page 31.");
    await say("show next page");
    const sys = mocks.opts[0].system;
    expect(sys).toContain("roll=30/54");
    expect(sys).toContain("ROLL (the Board's pages, numbered as the Board shows them)");
    expect(sys).toContain("- on screen: page 30 of 54 — deck slide 4");
    expect(sys).toContain("- pages 4–25: video slides 1–22");
    expect(sys).toContain("- pages 27–54: deck slides 1–28");
    expect(sys).toContain("15. The Board's ROLL is its pages");
    expect(mocks.opts[0].tools?.map((t) => t.name)).toContain("board__page");
  });
});

describe("production 2026-10-30, utterance by utterance (model routing)", () => {
  it("1. 'lets move to slide 4 in the deck please' → board.page to=deck 4 → roll page 30, never the video's slide 4", async () => {
    plays("board.page", { to: "deck", n: 4 }, "Here is slide 4 of the deck.");
    const r = await say("lets move to slide 4 in the deck please");
    expect(r.tools).toEqual(["board.page"]);
    expect(r.board).toEqual({ type: "board", move: "page", args: { page: 30, item: { kind: "deck", n: 4 } }, say: sayFor("page_deck", "en", { n: 4 }) });
    expect(r.text).not.toContain("Measuring tiny cells");
    expect(r.done).toMatchObject({ label: "grounded", sources: ["board.page"] });
  });

  it("2. 'load the complete deck as pages and then move to slide 4' → ONE board.load_deck with page=4", async () => {
    plays("board.load_deck", { page: 4 }, "The deck is on the roll; going to its slide 4.");
    const r = await say("load the complete deck as pages and then move to slide 4");
    expect(r.tools).toEqual(["board.load_deck"]);
    expect(r.board).toMatchObject({ type: "board", move: "load_deck", args: { page: 4 }, say: sayFor("page_deck", "en", { n: 4 }) });
    // Before the deck is on the roll: the load lands on deck slide 4 too.
    plays("board.page", { to: "deck", n: 4 }, "Loading the deck.");
    const fresh = await say("load the complete deck as pages and then move to slide 4", { ...BOARD, deck: "ready", rollCount: 26, roll: [ROLL[0]], rollPage: 25, rollAt: { kind: "blank" } });
    expect(fresh.board).toMatchObject({ move: "load_deck", args: { page: 4 }, say: sayFor("load_deck", "en") });
  });

  it("3. 'yes please' (to going to deck page 4) → board.page to=deck 4", async () => {
    plays("board.page", { to: "deck", n: 4 }, "Deck slide 4 is on screen.");
    const r = await say("yes please");
    expect(r.board).toMatchObject({ move: "page", args: { page: 30, item: { kind: "deck", n: 4 } } });
    expect(r.text).not.toMatch(/can't jump/i);
  });

  it("4. 'can you load the slide deck as pages' → board.load_deck (already there: its first page)", async () => {
    plays("board.load_deck", {}, "The deck is on the roll.");
    const r = await say("can you load the slide deck as pages");
    expect(r.board).toMatchObject({ move: "load_deck", say: sayFor("deck_first", "en") });
    expect((r.board!.args as Record<string, unknown>).page).toBeUndefined();
  });

  it("5. 'move to page 31' → board.page to=page 31 on the 54-page roll, not refused", async () => {
    plays("board.page", { to: "page", n: 31 }, "Page 31.");
    const r = await say("move to page 31");
    expect(r.board).toEqual({ type: "board", move: "page", args: { page: 31 }, say: "Page 31." });
    expect(r.text).not.toMatch(/no page 31|28 pages/i);
    // A page the roll does not have is SK's own line, no move.
    plays("board.page", { to: "page", n: 60 }, "");
    const bad = await say("move to page 60");
    expect(bad.board).toBeUndefined();
    expect(bad.text).toBe("The roll has 54 pages.");
  });

  it("6. 'show next page' → board.page to=next → page 31; at the end, SK says so", async () => {
    plays("board.page", { to: "next" }, "Page 31.");
    const r = await say("show next page");
    expect(r.board).toMatchObject({ move: "page", args: { page: 31 } });
    plays("board.page", { to: "next" }, "");
    const end = await say("show next page", { ...BOARD, rollPage: 53, rollAt: { kind: "deck", n: 28 } });
    expect(end.board).toBeUndefined();
    expect(end.text).toBe("This is the last page (54 / 54).");
  });

  it("7. 'explain the deck slide 4 which is currently open' → kit.documents reads deck slide 4 of the adopted kit; the roll already shows it", async () => {
    plays("kit.documents", { action: "read", doc: "deck", slide: 4 }, "Slide 4 shows the parts of a light microscope: the eyepiece, objective lens, stage and mirror.");
    const r = await say("explain the deck slide 4 which is currently open on the whiteboard");
    expect(r.tools).toEqual(["kit.documents"]);
    expect(r.text).toContain("eyepiece, objective lens, stage and mirror");
    expect(r.done).toMatchObject({ label: "grounded", sources: ["kit.documents"] });
    const result = mocks.opts[1].messages.find((m) => m.role === "tool");
    expect(result && "result" in result ? result.result : "").toContain("Parts of a light microscope");
  });

  it("8. a highlighted DECK bullet + 'Explain this part' → no model round to choose; the sibling deck's slide; ONE grounded call", async () => {
    mocks.queue.push([{ text: ["The coarse focus knob brings the specimen into rough focus. ", "Then the fine focus knob sharpens it at high power."] }]);
    const sel = { generationId: DECK, n: 7, text: "The coarse focus knob brings", title: "Focusing the microscope" };
    const r = await say("Explain this part", { ...BOARD, selection: sel });
    expect(r.ev.map((e) => e.type)).toEqual(["meta", "lang", "tool", "text", "done"].filter((t) => t !== "lang" || r.ev.some((e) => e.type === "lang")));
    expect(r.tools).toEqual(["board.explain_selection"]);
    expect(r.ev.find((e) => e.type === "tool")).toMatchObject({ ok: true });
    expect(r.text).toBe("The coarse focus knob brings the specimen into rough focus. Then the fine focus knob sharpens it at high power.");
    expect(r.text).not.toContain("<invoke");
    expect(r.done).toMatchObject({ label: "grounded", sources: ["board.explain_selection", "deck"] });
    // One provider: the grounded call itself (no tools, the teach budget), from the deck's slide 7.
    expect(mocks.constructed).toEqual([SONNET]);
    expect(mocks.opts[0].tools).toBeUndefined();
    expect(mocks.opts[0].maxTokens).toBe(220);
    expect(mocks.opts[0].system).toContain("--- deck slide 7: Focusing the microscope ---");
    expect(mocks.opts[0].system).toContain("speaker notes: Use the fine focus knob after the coarse one, at high power.");
    expect(mocks.opts[0].system).toContain("HIGHLIGHTED (the part to explain): The coarse focus knob brings");
    expect(downloads).toContain(MAP_PATH);
  });
});

describe("the highlight in model routing", () => {
  const SEL = { generationId: DECK, n: 7, text: "The coarse focus knob brings", title: "Focusing the microscope" };

  it("the deck's map not found by the deck's own read → the kit's SIBLING deck piece (#233) supplies slide 7, still grounded", async () => {
    mocks.createAdminClient.mockReturnValue(routeAdmin({ artifacts: false }));
    mocks.queue.push([{ text: ["The coarse focus knob brings the specimen into rough focus."] }]);
    const r = await say("explain this", { ...BOARD, selection: SEL });
    expect(r.done).toMatchObject({ label: "grounded", sources: ["board.explain_selection", "deck"] });
    expect(mocks.opts[0].system).toContain("--- deck slide 7: Focusing the microscope ---");
    // The route's own read missed (the default path), the kit's read found the row's map.
    expect(downloads).toContain(`${TEACHER_ID}/${DECK}/deck_pages/pages.json`);
    expect(downloads).toContain(MAP_PATH);
  });

  it("a deck that is neither hers nor a piece of her open kit → refused, no model", async () => {
    const r = await say("explain this", { ...BOARD, selection: { ...SEL, generationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" } });
    expect(r.ev.find((e) => e.type === "tool")).toMatchObject({ name: "board.explain_selection", ok: false });
    expect(r.done).toMatchObject({ label: "declined" });
    expect(mocks.constructed).toEqual([]);
  });

  it("the model's own board.explain_selection is a HAND-OFF: it stops, the route explains from the slide", async () => {
    mocks.queue.push([{ toolCalls: [{ id: "c1", name: "board__explain_selection", args: {} }] }, { text: ['<invoke name="board.explain_selection"> </invoke>'] }]);
    mocks.queue.push([{ text: ["The coarse focus knob brings the specimen into rough focus."] }]);
    const r = await say("hmm, why does that bit matter for the class?", { ...BOARD, selection: SEL });
    expect(r.tools).toEqual(["board.explain_selection"]);
    expect(r.text).toBe("The coarse focus knob brings the specimen into rough focus.");
    expect(r.done).toMatchObject({ label: "grounded", sources: ["board.explain_selection", "deck"] });
    // Round 1 (the tool call) then the grounded call; the model's round 2 never ran.
    expect(mocks.constructed).toEqual([SONNET, SONNET]);
    expect(mocks.opts).toHaveLength(2);
    expect(mocks.opts[1].tools).toBeUndefined();
  });

  it("a highlight on a video slide's frame: that video slide, explained from the lesson map, said as such", async () => {
    mocks.manifest = {
      status: "ready",
      builtAt: "2026-10-30T00:00:00Z",
      manifest: fakeManifest(SEGMENTS.map((s) => ({ id: s.id, heading: s.heading, narration: s.k === 3 ? "Cells are measured in micrometres with an eyepiece graticule." : `Narration ${s.k + 1}.` }))),
    };
    mocks.queue.push([{ text: ["Cells are measured in micrometres with an eyepiece graticule."] }]);
    const r = await say("explain this", { ...BOARD, rollPage: 6, rollAt: { kind: "video", n: 4 }, selection: { on: "video", generationId: PRES, n: 4, text: "", title: "Measuring tiny cells" } });
    expect(r.tools).toEqual(["board.explain_selection"]);
    expect(r.text).toBe(`${sayFor("selection_video", "en", { n: 4 })} Cells are measured in micrometres with an eyepiece graticule.`);
    expect(r.done).toMatchObject({ label: "grounded", sources: ["board.explain_selection", "manifest"] });
    expect(mocks.opts[0].system).toContain("--- slide 4: Measuring tiny cells ---");
  });

  it("a highlight on a blank page (her handwriting): SK says what it cannot read — no model, never 'nothing on that'", async () => {
    const r = await say("Explain this part", { ...BOARD, rollPage: 25, rollAt: { kind: "blank" }, selection: { on: "page", generationId: "", n: 26, text: "" } });
    expect(r.tools).toEqual(["board.explain_selection"]);
    expect(r.text).toBe(sayFor("selection_page", "en"));
    expect(r.done).toMatchObject({ label: "declined" });
    expect(mocks.constructed).toEqual([]);
  });
});

describe("tool-call markup never reaches her", () => {
  it("the production reply — three rounds of kit.documents, then `<invoke …>` as text — becomes SK's honest line; logged with the turn id; not remembered", async () => {
    const read = { id: "c", name: "kit__documents", args: { action: "read", doc: "deck", slide: 7 } };
    mocks.queue.push([{ toolCalls: [read] }, { toolCalls: [{ ...read, id: "c2" }] }, { toolCalls: [{ ...read, id: "c3" }] }, { text: ['<invoke name="board.explain_selection"> </invoke>'] }]);
    const r = await say("Explain this part");
    expect(r.text).toBe(COULD_NOT_DO.en);
    expect(JSON.stringify(r.ev)).not.toContain("invoke");
    expect(r.done).toMatchObject({ label: "declined" });
    const mem = openMemory(r.done.memory as string, { user: { id: TEACHER_ID } } as never, new Date()).memory;
    expect(JSON.stringify(mem.turns)).not.toContain("invoke");
    const logged = warn.mock.calls.find((c: unknown[]) => c[0] === "sk-shell.turn tool markup");
    expect(logged).toBeDefined();
    expect(JSON.parse(String(logged![1]))).toMatchObject({ where: "model", tools: ["kit.documents", "kit.documents", "kit.documents"] });
    expect(String(logged![1])).toContain('"turnId":"t-');
  });

  it("markup around real words: the words stay", async () => {
    plays("board.page", { to: "next" }, "Page 31 is up.<function_calls><invoke name=\"board.page\"><parameter name=\"to\">next</parameter></invoke></function_calls>");
    const r = await say("show next page");
    expect(r.text).toBe("Page 31 is up.");
  });
});
