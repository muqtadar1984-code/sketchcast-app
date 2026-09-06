import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isLibraryMemberRequest } from "@/utils/library-access";
import { libraryAllows } from "@/utils/library-routing";
import { catalogueGenerateEnabled, catalogueOwnerId } from "@/utils/flags";
import { curriculumHeaderLines, type HeaderMapping } from "@/utils/catalogue/kit";
import { canCompose, modeCounts, seedOf, validateBlueprintSpec, type Blueprint, type TopicQuestion } from "@/utils/catalogue/questions";
import { audit, bad, conflict, dbError, notFound, readJson, uuid } from "../../../lib";

export const runtime = "nodejs";

// Compose a worksheet from one topic's approved question bank (Phase 3, spec
// decision 9). POST {blueprintId, seed?} — `generate` role: composing inserts
// a `generations` row the worker builds, i.e. it spends build capacity, which
// is exactly what LibraryAction's `generate` covers ("trigger kit / translation
// jobs, compose worksheets"). Editing the ITEMS is edit_article; printing them
// is not. Today editor and admin hold both, so nothing changes for anyone —
// the first role granted edit_article without generate (a subject editor who
// may not spend capacity) is what this keeps out.
//
// The portal does not pick the items: it checks that the bank CAN satisfy the
// blueprint (canCompose — the worker composer's bucket arithmetic, so the 409
// here names exactly the buckets the worker would raise Unsatisfiable on),
// then records the request as
//   1. a `question_sets` row (blueprint, this topic, language, the seed, who
//      asked; question_ids empty until the worker fills it), and
//   2. ONE `generations` row of kind `worksheet` owned by the catalogue system
//      account (CATALOGUE_OWNER_ID) with params {catalogue: true, topic_id,
//      question_set_id, language, curriculum_header} and book_id / chapter_ref
//      NULL. create_job_for_generation() (0115) queues the job and copies the
//      catalogue flag into jobs.params, so the worker's LAST lane picks it up
//      only when no user builder is live and the quota window is open
//      (decision 12 — never starve). The worker's catalogue branch sees
//      params.question_set_id and renders the bank worksheet (student DOCX +
//      answer key) through catalogue.composer.render_question_set.
// The set's rendered_generation_id is then the generation. A generation the
// database refuses (42501: the 0112 guard — the owner is not a platform admin,
// or the flag was carried by a client) is a 409 that names the cause, and the
// set row is taken back out so no orphan set points at nothing.
//
// The curriculum header (decision 10) is composed here from the topic's
// mappings by the kit route's own helper (kit.ts curriculumHeaderLines) —
// `<curriculum name> <code> · <codes>`, one line per curriculum — so a
// composed worksheet carries the same header block as the kit's documents.
// Audited on the topic as library_compose.

type Body = { blueprintId?: unknown; seed?: unknown };

const LANGUAGE = "en";
const GENERATION_KIND = "worksheet";

const BLUEPRINT_COLUMNS = "id, name, scope, curriculum_id, spec, min_maturity, status, created_by, created_at";

type RawCurriculum = { id: string; code: string; name: string };
type RawMapping = {
  node_id: string;
  curriculum_nodes: { code: string; grade: string | null; title: string; curricula: RawCurriculum | RawCurriculum[] | null } | null;
};

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const m = await isLibraryMemberRequest();
  if (!m) return notFound();
  // Composing inserts a generation (the worker renders it): `generate`, the
  // same action every other catalogue generations insert asks for.
  if (!libraryAllows(m.role, "generate")) return notFound();

  const { id: rawId } = await ctx.params;
  const id = uuid(rawId);
  if (!id) return notFound();

  const body = await readJson<Body>(request);
  if (!body) return bad("Invalid JSON.");
  const blueprintId = uuid(body.blueprintId);
  if (!blueprintId) return bad("blueprintId is required.");
  const seed = seedOf(body.seed);
  if (seed === null) return bad("seed must be a whole number from 0 to 2147483647 (or blank for a fresh one).");

  if (!catalogueGenerateEnabled()) {
    return conflict("Catalogue generation is off (FEATURE_CATALOGUE_GENERATE). Nothing was composed.");
  }
  // catalogueOwnerId: the one reader the pages use too (a malformed value
  // greys the Compose button with the same sentence this answers).
  const owner = catalogueOwnerId();
  if (!owner) return conflict("Catalogue owner not configured (CATALOGUE_OWNER_ID) — the worksheet would have no account to belong to.");

  const admin = createAdminClient();
  const { data: topic, error: tErr } = await admin.from("topics").select("id, title, status, bank_maturity").eq("id", id).maybeSingle();
  if (tErr) return dbError(tErr);
  if (!topic) return NextResponse.json({ error: "Topic not found." }, { status: 404 });

  const { data: bpRow, error: bErr } = await admin.from("question_set_blueprints").select(BLUEPRINT_COLUMNS).eq("id", blueprintId).maybeSingle();
  if (bErr) return dbError(bErr);
  if (!bpRow) return NextResponse.json({ error: "Blueprint not found." }, { status: 404 });
  const blueprint = bpRow as unknown as Blueprint;
  if (blueprint.status !== "active") return conflict(`The blueprint "${blueprint.name}" is retired — reactivate it, or pick another.`, { status: blueprint.status });
  const spec = validateBlueprintSpec(blueprint.spec);
  if (!spec.ok) return conflict(`The blueprint "${blueprint.name}" has an invalid spec: ${spec.errors[0]}`, { errors: spec.errors });

  // The live approved counts per (answer_mode, difficulty): what the worker
  // will draw from. Checked here so the member gets the shortfall as a 409
  // with reasons instead of a failed generation an hour later.
  const { data: approved, error: qErr } = await admin
    .from("topic_questions")
    .select("answer_mode, difficulty, status")
    .eq("topic_id", id)
    .eq("language", LANGUAGE)
    .eq("status", "approved");
  if (qErr) return dbError(qErr);
  const check = canCompose(spec.spec, modeCounts((approved ?? []) as Pick<TopicQuestion, "answer_mode" | "difficulty" | "status">[]), {
    have: topic.bank_maturity,
    need: blueprint.min_maturity,
  });
  if (!check.ok) {
    return conflict(`The bank cannot fill "${blueprint.name}" yet: ${check.reasons.join("; ")}.`, { reasons: check.reasons, plan: check.plan });
  }

  // The curriculum header: every mapping's curriculum and code.
  const { data: mapRows, error: mErr } = await admin.from("topic_curriculum_map").select("node_id, curriculum_nodes(code, grade, title, curricula(id, code, name))").eq("topic_id", id);
  if (mErr) return dbError(mErr);
  const mappings: HeaderMapping[] = ((mapRows ?? []) as unknown as RawMapping[]).map((r) => {
    const n = r.curriculum_nodes;
    const c = n?.curricula ? (Array.isArray(n.curricula) ? (n.curricula[0] ?? null) : n.curricula) : null;
    return { curriculum: c, node: n ? { code: n.code, title: n.title, grade: n.grade } : null };
  });
  const curriculumHeader = curriculumHeaderLines(mappings);

  // 1. The set — who asked for what, with which seed. question_ids stays
  //    empty until the worker composes; rendered_generation_id follows.
  const { data: set, error: sErr } = await admin
    .from("question_sets")
    .insert({ blueprint_id: blueprint.id, topic_ids: [id], language: LANGUAGE, question_ids: [], seed, requested_by: m.id })
    .select("id")
    .single();
  if (sErr) return dbError(sErr);

  // 2. The generation, owned by the system account. book_id / chapter_ref /
  //    school_id are NULL on purpose — that is what makes the row a catalogue
  //    row to every 0112-classified trigger (the same shape as the kit route's
  //    kitGenerationRows; spelled here because the params are the composer's,
  //    not a kit's: the worker branches on question_set_id). The trigger
  //    makes the job.
  const { data: gen, error: gErr } = await admin
    .from("generations")
    .insert({
      kind: GENERATION_KIND,
      owner_id: owner,
      book_id: null,
      chapter_ref: null,
      school_id: null,
      title: `${topic.title} — ${blueprint.name}`,
      status: "queued",
      params: {
        catalogue: true,
        topic_id: id,
        question_set_id: set.id,
        blueprint_id: blueprint.id,
        seed,
        language: LANGUAGE,
        curriculum_header: curriculumHeader,
      },
    })
    .select("id")
    .single();
  if (gErr) {
    // No generation ⇒ no set: a set that points at nothing would sit in the
    // list forever as "not rendered".
    await admin.from("question_sets").delete().eq("id", set.id).is("rendered_generation_id", null);
    if (gErr.code === "42501") {
      // The 0112 guard: params.catalogue = true requires a service-role insert
      // for a platform-admin owner. CATALOGUE_OWNER_ID is not one.
      return conflict("The database refused a catalogue generation for the configured owner — CATALOGUE_OWNER_ID must be a platform admin's profile id.", { code: gErr.code });
    }
    return dbError(gErr);
  }
  const { error: linkErr } = await admin.from("question_sets").update({ rendered_generation_id: gen.id }).eq("id", set.id);
  if (linkErr) return dbError(linkErr);

  await audit(admin, m.id, "compose", "topic", id, {
    question_set_id: set.id,
    generation_id: gen.id,
    blueprint_id: blueprint.id,
    blueprint: blueprint.name,
    seed,
    language: LANGUAGE,
    plan: check.plan,
    curriculum_header: curriculumHeader,
  });
  return NextResponse.json({ ok: true, questionSetId: set.id, generationId: gen.id, plan: check.plan });
}
