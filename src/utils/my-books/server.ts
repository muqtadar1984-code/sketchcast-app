import "server-only";
import { createAdminClient } from "@/utils/supabase/admin";
import { s3Link } from "@/utils/books/files";
import { skAccessAllowed, skEnabled, type SkGateUser } from "@/utils/flags";
import { loadMyBooks, type MyBooksDb } from "./load";
import { myBookTiles, type MyBookTile } from "./tiles";

// SK S7 K3 — the dashboard's one call for the "My books" strip: decide (the
// access check), then sign the covers of what was decided. Never throws — the
// Library must render without the strip rather than fail on its account.
//
// "Open in SK" only for readers who pass the SK gate (NEXT_PUBLIC_FEATURE_SK +
// FEATURE_SK + the allow-list, the same as /sk/[product]); the strip itself
// and the PDF are not gated by any SK flag.

export async function myBooksStrip(user: SkGateUser & { id: string }, role: string | null): Promise<MyBookTile[]> {
  try {
    const books = await loadMyBooks(createAdminClient() as unknown as MyBooksDb, user.id, new Date());
    if (!books.length) return [];
    let skOpen = false;
    try {
      skOpen = process.env.NEXT_PUBLIC_FEATURE_SK === "true" && skEnabled() && (await skAccessAllowed(user, { role }));
    } catch {
      skOpen = false;
    }
    return await myBookTiles(books, { sign: (key, seconds) => s3Link(key, undefined, seconds), skOpen });
  } catch (e) {
    console.error("[sk-library] my books strip failed:", (e as Error).message);
    return [];
  }
}
