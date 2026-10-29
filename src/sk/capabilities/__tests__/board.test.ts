/**
 * board.* capabilities (S1 slice B): arg validation, the no-Board / no-map
 * refusals, explain/compare resolution over a stub ctx.board, the localised
 * `say` lines, and the registry meta (teacher hat, Board flag, immediate).
 * Run: node node_modules/vitest/vitest.mjs run src/sk/capabilities/__tests__/board.test.ts
 */
import { describe, expect, it } from "vitest";
import type { SkBoardState, SkCapability, SkContext } from "@/sk/shell/types";
import { BOARD_CAPABILITIES, BOARD_MOVES, BOARD_NOT_OPEN, BOARD_NO_MAP, conceptTokens, resolveSegment, sayFor } from "../board";
import { makeCtx, NOW } from "@/sk/shell/__tests__/fixtures";
import { buildContext } from "@/sk/shell/context";
import { fakeSession, ALL_FLAGS, TEACHER_ID, SCHOOL_ID } from "@/sk/shell/__tests__/fixtures";

const BOARD: SkBoardState = {
  sessionId: "sess-1",
  manifestId: "man-1",
  generationId: "gen-1",
  k: 2,
  segmentId: "s3",
  t: 61.2,
  paused: true,
  segments: [
    { k: 0, id: "s1", heading: "Introduction" },
    { k: 1, id: "s2", heading: "What is a cell?", points: ["Cells are the units of life", "Seen with a microscope"] },
    { k: 2, id: "s3", heading: "Red blood cells", points: ["Carry oxygen", "No nucleus"] },
    { k: 3, id: "s4", heading: "Nerve cells", points: ["Carry signals", "Long axon"] },
    { k: 4, id: "s5", heading: "Diffusion across the membrane" },
  ],
  concepts: [
    { id: "c-rbc", name: "red blood cell", segmentIds: ["s3"] },
    { id: "c-neuron", name: "neuron", segmentIds: ["s4"] },
    { id: "c-diff", name: "diffusion", segmentIds: ["s5"] },
  ],
};

function ctxWith(board: SkBoardState | null, locale = "en"): SkContext {
  return buildContext({
    user: { id: TEACHER_ID, email: "t@school.example" },
    role: "teacher",
    schoolId: SCHOOL_ID,
    hat: "teacher",
    coordinatorScope: [],
    plan: "school",
    staff: false,
    flags: ALL_FLAGS,
    collector: { path: "/present", board: board ?? undefined, locale },
    now: NOW,
  });
}

const cap = (name: string): SkCapability => {
  const c = BOARD_CAPABILITIES.find((x) => x.meta.name === name);
  if (!c) throw new Error(name);
  return c;
};
const deps = { session: fakeSession({}), now: NOW };
const run = (name: string, args: Record<string, unknown> = {}, board: SkBoardState | null = BOARD, locale = "en") => cap(name).handler(ctxWith(board, locale), args, deps);

describe("registry meta", () => {
  it("one entry per move, immediate/board, teacher hat, Board flag, no student/parent", () => {
    expect(BOARD_CAPABILITIES.map((c) => c.meta.name)).toEqual(BOARD_MOVES.map((m) => `board.${m}`));
    for (const c of BOARD_CAPABILITIES) {
      expect(c.meta.tier).toBe("immediate");
      expect(c.meta.kind).toBe("board");
      expect(c.meta.flags).toEqual(["board"]);
      expect(c.meta.hats).toEqual(["teacher"]);
      expect(c.meta.roles).not.toContain("student");
      expect(c.meta.roles).not.toContain("parent");
      expect(c.meta.roles).toContain("teacher");
    }
  });
});

describe("no Board → refused with BOARD_NOT_OPEN (every move)", () => {
  it.each(BOARD_MOVES)("board.%s", async (move) => {
    const r = await run(`board.${move}`, { k: 0, n: 2, concept: "x", a: "x", b: "y" }, null);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("no board");
    expect(r.summary).toBe(BOARD_NOT_OPEN);
    expect(r.board).toBeUndefined();
  });
  it("a collector board without a sessionId is no board", async () => {
    const r = await run("board.pause", {}, { sessionId: "" });
    expect(r).toMatchObject({ ok: false, error: "no board" });
  });
});

describe("segment-bound moves need the lesson map; the simple ones do not", () => {
  const noMap: SkBoardState = { sessionId: "sess-1" };
  it.each(["segment", "slide", "explain", "compare"])("board.%s without a manifest → BOARD_NO_MAP", async (m) => {
    const r = await run(`board.${m}`, { k: 0, concept: "x", a: "x", b: "y" }, noMap);
    expect(r).toMatchObject({ ok: false, error: "no manifest", summary: BOARD_NO_MAP });
  });
  it.each(["intro", "pause", "resume", "freeze", "blank", "back", "recap", "walkthrough", "practise"])("board.%s works with just a session", async (m) => {
    const r = await run(`board.${m}`, {}, noMap);
    expect(r.ok).toBe(true);
    expect(r.board?.move).toBe(m);
    expect(typeof r.board?.say).toBe("string");
  });
});

describe("intro / pause / resume / freeze / blank / back / recap", () => {
  it("return the move with no args and SK's line", async () => {
    const r = await run("board.intro");
    expect(r).toMatchObject({ ok: true, board: { move: "intro", args: {}, say: "Playing the introduction." } });
    expect((await run("board.pause")).board).toEqual({ move: "pause", args: {}, say: "Paused." });
    expect((await run("board.resume")).board?.move).toBe("resume");
    expect((await run("board.freeze")).board?.move).toBe("freeze");
    expect((await run("board.blank")).board?.move).toBe("blank");
    expect((await run("board.back")).board?.move).toBe("back");
    expect((await run("board.recap")).board?.move).toBe("recap");
  });
  it("speaks the user's locale", async () => {
    expect((await run("board.pause", {}, BOARD, "ms")).board?.say).toBe("Dijeda.");
    expect((await run("board.pause", {}, BOARD, "ar")).board?.say).toBe("متوقف.");
    expect((await run("board.intro", {}, BOARD, "hi")).board?.say).toBe("परिचय चल रहा है।");
    expect((await run("board.intro", {}, BOARD, "xx")).board?.say).toBe("Playing the introduction."); // unknown → English
  });
});

describe("segment / slide: k validated against the client's segments", () => {
  it("segment k → move segment with the heading; say uses the 1-based number", async () => {
    const r = await run("board.segment", { k: 1 });
    expect(r.ok).toBe(true);
    expect(r.board).toEqual({ move: "segment", args: { k: 1, heading: "What is a cell?" }, say: "Playing part 2." });
    expect(r.facts).toEqual([{ k: 2, heading: "What is a cell?" }]);
  });
  it("slide k carries heading + points for the model to narrate from", async () => {
    const r = await run("board.slide", { k: 2 });
    expect(r.board).toEqual({ move: "slide", args: { k: 2, heading: "Red blood cells", points: ["Carry oxygen", "No nucleus"] }, say: "Slide 3: Red blood cells." });
    expect(r.facts?.[0]).toMatchObject({ k: 3, heading: "Red blood cells" });
  });
  it("accepts a numeric string; refuses a missing, negative or out-of-range k", async () => {
    expect((await run("board.slide", { k: "3" })).board?.args.k).toBe(3);
    expect(await run("board.slide", {})).toMatchObject({ ok: false, error: "bad_k" });
    expect(await run("board.slide", { k: -1 })).toMatchObject({ ok: false, error: "bad_k" });
    expect(await run("board.slide", { k: 1.5 })).toMatchObject({ ok: false, error: "bad_k" });
    const r = await run("board.slide", { k: 5 });
    expect(r).toMatchObject({ ok: false, error: "no_such_slide" });
    expect(r.summary).toBe("This lesson has 5 slides.");
  });
  it("with a manifest but no segment list, any k ≥ 0 passes and the say has no heading", async () => {
    const r = await run("board.slide", { k: 7 }, { sessionId: "s", manifestId: "m" });
    expect(r.board).toEqual({ move: "slide", args: { k: 7, heading: "", points: [] }, say: "Slide 8." });
  });
});

describe("explain: concept → segment, as a slide", () => {
  it("resolves through the concept table first", async () => {
    const r = await run("board.explain", { concept: "neurons" });
    expect(r.ok).toBe(true);
    expect(r.board?.move).toBe("slide");
    expect(r.board?.args).toMatchObject({ k: 3, heading: "Nerve cells", concept: "neurons", via: "concept" });
    expect(r.board?.say).toBe("Let's look at Nerve cells.");
    expect(r.facts).toEqual([{ concept: "neurons", k: 4, heading: "Nerve cells", points: "Carry signals | Long axon" }]);
  });
  it("falls back to a heading match", async () => {
    const r = await run("board.explain", { concept: "the membrane" });
    expect(r.board?.args).toMatchObject({ k: 4, via: "heading" });
  });
  it("refuses an empty or unknown concept without a move", async () => {
    expect(await run("board.explain", {})).toMatchObject({ ok: false, error: "bad_concept" });
    const r = await run("board.explain", { concept: "photosynthesis" });
    expect(r).toMatchObject({ ok: false, error: "no_match" });
    expect(r.summary).toBe('I couldn\'t find "photosynthesis" in this lesson.');
    expect(r.board).toBeUndefined();
  });
});

describe("compare: two concepts → slide a, carrying b", () => {
  it("resolves both and shows the first", async () => {
    const r = await run("board.compare", { a: "red blood cells", b: "nerve cells" });
    expect(r.ok).toBe(true);
    expect(r.board?.move).toBe("slide");
    expect(r.board?.args).toMatchObject({ k: 2, next: 3, a: { k: 2, heading: "Red blood cells" }, b: { k: 3, heading: "Nerve cells" } });
    expect(r.board?.say).toBe("Slide 3 and slide 4: Red blood cells against Nerve cells.");
    expect(r.facts).toHaveLength(2);
  });
  it("names what it could not find", async () => {
    const r = await run("board.compare", { a: "red blood cells", b: "mitochondria" });
    expect(r).toMatchObject({ ok: false, error: "no_match" });
    expect(r.summary).toBe('I couldn\'t find "mitochondria" in this lesson.');
    expect(await run("board.compare", { a: "x" })).toMatchObject({ ok: false, error: "bad_concept" });
  });
});

describe("practise / walkthrough", () => {
  it("defaults to 3, caps at 10, carries the open segment", async () => {
    const r = await run("board.practise", {});
    expect(r.board).toEqual({ move: "practise", args: { n: 3, k: 2, segmentId: "s3" }, say: "3 questions for the class." });
    expect((await run("board.practise", { n: 25 })).board?.args.n).toBe(10);
    expect((await run("board.practise", { n: "2" })).board?.args.n).toBe(2);
    expect(await run("board.practise", { n: 0 })).toMatchObject({ ok: false, error: "bad_n" });
  });
  it("walkthrough is a bare move", async () => {
    expect((await run("board.walkthrough")).board).toEqual({ move: "walkthrough", args: {}, say: "Let's walk through the worksheet." });
  });
});

describe("resolveSegment / conceptTokens (pure)", () => {
  it("drops stop words and plural s", () => {
    expect(conceptTokens("the red blood cells")).toEqual(["red", "blood", "cell"]);
    expect(conceptTokens("الخلايا")).toEqual(["خلايا"]);
  });
  it("needs at least half the content words", () => {
    expect(resolveSegment("diffusion", BOARD)?.k).toBe(4);
    expect(resolveSegment("blood", BOARD)?.k).toBe(2);
    expect(resolveSegment("osmosis", BOARD)).toBeNull();
    expect(resolveSegment("", BOARD)).toBeNull();
    expect(resolveSegment("cell", { sessionId: "s" })).toBeNull();
  });
  it("a concept whose segment id is unknown falls through to headings", () => {
    const b: SkBoardState = { ...BOARD, concepts: [{ id: "c", name: "nerve cell", segmentIds: ["nope"] }] };
    expect(resolveSegment("nerve cell", b)).toMatchObject({ k: 3, via: "heading" });
  });
});

describe("sayFor", () => {
  it("fills placeholders in every locale", () => {
    for (const loc of ["en", "ms", "ms-arab", "ar", "fr", "es", "pt", "te", "mr", "hi"]) {
      const s = sayFor("slide", loc, { n: 4, heading: "Osmosis" });
      expect(s).toContain("4");
      expect(s).toContain("Osmosis");
      expect(s).not.toContain("{");
      expect(sayFor("practise", loc, { n: 3 })).toContain("3");
    }
  });
});

// Keep the fixtures import used for the registry filter sanity check.
it("the board entries are visible to the fixture teacher (hat teacher, Board flag on)", () => {
  const ctx = makeCtx({ path: "/present" });
  for (const c of BOARD_CAPABILITIES) {
    expect(c.meta.flags?.every((f) => ctx.flags[f] === true)).toBe(true);
  }
});

describe("practise carries stamped q_ids (S1 slice C)", () => {
  it("echoes bounded string items into the move and the facts; nothing else", async () => {
    const r = await run("board.practise", { n: 2, items: ["ws:q3", "ws:q4", 7, "", "quiz:q2"] });
    expect(r.board).toEqual({ move: "practise", args: { n: 2, k: 2, segmentId: "s3", items: ["ws:q3", "ws:q4", "quiz:q2"] }, say: "2 questions for the class." });
    expect(r.facts).toEqual([{ n: 2, items: "ws:q3, ws:q4, quiz:q2" }]);
    // No items → the slice B shape exactly.
    expect((await run("board.practise", { n: 2, items: "ws:q3" })).board?.args).toEqual({ n: 2, k: 2, segmentId: "s3" });
  });
});

describe("Board UX (2026-10-28): the deck line, the rail, slides as pages", () => {
  const LOCALES = ["en", "ms", "ms-arab", "ar", "fr", "es", "pt", "te", "mr", "hi"];

  it("'skip to the PowerPoint' (slide {k:0, deck:true}) shows slide 1 and says where the deck file is", async () => {
    const r = await run("board.slide", { k: 0, deck: true });
    expect(r.ok).toBe(true);
    expect(r.board).toEqual({
      move: "slide",
      args: { k: 0, heading: "Introduction", points: [], deck: true },
      say: "The slides are the lesson's own frames — this is slide 1. The slide deck file is in the rail.",
    });
    expect(r.facts?.[0]).toMatchObject({ k: 1, deck: "download in the rail" });
    // Without `deck` the plain slide line is unchanged.
    expect((await run("board.slide", { k: 0 })).board?.say).toBe("Slide 1: Introduction.");
  });

  it("the deck line, the rail line and both load lines exist in all ten locales", () => {
    for (const l of LOCALES) {
      for (const key of ["slides", "rail", "load_slides_any"] as const) {
        const line = sayFor(key, l);
        expect(line.length).toBeGreaterThan(5);
        if (l !== "en") expect(line).not.toBe(sayFor(key, "en"));
      }
      const load = sayFor("load_slides", l, { n: 7 });
      expect(load).toContain("7");
      expect(load).not.toContain("{n}");
    }
    // ms-arab is Malay in Jawi, never the Arabic line.
    expect(sayFor("slides", "ms-arab")).not.toBe(sayFor("slides", "ar"));
  });

  it("board.rail opens (default) or closes the unit rail; no lesson map needed", async () => {
    const noMap: SkBoardState = { sessionId: "sess-1" };
    expect((await run("board.rail", {}, noMap)).board).toEqual({ move: "rail", args: { open: true }, say: "Here are the units." });
    expect((await run("board.rail", { open: false }, noMap)).board).toEqual({ move: "rail", args: { open: false }, say: "" });
    expect((await run("board.rail", {}, BOARD, "ms")).board?.say).toBe("Ini unit-unitnya.");
  });

  it("board.load_slides counts the client's segments into its line; needs the lesson map", async () => {
    const r = await run("board.load_slides");
    expect(r.ok).toBe(true);
    expect(r.board).toEqual({ move: "load_slides", args: { count: 5 }, say: "Loading 5 slides onto the roll as pages." });
    expect((await run("board.load_slides", {}, { sessionId: "sess-1", manifestId: "m" })).board).toEqual({
      move: "load_slides",
      args: {},
      say: "Loading the slides onto the roll as pages.",
    });
    expect(await run("board.load_slides", {}, { sessionId: "sess-1" })).toMatchObject({ ok: false, error: "no manifest" });
  });

  it("both new moves are immediate Board capabilities in the registry", () => {
    for (const name of ["board.rail", "board.load_slides"]) {
      expect(cap(name).meta).toMatchObject({ tier: "immediate", kind: "board", hats: ["teacher"], flags: ["board"] });
    }
  });
});
