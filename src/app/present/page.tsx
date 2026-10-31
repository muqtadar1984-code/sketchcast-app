import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { presentEntitled } from "@/utils/present/entitlement";
import { getDictionary, type Dictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";
import { shapeFromConfig, type Slot } from "@/utils/timetable";
import type { LastTaught } from "@/utils/present/context";
import {
  calendarEnabledFor,
  catalogueTabEnabled,
  diaryEnabled,
  parentPortalEnabled,
  roleHatsEnabled,
  schoolAnalyticsEnabledFor,
  skShellEnabledFor,
  timetableEnabledFor,
} from "@/utils/flags";
import { hatsFor, resolveHat, type Hat } from "@/utils/hats";
import { tabsFor, tabsForHat } from "@/utils/nav-tabs";
import type { MenuItem } from "./menu-items";
import { activeHatCookie } from "@/utils/hats-server";
import { loadBoardBooks, loadBoardKits } from "@/utils/present/ready-made-server";
import PresentClient, { type BookOption, type ClassName, type KitOption, type LearnerKitOption, type PresentSk } from "./present-client";
import { learnerGate, loadLearnerKits } from "@/utils/present/learner-server";
import type { LearnerKit } from "@/utils/present/learner";
import { fmt } from "@/i18n/format";

export const dynamic = "force-dynamic";

// Present mode — the board a teacher drives on a classroom panel.
//
// This server component does the two things a server must: it enforces the gate,
// and it fetches. It deliberately does NOT decide which period it is. Vercel runs
// in UTC and the classroom is not; the panel's own clock is the classroom's
// clock, so the context is resolved on the client from the data handed down
// here. A server-side "it is Period 3" would be wrong by eight hours in Malaysia
// and right nowhere in particular.
//
// EVERY PRESENT QUERY IS BEST-EFFORT. Migration 0097 may not be applied yet, and
// this app's rule is that a not-yet-run migration can never break a page (see
// the same guard around books.language in the dashboard). A missing table gives
// an empty pointer list and a bar that asks her to pick, which is exactly the
// first-lesson experience anyway.

export default async function PresentPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=%2Fpresent");

  // plan_tier is service_role-only, so the gate needs the admin client. Built
  // once here and reused below for the class lookup.
  let admin: ReturnType<typeof createAdminClient> | null = null;
  try {
    admin = createAdminClient();
  } catch {
    admin = null;
  }

  // A SENTENCE, NOT A SILENT REDIRECT. Bouncing a Pro-less teacher to the
  // dashboard was right while the surface was secret — there was nothing to tell
  // them. Now that the board ships with Pro, Pro+ and every school plan, landing
  // them back on the Library with no explanation is the product refusing to say
  // what it wants. The API routes keep their bare 404s: those answer strangers.
  // The page's words. Resolved on the SERVER and handed down as props — ten
  // message files must never reach the browser bundle, which is the whole reason
  // dictionaries.ts is server-only.
  const dict = await getDictionary(await resolveLocale());
  const t = dict.present;

  const verdict = await presentEntitled(admin, user.id, user);
  if (!verdict.ok) {
    // THE STUDENT BOARD (SK student Board plan 2026-10-31, phase 1). A
    // student never drives a teacher's Board, but one for whom SK is on
    // learns her ASSIGNED kits on it, in learner mode: her school's or
    // teacher's entitlement is what assigned them, so she needs no plan of
    // her own. Everyone else (a student without SK, a parent) keeps the
    // refusal exactly as before.
    const lg = await learnerGate(supabase, user);
    if (!lg.ok) return <Refused t={t} why={verdict.why} />;
    return <LearnerBoard supabase={supabase} userId={user.id} role={lg.role} dict={dict} />;
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, role, school_id")
    .eq("id", user.id)
    .maybeSingle();
  const schoolId = (profile?.school_id as string | null) ?? null;
  const role = (profile?.role as string | null) ?? null;

  // SK Shell on the Board (S1): the same gates the dashboard layout runs
  // (FEATURE_SK + SK_ROLES + tenant opt-in / allow list) through the caller's
  // own session; nothing here can throw. The launcher is mounted by the
  // client page WITH the Board bridge, which is why it does not come through
  // dashboard/layout (the Board has no layout of its own).
  let sk: PresentSk | null = null;
  try {
    if (await skShellEnabledFor(supabase, user, role, schoolId)) {
      sk = { copy: dict.sk.shell, walkCopy: dict.sk.walkthrough, role, hat: await activeHatCookie() };
    }
  } catch {
    sk = null;
  }

  // The school's period/day shape. No school, or no config, resolves to the
  // default shape — which is harmless: with no slots to match, the bar simply
  // reports that it does not know.
  let shape = shapeFromConfig(null);
  if (schoolId) {
    const { data: school } = await supabase
      .from("schools")
      .select("config")
      .eq("id", schoolId)
      .maybeSingle();
    shape = shapeFromConfig(school?.config ?? null);
  }

  const { data: slotRows } = await supabase
    .from("timetable_slots")
    .select("class_id, day, period, subject, teacher_id, kind")
    .eq("teacher_id", user.id);
  const slots = (slotRows ?? []) as Slot[];

  // Class names and grades for the bar. Through the service role for the same
  // reason my-timetable does it: a member's RLS view of classes is narrower than
  // the grid they can already see, and a bar reading "Class" helps nobody.
  //
  // HER OWN CLASSES AS WELL AS HER TIMETABLE'S. The two are different sets and
  // only their union is useful: a school teacher's lessons come from the grid,
  // but an independent teacher has classes and no grid at all, and without her
  // own list the bar would offer nothing to attach a lesson to — which means no
  // audience for the note afterwards, discovered at the bell.
  const slotClassIds = [...new Set(slots.map((s) => s.class_id))];
  const classById = new Map<string, ClassName>();
  const collect = (rows: ClassName[] | null) => {
    for (const c of rows ?? []) classById.set(c.id, c);
  };
  try {
    if (!admin) throw new Error("no service role");
    if (slotClassIds.length) {
      const { data } = await admin.from("classes").select("id, name, grade").in("id", slotClassIds);
      collect(data as ClassName[] | null);
    }
    const { data: own } = await admin
      .from("classes")
      .select("id, name, grade")
      .eq("teacher_id", user.id);
    collect(own as ClassName[] | null);
  } catch {
    if (slotClassIds.length) {
      const { data } = await supabase.from("classes").select("id, name, grade").in("id", slotClassIds);
      collect(data as ClassName[] | null);
    }
    const { data: own } = await supabase
      .from("classes")
      .select("id, name, grade")
      .eq("teacher_id", user.id);
    collect(own as ClassName[] | null);
  }
  const classes: ClassName[] = [...classById.values()].sort((a, b) => a.name.localeCompare(b.name));

  // Where each of her classes has got to. Absent before 0097 — see the header.
  let lastTaught: LastTaught[] = [];
  try {
    const { data } = await supabase
      .from("present_last_taught")
      .select("class_id, subject, book_id, chapter_num, part")
      .eq("teacher_id", user.id);
    lastTaught = (data ?? []) as LastTaught[];
  } catch {
    lastTaught = [];
  }

  // The books she can teach from — the manual picker's options, and the only
  // path available on a first lesson with any class. Since 0175 that includes
  // every SketchCast book she holds a grant for (RLS), marked `product` with
  // each chapter's catalogue kits: a chapter of one is adopted on pick or on
  // a ?book=&chapter= deep link (utils/present/ready-made.ts).
  const books: BookOption[] = await loadBoardBooks(supabase, admin);

  // READY-MADE KITS: hers (catalogue kits copied into the library arrive with
  // no book and no chapter, so the book picker cannot reach them), then every
  // catalogue kit she can open but has not copied — adopted on pick. The id of
  // one of hers is the kit's presentation, which /api/present/kit?kit= and
  // /api/present/session {kitId} key on. Best-effort like every read here.
  let kits: KitOption[] = [];
  try {
    kits = await loadBoardKits(supabase, admin, user.id, catalogueTabEnabled() && role !== "student");
  } catch {
    kits = [];
  }

  // The Board's menu (Board UX 2026-10-28): the portal's tabs for her current
  // hat, from the SAME inputs app-header.tsx uses, so the menu never offers a
  // door the header would not. Best-effort: a failure is a menu with only
  // "Back to dashboard", never a broken Board.
  let tabs: MenuItem[] = [];
  try {
    tabs = await portalTabs(supabase, role, schoolId, dict);
  } catch {
    tabs = [];
  }

  return (
    <PresentClient
      teacherId={user.id}
      teacherName={(profile?.full_name as string | null) ?? null}
      t={t}
      shape={shape}
      slots={slots}
      classes={classes}
      lastTaught={lastTaught}
      books={books}
      kits={kits}
      sk={sk}
      tabs={tabs}
    />
  );
}

/**
 * The student Board: the same client page in learner mode. Her assigned kits
 * only (utils/present/learner.ts), SK on (the gate above), and none of the
 * teacher's inputs — no timetable, no classes, no books, no ready-made kits,
 * no portal menu beyond "Back to my lessons". Best-effort like every read
 * here: a failed read is an empty list, never a broken page.
 */
async function LearnerBoard({
  supabase,
  userId,
  role,
  dict,
}: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  userId: string;
  role: string | null;
  dict: Dictionary;
}) {
  const t = dict.present;
  let kits: LearnerKit[] = [];
  try {
    kits = await loadLearnerKits(supabase);
  } catch {
    kits = [];
  }
  const [{ data: profile }, books] = await Promise.all([
    supabase.from("profiles").select("full_name").eq("id", userId).maybeSingle(),
    (async () => {
      const ids = [...new Set(kits.map((k) => k.bookId).filter((x): x is string => !!x))];
      if (!ids.length) return [] as { id: string; title: string | null; chapters: { num: number; title?: string | null }[] | null }[];
      try {
        const { data } = await supabase.from("books").select("id, title, chapters").in("id", ids);
        return (data ?? []) as { id: string; title: string | null; chapters: { num: number; title?: string | null }[] | null }[];
      } catch {
        return [];
      }
    })(),
  ]);
  const bookById = new Map(books.map((b) => [b.id, b]));
  const titleOf = (k: LearnerKit): string => {
    if (k.title) return k.title;
    const b = k.bookId ? bookById.get(k.bookId) : undefined;
    const num = k.chapterNum ?? 0;
    const ch = b?.chapters?.find((c) => c?.num === num)?.title?.trim();
    const chapter = ch && !/^\d+$/.test(ch) ? ch : fmt(t.bar.chapterN, { n: num + 1 });
    return b?.title ? `${b.title} · ${chapter}` : chapter;
  };
  // (server component, rendered once per request — Date.now is fine here)
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const learnerKits: LearnerKitOption[] = kits.map((k) => ({ id: k.id, title: titleOf(k), due: k.due, members: k.members, overdue: !!k.due && Date.parse(k.due) < nowMs }));
  const sk: PresentSk = { copy: dict.sk.shell, walkCopy: dict.sk.walkthrough, role, hat: null };
  return (
    <PresentClient
      teacherId={userId}
      teacherName={(profile?.full_name as string | null) ?? null}
      t={t}
      shape={shapeFromConfig(null)}
      slots={[]}
      classes={[]}
      lastTaught={[]}
      books={[]}
      kits={learnerKits.map((k) => ({ id: k.id, title: k.title }))}
      sk={sk}
      tabs={[]}
      learner={{ kits: learnerKits }}
    />
  );
}

/**
 * The tabs app-header.tsx would show this teacher, computed the same way
 * (tabsForHat with a hat, tabsFor without). The Board's own gate already
 * passed, so `boardOn` is true; menuItemsFor drops /present from the list.
 */
async function portalTabs(
  supabase: Awaited<ReturnType<typeof createClient>>,
  role: string | null,
  schoolId: string | null,
  dict: Dictionary,
): Promise<MenuItem[]> {
  const adult = !!role && role !== "student";
  const analyticsOn = adult ? await schoolAnalyticsEnabledFor(supabase, schoolId) : false;
  const timetableOn = role && schoolId ? await timetableEnabledFor(supabase, schoolId) : false;
  const calendarOn = adult ? await calendarEnabledFor(supabase, schoolId) : false;
  let hasScope = false;
  if ((role === "teacher" || role === "coordinator") && schoolId) {
    const { data: sc } = await supabase.from("coordinator_scope").select("id").eq("school_id", schoolId).limit(1);
    hasScope = (sc?.length ?? 0) > 0;
  }
  let hasChildren = false;
  let hasSchoolParentLinks = false;
  if (parentPortalEnabled() && adult) {
    const { data: pl } = await supabase.from("parent_links").select("source").limit(20);
    hasChildren = (pl?.length ?? 0) > 0;
    hasSchoolParentLinks = ((pl ?? []) as { source: string | null }[]).some((l) => l.source === "school");
  }
  const diaryOn = diaryEnabled() && !!role;
  let activeHat: Hat | null = null;
  if (roleHatsEnabled()) {
    const hats = hatsFor({ role, hasScope, hasChildren, analyticsOn, timetableOn, diaryOn });
    activeHat = resolveHat(await activeHatCookie(), hats);
  }
  const kitsOn = catalogueTabEnabled() && adult;
  const boardOn = true;
  const t = dict.nav.tabs;
  return activeHat
    ? tabsForHat(t, activeHat, analyticsOn, calendarOn, timetableOn, diaryOn, hasSchoolParentLinks, boardOn, kitsOn)
    : tabsFor(t, role, hasScope, hasChildren, hasSchoolParentLinks, analyticsOn, calendarOn, timetableOn, diaryOn, dict.student.title, boardOn, kitsOn);
}

/** What a teacher sees when the board is not on their plan. Deliberately not a
 *  redirect and deliberately not a 404: they are signed in, they followed a link
 *  we gave them, and the honest answer is short. */
function Refused({ t, why }: { t: Dictionary["present"]; why: "not-teaching" | "plan" }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-[#0F1417] px-6 text-[#E7EDE9]">
      <div className="max-w-md text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-[#5F6F69]">
          SketchCast
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{t.title}</h1>
        <p className="mt-3 text-sm leading-relaxed text-[#93A09A]">
          {why === "plan" ? t.gate.plan : t.gate.notTeaching}
        </p>
        <a
          href="/dashboard"
          className="mt-6 inline-block rounded-xl bg-[#0C8175] px-6 py-3 text-sm font-medium text-white"
        >
          {t.gate.back}
        </a>
      </div>
    </main>
  );
}
