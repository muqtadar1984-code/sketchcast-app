import { EmptyBooks, TypeIcon } from "./icons";

export type StudentItem = {
  genId: string;
  kind: string;
  label: string;
  dueAt: string | null;
  video: string | null;
  deck: string | null;
  doc: string | null;
};
export type StudentChapter = { key: string; heading: string; items: StudentItem[] };
export type StudentClassGroup = { className: string; chapters: StudentChapter[] };

function dueLabel(due: string | null): { text: string; overdue: boolean } | null {
  if (!due) return null;
  const d = new Date(due);
  const overdue = d.getTime() < Date.now();
  return { text: `Due ${d.toLocaleDateString()}`, overdue };
}

// Read-only student view (Phase A): the chapters assigned to the student,
// grouped by class, with links to open each piece. Completion/progress arrives
// in Phase B.
export default function StudentDashboard({
  groups,
  downloadsReady,
}: {
  groups: StudentClassGroup[];
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
                      {ch.items.map((it) => {
                        const due = dueLabel(it.dueAt);
                        return (
                          <li key={it.genId} className="flex items-center justify-between gap-4">
                            <span className="flex items-center gap-1.5 text-sm min-w-0">
                              <TypeIcon kind={it.kind} />
                              <span className="text-[10px] uppercase tracking-wide text-[#9A958A]">{it.label}</span>
                            </span>
                            <span className="flex items-center gap-3 shrink-0 text-xs">
                              {due && (
                                <span className={due.overdue ? "text-[#A32D2D]" : "text-[#6F6A5F]"}>{due.text}</span>
                              )}
                              {it.video && (
                                <a href={it.video} target="_blank" className="font-medium text-[#2E6B4E] hover:underline">▶ Watch</a>
                              )}
                              {it.deck && (
                                <a href={it.deck} className="font-medium text-[#2E6B4E] hover:underline">⬇ Deck</a>
                              )}
                              {it.doc && (
                                <a href={it.doc} className="font-medium text-[#2E6B4E] hover:underline">⬇ Open</a>
                              )}
                            </span>
                          </li>
                        );
                      })}
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
