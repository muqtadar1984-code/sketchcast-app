import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { createClient, currentUser } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { batchSigner, type Signer } from "@/utils/storage/batch-sign";
import { isPossiblyOfficeMimetype } from "@/utils/office-file";
import UploadBook from "./upload-book";
import AutoRefresh from "@/components/auto-refresh";
import BooklessKits, { isCatalogueCopy } from "./bookless-kits";
import BookTable, { type BookRow } from "./book-table";
import { kindLabel, type LibraryMessages } from "./labels";
import { assignedDeckUnits, studentDeckLinks } from "./kit";
import { type BookHealth } from "./book-health-badge";
import BrandingCard from "./branding-card";
import ClassesCard, { type ClassRoster, type RosterStudent } from "./classes-card";
import AppHeader from "./app-header";
import StudentDashboard, {
  type StudentItemData,
  type StudentClassGroup,
} from "./student-dashboard";
import { EmptyBooks } from "./icons";
import { InkUnderline } from "@/components/ink-mark";
import FeedbackWidget from "./feedback-widget";
import ReportIssueWidget from "./report-issue-widget";
import BetaBanner from "./beta-banner";
import FairUseMeter from "./fair-use-meter";
import WithdrawnNotice from "./withdrawn-notice";
import GettingStarted from "./getting-started";
import NoticeBanner from "./notice-banner";
import NoticesCard from "./notices-card";
import { noticesFor, type NoticesData } from "@/utils/notices";
import { catalogueTabEnabled, diaryEnabled, examGenerationEnabled, gettingStartedEnabled, onboardingEnabled, platformConsoleEnabled, teacherBetaEnabled, timetableEnabledFor } from "@/utils/flags";
import AdminHelpNote from "./admin-help-note";
import { type JobStage } from "@/utils/job-stage";
import { builderJob } from "@/utils/builder-job";
import { enforceHat } from "@/utils/hats-server";
import { splitShelf } from "@/utils/school-books";
import { docDownloadName } from "@/utils/download-name";
import { canDownloadVideo, videoDownloadName } from "@/utils/video-download";
import FeedbackQuestionnaire from "./feedback-questionnaire";
import { tourForRole } from "@/tour/definitions";
import { shouldAutoStart } from "@/tour/logic";
import { maybeSendWelcomeEmail } from "@/utils/lifecycle/welcome";
import { getDictionary, type Dictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";
import { htmlLang, type Locale } from "@/i18n/locales";
import { fmt } from "@/i18n/format";
import { premiumVoicesFor } from "@/utils/narration";
import MyBooksStrip from "./my-books-strip";
import { myBooksStrip } from "@/utils/my-books/server";
import { lessonVideo, loadKitYoutubeIds, topicKitIdOf, youtubeWatchUrl } from "@/utils/catalogue/kit-youtube";
import type { User } from "@supabase/supabase-js";

type Chapter = { num: number; title: string; parts?: { titles?: string[]; words?: number }[] | null };

type Book = {
  id: string;
  title: string;
  author: string | null;
  owner_id: string;
  storage_path: string | null;
  status: string | null;
  chapters: Chapter[] | null;
  grade: string | null;
  subject: string | null;
  cover_path: string | null;
  created_at: string;
  health: BookHealth | null;
};

// Multi-part artifact ordering. NOT a path sort: ICU collation puts "." AFTER
// "_", so lesson.mp4 (Part 1) would sort BEHIND lesson_partN.mp4 — the student
// player would open on Part 2 and "complete" on the real Part 1. Extract the
// part number instead (no suffix = Part 1).
const partNum = (path: string): number => {
  const m = /_part(\d+)\.[a-z0-9]+$/i.exec(path);
  return m ? Number(m[1]) : 1;
};

// Human label for a set of 0-based chapter numbers → 1-based, contiguous runs
// collapsed: [0,1,2,4] → "Chapters 1–3, 5". Mirrors the worker's _range_label
// so a cumulative revision paper reads the same in the UI and the .docx.
function chapterRangeLabel(t: LibraryMessages, nums: number[]): string {
  const ns = [...new Set(nums.map((n) => Number(n)).filter((n) => Number.isFinite(n)))].sort((a, b) => a - b);
  if (!ns.length) return t.selectedChapters;
  const parts: string[] = [];
  let start = ns[0];
  let prev = ns[0];
  for (const n of [...ns.slice(1), null]) {
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    parts.push(start === prev ? `${start + 1}` : `${start + 1}–${prev + 1}`);
    if (n !== null) {
      start = n;
      prev = n;
    }
  }
  const list = parts.join(", ");
  return ns.length === 1 ? fmt(t.chapterOne, { list }) : fmt(t.chapterMany, { list });
}

// Readable coverage line for a cumulative exam (0062): which chapters and parts
// it tests, e.g. "1. Cells; 2. Materials (Parts 1, 3)". Mirrors what the worker
// prints on the paper so the teacher sees exactly what the last exam covered.
function examCoverageLabel(
  t: LibraryMessages,
  scope: { chapter: string; part: number }[],
  chapters: { num: number; title: string }[],
): string {
  const byChapter = new Map<number, number[]>();
  for (const s of scope) {
    const n = Number(s.chapter);
    if (!Number.isFinite(n)) continue;
    if (!byChapter.has(n)) byChapter.set(n, []);
    byChapter.get(n)!.push(Number(s.part) || 0);
  }
  const bits: string[] = [];
  for (const [n, parts] of [...byChapter.entries()].sort((a, b) => a[0] - b[0])) {
    const title = chapters.find((c) => c.num === n)?.title ?? fmt(t.chapter, { n: n + 1 });
    const realParts = [...new Set(parts.filter((p) => p > 0))].sort((a, b) => a - b);
    const list = realParts.join(", ");
    bits.push(
      realParts.length && !parts.includes(0)
        ? `${n + 1}. ${title} (${realParts.length > 1 ? fmt(t.partMany, { list }) : fmt(t.partOne, { list })})`
        : `${n + 1}. ${title}`,
    );
  }
  return bits.join("; ");
}

// ── Streaming (2026-10-30) ──────────────────────────────────────────────────
// The page used to make ~30 sequential round trips — and sign every artifact
// of every lesson one request at a time — before the first byte of the
// Library could render. Now the page itself only waits for what DECIDES the
// page (who you are, the forced-password and hat redirects, the dictionary);
// every section below starts its reads at once and streams in through its own
// <Suspense>. Sections that need the same data await the same promise, so
// nothing is read twice.
//
// SK's walkthrough treats aria-busy / [data-loading] / .animate-pulse as "still
// loading". Every fallback below carries aria-busy="true" + data-sk-loading,
// and every data-tour anchor lives in the STREAMED content, never in a
// fallback — so the tour waits for the real element rather than pointing at a
// skeleton.

type Db = Awaited<ReturnType<typeof createClient>>;

/** A started read that one or more sections await. Marked handled so a branch
 * that never renders it cannot leave an unhandled rejection behind; every
 * section that awaits it still sees the real error. */
function started<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {});
  return p;
}

/** The fallback every streaming section shows. Light on purpose: no data, no
 * anchors — just "busy" for the walkthrough and, where a section has real
 * height, a pulse block so the page does not jump when it lands. */
function Pending({ className = "", blocks = 0, height = "h-16" }: { className?: string; blocks?: number; height?: string }) {
  return (
    <div aria-busy="true" data-loading="" data-sk-loading="" className={className}>
      {Array.from({ length: blocks }, (_, i) => (
        <div key={i} className={`animate-pulse ${height} rounded-xl bg-[#F0F2EE] mb-4`} />
      ))}
    </div>
  );
}

type Trial = {
  isBeta: boolean;
  trialPin: { bookId: string; chapterRef: string | null; part: number | null } | null;
  trialBookUsed: number;
};
type ClassOption = { id: string; name: string; grade: string | null };
type ChildTarget = { id: string; name: string };
type FairUse = { trialTier: boolean; premiumVoices: boolean };
type GettingStartedSteps = { upload: boolean; generate: boolean; assign: boolean };

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ book_pdf?: string }> }) {
  // The verified user is shared with the layout and header (currentUser is
  // React-cached per request) — one Auth round trip for the whole render.
  const [supabase, user] = await Promise.all([createClient(), currentUser()]);
  if (!user) redirect("/login");

  // Everything the gates below need, in ONE wave. They stay separate queries
  // on purpose:
  //  • must_reset_password — forced password change (set by /api/reset-password
  //    hand-outs and on invited-student provisioning): everyone funnels through
  //    this page after sign-in, so this is the single enforcement point.
  //    Separate best-effort query so a not-yet-applied 0005 migration can't
  //    break the dashboard.
  //  • lesson_tools (0052) — PE/Music/Art-style teachers don't teach from books:
  //    SketchCast staff flag them and the upload/generation surfaces disappear
  //    (the DB triggers are the real guard). Best-effort: a not-yet-applied 0052
  //    must not break the dashboard, so a failed read means tools stay on.
  const [{ data: profile }, { data: mrp }, { data: lt }, locale, params] = await Promise.all([
    supabase.from("profiles").select("full_name, role, school_id").eq("id", user.id).single(),
    supabase.from("profiles").select("must_reset_password").eq("id", user.id).maybeSingle(),
    supabase.from("profiles").select("lesson_tools").eq("id", user.id).maybeSingle(),
    resolveLocale(),
    searchParams,
  ]);
  const schoolId = (profile?.school_id as string | null) ?? null;
  const role = (profile?.role as string | null) ?? null;

  let lessonTools = true;
  if (lt && (lt as { lesson_tools?: boolean | null }).lesson_tools === false) lessonTools = false;
  if ((mrp as { must_reset_password?: boolean } | null)?.must_reset_password) {
    redirect("/auth/update-password");
  }

  // One-hat mode: the Library is the TEACHER hat's home — an adult wearing a
  // different hat is sent to that hat's world instead (presentation only;
  // students are unaffected and every page keeps its own auth gates).
  const hatAway = await enforceHat(supabase, role, schoolId, "teacher");
  if (hatAway) redirect(hatAway);

  // The Library's words, resolved ONCE here and threaded down the whole client
  // tree as one object: every cell, card and modal below is a client component,
  // so they take the strings as a prop rather than importing the (server-only)
  // dictionary. resolveLocale is React-cached, so asking here costs nothing
  // beyond what the header already paid. Resolved BEFORE the student branch:
  // a student's row label ("Lesson", "Deck · Part 2") and chapter headings
  // are built from the same `library` words the adult surfaces use, so the
  // dashboard itself reads in the family's language, not just its rows.
  const dict = await getDictionary(locale);
  const t: LibraryMessages = { ...dict.library, common: dict.common, utils: dict.utils };
  const pdfUnavailable = params.book_pdf === "unavailable";

  // School notices (0068): the pinned banner + the "Next 10" card, the same
  // pair on every dashboard. ONE call resolves the flag (parents included, who
  // belong through their children) and both lists; null = notices are off for
  // this viewer, so nothing renders. Started before the student branch below —
  // students get the same board.
  const noticesP = started(noticesFor(supabase, { userId: user.id, role, schoolId }));
  // Can this reader reach the Diary, where the notices list now lives? Same
  // condition the header uses for the tab. FEATURE_DIARY is independent of
  // FEATURE_NOTICES, so this really can be false while notices are live.
  const diaryReachable = diaryEnabled() && !!role;

  // SK S7 K3 — "My books": SketchCast books this reader bought or was given
  // (and, for a parent, their verified children's). Decided and signed
  // server-side (src/utils/my-books); empty → the strip is not rendered. Not
  // gated by SK flags: a bought book shows even while SK is restricted. Started
  // before the student branch — a student who activated a code sees it too.
  const myBooksP = started(myBooksStrip(user, role));

  // ── Student view ──────────────────────────────────────────────────────────
  // Students see only the content assigned to them (RLS → shared_to_me); the
  // reads and the signing live in <StudentHome> below, which streams in under
  // the header.
  if (role === "student") {
    return (
      <div className="min-h-screen bg-[#FCFCFA] text-[#14181F]">
        <AppHeader />
        <Suspense fallback={<Pending className="max-w-7xl mx-auto px-6 pt-6" blocks={3} />}>
          <StudentHome
            supabase={supabase}
            userId={user.id}
            schoolId={schoolId}
            t={t}
            dict={dict}
            noticesP={noticesP}
            myBooksP={myBooksP}
            pdfUnavailable={pdfUnavailable}
          />
        </Suspense>
        {platformConsoleEnabled() && <ReportIssueWidget variant="student" />}
      </div>
    );
  }

  // ── Teacher / parent library ──────────────────────────────────────────────
  // (`locale`, `dict` and `t` — the Library's words — were resolved above the
  // student branch, which shares them.)
  //
  // Every read below STARTS here and is awaited by the section that shows it.

  // Teacher trial locks: best-effort queries so a not-yet-applied migration can
  // never break the dashboard. The trial state mirrors the DB scope EXACTLY via
  // my_trial_pin (0057): trial tier, no school, not a parent, no console
  // override. beta_tester alone no longer decides — the flag is never cleared
  // on upgrade, so a paying teacher must unlock the moment their entitlement
  // lands (review finding). Before 0057 runs, the RPC is absent → no locks,
  // matching the unpinned DB.
  const trialP: Promise<Trial> = started(
    (async () => {
      let isBeta = false;
      let trialPin: Trial["trialPin"] = null;
      let trialBookUsed = 0;
      if (role && teacherBetaEnabled()) {
        const { data: tp } = await supabase.rpc("my_trial_pin");
        const pin = (Array.isArray(tp) ? tp[0] : tp) as
          | {
              in_scope: boolean;
              pinned: boolean;
              book_id: string | null;
              chapter_ref: string | null;
              part: number | null;
              repinnable: boolean;
            }
          | null;
        isBeta = !!pin?.in_scope;
        // repinnable = the DB's failed-first-attempt escape is open (the pinned
        // unit never succeeded and every remaining generation errored) — render
        // as unpinned so the teacher can restart anywhere, exactly as the DB
        // would accept. The pin moves on their next accepted generation.
        if (isBeta && pin?.pinned && pin.book_id && !pin.repinnable) {
          trialPin = {
            bookId: pin.book_id,
            chapterRef: pin.chapter_ref,
            part: pin.part && pin.part >= 1 ? pin.part : null,
          };
        }
        if (isBeta) {
          const { data: used } = await supabase.rpc("my_trial_book_used");
          trialBookUsed = typeof used === "number" ? used : 0;
        }
      }
      return { isBeta, trialPin, trialBookUsed };
    })(),
  );

  if (role) {
    // Every signup path (email, Google, invite, school setup) funnels through
    // this page, so the founder's new-registration email fires here, exactly
    // once per account (signup_notified_at is the dedup marker). Started now,
    // finished by after() — the email no longer holds the render.
    after(
      (async () => {
        const { data: b } = await supabase
          .from("profiles")
          .select("signup_notified_at, onboarded_at")
          .eq("id", user.id)
          .maybeSingle();
        const flags = b as { signup_notified_at?: string | null; onboarded_at?: string | null } | null;
        // Don't notify while the user is still in onboarding limbo. This page renders
        // CONCURRENTLY with the layout's onboarding redirect, so firing here for a
        // brand-new adult would capture the pre-onboarding DEFAULT role ('teacher')
        // for someone who is about to choose Parent. Wait until they're settled —
        // onboarded, or the onboarding gate is off — so the email reports the real
        // role. The notification then fires on their first post-onboarding load.
        const settled = !onboardingEnabled() || !!flags?.onboarded_at;
        if (flags && !flags.signup_notified_at && settled) {
          const { notifySignupOnce } = await import("@/utils/notify");
          await notifySignupOnce(user.id, user.email ?? null, (profile?.full_name as string) ?? null, role);
        }
      })(),
    );
  }

  // Parents are now full authors (migration 0035 dropped the test-papers-only
  // trigger): they fall through to the Library like any other adult, with
  // My Children + Test Papers as extra tabs (see app-header tabsFor). No redirect.

  // Parent-role accounts (home educators): the Assign modal targets their
  // LINKED CHILDREN, not classes — a family has named learners, not a class
  // register (founder, 2026-08-18). RLS scopes parent_links to the viewer's
  // own rows; null (teachers/admins) keeps the class mode untouched.
  type ChildLinkJoin = { child_id: string; profiles: { full_name: string | null; username: string | null } | null };
  const childTargetsP: Promise<ChildTarget[] | null> = started(
    role === "parent"
      ? (async () =>
          (
            ((await supabase.from("parent_links").select("child_id, profiles:child_id(full_name, username)")).data ??
              []) as unknown as ChildLinkJoin[]
          ).map((l) => ({
            id: l.child_id,
            name: l.profiles?.full_name || l.profiles?.username || dict.school.fallback.child,
          })))()
      : Promise.resolve(null),
  );

  // Junk-upload gate: trial accounts get the dialog's stronger "your only
  // trial kit" line. Detected by plan_tier — my_fair_use() reports it (0047,
  // SECURITY DEFINER, auth.uid()-scoped) — and deliberately NOT by
  // beta_tester, which is never cleared on upgrade (known trap). Best-effort:
  // a pre-0047 DB just means no extra line.
  const fairUseP: Promise<FairUse> = started(
    (async () => {
      const { data: fu } = await supabase.rpc("my_fair_use");
      const f = fu as { tier?: string; unlimited?: boolean; premium_voices?: boolean } | null;
      // Premium voices in the picker follow the DATABASE's one answer — 0105's
      // premium_voices_allowed(): a paid tier, or a comp override at or above the
      // threshold that function carries. my_fair_use() reports it as
      // `premium_voices`; the worker's gate asks the same function, so the picker
      // and the render agree. Free and trial accounts see free voices; `auto`
      // still gives everyone the right language.
      const premiumVoices = premiumVoicesFor(f);
      return { trialTier: f?.tier === "trial", premiumVoices };
    })(),
  );

  // Teacher surfaces show what the person OWNS. Admins/coordinators can read
  // school-wide rows under RLS, so filter by ownership explicitly — their
  // Library is their teacher hat, not the school view (that's /dashboard/school).
  // Simple list for the assignment dropdown — always works (no 0005 columns).
  const classesP: Promise<ClassOption[]> = started(
    (async () => {
      const { data: classesRaw } = await supabase
        .from("classes")
        .select("id, name, grade")
        .eq("teacher_id", user.id)
        .order("created_at", { ascending: false });
      return (classesRaw ?? []) as ClassOption[];
    })(),
  );

  // Roster for the Classes card. Reads migration 0005's profile columns + policy;
  // if that migration isn't applied yet the query errors and we degrade to [] so
  // the rest of the dashboard keeps working.
  const rostersP: Promise<ClassRoster[]> = started(
    (async () => {
      const { data: rostersRaw } = await supabase
        .from("classes")
        .select("id, name, grade, join_code, enrollments(profiles(id, full_name, username, parent_email))")
        .eq("teacher_id", user.id)
        .order("created_at", { ascending: false });
      type RosterRaw = {
        id: string;
        name: string;
        grade: string | null;
        join_code: string;
        enrollments: { profiles: RosterStudent | null }[];
      };
      return ((rostersRaw ?? []) as unknown as RosterRaw[]).map((c) => ({
        id: c.id,
        name: c.name,
        grade: c.grade,
        join_code: c.join_code,
        students: (c.enrollments ?? []).map((e) => e.profiles).filter((p): p is RosterStudent => !!p),
      }));
    })(),
  );

  // Letterhead branding is a teacher/school affordance. Parent accounts (home
  // educators included) don't get the card (founder, 2026-08-18) — so skip the
  // reads too. Gated on ROLE, not hat: a teacher-who-is-a-parent keeps theirs.
  const brandingP = started(
    (async () => {
      const { data: brandingRow } =
        role === "parent"
          ? { data: null }
          : await supabase.from("branding").select("docx_path, pptx_path").eq("owner_id", user.id).maybeSingle();

      // A stored path is not proof of a usable template. Before upload-time
      // validation existed a teacher uploaded JPEGs as their .docx/.pptx letterheads
      // and the card still read "templates set", so they had no way to tell why
      // their documents came out unbranded. Check what is actually in storage and
      // treat an impossible mimetype as "not set".
      const brandingFiles = brandingRow
        ? (await supabase.storage.from("uploads").list(`${user.id}/branding`)).data ?? []
        : [];
      const brandingUsable = (path: string | null | undefined) => {
        if (!path) return false;
        const name = path.split("/").pop();
        const obj = brandingFiles.find((f) => f.name === name);
        // Missing metadata is not evidence of a bad file — only a positively
        // impossible type hides the template.
        return isPossiblyOfficeMimetype(obj?.metadata?.mimetype as string | undefined);
      };
      return {
        hasDocx: brandingUsable(brandingRow?.docx_path as string | null | undefined),
        hasPptx: brandingUsable(brandingRow?.pptx_path as string | null | undefined),
      };
    })(),
  );

  // ONE signer for everything this render signs as the USER (covers, and the
  // artifacts of every generation that is not a catalogue copy): calls made in
  // the same tick go out as one createSignedUrls request per download name,
  // under the same session — so storage RLS decides exactly as before.
  const userSign = batchSigner(supabase, "artifacts", 3600);
  const booksP = started(loadBooks(supabase, user.id, schoolId, classesP, userSign));
  const lessonsP = started(loadLessons(supabase, user, t, userSign));

  // Getting-started stepper (inline onboarding, 0064) — new joiners only. Show
  // ONLY when the flag is on, this account has book tools, and the dismissal
  // column reads back a genuine NULL (a pre-migration error → column undefined →
  // hidden, never a broken card; existing users were backfilled as dismissed).
  const gettingStartedP: Promise<GettingStartedSteps | null> = started(
    gettingStartedEnabled() && lessonTools && role !== "student"
      ? (async () => {
          const { data: gs, error: gsErr } = await supabase
            .from("profiles")
            .select("getting_started_dismissed_at")
            .eq("id", user.id)
            .maybeSingle();
          const dismissedAt = (gs as { getting_started_dismissed_at?: string | null } | null)?.getting_started_dismissed_at;
          if (gsErr || !gs || dismissedAt != null) return null;
          // Step 3 = "has assigned anything". One cheap head count of the shares the
          // user can see (RLS scopes to their own); best-effort → not-done on error.
          const [{ count }, books, lessons] = await Promise.all([
            supabase.from("generation_shares").select("id", { count: "exact", head: true }),
            booksP,
            lessonsP,
          ]);
          return {
            upload: books.bookList.length > 0,
            generate: lessons.length > 0,
            assign: (count ?? 0) > 0,
          };
        })()
      : Promise.resolve(null),
  );

  // Beta feedback: whether feedback was already submitted (the widget is
  // entirely voluntary — it opens only from its button).
  const feedbackP: Promise<{ submitted: boolean } | null> = started(
    trialP.then(async ({ isBeta }) => {
      if (!isBeta) return null;
      const { data: fb } = await supabase.from("beta_feedback").select("id").maybeSingle();
      return { submitted: !!fb };
    }),
  );

  // Feedback questionnaire (0083): the founder asks a specific account for
  // feedback from the console, and the OLDEST still-open request (never
  // answered, snooze expired or never snoozed) renders the modal over this
  // page. Adults only — requests target teachers/parents, and students never
  // reach this branch anyway (they returned above), but the role guard makes
  // that a rule rather than an accident of control flow.
  //
  // The tables are service-role-only (no authenticated RLS policies, by
  // design — all writes go through /api/feedback), so the read uses the admin
  // client. Best-effort like every other optional surface on this page: a
  // missing SUPABASE_SERVICE_ROLE_KEY or a not-yet-applied 0083 means no
  // modal, never a broken dashboard.
  //
  // Coexistence with the other blocking surfaces: onboarding role
  // confirmation, forced password reset and the hat redirect all `redirect()`
  // BEFORE this point, so this page render proves none of them fired. The one
  // overlay that could still fight it is the role tour auto-starting for a
  // user who has never seen it — same check the client provider makes
  // (shouldAutoStart), evaluated here server-side; the ask waits for the next
  // visit rather than stacking on the coach-marks.
  const feedbackAskP: Promise<{ requestId: string } | null> = started(
    (async () => {
      if (!(role && role !== "student")) return null;
      let tourWillAutoStart = false;
      if (process.env.NEXT_PUBLIC_FEATURE_TOUR === "true") {
        const def = tourForRole(role);
        if (def) {
          // Best-effort (0037): a missing table errors → prog null → the tour
          // WOULD auto-start, so the ask correctly stays back.
          const { data: prog } = await supabase
            .from("user_tour_progress")
            .select("version, status")
            .eq("tour_key", def.key)
            .maybeSingle();
          const seen = prog
            ? { version: prog.version as number, status: prog.status as "completed" | "skipped" }
            : null;
          tourWillAutoStart = shouldAutoStart(seen, def.version);
        }
      }
      if (tourWillAutoStart) return null;
      try {
        const admin = createAdminClient();
        const { data: req } = await admin
          .from("feedback_requests")
          .select("id")
          .eq("user_id", user.id)
          .is("responded_at", null)
          .or(`snoozed_until.is.null,snoozed_until.lt.${new Date().toISOString()}`)
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        return req?.id ? { requestId: req.id as string } : null;
      } catch {
        // No service key in this environment — the ask simply doesn't render.
        return null;
      }
    })(),
  );

  if (role) {
    // One-time welcome email for new accounts (claim-first, never throws,
    // never blocks the render on failure — see utils/lifecycle/welcome.ts).
    // Started now and finished by after(): it no longer holds the render.
    try {
      after(maybeSendWelcomeEmail(createAdminClient(), user.id, user.email));
    } catch {
      // best-effort only
    }
  }

  return (
    <div className="min-h-screen bg-[#FCFCFA] text-[#14181F]">
      <AppHeader />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
        <h1 className="text-3xl sm:text-4xl mb-2">{t.title}</h1>
        <InkUnderline className="block h-3 w-28 mb-3" />
        <p className="text-[#5B6470] mb-7">{t.subtitle}</p>

        <Suspense fallback={<Pending />}>
          <NoticesSection noticesP={noticesP} diaryReachable={diaryReachable} />
        </Suspense>

        <Suspense fallback={<Pending />}>
          <GettingStartedSection
            gettingStartedP={gettingStartedP}
            userId={user.id}
            variant={role === "parent" ? "parent" : "teacher"}
          />
        </Suspense>

        <Suspense fallback={<Pending />}>
          <BetaSection trialP={trialP} />
        </Suspense>

        {/* Fair-use transparency: what this month's plan includes, what's used,
            what carried over (0047). The DB triggers are the guard. */}
        <Suspense fallback={<Pending />}>
          <WithdrawnNotice />
        </Suspense>

        {lessonTools && (
          <Suspense fallback={<Pending blocks={1} height="h-12" />}>
            <FairUseMeter />
          </Suspense>
        )}

        {/* The trial's book slot comes from the 0046 ledger (my_trial_book_used):
            a deleted generated-from book keeps its slot consumed, so live book
            rows must not decide whether to offer a doomed multi-minute upload. */}
        {lessonTools ? (
          <Suspense fallback={<Pending blocks={1} height="h-24" />}>
            <UploadSection trialP={trialP} booksP={booksP} schoolId={schoolId} t={t} userId={user.id} />
          </Suspense>
        ) : (
          <p className="text-sm text-[#5B6470] mb-6">{t.noBookTools}</p>
        )}

        <Suspense fallback={<Pending blocks={1} height="h-28" />}>
          <ClassesSection rostersP={rostersP} trialP={trialP} brandingP={brandingP} role={role} t={t} />
        </Suspense>

        <Suspense fallback={<Pending />}>
          <MyBooksSection myBooksP={myBooksP} t={t} unavailable={pdfUnavailable} />
        </Suspense>

        <Suspense fallback={<Pending blocks={3} height="h-20" />}>
          <LibrarySection
            booksP={booksP}
            lessonsP={lessonsP}
            classesP={classesP}
            childTargetsP={childTargetsP}
            trialP={trialP}
            fairUseP={fairUseP}
            gettingStartedP={gettingStartedP}
            t={t}
            locale={locale}
            schoolId={schoolId}
            userId={user.id}
            role={role}
          />
        </Suspense>
        {/* Contact SketchCast staff for admin help beyond self-serve (password
            resets + adding students). Teachers/coordinators here; parents run
            their own family world, so it's hidden for them. */}
        {role !== "parent" && (
          <div className="mt-10">
            <AdminHelpNote />
          </div>
        )}
      </main>

      <Suspense fallback={<Pending />}>
        <FeedbackWidgetSection feedbackP={feedbackP} />
      </Suspense>
      {platformConsoleEnabled() && <ReportIssueWidget />}
      <Suspense fallback={<Pending />}>
        <FeedbackAskSection feedbackAskP={feedbackAskP} t={dict.feedbackAsk} />
      </Suspense>
    </div>
  );
}

// ── Student home (streams under the header + hero) ──────────────────────────

async function StudentHome({
  supabase,
  userId,
  schoolId,
  t,
  dict,
  noticesP,
  myBooksP,
  pdfUnavailable,
}: {
  supabase: Db;
  userId: string;
  schoolId: string | null;
  t: LibraryMessages;
  dict: Dictionary;
  noticesP: Promise<NoticesData | null>;
  myBooksP: ReturnType<typeof myBooksStrip>;
  pdfUnavailable: boolean;
}) {
  // Every read the student view needs, in ONE wave (they used to run one after
  // another). Current progress + submissions are tables from migration 0006;
  // if not applied yet these error → empty maps → everything shows "not
  // started". Real chapter titles for headings ("Unit 1: Be a designer" beats
  // "Chapter 1") — RLS: students in a school can read its books; failure →
  // graceful fallback. School-linked students get their class timetable; the
  // header tab is hidden on phones, so surface an in-page link too.
  const [
    { data: gensRaw },
    { data: sharesRaw },
    { data: progRaw },
    { data: subsRaw },
    { data: sBooks },
    studentTimetableOn,
    notices,
    myBooks,
  ] = await Promise.all([
    supabase
      .from("generations")
      .select("id, kind, chapter_ref, book_id, params, artifacts(kind, storage_path)")
      .order("created_at", { ascending: false }),
    supabase.from("generation_shares").select("generation_id, due_at, class_id, classes(name)"),
    supabase.from("student_progress").select("generation_id, status, revision_count, progress_pct"),
    supabase.from("submissions").select("generation_id"),
    supabase.from("books").select("id, chapters"),
    schoolId ? timetableEnabledFor(supabase, schoolId) : Promise.resolve(false),
    noticesP,
    myBooksP,
  ]);

  type ShareRow = { generation_id: string; due_at: string | null; class_id: string | null; classes: { name: string } | null };
  type ShareInfo = { due: string | null; className: string; classId: string | null };
  const shareByGen = new Map<string, ShareInfo>();
  // (to-one embeds come back as objects at runtime; supabase-js types them as arrays)
  for (const s of (sharesRaw ?? []) as unknown as ShareRow[]) {
    const gid = s.generation_id;
    // class_id null = a direct share (parent portal) — group it under a
    // family heading instead of a class name.
    const className = s.classes?.name || (s.class_id ? "My class" : "From your parent");
    const due = s.due_at ?? null;
    const prev = shareByGen.get(gid);
    if (!prev) shareByGen.set(gid, { due, className, classId: s.class_id });
    else if (due && (!prev.due || new Date(due) < new Date(prev.due)))
      shareByGen.set(gid, { due, className: prev.className, classId: prev.classId });
  }

  const progByGen = new Map<string, { status: string; revisionCount: number; progressPct: number }>();
  for (const p of (progRaw ?? []) as { generation_id: string; status: string; revision_count: number; progress_pct: number }[])
    progByGen.set(p.generation_id, {
      status: p.status,
      revisionCount: p.revision_count ?? 0,
      progressPct: p.progress_pct ?? 0,
    });
  const submittedSet = new Set((subsRaw ?? []).map((s: { generation_id: string }) => s.generation_id));

  // We sign the student's artifacts with the service role since the storage
  // policy only lets the owning teacher sign directly.
  let downloadsReady = true;
  let admin: ReturnType<typeof createAdminClient> | null = null;
  try {
    admin = createAdminClient();
  } catch {
    downloadsReady = false;
  }
  // ONE batched signer for the whole view (utils/storage/batch-sign): every
  // row asks for its URLs before its first await, so the view signs in one
  // round trip instead of a request per file, row after row. Same client —
  // the service role, only for the paths these assigned rows carry.
  const adminSign = admin ? batchSigner(admin, "artifacts", 3600) : null;
  // `download` bakes a Content-Disposition filename into the signed URL —
  // documents pass one (docDownloadName decides); video URLs and a lesson's
  // embedded decks must stay untouched. A deck-kind row's own .pptx is not
  // signed here at all any more: /api/deck/{id} signs it on the click, and
  // names it there.
  const sign = async (path: string | null, download?: string): Promise<string | null> => {
    if (!path || !adminSign) return null;
    return adminSign(path, download);
  };

  type GenRow = {
    id: string;
    kind: string;
    chapter_ref: string | null;
    book_id: string | null;
    params: { part?: unknown } | null;
    artifacts: { kind: string; storage_path: string }[];
  };
  type Item = StudentItemData & { className: string; chapterRef: string | null; bookId: string | null };
  const chapterTitle = new Map<string, string>();
  for (const b of (sBooks ?? []) as { id: string; chapters: { num: number; title: string }[] | null }[]) {
    for (const c of b.chapters ?? []) {
      if (c.title && !/^\d+$/.test(c.title.trim())) chapterTitle.set(`${b.id}|${c.num}`, c.title);
    }
  }
  // (server component, rendered once per request — Date.now is fine here)
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const gens = (gensRaw ?? []) as GenRow[];
  // The units whose deck arrives as its own assigned row (kind 'deck'): a
  // lesson from before 0103 still carries that unit's deck EMBEDDED, and
  // offering it twice put the recording link (the deck row's) next to one
  // that records nothing (the lesson row's). Same rule as the Library's.
  const deckUnits = assignedDeckUnits(gens, (id) => shareByGen.has(id));
  // Rows are built concurrently (in their original order), so their URLs
  // land in the same signing batch.
  const pending: Promise<Item>[] = [];
  for (const g of gens) {
    const info = shareByGen.get(g.id);
    if (!info || g.kind === "lesson_plan") continue; // only assigned, never the teacher plan
    pending.push(
      (async (): Promise<Item> => {
        const arts = g.artifacts ?? [];
        const path = (k: string) => arts.find((a) => a.kind === k)?.storage_path ?? null;
        const prog = progByGen.get(g.id);
        // Multi-part lessons: every video/deck part, in PART order (Part 1 first).
        // A deck-kind generation (0103, assignable since 2026-09-04) comes
        // through the same lines: its one deck_pptx lands in `deck`/`decks`, it
        // has no video, no docx and no questions_json, so `doc` and `quiz` stay
        // null and StudentItem renders it as a download alone.
        // NULL SLOTS ARE KEPT for videos: parts.length must always equal the true
        // part count — silently dropping a transiently-unsignable URL would shift
        // part numbering and corrupt the per-part progress math (a student could
        // even "complete" a lesson with a middle part missing).
        const videoPaths = arts
          .filter((a) => a.kind === "video_mp4")
          .map((a) => a.storage_path)
          .sort((a, b) => partNum(a) - partNum(b));
        const videosP = Promise.all(videoPaths.map((p) => sign(p)));
        // Answer keys stay with the adult (founder, 2026-08-18). Whether a
        // generation's 'docx' is safe to hand a student is decided by ONE
        // proof: the presence of an 'answer_key_docx' SIBLING artifact. The
        // worker now splits every document kind (exam_paper / worksheet /
        // activity / case_study) into a student-clean 'docx' plus that
        // separate key/teacher-notes sibling — so a sibling means the split
        // ran and the 'docx' carries no answers. LEGACY generations kept
        // their combined document under 'docx' with NO sibling, so they get
        // no student link, ever. The one kind that needs no proof is the
        // cumulative exam (0062, kind 'exam'): its docx has been the
        // key-LESS paper since birth. The answer_key_docx itself is NEVER
        // signed for a student under any code path. Storage RLS backs this
        // up: artifact files live under the ADULT's folder, so a student
        // session cannot sign these paths itself — this line is the only
        // door.
        const docP =
          g.kind === "exam" || arts.some((a) => a.kind === "answer_key_docx")
            ? sign(path("docx"), docDownloadName(g.kind, "docx"))
            : Promise.resolve(null);
        // A presentation whose unit has an assigned deck row keeps NO embedded
        // deck link (studentDeckLinks) — and nothing is signed for it.
        const deckPaths = studentDeckLinks(
          g,
          deckUnits,
          arts
            .filter((a) => a.kind === "deck_pptx")
            .map((a) => a.storage_path)
            .sort((a, b) => partNum(a) - partNum(b)),
        );
        // A deck-kind row's .pptx is NEVER signed for the client. The row gets
        // the ROUTE /api/deck/{id} instead, which re-checks the share and signs
        // at CLICK time (with the "Deck.pptx" disposition that keeps the click a
        // download). A signed URL rendered into the page is an hour-long link
        // the row then has to reason about, and it cannot: a client-router
        // restore hands the row that cached URL with a fresh mount clock, so an
        // hour-old link looked new, recorded the item complete, and failed at
        // storage. Same move `quiz` below already made.
        //
        // `downloadsReady` GATES IT. The route mints its URL with a service-role
        // client of its own, built from the same env this page just failed to
        // build one from — so when this page has no service role, that route
        // answers 500 for every click. Rendering the link anyway offered a
        // live-looking download that saved a JSON error body while the row
        // recorded "Completed"; without it the row falls back to the
        // deckWontLoad span (and the page's own downloadsNotReady banner says
        // why), and records nothing. Every OTHER download on this page is
        // already absent in that state, because `sign` returns null.
        //
        // A presentation's EMBEDDED decks (pre-0103 kits, and the per-part
        // decks a lesson still carries) keep the bare signed URL they always
        // had: they record nothing when clicked, so a stale one costs a
        // refresh and no false completion.
        const decks =
          g.kind === "deck"
            ? deckPaths.length && downloadsReady
              ? [`/api/deck/${g.id}`]
              : []
            : (await Promise.all(deckPaths.map((p) => sign(p)))).filter((u): u is string => !!u);
        const [videos, doc] = await Promise.all([videosP, docP]);
        // Per-part lesson units: label carries the part so three assigned
        // "Lesson"s of one chapter read as Part 1/2/3, not three clones. Both
        // halves come from the dictionary (the kind via kindLabel — the message
        // keys ARE the kind strings, `deck` included), so the row reads in the
        // student's language on the dashboard itself, not only on the adult
        // surfaces that report on it.
        const genPart = g.params?.part;
        const partLabel = typeof genPart === "number" && genPart >= 1 ? ` · ${fmt(t.part, { n: genPart })}` : "";
        return {
          genId: g.id,
          kind: g.kind,
          label: `${kindLabel(t, g.kind)}${partLabel}`,
          dueAt: info.due,
          dueOverdue: !!info.due && new Date(info.due).getTime() < now,
          classId: info.classId,
          className: info.className,
          chapterRef: g.chapter_ref ?? null,
          bookId: g.book_id ?? null,
          video: videos[0] ?? null,
          videos,
          deck: decks[0] ?? null,
          decks,
          doc,
          // NOT a signed URL. questions.json IS the marking scheme — the
          // fill_blank/true_false answers, the match pairs, the subjective
          // answer_outline — and this line used to hand the person being tested
          // a service-role signed link to it. A verifier pulled three of those
          // links from production with no credentials and read the keys back.
          // The student now gets a route that serves an answer-STRIPPED paper
          // (src/app/api/quiz/[generationId]) and nothing else; the raw artifact
          // stays service-role only, exactly like answer_key_docx above.
          quiz: path("questions_json") ? `/api/quiz/${g.id}` : null,
          status: (prog?.status as StudentItemData["status"]) ?? null,
          revisionCount: prog?.revisionCount ?? 0,
          progressPct: prog?.progressPct ?? 0,
          submitted: submittedSet.has(g.id),
        };
      })(),
    );
  }
  const items: Item[] = await Promise.all(pending);

  // Group by class → chapter.
  const byClass = new Map<string, Map<string, Item[]>>();
  for (const it of items) {
    const chKey = it.chapterRef ?? "—";
    if (!byClass.has(it.className)) byClass.set(it.className, new Map());
    const chMap = byClass.get(it.className)!;
    if (!chMap.has(chKey)) chMap.set(chKey, []);
    chMap.get(chKey)!.push(it);
  }
  const groups: StudentClassGroup[] = [...byClass.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([className, chMap]) => ({
      className,
      chapters: [...chMap.entries()]
        .sort((a, b) => (Number(a[0]) || 0) - (Number(b[0]) || 0))
        .map(([chKey, its]) => ({
          key: chKey,
          // Prefer the chapter's real title ("Unit 1: Be a designer"); the
          // fallbacks are dictionary words, like the row labels.
          heading:
            chKey === "—"
              ? dict.student.noChapter
              : chapterTitle.get(`${its[0]?.bookId}|${Number(chKey)}`) ||
                fmt(t.chapter, { n: Number(chKey) + 1 }),
          items: its,
        })),
    }));

  return (
    <>
      {studentTimetableOn && (
        <div className="max-w-7xl mx-auto px-6 pt-4 sm:hidden">
          <Link href="/dashboard/my-timetable" className="chip bg-[#E2F4F1] text-[#0C8175]">
            📅 My timetable
          </Link>
        </div>
      )}
      {myBooks.length > 0 && (
        <div className="max-w-7xl mx-auto px-6 pt-6">
          <MyBooksStrip tiles={myBooks} t={t.myBooks} unavailable={pdfUnavailable} />
        </div>
      )}
      <div data-tour="assignments">
        <StudentDashboard
          groups={groups}
          studentId={userId}
          downloadsReady={downloadsReady}
          notices={notices}
        />
      </div>
    </>
  );
}

// ── Library loaders ─────────────────────────────────────────────────────────

/** The teacher's books, then the school shelf merged in, with languages and
 * signed cover URLs. Two waves: (own books ‖ shelf ‖ timetable ‖ classes),
 * then (shelf owners ‖ languages ‖ covers, one signing batch). */
async function loadBooks(
  supabase: Db,
  userId: string,
  schoolId: string | null,
  classesP: Promise<ClassOption[]>,
  userSign: Signer,
) {
  // `health` (migration 0021) is optional — degrade to the health-less select
  // so the library never breaks on a not-yet-applied migration.
  const bookCols = "id, title, author, owner_id, storage_path, status, chapters, grade, subject, cover_path, created_at";
  const ownP = (async () => {
    const withHealth = await supabase
      .from("books")
      .select(`${bookCols}, health`)
      .eq("owner_id", userId)
      .order("created_at", { ascending: false });
    return withHealth.error
      ? await supabase.from("books").select(bookCols).eq("owner_id", userId).order("created_at", { ascending: false })
      : withHealth;
  })();

  // ── The school shelf (0070) ─────────────────────────────────────────────────
  // A school uploads its textbooks once and everyone works from them. The read
  // needed no migration — books_read has always allowed
  // (school_id = current_school_id()); the Library simply never asked.
  //
  // Merged into bookList rather than rendered apart, so a school book behaves
  // exactly like the teacher's own everywhere downstream: covers, languages,
  // grouping, generation, assignment. What a teacher does NOT teach goes to
  // `shelfRest` and waits behind a disclosure — nothing is hidden, it is only
  // ordered. Best-effort throughout: this is an addition to a working Library
  // and must never be the reason it fails to render.
  const shelfP = schoolId
    ? supabase
        .from("books")
        .select(`${bookCols}, health`)
        .eq("school_id", schoolId)
        .neq("owner_id", userId)
        .order("created_at", { ascending: false })
    : null;
  // What this teacher actually teaches — their own classes' grades and the
  // subjects they are timetabled for. Nobody maintains this; it is already
  // true. A teacher with neither is shown the whole shelf (see splitShelf).
  // Read alongside the shelf rather than after it.
  const slotsP = schoolId ? supabase.from("timetable_slots").select("subject").eq("teacher_id", userId) : null;

  const [booksRes, shelfRes, slotsRes, classes] = await Promise.all([ownP, shelfP, slotsP, classesP]);
  const bookList = (booksRes.data ?? []) as unknown as Book[];

  const shelfOwners = new Map<string, string>();
  // Ids of school books this teacher does not teach. They ride the SAME
  // pipeline as everything else — covers, languages, rows — and are only
  // separated at the very end, when the groups are laid out.
  const shelfRestIds = new Set<string>();
  const shelf = (shelfRes?.data ?? []) as unknown as Book[];
  let ownerIds: string[] = [];
  if (shelf.length) {
    const { relevant, rest } = splitShelf(shelf, {
      grades: classes.map((c) => c.grade).filter((g): g is string => !!g),
      subjects: [
        ...new Set(
          ((slotsRes?.data ?? []) as { subject: string | null }[])
            .map((s) => s.subject)
            .filter((s): s is string => !!s),
        ),
      ],
    });
    // Who to ask about a book you did not upload.
    ownerIds = [...new Set(shelf.map((b) => b.owner_id))];
    for (const b of rest) shelfRestIds.add(b.id);
    bookList.push(...relevant, ...rest);
  }

  const [ownersRes, langsRes, covers] = await Promise.all([
    ownerIds.length ? supabase.from("profiles").select("id, full_name, username").in("id", ownerIds) : null,
    // Detected book languages (0056) — separate best-effort query so a
    // not-yet-run migration can never break the Library.
    bookList.length ? supabase.from("books").select("id, language").in("id", bookList.map((b) => b.id)) : null,
    // Signed URLs for cover thumbnails — one batch with everything else this
    // tick signs as the user.
    Promise.all(bookList.map(async (b) => [b.id, b.cover_path ? await userSign(b.cover_path) : null] as const)),
  ]);
  for (const o of (ownersRes?.data ?? []) as { id: string; full_name: string | null; username: string | null }[]) {
    const name = o.full_name || o.username;
    if (name) shelfOwners.set(o.id, name);
  }
  const bookLangs = new Map<string, string>();
  for (const b of (langsRes?.data ?? []) as { id: string; language: string | null }[]) {
    if (b.language) bookLangs.set(b.id, b.language);
  }
  const coverUrls: Record<string, string | null> = Object.fromEntries(covers);
  return { bookList, shelfOwners, shelfRestIds, bookLangs, coverUrls };
}

/** Every generation the teacher owns, with signed download URLs — all of them
 * signed in batches (one request per download name per signer), not one
 * request per file. */
async function loadLessons(supabase: Db, user: User, t: LibraryMessages, userSign: Signer) {
  const { data: gensRaw } = await supabase
    .from("generations")
    .select(
      // jobs(*) on purpose: the embedded wildcard tolerates the 0053 `stage`
      // column existing or not, so deploy order can't break the Library.
      "id, title, status, created_at, kind, chapter_ref, book_id, params, artifacts(kind, storage_path), jobs(*)",
    )
    .eq("owner_id", user.id)
    // Kits whose source book the school retired (0070). "Withdrawn" has to
    // mean gone from the shelf it was taught from, or the whole act is
    // cosmetic — the row itself survives so past scores keep their title.
    .is("withdrawn_at", null)
    .order("created_at", { ascending: false });

  type LessonRow = {
    id: string;
    title: string | null;
    status: string;
    kind: string | null;
    chapter_ref: string | null;
    book_id: string | null;
    params: Record<string, unknown> | null;
    artifacts: { kind: string; storage_path: string }[] | null;
    // More than one row since the support agent (a support_diagnose job that
    // REPORTS on the generation) and its transient retry (a second builder).
    // `type` and `created_at` are what builderJob() needs to pick the live
    // build; jobs(*) already returns them.
    jobs:
      | {
          progress: number | null;
          status: string;
          stage?: JobStage | null;
          type?: string | null;
          created_at?: string | null;
        }[]
      | null;
  };

  // TEMPORARY (2026-08-31): founder-only lesson-video download. Resolved once
  // per request, not per artifact — see @/utils/video-download to revoke.
  const mayDownloadVideo = canDownloadVideo(user.email);

  // Catalogue COPIES (0132) point at the catalogue account's files, and the
  // storage policy (artifacts_owner_rw) lets a session sign only its own
  // prefix — so a teacher's session signs nothing for them and the card showed
  // bare labels (founder, 2026-10-16). Those sign with the service role: the
  // teacher OWNS the generation row (RLS already filtered this list to
  // owner_id = auth.uid()), which is the access decision; the master file is
  // read-only to them either way. Everything else keeps signing as the user.
  let copySigner: ReturnType<typeof createAdminClient> | null = null;
  try {
    copySigner = createAdminClient();
  } catch {
    copySigner = null; // no service role locally: copies simply show no links
  }
  const copySign = copySigner ? batchSigner(copySigner, "artifacts", 3600) : null;

  // Every lesson WATCHES ITS STORED MP4 (founder 2026-10-30: "the quality
  // matters in the app so lets use stored mp4 wherever possible"). Only a
  // catalogue copy (params.catalogue_ref, or a SketchCast book's product_ref)
  // with NO stored video falls back to its kit's YouTube video, played in the
  // same in-app player (lesson-player.tsx, captions off): one service-role
  // read of those kits' YouTube ids, and usually none at all.
  const copyKitIds = ((gensRaw ?? []) as unknown as LessonRow[])
    .filter((g) => g.kind === "presentation" && isCatalogueCopy({ params: g.params }) && !(g.artifacts ?? []).some((a) => a.kind === "video_mp4"))
    .map((g) => topicKitIdOf(g.params))
    .filter((x): x is string => !!x);
  const youtubeByKit = copySigner && copyKitIds.length ? await loadKitYoutubeIds(copySigner, copyKitIds) : new Map<string, string[]>();

  // Build signed download URLs for finished artifacts.
  return Promise.all(
    ((gensRaw ?? []) as unknown as LessonRow[]).map(async (g) => {
      const sign = copySign && isCatalogueCopy({ params: g.params }) ? copySign : userSign;
      const arts = await Promise.all(
        (g.artifacts ?? []).map(async (a) => {
          // Documents get a human download filename ("Test Paper.docx", not
          // the storage basename); everything else signs untouched — a
          // download disposition on a video URL would break in-tab playback.
          const dl = docDownloadName(g.kind, a.kind);
          return { kind: a.kind as string, path: a.storage_path, url: await sign(a.storage_path, dl) };
        }),
      );
      // Multi-part lessons: a long chapter renders as several ~15-min videos
      // (lesson.mp4, lesson_part2.mp4, …) with a deck per part — collect ALL of
      // them in PART order. `video`/`deck` stay the first part for old call sites.
      const videoArts = arts
        .filter((a) => a.kind === "video_mp4" && a.url)
        .sort((a, b) => partNum(a.path) - partNum(b.path));
      const lv = lessonVideo(isCatalogueCopy({ params: g.params }) ? g.params : null, videoArts.map((a) => a.url!), youtubeByKit);
      const videos = lv.youtube.length ? lv.youtube.map(youtubeWatchUrl) : lv.paths;
      // TEMPORARY (2026-08-31): a second, download-dispositioned signing of the
      // SAME paths, for the allow-listed accounts only. `videos` above is left
      // disposition-free so in-tab playback still works. Index-aligned with
      // `videos` — a path that fails to sign keeps its slot as null rather than
      // being dropped, so Save never lands under the wrong part's Watch.
      const videoDownloads: (string | null)[] = mayDownloadVideo
        ? await Promise.all(videoArts.map((a, i) => sign(a.path, videoDownloadName(i, videoArts.length))))
        : [];
      const decks = arts
        .filter((a) => a.kind === "deck_pptx" && a.url)
        .sort((a, b) => partNum(a.path) - partNum(b.path))
        .map((a) => a.url!);
      // The job that is BUILDING this generation — not the support agent's
      // diagnosis of it, and not a dead earlier attempt. `jobs[0]` was both of
      // those at different times (2026-09-03).
      const job = builderJob(g.jobs);
      return {
        id: g.id,
        title: g.title || t.untitled,
        status: g.status,
        progress: job?.progress ?? 0,
        stage: job?.stage ?? null,
        kind: g.kind || "presentation",
        params: g.params ?? null,
        bookId: g.book_id ?? null,
        chapterRef: g.chapter_ref ?? null,
        deck: decks[0] ?? null,
        decks,
        video: videos[0] ?? null,
        videos,
        videoDownloads,
        doc: arts.find((a) => a.kind === "docx")?.url ?? null,
        // Cumulative exams (0062) carry a SECOND doc — the answer key — as its
        // own artifact kind so it never rides the student's `docx` download.
        answerKey: arts.find((a) => a.kind === "answer_key_docx")?.url ?? null,
        artifactPaths: (g.artifacts ?? []).map((a) => a.storage_path),
      };
    }),
  );
}

// ── Library sections ────────────────────────────────────────────────────────

async function NoticesSection({
  noticesP,
  diaryReachable,
}: {
  noticesP: Promise<NoticesData | null>;
  diaryReachable: boolean;
}) {
  const notices = await noticesP;
  if (!notices) return null;
  return (
    <>
      <NoticeBanner notices={notices.featured} />
      {/* The browsable list lives on the Diary now — unless this reader has
          no Diary to go to. The list is the only place a notice can be
          SIGNED, and staff are asked to sign every staff notice, so it must
          not vanish just because FEATURE_DIARY is off. */}
      {!diaryReachable && <NoticesCard notices={notices.upcoming} />}
    </>
  );
}

async function GettingStartedSection({
  gettingStartedP,
  userId,
  variant,
}: {
  gettingStartedP: Promise<GettingStartedSteps | null>;
  userId: string;
  variant: "parent" | "teacher";
}) {
  const steps = await gettingStartedP;
  return steps ? <GettingStarted userId={userId} variant={variant} steps={steps} /> : null;
}

async function BetaSection({ trialP }: { trialP: Promise<Trial> }) {
  const { isBeta } = await trialP;
  return isBeta ? <BetaBanner /> : null;
}

async function UploadSection({
  trialP,
  booksP,
  schoolId,
  t,
  userId,
}: {
  trialP: Promise<Trial>;
  booksP: ReturnType<typeof loadBooks>;
  schoolId: string | null;
  t: LibraryMessages;
  userId: string;
}) {
  const { isBeta, trialBookUsed } = await trialP;
  // Only a trial account whose ledger is still clear needs the book list to
  // decide — everyone else gets the upload card without waiting for it.
  const betaBlocked =
    isBeta && (trialBookUsed >= 1 || (await booksP).bookList.some((b) => b.owner_id === userId));
  return <UploadBook schoolId={schoolId} t={t} betaBlocked={betaBlocked} />;
}

async function ClassesSection({
  rostersP,
  trialP,
  brandingP,
  role,
  t,
}: {
  rostersP: Promise<ClassRoster[]>;
  trialP: Promise<Trial>;
  brandingP: Promise<{ hasDocx: boolean; hasPptx: boolean }>;
  role: string | null;
  t: LibraryMessages;
}) {
  const [classRosters, { isBeta }, branding] = await Promise.all([rostersP, trialP, brandingP]);
  // Beta state: remaining student slots.
  let trialSlotsLeft: number | null = null;
  if (isBeta) {
    const distinctStudents = new Set(
      classRosters.flatMap((c) => c.students.map((s) => s.username || s.full_name || "")),
    ).size;
    trialSlotsLeft = Math.max(0, 2 - distinctStudents);
  }
  return (
    <>
      <div data-tour="classes">
        <ClassesCard classes={classRosters} t={t} trialSlotsLeft={trialSlotsLeft} />
      </div>

      {/* Teachers/schools only — parents never see the letterhead card. The
          school-admin tour's branding step tolerates the absent marker. */}
      {role !== "parent" && (
        <div data-tour="branding">
          <BrandingCard hasDocx={branding.hasDocx} hasPptx={branding.hasPptx} t={t} />
        </div>
      )}
    </>
  );
}

async function MyBooksSection({
  myBooksP,
  t,
  unavailable,
}: {
  myBooksP: ReturnType<typeof myBooksStrip>;
  t: LibraryMessages;
  unavailable: boolean;
}) {
  const myBooks = await myBooksP;
  return <MyBooksStrip tiles={myBooks} t={t.myBooks} unavailable={unavailable} />;
}

async function LibrarySection({
  booksP,
  lessonsP,
  classesP,
  childTargetsP,
  trialP,
  fairUseP,
  gettingStartedP,
  t,
  locale,
  schoolId,
  userId,
  role,
}: {
  booksP: ReturnType<typeof loadBooks>;
  lessonsP: ReturnType<typeof loadLessons>;
  classesP: Promise<ClassOption[]>;
  childTargetsP: Promise<ChildTarget[] | null>;
  trialP: Promise<Trial>;
  fairUseP: Promise<FairUse>;
  gettingStartedP: Promise<GettingStartedSteps | null>;
  t: LibraryMessages;
  locale: Locale;
  schoolId: string | null;
  userId: string;
  role: string | null;
}) {
  const [
    { bookList, shelfOwners, shelfRestIds, bookLangs, coverUrls },
    lessons,
    classes,
    childTargets,
    { isBeta, trialPin },
    { trialTier, premiumVoices },
    gettingStarted,
  ] = await Promise.all([booksP, lessonsP, classesP, childTargetsP, trialP, fairUseP, gettingStartedP]);
  // The pinned unit: the DB's own answer via my_trial_pin — display-list
  // derivation broke on created_at ties and the 1000-row cap.
  const betaPinned = trialPin;

  type Lesson = (typeof lessons)[number];

  // Latest generation for a book + chapter + kind (gensRaw is newest-first).
  // `part` scopes to per-part lesson units: null = the whole-chapter artifact
  // (a lesson generated with params.part never fills the whole-chapter cell,
  // and vice versa).
  const partOf = (l: Lesson): number | null => {
    const p = (l.params as { part?: unknown } | null)?.part;
    return typeof p === "number" && p >= 1 ? p : null;
  };
  // Revision papers (params.revision, 0061) are standalone worksheets/exams
  // over a group of chapters — they live in their OWN book-level section, never
  // in a chapter's kit cells.
  const isRevision = (l: Lesson): boolean => (l.params as { revision?: unknown } | null)?.revision === true;
  // Cumulative exams (0062, kind 'exam') live in their OWN book-level section
  // ("Exams") — never in a chapter's cells, Other lessons or Revision papers.
  const isExam = (l: Lesson): boolean => l.kind === "exam";
  const lessonFor = (bookId: string, num: number, kind: string, part: number | null = null): Lesson | undefined =>
    lessons.find(
      (l) => l.bookId === bookId && l.chapterRef === String(num) && l.kind === kind && partOf(l) === part && !isRevision(l),
    );
  // The chapter's "lesson" = its presentation (deck+video) — used for progress.
  const lessonForChapter = (bookId: string, num: number): Lesson | undefined =>
    lessonFor(bookId, num, "presentation");
  // Lessons for a book that aren't tied to one of its current chapters
  // (legacy whole-book lessons with chapter_ref = null, or stale refs) — plus
  // ORPHANED part lessons: a re-index can shrink or drop a chapter's part
  // map, and a lesson with params.part beyond it must stay visible (and
  // deletable) here rather than silently vanishing.
  const otherLessonsForBook = (book: Book): Lesson[] => {
    const nums = new Set((book.chapters ?? []).map((c) => String(c.num)));
    const partsLen = new Map((book.chapters ?? []).map((c) => [String(c.num), c.parts?.length ?? 0]));
    return lessons.filter((l) => {
      if (l.bookId !== book.id) return false;
      if (isRevision(l)) return false; // revision papers have their own section
      if (isExam(l)) return false; // exams have their own section
      if (l.chapterRef === null || !nums.has(l.chapterRef)) return true;
      const part = partOf(l);
      if (part !== null) {
        const n = partsLen.get(l.chapterRef) ?? 0;
        return n <= 1 || part > n;
      }
      return false;
    });
  };
  // Lessons queued via the book's "Generate selected" batch — shown together
  // under their own sub-header at the end of the book (marked params.batch).
  const batchLessonsForBook = (book: Book): Lesson[] =>
    lessons.filter((l) => l.bookId === book.id && (l.params as { batch?: unknown } | null)?.batch === true);

  const hasPending =
    lessons.some((l) => l.status === "queued" || l.status === "processing") ||
    bookList.some((b) => b.status === "indexing");

  // Shape the data for the (client) collapsible book/chapter table.
  const bookRows: BookRow[] = bookList.map((b) => {
    const chs = b.chapters ?? [];
    return {
      id: b.id,
      title: b.title,
      author: b.author,
      status: b.status,
      grade: b.grade,
      subject: b.subject,
      language: bookLangs.get(b.id) ?? null,
      // Non-null only for a school book someone else uploaded.
      sharedBy: b.owner_id === userId ? null : shelfOwners.get(b.owner_id) ?? null,
      coverUrl: coverUrls[b.id] ?? null,
      storagePath: b.storage_path,
      createdAt: b.created_at,
      health: (b.health as BookHealth | null) ?? null,
      doneChapters: chs.filter((c) => lessonForChapter(b.id, c.num)?.status === "done").length,
      totalChapters: chs.length,
      presentationIds: [
        ...chs.map((c) => lessonFor(b.id, c.num, "presentation")),
        // Per-part lessons are as assignable as whole-chapter ones.
        ...chs.flatMap((c) =>
          (c.parts?.length ?? 0) > 1 ? c.parts!.map((_, i) => lessonFor(b.id, c.num, "presentation", i + 1)) : [],
        ),
      ]
        .filter((l): l is Lesson => !!l && l.status === "done")
        .map((l) => l.id),
      chapters: chs.map((c) => ({
        num: c.num,
        title: c.title,
        presentation: lessonFor(b.id, c.num, "presentation") ?? null,
        // The deck generation (0103); a pre-0103 kit's deck stays on the
        // presentation's own `deck`/`decks` above.
        deck: lessonFor(b.id, c.num, "deck") ?? null,
        lessonPlan: lessonFor(b.id, c.num, "lesson_plan") ?? null,
        activity: lessonFor(b.id, c.num, "activity") ?? null,
        worksheet: lessonFor(b.id, c.num, "worksheet") ?? null,
        exam: lessonFor(b.id, c.num, "exam_paper") ?? null,
        caseStudy: lessonFor(b.id, c.num, "case_study") ?? null,
        // Per-part lesson units (index-time part map, 2026-07-18): each part
        // carries its OWN full kit, generated on demand.
        parts:
          (c.parts?.length ?? 0) > 1
            ? c.parts!.map((p, i) => ({
                n: i + 1,
                // The part TOTAL travels with the part number, because the card
                // names a part "<chapter> · Part 3 of 7" — an ordinal with no
                // total is a number the teacher cannot place.
                total: c.parts!.length,
                titles: (p.titles ?? []).slice(0, 3),
                presentation: lessonFor(b.id, c.num, "presentation", i + 1) ?? null,
                deck: lessonFor(b.id, c.num, "deck", i + 1) ?? null,
                lessonPlan: lessonFor(b.id, c.num, "lesson_plan", i + 1) ?? null,
                activity: lessonFor(b.id, c.num, "activity", i + 1) ?? null,
                worksheet: lessonFor(b.id, c.num, "worksheet", i + 1) ?? null,
                exam: lessonFor(b.id, c.num, "exam_paper", i + 1) ?? null,
                caseStudy: lessonFor(b.id, c.num, "case_study", i + 1) ?? null,
              }))
            : [],
      })),
      // "Pending" = no chapter-level lesson AND no part-level one either — a
      // chapter whose parts already have kits must not get a chapter-level
      // kit on top (it would duplicate the part videos and charge one credit
      // per rendered part, 0059).
      pendingChapters: chs
        .filter(
          (c) =>
            !lessonForChapter(b.id, c.num) &&
            !(c.parts ?? []).some((_, i) => lessonFor(b.id, c.num, "presentation", i + 1)),
        )
        // partCount travels with the chapter because "Generate all" now queues a
        // kit PER PART (founder decision 2026-08-27) rather than one
        // chapter-level kit. Without it the button cannot know how many rows a
        // chapter is worth, and Sara's Magnetism produced a chapter-level block
        // ABOVE four still-empty part rows — the same chapter offered twice.
        .map((c) => ({ num: c.num, title: c.title, partCount: c.parts?.length ?? 0 })),
      // Revision papers (0061): standalone worksheets/exams over a group of
      // chapters, in their own section. Cumulative ones carry params.chapters.
      revisionPapers: lessons
        .filter((l) => l.bookId === b.id && isRevision(l))
        .map((l) => {
          const kind = l.kind === "exam_paper" ? t.kinds.exam_paper : t.kinds.worksheet;
          const chapters = (l.params as { chapters?: unknown } | null)?.chapters;
          const scope = Array.isArray(chapters) && chapters.length
            ? chapterRangeLabel(t, chapters as number[])
            : l.chapterRef !== null
              ? chs.find((c) => String(c.num) === l.chapterRef)?.title ??
                fmt(t.chapter, { n: Number(l.chapterRef) + 1 })
              : "";
          return {
            id: l.id,
            label: scope ? fmt(t.book.revisionLabel, { kind, scope }) : kind,
            status: l.status,
            progress: l.progress,
            stage: l.stage,
            doc: l.doc,
            // Post-split papers carry their key as a separate document —
            // offered here (an adult surface) exactly like the exams section.
            answerKey: l.answerKey,
            artifactPaths: l.artifactPaths,
          };
        }),
      // Exam tool (0062): the covered units the teacher can test — a chapter
      // with a live chapter-level lesson (part 0 = "Whole chapter"), or each
      // covered part of a multi-part chapter. Only these are offered.
      examUnits: chs
        .map((c) => {
          const parts = c.parts ?? [];
          const units: { part: number; label: string }[] = [];
          // A chapter-level lesson (part 0) covers the whole chapter — offer it
          // whenever one exists, INCLUDING a multi-part chapter taught at chapter
          // level (e.g. via "Generate all"), which would otherwise be invisible.
          if (lessonFor(b.id, c.num, "presentation")?.status === "done") {
            units.push({ part: 0, label: t.wholeChapter });
          }
          if (parts.length > 1) {
            parts.forEach((p, i) => {
              const pl = lessonFor(b.id, c.num, "presentation", i + 1);
              if (pl && pl.status === "done") {
                const titles = (p.titles ?? []).slice(0, 2).join(", ");
                units.push({
                  part: i + 1,
                  label: titles ? fmt(t.partTitled, { n: i + 1, titles }) : fmt(t.part, { n: i + 1 }),
                });
              }
            });
          }
          return { num: c.num, title: c.title, units };
        })
        .filter((c) => c.units.length > 0),
      // Generated exams (0062): the exam paper + its answer key, with a coverage
      // line so the teacher knows exactly what the last exam tested.
      exams: lessons
        .filter((l) => l.bookId === b.id && isExam(l))
        .map((l) => {
          const scopeRaw = (l.params as { scope?: unknown } | null)?.scope;
          const scope = Array.isArray(scopeRaw) ? (scopeRaw as { chapter: string; part: number }[]) : [];
          const title = (l.params as { title?: unknown } | null)?.title;
          return {
            id: l.id,
            label: typeof title === "string" && title.trim() ? title.trim() : t.kinds.exam,
            coverage: examCoverageLabel(t, scope, chs),
            status: l.status,
            progress: l.progress,
            stage: l.stage,
            doc: l.doc,
            answerKey: l.answerKey,
            artifactPaths: l.artifactPaths,
          };
        }),
      otherLessons: otherLessonsForBook(b),
      batchLessons: batchLessonsForBook(b),
    };
  });

  // Group the library Grade → Subject (auto-detected; "Other / General" when unknown).
  // The school books this teacher does not teach are grouped the same way, but
  // into their own list — shown behind a disclosure so the shelf is complete
  // without a Science teacher scrolling through Form 5 Accounting.
  const groupBy = (rows: BookRow[]) => {
    const groupMap = new Map<string, BookRow[]>();
    for (const br of rows) {
      const key = `${br.grade || t.group.other}|||${br.subject || t.group.general}`;
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key)!.push(br);
    }
    return [...groupMap.entries()]
      .map(([key, rs]) => {
        const [grade, subject] = key.split("|||");
        return { grade, subject, books: rs };
      })
      .sort((a, b) => `${a.grade} ${a.subject}`.localeCompare(`${b.grade} ${b.subject}`));
  };
  const groups = groupBy(bookRows.filter((br) => !shelfRestIds.has(br.id)));
  const shelfGroups = groupBy(bookRows.filter((br) => shelfRestIds.has(br.id)));

  return (
    <>
      <AutoRefresh active={hasPending} />
      {bookList.length === 0 ? (
        gettingStarted ? (
          // The stepper above already walks the journey — keep this slim so the
          // same three steps don't appear twice on one screen.
          <div data-tour="library-empty" className="rounded-xl border border-dashed border-[#D2D6D1] bg-white p-8 text-center text-[#5B6470]">
            <EmptyBooks />
            <p className="font-medium text-[#14181F] mt-2">{t.empty.withStepper}</p>
          </div>
        ) : (
        <div data-tour="library-empty" className="rounded-xl border border-dashed border-[#D2D6D1] bg-white p-10 text-center text-[#5B6470]">
          <EmptyBooks />
          <p className="font-medium text-[#14181F] mb-4">{t.empty.title}</p>
          <div className="flex flex-wrap items-center justify-center gap-2 text-sm">
            <span className="inline-flex items-center gap-2 rounded-full bg-[#F5F6F3] px-3 py-1.5">
              <span className="h-5 w-5 rounded-full bg-[#1FB8A6] text-white text-xs font-medium inline-flex items-center justify-center">1</span>
              {t.empty.step1}
            </span>
            <span className="rtl-flip text-[#98A0A9]">→</span>
            <span className="inline-flex items-center gap-2 rounded-full bg-[#F5F6F3] px-3 py-1.5">
              <span className="h-5 w-5 rounded-full bg-[#1FB8A6] text-white text-xs font-medium inline-flex items-center justify-center">2</span>
              {t.empty.step2}
            </span>
            <span className="rtl-flip text-[#98A0A9]">→</span>
            <span className="inline-flex items-center gap-2 rounded-full bg-[#F5F6F3] px-3 py-1.5">
              <span className="h-5 w-5 rounded-full bg-[#1FB8A6] text-white text-xs font-medium inline-flex items-center justify-center">3</span>
              {t.empty.step3}
            </span>
          </div>
          <p className="text-xs text-[#98A0A9] mt-4">{t.empty.note}</p>
        </div>
        )
      ) : (
        <div className="space-y-8" data-tour="book-card">
          {groups.map((g) => (
            <section key={`${g.grade}-${g.subject}`}>
              <div className="flex items-center gap-2 mb-2.5 px-1">
                <h2 className="chip font-sans bg-[#E2F4F1] text-[#0C8175]">{g.grade}</h2>
                <span className="text-sm font-medium text-[#5B6470]">{g.subject}</span>
              </div>
              <BookTable
                books={g.books}
                schoolId={schoolId}
                classes={classes}
                childTargets={childTargets}
                t={t}
                lang={htmlLang(locale)}
                beta={isBeta ? { pinned: betaPinned } : null}
                examEnabled={examGenerationEnabled()}
                trial={trialTier}
                premiumVoices={premiumVoices}
              />
            </section>
          ))}
        </div>
      )}

      {/* The rest of the school's shelf (0070). Closed by default and never
          filtered away: the relevance rule upstream decides what a teacher
          sees FIRST, not what they are allowed to use, so being wrong about
          what someone teaches costs one click and not a missing book. */}
      {shelfGroups.length > 0 && (
        <details className="mt-10 group">
          <summary className="cursor-pointer text-sm text-[#5B6470] hover:text-[#14181F] select-none">
            <span className="rtl-flip inline-block me-1.5 transition-transform group-open:rotate-90">▶</span>
            {fmt(t.shelf.alsoInSchool, { n: shelfGroups.reduce((n, g) => n + g.books.length, 0) })}
          </summary>
          <div className="space-y-8 mt-5">
            {shelfGroups.map((g) => (
              <section key={`shelf-${g.grade}-${g.subject}`}>
                <div className="flex items-center gap-2 mb-2.5 px-1">
                  <h2 className="chip font-sans bg-[#F5F6F3] text-[#5B6470]">{g.grade}</h2>
                  <span className="text-sm font-medium text-[#5B6470]">{g.subject}</span>
                </div>
                <BookTable
                  books={g.books}
                  schoolId={schoolId}
                  classes={classes}
                  t={t}
                  lang={htmlLang(locale)}
                  beta={isBeta ? { pinned: betaPinned } : null}
                  examEnabled={examGenerationEnabled()}
                  trial={trialTier}
                  premiumVoices={premiumVoices}
                />
              </section>
            ))}
          </div>
        </details>
      )}

      <BooklessKits
        lessons={lessons.filter((l) => l.bookId === null)}
        classes={classes}
        childTargets={childTargets}
        kitsHref={catalogueTabEnabled() && role !== "student" ? "/dashboard/kits" : null}
        t={t}
      />
    </>
  );
}

async function FeedbackWidgetSection({ feedbackP }: { feedbackP: Promise<{ submitted: boolean } | null> }) {
  const feedback = await feedbackP;
  return feedback ? <FeedbackWidget submitted={feedback.submitted} /> : null;
}

async function FeedbackAskSection({
  feedbackAskP,
  t,
}: {
  feedbackAskP: Promise<{ requestId: string } | null>;
  t: Dictionary["feedbackAsk"];
}) {
  const feedbackAsk = await feedbackAskP;
  return feedbackAsk ? <FeedbackQuestionnaire requestId={feedbackAsk.requestId} t={t} /> : null;
}
