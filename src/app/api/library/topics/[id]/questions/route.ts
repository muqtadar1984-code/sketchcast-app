import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isLibraryMemberRequest } from "@/utils/library-access";
import { libraryAllows, type LibraryAction } from "@/utils/library-routing";
import { catalogueGenerateEnabled } from "@/utils/flags";
import {
  HINTS_MAX,
  TARGET_MAX,
  TARGET_MIN,
  canEditQuestion,
  questionContentKey,
  rejectedHints,
  validateQuestionEdit,
  type TopicQuestion,
} from "@/utils/catalogue/questions";
import { audit, bad, conflict, dbError, notFound, readJson, text, uuid, uuidList } from "../../../lib";

export const runtime = "nodejs";

// One topic's question bank (Phase 3, spec decision 8). POST {action, …} —
// every action is audited as library_<verb> on the TOPIC (target_kind
// 'topic'), so the topic page's trail shows the bank's history next to the
// article's.
//
//   generate (editor, admin) — the job spends model calls, which is what
//   LibraryAction's `generate` covers; editing the items is edit_article:
//     generate            {hints?, target?}   enqueue ONE `topic_questions` job
//                         for the topic's APPROVED English article: the worker
//                         writes `target` drafts (default 30 — 15 objective,
//                         15 subjective) and reports in jobs.stage. Refused
//                         while FEATURE_CATALOGUE_GENERATE is off (409).
//     regenerate_rejected {hints?}            the same job, its hints prefixed
//                         by the rejected items' review notes and stems
//                         (rejectedHints, capped at 4000), so the writer
//                         avoids or fixes exactly what a reviewer refused
//   edit_article (editor, admin):
//     save                {questionId, item}  validateQuestionEdit against the
//                         item's article, then a status-guarded write of the
//                         editable columns. An APPROVED item that is edited
//                         goes back to draft with a note — a reviewer approved
//                         the words that were there, not the new ones.
//                         content_hash is recomputed here exactly as the
//                         worker does (sha1(item_type|canonical_key(stem)));
//                         the unique (topic, language, hash) refusing it is
//                         "duplicate of another item", 409.
//     retire              {questionIds[]}     draft | approved | rejected →
//                         retired (out of the bank; never composed)
//   approve (reviewer, editor, admin):
//     approve             {questionIds[]}     draft → approved, with the
//                         reviewer's id and time. Approving ITEMS is a guarded
//                         UPDATE here, not a plan gate (decision 7): the kit's
//                         approval is the RPC. The maturity ladder
//                         (topics.bank_maturity) is a database trigger — this
//                         route never writes it.
//     reject              {questionIds[], notes}  draft | approved → rejected;
//                         notes are required (they feed regenerate_rejected)
//
// Bulk actions take up to 200 ids of THIS topic; the guarded UPDATE only
// touches rows still in an accepting status and reports how many moved —
// zero means every id had already moved (another reviewer) and answers 409,
// nothing audited. The job is an OBSERVER job (generation_id and book_id NULL,
// input in jobs.params) like topic_article; one live job per (topic,
// language) is the friendly pre-check here plus 0115's partial unique index
// jobs_one_live_questions, whose 23505 is the same 409.

type Action = "generate" | "regenerate_rejected" | "save" | "retire" | "approve" | "reject";

const NEEDS: Record<Action, LibraryAction> = {
  generate: "generate",
  regenerate_rejected: "generate",
  save: "edit_article",
  retire: "edit_article",
  approve: "approve",
  reject: "approve",
};

type Body = {
  action?: unknown;
  hints?: unknown;
  target?: unknown;
  questionId?: unknown;
  item?: unknown;
  questionIds?: unknown;
  notes?: unknown;
};

// Not exported: a route module may only export Next's handler names.
const QUESTIONS_JOB_TYPE = "topic_questions";
/** Phase 3 authors in English; translations arrive with the translate phase. */
const LANGUAGE = "en";
/** ids per bulk approve / reject / retire */
const BULK_MAX = 200;

const QUESTION_COLUMNS =
  "id, topic_id, article_id, objective_ref, claim_ref, language, source_question_id, item_type, answer_mode, difficulty, cognitive_level, marks, est_seconds, stem, options, distractor_rationale, answer, marking_scheme, explanation, tags, content_hash, status, reviewer_id, reviewed_at, notes, created_at, updated_at";

/** The worker's content_hash (decision 8): sha1 over questionContentKey. */
const contentHash = (itemType: string, stem: string) => createHash("sha1").update(questionContentKey(itemType, stem), "utf8").digest("hex");

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const m = await isLibraryMemberRequest();
  if (!m) return notFound();

  const { id: rawId } = await ctx.params;
  const id = uuid(rawId);
  if (!id) return notFound();

  const body = await readJson<Body>(request);
  if (!body) return bad("Invalid JSON.");
  const action = body.action as Action;
  if (typeof action !== "string" || !(action in NEEDS)) return bad("Unknown action.");
  if (!libraryAllows(m.role, NEEDS[action])) return notFound();

  const admin = createAdminClient();
  const { data: topic, error: tErr } = await admin.from("topics").select("id, title, status, bank_maturity").eq("id", id).maybeSingle();
  if (tErr) return dbError(tErr);
  if (!topic) return NextResponse.json({ error: "Topic not found." }, { status: 404 });

  /** The topic's approved English article, or null. Items are written from
   *  it and validated against it. */
  const approvedArticle = async () => {
    const { data, error } = await admin
      .from("topic_articles")
      .select("id, version, objectives, claims, misconceptions")
      .eq("topic_id", id)
      .eq("language", LANGUAGE)
      .eq("status", "approved")
      .maybeSingle();
    return { article: (data ?? null) as { id: string; version: number; objectives: unknown; claims: unknown; misconceptions: unknown } | null, error };
  };

  /** The ids of a jsonb list column as the validator wants them. */
  const refs = (v: unknown): { id: string }[] => (Array.isArray(v) ? v.filter((x): x is { id: string } => !!x && typeof x === "object" && typeof (x as { id?: unknown }).id === "string") : []);

  // ── generate / regenerate_rejected ─────────────────────────────────────────
  if (action === "generate" || action === "regenerate_rejected") {
    if (!catalogueGenerateEnabled()) {
      return conflict("Catalogue generation is off (FEATURE_CATALOGUE_GENERATE). Nothing was queued.");
    }
    const { article, error: aErr } = await approvedArticle();
    if (aErr) return dbError(aErr);
    if (!article) return bad("Approve an article first — questions are written from the topic's approved English article.");

    let hints = text(body.hints, HINTS_MAX) || null;
    let rejectedCount = 0;
    if (action === "regenerate_rejected") {
      // The rejected items' notes and stems lead the hints (newest first, so
      // the most recent verdicts survive the cap when there are many).
      const { data: rejected, error: rErr } = await admin
        .from("topic_questions")
        .select("stem, notes")
        .eq("topic_id", id)
        .eq("language", LANGUAGE)
        .eq("status", "rejected")
        .order("reviewed_at", { ascending: false, nullsFirst: false })
        .limit(100);
      if (rErr) return dbError(rErr);
      const rows = (rejected ?? []) as Pick<TopicQuestion, "stem" | "notes">[];
      if (!rows.length) return bad("No rejected items to regenerate from — reject some first, or use Generate questions.");
      rejectedCount = rows.length;
      hints = rejectedHints(rows, hints) || null;
    }

    let target: number | null = null;
    if (body.target !== undefined && body.target !== null && body.target !== "") {
      const t = typeof body.target === "number" ? body.target : typeof body.target === "string" && /^\d+$/.test(body.target.trim()) ? Number(body.target) : NaN;
      if (!Number.isInteger(t) || t < TARGET_MIN || t > TARGET_MAX) return bad(`target must be a whole number from ${TARGET_MIN} to ${TARGET_MAX}.`);
      target = t;
    }

    const liveQuestions = () =>
      admin
        .from("jobs")
        .select("id, status, created_at")
        .eq("type", QUESTIONS_JOB_TYPE)
        .eq("params->>topic_id", id)
        .eq("params->>language", LANGUAGE)
        .in("status", ["queued", "processing"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    const { data: live, error: lErr } = await liveQuestions();
    if (lErr) return dbError(lErr);
    if (live) return conflict(`A question job is already ${live.status} for this topic.`, { jobId: live.id });

    const { data: job, error: jErr } = await admin
      .from("jobs")
      .insert({
        type: QUESTIONS_JOB_TYPE,
        params: { topic_id: id, article_id: article.id, language: LANGUAGE, hints, target },
        book_id: null,
        generation_id: null,
        status: "queued",
      })
      .select("id")
      .single();
    if (jErr) {
      if (jErr.code === "23505") {
        // Lost the race to another click: jobs_one_live_questions (0115)
        // refused the second row. Answer as the check above would have.
        const { data: winner } = await liveQuestions();
        return conflict(`A question job is already ${winner?.status ?? "queued"} for this topic.`, { jobId: winner?.id ?? null });
      }
      return dbError(jErr);
    }
    await audit(admin, m.id, "questions_generate", "topic", id, {
      job_id: job.id,
      article_id: article.id,
      article_version: article.version,
      language: LANGUAGE,
      target,
      hints: hints !== null,
      from_rejected: action === "regenerate_rejected" ? rejectedCount : 0,
    });
    return NextResponse.json({ ok: true, jobId: job.id });
  }

  // ── save ───────────────────────────────────────────────────────────────────
  if (action === "save") {
    const questionId = uuid(body.questionId);
    if (!questionId) return bad("questionId is required.");
    // An item id is only reachable through its own topic.
    const { data: qRow, error: qErr } = await admin.from("topic_questions").select(QUESTION_COLUMNS).eq("id", questionId).eq("topic_id", id).maybeSingle();
    if (qErr) return dbError(qErr);
    if (!qRow) return NextResponse.json({ error: "Question not found on this topic." }, { status: 404 });
    const q = qRow as unknown as TopicQuestion;
    if (!canEditQuestion(q.status)) {
      return conflict(`This item is ${q.status} — only a draft or an approved item can be edited. Regenerate instead.`, { status: q.status });
    }
    // Validated against the article the item was written from (its own
    // article_id, not necessarily the currently approved version), so its
    // objective, claim and misconception refs resolve where they were made —
    // and, for a diagram_label item, against that version's RENDERED,
    // labelled figures (the worker's labelled_figures): the figure named and
    // every label must be real.
    const { data: art, error: aErr } = await admin.from("topic_articles").select("id, objectives, claims, misconceptions").eq("id", q.article_id).maybeSingle();
    if (aErr) return dbError(aErr);
    if (!art) return conflict("The article this item was written from no longer exists.");
    const { data: figRows, error: fErr } = await admin.from("article_figures").select("figure_key, caption, labels").eq("article_id", q.article_id).eq("status", "rendered");
    if (fErr) return dbError(fErr);
    const figures = ((figRows ?? []) as { figure_key: string; caption: string | null; labels: unknown }[])
      .map((f) => ({
        figure_key: String(f.figure_key ?? ""),
        caption: f.caption ?? null,
        labels: (Array.isArray(f.labels) ? f.labels : [])
          .map((lb: unknown) => (lb && typeof lb === "object" && typeof (lb as { label?: unknown }).label === "string" ? ((lb as { label: string }).label).trim() : ""))
          .filter(Boolean),
      }))
      .filter((f) => f.figure_key && f.labels.length > 0);
    const input = typeof body.item === "object" && body.item !== null ? { ...(body.item as Record<string, unknown>), item_type: q.item_type } : body.item;
    const v = validateQuestionEdit(input, { objectives: refs(art.objectives), claims: refs(art.claims), misconceptions: refs(art.misconceptions), figures });
    if (!v.ok) return NextResponse.json({ error: v.errors[0] ?? "The item is not valid.", errors: v.errors }, { status: 400 });
    const next = v.item;

    // An approved item edited by hand is a new set of words nobody has
    // reviewed: back to draft, with the fact recorded in its notes so the
    // reviewer sees why it is in the queue again.
    const demote = q.status === "approved";
    const note = demote ? `${q.notes ? `${q.notes}\n` : ""}Edited after approval (${new Date().toISOString().slice(0, 10)}) — needs re-review.` : q.notes;

    // Guarded on the status the row HAD when read, and read back: zero rows
    // means a reviewer moved it meanwhile (approved a draft, rejected it) —
    // nothing is written, the editor is told to reload. Without the guard a
    // Save that started on a draft would silently edit an item approved
    // since, without demoting it.
    const { data: written, error: uErr } = await admin
      .from("topic_questions")
      .update({
        objective_ref: next.objective_ref,
        claim_ref: next.claim_ref,
        difficulty: next.difficulty,
        cognitive_level: next.cognitive_level,
        marks: next.marks,
        est_seconds: next.est_seconds,
        stem: next.stem,
        options: next.options,
        distractor_rationale: next.distractor_rationale,
        answer: next.answer,
        marking_scheme: next.marking_scheme,
        explanation: next.explanation,
        tags: next.tags,
        content_hash: contentHash(q.item_type, next.stem),
        ...(demote ? { status: "draft", reviewer_id: null, reviewed_at: null, notes: note } : {}),
      })
      .eq("id", q.id)
      .eq("status", q.status)
      .select("id");
    if (uErr) {
      if (uErr.code === "23505") {
        // unique (topic_id, language, content_hash): the edited stem now says
        // the same thing as another item of this topic.
        return conflict("The edited stem is a duplicate of another item in this bank — change the wording, or retire one of them.", { code: uErr.code });
      }
      return dbError(uErr);
    }
    if (!written?.length) {
      return conflict("This item was approved or rejected while you were editing — reload to see its current state; nothing was saved.", { status: q.status });
    }
    await audit(admin, m.id, "question_save", "topic", id, {
      question_id: q.id,
      item_type: q.item_type,
      from: q.status,
      to: demote ? "draft" : q.status,
      edited_by: m.id,
    });
    return NextResponse.json({ ok: true, status: demote ? "draft" : q.status, demoted: demote });
  }

  // ── approve / reject / retire (bulk, guarded) ──────────────────────────────
  const list = uuidList(body.questionIds, BULK_MAX);
  if (!list || "invalid" in list || !list.ids.length) return bad(`questionIds must be a list of 1–${BULK_MAX} ids.`);
  const ids = list.ids;
  const now = new Date().toISOString();

  if (action === "approve") {
    // Approve only from draft: a rejected item is regenerated, not resurrected;
    // an approved one is already counted. The trigger recomputes the ladder.
    const { data: moved, error } = await admin
      .from("topic_questions")
      .update({ status: "approved", reviewer_id: m.id, reviewed_at: now })
      .eq("topic_id", id)
      .in("id", ids)
      .eq("status", "draft")
      .select("id");
    if (error) return dbError(error);
    if (!moved?.length) {
      return conflict(ids.length === 1 ? "This item is no longer a draft — it changed while you were reviewing; reload." : "None of the selected items is still a draft — reload to see their current state.", {
        requested: ids.length,
      });
    }
    await audit(admin, m.id, "questions_approve", "topic", id, { requested: ids.length, approved: moved.length, question_ids: moved.map((r) => r.id) });
    return NextResponse.json({ ok: true, approved: moved.length, skipped: ids.length - moved.length });
  }

  if (action === "reject") {
    const notes = text(body.notes, 2000);
    if (!notes) return bad("Say why — notes are required to reject items (they steer Regenerate rejected).");
    const { data: moved, error } = await admin
      .from("topic_questions")
      .update({ status: "rejected", reviewer_id: m.id, reviewed_at: now, notes })
      .eq("topic_id", id)
      .in("id", ids)
      .in("status", ["draft", "approved"])
      .select("id");
    if (error) return dbError(error);
    if (!moved?.length) {
      return conflict("None of the selected items can be rejected any more (already rejected or retired) — reload to see their current state.", { requested: ids.length });
    }
    await audit(admin, m.id, "questions_reject", "topic", id, { requested: ids.length, rejected: moved.length, question_ids: moved.map((r) => r.id), notes });
    return NextResponse.json({ ok: true, rejected: moved.length, skipped: ids.length - moved.length });
  }

  if (action === "retire") {
    const { data: moved, error } = await admin
      .from("topic_questions")
      .update({ status: "retired" })
      .eq("topic_id", id)
      .in("id", ids)
      .in("status", ["draft", "approved", "rejected"])
      .select("id");
    if (error) return dbError(error);
    if (!moved?.length) return conflict("Every selected item is already retired.", { requested: ids.length });
    await audit(admin, m.id, "questions_retire", "topic", id, { requested: ids.length, retired: moved.length, question_ids: moved.map((r) => r.id) });
    return NextResponse.json({ ok: true, retired: moved.length, skipped: ids.length - moved.length });
  }

  return bad("Unknown action.");
}
