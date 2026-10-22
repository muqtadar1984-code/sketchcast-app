import Link from "next/link";
import { createAdminClient } from "@/utils/supabase/admin";
import { InkUnderline } from "@/components/ink-mark";
import { finishRate, isoMinutesAgo } from "@/utils/queue-position";
import { bookGrid, byOwner, GRID_KINDS, summarise, type GenRow, type LiveJob } from "@/utils/console-queue";
import QueueActions from "./queue-actions";

// Live generation queue (surge plan §4.1). Who is waiting, how long their queue
// takes to drain at the measured rate, what is failing, and — per book — which
// kits are duplicates or ask for parts the book no longer has. Phase 2 adds the
// controls (queue-actions.tsx → /api/console/queue): pause/resume, cancel
// queued, stop running, cancel duplicates. They need migration 0153.

export const dynamic = "force-dynamic";

type JobRow = {
  id: string;
  type: string;
  status: "queued" | "processing";
  created_at: string;
  book_id: string | null;
  generations: { owner_id: string | null; book_id: string | null } | null;
};

type Timings = { phases?: Record<string, number> } | undefined;

const ago = (iso: string | null) => {
  if (!iso) return "—";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};
const dur = (min: number) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`);

export default async function ConsoleQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ owner?: string; book?: string }>;
}) {
  const { owner, book } = await searchParams;
  const admin = createAdminClient();
  const since30 = isoMinutesAgo(30);
  const since2h = isoMinutesAgo(120);

  const [{ data: liveRaw }, { data: errRaw }, { data: finRaw }] = await Promise.all([
    admin
      .from("jobs")
      .select("id, type, status, created_at, book_id, generations(owner_id, book_id)")
      .in("status", ["queued", "processing"])
      .limit(5000),
    admin
      .from("jobs")
      .select("generations(owner_id)")
      .eq("status", "error")
      .gte("updated_at", since2h)
      .limit(2000),
    admin
      .from("jobs")
      .select("status, generations(params)")
      .in("status", ["done", "error"])
      .gte("updated_at", since30)
      .limit(2000),
  ]);

  const live: LiveJob[] = ((liveRaw ?? []) as unknown as JobRow[]).map((j) => ({
    id: j.id,
    type: j.type,
    status: j.status,
    created_at: j.created_at,
    owner_id: j.generations?.owner_id ?? null,
    book_id: j.generations?.book_id ?? j.book_id,
  }));
  const errors2h = new Map<string, number>();
  for (const e of (errRaw ?? []) as unknown as { generations: { owner_id: string | null } | null }[]) {
    const id = e.generations?.owner_id;
    if (id) errors2h.set(id, (errors2h.get(id) ?? 0) + 1);
  }
  const finished = (finRaw ?? []) as unknown as { generations: { params: { timings?: Timings } | null } | null }[];
  const rate = finishRate(finished.length, 30);
  // Provider back-pressure over the same window: seconds builders spent
  // waiting on a lease, a cooldown or a rate limit (params.timings.phases).
  const pressure = { lease_wait: 0, cooldown_wait: 0, rate_limit_wait: 0 };
  for (const f of finished) {
    const ph = f.generations?.params?.timings?.phases ?? {};
    for (const k of Object.keys(pressure) as (keyof typeof pressure)[]) pressure[k] += Number(ph[k] ?? 0) || 0;
  }

  // Live holds (0153). Before the migration the table is absent: no holds.
  type Hold = { id: string; owner_id: string | null; book_id: string | null; reason: string | null; until: string; created_at: string };
  const { data: holdsRaw } = await admin
    .from("queue_holds")
    .select("id, owner_id, book_id, reason, until, created_at")
    .is("released_at", null)
    .gt("until", isoMinutesAgo(0))
    .limit(200);
  const holds = (holdsRaw ?? []) as Hold[];
  const ownerHeld = (id: string) => holds.some((h) => h.owner_id === id && !h.book_id);
  const bookHeld = (id: string) => holds.some((h) => h.book_id === id && !h.owner_id);

  const strip = summarise(live);
  let owners = byOwner(live, errors2h, rate);
  if (owner) owners = owners.filter((o) => o.ownerId === owner);

  const ownerIds = [
    ...new Set([...owners.map((o) => o.ownerId), ...holds.map((h) => h.owner_id ?? "system")]),
  ].filter((id) => id !== "system");
  const bookIds = [
    ...new Set([
      ...owners.flatMap((o) => o.books),
      ...(book ? [book] : []),
      ...holds.flatMap((h) => (h.book_id ? [h.book_id] : [])),
    ]),
  ];
  const [{ data: profs }, { data: books }] = await Promise.all([
    ownerIds.length
      ? admin.from("profiles").select("id, full_name, username").in("id", ownerIds)
      : Promise.resolve({ data: [] }),
    bookIds.length
      ? admin.from("books").select("id, title, chapters").in("id", bookIds)
      : Promise.resolve({ data: [] }),
  ]);
  const nameOf = new Map(
    ((profs ?? []) as { id: string; full_name: string | null; username: string | null }[]).map(
      (p) => [p.id, p.full_name || p.username || "User"] as const,
    ),
  );
  type BookRow = { id: string; title: string | null; chapters: { num?: unknown; title?: string; parts?: unknown[] }[] | null };
  const bookOf = new Map(((books ?? []) as BookRow[]).map((b) => [b.id, b] as const));

  // ── per-book grid (?book=) ──
  let grid: ReturnType<typeof bookGrid> | null = null;
  const focus = book ? bookOf.get(book) : undefined;
  if (book) {
    const { data: gens } = await admin
      .from("generations")
      .select("id, kind, status, chapter_ref, params, created_at")
      .eq("book_id", book)
      .is("removed_at", null)
      .order("created_at", { ascending: true })
      .limit(3000);
    const rows: GenRow[] = ((gens ?? []) as { id: string; kind: string; status: string; chapter_ref: string | null; params: { part?: unknown; revision?: unknown } | null; created_at: string }[])
      .filter((g) => g.params?.revision !== true && GRID_KINDS.includes(g.kind))
      .map((g) => ({
        id: g.id,
        kind: g.kind,
        status: g.status,
        chapter_ref: g.chapter_ref,
        part: typeof g.params?.part === "number" ? g.params.part : null,
        created_at: g.created_at,
      }));
    const partCounts = new Map<string, number>();
    for (const c of focus?.chapters ?? []) partCounts.set(String(c.num), Array.isArray(c.parts) ? c.parts.length : 0);
    grid = bookGrid(rows, partCounts);
  }
  const chapterTitle = (ref: string | null) =>
    ref === null ? "Book" : focus?.chapters?.find((c) => String(c.num) === ref)?.title ?? `Chapter ${Number(ref) + 1}`;

  const TONE: Record<string, string> = {
    queued: "bg-[#EEF0EC] text-[#5B6470]",
    processing: "bg-[#E2F4F1] text-[#0C8175]",
    done: "bg-[#E8F5E9] text-[#2E7D32]",
    error: "bg-[#FFE9E3] text-[#B3401F]",
  };

  return (
    <main className="max-w-7xl mx-auto px-6 py-10">
      <h1 className="text-4xl mb-2">Queue</h1>
      <InkUnderline className="block h-3 w-28 mb-3" />
      <p className="text-[#5B6470] mb-5">
        Live generation jobs. Cancels refund like the teacher&apos;s own ✕; Stop aborts running builds at their next
        stage; Pause holds a queue until you resume it (24 h at most).
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
        {[
          ["Queued", String(strip.queued)],
          ["Processing", String(strip.processing)],
          ["Owners waiting", String(strip.ownersWaiting)],
          ["Oldest queued", ago(strip.oldestQueuedAt)],
          ["Finished / min (30 min)", rate.toFixed(1)],
        ].map(([k, v]) => (
          <div key={k} className="card px-4 py-3">
            <div className="text-xs text-[#5B6470]">{k}</div>
            <div className="text-2xl tabular">{v}</div>
          </div>
        ))}
      </div>
      <p className="text-xs text-[#5B6470] mb-6">
        Provider back-pressure, last 30 min ({finished.length} finished): lease {Math.round(pressure.lease_wait / 60)} min ·
        cooldown {Math.round(pressure.cooldown_wait / 60)} min · rate limit {Math.round(pressure.rate_limit_wait / 60)} min
        {strip.byLane.length > 0 && (
          <>
            {" "}· lanes:{" "}
            {strip.byLane.map((l) => `${l.type} ${l.queued}/${l.processing}`).join(", ")}
          </>
        )}
      </p>

      {holds.length > 0 && (
        <div className="card px-5 py-3 mb-6 text-sm">
          <div className="font-medium mb-1">Paused queues ({holds.length})</div>
          {holds.map((h) => (
            <div key={h.id} className="text-[#5B6470]">
              {h.owner_id ? (nameOf.get(h.owner_id) ?? h.owner_id.slice(0, 8)) : "Any owner"}
              {h.book_id ? ` · ${bookOf.get(h.book_id)?.title ?? h.book_id.slice(0, 8)}` : ""} · until{" "}
              <span className="tabular">{new Date(h.until).toLocaleString()}</span>
              {h.reason ? ` · ${h.reason}` : ""}
            </div>
          ))}
        </div>
      )}

      {owner && (
        <p className="mb-3 text-sm">
          Filtered to one owner · <Link href="/console/queue" className="text-[#0C8175] hover:underline">show all</Link>
        </p>
      )}

      <div className="card overflow-x-auto mb-8">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-[#5B6470]">
            <tr>
              <th className="px-4 py-2">Owner</th>
              <th className="px-4 py-2">Queued</th>
              <th className="px-4 py-2">Processing</th>
              <th className="px-4 py-2">Errors (2 h)</th>
              <th className="px-4 py-2">Oldest queued</th>
              <th className="px-4 py-2">Est. drain</th>
              <th className="px-4 py-2">Books</th>
              <th className="px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#EEF0EC]">
            {owners.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-[#5B6470]">Nothing queued or failing. 🎉</td>
              </tr>
            )}
            {owners.map((o) => (
              <tr key={o.ownerId}>
                <td className="px-4 py-2">
                  {o.ownerId === "system" ? (
                    "System / catalogue"
                  ) : (
                    <Link href={`/console/users/${o.ownerId}`} className="text-[#0C8175] hover:underline">
                      {nameOf.get(o.ownerId) ?? o.ownerId.slice(0, 8)}
                    </Link>
                  )}
                </td>
                <td className="px-4 py-2 tabular">{o.queued}</td>
                <td className="px-4 py-2 tabular">{o.processing}</td>
                <td className={`px-4 py-2 tabular ${o.errors2h ? "text-[#B3401F]" : ""}`}>{o.errors2h}</td>
                <td className="px-4 py-2 tabular">{ago(o.oldestQueuedAt)}</td>
                <td className="px-4 py-2 tabular">{o.queued ? `~${dur(o.drainMin)}` : "—"}</td>
                <td className="px-4 py-2">
                  {o.books.map((b) => (
                    <Link key={b} href={`/console/queue?book=${b}${owner ? `&owner=${owner}` : ""}`} className="me-2 text-[#0C8175] hover:underline">
                      {bookOf.get(b)?.title ?? b.slice(0, 8)}
                    </Link>
                  ))}
                </td>
                <td className="px-4 py-2">
                  {o.ownerId !== "system" && (
                    <QueueActions ownerId={o.ownerId} held={ownerHeld(o.ownerId)} queued={o.queued} processing={o.processing} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {grid && (
        <section>
          <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
            <h2 className="font-display text-2xl">{focus?.title ?? "Book"}</h2>
            {book && (
              <QueueActions
                bookId={book}
                held={bookHeld(book)}
                queued={live.filter((j) => j.book_id === book && j.status === "queued").length}
                processing={live.filter((j) => j.book_id === book && j.status === "processing").length}
              />
            )}
          </div>
          <p className="text-sm text-[#5B6470] mb-3">
            Every kit on this book by chapter part. <span className="chip font-sans bg-[#FFF1D6] text-[#9A6400]">dup</span>{" "}
            = more than one non-failed kit for the same part and kind (a re-click).{" "}
            <span className="chip font-sans bg-[#FFE9E3] text-[#B3401F]">orphan</span> = a part the chapter no longer has
            (it can only fail).
          </p>
          <div className="card overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-[#5B6470]">
                <tr>
                  <th className="px-3 py-2">Unit</th>
                  {GRID_KINDS.map((k) => (
                    <th key={k} className="px-3 py-2">{k.replace("_", " ")}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EEF0EC]">
                {grid.map((u) => (
                  <tr key={`${u.chapterRef}:${u.part}`} className={u.orphan ? "bg-[#FFF6F3]" : ""}>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {chapterTitle(u.chapterRef)}
                      {u.part !== null ? ` · part ${u.part}` : ""}
                      {u.orphan && <span className="ms-2 chip font-sans bg-[#FFE9E3] text-[#B3401F]">orphan</span>}
                    </td>
                    {GRID_KINDS.map((k) => {
                      const c = u.cells.find((x) => x.kind === k);
                      return (
                        <td key={k} className="px-3 py-2 whitespace-nowrap">
                          {c?.rows.map((r) => (
                            <span key={r.id} className={`chip font-sans normal-case tracking-normal me-1 ${TONE[r.status] ?? ""}`} title={`${r.id} · ${r.created_at}`}>
                              {r.status}
                            </span>
                          ))}
                          {c?.duplicate && <span className="chip font-sans bg-[#FFF1D6] text-[#9A6400]">dup</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
