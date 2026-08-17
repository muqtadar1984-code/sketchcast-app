import Link from "next/link";
import { createAdminClient } from "@/utils/supabase/admin";
import { InkUnderline } from "@/components/ink-mark";
import { demoAccountPassword, partitionByDemo } from "@/utils/demo";
import { aggregateUserStats, languageSummary, EMPTY_USER_STATS } from "@/utils/console-user-stats";
import {
  deriveFeedbackState,
  deriveRemindState,
  type FeedbackRequestFacts,
} from "@/utils/console-actions";
import UserActions from "./user-actions";

// User roster — search across name/username/email; rows open the account's
// detail page (activity, issues, ops controls). Two tabs: real users (default)
// and demo accounts (profiles.is_demo, migration 0081) — the seeded sales
// tenants live in their own tab so the real roster stays honest, and staff can
// read a demo login + its shared password mid-pitch without digging out the
// seeder's credentials file.
//
// Per-user stats (Books/Lessons/Errors/Resolved + Language) come from THREE
// whole-table selects folded into a Map (src/utils/console-user-stats.ts) —
// never per-row queries; same pattern as the Overview page.

export const dynamic = "force-dynamic";

// One template shared by header + rows so the columns can never drift apart.
// The numeric four are deliberately narrow (text-xs, right-aligned) so the
// roster still fits the max-w-7xl container. Two variants, both FULL literals
// (Tailwind's scanner can't see interpolated class strings): the real tab
// carries a 12th Actions track; demo accounts get no actions, so the demo tab
// keeps the original 11.
const GRID_DEMO = "sm:grid-cols-[1.7fr_2fr_0.9fr_1.3fr_0.7fr_1.2fr_repeat(4,0.55fr)_1fr]";
const GRID_REAL = "sm:grid-cols-[1.6fr_1.9fr_0.8fr_1.2fr_0.6fr_1.1fr_repeat(4,0.5fr)_0.9fr_1.5fr]";

// Numeric roster cell — right-aligned on desktop; a real zero stays visible but
// muted, so "0 lessons" reads as a fact rather than missing data. The label
// only shows on mobile, where the header row is hidden and cells stack.
function Num({ label, n }: { label: string; n: number }) {
  return (
    <span className={`tabular sm:text-end text-xs ${n === 0 ? "text-[#98A0A9]" : ""}`}>
      <span className="sm:hidden text-[#98A0A9]">{label} </span>
      {n}
    </span>
  );
}

export default async function ConsoleUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; tab?: string }>;
}) {
  const { q, tab } = await searchParams;
  const demoTab = tab === "demo";
  const grid = demoTab ? GRID_DEMO : GRID_REAL;
  const admin = createAdminClient();

  const { data: profRaw } = await admin
    .from("profiles")
    .select("id, full_name, username, role, school_id, beta_tester, is_demo, ui_locale, email_optout_at, created_at")
    .order("created_at", { ascending: false })
    .limit(500);
  type Prof = { id: string; full_name: string | null; username: string | null; role: string; school_id: string | null; beta_tester: boolean | null; is_demo: boolean | null; ui_locale: string | null; email_optout_at: string | null; created_at: string };
  const { real, demo } = partitionByDemo((profRaw ?? []) as Prof[]);
  let profiles = demoTab ? demo : real;

  // Batched selects → Maps; the render loop below does ZERO queries. The three
  // action tables (0083 + 0080) are only needed on the real tab — demo
  // accounts get no actions.
  const none = Promise.resolve({ data: null });
  const [schoolsQ, booksQ, gensQ, issuesQ, fbQ, remQ, lifeQ] = await Promise.all([
    admin.from("schools").select("id, name"),
    admin.from("books").select("owner_id, language, removed_at"),
    admin.from("generations").select("owner_id, kind, status"),
    admin.from("platform_issues").select("reporter_id, status"),
    demoTab ? none : admin.from("feedback_requests").select("user_id, created_at, snoozed_until, responded_at"),
    demoTab ? none : admin.from("console_reminders").select("user_id, sent_at"),
    demoTab ? none : admin.from("lifecycle_emails").select("user_id, sent_at"),
  ]);
  const schoolName = new Map((schoolsQ.data ?? []).map((s) => [s.id as string, (s.name as string) || "School"]));
  const stats = aggregateUserStats(
    (booksQ.data ?? []) as { owner_id: string; language: string | null; removed_at: string | null }[],
    (gensQ.data ?? []) as { owner_id: string; kind: string | null; status: string }[],
    (issuesQ.data ?? []) as { reporter_id: string | null; status: string }[],
  );

  // Actions state, folded per user (same Map doctrine as the stats).
  const now = new Date();
  const fbByUser = new Map<string, FeedbackRequestFacts[]>();
  for (const r of (fbQ.data ?? []) as { user_id: string; created_at: string; snoozed_until: string | null; responded_at: string | null }[]) {
    const list = fbByUser.get(r.user_id) ?? [];
    list.push({ createdAt: r.created_at, snoozedUntil: r.snoozed_until, respondedAt: r.responded_at });
    fbByUser.set(r.user_id, list);
  }
  // Latest reminder that reached each user — manual (console_reminders) OR
  // automated (lifecycle_emails); either one starts the 3-day cooldown.
  const lastReminder = new Map<string, string>();
  for (const r of [...(remQ.data ?? []), ...(lifeQ.data ?? [])] as { user_id: string; sent_at: string }[]) {
    const prev = lastReminder.get(r.user_id);
    if (!prev || new Date(r.sent_at) > new Date(prev)) lastReminder.set(r.user_id, r.sent_at);
  }
  // Generation ATTEMPTS — any row, any status (the segments.ts rule). The
  // stats util counts done presentations only, so fold attempts separately
  // from the same generations select.
  const attempts = new Map<string, number>();
  for (const g of (gensQ.data ?? []) as { owner_id: string }[]) {
    attempts.set(g.owner_id, (attempts.get(g.owner_id) ?? 0) + 1);
  }

  // Emails live in auth.users — fetch via the admin auth API (paged).
  const emails = new Map<string, string>();
  try {
    const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    for (const u of data?.users ?? []) emails.set(u.id, u.email ?? "");
  } catch {
    // roster still renders without emails
  }

  const needle = (q ?? "").trim().toLowerCase();
  if (needle) {
    profiles = profiles.filter((p) =>
      [p.full_name, p.username, emails.get(p.id), p.role, schoolName.get(p.school_id ?? "")]
        .some((v) => (v ?? "").toLowerCase().includes(needle)),
    );
  }

  const tabs = [
    { href: "/console/users", label: `Users (${real.length})`, active: !demoTab },
    { href: "/console/users?tab=demo", label: `Demo (${demo.length})`, active: demoTab },
  ];

  return (
    <main className="max-w-7xl mx-auto px-6 py-10">
      <h1 className="text-4xl mb-2">Users</h1>
      <InkUnderline className="block h-3 w-28 mb-3" />
      <p className="text-[#5B6470] mb-5">
        {profiles.length}{demoTab ? " demo" : ""} account{profiles.length === 1 ? "" : "s"}{needle ? ` matching “${q}”` : ""}. Click a row for detail + ops.
      </p>

      <div className="flex flex-wrap gap-2 mb-5">
        {tabs.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className={`chip font-sans normal-case tracking-normal ${
              t.active ? "bg-[#14181F] text-white" : "bg-[#EEF0EC] text-[#5B6470]"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      <form method="get" className="mb-5">
        {demoTab && <input type="hidden" name="tab" value="demo" />}
        <input
          name="q"
          defaultValue={q ?? ""}
          placeholder="Search name, email, username, role, school…"
          className="field w-full sm:w-96 h-10 px-3"
        />
      </form>

      <div className="card divide-y divide-[#EEF0EC]">
        <div className={`hidden sm:grid ${grid} gap-2 px-5 py-2 text-xs text-[#5B6470] font-medium`}>
          <span>Name</span><span>Email / username</span><span>Role</span><span>School</span>
          <span>Country</span><span>Language</span>
          <span className="text-end">Books</span><span className="text-end">Lessons</span>
          <span className="text-end">Errors</span><span className="text-end">Resolved</span>
          {demoTab ? <span>Password</span> : <span className="text-end">Joined</span>}
          {!demoTab && <span>Actions</span>}
        </div>
        {profiles.map((p) => {
          const s = stats.get(p.id) ?? EMPTY_USER_STATS;
          const lang = languageSummary(p.ui_locale, s.bookLanguages);
          // The row is a grid DIV, not a Link: buttons can't nest inside an
          // anchor. The Link wraps the data cells with display:contents (they
          // stay grid items of the row, whole-row click preserved) and the
          // Actions cell sits OUTSIDE it as a sibling grid cell.
          return (
          <div key={p.id} className={`grid ${grid} gap-x-2 gap-y-1 px-5 py-2.5 text-sm items-center hover:bg-[#FAFBF9]`}>
          <Link href={`/console/users/${p.id}`} className="contents">
            <span className="font-medium truncate">
              {p.full_name || p.username || "—"}
              {/* Every signup is auto-flagged (0012), so on the demo tab the
                  chip would sit on every row and mean nothing — real tab only. */}
              {!demoTab && p.beta_tester && <span className="chip font-sans bg-[#FFF1D6] text-[#9A6400] ms-2">trial</span>}
            </span>
            <span className="truncate text-[#5B6470]">
              {/* Students log in by username, adults by email — on the demo tab
                  show the identifier staff would actually type at the portal. */}
              {demoTab ? p.username || emails.get(p.id) || "—" : emails.get(p.id) || p.username || "—"}
            </span>
            <span className={p.role === "student" ? "text-[#98A0A9]" : ""}>{p.role}</span>
            <span className="truncate text-[#5B6470]">{p.school_id ? schoolName.get(p.school_id) ?? "—" : "—"}</span>
            {/* Country: we capture no country anywhere today — profiles has no
                such column and auth.users raw_user_meta_data carries only OAuth
                identity keys (verified against prod 2026-08-17). Whether/how to
                capture it is a product decision pending with the founder; until
                then every row shows the same honest dash. */}
            <span className="text-xs text-[#98A0A9]"><span className="sm:hidden">Country </span>—</span>
            <span className={`truncate text-xs ${lang === "—" ? "text-[#98A0A9]" : "text-[#5B6470]"}`}>
              <span className="sm:hidden text-[#98A0A9]">Language </span>{lang}
            </span>
            <Num label="Books" n={s.books} />
            <Num label="Lessons" n={s.lessons} />
            <Num label="Errors" n={s.errors} />
            <Num label="Resolved" n={s.resolved} />
            {demoTab ? (
              <span className="font-mono text-xs text-[#5B6470]">{demoAccountPassword(emails.get(p.id), p.school_id) ?? "—"}</span>
            ) : (
              <span className="tabular sm:text-end text-xs text-[#5B6470]">{new Date(p.created_at).toLocaleDateString()}</span>
            )}
          </Link>
          {!demoTab && (
            <UserActions
              userId={p.id}
              feedback={deriveFeedbackState(fbByUser.get(p.id) ?? [], now, p.role)}
              remind={deriveRemindState(
                {
                  role: p.role,
                  books: s.books,
                  generationAttempts: attempts.get(p.id) ?? 0,
                  optedOutAt: p.email_optout_at,
                  lastReminderAt: lastReminder.get(p.id) ?? null,
                },
                now,
              )}
            />
          )}
          </div>
          );
        })}
        {profiles.length === 0 && <div className="px-5 py-6 text-sm text-[#5B6470]">No matches.</div>}
      </div>
    </main>
  );
}
