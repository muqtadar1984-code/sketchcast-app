import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";

// Delete a book AND everything generated from it — rows and files (0100).
//
// Why a route and not a client-side RPC like delete-lesson.tsx: the files
// students submitted live in the `submissions` bucket, which a teacher's own
// session cannot delete from (only the service role can — the same reason
// /api/delete-student removes them here and not in the browser). So the rows
// go through the caller's AUTHENTICATED session — delete_my_book authorises on
// auth.uid() and RLS is intact — and the files come off with the admin client,
// using exactly the paths the database handed back and nothing else.
//
// The database is the authority on what may be removed: it returns only the
// artifact paths no remaining row references (a colleague's adopted copy keeps
// its files), the cover, the upload, and the submitted files. This route never
// computes a path itself.
//
// Storage removal is best-effort AFTER the rows are gone. A file that outlives
// its row is invisible garbage; a row that outlives its file is a broken link
// a teacher can see. So the order is rows first, and a storage failure is
// reported, not fatal.

type Removed = {
  kits: number;
  submissions: number;
  artifacts: string[];
  submission_files: string[];
  cover: string | null;
  upload: string | null;
};

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { data, error } = await supabase.rpc("delete_my_book", { p_book: id });
  if (error) {
    // 'book_indexing' / 'kit_building' are the function's own refusals — the
    // client maps them to its dictionary. Anything else is shown as-is.
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  const r = data as Removed;

  const admin = createAdminClient();
  const failures: string[] = [];
  const artifacts = [...(r.artifacts ?? []), ...(r.cover ? [r.cover] : [])];
  if (artifacts.length) {
    const { error: e } = await admin.storage.from("artifacts").remove(artifacts);
    if (e) failures.push(`artifacts: ${e.message}`);
  }
  if (r.upload) {
    const { error: e } = await admin.storage.from("uploads").remove([r.upload]);
    if (e) failures.push(`upload: ${e.message}`);
  }
  if (r.submission_files?.length) {
    const { error: e } = await admin.storage.from("submissions").remove(r.submission_files);
    if (e) failures.push(`submissions: ${e.message}`);
  }
  if (failures.length) console.error("books.delete storage:", id, failures.join("; "));

  return NextResponse.json({
    ok: true,
    kits: r.kits,
    submissions: r.submissions,
    files: artifacts.length + (r.upload ? 1 : 0) + (r.submission_files?.length ?? 0),
    storageFailures: failures.length,
  });
}
