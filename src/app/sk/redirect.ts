import "server-only";
import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { presentEntitled } from "@/utils/present/entitlement";
import { boardChapterOf, skRedirectPath, type SkRedirectFacts } from "./redirect-path";

// The facts behind redirect-path.ts, read through the caller's own session
// (RLS decides which SketchCast book she may open on the Board, exactly as the
// Board's own book list does); the plan check is the Board's (service role).
// Every read is best-effort: a failure only makes the target less specific.

const PRODUCT_RE = /^[a-z0-9][a-z0-9_-]{0,119}$/i;

export async function skRedirect(product?: string, chapter?: string): Promise<never> {
  const facts: SkRedirectFacts = { signedIn: false, role: null, board: false };
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      facts.signedIn = true;
      const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
      facts.role = (profile?.role as string | null) ?? null;
      if (facts.role !== "student") {
        let admin: ReturnType<typeof createAdminClient> | null = null;
        try {
          admin = createAdminClient();
        } catch {
          admin = null;
        }
        facts.board = (await presentEntitled(admin, user.id, user)).ok;
      }
      if (facts.board && product && PRODUCT_RE.test(product)) {
        const { data: prod } = await supabase.from("sk_book_products").select("id").eq("slug", product).maybeSingle();
        const productId = (prod?.id as string | undefined) ?? null;
        if (productId) {
          const { data: books } = await supabase.from("books").select("id, chapters").eq("sk_product_id", productId).is("removed_at", null).limit(1);
          const book = ((books ?? []) as Array<{ id: string; chapters: Array<{ num: number }> | null }>)[0];
          if (book?.id) {
            facts.bookId = book.id;
            facts.chapterNum = boardChapterOf(chapter, Array.isArray(book.chapters) ? book.chapters : null);
          }
        }
      }
    }
  } catch (e) {
    console.error("[sk] tutor redirect:", (e as Error).message);
  }
  redirect(skRedirectPath(facts));
}
