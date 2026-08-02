import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import AppHeader from "../../app-header";
import { InkUnderline } from "@/components/ink-mark";
import { schoolAnalyticsEnabledFor, noticesEnabledFor } from "@/utils/flags";
import { enforceHat } from "@/utils/hats-server";
import CoordinatorAdmin, { type Member, type Scope } from "../coordinator-admin";
import ResetPasswordButton from "../../reset-password-button";
import DeleteStudentButton from "../../delete-student-button";
import { RevokeNoticeButton } from "../../calendar/notice-composer";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";
import { fmt } from "@/i18n/format";

/** The explicit page for the parent-link read. PostgREST caps an unbounded
 * select at its own default and does not say so; a school would have to be
 * enormous to reach this one, and if it ever does the shortfall is shown as a
 * floor instead of quietly distorting the acknowledgment percentages. */
const PARENT_LINK_CAP = 2000;

/** Which banner pins are still live. The clock is read HERE, outside the
 * component: a render must never ask the time (react-hooks/purity), and a pin
 * that expires between two re-renders is exactly the kind of unstable result
 * that rule exists to catch. */
function livePinIds(rows: { id: string; featured_until: string | null }[]): Set<string> {
  const now = Date.now();
  return new Set(
    rows.filter((r) => r.featured_until && new Date(r.featured_until).getTime() > now).map((r) => r.id),
  );
}

// Admin settings (school_admin only): roster role management + the
// coordinator → (grade, subject) scope mapping that drives the whole permission
// model, the published-notice review, plus the DPDP access-audit trail. Behind
// FEATURE_SCHOOL_ANALYTICS.
export default async function SchoolAdminPage() {
  const locale = await resolveLocale();
  const dict = await getDictionary(locale);
  const t = dict.school.admin;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, role, school_id")
    .eq("id", user.id)
    .single();
  // Global env flag OR this school's config override (the sales-demo tenant).
  if (!(await schoolAnalyticsEnabledFor(supabase, profile?.school_id as string | null)))
    redirect("/dashboard");
  const role = (profile?.role as string | null) ?? null;
  if (role === "coordinator") redirect("/dashboard/school");
  if (role !== "school_admin") redirect("/dashboard");
  // One-hat mode: Admin settings belong to the Principal hat only.
  const hatAway = await enforceHat(supabase, role, (profile?.school_id as string | null) ?? null, "principal");
  if (hatAway) redirect(hatAway);

  // School roster (teachers + coordinators), scope rows, and the option lists.
  const { data: peopleRaw } = await supabase
    .from("profiles")
    .select("id, full_name, username, role")
    .eq("school_id", profile!.school_id);
  const people = (peopleRaw ?? []) as { id: string; full_name: string | null; username: string | null; role: string }[];
  const nameOf = new Map(people.map((p) => [p.id, p.full_name || p.username || dict.school.fallback.user] as const));
  const members: Member[] = people
    .filter((p) => p.role === "teacher" || p.role === "coordinator")
    .map((p) => ({
      id: p.id,
      name: p.full_name || p.username || dict.school.fallback.user,
      role: p.role as "teacher" | "coordinator",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // School students, with their class names (best-effort — RLS leadership
  // reads). The admin is the deletion authority for every school student.
  const students = people
    .filter((p) => p.role === "student")
    .map((p) => ({ id: p.id, name: p.full_name || p.username || dict.school.fallback.student, username: p.username }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const classesOf = new Map<string, string[]>();
  if (students.length) {
    const { data: enrRaw } = await supabase
      .from("enrollments")
      .select("student_id, classes(name)");
    for (const e of (enrRaw ?? []) as unknown as { student_id: string; classes: { name: string } | null }[]) {
      if (!e.classes?.name) continue;
      if (!classesOf.has(e.student_id)) classesOf.set(e.student_id, []);
      classesOf.get(e.student_id)!.push(e.classes.name);
    }
  }

  const { data: scopesRaw } = await supabase
    .from("coordinator_scope")
    .select("id, coordinator_id, grade, subject")
    .eq("school_id", profile!.school_id);
  const scopes = (scopesRaw ?? []) as Scope[];

  const { data: classesRaw } = await supabase.from("classes").select("grade");
  const grades = [...new Set((classesRaw ?? []).map((c) => (c.grade as string | null)?.trim()).filter(Boolean) as string[])].sort();

  const { data: booksRaw } = await supabase.from("books").select("subject");
  const subjects = [...new Set((booksRaw ?? []).map((b) => (b.subject as string | null)?.trim()).filter(Boolean) as string[])].sort();

  // ── Published notices (0068) ────────────────────────────────────────────────
  // The review side of the announcement layer: what the school has said, who it
  // reached, how far the acknowledgment has got, and the one hand that can take
  // it back. Gated separately from the analytics flag because a pre-0068
  // database has no status/importance columns — reading them would break a page
  // that works today.
  const noticesOn = await noticesEnabledFor(supabase, profile!.school_id as string | null);

  type NoticeRow = {
    id: string;
    title: string;
    audience: string;
    importance: string;
    starts_at: string | null;
    action_by: string | null;
    action_label: string | null;
    featured_until: string | null;
    link_url: string | null;
    link_label: string | null;
    created_by: string | null;
    created_at: string;
  };
  let notices: NoticeRow[] = [];
  const ackCount = new Map<string, number>();
  let pinnedIds = new Set<string>();
  let unverifiedNames: string[] = [];
  let unverifiedLinks = 0;
  let linkedParents = 0;
  let linksTruncated = false;

  if (noticesOn) {
    // Rows published AS notices (is_notice) — school-wide and staff-wide native
    // ones only. An ordinary calendar entry shares the audience and is NOT an
    // announcement: without this filter every school-wide holiday already in
    // the table would appear here demanding a read-rate. 'class' events belong
    // to their teacher and 'leadership' notes are not announcements either.
    // Revoked rows stay readable to leadership (se_read keeps the audit trail)
    // but this is the LIVE list, so it filters them out itself.
    const { data: noticeRaw } = await supabase
      .from("school_events")
      .select(
        "id, title, audience, importance, starts_at, action_by, action_label, featured_until, link_url, link_label, created_by, created_at",
      )
      .eq("school_id", profile!.school_id)
      .eq("source", "native")
      .eq("status", "published")
      .eq("is_notice", true)
      .in("audience", ["school", "staff"])
      .order("created_at", { ascending: false })
      .limit(25);
    notices = (noticeRaw ?? []) as NoticeRow[];
    pinnedIds = livePinIds(notices);

    // The signature sheet, COUNTED IN THE DATABASE. Selecting the rows and
    // counting them here would silently stop at PostgREST's default page —
    // a notice past that cap would show a read-rate that only ever fell. Asked
    // exactly of the notices that invite a signature (staff notices, and
    // important Everyone ones); the rest display no number at all. na_read
    // hands leadership every ack on their own school's notices; everyone else
    // sees only their own row.
    const seeking = notices.filter((n) => n.audience === "staff" || n.importance === "important");
    const counts = await Promise.all(
      seeking.map((n) =>
        supabase.from("notice_acks").select("event_id", { count: "exact", head: true }).eq("event_id", n.id),
      ),
    );
    seeking.forEach((n, i) => ackCount.set(n.id, counts[i].count ?? 0));

    // Parents of this school's students (pl_admin_read scopes the read; an
    // admin who is ALSO a parent elsewhere would see their own links too, so
    // the child is checked against the school roster). Two jobs: the
    // denominator for an important Everyone notice, and the data-quality nudge
    // below. Bounded on purpose — an unbounded select stops at PostgREST's
    // default page and says nothing, which would quietly shrink a denominator
    // and inflate every percentage on the page. The cap is far above any
    // plausible roster; if it is ever reached the count is a floor, and the
    // rows say so with a "+" rather than lying with a round number.
    const studentIds = new Set(students.map((s) => s.id));
    type LinkRow = { parent_id: string; child_id: string; verified_at: string | null };
    const { data: plRaw } = await supabase
      .from("parent_links")
      .select("parent_id, child_id, verified_at")
      // School-ISSUED links only: a parent who registered their own child at
      // home is not part of the school's audience (0068's affiliation rule).
      .eq("source", "school")
      .order("created_at")
      .limit(PARENT_LINK_CAP);
    linksTruncated = (plRaw?.length ?? 0) >= PARENT_LINK_CAP;
    const schoolLinks = ((plRaw ?? []) as LinkRow[]).filter((l) => studentIds.has(l.child_id));
    linkedParents = new Set(schoolLinks.map((l) => l.parent_id)).size;
    // The parents themselves are unnameable here — they carry no school_id, so
    // profiles_read_self never returns them to an admin. Name the CHILD whose
    // record the address didn't match, which is what a principal looks up
    // anyway. Deduped: two unmatched links on one child is still one student
    // to ask about.
    unverifiedLinks = schoolLinks.filter((l) => !l.verified_at).length;
    unverifiedNames = [
      ...new Set(
        schoolLinks.filter((l) => !l.verified_at).map((l) => nameOf.get(l.child_id) || dict.school.fallback.student),
      ),
    ].sort((a, b) => a.localeCompare(b));
  }

  // Denominators — of who is ASKED, not of who can read. A staff notice asks
  // the staff room; an important Everyone notice asks the PARENTS (that is the
  // whole mechanic — a permission slip is a parent's to sign). Counting the
  // students and the teachers into an Everyone denominator, as this page used
  // to, made every percentage read low for a reason no principal could see.
  const staffTotal = people.filter((p) => p.role !== "student").length;

  // Notices are school-time things; format them the way the calendar does
  // rather than in whatever zone the principal's laptop is set to.
  const noticeFmt = new Intl.DateTimeFormat("en-MY", {
    timeZone: "Asia/Kuala_Lumpur",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  const when = (iso: string) => noticeFmt.format(new Date(iso));

  type LogRow = { id: string; actor_id: string; actor_role: string | null; scope: string; target_kind: string | null; detail: { at_risk?: number; students?: number } | null; created_at: string };
  const { data: logRaw } = await supabase
    .from("analytics_access_log")
    .select("id, actor_id, actor_role, scope, target_kind, detail, created_at")
    .order("created_at", { ascending: false })
    .limit(25);
  const log = (logRaw ?? []) as LogRow[];

  return (
    <div className="min-h-screen bg-[#FCFCFA] text-[#14181F]">
      <AppHeader />
      <main className="max-w-7xl mx-auto px-6 py-10">
        <h1 className="text-4xl mb-2">{t.title}</h1>
        <InkUnderline className="block h-3 w-28 mb-3" />
        <p className="text-[#5B6470] mb-7">{t.subtitle}</p>

        <CoordinatorAdmin
          members={members}
          scopes={scopes}
          grades={grades}
          subjects={subjects}
          t={{
            ...dict.school.coordinators,
            teacherAndCoordinator: dict.nav.roleLabel.teacherAndCoordinator,
            somethingWentWrong: dict.common.somethingWentWrong,
          }}
        />

        {noticesOn && (
          <>
            <h2 className="text-xl mt-10 mb-1">{t.notices.title}</h2>
            <p className="text-sm text-[#5B6470] mb-3">{t.notices.hint}</p>
            {notices.length === 0 ? (
              <div className="card px-5 py-6 text-sm text-[#5B6470]">{t.notices.empty}</div>
            ) : (
              <div className="card divide-y divide-[#EEF0EC]">
                {notices.map((n) => {
                  const acked = ackCount.get(n.id) ?? 0;
                  const staffNotice = n.audience === "staff";
                  // Staff notices always seek a confirmation, from staff;
                  // Everyone notices only when they are marked important, and
                  // then from parents. Anything else asks for nothing, and the
                  // row says so rather than showing a 0%.
                  const progress = staffNotice
                    ? fmt(t.notices.readByStaff, { n: acked, total: staffTotal })
                    : n.importance !== "important"
                      ? t.notices.noAckAsked
                      : linkedParents > 0
                        ? fmt(t.notices.ackParents, {
                            pct: Math.round((acked / linkedParents) * 100),
                            n: acked,
                            total: `${linkedParents}${linksTruncated ? "+" : ""}`,
                          })
                        : fmt(t.notices.ackNoParents, { n: acked });
                  const pinned = pinnedIds.has(n.id);
                  return (
                    <div key={n.id} className="px-5 py-3 flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-[#14181F] truncate">{n.title}</div>
                        <div className="text-xs text-[#5B6470]">
                          {staffNotice ? t.notices.staffOnly : t.notices.everyone}
                          {" · "}
                          {nameOf.get(n.created_by ?? "") || dict.school.fallback.school}
                          {n.starts_at ? ` · ${when(n.starts_at)}` : ""}
                          {n.action_by ? ` · ${n.action_label || t.notices.byFallback} ${when(n.action_by)}` : ""}
                          {pinned ? ` · ${fmt(t.notices.featuredUntil, { when: when(n.featured_until!) })}` : ""}
                        </div>
                        <div className="text-xs text-[#98A0A9] tabular">{progress}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        {n.importance === "important" && (
                          <span className="chip bg-[#FCEBEA] text-[#B42318]">{t.notices.important}</span>
                        )}
                        {n.link_url && (
                          <span className="chip bg-[#EEF0EC] text-[#5B6470] normal-case tracking-normal">
                            {n.link_label || t.notices.link}
                          </span>
                        )}
                        <RevokeNoticeButton eventId={n.id} title={n.title} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {/* A signal, never a block: these parents keep full access. An
                unmatched email usually means a sibling's address or a typo at
                invite time — worth a word at the next parents' evening, and
                worth knowing before you assume a notice landed. */}
            {unverifiedLinks > 0 &&
              (() => {
                const names =
                  unverifiedNames.slice(0, 8).join(", ") +
                  (unverifiedNames.length > 8
                    ? ` ${fmt(t.notices.andMore, { n: unverifiedNames.length - 8 })}`
                    : "");
                return (
                  <p className="text-xs text-[#98A0A9] mt-2">
                    {unverifiedLinks === 1
                      ? fmt(t.notices.unverifiedOne, { names })
                      : fmt(t.notices.unverifiedMany, { n: unverifiedLinks, names })}
                  </p>
                );
              })()}
          </>
        )}

        <h2 className="text-xl mt-10 mb-1">{t.members.title}</h2>
        <p className="text-sm text-[#5B6470] mb-3">{t.members.hint}</p>
        {members.length === 0 ? (
          <div className="card px-5 py-6 text-sm text-[#5B6470]">{t.members.empty}</div>
        ) : (
          <div className="card divide-y divide-[#EEF0EC]">
            {members.map((m) => (
              <div key={m.id} className="px-5 py-2.5 flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">
                  <span className="font-medium">{m.name}</span>
                  <span className="text-[#5B6470]"> · {t.role[m.role] ?? m.role}</span>
                </span>
                <ResetPasswordButton targetId={m.id} name={m.name} />
              </div>
            ))}
          </div>
        )}

        <h2 className="text-xl mt-10 mb-1">{t.students.title}</h2>
        <p className="text-sm text-[#5B6470] mb-3">{t.students.hint}</p>
        {students.length === 0 ? (
          <div className="card px-5 py-6 text-sm text-[#5B6470]">{t.students.empty}</div>
        ) : (
          <div className="card divide-y divide-[#EEF0EC]">
            {students.map((s) => (
              <div key={s.id} className="px-5 py-2.5 flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">
                  <span className="font-medium">{s.name}</span>
                  {s.username && <span className="text-[#5B6470]"> · {s.username}</span>}
                  {(classesOf.get(s.id) ?? []).length > 0 && (
                    <span className="text-[#5B6470]"> · {classesOf.get(s.id)!.join(", ")}</span>
                  )}
                </span>
                <span className="flex items-center gap-3 shrink-0">
                  <ResetPasswordButton targetId={s.id} name={s.name} />
                  <DeleteStudentButton targetId={s.id} name={s.name} />
                </span>
              </div>
            ))}
          </div>
        )}

        <h2 className="text-xl mt-10 mb-1">{t.audit.title}</h2>
        <p className="text-sm text-[#5B6470] mb-3">{t.audit.hint}</p>
        {log.length === 0 ? (
          <div className="card px-5 py-6 text-sm text-[#5B6470]">{t.audit.empty}</div>
        ) : (
          <div className="card divide-y divide-[#EEF0EC]">
            {log.map((l) => (
              <div key={l.id} className="px-5 py-2.5 flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">
                  <span className="font-medium">{nameOf.get(l.actor_id) || dict.school.fallback.user}</span>
                  <span className="text-[#5B6470]"> · {l.actor_role}</span>
                </span>
                <span className="flex items-center gap-3 shrink-0 text-xs text-[#5B6470]">
                  <span className="chip bg-[#EEF0EC] text-[#5B6470] normal-case tracking-normal">{l.scope}</span>
                  {l.detail?.at_risk != null && (
                    <span className="tabular">{fmt(t.audit.atRisk, { n: l.detail.at_risk })}</span>
                  )}
                  <span className="tabular">{new Date(l.created_at).toLocaleString()}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
