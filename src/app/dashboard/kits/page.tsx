import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import AppHeader from "../app-header";
import { InkUnderline } from "@/components/ink-mark";
import { catalogueTabEnabled } from "@/utils/flags";
import { enforceHat } from "@/utils/hats-server";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";
import { htmlLang } from "@/i18n/locales";
import { fmt } from "@/i18n/format";
import { kindLabel, type LibraryMessages } from "../labels";
import type { ChildRow, ClassRow } from "../assign-modal";
import KitsGallery, { type KitView, type PieceView } from "./kits-gallery";
import {
  buildKits,
  assignablePieces,
  canUnlockMore,
  showsUpgrade,
  topicParam,
  type Allowance,
  type CurrentKitRow,
  type PublicRow,
  type TopicKitRow,
  type TopicRow,
  type UnlockRow,
} from "./logic";

const PRICING_URL = "https://sketchcast.app/pricing";
const PUBLIC_TOPICS_URL = "https://sketchcast.app/topics";

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
export default async function KitsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!catalogueTabEnabled()) redirect("/dashboard");

  const locale = await resolveLocale();
  const dict = await getDictionary(locale);
  const t = dict.kits;
  const tLib: LibraryMessages = { ...dict.library, common: dict.common, utils: dict.utils };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase.from("profiles").select("role, school_id").eq("id", user.id).single();
  const role = (profile?.role as string | null) ?? null;
  if (role === "student") redirect("/dashboard");
  const hatAway = await enforceHat(supabase, role, (profile?.school_id as string | null) ?? null, "teacher");
  if (hatAway) redirect(hatAway);

  const highlight = topicParam((await searchParams).topic);

  const { data: allowanceRaw, error: allowanceError } = await supabase.rpc("my_catalogue_allowance");
  const allowance = (allowanceRaw as Allowance | null) ?? null;

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

  const notice = (title: string, bodyText: string, cta?: { href: string; label: string }) => (
    <section className="card px-6 py-6 max-w-2xl">
      <h2 className="text-xl mb-2">{title}</h2>
      <p className="text-sm text-[#5B6470]">{bodyText}</p>
      {cta && (
        <a href={cta.href} target="_blank" rel="noreferrer" className="inline-flex mt-4 rounded-lg bg-[#0C8175] px-3.5 py-2 text-sm font-medium text-white hover:bg-[#0A6F65]">
          {cta.label}
        </a>
      )}
    </section>
  );

  if (allowanceError || !allowance) return shell(notice(t.title, t.unavailable));
  if (!allowance.eligible) {
    const reason = allowance.reason;
    if (reason === "coming_soon")
      return shell(notice(t.comingSoonTitle, t.comingSoonBody, { href: PUBLIC_TOPICS_URL, label: t.browsePublic }));
    if (reason === "forbidden_role") return shell(notice(t.title, t.ineligibleRole));
    if (reason === "suspended") return shell(notice(t.title, t.ineligibleSuspended));
    return shell(notice(t.title, t.ineligibleOther));
  }

  // The private ids. Service role: catalogue_current_kits() and the kit rows
  // are internal (0128 grants them to service_role only) — nothing from here
  // reaches the browser but the ids the buttons need.
  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return shell(notice(t.title, t.unavailable));
  }
  const [{ data: pubRaw, error: pubError }, { data: curRaw, error: curError }, { data: unlocksRaw }] = await Promise.all([
    supabase.rpc("public_catalogue"),
    admin.rpc("catalogue_current_kits"),
    supabase.from("catalogue_unlocks").select("topic_id, unlocked_at"),
  ]);
  if (pubError || curError) return shell(notice(t.title, t.unavailable));
  const current = (curRaw ?? []) as CurrentKitRow[];
  const topicIds = [...new Set(current.map((c) => c.topic_id))];
  const kitIds = current.map((c) => c.topic_kit_id);
  const [{ data: topicsRaw }, { data: kitsRaw }] = topicIds.length
    ? await Promise.all([
        admin.from("topics").select("id, slug").in("id", topicIds),
        admin.from("topic_kits").select("id, presentation_generation_id, doc_generation_ids").in("id", kitIds),
      ])
    : [{ data: [] }, { data: [] }];

  const kits = buildKits(
    (pubRaw ?? []) as PublicRow[],
    current,
    (topicsRaw ?? []) as TopicRow[],
    (kitsRaw ?? []) as TopicKitRow[],
    (unlocksRaw ?? []) as UnlockRow[],
  );

  // Assignment targets, exactly as the Library resolves them: a teacher's own
  // classes, or a parent's linked children (named learners, not a register).
  type ChildLinkJoin = { child_id: string; profiles: { full_name: string | null; username: string | null } | null };
  const childTargets: ChildRow[] | null =
    role === "parent"
      ? (((await supabase.from("parent_links").select("child_id, profiles:child_id(full_name, username)")).data ?? []) as unknown as ChildLinkJoin[]).map(
          (l) => ({ id: l.child_id, name: l.profiles?.full_name || l.profiles?.username || dict.school.fallback.child }),
        )
      : null;
  const classes: ClassRow[] =
    role === "parent"
      ? []
      : (((await supabase.from("classes").select("id, name, grade").eq("teacher_id", user.id).order("created_at", { ascending: false })).data ??
          []) as ClassRow[]);

  const dateFmt = new Intl.DateTimeFormat(htmlLang(locale), { day: "numeric", month: "short" });
  const resetsLabel = dateFmt.format(new Date(allowance.resets_at));
  const canUnlock = canUnlockMore(allowance);

  const fileHref = (gen: string, kind: string) => `/api/catalogue/file?gen=${encodeURIComponent(gen)}&kind=${encodeURIComponent(kind)}`;
  /** Which files a piece offers: the deck its .pptx; a document its .docx and,
   * for the kinds that carry one, the answer key. The route refuses anything
   * else, so a kind not listed here simply has no link. */
  const downloadsFor = (kind: string, gen: string) => {
    if (kind === "presentation") return [];
    if (kind === "deck") return [{ label: t.download, href: fileHref(gen, "deck_pptx") }];
    const out = [{ label: t.download, href: fileHref(gen, "docx") }];
    if (kind === "worksheet" || kind === "quiz" || kind === "activity" || kind === "case_study" || kind === "question_bank")
      out.push({ label: t.answerKey, href: fileHref(gen, "answer_key_docx") });
    return out;
  };

  const views: KitView[] = kits.map((k) => ({
    topicId: k.topicId,
    kitId: k.kitId,
    slug: k.slug,
    title: k.title,
    subject: k.subject,
    language: k.language,
    youtubeId: k.youtubeId,
    // a kit with no public video (a translation) plays from storage: the
    // same route as the documents, without the unlock (logic.ts WATCH_KINDS)
    videoHref: k.youtubeId || !k.videoGenerationId ? null : fileHref(k.videoGenerationId, "video_mp4"),
    posterHref: k.youtubeId || !k.videoGenerationId ? null : fileHref(k.videoGenerationId, "thumbnail_png"),
    questionCount: k.questionCount,
    unlocked: k.unlocked,
    pieces: k.pieces.map(
      (p): PieceView => ({ kind: p.kind, generationId: p.generationId, label: kindLabel(tLib, p.kind), downloads: downloadsFor(p.kind, p.generationId) }),
    ),
    assignableIds: assignablePieces(k.pieces).map((p) => p.generationId),
  }));

  // One line, not a card: "3 of 5 this week · resets Mon 20 Oct", or the
  // unlimited sentence. The pricing link rides beside it for personal tiers.
  const allowanceLine =
    allowance.cap === null
      ? t.allowanceUnlimited
      : canUnlock
        ? fmt(t.allowanceLine, { used: allowance.used, cap: allowance.cap, date: resetsLabel })
        : fmt(t.allowanceSpent, { date: resetsLabel });

  return shell(
    <KitsGallery
      kits={views}
      canUnlock={canUnlock}
      allowanceLine={allowanceLine}
      upgradeHref={showsUpgrade(allowance) ? PRICING_URL : null}
      resetsLabel={resetsLabel}
      highlight={highlight}
      classes={classes}
      childTargets={childTargets}
      t={t}
      tLib={tLib}
    />,
  );
}
