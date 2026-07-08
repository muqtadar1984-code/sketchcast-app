import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import AppHeader from "../app-header";
import { InkUnderline } from "@/components/ink-mark";
import { parentPortalEnabled, aiTutorEnabled } from "@/utils/flags";
import AddChild from "./add-child";
import CoachRecap from "../coach-recap";
import AskCoachButton from "../ask-coach-button";

// The parent home: one section per linked child — their school assignments
// (read-only: completion, due dates, scores) and the test papers this parent
// assigned. Every read is RLS-scoped to the parent's OWN children; classmates
// and other teachers' data are invisible by construction (migration 0018).

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = {
  presentation: "Video lesson",
  activity: "Activities",
  worksheet: "Worksheet",
  exam_paper: "Test paper",
  case_study: "Case study",
};

type ChildItem = {
  genId: string;
  kind: string;
  label: string;
  from: string;
  due: string | null;
  overdue: boolean;
  status: string;
  score: string | null;
};

export default async function ChildrenPage() {
  if (!parentPortalEnabled()) redirect("/dashboard");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  const role = (profile?.role as string | null) ?? null;
  if (!role || role === "student") redirect("/dashboard");

  // Linked children (RLS: own links only).
  type LinkRow = {
    child_id: string;
    verified_at: string | null;
    profiles: { full_name: string | null; username: string | null } | null;
  };
  const { data: linksRaw } = await supabase
    .from("parent_links")
    .select("child_id, verified_at, profiles:child_id(full_name, username)");
  const links = (linksRaw ?? []) as unknown as LinkRow[];
  if (links.length === 0 && role !== "parent") redirect("/dashboard");

  // The child slice, all RLS-scoped: enrollments → classes, shares (class +
  // direct), generations, progress, scores.
  const [enrQ, classesQ, sharesQ, gensQ, progQ, subsQ] = await Promise.all([
    supabase.from("enrollments").select("class_id, student_id"),
    supabase.from("classes").select("id, name"),
    supabase.from("generation_shares").select("generation_id, class_id, student_id, due_at, shared_by"),
    supabase.from("generations").select("id, title, kind, chapter_ref"),
    supabase.from("student_progress").select("generation_id, student_id, status"),
    supabase.from("submissions").select("generation_id, student_id, auto_score, teacher_score, max_score, grade_status"),
  ]);

  const enr = (enrQ.data ?? []) as { class_id: string; student_id: string }[];
  const className = new Map(((classesQ.data ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]));
  const shares = (sharesQ.data ?? []) as { generation_id: string; class_id: string | null; student_id: string | null; due_at: string | null; shared_by: string | null }[];
  const genOf = new Map(((gensQ.data ?? []) as { id: string; title: string | null; kind: string | null; chapter_ref: string | null }[]).map((g) => [g.id, g]));
  const progOf = new Map(((progQ.data ?? []) as { generation_id: string; student_id: string; status: string }[]).map((p) => [`${p.generation_id}|${p.student_id}`, p.status]));
  type Sub = { generation_id: string; student_id: string; auto_score: number | null; teacher_score: number | null; max_score: number | null };
  const subOf = new Map(((subsQ.data ?? []) as Sub[]).map((s) => [`${s.generation_id}|${s.student_id}`, s]));

  const classesOfChild = new Map<string, string[]>();
  for (const e of enr) {
    if (!classesOfChild.has(e.student_id)) classesOfChild.set(e.student_id, []);
    classesOfChild.get(e.student_id)!.push(e.class_id);
  }

  // (server component, rendered once per request)
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();

  function itemsFor(childId: string): { school: ChildItem[]; mine: ChildItem[] } {
    const childClasses = new Set(classesOfChild.get(childId) ?? []);
    const school: ChildItem[] = [];
    const mine: ChildItem[] = [];
    for (const s of shares) {
      const direct = s.student_id === childId;
      const viaClass = s.class_id != null && childClasses.has(s.class_id);
      if (!direct && !viaClass) continue;
      const g = genOf.get(s.generation_id);
      if (!g || g.kind === "lesson_plan") continue;
      const key = `${s.generation_id}|${childId}`;
      const status = progOf.get(key) ?? "not started";
      const sub = subOf.get(key);
      const score =
        sub && sub.max_score ? `${(sub.teacher_score ?? sub.auto_score) ?? "—"}/${sub.max_score}` : null;
      const item: ChildItem = {
        genId: s.generation_id,
        kind: g.kind ?? "",
        label: g.title || KIND_LABEL[g.kind ?? ""] || "Item",
        from: direct ? "you" : className.get(s.class_id!) ?? "class",
        due: s.due_at,
        overdue: !!s.due_at && new Date(s.due_at).getTime() < now && status !== "completed" && !sub,
        status: sub ? "submitted" : status,
        score,
      };
      (direct && s.shared_by === user!.id ? mine : school).push(item);
    }
    return { school, mine };
  }

  const STATUS_TONE: Record<string, string> = {
    completed: "bg-[#E2F4F1] text-[#0C8175]",
    submitted: "bg-[#E2F4F1] text-[#0C8175]",
    in_progress: "bg-[#FFF1D6] text-[#9A6400]",
  };
  const coachOn = aiTutorEnabled();

  return (
    <div className="min-h-screen bg-[#FCFCFA] text-[#14181F]">
      <AppHeader />
      <main className="max-w-4xl mx-auto px-6 py-10">
        <h1 className="text-4xl mb-2">My children</h1>
        <InkUnderline className="block h-3 w-28 mb-3" />
        <p className="text-[#5B6470] mb-6">
          What each child is working on — schoolwork read-only, plus the test papers you assign.
        </p>

        <div className="space-y-5 mb-6">
          {links.length === 0 && (
            <div className="card px-5 py-8 text-sm text-[#5B6470]">
              No children linked yet. Add your child below — or if their school invited you, open the
              link from that email.
            </div>
          )}
          {links.map((l) => {
            const { school, mine } = itemsFor(l.child_id);
            const name = l.profiles?.full_name || l.profiles?.username || "Child";
            const renderRows = (rows: ChildItem[]) =>
              rows.map((it, i) => (
                <div key={i} className="px-5 py-2.5 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate">
                      {it.label} <span className="text-xs text-[#5B6470]">· from {it.from}</span>
                      {it.due && (
                        <span className={`text-xs ml-2 ${it.overdue ? "text-[#B3401F]" : "text-[#5B6470]"}`}>
                          due {new Date(it.due).toLocaleDateString()}
                        </span>
                      )}
                    </span>
                    <span className="flex items-center gap-2 shrink-0">
                      {it.score && <span className="tabular text-xs">{it.score}</span>}
                      <span className={`chip font-sans normal-case tracking-normal ${STATUS_TONE[it.status] ?? "bg-[#EEF0EC] text-[#5B6470]"}`}>
                        {it.status.replace("_", " ")}
                      </span>
                    </span>
                  </div>
                  {coachOn && it.kind === "presentation" && (
                    <div className="mt-1.5 flex items-center gap-3 text-xs">
                      <CoachRecap studentId={l.child_id} generationId={it.genId} />
                      <AskCoachButton generationId={it.genId} chapterLabel={it.label} className="font-medium text-[#0C8175] hover:underline" />
                    </div>
                  )}
                </div>
              ));
            return (
              <div key={l.child_id} className="card divide-y divide-[#EEF0EC]">
                <div className="px-5 py-3 flex items-center justify-between">
                  <span className="font-medium text-lg font-display">{name}</span>
                  <span className="text-xs text-[#5B6470]">
                    {l.verified_at ? "" : "unverified link · confirm with the school"}
                  </span>
                </div>
                <p className="px-5 py-1.5 text-xs font-medium text-[#5B6470] bg-[#FAFBF9]">School work ({school.length})</p>
                {school.length ? renderRows(school) : <p className="px-5 py-2.5 text-sm text-[#98A0A9]">Nothing assigned by school yet.</p>}
                <p className="px-5 py-1.5 text-xs font-medium text-[#5B6470] bg-[#FAFBF9]">From you ({mine.length})</p>
                {mine.length ? renderRows(mine) : <p className="px-5 py-2.5 text-sm text-[#98A0A9]">No test papers assigned yet — create one under Test Papers.</p>}
              </div>
            );
          })}
        </div>

        <AddChild />
      </main>
    </div>
  );
}
