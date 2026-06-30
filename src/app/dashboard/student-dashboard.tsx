import { EmptyBooks } from "./icons";
import StudentItem, { type StudentItemData } from "./student-item";
import { InkUnderline } from "@/components/ink-mark";

export type { StudentItemData };
export type StudentChapter = { key: string; heading: string; items: StudentItemData[] };
export type StudentClassGroup = { className: string; chapters: StudentChapter[] };

// Student view (Phase B): chapters assigned to the student, grouped by class.
// Each item is interactive — the lesson plays in-app (complete at 100%), and
// worksheets/exams accept an answer upload. Status updates live.
export default function StudentDashboard({
  groups,
  studentId,
  downloadsReady,
}: {
  groups: StudentClassGroup[];
  studentId: string;
  downloadsReady: boolean;
}) {
  return (
    <main className="max-w-5xl mx-auto px-6 py-10">
      <h1 className="text-4xl mb-2">My lessons</h1>
      <InkUnderline className="block h-3 w-28 mb-3" />
      <p className="text-[#5B6470] mb-7">Everything your teacher has assigned to you.</p>

      {!downloadsReady && (
        <p className="mb-6 text-sm text-[#9A6400] bg-[#FFF1D6] rounded-lg px-3 py-2">
          Downloads aren&apos;t available yet — ask your teacher to finish setup.
        </p>
      )}

      {groups.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[#D2D6D1] bg-white/60 p-10 text-center text-[#5B6470]">
          <EmptyBooks />
          Nothing assigned yet. Check back after your teacher shares a lesson.
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
                        <StudentItem key={it.genId} item={it} studentId={studentId} />
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
