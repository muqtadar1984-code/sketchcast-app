import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isLibraryMemberRequest } from "@/utils/library-access";
import { nodeKind, searchOr } from "@/utils/catalogue/status";
import type { NodeHit } from "@/utils/catalogue/types";
import { dbError, notFound, uuid } from "../../../lib";

export const runtime = "nodejs";

// GET /api/library/curricula/[id]/nodes?q=&grade=&limit= — the node picker on
// the topic page's "Add mapping" (any member). Searches code and title within
// ONE curriculum; results come back in the syllabus order. Each hit carries
// its resolved `kind` (the 0113 column, else inferred from the code) and the
// number of direct `children`, so the panel can offer "map all N objectives"
// when a group node is picked. The count is a second query over the hits'
// ids, never a per-row lookup.

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
    .select("id, code, grade, strand, sub_strand, title, parent_id, kind")
    .eq("curriculum_id", curriculumId)
    .order("sort", { ascending: true, nullsFirst: false })
    .order("code", { ascending: true })
    .limit(limit);
  if (grade) query = query.eq("grade", grade);
  const search = searchOr(q, ["code", "title", "strand", "sub_strand"]);
  if (search) query = query.or(search);
  const { data, error } = await query;
  if (error) return dbError(error);
  type Row = { id: string; code: string; grade: string | null; strand: string | null; sub_strand: string | null; title: string; parent_id: string | null; kind: string | null };
  const rows = (data ?? []) as Row[];
  const childCount = new Map<string, number>();
  if (rows.length) {
    const { data: kids, error: kErr } = await admin
      .from("curriculum_nodes")
      .select("parent_id")
      .in("parent_id", rows.map((r) => r.id))
      .limit(5000);
    if (kErr) return dbError(kErr);
    for (const k of (kids ?? []) as { parent_id: string | null }[]) {
      if (k.parent_id) childCount.set(k.parent_id, (childCount.get(k.parent_id) ?? 0) + 1);
    }
  }
  const nodes: NodeHit[] = rows.map((r) => ({
    id: r.id,
    code: r.code,
    grade: r.grade,
    strand: r.strand,
    sub_strand: r.sub_strand,
    title: r.title,
    kind: nodeKind(r),
    children: childCount.get(r.id) ?? 0,
  }));
  return NextResponse.json({ nodes });
}
