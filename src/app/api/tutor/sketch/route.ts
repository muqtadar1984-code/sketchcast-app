import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { aiTutorEnabled, aiTutorRequireProPlus, aiTutorSketchEnabled } from "@/utils/flags";
import { TUTOR_MODELS, toClaudeHistory } from "@/utils/tutor/models";
import { resolveTutorContext, loadGrounding, hasLessonGrounding, tutorEntitled, logMessage, anthropic } from "@/utils/tutor/service";
import { buildSketchPrompt, parseSketchSpec, canonicalSpecHash, SKETCH_MONTHLY_CAP } from "@/utils/tutor/sketch";

export const runtime = "nodejs";

// Sketches use the free Edge voice for now (premium narration is a later polish);
// the worker resolves a null voice_id to its Edge default. Fixed here so the cache
// key stays stable.
const SKETCH_VOICE = "edge-aria";

// POST — the Coach authors ONE grounded slide spec, then enqueues a render (or
// returns a cached clip). GET — poll a queued sketch for its finished clip URL.
// Rendering is async (it lives in the batch worker), so the panel enqueues then
// polls. Identical specs replay from the shared cache for $0.
export async function POST(request: Request) {
  if (!aiTutorEnabled() || !aiTutorSketchEnabled()) return NextResponse.json({ error: "Not available." }, { status: 404 });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body: { generationId?: string; concept?: string; history?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const generationId = String(body.generationId ?? "");
  const concept = String(body.concept ?? "").trim().slice(0, 200);
  const history = toClaudeHistory(body.history);
  if (!generationId) return NextResponse.json({ error: "Missing lesson." }, { status: 400 });

  const admin = createAdminClient();
  const ctx = await resolveTutorContext(admin, user.id, generationId);
  if (!ctx) return NextResponse.json({ error: "This lesson isn't assigned to you." }, { status: 403 });
  if (aiTutorRequireProPlus() && !(await tutorEntitled(admin, generationId))) {
    return NextResponse.json({ error: "The AI Coach is a Pro+ feature.", upgrade: true }, { status: 403 });
  }
  const grounding = await loadGrounding(admin, ctx.bookId, ctx.chapterNum);
  // Index-time rows carry only source_text — sketches need LESSON grounding.
  if (!hasLessonGrounding(grounding))
    return NextResponse.json({ error: "The tutor isn't ready for this lesson yet." }, { status: 409 });

  // 1) Author the slide spec + narration (one cheap, grounded, cached call).
  let parsed;
  try {
    const { instructions, context } = buildSketchPrompt(grounding, concept);
    const resp = await anthropic().messages.create({
      model: TUTOR_MODELS.cheap,
      max_tokens: 600,
      system: [
        { type: "text", text: instructions },
        { type: "text", text: context, cache_control: { type: "ephemeral" } },
      ],
      // Prior turns give the drawing memory of the thread — a follow-up like
      // "can you show me how" then resolves against what was just discussed.
      messages: [...history, { role: "user", content: concept || "Draw the key idea of this lesson." }],
    });
    const raw = resp.content.find((b) => b.type === "text");
    parsed = parseSketchSpec(raw && "text" in raw ? raw.text : "");
  } catch (e) {
    console.error("tutor.sketch.author", (e as Error).message);
    return NextResponse.json({ error: "Coach couldn't design that sketch — try asking a question." }, { status: 502 });
  }
  if (!parsed) return NextResponse.json({ error: "That one's hard to draw — try asking a question instead." }, { status: 422 });

  const { spec, narration } = parsed;
  const specHash = canonicalSpecHash(spec, narration, SKETCH_VOICE);
  const key = { book_id: ctx.bookId, chapter_num: ctx.chapterNum, spec_hash: specHash } as const;

  // 2) Cache-first (shared across every student).
  const { data: existing } = await admin
    .from("tutor_sketch")
    .select("id, status, storage_path, updated_at")
    .match(key)
    .maybeSingle();
  if (existing?.status === "done" && existing.storage_path) {
    const signed = await admin.storage.from("tutor-sketch").createSignedUrl(existing.storage_path as string, 3600);
    if (signed.data?.signedUrl) return NextResponse.json({ status: "done", url: signed.data.signedUrl });
    return NextResponse.json({ error: "Couldn't load that sketch — please try again." }, { status: 502 });
  }
  // An in-flight render coalesces onto the existing row — UNLESS it's been stuck
  // 'processing' too long (a dead/killed worker), in which case we re-enqueue it
  // so a crashed render can never leave students polling forever.
  const staleProcessing =
    existing?.status === "processing" &&
    !!existing.updated_at &&
    Date.now() - new Date(existing.updated_at as string).getTime() > 3 * 60 * 1000;
  if (existing && (existing.status === "queued" || (existing.status === "processing" && !staleProcessing))) {
    return NextResponse.json({ status: "pending", sketchId: existing.id });
  }

  // 3) Miss / prior error / dead render → reserve the monthly cap, then (re)enqueue.
  const period = new Date().toISOString().slice(0, 7);
  const { data: allowed } = await admin.rpc("tutor_sketch_reserve", { p_user: user.id, p_period: period, p_cap: SKETCH_MONTHLY_CAP });
  if (allowed !== true) return NextResponse.json({ error: "You've reached this month's sketch limit." }, { status: 429 });

  const { data: gen } = await admin.from("generations").select("owner_id").eq("id", generationId).maybeSingle();
  const row = {
    ...key,
    spec,
    narration,
    voice_id: null,
    owner_id: (gen?.owner_id as string | undefined) ?? null,
    requested_by: user.id,
    status: "queued",
    storage_path: null,
    error: null,
    updated_at: new Date().toISOString(),
  };

  let sketchId = existing?.id as string | undefined;
  if (existing && (existing.status === "error" || staleProcessing)) {
    await admin.from("tutor_sketch").update(row).eq("id", existing.id);
  } else {
    const ins = await admin.from("tutor_sketch").insert(row).select("id").maybeSingle();
    if (ins.error) {
      // Lost an insert race — coalesce onto the row the other request created.
      const { data: r2 } = await admin.from("tutor_sketch").select("id").match(key).maybeSingle();
      sketchId = r2?.id as string | undefined;
    } else {
      sketchId = ins.data?.id as string | undefined;
    }
  }
  if (!sketchId) return NextResponse.json({ error: "Couldn't start the sketch — please try again." }, { status: 500 });

  // Record the move on the transcript (mastery/recap; no raw draw stored).
  await logMessage(admin, {
    studentId: user.id,
    generationId,
    bookId: ctx.bookId,
    chapterNum: ctx.chapterNum,
    role: "coach",
    content: `Sketched: ${spec.heading}`,
    tutorMove: "sketch",
  });

  return NextResponse.json({ status: "pending", sketchId });
}

export async function GET(request: Request) {
  if (!aiTutorEnabled() || !aiTutorSketchEnabled()) return NextResponse.json({ error: "Not available." }, { status: 404 });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const url = new URL(request.url);
  const sketchId = url.searchParams.get("sketchId") ?? "";
  const generationId = url.searchParams.get("generationId") ?? "";
  if (!sketchId || !generationId) return NextResponse.json({ error: "Missing sketch." }, { status: 400 });

  const admin = createAdminClient();
  // Authorize by LESSON, not by who first requested it: the sketch cache is shared
  // across students, so a student who coalesced onto another's in-flight render
  // must still be able to poll it. Any student ASSIGNED this lesson may poll a
  // sketch whose book+chapter matches — same fence as the rest of the tutor.
  const ctx = await resolveTutorContext(admin, user.id, generationId);
  if (!ctx) return NextResponse.json({ error: "This lesson isn't assigned to you." }, { status: 403 });
  if (aiTutorRequireProPlus() && !(await tutorEntitled(admin, generationId))) {
    return NextResponse.json({ error: "The AI Coach is a Pro+ feature.", upgrade: true }, { status: 403 });
  }

  const { data: row } = await admin
    .from("tutor_sketch")
    .select("status, storage_path, book_id, chapter_num")
    .eq("id", sketchId)
    .maybeSingle();
  if (!row || row.book_id !== ctx.bookId || row.chapter_num !== ctx.chapterNum) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  if (row.status === "done" && row.storage_path) {
    const signed = await admin.storage.from("tutor-sketch").createSignedUrl(row.storage_path as string, 3600);
    if (signed.data?.signedUrl) return NextResponse.json({ status: "done", url: signed.data.signedUrl });
    return NextResponse.json({ status: "error" }); // rendered but can't be signed → let the client stop
  }
  if (row.status === "error") return NextResponse.json({ status: "error" });
  return NextResponse.json({ status: "pending" });
}
