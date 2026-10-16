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
import KitActions, { type PieceView } from "./kit-actions";
import {
  buildKits,
  assignablePieces,
  canUnlockMore,
  lessonPageUrl,
  showsUpgrade,
  topicParam,
  youtubeUrl,
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
    if (kind === "worksheet" || kind === "activity" || kind === "case_study") out.push({ label: t.answerKey, href: fileHref(gen, "answer_key_docx") });
    return out;
  };

  return shell(
    <>
      <section className="card px-5 py-3.5 mb-8 max-w-2xl border-[#BDE8E2] bg-[#F1FBF9]" data-tour="kits-allowance">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-[#0C8175]">{t.allowanceTitle}</span>
          {allowance.cap !== null && <span className="text-[10px] text-[#98A0A9]">{fmt(t.allowanceResets, { date: resetsLabel })}</span>}
        </div>
        {allowance.cap === null ? (
          <p className="text-sm mt-1">{t.allowanceUnlimited}</p>
        ) : (
          <>
            <p className="text-sm mt-1 tabular">{fmt(t.allowanceUsage, { used: allowance.used, cap: allowance.cap })}</p>
            {!canUnlock && <p className="text-xs text-[#5B6470] mt-1">{fmt(t.allowanceSpent, { date: resetsLabel })}</p>}
            {showsUpgrade(allowance) && (
              <a href={PRICING_URL} target="_blank" rel="noreferrer" className="inline-block mt-2 text-xs font-medium text-[#0C8175] hover:underline">
                {t.upgradeCta}
              </a>
            )}
          </>
        )}
      </section>

      {kits.length === 0 && <p className="text-sm text-[#5B6470]">{t.empty}</p>}

      <div className="grid gap-4 md:grid-cols-2">
        {kits.map((k) => {
          const pieces: PieceView[] = k.pieces.map((p) => ({
            kind: p.kind,
            generationId: p.generationId,
            label: kindLabel(tLib, p.kind),
            downloads: downloadsFor(p.kind, p.generationId),
          }));
          const isHighlighted = highlight !== null && k.slug === highlight;
          return (
            <article
              key={k.kitId}
              id={`kit-${k.slug}`}
              className={`card p-5 ${isHighlighted ? "ring-2 ring-[#0C8175]" : ""}`}
              data-topic={k.slug}
              data-unlocked={k.unlocked ? "true" : "false"}
            >
              {isHighlighted && <p className="text-xs font-medium text-[#0C8175] mb-2">{t.highlighted}</p>}
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs text-[#5B6470]">
                    {k.subject}
                    {k.language !== "en" ? ` · ${k.language.toUpperCase()}` : ""}
                  </p>
                  <h2 className="font-display text-xl leading-snug">{k.title}</h2>
                </div>
                {k.unlocked && <span className="shrink-0 text-xs font-medium rounded-full bg-[#E6F6F3] text-[#0C8175] px-2 py-0.5">{t.unlocked}</span>}
              </div>
              {k.summary && <p className="text-sm text-[#5B6470] mt-2 line-clamp-3">{k.summary}</p>}
              <p className="text-xs text-[#5B6470] mt-3 flex flex-wrap gap-x-3 gap-y-1">
                <span>{fmt(t.pieces, { n: k.pieces.length })}</span>
                {k.questionCount > 0 && <span>{fmt(t.questions, { n: k.questionCount })}</span>}
                {k.youtubeId && (
                  <a href={youtubeUrl(k.youtubeId)} target="_blank" rel="noreferrer" className="font-medium text-[#0C8175] hover:underline">
                    ▶ {t.watch}
                  </a>
                )}
                <a href={lessonPageUrl(k.slug)} target="_blank" rel="noreferrer" className="font-medium text-[#0C8175] hover:underline">
                  {t.lessonPage}
                </a>
              </p>
              <KitActions
                topicId={k.topicId}
                unlocked={k.unlocked}
                canUnlock={canUnlock}
                resetsLabel={resetsLabel}
                pieces={pieces}
                assignableIds={assignablePieces(k.pieces).map((p) => p.generationId)}
                classes={classes}
                childTargets={childTargets}
                t={t}
                tLib={tLib}
              />
            </article>
          );
        })}
      </div>
    </>,
  );
}
