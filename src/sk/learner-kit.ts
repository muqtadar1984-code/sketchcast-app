// The kit open on a STUDENT'S Board (learner mode, 2026-10-31), for SK's
// Board reads (documents.ts openUnitSlides / openUnitDeckSlide).
//
// A teacher's kit is resolved by kitOfGeneration with HER owner filter. A
// student owns nothing: the kit on her Board is her TEACHER'S, assigned to
// her. So the generation must first be assigned to her (one of her own
// generation_shares rows names it, read through HER session — sharedToMe),
// then the kit is resolved under its real owner, and finally narrowed to the
// pieces that are ALSO assigned to her. A piece her teacher did not assign
// (the lesson plan, the question bank, a worksheet kept back) never reaches
// her through SK. kit-docs.ts readDoc still refuses every teacher-only
// document for a student on top of this.

import { kitOfGeneration, type DocsAdmin, type KitDocs } from "@/sk/kit-docs";
import { sharedToMe } from "@/utils/present/learner-server";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type LearnerSession = { from: (table: string) => any };
/* eslint-enable @typescript-eslint/no-explicit-any */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function learnerKitOfGeneration(admin: DocsAdmin, session: LearnerSession, generationId: string): Promise<KitDocs | null> {
  if (!UUID.test(generationId) || !(await sharedToMe(session, generationId))) return null;
  const { data: g } = await admin.from("generations").select("id, owner_id").eq("id", generationId).maybeSingle();
  const owner = (g as { id?: string; owner_id?: string } | null)?.owner_id;
  if (!owner || (g as { id?: string }).id !== generationId) return null;
  const kit = await kitOfGeneration(admin, owner, generationId);
  if (!kit) return null;
  const ids = kit.pieces.map((p) => p.id);
  if (!ids.length) return null;
  const { data: rows, error } = await session.from("generation_shares").select("generation_id").in("generation_id", ids);
  if (error || !Array.isArray(rows)) return null;
  const mine = new Set((rows as { generation_id?: string }[]).map((r) => r?.generation_id).filter((x): x is string => !!x));
  const pieces = kit.pieces.filter((p) => mine.has(p.id));
  return pieces.length ? { ...kit, pieces } : null;
}
