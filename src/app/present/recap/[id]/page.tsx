import { notFound, redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { sessionById } from "@/utils/present/server";
import { mayReadRecap } from "@/utils/present/audience";
import { authorAllowed, readerFacts } from "@/utils/present/reader";
import { chaptersShown, type RecapItem } from "@/utils/present/recap";

export const dynamic = "force-dynamic";

// What a student who missed the period opens.
//
// THIS IS THE ONE PRESENT SURFACE THAT IS NOT BEHIND THE ALLOWLIST, and it must
// not be. presentAllowed() answers "may this account drive a board?" about a
// named operator address; a student is never on that list, has no email at all
// (they sign in with a student ID), and putting one on it would hand them
// /api/present/kit and its eight-hour signed URLs to every artifact the teacher
// owns. So the allowlist is checked against the lesson's AUTHOR here — the same
// shape the AI Tutor uses, where the entitlement belongs to the lesson's owner
// rather than to the student asking the question.
//
// 404, NEVER 403, for a reader who is not entitled — otherwise a session id
// becomes an oracle for which lessons exist and who taught them. A published
// recap is not secret from its own class, but it is still not a directory.
//
// SERVED THROUGH THE SERVICE ROLE. present_sessions is revoked from
// `authenticated` and 0099 deliberately keeps it that way: recap_draft and
// recap_body sit in the same row, an RLS policy filters rows and not columns, so
// any grant that let a student read the published note would also hand them the
// sentence the teacher deleted. Every check RLS would have done is done in
// mayReadRecap() instead, against facts fetched in reader.ts.
//
// NOT TRANSLATED. The rest of Present mode is English-only because it is behind
// a one-account allowlist, and that argument is weakest exactly here — this is
// the first Present surface with a real audience, and that audience is
// Malaysian. It is a release blocker for widening the allowlist, recorded in
// docs/PRESENT-MODE.md rather than left to be discovered.

const SIGN_TTL = 8 * 60 * 60;

export default async function RecapPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // A bookmarked link that outlived a session should land on the login page and
  // come back, not on a dead end.
  if (!user) redirect(`/login?next=${encodeURIComponent(`/present/recap/${id}`)}`);

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    notFound();
  }

  const session = await sessionById(admin, id);
  if (!session) notFound();

  const [allowed, reader] = await Promise.all([
    authorAllowed(admin, session.teacher_id),
    readerFacts(admin, user.id, session.school_id),
  ]);

  const verdict = mayReadRecap(session, reader, allowed);
  if (!verdict.ok) notFound();

  // What the lesson covered, from what she SHOWED. The session's own chapter is
  // the timetable's opinion; present_items is the record.
  const { data: itemRows } = await admin
    .from("present_items")
    .select("kind, detail")
    .eq("session_id", session.id)
    .order("seq", { ascending: true });
  type Row = { kind: string; detail: Record<string, unknown> | null };
  const items: RecapItem[] = ((itemRows ?? []) as Row[]).map((i) => ({
    kind: i.kind === "video" || i.kind === "worksheet" ? i.kind : "blank",
    chapterNum: typeof i.detail?.chapterNum === "number" ? i.detail.chapterNum : null,
    part: typeof i.detail?.part === "number" ? i.detail.part : null,
  }));
  const covered = chaptersShown(items);

  const [book, teacher, klass] = await Promise.all([
    session.book_id
      ? admin.from("books").select("title, chapters").eq("id", session.book_id).maybeSingle()
      : Promise.resolve({ data: null }),
    admin.from("profiles").select("full_name").eq("id", session.teacher_id).maybeSingle(),
    session.class_id
      ? admin.from("classes").select("name").eq("id", session.class_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const chapters = Array.isArray(book.data?.chapters)
    ? (book.data.chapters as { title?: string }[])
    : [];

  // The roll. Signed for eight hours for the same reason the kit is: a link
  // opened on a school device in the morning has to still work that afternoon.
  let rollUrl: string | null = null;
  if (session.pdf_path) {
    const { data } = await admin.storage
      .from("artifacts")
      .createSignedUrl(session.pdf_path, SIGN_TTL);
    rollUrl = data?.signedUrl ?? null;
  }

  const taught = session.recap_published_at
    ? new Date(session.started_at ?? session.recap_published_at)
    : null;

  return (
    <main className="min-h-dvh bg-[#F7F9F8] text-[#14181F]">
      <article className="mx-auto grid max-w-2xl gap-6 px-5 py-10">
        <header className="grid gap-1">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#6B7A75]">
            {klass.data?.name ? `${klass.data.name} · ` : ""}
            {session.subject ?? "Lesson"}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">
            {book.data?.title ?? "Lesson note"}
          </h1>
          <p className="font-mono text-[11px] text-[#6B7A75]">
            {teacher.data?.full_name ?? "Your teacher"}
            {taught ? ` · ${taught.toLocaleDateString(undefined, { dateStyle: "medium" })}` : ""}
          </p>
        </header>

        {/* recap_BODY, never recap_draft. What she published, not what the model
            first wrote. */}
        <p className="rounded-2xl border border-[#D9E2DE] bg-white px-5 py-5 text-lg leading-relaxed">
          {session.recap_body}
        </p>

        {!!covered.chapters.length && (
          <section className="grid gap-1">
            <h2 className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#6B7A75]">
              What this covered
            </h2>
            <ul className="grid gap-1 text-sm">
              {covered.chapters.map((c) => (
                <li key={c.chapterNum}>
                  {/* chapter_ref is 0-based in the database and rendered +1. */}
                  <span className="font-medium">
                    {chapters[c.chapterNum]?.title ?? `Chapter ${c.chapterNum + 1}`}
                  </span>
                  {c.parts.length > 0 && (
                    <span className="text-[#6B7A75]">
                      {" "}
                      · {c.parts.length === 1 ? "Part" : "Parts"} {c.parts.join(", ")}
                    </span>
                  )}
                </li>
              ))}
              {covered.revision && <li className="text-[#6B7A75]">Revision across other chapters</li>}
            </ul>
          </section>
        )}

        {rollUrl ? (
          <a
            href={rollUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-fit items-center gap-2 rounded-xl bg-[#0C8175] px-5 py-3 text-sm font-medium text-white"
          >
            Open what was written on the board
            <span className="font-mono text-[11px] opacity-80">
              {session.page_count ?? 1} {(session.page_count ?? 1) === 1 ? "page" : "pages"} · PDF
            </span>
          </a>
        ) : (
          // Said, not hidden. A missing board is a fact about this lesson, and a
          // student hunting for a button that was never there is worse.
          <p className="text-sm text-[#6B7A75]">Nothing was written on the board in this lesson.</p>
        )}
      </article>
    </main>
  );
}
