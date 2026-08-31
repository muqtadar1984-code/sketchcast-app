import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { authorAllowed, readerFacts } from "@/utils/present/reader";

export const dynamic = "force-dynamic";

// Every lesson note this account may read, newest first.
//
// WHY THIS EXISTS AT ALL. A link the teacher pastes into a chat is the fast path
// and the one Phase 3's gate exercises, but a link is also the only way in, and
// a student who loses it has lost the lesson. This is the boring answer: one
// page, no nav entry, no new machinery.
//
// NOT A DIRECTORY. It lists only what mayReadRecap() would already allow — the
// classes this account is enrolled in, or whose children it is a verified parent
// of, or its own lessons if it is a teacher. It deliberately does NOT include
// the leadership branch: an admin's oversight view of a whole school belongs on
// a school surface with its own filters, not on a page a student shares a URL
// shape with.

const LIMIT = 50;

type Row = {
  id: string;
  teacher_id: string;
  class_id: string | null;
  subject: string | null;
  book_id: string | null;
  recap_body: string | null;
  recap_published_at: string | null;
  page_count: number | null;
};

export default async function RecapListPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent("/present/recap")}`);

  let rows: Row[] = [];
  let books = new Map<string, string>();
  try {
    const admin = createAdminClient();
    const reader = await readerFacts(admin, user.id, null);
    const classIds = [...new Set([...reader.enrolledClassIds, ...reader.childClassIds])];

    // Two queries rather than an `or` filter: PostgREST's `or` with an `in` list
    // is a string-built predicate, and a class id list is user-derived. Two
    // parameterised queries merged in memory is the same result and nothing to
    // get wrong.
    const [mine, theirs] = await Promise.all([
      admin
        .from("present_sessions")
        .select("id, teacher_id, class_id, subject, book_id, recap_body, recap_published_at, page_count")
        .eq("teacher_id", user.id)
        .not("recap_published_at", "is", null)
        .order("recap_published_at", { ascending: false })
        .limit(LIMIT),
      classIds.length
        ? admin
            .from("present_sessions")
            .select("id, teacher_id, class_id, subject, book_id, recap_body, recap_published_at, page_count")
            .in("class_id", classIds)
            .not("recap_published_at", "is", null)
            .order("recap_published_at", { ascending: false })
            .limit(LIMIT)
        : Promise.resolve({ data: [] as Row[] }),
    ]);

    const byId = new Map<string, Row>();
    for (const r of [...((mine.data ?? []) as Row[]), ...((theirs.data ?? []) as Row[])]) {
      byId.set(r.id, r);
    }

    // The author's allowlist, once per teacher rather than once per lesson.
    const teachers = [...new Set([...byId.values()].map((r) => r.teacher_id))];
    const allowed = new Map(
      await Promise.all(
        teachers.map(async (t) => [t, await authorAllowed(admin, t)] as const),
      ),
    );

    rows = [...byId.values()]
      .filter((r) => r.recap_body && allowed.get(r.teacher_id))
      .sort((a, b) => (b.recap_published_at ?? "").localeCompare(a.recap_published_at ?? ""))
      .slice(0, LIMIT);

    const bookIds = [...new Set(rows.map((r) => r.book_id).filter((b): b is string => !!b))];
    if (bookIds.length) {
      const { data } = await admin.from("books").select("id, title").in("id", bookIds);
      books = new Map(((data ?? []) as { id: string; title: string }[]).map((b) => [b.id, b.title]));
    }
  } catch {
    // No service key, or 0097/0099 not applied. An empty list is the honest
    // answer and is also the correct one for almost every account.
    rows = [];
  }

  return (
    <main className="min-h-dvh bg-[#F7F9F8] text-[#14181F]">
      <div className="mx-auto grid max-w-2xl gap-5 px-5 py-10">
        <h1 className="text-2xl font-semibold tracking-tight">Lesson notes</h1>
        {!rows.length ? (
          <p className="text-sm text-[#6B7A75]">
            Nothing published yet. A note appears here once a teacher publishes one to a class you
            are in.
          </p>
        ) : (
          <ul className="grid gap-3">
            {rows.map((r) => (
              <li key={r.id}>
                <Link
                  href={`/present/recap/${r.id}`}
                  className="block rounded-2xl border border-[#D9E2DE] bg-white px-5 py-4 hover:border-[#0C8175]"
                >
                  <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#6B7A75]">
                    {(r.book_id && books.get(r.book_id)) || r.subject || "Lesson"}
                    {r.recap_published_at
                      ? ` · ${new Date(r.recap_published_at).toLocaleDateString(undefined, {
                          dateStyle: "medium",
                        })}`
                      : ""}
                  </p>
                  <p className="mt-1 leading-relaxed">{r.recap_body}</p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
