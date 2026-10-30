import "server-only";
import { createAdminClient } from "@/utils/supabase/admin";
import { readRunsFile, runsFile, writeRunsFile } from "./runs";

// Book releases for the Library and SK (migration 0172; contract BOOK-RELEASES-CONTRACT-2026-10-30, approved by SK).
// The books runner makes a release (stage `release`); the app lists them and lets an approver withdraw one. SK reads
// pub_releases and the files under books/<slug>/editions/ — it never writes here, and the app never writes SK tables.
// Development (BOOKS_FIXTURE): BOOKS_RUNS_FILE.

export type Release = {
  id: number;
  work_uid: string;
  release_kind: "final" | "draft";
  edition_key: string;
  language: string;
  revision_key: string;
  gate_e_approval_id: number | null;
  chapters: { chapter: number; title: string; content_sha256: string; gate_d_approval_id: number; pdf_key: string | null }[];
  chapter_count: number;
  bundle_key: string;
  digital_pdf_key: string | null;
  released_by: string;
  released_at: string;
  run_id: number | null;
  superseded_by: number | null;
  withdrawn_at: string | null;
  withdrawn_reason: string | null;
  withdrawn_by: string | null;
};

const TABLE = "pub_releases";

/** A release's state for people: live, superseded by a newer one, or withdrawn. Pure (tested). */
export function releaseState(r: Pick<Release, "superseded_by" | "withdrawn_at">): "live" | "superseded" | "withdrawn" {
  return r.withdrawn_at ? "withdrawn" : r.superseded_by ? "superseded" : "live";
}

/** The book's releases, newest first. Empty before migration 0172 is applied. */
export async function listReleases(workUid: string): Promise<Release[]> {
  const f = runsFile();
  if (f) return ((readRunsFile(f)[TABLE] ?? []) as unknown as Release[]).filter((r) => r.work_uid === workUid).sort((a, b) => b.id - a.id);
  const { data, error } = await createAdminClient().from(TABLE).select("*").eq("work_uid", workUid).order("id", { ascending: false });
  if (error && missingTable(error)) return [];
  if (error) throw new Error(`${TABLE}: ${error.message}`);
  return (data ?? []) as Release[];
}

export async function withdrawRelease(i: { workUid: string; id: number; reason: string; by: string }): Promise<{ ok: true } | { error: string; status: number }> {
  const reason = i.reason.trim();
  if (reason.length < 10) return { error: "Say why the release is withdrawn (at least a sentence); SK shows it to no new reader.", status: 400 };
  const at = new Date().toISOString();
  const f = runsFile();
  if (f) {
    const d = readRunsFile(f);
    const r = ((d[TABLE] ?? []) as unknown as Release[]).find((x) => x.id === i.id && x.work_uid === i.workUid);
    if (!r) return { error: "Unknown release.", status: 404 };
    if (r.withdrawn_at) return { error: "This release was already withdrawn.", status: 409 };
    Object.assign(r, { withdrawn_at: at, withdrawn_reason: reason.slice(0, 1000), withdrawn_by: i.by });
    writeRunsFile(f, d);
    return { ok: true };
  }
  const { data, error } = await createAdminClient()
    .from(TABLE)
    .update({ withdrawn_at: at, withdrawn_reason: reason.slice(0, 1000), withdrawn_by: i.by })
    .eq("id", i.id)
    .eq("work_uid", i.workUid)
    .is("withdrawn_at", null)
    .select("id");
  if (error && missingTable(error)) return { error: "Releases are waiting for database migration 0172.", status: 503 };
  if (error) throw new Error(`${TABLE}: ${error.message}`);
  if (!data?.length) return { error: "Unknown release, or it was already withdrawn.", status: 409 };
  return { ok: true };
}

/** PostgREST's "no such table" (schema cache) or Postgres's undefined_table. */
function missingTable(e: { code?: string; message?: string }): boolean {
  return e.code === "PGRST205" || e.code === "42P01" || /could not find the table|does not exist/i.test(e.message ?? "");
}
