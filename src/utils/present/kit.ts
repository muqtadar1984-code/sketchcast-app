// What the kit rail may offer, and — more importantly — what it may not.
//
// Pure: takes generation rows and returns a decision. No Supabase, no signing,
// no React. The route above it does the fetching and the URL signing; the rules
// live here because they are the part worth testing and the part that must not
// drift.
//
// ONE PREDICATE DECIDES WHAT REACHES THE BOARD, and it excludes the assessment
// kinds BY KIND rather than by missing data. `exam_paper` has a perfectly good
// questions.json — the worker writes one for it (worker/process.py) — and we are
// choosing not to use it, because a paper the class has watched on the board is
// no longer a test. Excluding it for the reason that happens to be convenient
// would be an exclusion that quietly disappears the day the data changes.

/** The shape of a generation row, as far as this module is concerned. */
export type KitArtifact = { kind: string; storage_path: string };
export type KitGeneration = {
  id: string;
  kind: string;
  title: string | null;
  chapter_ref: string | null;
  params: Record<string, unknown> | null;
  artifacts: KitArtifact[];
};

/** Where a generation sits in the book. */
export type Scope =
  | { kind: "part"; chapter: number; part: number }
  | { kind: "chapter"; chapter: number }
  | { kind: "chapters"; chapters: number[] }
  | { kind: "book" };

export const partOf = (g: KitGeneration): number | null => {
  const p = g.params?.part;
  return typeof p === "number" && p >= 1 ? p : null;
};

export const chapterOf = (g: KitGeneration): number | null => {
  if (g.chapter_ref === null) return null;
  const n = Number(g.chapter_ref);
  return Number.isInteger(n) ? n : null;
};

/** Revision papers (0061) — free, standalone, and possibly cumulative. */
export const isRevision = (g: KitGeneration): boolean => g.params?.revision === true;

export function scopeOf(g: KitGeneration): Scope {
  const chapters = g.params?.chapters;
  if (Array.isArray(chapters) && chapters.length) {
    return { kind: "chapters", chapters: chapters.filter((n): n is number => typeof n === "number") };
  }
  const chapter = chapterOf(g);
  if (chapter === null) return { kind: "book" };
  const part = partOf(g);
  return part === null ? { kind: "chapter", chapter } : { kind: "part", chapter, part };
}

export const hasArtifact = (g: KitGeneration, kind: string): boolean =>
  g.artifacts.some((a) => a.kind === kind);

/**
 * MAY THIS GO ON THE BOARD?
 *
 * `kind === 'worksheet'` AND it carries structured questions. That single rule
 * admits all three worksheet flavours — the part's own, a per-chapter revision
 * paper, and a cumulative one spanning a chapter group — and excludes both
 * assessment kinds by kind, on principle rather than on capability.
 */
export function boardEligible(g: KitGeneration): boolean {
  return g.kind === "worksheet" && hasArtifact(g, "questions_json");
}

/** Kinds that must never be projected, whatever data they carry. */
export const NEVER_PROJECT = new Set(["exam_paper", "exam"]);

/**
 * Where a worksheet belongs in the picker.
 *
 * Grouped the way she thinks about them rather than by database shape: what is
 * on this screen, what is elsewhere in this chapter, what is elsewhere in this
 * book, and the revision papers, which are a different KIND of thing rather than
 * a different location.
 */
export type PickerGroup = "this-part" | "this-chapter" | "this-book" | "revision";

export function groupOf(
  g: KitGeneration,
  here: { chapter: number | null; part: number | null },
): PickerGroup {
  if (isRevision(g)) return "revision";
  const s = scopeOf(g);
  if (s.kind === "chapters" || s.kind === "book") return "revision";
  if (s.chapter !== here.chapter) return "this-book";
  if (s.kind === "part" && s.part === here.part) return "this-part";
  if (s.kind === "chapter" && here.part === null) return "this-part";
  return "this-chapter";
}

export const GROUP_ORDER: PickerGroup[] = ["this-part", "this-chapter", "this-book", "revision"];

// ── the rail for one part ────────────────────────────────────────────────────

/**
 * WHAT it is and WHETHER it projects — never the words for either.
 *
 * This module ran on the server and composed English: a `label` from a kind and
 * a sentence explaining why a test paper only downloads. Both are now keys the
 * UI renders in the reader's own language, because the board reaches ten
 * locales and a rail labelled "Worksheet" in the middle of a Malay page is the
 * kind of half-translation nobody files a bug about.
 */
export type RailDoc = {
  id: string;
  kind: string;
  /** True when tapping it projects; false when it only downloads. */
  projects: boolean;
  /** WHY it does not project, when it does not. A reason, not a sentence. */
  note?: "never-project" | "no-text";
};

export type RailUnit = {
  /** null = a kit generated for the whole chapter rather than a part of it. */
  part: number | null;
  /** How many parts this chapter has kits for, so the UI can say "1 of 4". */
  total: number;
  video: { id: string; title: string | null } | null;
  docs: RailDoc[];
};

function docFor(g: KitGeneration): RailDoc {
  if (NEVER_PROJECT.has(g.kind)) {
    return { id: g.id, kind: g.kind, projects: false, note: "never-project" };
  }
  if (boardEligible(g)) return { id: g.id, kind: g.kind, projects: true };
  return { id: g.id, kind: g.kind, projects: false, note: "no-text" };
}

/**
 * Everything generated for this chapter, grouped by the unit it belongs to.
 *
 * NOT FILTERED TO ONE PART. A chapter is split into parts at index time and
 * every kit is generated per part, so asking for "the chapter's kit" and
 * matching only part-less generations finds nothing at all — the rail reads
 * "nothing generated yet" while sitting on a full set. And a teacher should not
 * have to declare which part she is about to teach before she can see what
 * exists; she opens the chapter and the rail shows what is there.
 *
 * Chapter-level kits (a chapter that was never split) come first, then parts in
 * order. Revision papers are deliberately absent — they belong to the picker,
 * because they are a different KIND of thing rather than a place in the book.
 */
export function railFor(gens: KitGeneration[], here: { chapter: number }): RailUnit[] {
  const mine = gens.filter((g) => {
    if (isRevision(g)) return false;
    const s = scopeOf(g);
    return (s.kind === "part" || s.kind === "chapter") && s.chapter === here.chapter;
  });

  const byPart = new Map<number | null, KitGeneration[]>();
  for (const g of mine) {
    const s = scopeOf(g);
    const key = s.kind === "part" ? s.part : null;
    const list = byPart.get(key);
    if (list) list.push(g);
    else byPart.set(key, [g]);
  }

  const parts = [...byPart.keys()].sort((a, b) => (a ?? 0) - (b ?? 0));
  const total = parts.filter((p) => p !== null).length;

  return parts.map((part) => {
    const group = byPart.get(part)!;
    const vid = group.find((g) => g.kind === "presentation" && hasArtifact(g, "video_mp4")) ?? null;
    return {
      part,
      total,
      video: vid ? { id: vid.id, title: vid.title } : null,
      docs: group
        .filter((g) => g.kind !== "presentation")
        .map(docFor)
        // What projects goes first: it is the one that reaches the board. Then
        // by KIND rather than by label — the label is a translation now, and
        // sorting on it would reorder the rail per language.
        .sort((a, b) => Number(b.projects) - Number(a.projects) || a.kind.localeCompare(b.kind)),
    };
  });
}

export type PickerItem = {
  id: string;
  /** Where it sits, for the UI to render as "Chapter 4 · Part 2". Structured
   *  rather than composed, for the same reason RailDoc lost its label. */
  scope: Scope;
  title: string | null;
  /**
   * WHERE IT ACTUALLY SITS, carried so the item recorded when she projects it can
   * be truthful. Stamping the session's own chapter onto whatever she opened
   * would make a cumulative revision paper look like progress through the
   * chapter she is teaching, and moving the class's pointer on that is the one
   * mistake the pointer rule exists to prevent.
   */
  chapter: number | null;
  part: number | null;
};

/** Every worksheet in this book that may reach the board, grouped for the picker. */
export function pickerFor(
  gens: KitGeneration[],
  here: { chapter: number | null; part: number | null },
): { group: PickerGroup; items: PickerItem[] }[] {
  const eligible = gens.filter(boardEligible);
  const out = GROUP_ORDER.map((group) => ({
    group,
    items: eligible
      .filter((g) => groupOf(g, here) === group)
      .map((g) => {
        const s = scopeOf(g);
        return {
          id: g.id,
          scope: s,
          title: g.title,
          // A cumulative paper spans chapters, so it sits in NO chapter — null,
          // which is exactly what advancesPointer refuses.
          chapter: s.kind === "part" || s.kind === "chapter" ? s.chapter : null,
          part: s.kind === "part" ? s.part : null,
        };
      }),
  }));
  return out.filter((g) => g.items.length > 0);
}
