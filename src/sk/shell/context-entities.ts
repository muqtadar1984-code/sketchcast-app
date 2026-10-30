// SK — the user's OWN context entities as grounding support (2026-10-30).
//
// Production log, the founder's "play chapter 1 from the book":
//   dropped: ["Do you mean a class like 7B, or a different book title?"]
//   unsupported: ["7"]
// groundingCheck holds every number and capitalised name in SK's answer to
// the tool results and the question. A clarifying question that names one of
// HER classes ("7B"), books, chapters, children or her school is not an
// invented fact — those names are hers — but no tool returned them that turn,
// so the question was dropped and she got "I have nothing on that".
//
// The fix: when the check fails, the turn route asks again with these names
// added (`groundWithContext`). They are read through the USER-SESSION client
// (RLS; classes and school re-filtered to her own), and only when needed, so a turn
// whose answer is already grounded reads nothing more. Invented names are
// still dropped: a name that is neither in the tools, the question nor her
// own context never passes.

import type { SkCapabilityDeps, SkContext } from "./types";
import { groundingCheck, type GroundingMode, type GroundingVerdict } from "./prompt";
import { teacherClasses } from "@/sk/capabilities/shared";

type Row = Record<string, unknown>;
const rowsOf = (r: unknown): Row[] => {
  const d = (r as { data?: unknown } | null)?.data;
  return Array.isArray(d) ? (d as Row[]) : d && typeof d === "object" ? [d as Row] : [];
};
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Cap per source: a big shelf must not turn the support into a dictionary. */
const MAX_BOOKS = 40;
const MAX_CHAPTERS = 60;

async function safe(read: () => Promise<string[]>): Promise<string[]> {
  try {
    return await read();
  } catch {
    return [];
  }
}

/**
 * Her own context, as strings: class names, book titles with their chapter
 * numbers (1-based, as the app shows them) and titles, her children's names
 * (a parent), her school's name, and what this conversation already resolved.
 */
export async function contextEntities(ctx: SkContext, deps: Pick<SkCapabilityDeps, "session" | "cache">): Promise<string[]> {
  const me = ctx.user.id;
  const role = ctx.user.role;
  const out: string[] = [];

  // What this conversation already resolved (signed memory) and the children
  // loadContext read for a parent (verified or not, they are hers).
  for (const e of ctx.recent.entities ?? []) if (e.label) out.push(e.label);
  for (const c of ctx.children ?? []) out.push(c.name, c.firstName);

  const reads: Array<Promise<string[]>> = [];

  // Her classes: the ones she teaches; a student's own enrolments.
  if (role !== "student" && role !== "parent") {
    reads.push(
      safe(async () =>
        rowsOf(await teacherClasses(deps as SkCapabilityDeps, me))
          .filter((c) => c.teacher_id === me)
          .map((c) => text(c.name))
          .filter((x): x is string => !!x),
      ),
    );
  } else if (role === "student") {
    reads.push(
      safe(async () =>
        rowsOf(await deps.session.from("enrollments").select("student_id, classes(name)").eq("student_id", me))
          .filter((r) => r.student_id === me)
          .map((r) => {
            const c = r.classes as { name?: unknown } | Array<{ name?: unknown }> | null;
            return text(Array.isArray(c) ? c[0]?.name : c?.name);
          })
          .filter((x): x is string => !!x),
      ),
    );
  }

  // Her books (own, the school shelf, SketchCast books RLS shows her): the
  // titles, and each chapter's number and title.
  reads.push(
    safe(async () => {
      const rows = rowsOf(await deps.session.from("books").select("id, title, chapters").is("removed_at", null).limit(MAX_BOOKS));
      // RLS decides which books she may read (own, the school shelf, the
      // SketchCast books she holds a grant for); these are support words
      // only, never shown as data.
      const words: string[] = [];
      for (const b of rows) {
        const title = text(b.title);
        if (title) words.push(title);
        const chapters = Array.isArray(b.chapters) ? (b.chapters as Array<{ num?: unknown; title?: unknown }>).slice(0, MAX_CHAPTERS) : [];
        for (const c of chapters) {
          if (typeof c?.num === "number" && Number.isInteger(c.num) && c.num >= 0) words.push(`chapter ${c.num + 1}`);
          const ct = text(c?.title);
          if (ct) words.push(ct);
        }
      }
      return words;
    }),
  );

  // Her school's name.
  if (ctx.user.schoolId) {
    reads.push(
      safe(async () =>
        rowsOf(await deps.session.from("schools").select("id, name").eq("id", ctx.user.schoolId).maybeSingle())
          .filter((s) => s.id === ctx.user.schoolId)
          .map((s) => text(s.name))
          .filter((x): x is string => !!x),
      ),
    );
  }

  for (const r of await Promise.all(reads)) out.push(...r);
  return [...new Set(out)];
}

/**
 * groundingCheck, and — only when it fails — again with her own context
 * entities as support. `context` says the second pass was taken.
 */
export async function groundWithContext(
  answer: string,
  support: unknown[],
  question: string,
  entities: () => Promise<string[]>,
  mode: GroundingMode = "strict",
): Promise<GroundingVerdict & { context: boolean }> {
  // Soft mode (model routing): "does a sentence cite a tool fact?" reads the
  // TOOL results only, never her context entities.
  const opts = { mode, toolSupport: support };
  const first = groundingCheck(answer, support, question, opts);
  if (first.ok) return { ...first, context: false };
  const extra = await entities().catch(() => [] as string[]);
  if (!extra.length) return { ...first, context: false };
  return { ...groundingCheck(answer, [...support, ...extra], question, opts), context: true };
}
