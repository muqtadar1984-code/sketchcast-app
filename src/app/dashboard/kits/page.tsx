import { Suspense } from "react";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { createClient, currentUser } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import AppHeader from "../app-header";
import { InkUnderline } from "@/components/ink-mark";
import { catalogueTabEnabled } from "@/utils/flags";
import { enforceHat } from "@/utils/hats-server";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";
import { htmlLang } from "@/i18n/locales";
import { fmt } from "@/i18n/format";
import { type LibraryMessages } from "../labels";
import type { ChildRow, ClassRow } from "../assign-modal";
import KitsGallery, { type KitsMessages, type KitView } from "./kits-gallery";
import {
  buildKits,
  canUnlockMore,
  showsUpgrade,
  topicParam,
  type Allowance,
  type CurrentKitRow,
  type Kit,
  type PublicRow,
  type TopicKitRow,
  type TopicRow,
  type UnlockRow,
} from "./logic";

const PRICING_URL = "https://sketchcast.app/pricing";
const PUBLIC_TOPICS_URL = "https://sketchcast.app/topics";

type Db = Awaited<ReturnType<typeof createClient>>;

// Ready-made kits (catalogue Phase C; plan §4.2/§5.2/§5.3).
//
// The approved catalogue lessons, behind sign-in: see what each kit holds,
// unlock one within the weekly allowance, download its documents, and copy it
// into the Library to assign. Everything that decides is in the database —
// catalogue_current_kits() (which kits exist), my_catalogue_allowance() (how
// many this week), unlock_catalogue_kit() (the click), adopt_catalogue_piece()
// (the copy) and /api/catalogue/file (every download). This page is the honest
// mirror of those answers, in the reader's language.
//
// GATES, in order: the feature flag (a door, redirects rather than 404s so a
// signup carry-through still lands somewhere); the session; the role
// (students have no kits); the hat (an authoring surface, like the Library);
// then the database's own eligibility, which includes the RELEASE switch
// (0130): until the founder flips it, everyone outside the preview list sees
// the "coming soon" card here while the public lesson pages stay public.
//
// EVERY LOAD PAST THE ROLE GATES IS A 'view' in catalogue_events — the
// funnel's first in-app step (Console → Catalogue, and the account page).
// Recorded whatever the database answers, with that answer in meta, so a
// "coming soon" visit still counts as someone who came looking. Written after
// the response, best-effort: a failed log never slows or fails the page.
//
// ── Streaming (2026-10-30) ──────────────────────────────────────────────────
// SK's first-login tour skipped this page: it waited (capped at 20 s) for a
// page that made eight round trips IN SEQUENCE and then rendered ~610 cards
// at once. Now:
//   · every read that does not depend on another starts at once — the
//     profile, the allowance and the whole catalogue in ONE wave, the
//     assignment targets as soon as the role is known (beside enforceHat);
//   · the page itself waits only for what DECIDES it (who, the role and hat
//     redirects, the eligibility answer) and renders the header and the
//     allowance line — the tour's anchor, `data-tour="kits-allowance"` — at
//     once;
//   · the gallery streams in behind <Suspense> with a light <Pending>
//     skeleton (aria-busy + data-sk-loading, so the tour knows it is still
//     loading), and renders in chunks (kits-gallery.tsx);
//   · the cards ship only what they cannot derive: labels, download links and
//     the in-app video URL are computed in the browser (logic.ts).
// Reads started before a redirect is decided are reads only: nothing from
// them reaches the browser unless the page renders past every gate.
export default async function KitsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!catalogueTabEnabled()) redirect("/dashboard");

  // The verified user is shared with the layout and header (currentUser is
  // React-cached per request) — one Auth round trip for the whole render.
  const [supabase, user, locale, params] = await Promise.all([createClient(), currentUser(), resolveLocale(), searchParams]);
  if (!user) redirect("/login");

  // ONE wave: none of these depends on another.
  const dictP = started(getDictionary(locale));
  const profileP = started(supabase.from("profiles").select("role, school_id").eq("id", user.id).single());
  const allowanceP = started(supabase.rpc("my_catalogue_allowance"));
  const catalogueP = started(readCatalogue(supabase));

  const { data: profile } = await profileP;
  const role = (profile?.role as string | null) ?? null;
  if (role === "student") redirect("/dashboard");
  // The assignment targets need only the role: asked now, beside the hat check.
  const targetsP = started(assignTargets(supabase, role, user.id));
  const hatAway = await enforceHat(supabase, role, (profile?.school_id as string | null) ?? null, "teacher");
  if (hatAway) redirect(hatAway);

  const highlight = topicParam(params.topic);
  const dict = await dictP;
  const t = dict.kits;
  const tLib: LibraryMessages = { ...dict.library, common: dict.common, utils: dict.utils };

  const { data: allowanceRaw, error: allowanceError } = await allowanceP;
  const allowance = (allowanceRaw as Allowance | null) ?? null;

  after(async () => {
    try {
      await createAdminClient().from("catalogue_events").insert({
        user_id: user.id,
        topic_id: null,
        event: "view",
        meta: {
          eligible: allowance?.eligible === true,
          reason: allowanceError ? "error" : (allowance?.reason ?? null),
          ...(highlight ? { topic: highlight } : {}),
        },
      });
    } catch {
      // the funnel misses one view; the page is unaffected
    }
  });

  const shell = (body: React.ReactNode) => (
    <>
      <AppHeader />
      <main className="max-w-7xl mx-auto px-6 py-10">
        <h1 className="text-4xl mb-2">{t.title}</h1>
        <InkUnderline className="block h-3 w-28 mb-3" />
        <p className="text-[#5B6470] mb-7 max-w-3xl">{t.subtitle}</p>
        {body}
      </main>
    </>
  );

  if (allowanceError || !allowance) return shell(<Notice title={t.title} body={t.unavailable} />);
  if (!allowance.eligible) {
    const reason = allowance.reason;
    if (reason === "coming_soon")
      return shell(<Notice title={t.comingSoonTitle} body={t.comingSoonBody} cta={{ href: PUBLIC_TOPICS_URL, label: t.browsePublic }} />);
    if (reason === "forbidden_role") return shell(<Notice title={t.title} body={t.ineligibleRole} />);
    if (reason === "suspended") return shell(<Notice title={t.title} body={t.ineligibleSuspended} />);
    return shell(<Notice title={t.title} body={t.ineligibleOther} />);
  }

  const dateFmt = new Intl.DateTimeFormat(htmlLang(locale), { day: "numeric", month: "short" });
  const resetsLabel = dateFmt.format(new Date(allowance.resets_at));
  const canUnlock = canUnlockMore(allowance);

  // One line, not a card: "3 of 5 this week · resets Mon 20 Oct", or the
  // unlimited sentence. The pricing link rides beside it for personal tiers.
  const allowanceLine =
    allowance.cap === null
      ? t.allowanceUnlimited
      : canUnlock
        ? fmt(t.allowanceLine, { used: allowance.used, cap: allowance.cap, date: resetsLabel })
        : fmt(t.allowanceSpent, { date: resetsLabel });
  const upgradeHref = showsUpgrade(allowance) ? PRICING_URL : null;

  return shell(
    <>
      {/* SK's tour anchor: rendered with the page, never behind the Suspense. */}
      <p className="text-xs text-[#5B6470] mb-5 flex flex-wrap items-center gap-x-3" data-tour="kits-allowance">
        <span className="tabular">{allowanceLine}</span>
        {upgradeHref && (
          <a href={upgradeHref} target="_blank" rel="noreferrer" className="font-medium text-[#0C8175] hover:underline">
            {t.upgradeCta}
          </a>
        )}
      </p>
      <Suspense fallback={<Pending />}>
        <KitsSection catalogueP={catalogueP} targetsP={targetsP} canUnlock={canUnlock} resetsLabel={resetsLabel} highlight={highlight} childFallback={dict.school.fallback.child} t={t} tLib={tLib} />
      </Suspense>
    </>,
  );
}

/** A started read that the page awaits later. Marked handled so a branch that
 * never awaits it (a redirect, an ineligible viewer) leaves no unhandled
 * rejection behind; whoever awaits it still sees the real error. Supabase
 * builders are lazy thenables — Promise.resolve() is what sends them. */
function started<T>(p: PromiseLike<T>): Promise<T> {
  const q = Promise.resolve(p);
  q.catch(() => {});
  return q;
}

/** The kits, joined: null when the catalogue cannot be read (the page says
 * "unavailable"). The private ids come through the service role:
 * catalogue_current_kits() and the kit rows are internal (0128 grants them to
 * service_role only) — nothing from here reaches the browser but the ids the
 * buttons need. */
async function readCatalogue(supabase: Db): Promise<Kit[] | null> {
  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return null;
  }
  const [{ data: pubRaw, error: pubError }, { data: curRaw, error: curError }, { data: unlocksRaw }] = await Promise.all([
    supabase.rpc("public_catalogue"),
    admin.rpc("catalogue_current_kits"),
    supabase.from("catalogue_unlocks").select("topic_id, unlocked_at"),
  ]);
  if (pubError || curError) return null;
  const current = (curRaw ?? []) as CurrentKitRow[];
  const topicIds = [...new Set(current.map((c) => c.topic_id))];
  const kitIds = current.map((c) => c.topic_kit_id);
  const [{ data: topicsRaw }, { data: kitsRaw }] = topicIds.length
    ? await Promise.all([
        admin.from("topics").select("id, slug").in("id", topicIds),
        admin.from("topic_kits").select("id, presentation_generation_id, doc_generation_ids").in("id", kitIds),
      ])
    : [{ data: [] }, { data: [] }];
  return buildKits(
    (pubRaw ?? []) as PublicRow[],
    current,
    (topicsRaw ?? []) as TopicRow[],
    (kitsRaw ?? []) as TopicKitRow[],
    (unlocksRaw ?? []) as UnlockRow[],
  );
}

/** Assignment targets, exactly as the Library resolves them: a teacher's own
 * classes, or a parent's linked children (named learners, not a register).
 * The child's fallback name is filled in by the section (it needs the words). */
async function assignTargets(
  supabase: Db,
  role: string | null,
  userId: string,
): Promise<{ classes: ClassRow[]; children: Array<{ id: string; name: string | null }> | null }> {
  type ChildLinkJoin = { child_id: string; profiles: { full_name: string | null; username: string | null } | null };
  if (role === "parent") {
    const links = ((await supabase.from("parent_links").select("child_id, profiles:child_id(full_name, username)")).data ?? []) as unknown as ChildLinkJoin[];
    return { classes: [], children: links.map((l) => ({ id: l.child_id, name: l.profiles?.full_name || l.profiles?.username || null })) };
  }
  const classes = ((await supabase.from("classes").select("id, name, grade").eq("teacher_id", userId).order("created_at", { ascending: false })).data ??
    []) as ClassRow[];
  return { classes, children: null };
}

/** The gallery, once the catalogue has landed. */
async function KitsSection({
  catalogueP,
  targetsP,
  canUnlock,
  resetsLabel,
  highlight,
  childFallback,
  t,
  tLib,
}: {
  catalogueP: Promise<Kit[] | null>;
  targetsP: ReturnType<typeof assignTargets>;
  canUnlock: boolean;
  resetsLabel: string;
  highlight: string | null;
  /** a linked child with no name yet */
  childFallback: string;
  t: KitsMessages;
  tLib: LibraryMessages;
}) {
  const [kits, targets] = await Promise.all([catalogueP, targetsP]);
  if (!kits) return <Notice title={t.title} body={t.unavailable} />;
  const childTargets: ChildRow[] | null = targets.children ? targets.children.map((c) => ({ id: c.id, name: c.name || childFallback })) : null;

  // Only what a card cannot derive (logic.ts derives the rest in the browser).
  const views: KitView[] = kits.map((k) => ({
    topicId: k.topicId,
    kitId: k.kitId,
    slug: k.slug,
    title: k.title,
    subject: k.subject,
    language: k.language,
    youtubeId: k.youtubeId,
    // EVERY kit plays its stored MP4 in-app (founder 2026-10-30: quality
    // first), through the same route as the documents, without the unlock
    // (logic.ts WATCH_KINDS); YouTube is the card's fallback only
    videoGenerationId: k.videoGenerationId,
    questionCount: k.questionCount,
    unlocked: k.unlocked,
    pieces: k.pieces.map((p) => ({ kind: p.kind, generationId: p.generationId })),
  }));

  return (
    <KitsGallery
      kits={views}
      canUnlock={canUnlock}
      resetsLabel={resetsLabel}
      highlight={highlight}
      classes={targets.classes}
      childTargets={childTargets}
      t={t}
      tLib={tLib}
    />
  );
}

function Notice({ title, body, cta }: { title: string; body: string; cta?: { href: string; label: string } }) {
  return (
    <section className="card px-6 py-6 max-w-2xl">
      <h2 className="text-xl mb-2">{title}</h2>
      <p className="text-sm text-[#5B6470]">{body}</p>
      {cta && (
        <a href={cta.href} target="_blank" rel="noreferrer" className="inline-flex mt-4 rounded-lg bg-[#0C8175] px-3.5 py-2 text-sm font-medium text-white hover:bg-[#0A6F65]">
          {cta.label}
        </a>
      )}
    </section>
  );
}

/** The gallery's fallback. Light on purpose: no data, no anchors — "busy" for
 * SK's walkthrough (aria-busy, data-loading, data-sk-loading) and a row of
 * card-sized pulse blocks so the page does not jump when the gallery lands. */
function Pending() {
  return (
    <div aria-busy="true" data-loading="" data-sk-loading="" className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="animate-pulse h-64 rounded-xl bg-[#F0F2EE]" />
      ))}
    </div>
  );
}
