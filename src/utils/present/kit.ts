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
export const GROUP_LABEL: Record<PickerGroup, string> = {
  "this-part": "This part",
  "this-chapter": "This chapter",
  "this-book": "Elsewhere in this book",
  revision: "Revision papers",
};

/** A human label for a worksheet in the picker. Falls back to the stored title,
 *  which the worker already composes to carry the chapter name and part. */
export function scopeLabel(g: KitGeneration): string {
  const s = scopeOf(g);
  switch (s.kind) {
    case "part":
      // chapter_ref is 0-based in the database and rendered +1 everywhere.
      return `Chapter ${s.chapter + 1} · Part ${s.part}`;
    case "chapter":
      return `Chapter ${s.chapter + 1}`;
    case "chapters": {
      const nums = [...s.chapters].sort((a, b) => a - b).map((n) => n + 1);
      return nums.length > 3
        ? `Chapters ${nums[0]}–${nums[nums.length - 1]}`
        : `Chapters ${nums.join(", ")}`;
    }
    default:
      return g.title ?? "Worksheet";
  }
}

// ── the rail for one part ────────────────────────────────────────────────────

export type RailDoc = {
  id: string;
  kind: string;
  label: string;
  /** True when tapping it projects; false when it only downloads. */
  projects: boolean;
  /** Why it does not project, when it does not. Shown to her, not swallowed. */
  note?: string;
};

const DOC_LABEL: Record<string, string> = {
  presentation: "Video",
  worksheet: "Worksheet",
  lesson_plan: "Lesson plan",
  activity: "Activity",
  case_study: "Case study",
  exam_paper: "Test paper",
  exam: "Exam",
};

/**
 * The kit for the part she is teaching.
 *
 * A test paper is INCLUDED and marked as download-only rather than hidden. She
 * generated it and she knows it exists; a rail that silently omitted it would
 * read as a bug, and she would go looking. Saying "download only — projecting it
 * would spend the paper" is the honest version, and it teaches the rule once
 * instead of hiding it for ever.
 */
export function railFor(
  gens: KitGeneration[],
  here: { chapter: number; part: number | null },
): { video: KitGeneration | null; docs: RailDoc[] } {
  const mine = gens.filter((g) => {
    if (isRevision(g)) return false;
    const s = scopeOf(g);
    if (s.kind !== "part" && s.kind !== "chapter") return false;
    if (s.chapter !== here.chapter) return false;
    return s.kind === "part" ? s.part === here.part : here.part === null || here.part === 1;
  });

  const video = mine.find((g) => g.kind === "presentation" && hasArtifact(g, "video_mp4")) ?? null;

  const docs: RailDoc[] = mine
    .filter((g) => g.kind !== "presentation")
    .map((g) => {
      if (NEVER_PROJECT.has(g.kind)) {
        return {
          id: g.id,
          kind: g.kind,
          label: DOC_LABEL[g.kind] ?? g.kind,
          projects: false,
          note: "Download only — a paper the class has watched is no longer a test",
        };
      }
      if (boardEligible(g)) {
        return { id: g.id, kind: g.kind, label: DOC_LABEL[g.kind] ?? g.kind, projects: true };
      }
      return {
        id: g.id,
        kind: g.kind,
        label: DOC_LABEL[g.kind] ?? g.kind,
        projects: false,
        note: "Download only — this kind has no structured text to put on a board",
      };
    })
    // Worksheet first: it is the one that goes on the board.
    .sort((a, b) => Number(b.projects) - Number(a.projects) || a.label.localeCompare(b.label));

  return { video, docs };
}

/** Every worksheet in this book that may reach the board, grouped for the picker. */
export function pickerFor(
  gens: KitGeneration[],
  here: { chapter: number | null; part: number | null },
): { group: PickerGroup; items: { id: string; label: string; title: string | null }[] }[] {
  const eligible = gens.filter(boardEligible);
  const out = GROUP_ORDER.map((group) => ({
    group,
    items: eligible
      .filter((g) => groupOf(g, here) === group)
      .map((g) => ({ id: g.id, label: scopeLabel(g), title: g.title })),
  }));
  return out.filter((g) => g.items.length > 0);
}
