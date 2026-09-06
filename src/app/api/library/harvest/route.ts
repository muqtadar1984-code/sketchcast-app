import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isLibraryMemberRequest } from "@/utils/library-access";
import { audit, bad, conflict, dbError, notFound, readJson, uuid } from "../lib";

export const runtime = "nodejs";

// POST {bookId} — enqueue ONE `topic_harvest` job for a book (curate).
//
// The worker's harvest.py reads the book's chapter titles and section headings
// from the existing structured extraction and files topic_candidates — names
// only, never page text (plan §6). The job row is inserted directly with the
// service role: it is an OBSERVER job (owns no generation, generation_id NULL)
// so nothing here touches `generations`, no credit moves, and the
// on_generation_created trigger is not involved. One live harvest per book:
// a queued or processing one refuses a second with 409. The read-then-insert
// below is the friendly answer (it can name the live job); the partial unique
// index jobs_one_live_harvest (0112) is the rule the database enforces when two
// clicks race it, and its 23505 is mapped to the same 409.

// Not exported: a route module may only export Next's handler names.
const HARVEST_JOB_TYPE = "topic_harvest";

type Body = { bookId?: unknown };

export async function POST(request: Request) {
  const m = await isLibraryMemberRequest("curate");
  if (!m) return notFound();

  const body = await readJson<Body>(request);
  if (!body) return bad("Invalid JSON.");
  const bookId = uuid(body.bookId);
  if (!bookId) return bad("bookId is required.");

  const admin = createAdminClient();
  const { data: book, error: bErr } = await admin
    .from("books")
    .select("id, title, status, removed_at")
    .eq("id", bookId)
    .maybeSingle();
  if (bErr) return dbError(bErr);
  if (!book) return NextResponse.json({ error: "Book not found." }, { status: 404 });
  if (book.removed_at) return bad("That book has been taken down.");
  // books.status is 'ready' | 'indexing' | 'error' (0001). The harvester needs
  // the structured extraction, which exists only once indexing finished.
  if (book.status === "indexing") return bad("The book is still indexing; harvest it once that has finished.");
  if (book.status !== "ready") return bad(`The book is ${book.status}; only a ready book can be harvested.`);

  const { data: live, error: lErr } = await admin
    .from("jobs")
    .select("id, status, created_at")
    .eq("type", HARVEST_JOB_TYPE)
    .eq("book_id", bookId)
    .in("status", ["queued", "processing"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lErr) return dbError(lErr);
  if (live) return conflict(`A harvest is already ${live.status} for this book.`, { jobId: live.id });

  const { data: job, error: jErr } = await admin
    .from("jobs")
    .insert({ type: HARVEST_JOB_TYPE, book_id: bookId, generation_id: null, status: "queued" })
    .select("id")
    .single();
  if (jErr) {
    if (jErr.code === "23505") {
      // Lost the race to another click: jobs_one_live_harvest refused the second
      // row. Answer as the check above would have, naming the job that won.
      const { data: winner } = await admin
        .from("jobs")
        .select("id, status")
        .eq("type", HARVEST_JOB_TYPE)
        .eq("book_id", bookId)
        .in("status", ["queued", "processing"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return conflict(`A harvest is already ${winner?.status ?? "queued"} for this book.`, { jobId: winner?.id ?? null });
    }
    return dbError(jErr);
  }

  await audit(admin, m.id, "harvest_enqueue", "book", bookId, { job_id: job.id, title: book.title ?? null });
  return NextResponse.json({ ok: true, jobId: job.id });
}
