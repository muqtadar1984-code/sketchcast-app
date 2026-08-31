import { describe, it, expect } from "vitest";
import {
  chaptersShown,
  conceptList,
  clip,
  buildGround,
  violations,
  cleanRecap,
  fallbackRecap,
  recapPrompt,
  MAX_CHAPTERS,
  MAX_CHARS,
  type RecapItem,
  type ChapterFacts,
  type RecapGround,
} from "@/utils/present/recap";

const item = (over: Partial<RecapItem> = {}): RecapItem => ({
  kind: "video",
  chapterNum: 3,
  part: 1,
  ...over,
});

describe("what the lesson was actually about", () => {
  it("takes the chapters from what she SHOWED, in the order she opened them", () => {
    const { chapters } = chaptersShown([
      item({ chapterNum: 7, part: 2 }),
      item({ chapterNum: 3, part: 1, kind: "worksheet" }),
      item({ chapterNum: 7, part: 3 }),
    ]);
    expect(chapters.map((c) => c.chapterNum)).toEqual([7, 3]);
    expect(chapters[0].parts).toEqual([2, 3]);
  });

  it("COUNTS A CUMULATIVE PAPER AS REVISION rather than dropping it", () => {
    // A worksheet spanning chapters 1-5 has no chapter of its own. Dropping it
    // would make a revision lesson read as if nothing happened; inventing a
    // chapter for it would be worse.
    const { chapters, revision } = chaptersShown([item({ chapterNum: null, kind: "worksheet" })]);
    expect(chapters).toEqual([]);
    expect(revision).toBe(true);
  });

  it("ignores a blank board — pushing paper is not teaching a chapter", () => {
    const { chapters, revision } = chaptersShown([item({ kind: "blank", chapterNum: null })]);
    expect(chapters).toEqual([]);
    expect(revision).toBe(false);
  });

  it("caps at six chapters and says the lesson ranged wider", () => {
    const many = Array.from({ length: 9 }, (_, i) => item({ chapterNum: i }));
    const { chapters, revision } = chaptersShown(many);
    expect(chapters).toHaveLength(MAX_CHAPTERS);
    expect(revision).toBe(true);
  });

  it("keeps parts sorted and distinct however she jumped around", () => {
    const { chapters } = chaptersShown([
      item({ part: 3 }),
      item({ part: 1 }),
      item({ part: 3 }),
      item({ part: 0 }), // 0 is not a part — partOf rejects it everywhere else too
    ]);
    expect(chapters[0].parts).toEqual([1, 3]);
  });
});

describe("reading concepts out of jsonb written by somebody else", () => {
  it("accepts a list of strings, a list of objects, and an object of keys", () => {
    expect(conceptList(["osmosis", "diffusion"])).toEqual(["osmosis", "diffusion"]);
    expect(conceptList([{ name: "osmosis" }, { title: "diffusion" }, { concept: "turgor" }])).toEqual(
      ["osmosis", "diffusion", "turgor"],
    );
    expect(conceptList({ osmosis: 1, diffusion: 2 })).toEqual(["osmosis", "diffusion"]);
  });

  it("CONTRIBUTES NOTHING rather than throwing on a shape it does not know", () => {
    // The worker's analysis pass has changed this column's shape before, and a
    // recap that 500s because of it would be a lesson note lost to a schema
    // detail the teacher cannot see.
    expect(conceptList(null)).toEqual([]);
    expect(conceptList("just a string")).toEqual([]);
    expect(conceptList(42)).toEqual([]);
    expect(conceptList([1, 2, { nope: "x" }])).toEqual([]);
  });

  it("drops duplicates and anything absurdly long", () => {
    expect(conceptList(["a", "a", "b"])).toEqual(["a", "b"]);
    expect(conceptList(["x".repeat(200)])).toEqual([]);
  });
});

describe("clipping evidence to a budget", () => {
  it("collapses whitespace and cuts on a word boundary", () => {
    expect(clip("  a   b \n c ", 100)).toBe("a b c");
    expect(clip("alpha beta gamma delta", 12)).toBe("alpha beta");
  });

  it("still cuts when there is no boundary to cut on", () => {
    expect(clip("x".repeat(50), 10)).toHaveLength(10);
  });
});

describe("assembling the grounding", () => {
  const facts: ChapterFacts[] = [
    { chapterNum: 3, title: "Ecosystems", concepts: ["food web"], sourceText: "raw book text" },
    { chapterNum: 7, title: null, scriptText: "narration for seven", sourceText: "book seven" },
  ];

  it("renders chapter numbers +1, because chapter_ref is 0-based", () => {
    const g = buildGround([item({ chapterNum: 3 })], facts, 4);
    expect(g.chapters[0].label).toBe("Chapter 4");
  });

  it("PREFERS NARRATION over book text — one was said out loud, the other was merely available", () => {
    const g = buildGround([item({ chapterNum: 7 })], facts, 1);
    expect(g.chapters[0].evidence).toBe("narration for seven");
  });

  it("falls back to book text, which in practice is the only one that is there", () => {
    const g = buildGround([item({ chapterNum: 3 })], facts, 1);
    expect(g.chapters[0].evidence).toBe("raw book text");
  });

  it("keeps a chapter it knows nothing about, rather than dropping the lesson", () => {
    const g = buildGround([item({ chapterNum: 99 })], facts, 1);
    expect(g.chapters).toHaveLength(1);
    expect(g.chapters[0]).toMatchObject({ label: "Chapter 100", title: null, evidence: "" });
  });

  it("never reports fewer than one page", () => {
    expect(buildGround([], facts, 0).pages).toBe(1);
    expect(buildGround([], facts, Number.NaN).pages).toBe(1);
  });
});

describe("the machinery the note may never name", () => {
  it("REJECTS the brief's own example sentence", () => {
    // "described in terms of the concept, never 'played the video'".
    expect(cleanRecap("We played the video on cells and did the worksheet.").ok).toBe(false);
  });

  it("names what it objected to, so a retry can be told what to fix", () => {
    const v = violations("We watched the video, then the worksheet on the whiteboard.");
    expect(v).toContain("it names the lesson's materials");
    expect(v).toContain("it names the worksheet");
    expect(v).toContain("it names the board");
  });

  it("catches the delivery nouns wherever they carry a determiner", () => {
    for (const bad of [
      "We opened the video.",
      "The class finished a worksheet.",
      "Notes came from the slides.",
      "It was on the board.",
      "Marks came from the test paper.",
      "She followed the lesson plan.",
      "It ran on a screen at the front.",
      "Built with SketchCast.",
    ]) {
      expect(violations(bad).length, bad).toBeGreaterThan(0);
    }
  });

  it("catches the verbs when they act on the machinery", () => {
    for (const bad of [
      "We played the video.",
      "The teacher showed a presentation.",
      "She projected the slides.",
      "The class watched a film.",
    ]) {
      expect(violations(bad).length, bad).toBeGreaterThan(0);
    }
  });

  it("DOES NOT REJECT ORDINARY SCIENCE, which a bare word list did", () => {
    // Each of these was refused by the first version of the ban, and each is the
    // most natural sentence for its concept. A false rejection costs a retry and
    // then hands her the generic fallback — so the ban is about the lesson's
    // machinery, not about vocabulary that happens to overlap with it.
    for (const good of [
      "Worked out why a block slides more easily on a smooth surface.",
      "Traced how current flows around a circuit board.",
      "Looked at the part enzymes play in digestion.",
      "The experiment showed that gas expands when heated.",
      "Compared projected population growth against the recorded figures.",
      "Practised how to play a scale in two octaves.",
    ]) {
      expect(violations(good), good).toEqual([]);
    }
  });

  it("still over-fires on a determiner + a delivery noun used innocently", () => {
    // Pinned as a KNOWN residual rather than left to be discovered. "a screen of
    // trees" is the shape the heuristic cannot separate from "on a screen", and
    // the cost is bounded and one-directional: one retry, then the fallback
    // sentence. Tightening it further would start letting "on the screen"
    // through, which is the failure that actually matters.
    expect(violations("Explored how a screen of trees slows the wind.")).not.toEqual([]);
  });

  it("ACCEPTS a sentence about the concept", () => {
    const r = cleanRecap("Looked at how a plant cell differs from an animal cell.");
    expect(r).toEqual({ ok: true, text: "Looked at how a plant cell differs from an animal cell." });
  });

  it("JUDGES THE TEXT THAT WOULD BE PUBLISHED, not the raw answer", () => {
    // A third sentence is cut, so a banned word only in that third sentence
    // never reaches anybody and must not condemn the two that survive.
    expect(
      cleanRecap("Explored magnetism. Compared iron and copper. Then we played the video."),
    ).toEqual({ ok: true, text: "Explored magnetism. Compared iron and copper." });
  });
});

describe("tidying what the model returned", () => {
  it("strips markdown, a self-announcing prefix and wrapping quotes before judging", () => {
    // None of these is a broken rule, and rejecting them would spend a retry on
    // punctuation.
    expect(cleanRecap('**Recap:** "Explored how magnets attract iron."')).toEqual({
      ok: true,
      text: "Explored how magnets attract iron.",
    });
  });

  it("CUTS a third sentence rather than rejecting it", () => {
    // A generous model has not broken the rule; the first two sentences are
    // still the note.
    const r = cleanRecap("One thing. Two things. Three things.");
    expect(r).toEqual({ ok: true, text: "One thing. Two things." });
  });

  it("adds the full stop a model left off", () => {
    expect(cleanRecap("Explored magnetism")).toEqual({ ok: true, text: "Explored magnetism." });
  });

  it("caps the length and marks that it was cut", () => {
    const r = cleanRecap(`${"word ".repeat(200)}end.`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text.length).toBeLessThanOrEqual(MAX_CHARS);
      expect(r.text.endsWith("…")).toBe(true);
    }
  });

  it("refuses an empty answer and refuses a refusal", () => {
    expect(cleanRecap("   ")).toEqual({ ok: false, reason: "it was empty" });
    expect(cleanRecap("I cannot write that.").ok).toBe(false);
    expect(cleanRecap("Sorry, there is not enough information.").ok).toBe(false);
  });
});

describe("the note she gets when the model does not answer", () => {
  const ground = (over: Partial<RecapGround> = {}): RecapGround => ({
    chapters: [
      { chapterNum: 3, label: "Chapter 4", title: "Ecosystems", parts: [1], concepts: [], evidence: "" },
    ],
    revision: false,
    pages: 2,
    ...over,
  });

  it("IS A REAL SENTENCE, not an apology — she has thirty seconds between periods", () => {
    expect(fallbackRecap(ground())).toBe("Worked through Ecosystems.");
  });

  it("obeys the same ban it was written to survive", () => {
    expect(violations(fallbackRecap(ground()))).toEqual([]);
    expect(violations(fallbackRecap(ground({ revision: true })))).toEqual([]);
  });

  it("names the concepts when the grounding has them", () => {
    const g = ground();
    g.chapters[0].concepts = ["food webs", "producers", "decomposers", "energy"];
    expect(fallbackRecap(g)).toBe(
      "Worked through Ecosystems. Focused on food webs, producers, decomposers.",
    );
  });

  it("lists several chapters readably and says when it was revision", () => {
    const g = ground({
      revision: true,
      chapters: [
        { chapterNum: 0, label: "Chapter 1", title: "Cells", parts: [], concepts: [], evidence: "" },
        { chapterNum: 1, label: "Chapter 2", title: null, parts: [], concepts: [], evidence: "" },
      ],
    });
    expect(fallbackRecap(g)).toBe("Revision covering Cells and Chapter 2.");
  });

  it("still says something when it knows nothing at all", () => {
    expect(fallbackRecap(ground({ chapters: [] }))).toBe("Worked through the class's current topic.");
    expect(fallbackRecap(ground({ chapters: [], revision: true }))).toBe(
      "Revision across several chapters.",
    );
  });
});

describe("the prompt", () => {
  const g: RecapGround = {
    chapters: [
      {
        chapterNum: 3,
        label: "Chapter 4",
        title: "Ecosystems",
        parts: [1, 2],
        concepts: ["food web"],
        evidence: "Producers make their own food.",
      },
    ],
    revision: true,
    pages: 3,
  };

  it("keeps the instructions byte-identical between lessons, so the prefix can be cached", () => {
    const a = recapPrompt(g);
    const b = recapPrompt({ ...g, chapters: [], revision: false });
    expect(a.instructions).toBe(b.instructions);
  });

  it("puts the banned words IN the instructions as well as in the checker", () => {
    // The check is the guarantee; the prompt is what makes the check rarely fire.
    const { instructions } = recapPrompt(g);
    for (const w of ["video", "worksheet", "slides", "board", "watched", "played"]) {
      expect(instructions).toContain(w);
    }
  });

  it("carries the chapter, its parts, its ideas and its evidence", () => {
    const { context } = recapPrompt(g);
    expect(context).toContain("Chapter 4: Ecosystems");
    expect(context).toContain("(parts 1, 2)");
    expect(context).toContain("Key ideas: food web");
    expect(context).toContain("Producers make their own food.");
    expect(context).toContain("revision material");
  });

  it("SAYS SO when there is no material, rather than sending an empty context", () => {
    // An empty context invites invention, which rule 4 forbids. Naming the
    // absence is what makes "stay general" a followable instruction.
    const { context } = recapPrompt({ chapters: [], revision: false, pages: 1 });
    expect(context).toContain("No chapter material is available");
  });
});
