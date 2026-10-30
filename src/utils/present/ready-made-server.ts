import "server-only";
import { boardBooks, boardKits, type BoardBook, type BoardKit, type CatalogueOffer, type OwnKitRow } from "./ready-made";

// The Board page's two picker reads (rules in ./ready-made.ts). Best-effort
// like every read on that page: a failure is a shorter list, never a broken
// Board.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = { from: (table: string) => any; rpc: (fn: string, args?: Record<string, unknown>) => any };
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Every book she may read (RLS), SketchCast books marked. Falls back to the pre-0175 columns. */
export async function loadBoardBooks(session: Db): Promise<BoardBook[]> {
  const cols = "id, title, grade, subject, chapters";
  let res = await session.from("books").select(`${cols}, sk_product_id`).is("removed_at", null).order("title");
  if (res.error) res = await session.from("books").select(cols).is("removed_at", null).order("title");
  return boardBooks(res.data ?? []);
}

/**
 * Her ready-made kits, then the catalogue kits she can open but has not
 * copied. `admin` reads catalogue_current_kits() / topic_kits (service role
 * only); her allowance and unlocks are read as HER.
 */
export async function loadBoardKits(session: Db, admin: Db | null, userId: string, catalogueOn: boolean): Promise<BoardKit[]> {
  let own: OwnKitRow[] = [];
  try {
    const { data } = await session
      .from("generations")
      .select("id, title, created_at, params")
      .eq("owner_id", userId)
      .eq("kind", "presentation")
      .eq("status", "done")
      .is("book_id", null)
      .is("withdrawn_at", null)
      .order("created_at", { ascending: false })
      .limit(200);
    own = (data ?? []) as OwnKitRow[];
  } catch {
    own = [];
  }

  let offers: CatalogueOffer[] = [];
  let unlocked = new Set<string>();
  let unlimited = false;
  if (catalogueOn && admin) {
    try {
      const { data: allowance } = await session.rpc("my_catalogue_allowance");
      const a = (allowance ?? null) as { eligible?: boolean; cap?: number | null } | null;
      if (a?.eligible) {
        unlimited = a.cap === null;
        const [{ data: cur }, { data: unl }] = await Promise.all([admin.rpc("catalogue_current_kits"), session.from("catalogue_unlocks").select("topic_id").eq("user_id", userId)]);
        unlocked = new Set(((unl ?? []) as { topic_id: string }[]).map((u) => u.topic_id));
        const current = ((cur ?? []) as { topic_id: string; topic_kit_id: string }[]).filter((c) => unlimited || unlocked.has(c.topic_id));
        if (current.length) {
          const { data: kits } = await admin.from("topic_kits").select("id, topic_id, presentation_generation_id").in("id", current.map((c) => c.topic_kit_id));
          const rows = ((kits ?? []) as { id: string; topic_id: string; presentation_generation_id: string | null }[]).filter((k) => !!k.presentation_generation_id);
          const { data: gens } = rows.length
            ? await admin.from("generations").select("id, title").in("id", rows.map((k) => k.presentation_generation_id))
            : { data: [] };
          const titles = new Map(((gens ?? []) as { id: string; title: string | null }[]).map((g) => [g.id, g.title]));
          offers = rows.map((k) => ({ topicKitId: k.id, topicId: k.topic_id, presentationId: k.presentation_generation_id!, title: titles.get(k.presentation_generation_id!) ?? null }));
        }
      }
    } catch {
      offers = [];
    }
  }
  return boardKits({ own, offers, unlocked, unlimited });
}
