import { skShellEnabledFor } from "@/utils/flags";
import { learnerAllowed, learnerKits, type LearnerGen, type LearnerKit, type LearnerShare } from "./learner";

// The student Board's reads (learner mode, phase 1). Everything goes through
// the STUDENT'S OWN session: RLS confines her to what she may read, and
// learner.ts then keeps only what one of HER generation_shares rows names.
// The service role is used by the callers for one thing only — signing the
// artifact paths of pieces this module already proved are hers to see.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Session = { from: (table: string) => any };
/* eslint-enable @typescript-eslint/no-explicit-any */
type GateUser = { id: string; email?: string | null; email_confirmed_at?: string | null };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Is this signed-in user a learner on the Board? (role student + SK on.) Never throws. */
export async function learnerGate(supabase: Session, user: GateUser): Promise<{ ok: boolean; role: string | null; schoolId: string | null }> {
  try {
    const { data: profile } = await supabase.from("profiles").select("role, school_id").eq("id", user.id).maybeSingle();
    const role = (profile?.role as string | null) ?? null;
    const schoolId = (profile?.school_id as string | null) ?? null;
    if (role !== "student") return { ok: false, role, schoolId };
    const skOn = await skShellEnabledFor(supabase as never, user, role, schoolId);
    return { ok: learnerAllowed({ role, skOn }), role, schoolId };
  } catch {
    return { ok: false, role: null, schoolId: null };
  }
}

/** Her assigned kits (learner.ts), from one read of her generations and one of her shares. */
export async function loadLearnerKits(supabase: Session): Promise<LearnerKit[]> {
  const [gens, shares] = await Promise.all([
    supabase
      .from("generations")
      .select("id, kind, title, chapter_ref, book_id, params, status, withdrawn_at, created_at, artifacts(kind, storage_path)")
      .order("created_at", { ascending: false }),
    supabase.from("generation_shares").select("generation_id, due_at, created_at"),
  ]);
  const rows = ((gens?.data ?? []) as LearnerGen[]).map((g) => ({ ...g, artifacts: g.artifacts ?? [] }));
  return learnerKits(rows, (shares?.data ?? []) as LearnerShare[]);
}

/**
 * Is this generation assigned to HER? One of her generation_shares rows must
 * name it (RLS: shares_student_read / shares_child_read show a student only
 * the shares to her classes and to her). Never throws; anything odd is "no".
 */
export async function sharedToMe(supabase: Session, generationId: string): Promise<boolean> {
  if (!UUID_RE.test(generationId)) return false;
  try {
    const { data, error } = await supabase.from("generation_shares").select("generation_id").eq("generation_id", generationId).limit(1);
    return !error && Array.isArray(data) && data.some((r: { generation_id?: string }) => r?.generation_id === generationId);
  } catch {
    return false;
  }
}
