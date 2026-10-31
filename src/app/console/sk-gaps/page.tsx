import Link from "next/link";
import { createAdminClient } from "@/utils/supabase/admin";
import { InkUnderline } from "@/components/ink-mark";
import { SK_GAP_TEXT_DAYS } from "@/sk/gaps/store";
import { byWeight, EMPTY_STATS, themeStats, type GapCountRow } from "@/sk/gaps/stats";
import { addToSk, dismissGap, groupNow, markFixed, setThemeStatus } from "./actions";

// SK gaps: the turns where SK could not help, grouped nightly into themes
// (src/sk/gaps/group.ts, /api/sk/gaps/nightly). The founder decides per theme:
// Add to SK (files a platform_issues ticket), Won't do, Already possible (SK
// should have known — an instructions fix), Mark fixed, Reopen. The console
// layout is the staff gate for the page; every action re-checks it.

export const dynamic = "force-dynamic";
// "Group now" runs the grouping (one Haiku call) inside this page's function.
export const maxDuration = 300;

const STATUSES = ["open", "accepted", "already_possible", "wont_do", "fixed"] as const;
const LABEL: Record<string, string> = {
  open: "Open",
  accepted: "Added to SK",
  already_possible: "Already possible",
  wont_do: "Won't do",
  fixed: "Fixed",
};
const STATUS_TONE: Record<string, string> = {
  open: "bg-[#FFE9E3] text-[#B3401F]",
  accepted: "bg-[#E2F4F1] text-[#0C8175]",
  already_possible: "bg-[#FFF1D6] text-[#9A6400]",
  wont_do: "bg-[#EEF0EC] text-[#5B6470]",
  fixed: "bg-[#E3ECFF] text-[#2B4FA8]",
};
const SIGNAL_LABEL: Record<string, string> = {
  self: "SK said so",
  refusal: "refusal",
  tool_failed: "tool failed",
  grounding: "fact-check",
  phrase: "phrase",
  thumbs_down: "👎",
};
const SAMPLES = 10;
const UNGROUPED_SHOWN = 30;
const COUNT_PAGE = 1000;
const COUNT_PAGES = 20;

type ThemeRow = {
  id: string;
  title: string;
  summary: string | null;
  status: string;
  issue_id: string | null;
  fixed_pr: string | null;
  note: string | null;
  last_seen_at: string | null;
};
type SampleRow = {
  id: string;
  created_at: string;
  role: string | null;
  page: string | null;
  signal: string;
  question: string | null;
  reply: string | null;
  wanted: string | null;
  status: string;
  text_purged_at: string | null;
};

const when = (iso: string | null) => (iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "—");
const mix = (pairs: [string, number][], label: (k: string) => string = (k) => k) =>
  pairs.length ? pairs.map(([k, n]) => `${label(k)} ${n}`).join(" · ") : "—";

export default async function ConsoleSkGapsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; theme?: string; msg?: string }>;
}) {
  const sp = await searchParams;
  const status = sp.status === "all" || STATUSES.includes(sp.status as (typeof STATUSES)[number]) ? sp.status! : "open";
  const expanded = sp.theme ?? null;
  const admin = createAdminClient();
  const now = new Date();

  // Themes in this filter.
  let tq = admin
    .from("sk_gap_themes")
    .select("id, title, summary, status, issue_id, fixed_pr, note, last_seen_at")
    .order("last_seen_at", { ascending: false, nullsFirst: false })
    .limit(500);
  if (status !== "all") tq = tq.eq("status", status);
  const { data: themesRaw, error: themesErr } = await tq;
  const themesUnsorted = (themesRaw ?? []) as ThemeRow[];

  // How many themes per status (for the filter chips).
  const { data: allStatuses } = await admin.from("sk_gap_themes").select("status").limit(5000);
  const perStatus = new Map<string, number>();
  for (const r of (allStatuses ?? []) as { status: string }[]) perStatus.set(r.status, (perStatus.get(r.status) ?? 0) + 1);

  // Every grouped miss (light columns), paged past PostgREST's 1000-row cap,
  // for the distinct-turn counts. Dismissed misses never count.
  const countRows: GapCountRow[] = [];
  for (let page = 0; page < COUNT_PAGES; page++) {
    const { data } = await admin
      .from("sk_gaps")
      .select("theme_id, turn_id, role, signal, status, created_at")
      .eq("status", "grouped")
      .not("theme_id", "is", null)
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(page * COUNT_PAGE, (page + 1) * COUNT_PAGE - 1);
    const rows = (data ?? []) as GapCountRow[];
    countRows.push(...rows);
    if (rows.length < COUNT_PAGE) break;
  }
  const stats = themeStats(countRows, now);
  const themes = byWeight(themesUnsorted, stats);

  // Samples for the expanded theme.
  let samples: SampleRow[] = [];
  if (expanded && themes.some((t) => t.id === expanded)) {
    const { data } = await admin
      .from("sk_gaps")
      .select("id, created_at, role, page, signal, question, reply, wanted, status, text_purged_at")
      .eq("theme_id", expanded)
      .neq("status", "dismissed")
      .order("created_at", { ascending: false })
      .limit(SAMPLES);
    samples = (data ?? []) as SampleRow[];
  }

  // Ungrouped (new) misses.
  const { count: newCount } = await admin.from("sk_gaps").select("id", { count: "exact", head: true }).eq("status", "new");
  const { data: newRaw } = await admin
    .from("sk_gaps")
    .select("id, created_at, role, page, signal, question, reply, wanted, status, text_purged_at")
    .eq("status", "new")
    .order("created_at", { ascending: false })
    .limit(UNGROUPED_SHOWN);
  const fresh = (newRaw ?? []) as SampleRow[];

  const here = (extra: Record<string, string | null> = {}) => {
    const q = new URLSearchParams();
    if (status !== "open") q.set("status", status);
    for (const [k, v] of Object.entries(extra)) if (v) q.set(k, v);
    const s = q.toString();
    return `/console/sk-gaps${s ? `?${s}` : ""}`;
  };
  const backHere = here(expanded ? { theme: expanded } : {});

  const filters = [...STATUSES.map((s) => ({ key: s, label: `${LABEL[s]} (${perStatus.get(s) ?? 0})` })), { key: "all", label: "All" }];

  return (
    <main className="max-w-7xl mx-auto px-6 py-10">
      <h1 className="text-4xl mb-2">SK gaps</h1>
      <InkUnderline className="block h-3 w-28 mb-3" />
      <p className="text-[#5B6470] mb-5 max-w-3xl">
        Turns where SK could not help, grouped into themes every night at 20:00 UTC. Counts are distinct turns; dismissed
        misses do not count. Question text is cleared after {SK_GAP_TEXT_DAYS} days.
      </p>

      {sp.msg && <div className="card px-4 py-3 mb-5 text-sm text-[#0C8175]">{sp.msg.slice(0, 300)}</div>}
      {themesErr && <div className="card px-4 py-3 mb-5 text-sm text-red-600">Could not read themes: {themesErr.message}</div>}

      <div className="flex flex-wrap gap-2 mb-5">
        {filters.map((f) => (
          <Link
            key={f.key}
            href={f.key === "open" ? "/console/sk-gaps" : `/console/sk-gaps?status=${f.key}`}
            className={`chip font-sans normal-case tracking-normal ${
              status === f.key ? "bg-[#14181F] text-white" : "bg-[#EEF0EC] text-[#5B6470]"
            }`}
          >
            {f.label}
          </Link>
        ))}
      </div>

      {themes.length === 0 ? (
        <div className="card px-5 py-8 text-sm text-[#5B6470] mb-10">No themes here.</div>
      ) : (
        <div className="space-y-3 mb-10">
          {themes.map((t) => {
            const s = stats.get(t.id) ?? EMPTY_STATS;
            const open = expanded === t.id;
            const anchor = `t-${t.id}`;
            return (
              <section key={t.id} id={anchor} className="card px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="font-display font-medium text-lg leading-snug">{t.title}</h2>
                    {t.summary && <p className="text-sm text-[#5B6470] mt-1 max-w-3xl">{t.summary}</p>}
                  </div>
                  <span className={`chip font-sans normal-case tracking-normal shrink-0 ${STATUS_TONE[t.status] ?? ""}`}>
                    {LABEL[t.status] ?? t.status}
                  </span>
                </div>

                <div className="mt-2 text-sm">
                  <span className="font-medium tabular">{s.d30}</span> turns in 30 days ·{" "}
                  <span className="tabular">{s.d7}</span> in 7 days · <span className="tabular">{s.total}</span> in all ·
                  last seen <span className="tabular">{when(s.lastSeen ?? t.last_seen_at)}</span>
                </div>
                <div className="mt-1 text-xs text-[#5B6470]">
                  Roles: {mix(s.roles)} &nbsp;|&nbsp; Signals: {mix(s.signals, (k) => SIGNAL_LABEL[k] ?? k)}
                </div>
                {(t.issue_id || t.fixed_pr || t.note) && (
                  <div className="mt-1 text-xs text-[#5B6470] space-y-0.5">
                    {t.issue_id && (
                      <div>
                        Ticket:{" "}
                        <Link href={`/console/issues/${t.issue_id}`} className="underline text-[#0C8175]">
                          open in Issues
                        </Link>
                      </div>
                    )}
                    {t.fixed_pr && <div>Fixed by: {t.fixed_pr}</div>}
                    {t.note && <div className="whitespace-pre-line">Note: {t.note}</div>}
                  </div>
                )}

                <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                  <Link href={open ? `${here()}#${anchor}` : `${here({ theme: t.id })}#${anchor}`} className="btn-ghost h-8 px-3 inline-flex items-center">
                    {open ? "Hide samples" : "Show samples"}
                  </Link>
                  {t.status !== "accepted" && (
                    <ThemeButton action={addToSk} themeId={t.id} back={backHere} anchor={anchor} primary>
                      {t.issue_id ? "Add to SK (ticket exists)" : "Add to SK"}
                    </ThemeButton>
                  )}
                  {t.status !== "wont_do" && (
                    <ThemeButton action={setThemeStatus} themeId={t.id} back={backHere} anchor={anchor} status="wont_do">
                      Won&apos;t do
                    </ThemeButton>
                  )}
                  {t.status !== "already_possible" && (
                    <ThemeButton action={setThemeStatus} themeId={t.id} back={backHere} anchor={anchor} status="already_possible">
                      Already possible
                    </ThemeButton>
                  )}
                  {t.status !== "open" && (
                    <ThemeButton action={setThemeStatus} themeId={t.id} back={backHere} anchor={anchor} status="open">
                      Reopen
                    </ThemeButton>
                  )}
                  {t.status !== "fixed" && (
                    <form action={markFixed} className="flex items-center gap-1.5">
                      <input type="hidden" name="theme_id" value={t.id} />
                      <input type="hidden" name="back" value={backHere} />
                      <input type="hidden" name="anchor" value={anchor} />
                      <input name="fixed_pr" required maxLength={200} placeholder="PR / what fixed it" className="field h-8 px-2 w-44 text-sm" />
                      <button className="btn-ghost h-8 px-3">Mark fixed</button>
                    </form>
                  )}
                </div>

                {open && (
                  <div className="mt-4 border-t border-[#EEF0EC] pt-3">
                    {samples.length === 0 ? (
                      <p className="text-sm text-[#5B6470]">No samples (all dismissed?).</p>
                    ) : (
                      <ul className="divide-y divide-[#EEF0EC]">
                        {samples.map((g) => (
                          <GapItem key={g.id} g={g} back={backHere} anchor={anchor} />
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      <section>
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <h2 className="text-2xl">
            Ungrouped (new) <span className="text-[#5B6470] text-lg tabular">· {newCount ?? 0}</span>
          </h2>
          <form action={groupNow}>
            <input type="hidden" name="back" value={backHere} />
            <button className="btn-primary h-9 px-4" disabled={!newCount}>
              Group now
            </button>
          </form>
        </div>
        <p className="text-xs text-[#5B6470] mb-3">
          Group now runs the nightly grouping on demand: one Haiku 5.5 call over the oldest new misses (at most 300).
        </p>
        {fresh.length === 0 ? (
          <div className="card px-5 py-6 text-sm text-[#5B6470]">Nothing waiting.</div>
        ) : (
          <ul className="card divide-y divide-[#EEF0EC] px-5">
            {fresh.map((g) => (
              <GapItem key={g.id} g={g} back={backHere} />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function ThemeButton({
  action,
  themeId,
  back,
  anchor,
  status,
  primary,
  children,
}: {
  action: (fd: FormData) => Promise<void>;
  themeId: string;
  back: string;
  anchor: string;
  status?: string;
  primary?: boolean;
  children: React.ReactNode;
}) {
  return (
    <form action={action}>
      <input type="hidden" name="theme_id" value={themeId} />
      <input type="hidden" name="back" value={back} />
      <input type="hidden" name="anchor" value={anchor} />
      {status && <input type="hidden" name="status" value={status} />}
      <button className={primary ? "btn-primary h-8 px-3" : "btn-ghost h-8 px-3"}>{children}</button>
    </form>
  );
}

function GapItem({ g, back, anchor }: { g: SampleRow; back: string; anchor?: string }) {
  const purged = !!g.text_purged_at;
  return (
    <li className="py-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {purged ? (
            <p className="italic text-[#98A0A9]">Text cleared ({SK_GAP_TEXT_DAYS}-day limit).</p>
          ) : (
            <>
              <p className="font-medium whitespace-pre-line break-words">{g.question || <span className="italic text-[#98A0A9]">(no question text)</span>}</p>
              {g.reply && (
                <p className="mt-1 text-[#5B6470] break-words">
                  <span className="text-xs uppercase tracking-wide text-[#98A0A9]">SK: </span>
                  {g.reply}
                </p>
              )}
              {g.wanted && (
                <p className="mt-1 text-[#5B6470] break-words">
                  <span className="text-xs uppercase tracking-wide text-[#98A0A9]">Wanted: </span>
                  {g.wanted}
                </p>
              )}
            </>
          )}
          <p className="mt-1 text-xs text-[#5B6470]">
            {g.role ?? "unknown"} · {SIGNAL_LABEL[g.signal] ?? g.signal} · <span className="tabular">{when(g.created_at)}</span>
            {g.page && <> · <span className="break-all">{g.page}</span></>}
          </p>
        </div>
        <form action={dismissGap} className="shrink-0">
          <input type="hidden" name="gap_id" value={g.id} />
          <input type="hidden" name="back" value={back} />
          {anchor && <input type="hidden" name="anchor" value={anchor} />}
          <button className="btn-ghost h-7 px-2 text-xs">Dismiss</button>
        </form>
      </div>
    </li>
  );
}
