// SK Shell — executing `lesson.prepare` from a VERIFIED token row (S2 slice B).
// CLICK-ONLY (§9.2: it spends credits): act.ts refuses a spoken yes before
// this runs, via the handler's `clickOnly` flag.
//
// act-core's consumeThenWrite: the stored params are shape-checked before the
// consume, the token is consumed through the admin RPC, then the kit is
// re-planned and inserted AS THE TEACHER through the user-session client —
// NEVER the admin client: the trial pin (beta_generation_cap) only applies
// when auth.uid() is set, and gen_write / can_use_book, fair_use_cap,
// duplicate_guard, lesson tools and the part-map guard all decide exactly as
// they do for a Library click. The rows are prepare.ts `planKit`'s — the
// SAME kitRows() the Library's chapter kit inserts — each carrying
// sk_action_id = token id (0169's unique index (sk_action_id, kind, part)
// makes a repeat insert fail → already_used).
//
// Re-checked at execution, inside the write: the book is still on her shelf
// (else "That book isn't on your shelf."), she still has no kit for the
// chapter (else already_used + "You already have that kit"), the credits
// still equal the card's (else refused, nothing inserted), and a book the
// junk-upload gate flags carries the card's warning (the click IS the
// confirmation, so every row is stamped like the Library's dialog does).
//
// A trigger's refusal is mapped to one plain line (prepRefusal); the DB's own
// message goes to the audit row only.

import type { ResolvedEntity } from "./types";
import type { ActionTokenRow } from "./tokens";
import { ACT_LINES, consumeThenWrite, fail, failedStage, str, writeFailure, type ActInput, type Handled, type WriteOutcome } from "./act-core";
import { lineFor } from "./lines";
import {
  ACT_WRITE_FAILED,
  PREP_BOOK_BUSY,
  PREP_EXISTS,
  PREP_JUST_STARTED,
  PREP_NO_ACCESS,
  PREP_NO_CREDITS,
  PREP_NOT_ON_SHELF,
  PREP_STARTED,
  PREP_TRIAL,
} from "./act-lines";
import { planKit } from "@/sk/capabilities/prepare";
import { stampConfirmation } from "@/utils/junk-gate";

type Line = Record<string, string>;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const badParams = () => fail("refused", undefined, { reason: "bad_params" });

/** The plain line for each refusal reason; anything else is the generic one. */
export const PREP_REFUSAL_LINES: Record<string, Line> = {
  not_on_shelf: PREP_NOT_ON_SHELF,
  no_credits: PREP_NO_CREDITS,
  duplicate_guard: PREP_JUST_STARTED,
  trial_pin: PREP_TRIAL,
  book_busy: PREP_BOOK_BUSY,
  no_access: PREP_NO_ACCESS,
};

/**
 * A generations insert error → the write outcome. Trigger exceptions arrive
 * as P0001 with the trigger's own sentence, so the reason is read from the
 * message; duplicate_guard raises 23505 too, so its sentence is checked
 * BEFORE 0169's unique index (also 23505 → already_used).
 */
export function prepRefusal(error: unknown): { ok: false; outcome: "already_used" | "refused" | "error"; reason?: string; error?: string } {
  const e = (error ?? {}) as { code?: string; message?: string };
  const m = e.message ?? "";
  const refused = (reason: string) => ({ ok: false as const, outcome: "refused" as const, reason, error: m || undefined });
  if (/already being made/i.test(m)) return refused("duplicate_guard");
  if (e.code === "23505") return { ok: false, outcome: "already_used", reason: "duplicate" };
  if (e.code === "42501" || /row-level security/i.test(m)) return refused("not_on_shelf");
  if (/Monthly limit reached|free trial includes \d+ generations|school's free trial includes|you've used them all/i.test(m)) return refused("no_credits");
  if (/free trial (?:generates chapter by chapter|includes the full kit)|This chapter has \d+ parts|Your plan is limited to|Trial lessons can't/i.test(m)) return refused("trial_pin");
  if (/being re-read|no longer exists — this chapter now has/i.test(m)) return refused("book_busy");
  if (/Lesson tools are not enabled|access is suspended|free trial has ended/i.test(m)) return refused("no_access");
  if (/Regeneration limit/i.test(m)) return refused("regeneration_limit");
  return writeFailure(error);
}

/** The card's params, checked. */
export function prepareParams(p: Record<string, unknown>): { bookId: string; num: number; credits: number; chapterTitle: string; warned: boolean } | null {
  const bookId = typeof p.book_id === "string" && UUID_RE.test(p.book_id) ? p.book_id : null;
  const num = typeof p.chapter_ref === "string" && /^[0-9]{1,4}$/.test(p.chapter_ref) ? Number(p.chapter_ref) : null;
  const credits = typeof p.credits === "number" && Number.isInteger(p.credits) && p.credits > 0 ? p.credits : null;
  const chapterTitle = typeof p.chapter_title === "string" ? p.chapter_title.trim() : "";
  if (!bookId || num === null || credits === null || !chapterTitle || p.click_only !== true) return null;
  return { bookId, num, credits, chapterTitle, warned: typeof p.warning === "string" && p.warning.length > 0 };
}

type Inserted = { ids: string[]; presentationId: string | null };

export async function runLessonPrepare(row: ActionTokenRow, input: ActInput): Promise<Handled> {
  const p = prepareParams(row.params ?? {});
  if (!p) return badParams();
  if (!input.session) return fail("error", undefined, undefined, "error:no_session");
  const { ctx } = input;
  const locale = ctx.user.locale;

  const r = await consumeThenWrite(input.admin, input.session, row, ctx, async (db, actionId): Promise<WriteOutcome<Inserted>> => {
    const plan = await planKit(ctx, { session: db, now: input.now }, p.bookId, p.num);
    if (plan.kind === "no_book" || plan.kind === "no_chapter" || plan.kind === "not_ready") return { ok: false, outcome: "refused", reason: plan.kind === "no_book" ? "not_on_shelf" : plan.kind };
    if (plan.kind === "exists") return { ok: false, outcome: "already_used", reason: "kit_exists" };
    if (plan.credits !== p.credits) return { ok: false, outcome: "refused", reason: "credits_changed" };
    if (plan.gated && !p.warned) return { ok: false, outcome: "refused", reason: "gate_changed" };
    const insert = plan.rows.map((r) => ({ ...r, params: plan.gated ? stampConfirmation(r.params) : r.params, sk_action_id: actionId }));
    const res = (await db.from("generations").insert(insert).select("id, kind")) as { data?: unknown; error?: unknown };
    if (res?.error) return prepRefusal(res.error);
    const out = Array.isArray(res?.data) ? (res.data as Array<{ id?: string; kind?: string }>) : [];
    if (!out.length) return { ok: false, outcome: "error", error: "no rows returned" };
    return { ok: true, value: { ids: out.map((x) => String(x.id)), presentationId: out.find((x) => x.kind === "presentation")?.id ?? null } };
  });

  if (r.stage === "write" && !r.result.ok) {
    const w = r.result;
    if (w.outcome === "already_used" && w.reason === "kit_exists") return fail("already_used", lineFor(PREP_EXISTS, locale), undefined, "already_used:kit_exists");
    if (w.outcome === "refused" && w.reason && PREP_REFUSAL_LINES[w.reason]) {
      return fail("refused", lineFor(PREP_REFUSAL_LINES[w.reason], locale), { reason: w.reason }, `refused:${w.reason}${w.error ? `:${w.error}` : ""}`.slice(0, 500));
    }
    if (w.outcome === "refused") return fail("refused", ACT_LINES.refused, w.reason ? { reason: w.reason } : undefined, `refused:${w.reason ?? "write"}${w.error ? `:${w.error}` : ""}`.slice(0, 500));
  }
  const failed = failedStage(r, lineFor(ACT_WRITE_FAILED, locale));
  if (failed) return failed;
  const v = r.stage === "write" && r.result.ok ? r.result.value : { ids: [], presentationId: null };
  const chapter = str(row.params?.chapter_title) || p.chapterTitle;
  const entities: ResolvedEntity[] = v.presentationId ? [{ kind: "kit", id: v.presentationId, label: chapter, via: "lesson.prepare", ids: [p.bookId, String(p.num)] }] : [];
  return {
    response: {
      ok: true,
      outcome: "done",
      summary: lineFor(PREP_STARTED, locale, { chapter }),
      result: { generation_id: v.presentationId, generation_ids: v.ids, book_id: p.bookId, chapter_ref: String(p.num), credits: p.credits },
    },
    entities,
  };
}
