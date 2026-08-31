import { notFound, redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { sessionById } from "@/utils/present/server";
import { mayReadRecap } from "@/utils/present/audience";
import { authorAllowed, readerFacts } from "@/utils/present/reader";
import { chaptersShown, type RecapItem } from "@/utils/present/recap";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";
import { fmt } from "@/i18n/format";

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
// TRANSLATED, AND THIS IS THE PAGE THAT FORCED IT. Every other Present surface
// is driven by the teacher who chose to open it; this one is sent to students
// and parents who did not, and it went out to a Malaysian class. The locale is
// resolved per REQUEST rather than per lesson, because a student and their
// teacher need not share one.

const SIGN_TTL = 8 * 60 * 60;

export default async function RecapPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // The reader's own language, and the tag every date on this page is written
  // in. A student and their teacher may not share one, which is the whole point
  // of resolving it per request rather than per lesson.
  const locale = await resolveLocale();
  const t = (await getDictionary(locale)).present;

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
            {session.subject ?? t.recap.lesson}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">
            {book.data?.title ?? t.recap.lessonNote}
          </h1>
          <p className="font-mono text-[11px] text-[#6B7A75]">
            {teacher.data?.full_name ?? t.recap.yourTeacher}
            {taught ? ` · ${taught.toLocaleDateString(locale, { dateStyle: "medium" })}` : ""}
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
              {t.recap.covered}
            </h2>
            <ul className="grid gap-1 text-sm">
              {covered.chapters.map((c) => (
                <li key={c.chapterNum}>
                  {/* chapter_ref is 0-based in the database and rendered +1. */}
                  <span className="font-medium">
                    {chapters[c.chapterNum]?.title ?? fmt(t.bar.chapterN, { n: c.chapterNum + 1 })}
                  </span>
                  {c.parts.length > 0 && (
                    <span className="text-[#6B7A75]">
                      {" "}
                      ·{" "}
                      {fmt(c.parts.length === 1 ? t.recap.partOne : t.recap.partMany, {
                        list: c.parts.join(", "),
                      })}
                    </span>
                  )}
                </li>
              ))}
              {covered.revision && (
                <li className="text-[#6B7A75]">{t.recap.revisionElsewhere}</li>
              )}
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
            {t.recap.openBoard}
            <span className="font-mono text-[11px] opacity-80">
              {(session.page_count ?? 1) === 1
                ? t.recap.boardOne
                : fmt(t.recap.boardMany, { n: session.page_count ?? 1 })}
            </span>
          </a>
        ) : (
          // Said, not hidden. A missing board is a fact about this lesson, and a
          // student hunting for a button that was never there is worse.
          <p className="text-sm text-[#6B7A75]">{t.recap.noBoard}</p>
        )}
      </article>
    </main>
  );
}
