// SK S3 slice B — the student kit player's contract and its pure logic.
//
// PURE and client-safe: no imports beyond types. The API (/api/sk/kit*) builds
// these shapes on the server (src/sk/kit-view.ts); the player component
// (src/app/sk/[product]/[chapter]/kit-player.tsx) only renders what the
// functions below decide, so the decisions are tested here, not in a browser.
//
// The moves (Final Plan §2.4, design S3 slice B):
//   segment(k)  play section k of the lesson video from its start
//   slide(k)    the section's finished slide: the video paused on its frame at
//               slide_t — or, when the kit map says the picture is not trusted
//               (`caption_only`, design decision 6), a heading-and-points card.
//               A frame is NEVER shown for a caption_only section.
//   explain     one metered model turn grounded on the section's narration
//   practise    the section's mapped bank items, marked on the server
//   what's next the deterministic next step (nextMove below) — no model

export type KitRefusal = "unknown_product" | "not_entitled" | "not_mapped" | "no_kit";

/** One kit of the chapter, for the "lessons in this chapter" picker. */
export type KitListEntry = { generationId: string; label: string | null; title: string };

export type KitVisualKind = "frame" | "fallback_frame" | "caption_only";

export type KitSegmentView = {
  /** Kit-wide 0-based index (the manifest's `k`). */
  index: number;
  /** The manifest key, "p<part>:<segment_id>" — what practise and explain name. */
  key: string;
  /** The video part this section plays in (1-based). Times are within that part. */
  part: number;
  start: number;
  end: number;
  /** The moment the section's slide is complete (the frame slide(k) shows). */
  slide_t: number;
  heading: string;
  points: string[];
  visual: {
    kind: KitVisualKind;
    /** True whenever no picture may be shown for this section. */
    caption_only: boolean;
    /** fallback_frame: the `index` of the section whose verified frame stands in. */
    fallback?: number;
  };
  /** How many practice items are mapped to this section. */
  practise: number;
};

export type KitView = {
  generationId: string;
  title: string;
  chapterRef: string;
  language: string | null;
  /** Part 1's signed URL (null when the kit has no video). */
  videoUrl: string | null;
  /** Every part, signed, in part order. */
  videos: { part: number; url: string }[];
  segments: KitSegmentView[];
};

export type KitReply =
  | { status: "ready"; kits: KitListEntry[]; kit: KitView }
  /** The kit map is being built (first open) — poll, as the Board does. */
  | { status: "preparing"; kits: KitListEntry[]; kit: { generationId: string; title: string } }
  /** The kit map could not be built; nothing is taught from it. */
  | { status: "unavailable"; kits: KitListEntry[]; kit: { generationId: string; title: string }; reason: "map_failed" };

/** A practice item as the student sees it: no answer key (quiz integrity rule 1). */
export type KitPractiseItem =
  | { id: string; type: "fill_blank" | "short" | "true_false" | "subjective"; prompt: string; marks: number }
  | { id: string; type: "mcq"; prompt: string; marks: number; options: string[] }
  | { id: string; type: "match"; prompt: string; marks: number; left: string[]; options: string[] };

export type KitGrade = { outcome: "correct" | "partial" | "incorrect" | "needs_review"; score: number; max: number; attemptNo: number; triesLeft: number };

// ── navigation ──────────────────────────────────────────────────────────────

/** Clamp an index into the section list (−1 for an empty list). */
export function clampIndex(segments: readonly KitSegmentView[], i: number): number {
  if (!segments.length) return -1;
  if (!Number.isFinite(i)) return 0;
  return Math.max(0, Math.min(segments.length - 1, Math.trunc(i)));
}

/** Previous / next section from `i`; stays put at either end. */
export function stepSection(segments: readonly KitSegmentView[], i: number, dir: -1 | 1): number {
  return clampIndex(segments, i + dir);
}

export function canStep(segments: readonly KitSegmentView[], i: number, dir: -1 | 1): boolean {
  return segments.length > 0 && stepSection(segments, i, dir) !== clampIndex(segments, i);
}

/** The section playing at time `t` of video part `part`: the one whose
 *  [start, end) holds t, else the last that has started. −1 before the first. */
export function sectionAt(segments: readonly KitSegmentView[], part: number, t: number): number {
  let best = -1;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    if (s.part !== part) continue;
    if (t >= s.start && t < s.end) return i;
    if (s.start <= t) best = i;
  }
  return best;
}

// ── the slide ───────────────────────────────────────────────────────────────

export type SlideView =
  | { kind: "frame"; part: number; t: number; fromFallback: boolean }
  | { kind: "caption"; heading: string; points: string[] };

/** What slide(k) shows. A frame only when the map trusts it (`frame`), or a
 *  verified stand-in frame in the SAME video part (`fallback_frame`); a
 *  section without a playable video for its part, or anything else, is the
 *  heading-and-points card. Never an untrusted picture (design decision 6). */
export function slideView(segments: readonly KitSegmentView[], i: number, partsWithVideo: ReadonlySet<number>): SlideView {
  const s = segments[i];
  if (!s) return { kind: "caption", heading: "", points: [] };
  const caption: SlideView = { kind: "caption", heading: s.heading, points: s.points };
  if (s.visual.caption_only || !partsWithVideo.has(s.part)) return caption;
  if (s.visual.kind === "frame") return { kind: "frame", part: s.part, t: s.slide_t, fromFallback: false };
  if (s.visual.kind === "fallback_frame" && typeof s.visual.fallback === "number") {
    const f = segments.find((x) => x.index === s.visual.fallback);
    if (f && f.part === s.part && f.visual.kind === "frame" && !f.visual.caption_only) return { kind: "frame", part: f.part, t: f.slide_t, fromFallback: true };
  }
  return caption;
}

// ── what's next ─────────────────────────────────────────────────────────────

export type NextMove = { kind: "practise"; index: number } | { kind: "watch"; index: number } | { kind: "done" };

/** The next step, deterministically: practise the section just watched if it
 *  has questions; else the first section not yet watched (the current one,
 *  then onwards, then from the start); else any section whose questions are
 *  still unpractised; else the lesson is done. */
export function nextMove(state: { segments: readonly KitSegmentView[]; current: number; watched: readonly number[]; practised: readonly number[] }): NextMove {
  const { segments } = state;
  if (!segments.length) return { kind: "done" };
  const watched = new Set(state.watched);
  const practised = new Set(state.practised);
  const cur = clampIndex(segments, state.current);
  const here = segments[cur]!;
  if (watched.has(here.index) && here.practise > 0 && !practised.has(here.index)) return { kind: "practise", index: cur };
  // The current section first (not yet watched = watch it), then onwards, then wrap.
  const order = [...segments.keys()].slice(cur).concat([...segments.keys()].slice(0, cur));
  const unwatched = order.find((i) => !watched.has(segments[i]!.index));
  if (unwatched !== undefined) return { kind: "watch", index: unwatched };
  const unpractised = order.find((i) => segments[i]!.practise > 0 && !practised.has(segments[i]!.index));
  if (unpractised !== undefined) return { kind: "practise", index: unpractised };
  return { kind: "done" };
}

/** The i18n key under sk.player for a refusal reason. */
export function refusalKey(reason: string | undefined): "refusedNotEntitled" | "refusedNotMapped" | "refusedNoKit" | "refusedUnknown" {
  if (reason === "not_entitled") return "refusedNotEntitled";
  if (reason === "not_mapped") return "refusedNotMapped";
  if (reason === "no_kit") return "refusedNoKit";
  return "refusedUnknown";
}

// ── loading (the Board's pattern: GET, one POST to build, then poll) ────────

export type KitFetchResult = { ok: true; reply: KitReply } | { ok: false; status: number; reason?: string };
export type KitFetch = (method: "GET" | "POST") => Promise<KitFetchResult>;
export type LoadKitResult = { status: "ready"; reply: Extract<KitReply, { status: "ready" }> } | { status: "refused"; reason: string | undefined } | { status: "failed"; reason: "map_failed" | "timeout" | "error" | "aborted" };

export const KIT_POLL_MS = 3000;
export const KIT_MAX_MS = 120_000;

/** Load the kit: GET; on `preparing` ask for a build ONCE (POST — the first
 *  open of a kit derives its map, about $0.005) and then poll GET every 3 s
 *  for at most 2 min. `onPreparing` drives the "getting the lesson ready" line. */
export async function loadKit(
  fetchKit: KitFetch,
  opts: { pollMs?: number; maxMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number; onPreparing?: (reply: Extract<KitReply, { status: "preparing" }>) => void; signal?: AbortSignal } = {},
): Promise<LoadKitResult> {
  const pollMs = opts.pollMs ?? KIT_POLL_MS;
  const maxMs = opts.maxMs ?? KIT_MAX_MS;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const t0 = now();
  let method: "GET" | "POST" = "GET";
  let requested = false;
  for (;;) {
    if (opts.signal?.aborted) return { status: "failed", reason: "aborted" };
    let res: KitFetchResult;
    try {
      res = await fetchKit(method);
    } catch {
      return { status: "failed", reason: "error" };
    }
    method = "GET";
    if (!res.ok) return res.status === 403 || res.status === 404 ? { status: "refused", reason: res.reason } : { status: "failed", reason: "error" };
    const reply = res.reply;
    if (reply.status === "ready") return { status: "ready", reply };
    if (reply.status === "unavailable") return { status: "failed", reason: "map_failed" };
    opts.onPreparing?.(reply);
    if (!requested) {
      requested = true;
      method = "POST";
      continue;
    }
    if (now() - t0 >= maxMs) return { status: "failed", reason: "timeout" };
    await sleep(pollMs);
  }
}

/** The text and done events of an SSE body (the kit turn's reply). */
export function parseSse(body: string): { event: string; data: unknown }[] {
  return body
    .split("\n\n")
    .filter((c) => c.trim())
    .flatMap((chunk) => {
      const ev = /^event: (.*)$/m.exec(chunk)?.[1];
      const data = chunk
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .join("\n");
      if (!ev) return [];
      try {
        return [{ event: ev, data: JSON.parse(data) as unknown }];
      } catch {
        return [];
      }
    });
}
