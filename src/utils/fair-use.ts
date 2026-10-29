// The fair-use meter's arithmetic, in a plain module so the Library's meter
// (fair-use-meter.tsx) and SK's lesson.prepare card (src/sk/capabilities/
// prepare.ts) read "how many credits can I spend right now" the SAME way.
// Moved out of fair-use-meter.tsx (S2 slice B) — never re-derive it elsewhere.

/** One pool of my_fair_use() (0047/0059): cap, carry-over, used, clamped available. */
export type FairUseBucket = { cap: number; carry: number; used: number; available: number };

/** The slice of my_fair_use()'s payload this module reads. */
export type FairUsePayload = {
  tier?: string;
  unlimited?: boolean;
  credits?: FairUseBucket;
  locked?: boolean;
  /** 0086: the purchased-pack balance — a number or a bucket. */
  purchased?: number | Partial<FairUseBucket>;
};

/** THE ONE PLACE THAT ANSWERS "how many more can I generate right now".
 *
 * IT REPRODUCES enforce_fair_use EXACTLY, and the subtlety it exists for is that
 * the RPC payload does NOT. my_fair_use() returns `greatest(0, c.available)`
 * (0086), while fair_use_avail computes available = cap + carry - used
 * UNCLAMPED (0059) and the trigger gates on that raw, possibly-NEGATIVE value:
 *   if a.available < 1 and a.available + fair_use_purchased_remaining(...) < 1
 * The value goes negative for real: a chapter lesson is charged WHOLE to
 * whichever pool had any room left (the bounded one-chapter overshoot 0047
 * accepted by design), so 11 used of a cap of 12 plus a four-part chapter leaves
 * used = 15 and a raw available of -3. Reading the clamped 0 and adding a 6-pack
 * would promise 6 more generations where the database admits 3. The overdraft
 * is a genuine claim on the purchased pool, so it is subtracted there.
 *
 * `used`, `cap` and `carry` all ride in the payload, so the raw figure is
 * reconstructible with no migration and no new RPC field. */
export function spendable(b: FairUseBucket, purchased: number) {
  const monthly = b.cap + b.carry; // this month's allowance, carry-over included
  const overdraft = Math.max(0, b.used - monthly); // already charged against the purchased pool
  const monthlyLeft = Math.max(0, monthly - b.used); // === b.available (the clamped figure)
  const purchasedLeft = Math.max(0, purchased - overdraft);
  return { monthly, monthlyLeft, purchasedLeft, total: monthlyLeft + purchasedLeft };
}

/** The purchased balance as my_fair_use() reports it (0 before 0086). */
export function purchasedOf(fu: FairUsePayload): number {
  if (typeof fu.purchased === "number") return fu.purchased;
  if (fu.purchased && typeof fu.purchased.available === "number") return fu.purchased.available;
  return 0;
}

/** Credits the account can spend now, or null when it is unmetered (schools,
 *  console-blessed) or the payload has no credits pool to read. A locked
 *  school (expired / suspended) can spend nothing. */
export function creditsLeftOf(fu: FairUsePayload | null | undefined): number | null {
  if (!fu || typeof fu !== "object" || fu.unlimited) return null;
  if (fu.locked) return 0;
  if (!fu.credits) return null;
  return spendable(fu.credits, purchasedOf(fu)).total;
}
