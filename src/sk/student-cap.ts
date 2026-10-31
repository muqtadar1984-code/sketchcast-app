// The student fair-use cap on SK turns (SK student Board plan 2026-10-31,
// founder decision 4: "Unlimited, fair use. No count is shown; a hidden
// fair-use cap stops abuse").
//
// SK_STUDENT_DAILY_TURNS (default 300) Shell turns per student per UTC day.
// Over it, the turn route answers with SK's fixed "let's take a break" line
// (no model call) and logs ONE `sk-student.cap` line.
//
// NO NEW MIGRATION: the count rides in the EXISTING metering table, sk_usage
// (0158 — B8's per-turn metering: PK (user_id, product_id, period), service
// role writes, the student may read her own rows), under
//   product_id = SK_STUDENT_CAP_PRODUCT  (a fixed sentinel; product_id has no
//                foreign key — the book products' ids are uuids too, and none
//                is all zeros)
//   period     = "day:YYYY-MM-DD"        (UTC; never equal to a book's
//                monthly 'YYYY-MM', so no reader of those rows sees it)
// one `live_turns` per turn. Read-then-upsert, like store-supabase.ts
// bumpUsage: PostgREST cannot increment in place and B8 shipped no increment
// function, so two turns in the same instant can count once — harmless for a
// fair-use cap.
//
// FAILS OPEN: no service role, or a read/write error, lets the turn through
// (logged). A hidden fair-use cap must never be what stops a child learning
// when the database blips; the cap exists to stop abuse, not to meter.

export const SK_STUDENT_DAILY_TURNS_DEFAULT = 300;
/** The sentinel product id the daily student count is kept under (sk_usage). */
export const SK_STUDENT_CAP_PRODUCT = "00000000-0000-0000-0000-000000000000";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type CapDb = { from: (table: string) => any };
/* eslint-enable @typescript-eslint/no-explicit-any */

/** The cap from the environment: a positive integer, else the default. */
export function studentDailyCap(env: Record<string, string | undefined> = process.env): number {
  const raw = (env.SK_STUDENT_DAILY_TURNS ?? "").trim();
  const n = /^\d{1,6}$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : SK_STUDENT_DAILY_TURNS_DEFAULT;
}

/** The UTC day's period key: "day:2026-10-31". */
export function capPeriod(now: Date): string {
  return `day:${now.toISOString().slice(0, 10)}`;
}

export type CapOutcome = { ok: true; count: number; metered: boolean } | { ok: false; count: number; cap: number };

/**
 * Count this turn against today's cap. Over the cap → refused (and not
 * counted again); under → counted. Errors and a missing client fail open.
 */
export async function meterStudentTurn(db: CapDb | null, userId: string, now: Date = new Date(), cap: number = studentDailyCap()): Promise<CapOutcome> {
  if (!db || !userId) return { ok: true, count: 0, metered: false };
  const period = capPeriod(now);
  try {
    const { data, error } = await db
      .from("sk_usage")
      .select("live_turns, generated_segments, interactive_ms")
      .eq("user_id", userId)
      .eq("product_id", SK_STUDENT_CAP_PRODUCT)
      .eq("period", period)
      .maybeSingle();
    if (error) throw new Error(error.message ?? "read failed");
    const row = (data ?? null) as { live_turns?: number | null; generated_segments?: number | null; interactive_ms?: number | null } | null;
    const used = Math.max(0, Number(row?.live_turns ?? 0) || 0);
    if (used >= cap) return { ok: false, count: used, cap };
    const { error: wErr } = await db.from("sk_usage").upsert(
      {
        user_id: userId,
        product_id: SK_STUDENT_CAP_PRODUCT,
        period,
        live_turns: used + 1,
        generated_segments: Number(row?.generated_segments ?? 0) || 0,
        interactive_ms: Number(row?.interactive_ms ?? 0) || 0,
        updated_at: now.toISOString(),
      },
      { onConflict: "user_id,product_id,period" },
    );
    if (wErr) throw new Error(wErr.message ?? "write failed");
    return { ok: true, count: used + 1, metered: true };
  } catch (e) {
    console.warn("sk-student.cap meter failed (turn allowed)", e instanceof Error ? e.message : String(e));
    return { ok: true, count: 0, metered: false };
  }
}
