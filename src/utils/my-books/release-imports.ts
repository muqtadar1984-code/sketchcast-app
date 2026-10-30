// SK S7 K3 — what the founder's "Import now" card shows (console → Content):
// the book app's LIVE releases and, per release, SK's last import
// (sk_release_imports, 0174). Finals are importable; drafts are listed as
// "skipped (drafts not used)" and never offered (founder 2026-10-30: only
// completed books). Read with the service role; it writes nothing — the
// button calls K1's POST /api/sk/knowledge/import.

/* eslint-disable @typescript-eslint/no-explicit-any */
export type ReleaseImportsDb = { from: (table: string) => any };
/* eslint-enable @typescript-eslint/no-explicit-any */

export type ReleaseImportRow = {
  id: number;
  workUid: string;
  slug: string;
  title: string;
  language: string;
  kind: "final" | "draft";
  editionKey: string;
  releasedAt: string | null;
  /** final: the last import's status (or "never"); draft: always "draft_skipped". */
  status: "ok" | "error" | "skipped" | "never" | "draft_skipped";
  importedAt: string | null;
  blocks: number | null;
  error: string | null;
};

export type ReleaseImports =
  | { state: "waiting_for_book_app"; rows: [] }
  | { state: "ok"; migration0174: boolean; rows: ReleaseImportRow[] }
  | { state: "error"; message: string; rows: [] };

/** FOUNDER_EMAILS (src/utils/platform-admin.ts founderEmails), case-insensitive. Pure. */
export function isFounderEmail(email: string | null | undefined, founders: string[]): boolean {
  const e = (email ?? "").trim().toLowerCase();
  return !!e && founders.map((f) => f.trim().toLowerCase()).includes(e);
}

const missing = (e: { code?: string; message?: string } | null | undefined) =>
  !!e && (e.code === "42P01" || e.code === "PGRST205" || /does not exist|schema cache|could not find the table/i.test(e.message ?? ""));

export async function loadReleaseImports(db: ReleaseImportsDb): Promise<ReleaseImports> {
  const rel = await db
    .from("pub_releases")
    .select("id, work_uid, slug, title, language, release_kind, edition_key, released_at, superseded_by, withdrawn_at")
    .is("superseded_by", null)
    .is("withdrawn_at", null)
    .order("id", { ascending: false });
  if (rel.error) {
    if (missing(rel.error)) return { state: "waiting_for_book_app", rows: [] };
    return { state: "error", message: rel.error.message ?? "pub_releases read failed", rows: [] };
  }
  const releases = (rel.data ?? []) as {
    id: number;
    work_uid: string;
    slug: string;
    title: string | null;
    language: string;
    release_kind: string;
    edition_key: string;
    released_at: string | null;
  }[];

  const ids = releases.filter((r) => r.release_kind === "final").map((r) => Number(r.id));
  let migration0174 = true;
  const log = new Map<number, { status: string; imported_at: string | null; blocks: number | null; error: string | null }>();
  if (ids.length) {
    const imp = await db.from("sk_release_imports").select("release_id, status, imported_at, blocks, error").in("release_id", ids);
    if (imp.error) {
      if (!missing(imp.error)) return { state: "error", message: imp.error.message ?? "sk_release_imports read failed", rows: [] };
      migration0174 = false;
    }
    for (const r of (imp.data ?? []) as { release_id: number; status: string; imported_at: string | null; blocks: number | null; error: string | null }[]) {
      log.set(Number(r.release_id), r);
    }
  }

  const rows: ReleaseImportRow[] = releases.map((r) => {
    const kind = r.release_kind === "final" ? "final" : "draft";
    const l = kind === "final" ? log.get(Number(r.id)) : undefined;
    const status: ReleaseImportRow["status"] =
      kind === "draft" ? "draft_skipped" : l && ["ok", "error", "skipped"].includes(l.status) ? (l.status as "ok" | "error" | "skipped") : "never";
    return {
      id: Number(r.id),
      workUid: r.work_uid,
      slug: r.slug,
      title: r.title || r.slug,
      language: r.language,
      kind,
      editionKey: r.edition_key,
      releasedAt: r.released_at,
      status,
      importedAt: l?.imported_at ?? null,
      blocks: l?.blocks ?? null,
      error: l?.error ?? null,
    };
  });
  // finals first (the importable ones), then the skipped drafts
  rows.sort((a, b) => (a.kind === b.kind ? b.id - a.id : a.kind === "final" ? -1 : 1));
  return { state: "ok", migration0174, rows };
}

/** The card's data, or null when the viewer is not a founder (the card does not render, and nothing is read). */
export async function founderImportCard(email: string | null | undefined, founders: string[], db: () => ReleaseImportsDb): Promise<ReleaseImports | null> {
  if (!isFounderEmail(email, founders)) return null;
  try {
    return await loadReleaseImports(db());
  } catch (e) {
    return { state: "error", message: (e as Error).message, rows: [] };
  }
}

/** What K1's POST /api/sk/knowledge/import answers (its PollResult, or an error). */
export type PollResult =
  | { status: "waiting_for_book_app" }
  | { status: "waiting_for_0174"; live: number }
  | { status: "ok"; live: number; imported: number[]; unchanged: number[]; skipped: number[]; unavailable: string[]; errors: { release_id: number; error: string }[] }
  | { error: string };

/** One line for the founder after "Import now". Pure. */
export function describePoll(r: PollResult): string {
  if ("error" in r) return `Failed: ${r.error}`;
  if (r.status === "waiting_for_book_app") return "Waiting for the book app: pub_releases (0172) is not there yet.";
  if (r.status === "waiting_for_0174") return `${r.live} live release(s), but SK's migration 0174 is not applied yet — nothing imported.`;
  const bits = [`${r.imported.length} imported`, `${r.unchanged.length} unchanged`, `${r.skipped.length} skipped`];
  if (r.unavailable.length) bits.push(`${r.unavailable.length} marked unavailable`);
  if (r.errors.length) bits.push(`${r.errors.length} failed (${r.errors.map((e) => `#${e.release_id}: ${e.error}`).join("; ")})`);
  return bits.join(" · ");
}
