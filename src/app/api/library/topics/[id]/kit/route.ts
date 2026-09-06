import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isLibraryMemberRequest } from "@/utils/library-access";
import { libraryAllows, type LibraryAction } from "@/utils/library-routing";
import { catalogueGenerateEnabled, catalogueOwnerId } from "@/utils/flags";
import { catalogueColumnMissing } from "@/utils/catalogue/status";
import {
  CATALOGUE_KITS_MIGRATION,
  RETRIED_KEY,
  canEditClips,
  canRetryKit,
  curriculumHeaderLines,
  hasLiveKit,
  isKitKind,
  isKitRejectReason,
  isTeacherAvatar,
  kitAcceptsApprove,
  kitAcceptsGenerate,
  kitAcceptsRegenerate,
  kitAcceptsReject,
  kitGenerationIdFor,
  kitGenerationParams,
  kitGenerationRows,
  nextTeacherAvatar,
  partDurationsOf,
  retryParamsOf,
  validateClips,
  voicePairFor,
  type HeaderMapping,
} from "@/utils/catalogue/kit";
import type { PartPlanRow, TeacherAvatar, TopicKit } from "@/utils/catalogue/types";
import { audit, bad, conflict, dbError, notFound, readJson, text, uuid } from "../../../lib";
import { enqueueQuestionsJob } from "./questions-job";

export const runtime = "nodejs";

// One topic's KIT (Phase 3). POST {action, …} — every action is audited as
// library_<verb> on the TOPIC (target_kind 'topic'), so the topic page's
// trail shows the kit's history next to the article's and the taxonomy's.
//
//   generate (editor, admin):
//     generate     {teacherAvatar?}   ONE topic_kits row (status generating)
//                  + FIVE generations rows — presentation, activity,
//                  case_study, worksheet, deck — owned by the catalogue
//                  system account (CATALOGUE_OWNER_ID) with book_id and
//                  chapter_ref NULL and the params of decision 1
//                  (kitGenerationParams: catalogue: true, topic / kit /
//                  article ids, language, dialogue narration, the teacher's
//                  gender, the two premium voices, the curriculum header
//                  lines composed from the topic's mappings). The lesson plan
//                  is NOT inserted here: the worker adds it after the
//                  presentation finishes, because it cites the clips. Then
//                  ONE `topic_questions` observer job (questions-job.ts; a
//                  live one is reused, never a failure) and the topic moves
//                  article_approved → generating — a guarded UPDATE read back,
//                  which is also the race lock: two clicks both insert a kit
//                  row, one wins the topic move, the loser takes its row out
//                  and answers 409.
//     retry        {kitId, kind}      re-insert ONE failed piece with the
//                  failed row's INPUT params (retryParamsOf — the worker's
//                  telemetry is not copied; a retried worksheet is otherwise
//                  byte-identical to the one it replaces), repoint the kit at
//                  it, kit failed → generating. The failed row is taken
//                  EXCLUSIVELY first: a compare-and-swap flips params.retried
//                  to true where it is not yet set, so two operators clicking
//                  Retry on the same piece (two tabs; Sara and the founder
//                  both hold generate) queue ONE build, not two — a duplicate
//                  presentation is a whole video's worth of Vertex image
//                  calls, the never-starve capacity. The pointer is written
//                  by repoint_kit_generation() (0115): a jsonb merge, never a
//                  replace of doc_generation_ids read at the top of the
//                  request, so the worker merging its lesson_plan id in
//                  between cannot be lost; and a compare-and-swap on the id
//                  being replaced.
//     regenerate   {kitId}            a NEW kit (old one kept as history,
//                  source_kit_id = old) from an in-review or rejected kit,
//                  with the old kit's teacher avatar; topic in_review →
//                  generating (the status machine's reopening).
//     save_clips   {kitId, clips}     validateClips (mm:ss, 30–600 s, inside a
//                  known part) → topic_kits.clips, guarded on an editable
//                  kit status.
//   approve (reviewer, editor, admin):
//     approve      {kitId, notes?}    approve_topic_kit() — the RPC moves the
//                  kit to approved, the topic to video_approved and audits, in
//                  ONE transaction. Nothing in this repo writes
//                  topic_kits.status = 'approved' (plan §1.3 gate 2;
//                  catalogue-routes.test.ts and the 0115 test assert it).
//                  Three things must agree (kitAcceptsApprove, mirrored by the
//                  RPC): the kit is in_review, the TOPIC is in_review (the kit
//                  Regenerate leaves behind is history, not a candidate — else
//                  a topic ends with two approved kits), and the kit's ARTICLE
//                  is still the approved version (a kit built from v1 is not
//                  approved after v2 supersedes it; it is regenerated).
//     reject       {kitId, reason, notes}  reject_topic_kit(): reason from the
//                  0112 list and notes REQUIRED; an approved kit's approval is
//                  pulled and the topic reopens to in_review. The topic must be
//                  in_review or video_approved (kitAcceptsReject).
//
// Two locks sit in front of every generations insert and are answered as 409
// with a plain sentence, never a 500: FEATURE_CATALOGUE_GENERATE
// (catalogueGenerateEnabled — a kit spends the same Vertex image capacity
// real lessons do) and CATALOGUE_OWNER_ID (catalogueOwnerId — the rows need an
// owner that is a platform admin, or 0112's guard raises 42501 — mapped to
// its own 409). A kit id from another topic is a 404. Every status transition
// here is a guarded UPDATE read back with .select("id"); zero rows is a 409
// and nothing is audited — and once a kit and its generations EXIST, a later
// step failing is audited with what happened, because the member's screen
// then shows a kit the audit trail would otherwise not know about. The worker
// re-checks everything this route checks (decision 13): human approval is
// enforced twice, nothing auto-approves.

type Action = "generate" | "retry" | "regenerate" | "save_clips" | "approve" | "reject";

const NEEDS: Record<Action, LibraryAction> = {
  generate: "generate",
  retry: "generate",
  regenerate: "generate",
  save_clips: "generate",
  approve: "approve",
  reject: "approve",
};

type Body = {
  action?: unknown;
  teacherAvatar?: unknown;
  kitId?: unknown;
  kind?: unknown;
  clips?: unknown;
  notes?: unknown;
  reason?: unknown;
};

/** Phase 3 builds English kits; translations arrive with the translate phase. */
const LANGUAGE = "en";

/** Without part_plan (0115): the route reads it separately so a database
 *  where 0115 is not yet applied still serves every other action. */
const KIT_COLUMNS =
  "id, topic_id, article_id, language, source_kit_id, teacher_avatar, voice_pair, presentation_generation_id, doc_generation_ids, chapters, clips, status, reject_reason, approved_by, reviewer_id, reviewed_at, notes, created_at, updated_at";

type KitRow = Omit<TopicKit, "part_plan" | "judge_score">;

/** Postgres SQLSTATEs the two RPCs raise on purpose: check_violation for a
 *  kit that is not in an accepting status (or a reject with no reason /
 *  notes), no_data_found for a vanished kit. */
const RPC_REFUSALS = new Set(["23514", "P0002"]);

/** insufficient_privilege from 0112's trigger guard: a params.catalogue row
 *  whose owner is not a platform admin. Operator error, not a server fault. */
const OWNER_NOT_ADMIN = "42501";

/** The kit statuses save_clips may write into (canEditClips) — spelled once
 *  for the guarded UPDATE. */
const CLIP_EDITABLE = ["in_review", "approved", "rejected", "failed"];

type RawMapping = {
  curriculum_nodes:
    | {
        code: string;
        title: string;
        grade: string | null;
        curricula: { id: string; code: string; name: string } | { id: string; code: string; name: string }[] | null;
      }
    | null;
};

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

  /** One of THIS topic's kits, or a 404 — a kit id from another topic is not
   *  reachable through this route. */
  const loadKit = async (raw: unknown) => {
    const kitId = uuid(raw);
    if (!kitId) return { kit: null, response: bad("kitId is required.") };
    const { data, error } = await admin.from("topic_kits").select(KIT_COLUMNS).eq("id", kitId).eq("topic_id", id).maybeSingle();
    if (error) return { kit: null, response: dbError(error) };
    if (!data) return { kit: null, response: NextResponse.json({ error: "Kit not found on this topic." }, { status: 404 }) };
    return { kit: data as unknown as KitRow, response: null };
  };

  /** Every kit of the topic (avatar alternation + the live-kit pre-check). */
  const loadKits = async () => {
    const { data, error } = await admin.from("topic_kits").select("id, status, teacher_avatar, language").eq("topic_id", id);
    return { kits: (data ?? []) as { id: string; status: string; teacher_avatar: string | null; language: string }[], error };
  };

  /** The two locks in front of any generations insert. */
  const generationGate = (): { owner: string; response: null } | { owner: null; response: NextResponse } => {
    if (!catalogueGenerateEnabled()) {
      return { owner: null, response: conflict("Catalogue generation is switched off (FEATURE_CATALOGUE_GENERATE) — nothing was queued.") };
    }
    // catalogueOwnerId: the one reader the pages use too, so the button the
    // panel shows and the answer this gives agree on a malformed value.
    const owner = catalogueOwnerId();
    if (!owner) return { owner: null, response: conflict("The catalogue owner is not configured (CATALOGUE_OWNER_ID) — nothing was queued.") };
    return { owner, response: null };
  };

  const ownerNotAdmin = () =>
    conflict("The catalogue owner is not a platform admin — params.catalogue is reserved for the catalogue system account (0112). Fix CATALOGUE_OWNER_ID or grant the account platform_admins.", {
      code: OWNER_NOT_ADMIN,
    });

  // ── generate / regenerate ──────────────────────────────────────────────────
  // One insert path for both: the difference is where the topic comes FROM
  // (article_approved, or in_review when regenerating), the avatar (chosen,
  // or the old kit's) and the source kit recorded on the new row.
  const createKit = async (opts: { owner: string; articleId: string; teacherAvatar: TeacherAvatar; sourceKitId: string | null; fromTopicStatus: "article_approved" | "in_review"; verb: "kit_generate" | "kit_regenerate" }) => {
    // The curriculum header every catalogue document carries (decision 10),
    // composed here from the same mappings the topic page shows.
    const { data: mapRows, error: mErr } = await admin
      .from("topic_curriculum_map")
      .select("curriculum_nodes(code, title, grade, curricula(id, code, name))")
      .eq("topic_id", id);
    if (mErr) return dbError(mErr);
    const mappings: HeaderMapping[] = ((mapRows ?? []) as unknown as RawMapping[]).map((r) => {
      const n = r.curriculum_nodes;
      const c = n?.curricula ? (Array.isArray(n.curricula) ? (n.curricula[0] ?? null) : n.curricula) : null;
      return { curriculum: c, node: n ? { code: n.code, title: n.title, grade: n.grade } : null };
    });
    const curriculumHeader = curriculumHeaderLines(mappings);

    const { data: kit, error: kErr } = await admin
      .from("topic_kits")
      .insert({
        topic_id: id,
        article_id: opts.articleId,
        language: LANGUAGE,
        source_kit_id: opts.sourceKitId,
        teacher_avatar: opts.teacherAvatar,
        voice_pair: voicePairFor(opts.teacherAvatar, LANGUAGE),
        status: "generating",
      })
      .select("id")
      .single();
    if (kErr) return dbError(kErr);
    const kitId = kit.id as string;

    // The topic move is the race lock: guarded on the status the caller saw
    // and read back. Zero rows means another click (or a reviewer) moved the
    // topic first — this kit row has nothing behind it, so it is taken out.
    const { data: moved, error: tmErr } = await admin.from("topics").update({ status: "generating" }).eq("id", id).eq("status", opts.fromTopicStatus).select("id");
    if (tmErr) return dbError(tmErr);
    if (!moved?.length) {
      await admin.from("topic_kits").delete().eq("id", kitId).eq("status", "generating");
      return conflict(`The topic is no longer ${statusLabel(opts.fromTopicStatus)} — it changed while you were looking; reload to see its current state. Nothing was queued.`, {
        topicStatus: opts.fromTopicStatus,
      });
    }

    const params = kitGenerationParams({ topicId: id, kitId, articleId: opts.articleId, language: LANGUAGE, teacherAvatar: opts.teacherAvatar, curriculumHeader });
    const { data: gens, error: gErr } = await admin.from("generations").insert(kitGenerationRows(opts.owner, params)).select("id, kind");
    if (gErr) {
      // Nothing to build: the kit is failed (with the reason on it) and the
      // topic goes back to where it was, both guarded, so the panel shows an
      // honest failed kit rather than a topic stuck in generating.
      await admin.from("topic_kits").update({ status: "failed", notes: `generations insert failed: ${gErr.message ?? gErr.code ?? "unknown"}` }).eq("id", kitId).eq("status", "generating");
      await admin.from("topics").update({ status: opts.fromTopicStatus }).eq("id", id).eq("status", "generating");
      if (gErr.code === OWNER_NOT_ADMIN) return ownerNotAdmin();
      return dbError(gErr);
    }
    const rows = (gens ?? []) as { id: string; kind: string }[];
    const presentationId = rows.find((r) => r.kind === "presentation")?.id ?? null;
    const docIds: Record<string, string> = {};
    for (const r of rows) if (r.kind !== "presentation") docIds[r.kind] = r.id;

    // From here the kit and its five generations EXIST — the worker will
    // build them and hasLiveKit refuses a second Generate — so whatever
    // follows is audited with what happened, and a bank-job failure is a
    // warning on a 200, not a 500 that reads as "nothing happened".
    const { error: pErr } = await admin.from("topic_kits").update({ presentation_generation_id: presentationId, doc_generation_ids: docIds }).eq("id", kitId);
    // The bank fills alongside the kit (decision 8); a live bank job is
    // reused — it is not this kit's failure.
    const q = pErr ? null : await enqueueQuestionsJob(admin, { topicId: id, articleId: opts.articleId, language: LANGUAGE });
    await audit(admin, m.id, opts.verb, "topic", id, {
      kit_id: kitId,
      article_id: opts.articleId,
      language: LANGUAGE,
      teacher_avatar: opts.teacherAvatar,
      source_kit_id: opts.sourceKitId,
      generation_ids: { presentation: presentationId, ...docIds },
      curriculum_header: curriculumHeader,
      questions_job: q?.ok ? q.jobId : null,
      questions_job_existing: q?.ok ? q.existing : null,
      questions_job_error: q && !q.ok ? (q.error.message ?? q.error.code ?? "unknown") : null,
      pointer_error: pErr ? (pErr.message ?? pErr.code ?? "unknown") : null,
      from: opts.fromTopicStatus,
      to: "generating",
    });
    if (pErr) {
      // The generations are queued but the kit does not point at them: the
      // worker's lifecycle will not see them complete. Say so, with the ids.
      return NextResponse.json(
        {
          error: `The kit and its generations were queued, but the kit could not be pointed at them: ${pErr.message ?? pErr.code ?? "database error"}. The audit row carries the generation ids.`,
          kitId,
          generationIds: { presentation: presentationId, ...docIds },
        },
        { status: 500 },
      );
    }
    return NextResponse.json({
      ok: true,
      kitId,
      generationIds: { presentation: presentationId, ...docIds },
      questionsJobId: q?.ok ? q.jobId : null,
      questionsJobExisting: q?.ok ? q.existing : false,
      warning: q && !q.ok ? `The kit is queued, but the question-bank job could not be enqueued (${q.error.message ?? q.error.code ?? "database error"}) — use Generate questions on the bank page.` : undefined,
    });
  };

  if (action === "generate") {
    const { kits, error: ksErr } = await loadKits();
    if (ksErr) return dbError(ksErr);
    const { data: article, error: aErr } = await admin
      .from("topic_articles")
      .select("id, version, status")
      .eq("topic_id", id)
      .eq("language", LANGUAGE)
      .eq("status", "approved")
      .maybeSingle();
    if (aErr) return dbError(aErr);
    const accepts = kitAcceptsGenerate(topic.status, article?.status ?? null, hasLiveKit(kits, LANGUAGE));
    if (!accepts.ok) return conflict(accepts.why, { topicStatus: topic.status });
    let teacherAvatar: TeacherAvatar;
    if (body.teacherAvatar === undefined || body.teacherAvatar === null || body.teacherAvatar === "") teacherAvatar = nextTeacherAvatar(kits);
    else if (isTeacherAvatar(body.teacherAvatar)) teacherAvatar = body.teacherAvatar;
    else return bad("teacherAvatar must be 'female' or 'male'.");
    const gate = generationGate();
    if (gate.response) return gate.response;
    return createKit({ owner: gate.owner, articleId: article!.id as string, teacherAvatar, sourceKitId: null, fromTopicStatus: "article_approved", verb: "kit_generate" });
  }

  if (action === "regenerate") {
    const { kit, response } = await loadKit(body.kitId);
    if (!kit) return response!;
    const { kits, error: ksErr } = await loadKits();
    if (ksErr) return dbError(ksErr);
    const accepts = kitAcceptsRegenerate(topic.status, kit.status, hasLiveKit(kits, LANGUAGE));
    if (!accepts.ok) return conflict(accepts.why, { topicStatus: topic.status, kitStatus: kit.status });
    // The article the old kit was built from must still be the approved one:
    // a kit is never regenerated from a superseded version (decision 13 — the
    // worker would refuse it anyway; say so here).
    const { data: article, error: aErr } = await admin.from("topic_articles").select("id, version, status").eq("id", kit.article_id).eq("topic_id", id).maybeSingle();
    if (aErr) return dbError(aErr);
    if (!article || article.status !== "approved") {
      return conflict(
        article
          ? `The article this kit was built from (v${article.version}) is ${statusLabel(article.status as string)}, not approved — generate a new kit from the approved version instead.`
          : "The article this kit was built from no longer exists.",
        { articleStatus: article?.status ?? null },
      );
    }
    const teacherAvatar: TeacherAvatar = isTeacherAvatar(kit.teacher_avatar) ? kit.teacher_avatar : nextTeacherAvatar(kits);
    const gate = generationGate();
    if (gate.response) return gate.response;
    return createKit({ owner: gate.owner, articleId: article.id as string, teacherAvatar, sourceKitId: kit.id, fromTopicStatus: "in_review", verb: "kit_regenerate" });
  }

  // ── retry ──────────────────────────────────────────────────────────────────
  if (action === "retry") {
    const { kit, response } = await loadKit(body.kitId);
    if (!kit) return response!;
    if (!canRetryKit(kit.status)) return conflict(`This kit is ${statusLabel(kit.status)} — only a failed or still-generating kit has a piece to retry.`, { status: kit.status });
    const kind = body.kind;
    if (!isKitKind(kind)) return bad("kind must be one of the kit's kinds.");
    const genId = kitGenerationIdFor(kit, kind);
    if (!genId) return bad(`This kit has no ${statusLabel(kind)} to retry.`);
    const { data: old, error: oErr } = await admin.from("generations").select("id, kind, status, params").eq("id", genId).maybeSingle();
    if (oErr) return dbError(oErr);
    if (!old) return conflict("The failed generation no longer exists — regenerate the kit instead.", { kind });
    if (old.status !== "error") return conflict(`The ${statusLabel(kind)} is ${old.status}, not failed — only a failed piece is retried.`, { kind, status: old.status });
    const params = (old.params ?? null) as Record<string, unknown> | null;
    if (!params || params.catalogue !== true) return conflict("That generation is not a catalogue generation; it cannot be retried from here.", { kind });
    if (params[RETRIED_KEY] === true) return conflict(`The ${statusLabel(kind)} was already retried — reload to see the piece that replaced it.`, { kind, generationId: old.id });
    const gate = generationGate();
    if (gate.response) return gate.response;

    // The failed row is taken EXCLUSIVELY first: params.retried flips to true
    // only where it is not set yet (a compare-and-swap read back). Two Retry
    // clicks on the same piece — two tabs, two operators — get one winner;
    // the loser inserts nothing. A generation in status error is finished:
    // nothing else writes its params any more, so the guarded write is safe.
    const lockedParams = { ...params, [RETRIED_KEY]: true };
    const { data: locked, error: lkErr } = await admin.from("generations").update({ params: lockedParams }).eq("id", old.id).eq("status", "error").is(`params->>${RETRIED_KEY}`, null).select("id");
    if (lkErr) return dbError(lkErr);
    if (!locked?.length) return conflict(`The ${statusLabel(kind)} was retried by somebody else a moment ago — reload to see the piece that replaced it; nothing was queued.`, { kind, generationId: old.id });
    /** Undo the lock when nothing was inserted behind it (best effort: the
     *  refusal is answered either way, and a stale lock only blocks a Retry
     *  the operator can Regenerate around). */
    const unlock = () => admin.from("generations").update({ params }).eq("id", old.id).eq("status", "error");

    // Kit back to generating (guarded, read back): if the kit moved meanwhile
    // nothing is inserted. The pointer follows the insert.
    const { data: reopened, error: rErr } = await admin.from("topic_kits").update({ status: "generating" }).eq("id", kit.id).in("status", ["failed", "generating"]).select("id");
    if (rErr) {
      await unlock();
      return dbError(rErr);
    }
    if (!reopened?.length) {
      await unlock();
      return conflict("This kit moved while you were looking — reload to see its current state; nothing was queued.", { status: kit.status });
    }

    // The failed row's INPUTS, not its params verbatim: the worker merges
    // telemetry into a generation's params as it runs, and the retried flag
    // must not travel either.
    const { data: gens, error: gErr } = await admin.from("generations").insert(kitGenerationRows(gate.owner, retryParamsOf(params, kind), [kind])).select("id, kind");
    if (gErr) {
      await unlock();
      if (kit.status === "failed") await admin.from("topic_kits").update({ status: "failed" }).eq("id", kit.id).eq("status", "generating");
      if (gErr.code === OWNER_NOT_ADMIN) return ownerNotAdmin();
      return dbError(gErr);
    }
    const newId = ((gens ?? []) as { id: string }[])[0]?.id ?? null;
    if (!newId) return dbError({ message: "The retry inserted no row." });

    // The pointer: ONE merged statement in the database (0115
    // repoint_kit_generation — jsonb `||`, so a lesson_plan id the worker
    // merged in meanwhile survives) with a compare-and-swap on the id being
    // replaced. A refusal here means somebody moved the pointer under us: the
    // new row is queued but unreferenced, which the audit row records with
    // both ids so the operator can see what to regenerate.
    const { error: pErr } = await admin.rpc("repoint_kit_generation", { p_kit: kit.id, p_kind: kind, p_generation: newId, p_replaces: old.id });
    if (pErr) {
      await audit(admin, m.id, "kit_retry_unpointed", "topic", id, { kit_id: kit.id, kind, replaced_generation_id: old.id, generation_id: newId, error: pErr.message ?? pErr.code ?? "unknown" });
      if (RPC_REFUSALS.has(pErr.code ?? "")) {
        return conflict(`The ${statusLabel(kind)} was queued again, but the kit's pointer moved meanwhile and was left alone: ${pErr.message ?? "check_violation"}. Reload; regenerate the kit if the new piece is not listed.`, {
          code: pErr.code ?? null,
          generationId: newId,
        });
      }
      return dbError(pErr);
    }
    await audit(admin, m.id, "kit_retry", "topic", id, { kit_id: kit.id, kind, replaced_generation_id: old.id, generation_id: newId, from: kit.status, to: "generating" });
    return NextResponse.json({ ok: true, kitId: kit.id, kind, generationId: newId });
  }

  // ── save_clips ─────────────────────────────────────────────────────────────
  if (action === "save_clips") {
    const { kit, response } = await loadKit(body.kitId);
    if (!kit) return response!;
    if (!canEditClips(kit.status)) return conflict("Clips are edited once the worker has written them — this kit is still generating.", { status: kit.status });
    // part_plan bounds the edit (a clip must end inside its part). 0115 not
    // applied means no plan: the parts are then unknown and any part is
    // accepted — the same as a kit whose plan is still empty.
    let plan: PartPlanRow[] = [];
    const { data: planRow, error: plErr } = await admin.from("topic_kits").select("part_plan").eq("id", kit.id).maybeSingle();
    if (plErr && !(catalogueColumnMissing(plErr) && /part_plan/i.test(plErr.message ?? ""))) return dbError(plErr);
    if (!plErr && Array.isArray(planRow?.part_plan)) plan = planRow.part_plan as PartPlanRow[];
    const v = validateClips(body.clips, partDurationsOf(plan));
    if (!v.ok) return NextResponse.json({ error: v.errors[0] ?? "The clips are not valid.", errors: v.errors }, { status: 400 });
    const { data: written, error: uErr } = await admin.from("topic_kits").update({ clips: v.clips }).eq("id", kit.id).in("status", CLIP_EDITABLE).select("id");
    if (uErr) return dbError(uErr);
    if (!written?.length) return conflict("This kit went back to generating while you were editing — the worker will rewrite the clips; nothing was saved.", { status: kit.status });
    await audit(admin, m.id, "kit_clips_save", "topic", id, { kit_id: kit.id, clips: v.clips.length, parts: [...new Set(v.clips.map((c) => c.part))], plan_known: plan.length > 0, migration: plErr ? CATALOGUE_KITS_MIGRATION : null });
    return NextResponse.json({ ok: true, clips: v.clips });
  }

  // ── approve ────────────────────────────────────────────────────────────────
  // Gate 2 (plan §1.3): the RPC is the ONLY writer of the approved status —
  // it locks the kit and the topic, records the reviewer and time, moves the
  // topic to video_approved and writes the audit row, atomically. This
  // handler never touches topic_kits.status itself.
  if (action === "approve") {
    const { kit, response } = await loadKit(body.kitId);
    if (!kit) return response!;
    // The kit's own article — it must still be the approved version (the
    // article is the kit's source of truth; a superseded one is regenerated,
    // not approved). The RPC checks the same; this is the friendly sentence.
    const { data: article, error: aErr } = await admin.from("topic_articles").select("id, status").eq("id", kit.article_id).maybeSingle();
    if (aErr) return dbError(aErr);
    const accepts = kitAcceptsApprove(topic.status, kit.status, (article?.status as string | undefined) ?? null);
    if (!accepts.ok) return conflict(accepts.why, { status: kit.status, topicStatus: topic.status, articleStatus: article?.status ?? null });
    const notes = text(body.notes, 2000) || null;
    const { data, error } = await admin.rpc("approve_topic_kit", { p_kit: kit.id, p_reviewer: m.id, p_notes: notes });
    if (error) {
      if (RPC_REFUSALS.has(error.code ?? "") || /not reviewable|not found/i.test(error.message ?? "")) {
        return conflict(error.message ?? "The kit could not be approved.", { code: error.code ?? null });
      }
      return dbError(error);
    }
    // Audited by the RPC (library_kit_approve on the topic).
    return NextResponse.json({ ok: true, kit: data });
  }

  // ── reject ─────────────────────────────────────────────────────────────────
  if (action === "reject") {
    const { kit, response } = await loadKit(body.kitId);
    if (!kit) return response!;
    const accepts = kitAcceptsReject(topic.status, kit.status);
    if (!accepts.ok) return conflict(accepts.why, { status: kit.status, topicStatus: topic.status });
    const reason = body.reason;
    if (!isKitRejectReason(reason)) return bad("Pick a reject reason — it steers the regeneration.");
    const notes = text(body.notes, 2000);
    if (!notes) return bad("Say why — notes are required to reject a kit.");
    const { data, error } = await admin.rpc("reject_topic_kit", { p_kit: kit.id, p_reviewer: m.id, p_reason: reason, p_notes: notes });
    if (error) {
      if (RPC_REFUSALS.has(error.code ?? "") || /not reviewable|not found|required/i.test(error.message ?? "")) {
        return conflict(error.message ?? "The kit could not be rejected.", { code: error.code ?? null });
      }
      return dbError(error);
    }
    // Audited by the RPC (library_kit_reject on the topic, with the reason).
    return NextResponse.json({ ok: true, kit: data });
  }

  return bad("Unknown action.");
}
