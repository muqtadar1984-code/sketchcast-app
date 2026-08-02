import { EmptyBooks } from "./icons";
import StudentItem, { type StudentItemData, type StudentItemMessages } from "./student-item";
import NoticeBanner from "./notice-banner";
import NoticesCard from "./notices-card";
import type { NoticesData } from "@/utils/notices";
import { InkUnderline } from "@/components/ink-mark";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";
import { htmlLang } from "@/i18n/locales";

export type { StudentItemData };
export type StudentChapter = { key: string; heading: string; items: StudentItemData[] };
export type StudentClassGroup = { className: string; chapters: StudentChapter[] };

// Student view (Phase B): chapters assigned to the student, grouped by class.
// Each item is interactive — the lesson plays in-app (complete at 100%), and
// worksheets/exams accept an answer upload. Status updates live.
//
// The first surface translated end to end: a child is the reader least likely
// to hold the school's second language, so this page reads in the family's own.
// It resolves its own dictionary (resolveLocale is React-cached, so asking here
// and in the header is one lookup) and hands every row ONE shared message
// object — the strings cross the client boundary, the dictionary never does.
export default async function StudentDashboard({
  groups,
  studentId,
  downloadsReady,
  notices = null,
}: {
  groups: StudentClassGroup[];
  studentId: string;
  downloadsReady: boolean;
  /** School notices (0068) — null when the feature is off for this school. */
  notices?: NoticesData | null;
}) {
  const locale = await resolveLocale();
  const dict = await getDictionary(locale);
  const t = dict.student;
  // Built once, shared by every row: one object in the RSC payload rather than
  // one per assignment.
  const itemMessages: StudentItemMessages = { ...t, close: dict.common.close };
  return (
    <main className="max-w-7xl mx-auto px-6 py-10">
      <h1 className="text-4xl mb-2">{t.title}</h1>
      <InkUnderline className="block h-3 w-28 mb-3" />
      <p className="text-[#5B6470] mb-7">{t.subtitle}</p>

      {/* The school's own news, above the lessons: a student's page has nothing
          else competing at the top, so both surfaces sit together. */}
      {notices && <NoticeBanner notices={notices.featured} />}
      {notices && <NoticesCard notices={notices.upcoming} />}

      {!downloadsReady && (
        <p className="mb-6 text-sm text-[#9A6400] bg-[#FFF1D6] rounded-lg px-3 py-2">{t.downloadsNotReady}</p>
      )}

      {groups.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[#D2D6D1] bg-white/60 p-10 text-center text-[#5B6470]">
          <EmptyBooks />
          {t.empty}
        </div>
      ) : (
        <div className="space-y-8">
          {groups.map((g) => (
            <section key={g.className}>
              <h2 className="chip font-sans bg-[#E2F4F1] text-[#0C8175] mb-2.5">{g.className}</h2>
              <div className="card divide-y divide-[#EEF0EC]">
                {g.chapters.map((ch) => (
                  <div key={ch.key} className="px-5 py-3">
                    <div className="font-display font-medium mb-2">{ch.heading}</div>
                    <ul className="space-y-1.5">
                      {ch.items.map((it) => (
                        <StudentItem
                          key={it.genId}
                          item={it}
                          studentId={studentId}
                          t={itemMessages}
                          lang={htmlLang(locale)}
                        />
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
