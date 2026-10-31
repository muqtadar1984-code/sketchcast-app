import { notFound, redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import AppHeader from "../../app-header";
import { InkUnderline } from "@/components/ink-mark";
import {
  buildProgressReport,
  reportAccess,
  type ReportGenRow,
  type ReportItem,
  type ReportProgressRow,
  type ReportShareRow,
  type ReportSubmissionRow,
  type ReportSummary,
} from "@/utils/progress-report";
import { getDictionary, type Dictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";
import { htmlLang } from "@/i18n/locales";
import { fmt } from "@/i18n/format";
import PrintButton from "./print-button";

// The printable progress record — one learner, everything their record can
// truthfully say TODAY: what was assigned (and when), what was completed,
// what was scored. Teachers reach it per student from the class roster;
// parents (school-supporting and homeschooling alike) per child from My
// Children. The browser's print dialog is the export: app chrome hides under
// @media print and each book section avoids page breaks.
//
// AUTH: the viewer must be entitled to this learner — a parent via their own
// parent_links row, a teacher via a class of theirs the learner is enrolled
// in. Everyone else (including the learner) gets a 404, not a refusal that
// confirms the id exists. RLS scopes every read; reportAccess() re-checks the
// relationship explicitly on top.

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// DB status words → dictionary keys (same mapping the parent portal uses).
const STATUS_KEY: Record<string, keyof Dictionary["school"]["children"]["status"]> = {
  not_started: "notStarted",
  in_progress: "inProgress",
  completed: "completed",
  revised: "revised",
  submitted: "submitted",
};

export default async function ProgressReportPage({
  params,
}: {
  params: Promise<{ learnerId: string }>;
}) {
  const { learnerId } = await params;
  if (!UUID_RE.test(learnerId)) notFound();

  const locale = await resolveLocale();
  const dict = await getDictionary(locale);
  const t = dict.reports;
  const lang = htmlLang(locale);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, full_name, username")
    .eq("id", user.id)
    .maybeSingle();
  const role = (profile?.role as string | null) ?? null;
  // Students never hold a report over anyone; don't even run the checks.
  if (!role || role === "student") notFound();

  // The three relationship reads. All RLS-scoped to what this viewer may see;
  // reportAccess() then re-checks the ids explicitly.
  type NameJoin = { full_name: string | null; username: string | null } | null;
  const [linksQ, classesQ, enrQ] = await Promise.all([
    supabase
      .from("parent_links")
      .select("parent_id, child_id, profiles:child_id(full_name, username)")
      .eq("child_id", learnerId),
    supabase.from("classes").select("id, teacher_id").eq("teacher_id", user.id),
    supabase
      .from("enrollments")
      .select("class_id, student_id, profiles:student_id(full_name, username)")
      .eq("student_id", learnerId),
  ]);
  const links = (linksQ.data ?? []) as unknown as { parent_id: string; child_id: string; profiles: NameJoin }[];
  const taughtClasses = (classesQ.data ?? []) as { id: string; teacher_id: string }[];
  const enrollments = (enrQ.data ?? []) as unknown as { class_id: string; student_id: string; profiles: NameJoin }[];

  const access = reportAccess({
    viewerId: user.id,
    learnerId,
    parentLinks: links,
    taughtClasses,
    learnerEnrollments: enrollments,
  });
  if (!access.allowed) notFound();

  const learnerJoin = links.find((l) => l.profiles)?.profiles ?? enrollments.find((e) => e.profiles)?.profiles;
  const learnerName = learnerJoin?.full_name || learnerJoin?.username || dict.school.fallback.child;
  const preparedBy = profile?.full_name || profile?.username || user.email || dict.school.fallback.user;

  // The learner's work: shares addressed to them directly or to a class of
  // theirs, then the generations/progress/submissions those shares point at.
  const classIds = [...new Set(enrollments.map((e) => e.class_id))];
  const orFilter = classIds.length
    ? `student_id.eq.${learnerId},class_id.in.(${classIds.join(",")})`
    : `student_id.eq.${learnerId}`;
  const { data: sharesRaw } = await supabase
    .from("generation_shares")
    .select("generation_id, class_id, student_id, due_at, created_at")
    .or(orFilter);
  const shares = (sharesRaw ?? []) as ReportShareRow[];

  const genIds = [...new Set(shares.map((s) => s.generation_id))];
  let generations: ReportGenRow[] = [];
  let progress: ReportProgressRow[] = [];
  let submissions: ReportSubmissionRow[] = [];
  let books: { id: string; title: string; subject: string | null }[] = [];
  if (genIds.length) {
    const [gensQ, progQ, subsQ] = await Promise.all([
      supabase.from("generations").select("id, title, kind, chapter_ref, book_id").in("id", genIds),
      supabase
        .from("student_progress")
        .select("generation_id, student_id, status, completed_at, opened_at")
        .eq("student_id", learnerId)
        .in("generation_id", genIds),
      supabase
        .from("submissions")
        .select("generation_id, student_id, auto_score, teacher_score, max_score, grade_status, submitted_at, graded_at")
        .eq("student_id", learnerId)
        .in("generation_id", genIds),
    ]);
    generations = (gensQ.data ?? []) as ReportGenRow[];
    progress = (progQ.data ?? []) as ReportProgressRow[];
    submissions = (subsQ.data ?? []) as ReportSubmissionRow[];
    const bookIds = [...new Set(generations.map((g) => g.book_id).filter((b): b is string => b !== null))];
    if (bookIds.length) {
      // Fails open: a book row the viewer can't read (e.g. a parent and the
      // teacher's private book) just renders its section as "Other work".
      const { data: booksRaw } = await supabase.from("books").select("id, title, subject").in("id", bookIds);
      books = (booksRaw ?? []) as { id: string; title: string; subject: string | null }[];
    }
  }

  const report = buildProgressReport({ learnerId, learnerClassIds: classIds, shares, generations, progress, submissions });
  const bookOf = new Map(books.map((b) => [b.id, b]));

  const d = (iso: string) => new Date(iso).toLocaleDateString(lang);
  // (server component, rendered once per request)
  const today = new Date();

  const statusWord = (s: ReportItem["status"]) =>
    STATUS_KEY[s] ? dict.school.children.status[STATUS_KEY[s]] : s.replace("_", " ");
  const kindWord = (kind: string) => (dict.library.kinds as Record<string, string>)[kind] ?? kind;
  const summaryText = (s: ReportSummary) =>
    s.averagePct === null
      ? fmt(t.summaryLineNoScores, { assigned: s.assigned, completed: s.completed })
      : fmt(t.summaryLine, { assigned: s.assigned, completed: s.completed, avg: s.averagePct });

  const th = "py-1.5 pe-3 text-[10px] uppercase tracking-wide text-[#98A0A9] font-medium text-start";
  const td = "py-2 pe-3 text-sm align-top";

  return (
    <div className="min-h-screen bg-[#FCFCFA] text-[#14181F] print:bg-white">
      {/* Page-scoped print rule (the console financials pattern): the app
          header comes from a shared component, so a print:hidden inside it
          would bleed everywhere. This <style> only exists on THIS page. */}
      <style>{`@media print { header { display: none !important } }`}</style>
      <AppHeader />
      <main className="max-w-4xl mx-auto px-6 py-10 print:py-2">
        {/* The dated line that makes the printout stand on its own. */}
        <p className="hidden print:block text-sm text-[#5B6470] mb-4">
          SketchCast — {t.title} — {d(today.toISOString())}
        </p>

        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-4xl mb-1">{t.title}</h1>
            <InkUnderline className="block h-3 w-28 mb-3 print:hidden" />
            <p className="text-2xl font-display mb-2">{learnerName}</p>
            <p className="text-xs text-[#5B6470]">
              {fmt(t.preparedBy, { name: preparedBy })} · {fmt(t.generated, { date: d(today.toISOString()) })}
            </p>
            {report.firstActivityAt && report.lastActivityAt && (
              <p className="text-xs text-[#5B6470] mt-0.5">
                {fmt(t.range, { from: d(report.firstActivityAt), to: d(report.lastActivityAt) })}
              </p>
            )}
          </div>
          <PrintButton label={t.print} />
        </div>

        {report.empty ? (
          <div className="card px-5 py-8 mt-6 text-sm text-[#5B6470]">
            <p>{t.empty}</p>
            <p className="mt-1 text-xs text-[#98A0A9]">{t.emptyHint}</p>
          </div>
        ) : (
          <>
            <p className="mt-4 mb-6 text-sm font-medium">
              {t.overall}: <span className="font-normal">{summaryText(report.summary)}</span>
            </p>

            {report.sections.map((section) => {
              const book = section.bookId ? bookOf.get(section.bookId) : undefined;
              return (
                <section key={section.bookId ?? "other"} className="mb-8 break-inside-avoid">
                  <h2 className="text-xl mb-0.5">{book?.title ?? t.otherWork}</h2>
                  {book?.subject && <p className="text-xs text-[#5B6470] mb-1">{fmt(t.subject, { subject: book.subject })}</p>}
                  {section.chaptersCovered.length > 0 && (
                    <p className="text-xs text-[#5B6470] mb-2">
                      {fmt(t.chaptersCovered, { list: section.chaptersCovered.join(", ") })}
                    </p>
                  )}
                  <div className="card px-5 py-2 overflow-x-auto print:overflow-visible print:shadow-none">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-[#EEF0EC]">
                          <th className={th}>{t.columns.item}</th>
                          <th className={th}>{t.columns.assigned}</th>
                          <th className={th}>{t.columns.due}</th>
                          <th className={th}>{t.columns.status}</th>
                          <th className={th}>{t.columns.completed}</th>
                          <th className={`${th} pe-0`}>{t.columns.score}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {section.items.map((item) => (
                          <tr key={item.generationId} className="border-b border-[#EEF0EC] last:border-b-0">
                            <td className={`${td} min-w-40`}>
                              <span className="font-medium">{item.title || kindWord(item.kind)}</span>
                              {item.title && <span className="block text-xs text-[#98A0A9]">{kindWord(item.kind)}</span>}
                            </td>
                            <td className={`${td} whitespace-nowrap`}>{d(item.assignedAt)}</td>
                            <td className={`${td} whitespace-nowrap`}>{item.dueAt ? d(item.dueAt) : "—"}</td>
                            <td className={td}>{statusWord(item.status)}</td>
                            <td className={`${td} whitespace-nowrap`}>{item.completedAt ? d(item.completedAt) : "—"}</td>
                            <td className={`${td} pe-0 whitespace-nowrap`}>
                              {item.score ? (
                                <>
                                  <span className="tabular">
                                    {fmt(t.scoreValue, { points: item.score.points, max: item.score.max, pct: item.score.pct })}
                                  </span>
                                  <span className="block text-xs text-[#98A0A9]">
                                    {fmt(t.gradingOn, {
                                      grading:
                                        (t.grading as Record<string, string>)[item.score.gradeStatus] ?? item.score.gradeStatus,
                                      date: d(item.score.date),
                                    })}
                                  </span>
                                </>
                              ) : (
                                "—"
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-xs text-[#5B6470] mt-1.5">{summaryText(section.summary)}</p>
                </section>
              );
            })}
          </>
        )}
      </main>
    </div>
  );
}
