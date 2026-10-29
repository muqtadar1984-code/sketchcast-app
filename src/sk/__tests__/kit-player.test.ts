// SK S3 slice B — the student kit player's pure logic (src/sk/kit-player.ts)
// and the manifest → player view (src/sk/kit-view.ts): section navigation, the
// slide (a trusted frame or the caption card — never an untrusted picture),
// the "what's next" choice, the load/poll sequence and the chapter list.
import { describe, expect, it } from "vitest";
import { canStep, clampIndex, loadKit, nextMove, parseSse, refusalKey, sectionAt, slideView, stepSection, type KitFetchResult, type KitReply, type KitSegmentView } from "../kit-player";
import { kitItemIds, kitSegments, kitView, mergeChapters, practiseItemIds } from "../kit-view";
import type { ProductKit } from "../product-kits";
import { CELLS, ITEM_MCQ, ITEM_OFFMAP, ITEM_TF, kitManifest } from "./kit-fixtures";

const segments = (): KitSegmentView[] => kitSegments(kitManifest());
const BOTH = new Set([1, 2]);

describe("kitSegments: what leaves the server", () => {
  it("one view per section in kit order, with the part-local times and no narration", () => {
    const s = segments();
    expect(s.map((x) => [x.index, x.key, x.part, x.start, x.end, x.slide_t])).toEqual([
      [0, "p1:s001", 1, 0, 10, 9],
      [1, "p1:s002", 1, 10, 20, 19],
      [2, "p1:s003", 1, 20, 30, 29],
      [3, "p2:s004", 2, 0, 10, 9],
    ]);
    expect(JSON.stringify(s)).not.toContain("smallest unit of life. Every");
  });
  it("passes caption_only through untouched, and every other verdict as its kind", () => {
    const s = segments();
    expect(s[0]!.visual).toEqual({ kind: "frame", caption_only: false });
    expect(s[1]!.visual).toEqual({ kind: "caption_only", caption_only: true });
    expect(s[2]!.visual).toEqual({ kind: "fallback_frame", caption_only: false, fallback: 0 });
  });
  it("counts only available, bank-traced items per section", () => {
    const m = kitManifest();
    expect(practiseItemIds(m, "p1:s001")).toEqual([ITEM_MCQ, ITEM_TF]);
    expect(practiseItemIds(m, "p1:s002")).toEqual([]); // worksheet item without a bank trace
    expect(practiseItemIds(m, "p1:s003")).toEqual([]); // unavailable mapping is never used
    expect(segments().map((s) => s.practise)).toEqual([2, 0, 0, 0]);
    expect([...kitItemIds(m)].sort()).toEqual([ITEM_MCQ, ITEM_TF].sort());
    expect(kitItemIds(m).has(ITEM_OFFMAP)).toBe(false);
  });
  it("kitView: part 1's URL is the videoUrl whatever order the parts arrive in", () => {
    const kit: ProductKit = { chapterRef: "1", sort: 0, generationId: CELLS, label: null, title: "Cells" };
    const v = kitView(kitManifest(), kit, [{ part: 1, url: "u1" }, { part: 2, url: "u2" }]);
    expect(v.videoUrl).toBe("u1");
    expect(kitView(kitManifest(), kit, []).videoUrl).toBeNull();
  });
});

describe("section navigation", () => {
  it("previous / next stay inside the list", () => {
    const s = segments();
    expect(stepSection(s, 0, -1)).toBe(0);
    expect(stepSection(s, 0, 1)).toBe(1);
    expect(stepSection(s, 3, 1)).toBe(3);
    expect(canStep(s, 0, -1)).toBe(false);
    expect(canStep(s, 0, 1)).toBe(true);
    expect(canStep(s, 3, 1)).toBe(false);
    expect(clampIndex(s, 99)).toBe(3);
    expect(clampIndex([], 2)).toBe(-1);
  });
  it("sectionAt reads the playing section from the part and the time", () => {
    const s = segments();
    expect(sectionAt(s, 1, 0)).toBe(0);
    expect(sectionAt(s, 1, 15)).toBe(1);
    expect(sectionAt(s, 1, 29.9)).toBe(2);
    expect(sectionAt(s, 1, 31)).toBe(2); // past the last end: the last that started
    expect(sectionAt(s, 2, 4)).toBe(3); // part 2's own clock
    expect(sectionAt(s, 3, 4)).toBe(-1);
  });
});

describe("slideView: a frame only when trusted, otherwise the caption card", () => {
  it("a trusted frame pauses on its own slide_t", () => {
    expect(slideView(segments(), 0, BOTH)).toEqual({ kind: "frame", part: 1, t: 9, fromFallback: false });
  });
  it("caption_only is ALWAYS the heading-and-points card (design decision 6)", () => {
    expect(slideView(segments(), 1, BOTH)).toEqual({ kind: "caption", heading: "Plant and animal cells", points: ["Plant cells have a wall", "Animal cells have none"] });
  });
  it("a fallback frame in the same part shows the verified frame", () => {
    expect(slideView(segments(), 2, BOTH)).toEqual({ kind: "frame", part: 1, t: 9, fromFallback: true });
  });
  it("a fallback frame in ANOTHER part degrades to the card (this video cannot show it)", () => {
    expect(slideView(segments(), 3, BOTH)).toMatchObject({ kind: "caption", heading: "Cell membrane" });
  });
  it("no video for the section's part: the card, even for a trusted frame", () => {
    expect(slideView(segments(), 0, new Set([2]))).toMatchObject({ kind: "caption", heading: "What is a cell?" });
  });
  it("a fallback that points at a caption_only section is the card", () => {
    const s = segments();
    s[2] = { ...s[2]!, visual: { kind: "fallback_frame", caption_only: false, fallback: 1 } };
    expect(slideView(s, 2, BOTH).kind).toBe("caption");
  });
});

describe("nextMove: what's next, deterministically", () => {
  it("starts with the first section", () => {
    expect(nextMove({ segments: segments(), current: 0, watched: [], practised: [] })).toEqual({ kind: "watch", index: 0 });
  });
  it("after watching a section with questions: practise it", () => {
    expect(nextMove({ segments: segments(), current: 0, watched: [0], practised: [] })).toEqual({ kind: "practise", index: 0 });
  });
  it("after practising: the next unwatched section", () => {
    expect(nextMove({ segments: segments(), current: 0, watched: [0], practised: [0] })).toEqual({ kind: "watch", index: 1 });
  });
  it("a section without questions moves straight on", () => {
    expect(nextMove({ segments: segments(), current: 1, watched: [0, 1], practised: [0] })).toEqual({ kind: "watch", index: 2 });
  });
  it("wraps to an earlier unwatched section, then to unpractised questions, then done", () => {
    expect(nextMove({ segments: segments(), current: 3, watched: [1, 2, 3], practised: [] })).toEqual({ kind: "watch", index: 0 });
    expect(nextMove({ segments: segments(), current: 3, watched: [0, 1, 2, 3], practised: [] })).toEqual({ kind: "practise", index: 0 });
    expect(nextMove({ segments: segments(), current: 3, watched: [0, 1, 2, 3], practised: [0] })).toEqual({ kind: "done" });
  });
  it("an empty kit is done", () => {
    expect(nextMove({ segments: [], current: 0, watched: [], practised: [] })).toEqual({ kind: "done" });
  });
});

describe("loadKit: GET, one POST to build, then poll", () => {
  const head = { kits: [{ generationId: CELLS, label: null, title: "Cells" }], kit: { generationId: CELLS, title: "Cells" } };
  const ready: KitReply = { status: "ready", kits: head.kits, kit: { generationId: CELLS, title: "Cells", chapterRef: "1", language: "en", videoUrl: null, videos: [], segments: [] } };
  const preparing: KitReply = { status: "preparing", ...head };

  it("preparing → asks for the build ONCE → polls until ready", async () => {
    const replies: KitFetchResult[] = [
      { ok: true, reply: preparing },
      { ok: true, reply: preparing },
      { ok: true, reply: preparing },
      { ok: true, reply: ready },
    ];
    const calls: string[] = [];
    let preparingSeen = 0;
    const r = await loadKit(
      async (m) => {
        calls.push(m);
        return replies.shift()!;
      },
      { sleep: async () => {}, onPreparing: () => preparingSeen++ },
    );
    expect(r.status).toBe("ready");
    expect(calls).toEqual(["GET", "POST", "GET", "GET"]);
    expect(preparingSeen).toBe(3);
  });
  it("a refusal (403/404) carries its reason; a map failure is map_failed", async () => {
    expect(await loadKit(async () => ({ ok: false, status: 403, reason: "not_entitled" }))).toEqual({ status: "refused", reason: "not_entitled" });
    expect(await loadKit(async () => ({ ok: true, reply: { status: "unavailable", ...head, reason: "map_failed" } }))).toEqual({ status: "failed", reason: "map_failed" });
    expect(await loadKit(async () => ({ ok: false, status: 500 }))).toEqual({ status: "failed", reason: "error" });
  });
  it("gives up after the time limit", async () => {
    let t = 0;
    const r = await loadKit(async () => ({ ok: true, reply: preparing }), { sleep: async (ms) => void (t += ms), now: () => t, maxMs: 9000, pollMs: 3000 });
    expect(r).toEqual({ status: "failed", reason: "timeout" });
  });
  it("refusalKey maps every reason to a string key", () => {
    expect(refusalKey("not_entitled")).toBe("refusedNotEntitled");
    expect(refusalKey("not_mapped")).toBe("refusedNotMapped");
    expect(refusalKey("no_kit")).toBe("refusedNoKit");
    expect(refusalKey(undefined)).toBe("refusedUnknown");
  });
  it("parseSse reads the kit turn's frames", () => {
    const body = 'event: meta\ndata: {"move":"explain"}\n\nevent: text\ndata: "A cell is small."\n\nevent: done\ndata: {"label":"grounded"}\n\n';
    expect(parseSse(body)).toEqual([
      { event: "meta", data: { move: "explain" } },
      { event: "text", data: "A cell is small." },
      { event: "done", data: { label: "grounded" } },
    ]);
  });
});

describe("mergeChapters: the chapter list", () => {
  const k = (chapterRef: string, sort: number, generationId: string, title: string): ProductKit => ({ chapterRef, sort, generationId, label: null, title });
  it("kit chapters with their kits, in chapter order; nothing else is listed", () => {
    const out = mergeChapters([k("10", 0, "e", "Ten"), k("1", 0, "a", "Cells"), k("8", 0, "b", "Blood"), k("8", 1, "c", "Resp"), k("8", 2, "d", "Transport")]);
    expect(out.map((c) => [c.chapterRef, c.kits.map((x) => x.title)])).toEqual([
      ["1", ["Cells"]],
      ["8", ["Blood", "Resp", "Transport"]],
      ["10", ["Ten"]],
    ]);
    expect(mergeChapters([])).toEqual([]);
  });
});
