// Founding-teacher places — how many of the capped offer have been CLAIMED.
//
// WHAT IS ACTUALLY BEING COUNTED. "Founding Teacher" is not a product. It is a
// Lemon Squeezy DISCOUNT CODE (FOUNDINGTEACHER, $14 off Teacher Pro's $24 →
// $10/mo, repeating for 24 months) with `is_limited_redemptions = true` and
// `max_redemptions = 50`. LEMON SQUEEZY ITSELF ENFORCES THE CAP: the 51st
// teacher is refused at checkout by LS, not by us. That is why the pricing
// page's "Only the first 50 teachers" is a true statement of a mechanism and
// not an honour-system claim — and it is why LS's own redemption total, not our
// database, is the source of truth here.
//
// ── THE RULE THIS FILE EXISTS TO ENFORCE ────────────────────────────────────
// NO NUMBER IS EVER INVENTED. A scarcity counter on a paid-conversion page is
// the single easiest place in a product to start lying: a plausible-looking
// literal in the markup ("37 claimed") is invisible to every test and every
// reviewer, and it is fabricated evidence shown to a customer deciding whether
// to pay. So:
//   * the claimed count comes from LS, or from our own subscriptions table, or
//     it does not exist;
//   * `{ status: "unknown" }` carries NO claimed/max/remaining keys at all —
//     not zeroes, not nulls-that-render-as-zero. A consumer reading
//     `data.claimed` on an unknown response gets `undefined`, which fails every
//     `typeof x === "number"` guard, so the only way to display a number is to
//     have actually been given one;
//   * a partial answer is allowed (claimed without max), because "we know the
//     count but not the cap" is a true state; a guessed cap is not.
//
// ── WHY THE MAX IS READ FROM LS RATHER THAN WRITTEN HERE ────────────────────
// 50 is LS's number: it is the value LS enforces, and the moment the founder
// edits the discount in the LS dashboard, ours would be wrong. So this module
// holds no cap literal. It reports `max_redemptions` as LS states it, and only
// when `is_limited_redemptions` is true — an unlimited discount has no cap, and
// reporting one would manufacture scarcity that does not exist.
//
// ── WHY RAW fetch AND NOT @lemonsqueezy/lemonsqueezy.js ─────────────────────
// The rest of this folder uses the SDK (see orders.ts). This one does not, for
// one reason: the SDK exposes no AbortSignal and no timeout. This endpoint sits
// on a public marketing page, so a slow or hanging LS API must cost the reader
// a few hundred milliseconds and then degrade — never hold a function open
// until the platform kills it. `AbortSignal.timeout` needs the raw call.
//
// SERVER ONLY. LEMONSQUEEZY_API_KEY is read here and must never reach a client
// bundle; nothing in this file is importable from a Client Component.

import { createAdminClient } from "@/utils/supabase/admin";

const LS_API = "https://api.lemonsqueezy.com/v1";

/** How long a resolved answer is reused inside one warm server instance. See
 * the memo below — this is the *second* cache; the CDN in front of the route is
 * the first, and does the real work. */
const MEMO_OK_MS = 60_000;
/** An unknown answer is memoised far more briefly: caching a failure is how a
 * 30-second LS blip becomes a 10-minute blank counter. */
const MEMO_UNKNOWN_MS = 10_000;

/** Per-call network budget. Two LS calls share one signal, so this is the total
 * LS wall-clock, not per request. */
const LS_TIMEOUT_MS = 2_000;
const DB_TIMEOUT_MS = 2_000;

/** The public contract. `status` is the discriminant a consumer must branch on;
 * the numeric fields exist ONLY on "ok". */
export type FoundingPlaces =
  | {
      status: "ok";
      /** Places consumed. Always a non-negative integer. */
      claimed: number;
      /** The cap, as the system that enforces it states it — or null when that
       * system could not be reached (the DB fallback knows counts, not caps). */
      max: number | null;
      /** max - claimed, floored at 0; null exactly when max is null. */
      remaining: number | null;
      source: "lemonsqueezy" | "database";
      /** When this snapshot was taken, so a cached body is self-describing. */
      asOf: string;
    }
  | { status: "unknown" };

/** What a source can tell us: a count, and (LS only) the cap it enforces. */
export type FoundingSnapshot = { claimed: number; max: number | null };

/** The two sources, injectable so the resolution logic can be tested without a
 * network or a database — the same shape as handleLsEvent's `planKeyForVariant`
 * and claimLsPurchasesWith's `ClaimDb`. */
export type FoundingSources = {
  /** Lemon Squeezy: authoritative, because it is what enforces the cap. */
  ls: () => Promise<FoundingSnapshot | null>;
  /** Our own subscriptions table: a fallback count, never a cap. */
  db: () => Promise<number | null>;
  now?: () => Date;
};

/** A count is only usable if it is a real, non-negative whole number. Anything
 * else (NaN from a shape change, a float, a negative) is treated as source
 * failure — falling through to the next source is always better than printing
 * a number we cannot explain. */
function usableCount(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

/** THE RESOLUTION ORDER, and the whole of the decision this endpoint makes:
 *
 *   1. Lemon Squeezy — the system that enforces the cap. Gives claimed + max.
 *   2. our subscriptions table (`is_founding`) — gives claimed only.
 *   3. neither → "unknown", and the page keeps its static line.
 *
 * Note what step 2 is NOT: it is not a cross-check and not a maximum of the
 * two. The DB count is a PROXY (it counts founding subscriptions we recorded,
 * which can lag a redemption, and cannot see a redemption whose webhook we
 * missed), so mixing it into an LS answer would corrupt an exact number with an
 * approximate one. It is used only when the exact number is unavailable.
 *
 * Neither source may throw out of here: both are wrapped, because the only
 * acceptable failure mode on a marketing page is "no counter".
 */
export async function resolveFoundingPlacesWith(src: FoundingSources): Promise<FoundingPlaces> {
  const asOf = (src.now ? src.now() : new Date()).toISOString();

  const ls = await src.ls().catch(() => null);
  if (ls && usableCount(ls.claimed)) {
    // `ls.max >= ls.claimed` is a CONSISTENCY GATE, not defensiveness. The two
    // figures come from two independent LS fields, and the founder can lower
    // max_redemptions in the dashboard after redemptions have happened — which
    // yields a true pair (30 redeemed, cap now 25) that cannot be written as
    // one sentence without saying something absurd ("30 of 25 claimed"). When
    // they disagree we publish the count we measured and NO cap: a count
    // without a denominator is a smaller claim, and a smaller true claim beats
    // a bigger self-contradicting one.
    const max = usableCount(ls.max) && ls.max > 0 && ls.max >= ls.claimed ? ls.max : null;
    return {
      status: "ok",
      claimed: ls.claimed,
      max,
      remaining: max === null ? null : Math.max(0, max - ls.claimed),
      source: "lemonsqueezy",
      asOf,
    };
  }

  const dbCount = await src.db().catch(() => null);
  if (usableCount(dbCount)) {
    // No cap from this source, deliberately: the database has no idea what LS
    // is configured to allow, and the consumer's own published cap is a better
    // stand-in than anything we could infer here.
    return { status: "ok", claimed: dbCount, max: null, remaining: null, source: "database", asOf };
  }

  return { status: "unknown" };
}

/* ── the real sources ─────────────────────────────────────────────────────── */

type LsJson = Record<string, unknown>;

/** One authenticated LS GET. Returns null on ANY non-2xx, bad JSON, timeout or
 * transport error — callers distinguish "no data" from "data", never "why". */
async function lsGet(path: string, signal: AbortSignal): Promise<LsJson | null> {
  const key = process.env.LEMONSQUEEZY_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`${LS_API}${path}`, {
      method: "GET",
      headers: { Accept: "application/vnd.api+json", Authorization: `Bearer ${key}` },
      signal,
      // We do our own caching (memo below + CDN in front of the route). Letting
      // Next's data cache also hold this would give the counter a third, opaque
      // staleness window nobody can reason about.
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as LsJson;
  } catch {
    return null;
  }
}

function pick(obj: unknown, ...path: string[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** Ask Lemon Squeezy. Two calls, in parallel, sharing one timeout:
 *
 *   GET /discount-redemptions?filter[discount_id]=…  → meta.page.total = CLAIMED
 *   GET /discounts/{id}                              → max_redemptions = the CAP
 *
 * `page[size]=1` because we want the META, not the rows — the count lives in
 * the pagination block, so fetching one record is enough to be told the total.
 *
 * BOTH CALLS ARE REQUIRED, and the second one is the interesting half.
 *
 * A redemption total on its own is UNFALSIFIABLE: `filter[discount_id]` against
 * an id that no longer exists — a typo, a deleted discount, or (the one that
 * will actually happen) the TEST-MODE discount still configured after the store
 * goes live — returns `meta.page.total = 0`, which is indistinguishable from a
 * genuine "nobody has redeemed yet". Publishing that would put a confident,
 * measured-looking "0 of 50 claimed · 50 left" on the pricing page while real
 * teachers were consuming real places: not a fabricated number exactly, but a
 * measurement of the wrong thing, which reads identically to the reader and is
 * worse than showing nothing. So we require LS to CONFIRM THE DISCOUNT EXISTS
 * before we are willing to publish a count for it. If it does not, this returns
 * null and the resolver falls to the DB — which counts what our own webhooks
 * recorded and is therefore mode-agnostic — and then to "unknown".
 *
 * TEST MODE. LS keeps test-mode and live-mode objects as separate data sets, so
 * activating the store creates a NEW FOUNDINGTEACHER discount with a new id;
 * the old test-mode id keeps answering 0 forever. In production we refuse a
 * test-mode discount outright, because a test ledger is not the ledger the
 * offer is being sold from. Outside production we accept it, which is what lets
 * the whole path be exercised end to end before any money exists.
 */
export async function fetchLsFoundingSnapshot(timeoutMs = LS_TIMEOUT_MS): Promise<FoundingSnapshot | null> {
  const discountId = process.env.LEMONSQUEEZY_FOUNDING_DISCOUNT_ID;
  if (!discountId || !process.env.LEMONSQUEEZY_API_KEY) return null;
  const id = encodeURIComponent(discountId);

  // One signal for both: the reader waits for the pair, so the pair is what the
  // budget applies to.
  const signal = AbortSignal.timeout(timeoutMs);
  const [redemptions, discount] = await Promise.all([
    lsGet(`/discount-redemptions?filter[discount_id]=${id}&page[size]=1`, signal),
    lsGet(`/discounts/${id}`, signal),
  ]);

  // Proof of existence first. No attributes block → LS did not hand us this
  // discount (404, deleted, wrong id, or the call failed), so we have nothing
  // to attribute a redemption total to and we do not publish one.
  const attrs = pick(discount, "data", "attributes");
  if (!attrs || typeof attrs !== "object") return null;
  if (pick(attrs, "test_mode") === true && process.env.NODE_ENV === "production") return null;

  const claimed = pick(redemptions, "meta", "page", "total");
  if (!usableCount(claimed)) return null;

  // The cap is reported ONLY when LS says the discount is actually limited.
  // An unlimited discount has no "first 50" to be inside of.
  const limited = pick(attrs, "is_limited_redemptions") === true;
  const rawMax = pick(attrs, "max_redemptions");
  const max = limited && usableCount(rawMax) && rawMax > 0 ? rawMax : null;

  return { claimed, max };
}

/** The fallback count: rows in `subscriptions` flagged `is_founding` (0023).
 *
 * WHY NO STATUS FILTER. A place is consumed at REDEMPTION, and LS does not hand
 * it back when the teacher later cancels — so counting only active founding
 * subs would report more places free than LS will actually sell, i.e. it would
 * overstate availability. Counting every founding row is the closer proxy.
 *
 * It is still only a proxy, and knowingly so: it can lag a redemption by a
 * webhook, and it cannot see a redemption whose webhook we dropped. That is
 * exactly why it is second in line and never blended with the LS number.
 *
 * `head: true` with an exact count is a COUNT(*) — no rows cross the wire, and
 * nothing about any subscriber is read.
 */
export async function countFoundingSubscriptions(timeoutMs = DB_TIMEOUT_MS): Promise<number | null> {
  try {
    const admin = createAdminClient();
    const { count, error } = await admin
      .from("subscriptions")
      .select("id", { count: "exact", head: true })
      .eq("is_founding", true)
      .abortSignal(AbortSignal.timeout(timeoutMs));
    if (error) return null;
    return usableCount(count) ? count : null;
  } catch {
    return null;
  }
}

/* ── the memo ─────────────────────────────────────────────────────────────── */

let memo: { until: number; value: FoundingPlaces } | null = null;
/** The resolve that is happening RIGHT NOW, if one is. See the single-flight
 * note on resolveFoundingPlaces — this is the half of the memo that covers the
 * window the settled-value memo cannot see. */
let inflight: Promise<FoundingPlaces> | null = null;

/** Reset point for tests and for anything that needs a guaranteed-fresh read. */
export function clearFoundingPlacesMemo(): void {
  memo = null;
  inflight = null;
}

/** The wired resolver used by the route.
 *
 * TWO CACHES, DIFFERENT JOBS. The response carries `s-maxage`, so the CDN
 * answers essentially every reader without invoking this function at all — that
 * is the cache that protects the LS API from a marketing page's traffic. This
 * in-process memo is the backstop for the requests that DO reach the function:
 * a cold CDN, a per-origin cache shard, a cache-busting query string, an
 * uptime prober. Without it a single client looping with `?t=<random>` could
 * turn one public URL into an unbounded LS API amplifier.
 *
 * ⚠️ WHY THE PROMISE IS MEMOISED AND NOT JUST THE VALUE. Caching only the
 * settled value leaves the resolve window itself uncovered: for the ~2s an LS
 * round-trip may take, every arriving request sees an empty memo and starts its
 * OWN pair of LS calls. That window is trivially reachable from outside — a
 * distinct query string is a distinct CDN cache key, so `?t=1&t=2&…` fired
 * concurrently all miss the CDN and all land here — and the API key they would
 * hammer is the SAME key that createLsCheckout uses to open a paid checkout and
 * that the webhook uses to detect the founding cohort. LS rate-limits per key,
 * so an unauthenticated marketing endpoint must not be able to push it into
 * 429s and break real purchases. Storing the in-flight promise collapses any
 * number of concurrent callers onto one resolve, which turns the amplification
 * factor from "however many requests fit in 2 seconds" into 1.
 *
 * (This is per instance, and Vercel scales out; the CDN in front is what keeps
 * the number of instances that ever reach here small. Belt and braces, in that
 * order.)
 */
export async function resolveFoundingPlaces(): Promise<FoundingPlaces> {
  const now = Date.now();
  if (memo && memo.until > now) return memo.value;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const value = await resolveFoundingPlacesWith({
        ls: () => fetchLsFoundingSnapshot(),
        db: () => countFoundingSubscriptions(),
      });
      // Dated from COMPLETION, not from entry: the freshness window should not
      // be eaten by the round-trip that produced the value.
      memo = { until: Date.now() + (value.status === "ok" ? MEMO_OK_MS : MEMO_UNKNOWN_MS), value };
      return value;
    } finally {
      // Cleared on the throw path too, or one unexpected error would wedge the
      // endpoint on a permanently rejected promise.
      inflight = null;
    }
  })();
  return inflight;
}
