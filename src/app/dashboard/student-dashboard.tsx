import { EmptyBooks } from "./icons";
import StudentItem, { type StudentItemData } from "./student-item";

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
      <div className="h-1 w-14 rounded-full bg-[#C77F2A] mb-3" />
      <p className="text-[#6F6A5F] mb-7">Everything your teacher has assigned to you.</p>

      {!downloadsReady && (
        <p className="mb-6 text-sm text-[#854F0B] bg-[#FAEEDA] rounded-lg px-3 py-2">
          Downloads aren&apos;t available yet — ask your teacher to finish setup.
        </p>
      )}

      {groups.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[#D9CFB8] bg-white/60 p-10 text-center text-[#6F6A5F]">
          <EmptyBooks />
          Nothing assigned yet. Check back after your teacher shares a lesson.
        </div>
      ) : (
        <div className="space-y-8">
          {groups.map((g) => (
            <section key={g.className}>
              <h2 className="chip font-sans bg-[#EAF1EC] text-[#2E6B4E] mb-2.5">{g.className}</h2>
              <div className="card divide-y divide-[#F1ECE0]">
                {g.chapters.map((ch) => (
                  <div key={ch.key} className="px-5 py-3">
                    <div className="font-serif font-medium mb-2">{ch.heading}</div>
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
