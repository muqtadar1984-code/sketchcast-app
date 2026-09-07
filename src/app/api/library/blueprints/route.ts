import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isLibraryMemberRequest } from "@/utils/library-access";
import { validateBlueprint, type Blueprint } from "@/utils/catalogue/questions";
import { audit, bad, conflict, dbError, notFound, readJson, uuid } from "../lib";

export const runtime = "nodejs";

// The composer's presets (0112 question_set_blueprints; Phase 3). POST
// {action, …} — curate role (the presets are taxonomy-level configuration,
// not a review act). Every action is audited as library_blueprint_<verb> on
// the BLUEPRINT (target_kind 'blueprint').
//
//   create      {blueprint: {name, scope, min_maturity, spec}}
//   update      {blueprintId, blueprint}   the same shape; the seeded presets
//               are editable like any other row — a changed spec applies to
//               the NEXT compose only (a question_sets row keeps its
//               blueprint_id, and its rendered worksheet is already a file)
//   retire      {blueprintId}              active → retired: hidden from the
//               Compose select and refused by the compose route; existing
//               sets keep pointing at it (on delete restrict — nothing is
//               ever deleted here)
//   reactivate  {blueprintId}              retired → active
//
// The spec is validated by validateBlueprintSpec (preset, objective_ratio
// 0..1, difficulty_mix "1".."5" summing to 1 ±0.01, count 1..60, total_marks
// 1..200) so the compose route's arithmetic never meets a malformed row.
// `name` is unique (0112): a 23505 is the 409 that names the clash. The two
// status transitions are guarded UPDATEs read back — zero rows means the row
// moved between the read and the write and answers 409, nothing audited.

type Action = "create" | "update" | "retire" | "reactivate";
const ACTIONS: ReadonlySet<string> = new Set<Action>(["create", "update", "retire", "reactivate"]);

type Body = { action?: unknown; blueprintId?: unknown; blueprint?: unknown };

const BLUEPRINT_COLUMNS = "id, name, scope, curriculum_id, spec, min_maturity, status, created_by, created_at";

export async function POST(request: Request) {
  const m = await isLibraryMemberRequest("curate");
  if (!m) return notFound();

  const body = await readJson<Body>(request);
  if (!body) return bad("Invalid JSON.");
  const action = body.action as Action;
  if (typeof action !== "string" || !ACTIONS.has(action)) return bad("Unknown action.");

  const admin = createAdminClient();

  // ── create ─────────────────────────────────────────────────────────────────
  if (action === "create") {
    const v = validateBlueprint(body.blueprint);
    if (!v.ok) return NextResponse.json({ error: v.errors[0] ?? "The blueprint is not valid.", errors: v.errors }, { status: 400 });
    const b = v.blueprint;
    const { data, error } = await admin
      .from("question_set_blueprints")
      .insert({ name: b.name, scope: b.scope, spec: b.spec, min_maturity: b.min_maturity, status: "active", created_by: m.id })
      .select("id")
      .single();
    if (error) {
      if (error.code === "23505") return conflict(`A blueprint named "${b.name}" already exists — pick another name, or edit that one.`, { name: b.name });
      return dbError(error);
    }
    await audit(admin, m.id, "blueprint_create", "blueprint", data.id, { name: b.name, scope: b.scope, min_maturity: b.min_maturity, spec: b.spec });
    return NextResponse.json({ ok: true, id: data.id });
  }

  // The other three act on one existing row.
  const blueprintId = uuid(body.blueprintId);
  if (!blueprintId) return bad("blueprintId is required.");
  const { data: row, error: rErr } = await admin.from("question_set_blueprints").select(BLUEPRINT_COLUMNS).eq("id", blueprintId).maybeSingle();
  if (rErr) return dbError(rErr);
  if (!row) return NextResponse.json({ error: "Blueprint not found." }, { status: 404 });
  const existing = row as unknown as Blueprint;

  // ── update ─────────────────────────────────────────────────────────────────
  if (action === "update") {
    const v = validateBlueprint(body.blueprint);
    if (!v.ok) return NextResponse.json({ error: v.errors[0] ?? "The blueprint is not valid.", errors: v.errors }, { status: 400 });
    const b = v.blueprint;
    const { data: written, error } = await admin
      .from("question_set_blueprints")
      .update({ name: b.name, scope: b.scope, spec: b.spec, min_maturity: b.min_maturity })
      .eq("id", existing.id)
      .select("id");
    if (error) {
      if (error.code === "23505") return conflict(`A blueprint named "${b.name}" already exists — pick another name.`, { name: b.name });
      return dbError(error);
    }
    if (!written?.length) return conflict("The blueprint vanished while you were editing — reload.");
    await audit(admin, m.id, "blueprint_update", "blueprint", existing.id, {
      from: { name: existing.name, scope: existing.scope, min_maturity: existing.min_maturity, spec: existing.spec },
      to: { name: b.name, scope: b.scope, min_maturity: b.min_maturity, spec: b.spec },
    });
    return NextResponse.json({ ok: true });
  }

  // ── retire / reactivate ────────────────────────────────────────────────────
  const to = action === "retire" ? "retired" : "active";
  const from = action === "retire" ? "active" : "retired";
  if (existing.status !== from) return conflict(`"${existing.name}" is already ${existing.status}.`, { status: existing.status });
  const { data: moved, error } = await admin.from("question_set_blueprints").update({ status: to }).eq("id", existing.id).eq("status", from).select("id");
  if (error) return dbError(error);
  if (!moved?.length) return conflict(`"${existing.name}" changed while you were looking — reload to see its current state.`, { status: existing.status });
  await audit(admin, m.id, `blueprint_${action}`, "blueprint", existing.id, { name: existing.name, from, to });
  return NextResponse.json({ ok: true, status: to });
}
