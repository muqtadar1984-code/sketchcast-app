// The Board's adopt-on-pick (POST /api/present/adopt): turn a pick she does
// not own yet into a ready-made kit she DOES own, because the session and kit
// routes play only her own done, book-less presentation.
//
//   SketchCast book chapter → adopt_product_kit() for every piece of the
//     chapter's catalogue kit (sk_product_kits; the one she chose when the
//     chapter has several, else the first). The book grant is the entitlement
//     (0175: no unlock, no allowance); the database re-checks it;
//   catalogue kit           → adopt_catalogue_piece() for every piece of a
//     CURRENT catalogue kit (0132), after a free unlock_catalogue_kit() on an
//     unlimited tier. A capped tier's locked kit is refused, never unlocked
//     here (that spends her weekly allowance — the Kits tab's question).
//
// Both are copies: no job, no credit, the same files. Idempotent (the
// functions return an existing copy), so a double tap costs nothing.
//
// The reads use the service role (sk_product_kits and topic_kits are not hers
// to read); every WRITE goes through her own session's RPC, so the database's
// own checks decide. Injected so every branch is testable without a database.

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

/**
 * A SketchCast book's chapter → her copy of ONE of its catalogue kits.
 * `chapterNum` is the book's 0-based num (the Board's chapter key); the map is
 * keyed by the release chapter (num + 1). `lesson` picks among a chapter's
 * kits (the kit's lesson id, as the bar lists them); omitted → the first.
 */
export async function adoptProductChapter(deps: AdoptDeps, bookId: string, chapterNum: number, lesson?: string | null): Promise<AdoptResult> {
  if (!UUID.test(bookId) || !Number.isInteger(chapterNum) || chapterNum < 0) return fail(404, "not_found");
  if (lesson != null && !UUID.test(lesson)) return fail(404, "not_found");
  const { data: bookRow } = await deps.admin.from("books").select("id, sk_product_id, removed_at").eq("id", bookId).maybeSingle();
  const book = bookRow as { id: string; sk_product_id: string | null; removed_at: string | null } | null;
  if (!book || !book.sk_product_id || book.removed_at) return fail(404, "not_found");
  // her grant, asked as HER (the definer function reads auth.uid()); no grant → as if no book
  const { data: granted, error: gErr } = await deps.rpc("has_book_grant", { p_product: book.sk_product_id });
  if (gErr || granted !== true) return fail(404, "not_found");
  const { data: rows } = await deps.admin
    .from("sk_product_kits")
    .select("generation_id, sort")
    .eq("product_id", book.sk_product_id)
    .eq("chapter_ref", String(chapterNum + 1));
  const lessons = ((rows ?? []) as { generation_id: string; sort: number | null }[]).sort((a, b) => Number(a.sort ?? 0) - Number(b.sort ?? 0)).map((r) => r.generation_id);
  if (!lessons.length) return fail(409, "no_kit");
  const chosen = lesson ?? lessons[0];
  if (!lessons.includes(chosen)) return fail(404, "not_found");
  const { data: kits } = await deps.admin
    .from("topic_kits")
    .select("id, presentation_generation_id, doc_generation_ids, status")
    .eq("presentation_generation_id", chosen)
    .eq("status", "approved");
  const kitRow = ((kits ?? []) as TopicKitRow[])[0];
  if (!kitRow) return fail(409, "no_kit");
  return adoptAll(deps, "adopt_product_kit", piecesOf(kitRow).map((p) => ({ id: p.generationId, kind: p.kind })));
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
