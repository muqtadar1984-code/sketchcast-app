import { NextResponse } from "next/server";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import {
  ESTIMATE_KINDS,
  WINDOW_DAYS,
  backloggedRates,
  type EstimateKind,
  type JobSample,
  type KindRate,
} from "@/utils/generate-all-estimate";

export const runtime = "nodejs";

// Everything the Generate all dialog asks before it queues (surge plan §3.2
// item 2): the book's kits as they stand NOW, how deep the queue is, how fast
// it drains, how many kits the caller made today, and whether the book is being
// re-indexed.
//
// The kit list is read fresh here, not taken from the page: the page is a
// snapshot from whenever it rendered, and the 2026-10-22 duplicates came from
// clicks on a stale one.
//
// The caller's own rows go through their session (RLS). Queue depth and drain
// rate are about OTHER people's jobs, which RLS rightly hides — they come from
// the admin client as counts and rates only; no other user's row leaves here.

type RateCache = { at: number; rates: Record<EstimateKind, KindRate> };
let rateCache: RateCache | null = null;
const RATE_TTL_MS = 10 * 60_000;

async function drainRates(admin: ReturnType<typeof createAdminClient>): Promise<Record<EstimateKind, KindRate>> {
  const now = Date.now();
  if (rateCache && now - rateCache.at < RATE_TTL_MS) return rateCache.rates;
  // One day of lead-in so a job queued before the window still marks the
  // buckets it waited through.
  const since = new Date(now - (WINDOW_DAYS + 1) * 24 * 60 * 60_000).toISOString();
  const jobs: JobSample[] = [];
  // PostgREST caps a response at 1000 rows; a busy week is a few thousand.
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin
      .from("jobs")
      .select("type, status, created_at, claimed_at, updated_at")
      .in("type", [...ESTIMATE_KINDS])
      .gte("created_at", since)
      .order("created_at", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    jobs.push(...((data ?? []) as JobSample[]));
    if (!data || data.length < 1000) break;
  }
  const rates = backloggedRates(jobs, new Date(now));
  rateCache = { at: now, rates };
  return rates;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  // The caller must be able to see the book — the same test the Library uses.
  const { data: book } = await supabase.from("books").select("id").eq("id", id).maybeSingle();
  if (!book) return NextResponse.json({ error: "Book not found." }, { status: 404 });

  const utcMidnight = new Date();
  utcMidnight.setUTCHours(0, 0, 0, 0);

  const admin = createAdminClient();
  const [existing, today, fairUse, indexing, queued, rates] = await Promise.all([
    supabase
      .from("generations")
      .select("kind, chapter_ref, status, params")
      .eq("book_id", id)
      .eq("owner_id", user.id)
      .in("kind", [...ESTIMATE_KINDS]),
    // A kit is its presentation: one per unit queued.
    supabase
      .from("generations")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", user.id)
      .eq("kind", "presentation")
      .gte("created_at", utcMidnight.toISOString()),
    supabase.rpc("my_fair_use"),
    // 0152 refuses inserts while this is in flight; the dialog says so first.
    admin
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("book_id", id)
      .eq("type", "index_book")
      .in("status", ["queued", "processing"]),
    // Counted per kind (head-only): a row list would stop at PostgREST's
    // 1000-row cap in exactly the burst this is for.
    Promise.all(
      ESTIMATE_KINDS.map((k) =>
        admin.from("jobs").select("id", { count: "exact", head: true }).eq("status", "queued").eq("type", k),
      ),
    ),
    drainRates(admin).catch(() => null),
  ]);
  if (existing.error) return NextResponse.json({ error: existing.error.message }, { status: 500 });

  const ahead: Partial<Record<EstimateKind, number>> = {};
  ESTIMATE_KINDS.forEach((k, i) => (ahead[k] = queued[i].count ?? 0));
  const queueFailed = queued.some((q) => q.error);

  const f = fairUse.data as { unlimited?: boolean } | null;
  return NextResponse.json({
    existing: existing.data ?? [],
    kitsToday: today.count ?? 0,
    unmetered: f?.unlimited === true,
    indexing: (indexing.count ?? 0) > 0,
    // Null when a query failed: the dialog then says it can't estimate rather
    // than showing a number it doesn't have.
    ahead: queueFailed ? null : ahead,
    rates,
  });
}
