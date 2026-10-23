import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/utils/supabase/admin";
import { InkUnderline } from "@/components/ink-mark";
import { founderEmails, requirePlatformAdmin } from "@/utils/platform-admin";
import OpsControls from "./ops-controls";
import { aggregateKitActivity, kitTopicsFor, EMPTY_KIT_ACTIVITY } from "@/utils/console-kit-activity";

// One account: profile, activity counts, their books, their Ready-made kits
// activity (Kits page opens, unlocks, downloads, Library copies — from
// catalogue_unlocks + catalogue_events), their issue reports, their staff
// audit trail, and the ops panel (suspend / caps / staff).

export const dynamic = "force-dynamic";

export default async function ConsoleUserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const staff = await requirePlatformAdmin(); // layout guards too; needed for founder check
  const { id } = await params;
  const admin = createAdminClient();

  // select("*") so missing 0015/0016 columns degrade instead of erroring.
  const { data: profRaw } = await admin.from("profiles").select("*").eq("id", id).maybeSingle();
  if (!profRaw) notFound();
  const p = profRaw as Record<string, unknown>;

  let email = "";
  try {
    const { data: u } = await admin.auth.admin.getUserById(id);
    email = u?.user?.email ?? "";
  } catch {
    // profile-only
  }

  let schoolName: string | null = null;
  if (p.school_id) {
    const { data: s } = await admin.from("schools").select("name").eq("id", p.school_id).maybeSingle();
    schoolName = (s?.name as string) ?? null;
  }

  const [classesQ, booksQ, gensQ, issuesQ, auditQ, staffQ, kitUnlocksQ, kitEventsQ] = await Promise.all([
    admin.from("classes").select("id", { count: "exact", head: true }).eq("teacher_id", id),
    admin.from("books").select("id, title, status, created_at").eq("owner_id", id),
    admin.from("generations").select("id, kind, status", { count: "exact" }).eq("owner_id", id),
    admin.from("platform_issues").select("id, title, status, created_at").eq("reporter_id", id).order("created_at", { ascending: false }).limit(5),
    admin.from("platform_audit_log").select("action, detail, created_at").eq("target_id", id).order("created_at", { ascending: false }).limit(10),
    admin.from("platform_admins").select("user_id").eq("user_id", id).is("revoked_at", null).maybeSingle(),
    admin.from("catalogue_unlocks").select("user_id, topic_id, unlocked_at").eq("user_id", id),
    admin.from("catalogue_events").select("user_id, topic_id, event, created_at").eq("user_id", id),
  ]);
  // 0110: Library portal membership. Read separately so a database without the
  // migration degrades to "no membership" instead of failing the whole page.
  let libraryRole: string | null = null;
  let libraryReady = true;
  {
    const q = await admin.from("library_members").select("role").eq("user_id", id).is("revoked_at", null).maybeSingle();
    if (q.error) libraryReady = false;
    else libraryRole = (q.data?.role as string | null) ?? null;
  }

  const gens = (gensQ.data ?? []) as { kind: string | null; status: string }[];
  const gensDone = gens.filter((g) => g.status === "done").length;
  const books = (booksQ.data ?? []) as { id: string; title: string | null; status: string; created_at: string }[];

  const kitUnlocks = (kitUnlocksQ.data ?? []) as { user_id: string; topic_id: string; unlocked_at: string }[];
  const kitEvents = (kitEventsQ.data ?? []) as { user_id: string | null; topic_id: string | null; event: string; created_at: string }[];
  const kit = aggregateKitActivity(kitUnlocks, kitEvents).get(id) ?? EMPTY_KIT_ACTIVITY;
  const kitTopics = kitTopicsFor(kitUnlocks, kitEvents);
  const topicTitle = new Map<string, string>();
  if (kitTopics.length) {
    const { data: t } = await admin.from("topics").select("id, title").in("id", kitTopics.map((k) => k.topic_id));
    for (const row of (t ?? []) as { id: string; title: string | null }[]) topicTitle.set(row.id, row.title || "Untitled topic");
  }
  const kitFacts: { label: string; value: string }[] = [
    { label: "Kits page opens", value: String(kit.views) },
    { label: "Last opened", value: kit.lastViewedAt ? new Date(kit.lastViewedAt).toLocaleString() : "never" },
    { label: "Kits unlocked", value: String(kit.unlocks) },
    { label: "Files downloaded", value: String(kit.downloads) },
    { label: "Videos played", value: String(kit.watches) },
    { label: "Copied to Library", value: String(kit.adopts) },
    { label: "Weekly limit hit", value: String(kit.weeklyLimitHits) },
  ];

  const opsReady = "suspended_at" in p && "max_books" in p;
  const isStaffTarget = !!staffQ.data || founderEmails().includes(email.toLowerCase());
  const role = (p.role as string) ?? "?";

  const facts: { label: string; value: string }[] = [
    { label: "Email", value: email || "—" },
    { label: "Username", value: (p.username as string) || "—" },
    { label: "Role", value: role },
    { label: "School", value: schoolName ?? "independent" },
    { label: "Joined", value: new Date(p.created_at as string).toLocaleDateString() },
    { label: "Classes", value: String(classesQ.count ?? 0) },
    { label: "Books", value: String(books.length) },
    { label: "Generations", value: `${gensDone} done / ${gens.length}` },
  ];

  return (
    <main className="max-w-7xl mx-auto px-6 py-10">
      <p className="mb-4 text-sm flex items-center justify-between">
        <Link href="/console/users" className="text-[#0C8175] hover:underline"><span className="rtl-flip">←</span> Users</Link>
        <Link href={`/console/users/${id}/view`} className="btn-ghost h-8 px-3 text-xs">
          View as (read-only)
        </Link>
      </p>
      <h1 className="text-3xl mb-2">
        {(p.full_name as string) || (p.username as string) || "User"}
        {/* beta_tester is auto-set on EVERY signup (0012) and drives the trial
            caps — it is a trial marker, not beta-programme membership. */}
        {p.beta_tester === true && <span className="chip font-sans bg-[#FFF1D6] text-[#9A6400] ms-3 align-middle">trial</span>}
        {opsReady && p.suspended_at != null && (
          <span className="chip font-sans bg-[#FFE9E3] text-[#B3401F] ms-2 align-middle">suspended</span>
        )}
        {isStaffTarget && <span className="chip font-sans bg-[#E2F4F1] text-[#0C8175] ms-2 align-middle">staff</span>}
        {!isStaffTarget && libraryRole && (
          <span className="chip font-sans bg-[#E6F4EC] text-[#1F6B45] ms-2 align-middle">library · {libraryRole}</span>
        )}
      </h1>
      <InkUnderline className="block h-3 w-28 mb-6" />

      <div className="grid lg:grid-cols-[1.2fr_1fr] gap-6 items-start">
        <div className="space-y-4">
          <div className="card px-5 py-4 grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
            {facts.map((f) => (
              <p key={f.label}>
                <span className="text-[#5B6470]">{f.label}: </span>
                <span className="font-medium break-all">{f.value}</span>
              </p>
            ))}
          </div>

          {books.length > 0 && (
            <div className="card divide-y divide-[#EEF0EC]">
              <p className="px-5 py-2 text-xs font-medium text-[#5B6470]">Books</p>
              {books.map((b) => (
                <div key={b.id} className="px-5 py-2.5 flex items-center justify-between text-sm">
                  <span className="truncate font-medium">{b.title || "Untitled"}</span>
                  <span className="text-xs text-[#5B6470]">{b.status}</span>
                </div>
              ))}
            </div>
          )}

          {role !== "student" && (
            <div className="card divide-y divide-[#EEF0EC]">
              <p className="px-5 py-2 text-xs font-medium text-[#5B6470]">
                Ready-made kits{" "}
                <span className="font-normal text-[#98A0A9]">· page opens counted from 2026-10-23</span>
              </p>
              <div className="px-5 py-3 grid sm:grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
                {kitFacts.map((f) => (
                  <p key={f.label}>
                    <span className="text-[#5B6470]">{f.label}: </span>
                    <span className="font-medium tabular">{f.value}</span>
                  </p>
                ))}
              </div>
              {kitTopics.map((k) => (
                <div key={k.topic_id} className="px-5 py-2.5 flex items-center justify-between gap-3 text-sm">
                  <span className="truncate font-medium">{topicTitle.get(k.topic_id) ?? k.topic_id}</span>
                  <span className="shrink-0 text-xs text-[#5B6470] tabular">
                    {k.unlocked_at ? `unlocked ${new Date(k.unlocked_at).toLocaleDateString()}` : "not unlocked"} · {k.downloads} downloads ·{" "}
                    {k.watches} plays · {k.adopts} copied
                  </span>
                </div>
              ))}
            </div>
          )}

          {(issuesQ.data ?? []).length > 0 && (
            <div className="card divide-y divide-[#EEF0EC]">
              <p className="px-5 py-2 text-xs font-medium text-[#5B6470]">Issue reports</p>
              {(issuesQ.data ?? []).map((i) => (
                <Link key={i.id} href={`/console/issues/${i.id}`} className="px-5 py-2.5 flex items-center justify-between text-sm hover:bg-[#FAFBF9]">
                  <span className="truncate">{i.title}</span>
                  <span className="text-xs text-[#5B6470]">{i.status.replace("_", " ")}</span>
                </Link>
              ))}
            </div>
          )}

          {(auditQ.data ?? []).length > 0 && (
            <div className="card divide-y divide-[#EEF0EC]">
              <p className="px-5 py-2 text-xs font-medium text-[#5B6470]">Staff actions on this account</p>
              {(auditQ.data ?? []).map((a, i) => (
                <div key={i} className="px-5 py-2.5 flex items-center justify-between text-sm">
                  <span>{a.action}</span>
                  <span className="tabular text-xs text-[#5B6470]">{new Date(a.created_at).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <OpsControls
          userId={id}
          suspended={opsReady && p.suspended_at != null}
          caps={{
            books: (p.max_books as number | null) ?? null,
            chapters: (p.max_chapters as number | null) ?? null,
            students: (p.max_students as number | null) ?? null,
            children: (p.max_children as number | null) ?? null,
          }}
          country={(p.country as string | null) ?? null}
          isStaffTarget={isStaffTarget}
          canGrantStaff={founderEmails().includes(staff.email) && role !== "student"}
          opsReady={opsReady}
          metricsExcluded={p.metrics_excluded === true}
          libraryRole={libraryRole}
          libraryReady={libraryReady}
          canGrantLibrary={role !== "student"}
        />
      </div>
    </main>
  );
}
