import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/utils/supabase/admin";
import { requirePlatformAdmin } from "@/utils/platform-admin";

// Read-only "view as" lens: server-renders the target's world through the
// service role, filtered to exactly what that user owns/sees. Deliberately
// NOT a session swap — there is nothing interactive here, so staff cannot
// mutate anything "as" the user. Every open writes a view_as audit row
// (same DPDP posture as the school analytics access log). Student views
// show assignment status and scores, never submission content bodies.

export const dynamic = "force-dynamic";

export default async function ViewAsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const staff = await requirePlatformAdmin();
  const { id } = await params;
  const admin = createAdminClient();

  const { data: profRaw } = await admin
    .from("profiles")
    .select("id, full_name, username, role, school_id")
    .eq("id", id)
    .maybeSingle();
  if (!profRaw) notFound();
  const name = profRaw.full_name || profRaw.username || "User";
  const role = (profRaw.role as string) ?? "?";
  const isStudent = role === "student";

  // The lens is itself sensitive access — audit every open.
  await admin.from("platform_audit_log").insert({
    actor_id: staff.id,
    action: "view_as",
    target_kind: "profile",
    target_id: id,
    detail: { role },
  });

  let sections: { title: string; rows: { main: string; side: string }[] }[] = [];

  if (isStudent) {
    // Assigned work: shares into the student's classes (+ direct shares if the
    // parent-portal column exists later), joined with progress + scores.
    const { data: enr } = await admin
      .from("enrollments")
      .select("class_id, classes(name)")
      .eq("student_id", id);
    const classIds = (enr ?? []).map((e) => e.class_id as string);
    type Share = { generation_id: string; class_id: string | null; due_at: string | null };
    const { data: sharesRaw } = classIds.length
      ? await admin.from("generation_shares").select("generation_id, class_id, due_at").in("class_id", classIds)
      : { data: [] };
    const shares = (sharesRaw ?? []) as Share[];
    const genIds = [...new Set(shares.map((s) => s.generation_id))];
    const { data: gens } = genIds.length
      ? await admin.from("generations").select("id, title, kind, chapter_ref").in("id", genIds)
      : { data: [] };
    const genOf = new Map((gens ?? []).map((g) => [g.id as string, g] as const));
    const { data: prog } = await admin
      .from("student_progress")
      .select("generation_id, status, progress_pct")
      .eq("student_id", id);
    const progOf = new Map((prog ?? []).map((p) => [p.generation_id as string, p] as const));
    const { data: subs } = await admin
      .from("submissions")
      .select("generation_id, grade_status, auto_score, teacher_score, max_score")
      .eq("student_id", id);
    const subOf = new Map((subs ?? []).map((s) => [s.generation_id as string, s] as const));

    sections = [
      {
        title: `Classes (${(enr ?? []).length})`,
        rows: (enr ?? []).map((e) => ({
          main: ((e.classes as { name?: string } | null)?.name as string) ?? "Class",
          side: "",
        })),
      },
      {
        title: `Assigned work (${shares.length})`,
        rows: shares.map((s) => {
          const g = genOf.get(s.generation_id);
          const p = progOf.get(s.generation_id);
          const sub = subOf.get(s.generation_id);
          const score =
            sub && sub.max_score
              ? ` · ${(sub.teacher_score ?? sub.auto_score) ?? "—"}/${sub.max_score}`
              : "";
          return {
            main: (g?.title as string) || (g?.kind as string) || "Item",
            side: `${p?.status ?? "not started"}${score}`,
          };
        }),
      },
    ];
  } else {
    const [booksQ, gensQ, classesQ, subsQ] = await Promise.all([
      admin.from("books").select("id, title, status").eq("owner_id", id),
      admin.from("generations").select("id, title, kind, status, chapter_ref").eq("owner_id", id).order("created_at", { ascending: false }).limit(30),
      admin.from("classes").select("id, name, grade, enrollments(count)").eq("teacher_id", id),
      admin.from("submissions").select("id, grade_status, generations!inner(owner_id)").eq("generations.owner_id", id).eq("grade_status", "pending"),
    ]);
    sections = [
      {
        title: `Books (${(booksQ.data ?? []).length})`,
        rows: (booksQ.data ?? []).map((b) => ({ main: (b.title as string) || "Untitled", side: b.status as string })),
      },
      {
        title: `Lessons & documents (${(gensQ.data ?? []).length} recent)`,
        rows: (gensQ.data ?? []).map((g) => ({
          main: (g.title as string) || (g.kind as string) || "generation",
          side: g.status as string,
        })),
      },
      {
        title: `Classes (${(classesQ.data ?? []).length})`,
        rows: (classesQ.data ?? []).map((c) => ({
          main: `${c.name}${c.grade ? ` · Grade ${c.grade}` : ""}`,
          side: `${((c.enrollments as { count: number }[] | null)?.[0]?.count ?? 0)} students`,
        })),
      },
      {
        title: `Grading backlog`,
        rows: [{ main: "Submissions awaiting a grade", side: String((subsQ.data ?? []).length) }],
      },
    ];
  }

  return (
    <main className="max-w-4xl mx-auto px-6 py-8">
      <div className="rounded-xl bg-[#FFF1D6] text-[#9A6400] px-4 py-3 text-sm mb-6 flex items-center justify-between gap-3">
        <span>
          Read-only view as <span className="font-medium">{name}</span> ({role}) — nothing here is
          clickable, and this access is audited.
        </span>
        <Link href={`/console/users/${id}`} className="font-medium hover:underline shrink-0">
          ← Back to account
        </Link>
      </div>

      <div className="space-y-4">
        {sections.map((s) => (
          <div key={s.title} className="card divide-y divide-[#EEF0EC]">
            <p className="px-5 py-2 text-xs font-medium text-[#5B6470]">{s.title}</p>
            {s.rows.length === 0 ? (
              <p className="px-5 py-3 text-sm text-[#98A0A9]">Nothing yet.</p>
            ) : (
              s.rows.map((r, i) => (
                <div key={i} className="px-5 py-2.5 flex items-center justify-between gap-3 text-sm">
                  <span className="truncate">{r.main}</span>
                  <span className="text-xs text-[#5B6470] shrink-0">{r.side}</span>
                </div>
              ))
            )}
          </div>
        ))}
      </div>
    </main>
  );
}
