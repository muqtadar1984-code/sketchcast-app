import { createAdminClient } from "@/utils/supabase/admin";
import { InkUnderline } from "@/components/ink-mark";

// Beta feedback — submissions, average ratings, distributions. Moved here from
// /dashboard/beta-feedback (which now redirects) as the console's Feedback
// section; the console layout provides the staff gate.

export const dynamic = "force-dynamic";

const RATING_KEYS = [
  { key: "overall", label: "Overall" },
  { key: "lesson_quality", label: "Lesson quality" },
  { key: "deck_quality", label: "Deck quality" },
  { key: "ease_of_use", label: "Ease of use" },
] as const;

type FeedbackRow = {
  id: string;
  teacher_id: string;
  overall: number;
  lesson_quality: number;
  deck_quality: number;
  ease_of_use: number;
  worked_well: string | null;
  improve: string | null;
  trigger_type: string;
  context: Record<string, unknown> | null;
  submitted_at: string;
};

export default async function ConsoleFeedbackPage() {
  const admin = createAdminClient();
  const { data: rowsRaw } = await admin
    .from("beta_feedback")
    .select("*")
    .order("submitted_at", { ascending: false });
  const rows = (rowsRaw ?? []) as FeedbackRow[];

  const teacherIds = rows.map((r) => r.teacher_id);
  const { data: profs } = teacherIds.length
    ? await admin.from("profiles").select("id, full_name, username").in("id", teacherIds)
    : { data: [] };
  const nameOf = new Map((profs ?? []).map((p) => [p.id, p.full_name || p.username || "Teacher"] as const));

  const avg = (key: (typeof RATING_KEYS)[number]["key"]) =>
    rows.length ? Math.round((rows.reduce((s, r) => s + (r[key] ?? 0), 0) / rows.length) * 10) / 10 : 0;
  const dist = (key: (typeof RATING_KEYS)[number]["key"]) => {
    const d = [0, 0, 0, 0, 0];
    for (const r of rows) {
      const v = r[key];
      if (v >= 1 && v <= 5) d[v - 1]++;
    }
    return d;
  };

  return (
    <main className="max-w-4xl mx-auto px-6 py-10">
      <h1 className="text-4xl mb-2">Beta feedback</h1>
      <InkUnderline className="block h-3 w-28 mb-3" />
      <p className="text-[#5B6470] mb-7">
        {rows.length} submission{rows.length === 1 ? "" : "s"} from beta teachers.
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        {RATING_KEYS.map((k) => (
          <div key={k.key} className="rounded-xl bg-white border border-[#E6E8E4] px-4 py-3">
            <div className="text-xs text-[#5B6470]">{k.label}</div>
            <div className="text-2xl tabular mt-0.5">
              {rows.length ? `${avg(k.key)}/5` : "—"}
            </div>
            <div className="flex items-end gap-0.5 h-6 mt-2" aria-hidden>
              {dist(k.key).map((n, i) => {
                const max = Math.max(...dist(k.key), 1);
                return (
                  <div key={i} className="flex-1 rounded-t bg-[#1FB8A6]" style={{ height: `${(n / max) * 100}%`, minHeight: n ? 3 : 1, opacity: n ? 1 : 0.15 }} title={`${i + 1}★: ${n}`} />
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="card px-5 py-8 text-sm text-[#5B6470]">No feedback yet.</div>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <div key={r.id} className="card p-5">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                <span className="font-medium">{nameOf.get(r.teacher_id) || "Teacher"}</span>
                <span className="flex items-center gap-2 text-xs text-[#5B6470]">
                  <span className="chip bg-[#EEF0EC] text-[#5B6470] normal-case tracking-normal">{r.trigger_type}</span>
                  <span className="tabular">{new Date(r.submitted_at).toLocaleString()}</span>
                </span>
              </div>
              <div className="flex flex-wrap gap-2 mb-3">
                {RATING_KEYS.map((k) => (
                  <span key={k.key} className="chip font-sans bg-[#E2F4F1] text-[#0C8175]">
                    {k.label}: {r[k.key]}/5
                  </span>
                ))}
              </div>
              {r.worked_well && (
                <p className="text-sm mb-1.5">
                  <span className="text-[#0C8175] font-medium">Worked well:</span> {r.worked_well}
                </p>
              )}
              {r.improve && (
                <p className="text-sm mb-1.5">
                  <span className="text-[#9A6400] font-medium">Improve:</span> {r.improve}
                </p>
              )}
              {r.context && Object.keys(r.context).length > 0 && (
                <p className="text-xs text-[#98A0A9] mt-2">
                  Context: {String(r.context.book ?? "—")} · ch {String(r.context.chapter_ref ?? "—")} ·{" "}
                  {Array.isArray(r.context.generations) ? r.context.generations.length : 0} generations ·{" "}
                  {String(r.context.artifacts_viewed ?? 0)} artifacts viewed
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
