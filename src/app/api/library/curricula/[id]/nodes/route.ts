import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isLibraryMemberRequest } from "@/utils/library-access";
import { searchOr } from "@/utils/catalogue/status";
import type { NodeHit } from "@/utils/catalogue/types";
import { dbError, notFound, uuid } from "../../../lib";

export const runtime = "nodejs";

// GET /api/library/curricula/[id]/nodes?q=&grade=&limit= — the node picker on
// the topic page's "Add mapping" (any member). Searches code and title within
// ONE curriculum; results come back in the syllabus order.

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const m = await isLibraryMemberRequest();
  if (!m) return notFound();

  const { id: rawId } = await ctx.params;
  const curriculumId = uuid(rawId);
  if (!curriculumId) return notFound();

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const grade = (url.searchParams.get("grade") ?? "").trim();
  const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "30", 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 30;

  const admin = createAdminClient();
  let query = admin
    .from("curriculum_nodes")
    .select("id, code, grade, strand, sub_strand, title")
    .eq("curriculum_id", curriculumId)
    .order("sort", { ascending: true, nullsFirst: false })
    .order("code", { ascending: true })
    .limit(limit);
  if (grade) query = query.eq("grade", grade);
  const search = searchOr(q, ["code", "title", "strand", "sub_strand"]);
  if (search) query = query.or(search);
  const { data, error } = await query;
  if (error) return dbError(error);
  return NextResponse.json({ nodes: (data ?? []) as NodeHit[] });
}
