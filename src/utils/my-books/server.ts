import "server-only";
import { createAdminClient } from "@/utils/supabase/admin";
import { s3Link } from "@/utils/books/files";
import { skAccessAllowed, skEnabled, type SkGateUser } from "@/utils/flags";
import { loadMyBooks, type MyBooksDb } from "./load";
import { myBookTiles, type AssignTargets, type MyBookTile } from "./tiles";
import { loadProductBooks, productChapters, type ProductBookDb } from "./product-book";
import { presentEntitled } from "@/utils/present/entitlement";

// SK S7 K3 — the dashboard's one call for the "My books" strip: decide (the
// access check), then sign the covers of what was decided. Never throws — the
// Library must render without the strip rather than fail on its account.
//
// "Open in SK" only for readers who pass the SK gate (NEXT_PUBLIC_FEATURE_SK +
// FEATURE_SK + the allow-list, the same as /sk/[product]); the strip itself
// and the PDF are not gated by any SK flag.
//
// 0175 — SketchCast books as Library books: for a book a TEACHER or PARENT
// holds themselves, its chapters and each chapter's catalogue kits (documents
// signed here with the service role AFTER the decision — the catalogue's
// pattern; the lesson video is a YouTube link), each chapter's Classroom
// Board link when the reader may open the Board, and the reader's Assign
// targets (their classes, or a parent's children). The book goes to the
// Board, not to SK (founder 2026-10-30), so the card carries no "Open in SK";
// a STUDENT keeps the plain tile, whose "Open in SK" is the student tutor.

/** Same lifetime as every other Library link. */
const KIT_LINK_SECONDS = 3600;

export async function myBooksStrip(user: SkGateUser & { id: string }, role: string | null): Promise<MyBookTile[]> {
  try {
    const admin = createAdminClient();
    const books = await loadMyBooks(admin as unknown as MyBooksDb, user.id, new Date());
    if (!books.length) return [];
    let skOpen = false;
    try {
      skOpen = process.env.NEXT_PUBLIC_FEATURE_SK === "true" && skEnabled() && (await skAccessAllowed(user, { role }));
    } catch {
      skOpen = false;
    }
    let systemBooks: Awaited<ReturnType<typeof loadProductBooks>> = new Map();
    let boardOn = false;
    if (role !== "student") {
      try {
        systemBooks = await loadProductBooks(admin as unknown as ProductBookDb, books.filter((b) => !b.forChildren.length).map((b) => b.productId));
      } catch (e) {
        console.error("[sk-library] product books read failed:", (e as Error).message);
      }
      if (systemBooks.size) {
        try {
          boardOn = (await presentEntitled(admin, user.id, user)).ok;
        } catch {
          boardOn = false;
        }
      }
    }
    const sign = async (path: string, download?: string) => {
      const { data } = await admin.storage.from("artifacts").createSignedUrl(path, KIT_LINK_SECONDS, download ? { download } : undefined);
      return data?.signedUrl ?? null;
    };
    const tiles = await myBookTiles(books, {
      sign: (key, seconds) => s3Link(key, undefined, seconds),
      skOpen,
      chapters: async (b) => {
        const hit = systemBooks.get(b.productId);
        if (!hit) return null;
        return productChapters(hit, { sign, boardOn: boardOn && !b.withdrawn });
      },
    });
    // Assign targets only when a card lists chapters (one read, not per book).
    const assign = tiles.some((t) => t.chapters) ? await myBooksAssignTargets(user.id, role) : null;
    return tiles.map((t) => ({ ...t, assign: t.chapters ? assign : null }));
  } catch (e) {
    console.error("[sk-library] my books strip failed:", (e as Error).message);
    return [];
  }
}

/**
 * Who a chapter can be assigned to: the teacher's own classes, or — for a
 * parent — their linked children (the page's own two modes, read the same
 * way). Null for a student (nothing to assign). Never throws.
 */
export async function myBooksAssignTargets(userId: string, role: string | null): Promise<AssignTargets | null> {
  if (role === "student") return null;
  try {
    const admin = createAdminClient();
    if (role === "parent") {
      const { data } = await admin.from("parent_links").select("child_id, profiles:child_id(full_name, username)").eq("parent_id", userId);
      type Row = { child_id: string; profiles: { full_name: string | null; username: string | null } | null };
      return {
        classes: [],
        // a nameless child gets the strip's localised fallback
        childTargets: ((data ?? []) as unknown as Row[]).map((l) => ({ id: l.child_id, name: l.profiles?.full_name || l.profiles?.username || "" })),
      };
    }
    const { data } = await admin.from("classes").select("id, name, grade").eq("teacher_id", userId).order("created_at", { ascending: false });
    return { classes: (data ?? []) as AssignTargets["classes"], childTargets: null };
  } catch {
    return { classes: [], childTargets: null };
  }
}
