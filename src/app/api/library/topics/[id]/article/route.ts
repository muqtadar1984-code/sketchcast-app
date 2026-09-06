import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isLibraryMemberRequest } from "@/utils/library-access";
import { libraryAllows, type LibraryAction } from "@/utils/library-routing";
import {
  canApproveArticle,
  canEditArticle,
  canRejectArticle,
  canRenderFigures,
  canSubmitArticle,
  figureNeedsReset,
  topicAcceptsArticle,
  validateArticle,
} from "@/utils/catalogue/article";
import type { ArticleFigureInput, FigureSpec, TopicArticle } from "@/utils/catalogue/types";
import { audit, bad, conflict, dbError, notFound, readJson, text, uuid } from "../../../lib";

export const runtime = "nodejs";

// One topic's knowledge article (Phase 2b). POST {action, …} — every action is
// audited as library_<verb> on the TOPIC (target_kind 'topic'), so the topic
// page's trail shows the article's history next to the taxonomy's.
//
//   edit_article (editor, admin):
//     generate        {hints?, sourceArticleId?}  enqueue ONE `topic_article` job:
//                     the worker writes the next version as a draft (from the
//                     source version when one is named — "New version from this")
//     save            {articleId, article}        validate (validateArticle) and
//                     write a draft / in-review version — the write itself is
//                     guarded on status, so a Save that lands after an approve
//                     or reject is a 409, never an overwrite; figures upserted
//                     by figure_key (a rendered figure whose spec changed goes
//                     back to draft for a re-render — figureNeedsReset),
//                     removed ones deleted only while still 'draft'
//     submit          {articleId}                 draft → in_review
//     render_figures  {articleId}                 enqueue ONE `figure_render` job
//                     for a draft / in-review / approved version (the figures
//                     are part of the article a member edits, so the same
//                     edit_article role — not the kit-level `generate`)
//   approve (reviewer, editor, admin):
//     approve         {articleId, notes?}         approve_topic_article() — the RPC
//                     supersedes the old approved version, approves this one,
//                     moves the topic to article_approved and audits, in ONE
//                     transaction. Nothing else in this repo writes 'approved'
//                     (plan §1.3; catalogue-routes.test.ts asserts it). Refused
//                     while the TOPIC is still a candidate (approve it first)
//     reject          {articleId, notes}          draft | in_review → rejected
//
// Every status transition here is a guarded UPDATE (…eq/in("status")…select("id"))
// read back: zero rows means the version moved between the read and the write
// (two reviewers, or an editor and a reviewer, racing) and answers 409 — the
// audit row is written only for a change that happened.
//
// Both jobs are OBSERVER jobs (generation_id and book_id NULL, input in
// jobs.params — 0113) like topic_derive; one live job per target is the
// friendly pre-check here plus the partial unique indexes of 0114
// (jobs_one_live_article, jobs_one_live_figure_render), whose 23505 is the
// same 409. A member whose role does not allow the action gets the same 404
// as a non-member (library-access.ts: the portal is not probeable).

type Action = "generate" | "save" | "submit" | "render_figures" | "approve" | "reject";

const NEEDS: Record<Action, LibraryAction> = {
  generate: "edit_article",
  save: "edit_article",
  submit: "edit_article",
  render_figures: "edit_article",
  approve: "approve",
  reject: "approve",
};

type Body = {
  action?: unknown;
  hints?: unknown;
  sourceArticleId?: unknown;
  articleId?: unknown;
  article?: unknown;
  notes?: unknown;
};

// Not exported: a route module may only export Next's handler names.
const ARTICLE_JOB_TYPE = "topic_article";
const FIGURE_JOB_TYPE = "figure_render";
/** Phase 2b authors in English; translations (other languages, with a
 *  source_article_id) arrive with the translate phase. */
const LANGUAGE = "en";

const ARTICLE_COLUMNS =
  "id, topic_id, version, language, source_article_id, title, objectives, sections, glossary, misconceptions, worked_examples, claims, depth_node_id, depth_rationale, word_count, status, author, reviewer_id, reviewed_at, approved_by, notes, created_at, updated_at";

/** Postgres SQLSTATEs the approve RPC raises on purpose: check_violation for
 *  a version that is not reviewable, no_data_found for a vanished article. */
const RPC_REFUSALS = new Set(["23514", "P0002"]);

/** The renderer-owned columns of a figure whose spec changed: back to draft
 *  with no asset, no labels and no stale error, so Render figures redraws it. */
const FIGURE_RESET = { status: "draft", visual_asset_id: null, labels: [], render_error: null };

const statusLabel = (s: string) => s.replace(/_/g, " ");

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
  const { data: topic, error: tErr } = await admin.from("topics").select("id, title, status").eq("id", id).maybeSingle();
  if (tErr) return dbError(tErr);
  if (!topic) return NextResponse.json({ error: "Topic not found." }, { status: 404 });

  /** One of THIS topic's versions, or a 404 — an article id from another topic
   *  is not reachable through this route. */
  const loadArticle = async (raw: unknown) => {
    const articleId = uuid(raw);
    if (!articleId) return { article: null, response: bad("articleId is required.") };
    const { data, error } = await admin.from("topic_articles").select(ARTICLE_COLUMNS).eq("id", articleId).eq("topic_id", id).maybeSingle();
    if (error) return { article: null, response: dbError(error) };
    if (!data) return { article: null, response: NextResponse.json({ error: "Article version not found on this topic." }, { status: 404 }) };
    return { article: data as unknown as TopicArticle, response: null };
  };

  // ── generate ───────────────────────────────────────────────────────────────
  if (action === "generate") {
    if (!topicAcceptsArticle(topic.status)) {
      return bad(
        topic.status === "candidate"
          ? "Approve the topic first — an article is written for an approved topic."
          : "This topic is retired; reopen it before writing an article.",
      );
    }
    const hints = text(body.hints, 4000) || null;
    let sourceArticleId: string | null = null;
    if (body.sourceArticleId !== undefined && body.sourceArticleId !== null && body.sourceArticleId !== "") {
      const { article: source, response } = await loadArticle(body.sourceArticleId);
      if (!source) return response!;
      sourceArticleId = source.id;
    }

    const liveArticle = () =>
      admin
        .from("jobs")
        .select("id, status, created_at")
        .eq("type", ARTICLE_JOB_TYPE)
        .eq("params->>topic_id", id)
        .eq("params->>language", LANGUAGE)
        .in("status", ["queued", "processing"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    const { data: live, error: lErr } = await liveArticle();
    if (lErr) return dbError(lErr);
    if (live) return conflict(`An article is already ${live.status} for this topic.`, { jobId: live.id });

    const { data: job, error: jErr } = await admin
      .from("jobs")
      .insert({
        type: ARTICLE_JOB_TYPE,
        params: { topic_id: id, language: LANGUAGE, hints, source_article_id: sourceArticleId },
        book_id: null,
        generation_id: null,
        status: "queued",
      })
      .select("id")
      .single();
    if (jErr) {
      if (jErr.code === "23505") {
        // Lost the race to another click: jobs_one_live_article (0114) refused
        // the second row. Answer as the check above would have.
        const { data: winner } = await liveArticle();
        return conflict(`An article is already ${winner?.status ?? "queued"} for this topic.`, { jobId: winner?.id ?? null });
      }
      return dbError(jErr);
    }
    await audit(admin, m.id, "article_generate", "topic", id, {
      job_id: job.id,
      language: LANGUAGE,
      hints: hints !== null,
      source_article_id: sourceArticleId,
    });
    return NextResponse.json({ ok: true, jobId: job.id });
  }

  // ── save ───────────────────────────────────────────────────────────────────
  if (action === "save") {
    const { article, response } = await loadArticle(body.articleId);
    if (!article) return response!;
    if (!canEditArticle(article.status)) {
      return conflict(`Version ${article.version} is ${article.status.replace(/_/g, " ")} — only a draft or in-review version can be edited. Start a new version from it instead.`, {
        status: article.status,
      });
    }
    const v = validateArticle(body.article);
    if (!v.ok) return NextResponse.json({ error: v.errors[0] ?? "The article is not valid.", errors: v.errors }, { status: 400 });
    const next = v.article;

    // The write is guarded on status and read back: canEditArticle() above
    // looked at a row that approve_topic_article() or a reject may have moved
    // since. Zero rows written means exactly that — nothing is touched (not
    // the figures either) and the editor is told to reload. An approved
    // version is never overwritten by a Save that started before the approval.
    const { data: written, error: uErr } = await admin
      .from("topic_articles")
      .update({
        title: next.title,
        objectives: next.objectives,
        sections: next.sections,
        glossary: next.glossary,
        misconceptions: next.misconceptions,
        worked_examples: next.worked_examples,
        claims: next.claims,
        depth_rationale: next.depth_rationale,
        word_count: v.wordCount,
      })
      .eq("id", article.id)
      .in("status", ["draft", "in_review"])
      .select("id");
    if (uErr) return dbError(uErr);
    if (!written?.length) {
      return conflict(`Version ${article.version} was approved or rejected while you were editing — reload to see its current state; nothing was saved.`, {
        version: article.version,
      });
    }

    // Figures: upsert by (article_id, figure_key) — the payload carries the
    // editable columns, so an existing row keeps its visual_asset_id, labels,
    // status and render_error… unless what to DRAW changed on a figure that
    // was already rendered or reviewed (figureNeedsReset: subject, parts,
    // style or notes — not the caption): that row goes back to draft with the
    // asset, labels and error cleared, so the next Render figures redraws it
    // rather than keeping a picture of the old spec. A figure the editor
    // dropped is deleted only while it is still 'draft'; a rendered or
    // approved one has an asset behind it and stays (reported as kept).
    const { data: existingRows, error: fErr } = await admin.from("article_figures").select("id, figure_key, status, spec").eq("article_id", article.id);
    if (fErr) return dbError(fErr);
    const existing = (existingRows ?? []) as { id: string; figure_key: string; status: string; spec: Partial<FigureSpec> | null }[];
    const existingByKey = new Map(existing.map((f) => [f.figure_key, f]));
    const incoming = new Set(next.figures.map((f) => f.figure_key));
    const removed = existing.filter((f) => !incoming.has(f.figure_key));
    const removedDraft = removed.filter((f) => f.status === "draft").map((f) => f.figure_key);
    const kept = removed.filter((f) => f.status !== "draft").map((f) => f.figure_key);
    const reset = next.figures
      .filter((f) => {
        const prior = existingByKey.get(f.figure_key);
        return !!prior && figureNeedsReset(prior, f.spec);
      })
      .map((f) => f.figure_key);
    const resetKeys = new Set(reset);
    if (next.figures.length) {
      const { error } = await admin.from("article_figures").upsert(
        next.figures.map((f: ArticleFigureInput) => ({
          article_id: article.id,
          figure_key: f.figure_key,
          caption: f.caption,
          spec: f.spec,
          sort: f.sort,
          ...(resetKeys.has(f.figure_key) ? FIGURE_RESET : {}),
        })),
        { onConflict: "article_id,figure_key" },
      );
      if (error) return dbError(error);
    }
    if (removedDraft.length) {
      const { error } = await admin.from("article_figures").delete().eq("article_id", article.id).eq("status", "draft").in("figure_key", removedDraft);
      if (error) return dbError(error);
    }

    // The author column stays what it was (a model draft a human touched is
    // still the model's draft); who edited is the audit row's business.
    await audit(admin, m.id, "article_save", "topic", id, {
      article_id: article.id,
      version: article.version,
      status: article.status,
      author: article.author,
      edited_by: m.id,
      word_count: v.wordCount,
      figures: next.figures.length,
      figures_removed: removedDraft.length,
      figures_kept: kept,
      figures_reset: reset,
    });
    return NextResponse.json({ ok: true, wordCount: v.wordCount, figuresKept: kept, figuresReset: reset });
  }

  // ── submit ─────────────────────────────────────────────────────────────────
  if (action === "submit") {
    const { article, response } = await loadArticle(body.articleId);
    if (!article) return response!;
    if (!canSubmitArticle(article.status)) {
      return conflict(`Version ${article.version} is ${article.status.replace(/_/g, " ")}; only a draft can be submitted for review.`, { status: article.status });
    }
    const { data: moved, error } = await admin.from("topic_articles").update({ status: "in_review" }).eq("id", article.id).eq("status", "draft").select("id");
    if (error) return dbError(error);
    if (!moved?.length) {
      // The draft moved between the read and the write (submitted, approved or
      // rejected by someone else): nothing changed here, so nothing to audit.
      return conflict(`Version ${article.version} is no longer a draft — it changed while you were looking; reload to see its current state.`, {
        version: article.version,
      });
    }
    await audit(admin, m.id, "article_submit", "topic", id, { article_id: article.id, version: article.version, from: "draft", to: "in_review" });
    return NextResponse.json({ ok: true, status: "in_review" });
  }

  // ── render_figures ─────────────────────────────────────────────────────────
  if (action === "render_figures") {
    const { article, response } = await loadArticle(body.articleId);
    if (!article) return response!;
    if (!canRenderFigures(article.status)) {
      // A rejected or superseded version is history: rendering its figures
      // would spend image quota on assets no kit will ever read.
      return conflict(`Version ${article.version} is ${statusLabel(article.status)} — figures are rendered for a draft, in-review or approved version only.`, {
        status: article.status,
      });
    }
    const { count, error: cErr } = await admin.from("article_figures").select("id", { count: "exact", head: true }).eq("article_id", article.id);
    if (cErr) return dbError(cErr);
    if (!count) return bad("This version has no figures to render — add a figure spec and save first.");

    const liveRender = () =>
      admin
        .from("jobs")
        .select("id, status, created_at")
        .eq("type", FIGURE_JOB_TYPE)
        .eq("params->>article_id", article.id)
        .in("status", ["queued", "processing"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    const { data: live, error: lErr } = await liveRender();
    if (lErr) return dbError(lErr);
    if (live) return conflict(`A figure render is already ${live.status} for this version.`, { jobId: live.id });

    const { data: job, error: jErr } = await admin
      .from("jobs")
      .insert({
        type: FIGURE_JOB_TYPE,
        params: { article_id: article.id },
        book_id: null,
        generation_id: null,
        status: "queued",
      })
      .select("id")
      .single();
    if (jErr) {
      if (jErr.code === "23505") {
        // jobs_one_live_figure_render (0114) refused a racing second click.
        const { data: winner } = await liveRender();
        return conflict(`A figure render is already ${winner?.status ?? "queued"} for this version.`, { jobId: winner?.id ?? null });
      }
      return dbError(jErr);
    }
    await audit(admin, m.id, "figures_render", "topic", id, { article_id: article.id, version: article.version, job_id: job.id, figures: count });
    return NextResponse.json({ ok: true, jobId: job.id });
  }

  // ── approve ────────────────────────────────────────────────────────────────
  // Human approval, recorded (plan §1.3). The RPC is the ONLY writer of the
  // approved status: it locks the topic, supersedes the previously approved
  // version of this language, approves this one with the reviewer's id and
  // time, moves the topic to article_approved and writes the audit row —
  // atomically, so two reviewers racing cannot leave two approved versions
  // or none. This handler never touches topic_articles.status itself.
  if (action === "approve") {
    const { article, response } = await loadArticle(body.articleId);
    if (!article) return response!;
    if (!canApproveArticle(article.status)) {
      return conflict(`Version ${article.version} is ${statusLabel(article.status)}, not reviewable.`, { status: article.status });
    }
    if (topic.status === "candidate") {
      // Plan §1.3: the article comes AFTER the topic. Approving the article
      // would move a topic nobody has approved straight to article_approved.
      return conflict("Approve the topic first — an article is approved for an approved topic.", { topicStatus: topic.status });
    }
    const notes = text(body.notes, 2000) || null;
    const { data, error } = await admin.rpc("approve_topic_article", { p_article: article.id, p_reviewer: m.id, p_notes: notes });
    if (error) {
      if (RPC_REFUSALS.has(error.code ?? "") || /not reviewable|not found/i.test(error.message ?? "")) {
        return conflict(error.message ?? "The article could not be approved.", { code: error.code ?? null });
      }
      return dbError(error);
    }
    // Audited by the RPC (library_article_approve on the topic).
    return NextResponse.json({ ok: true, article: data });
  }

  // ── reject ─────────────────────────────────────────────────────────────────
  if (action === "reject") {
    const { article, response } = await loadArticle(body.articleId);
    if (!article) return response!;
    if (!canRejectArticle(article.status)) {
      return conflict(`Version ${article.version} is ${article.status.replace(/_/g, " ")}, not reviewable.`, { status: article.status });
    }
    const notes = text(body.notes, 2000);
    if (!notes) return bad("Say why — notes are required to reject a version.");
    const { data: rejected, error } = await admin
      .from("topic_articles")
      .update({ status: "rejected", reviewer_id: m.id, reviewed_at: new Date().toISOString(), notes })
      .eq("id", article.id)
      .in("status", ["draft", "in_review"])
      .select("id");
    if (error) return dbError(error);
    if (!rejected?.length) {
      // Another reviewer's verdict landed first: the version is approved or
      // rejected already. Nothing changed here, so nothing to audit.
      return conflict(`Version ${article.version} was approved or rejected while you were reviewing — reload to see its current state.`, {
        version: article.version,
      });
    }
    await audit(admin, m.id, "article_reject", "topic", id, { article_id: article.id, version: article.version, from: article.status, notes });
    return NextResponse.json({ ok: true, status: "rejected" });
  }

  return bad("Unknown action.");
}
