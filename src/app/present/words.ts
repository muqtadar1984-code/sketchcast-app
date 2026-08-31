import type { Dictionary } from "@/i18n/dictionaries";
import { fmt } from "@/i18n/format";
import type { PickerGroup, Scope } from "@/utils/present/kit";

// Turning what the API says into what the reader sees.
//
// The kit modules used to compose these strings on the server — a `label` per
// generation kind, "Part 1 of 4", "Chapter 4 · Part 2", "This part". Every one
// of them was English, and every one reached a page that now renders in ten
// languages. So the pure modules return PLACES and KINDS, and this is the one
// file that turns them into words.
//
// It is shared by the pre-lesson rail and the running board, which is the point:
// two renderings of the same unit that disagreed about whether it was "Part 2"
// or "Part 2 of 4" would be a bug nobody would think to look for.

type T = Dictionary["present"];

/** "Worksheet", "Test paper" — by generation kind, with the kind itself as the
 *  last resort, because a kind this build has never heard of is still better
 *  rendered as `case_study` than as nothing. */
export function docLabel(t: T, kind: string): string {
  switch (kind) {
    case "presentation":
      return t.doc.presentation;
    case "worksheet":
      return t.doc.worksheet;
    case "lesson_plan":
      return t.doc.lessonPlan;
    case "activity":
      return t.doc.activity;
    case "case_study":
      return t.doc.caseStudy;
    case "exam_paper":
      return t.doc.examPaper;
    case "exam":
      return t.doc.exam;
    default:
      return kind;
  }
}

export function groupLabel(t: T, group: PickerGroup | string): string {
  switch (group) {
    case "this-part":
      return t.group.thisPart;
    case "this-chapter":
      return t.group.thisChapter;
    case "this-book":
      return t.group.thisBook;
    default:
      return t.group.revision;
  }
}

/** "Part 2 of 4", "Part 2", or "Whole chapter" — the unit a kit belongs to.
 *  `total` counts the chapter's parts, so a chapter with exactly one does not
 *  claim to be "1 of 1". */
export function unitLabel(t: T, u: { part: number | null; total: number }): string {
  if (u.part === null) return t.kit.wholeChapter;
  return u.total > 1
    ? fmt(t.kit.partOf, { n: u.part, total: u.total })
    : fmt(t.kit.part, { n: u.part });
}

/** The short form for a tab: "P2", or "Whole". */
export function unitShort(t: T, u: { part: number | null }): string {
  return u.part === null ? t.kit.wholeShort : fmt(t.kit.partShort, { n: u.part });
}

/**
 * Where a worksheet sits, for the picker.
 *
 * chapter_ref is 0-based in the database and rendered +1 everywhere. A run of
 * more than three chapters collapses to a range, because "Chapters 1, 2, 3, 4,
 * 5, 6, 7" in a narrow rail is a wall rather than a label. A generation that
 * belongs to no place at all falls back to the title the worker composed, which
 * already carries the chapter name.
 */
export function scopeLabel(t: T, scope: Scope, title: string | null): string {
  switch (scope.kind) {
    case "part":
      return fmt(t.kit.scopePart, { c: scope.chapter + 1, p: scope.part });
    case "chapter":
      return fmt(t.kit.scopeChapter, { c: scope.chapter + 1 });
    case "chapters": {
      const nums = [...scope.chapters].sort((a, b) => a - b).map((n) => n + 1);
      if (!nums.length) return title ?? t.kit.scopeBook;
      return nums.length > 3
        ? fmt(t.kit.scopeRange, { from: nums[0], to: nums[nums.length - 1] })
        : fmt(t.kit.scopeChapters, { list: nums.join(", ") });
    }
    default:
      return title ?? t.kit.scopeBook;
  }
}

/** The three tools, by key. The rail's colours and widths stay in the board —
 *  those are ink, not language. */
export function toolLabel(t: T, tool: "pen" | "highlighter" | "eraser"): string {
  return tool === "pen" ? t.board.pen : tool === "highlighter" ? t.board.highlighter : t.board.eraser;
}
