// The Board's adopt-on-pick (POST /api/present/adopt): turn a pick she does
// not own yet into a ready-made kit she DOES own, because the session and kit
// routes play only her own done, book-less presentation.
//
//   SketchCast book chapter → adopt_product_kit() for every piece of the
//     chapter's ONE master kit (0175; the database re-checks her grant);
//   catalogue kit           → adopt_catalogue_piece() for every piece of a
//     CURRENT catalogue kit (0132), after a free unlock_catalogue_kit() on an
//     unlimited tier. A capped tier's locked kit is refused, never unlocked
//     here (that spends her weekly allowance — the Kits tab's question).
//
// Both are copies: no job, no credit, the same files. Idempotent (the
// functions return an existing copy), so a double tap costs nothing.
//
// The reads use the service role (master kits and topic_kits are not hers to
// read); every WRITE goes through her own session's RPC, so the database's own
// checks decide. Injected so every branch is testable without a database.

import { chapterKit, type MasterKitRow, type ProductSystemBook } from "@/utils/my-books/product-book";
import { piecesOf, type TopicKitRow } from "@/app/dashboard/kits/logic";
import { kitPrefix } from "./kit";

type Res = { data: unknown; error: { message?: string; code?: string } | null };
/* eslint-disable @typescript-eslint/no-explicit-any */
export type AdoptDeps = {
  /** service role: reads only */
  admin: { from: (table: string) => any; rpc: (fn: string, args?: Record<string, unknown>) => any };
  /** the caller's own session: every write */
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<Res>;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

export type AdoptResult =
  | { ok: true; kitId: string; title: string }
  | { ok: false; status: 403 | 404 | 409 | 500; reason: "not_found" | "no_kit" | "locked" | "ineligible" | "failed" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status: 403 | 404 | 409 | 500, reason: Extract<AdoptResult, { ok: false }>["reason"]): AdoptResult => ({ ok: false, status, reason });

/** Adopt each source in order; the presentation's copy is the kit. */
async function adoptAll(deps: AdoptDeps, fn: "adopt_product_kit" | "adopt_catalogue_piece", sources: { id: string; kind: string }[]): Promise<AdoptResult> {
  let kitId: string | null = null;
  for (const s of sources) {
    const { data, error } = await deps.rpc(fn, { p_source: s.id });
    if (error || typeof data !== "string") {
      // the lesson is the kit; a document that will not copy is skipped
      if (s.kind === "presentation") return fail(error?.code === "42501" ? 403 : 500, error?.code === "42501" ? "ineligible" : "failed");
      continue;
    }
    if (s.kind === "presentation") kitId = data;
  }
  if (!kitId) return fail(409, "no_kit");
  const { data: copy } = await deps.admin.from("generations").select("id, title").eq("id", kitId).maybeSingle();
  const title = kitPrefix((copy as { title?: string | null } | null)?.title ?? "");
  return { ok: true, kitId, title: title || kitId };
}

export async function adoptProductChapter(deps: AdoptDeps, bookId: string, chapterNum: number): Promise<AdoptResult> {
  if (!UUID.test(bookId) || !Number.isInteger(chapterNum) || chapterNum < 0) return fail(404, "not_found");
  const { data: bookRow } = await deps.admin.from("books").select("id, owner_id, sk_product_id, title, chapters, removed_at").eq("id", bookId).maybeSingle();
  const book = bookRow as (ProductSystemBook & { removed_at: string | null }) | null;
  if (!book || !book.sk_product_id || book.removed_at) return fail(404, "not_found");
  // her grant, asked as HER (the definer function reads auth.uid()); no grant → as if no book
  const { data: granted, error: gErr } = await deps.rpc("has_book_grant", { p_product: book.sk_product_id });
  if (gErr || granted !== true) return fail(404, "not_found");
  const { data: rows } = await deps.admin
    .from("generations")
    .select("id, kind, title, chapter_ref, status, owner_id, book_id, params, created_at, removed_at, withdrawn_at")
    .eq("book_id", book.id)
    .eq("owner_id", book.owner_id)
    .eq("chapter_ref", String(chapterNum))
    .eq("status", "done");
  const kit = chapterKit(book, ((rows ?? []) as MasterKitRow[]).map((r) => ({ ...r, artifacts: [] })), chapterNum);
  if (!kit.length) return fail(409, "no_kit");
  return adoptAll(deps, "adopt_product_kit", kit.map((g) => ({ id: g.id, kind: g.kind })));
}

export async function adoptCatalogueKit(deps: AdoptDeps, userId: string, topicKitId: string): Promise<AdoptResult> {
  if (!UUID.test(topicKitId)) return fail(404, "not_found");
  const { data: current, error: cErr } = await deps.admin.rpc("catalogue_current_kits");
  if (cErr || !Array.isArray(current)) return fail(500, "failed");
  const cur = (current as { topic_id: string; topic_kit_id: string }[]).find((c) => c.topic_kit_id === topicKitId);
  if (!cur) return fail(404, "not_found");
  const { data: kitRow } = await deps.admin.from("topic_kits").select("id, presentation_generation_id, doc_generation_ids").eq("id", topicKitId).maybeSingle();
  if (!kitRow) return fail(404, "not_found");

  const { data: allowance, error: aErr } = await deps.rpc("my_catalogue_allowance");
  const a = (allowance ?? null) as { eligible?: boolean; cap?: number | null } | null;
  if (aErr || !a?.eligible) return fail(403, "ineligible");
  const { data: unlocks } = await deps.admin.from("catalogue_unlocks").select("id").eq("user_id", userId).eq("topic_id", cur.topic_id);
  if (!((unlocks as unknown[] | null) ?? []).length) {
    if (a.cap !== null && a.cap !== undefined) return fail(403, "locked");
    const { data: u, error: uErr } = await deps.rpc("unlock_catalogue_kit", { p_topic: cur.topic_id });
    const status = (u as { status?: string } | null)?.status;
    if (uErr || (status !== "unlocked" && status !== "already")) return fail(403, "locked");
  }
  const pieces = piecesOf(kitRow as TopicKitRow).map((p) => ({ id: p.generationId, kind: p.kind }));
  return adoptAll(deps, "adopt_catalogue_piece", pieces);
}
