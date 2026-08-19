// Claim-on-sign-in: bind any Lemon Squeezy purchase that was bought from the
// public pricing page (parked "unclaimed" by the buyer's email) to the account
// holder once they are authenticated with that same VERIFIED email — and only
// then create the entitlement that grants access (subscriptions), or record the
// revenue (credit packs).
//
// SECURITY: the caller MUST pass the Supabase-verified session email (never a
// value from the request body). A buyer can type any email at LS checkout, so
// binding happens only when the real account holder proves control of the email
// by signing in with it. Emails are stored lower-cased on both sides, so this is
// an exact match — no wildcard/ilike surprises.
//
// WHY THE PACK REVENUE ROW IS WRITTEN HERE AND NOT IN THE WEBHOOK (2026-08-19).
// payments.user_id is NOT NULL, so handlers.ts can only write the revenue row
// when the buyer is already bound at webhook time. It assumed that was the
// normal case ("packs are sold from inside the app to signed-in paid users") —
// that assumption was FALSE. The in-app buy chip (dashboard/fair-use-meter.tsx)
// is a plain <a href> to the LS hosted checkout carrying no custom_data, so the
// webhook has nothing but a buyer-typed email and PARKED IS THE ONLY PATH A
// PACK CAN TAKE. Every pack ever sold was therefore missing from the console's
// "Collected to date". The bind below is the first moment a user_id exists for
// that order, so it is the only place the payments row can be written.
// Migration 0092 backfills the sales that predate this.
//
// PRECEDENCE: credits before revenue, always. The bind is committed before any
// payments work starts, and every payments failure is logged and swallowed — a
// buyer must keep what they paid for even if the bookkeeping row is lost, and
// 0092's backfill is re-runnable to repair exactly that.
//
// DEPLOY ORDER: 0092 BEFORE this code. The bind reads three columns 0092 adds
// (total_minor, total_currency, order_status). If this ships first that read
// fails, and the fallback in bindParkedPacks deliberately keeps the CREDITS
// flowing on the old blind UPDATE while the revenue row waits for the migration
// — degraded and loud in the logs, never a buyer paying for nothing.

import { createAdminClient } from "@/utils/supabase/admin";
import { CREDIT_PACKS } from "@/utils/billing/packs";
import { lsActiveFromStored } from "./handlers";

type ClaimError = { code?: string; message: string };

// Minimal shape of the (Supabase) query client we use — injectable for tests.
type ClaimFilter<T> = {
  eq(col: string, v: unknown): ClaimFilter<T>;
  is(col: string, v: unknown): ClaimFilter<T>;
} & PromiseLike<T>;
// An UPDATE chain. Chaining .select() switches supabase-js from
// `Prefer: return=minimal` to `return=representation`, so postgres hands back
// the rows the statement ACTUALLY matched — the mechanism bindParkedPacks needs
// to know what it bound. Awaiting the chain WITHOUT .select() keeps the
// error-only shape (the subscriptions bind below).
type ClaimUpdate = {
  eq(col: string, v: unknown): ClaimUpdate;
  is(col: string, v: unknown): ClaimUpdate;
  select(cols: string): ClaimFilter<{ data: Record<string, unknown>[] | null; error: ClaimError | null }>;
} & PromiseLike<{ error: ClaimError | null }>;
export type ClaimDb = {
  from(table: string): {
    select(cols: string): ClaimFilter<{ data: Record<string, unknown>[] | null; error?: ClaimError | null }>;
    update(row: Record<string, unknown>): ClaimUpdate;
    upsert(row: Record<string, unknown>, opts?: { onConflict?: string }): PromiseLike<{ error: { message: string } | null }>;
    // A 23505 here is a NORMAL outcome, not a failure (see recordPackRevenue),
    // so the error carries its `code` — the same shape the webhook's Db uses.
    insert(row: Record<string, unknown>): PromiseLike<{ error: ClaimError | null }>;
  };
};

type ParkedSub = {
  ls_subscription_id: string;
  plan_key: string | null;
  status: string | null;
  current_period_end: string | null;
};

type ParkedPack = {
  ls_order_id: string | null;
  pack_key: string | null;
  /** `numeric(8,2)` LIST price — see packAmountMinor: postgres hands numerics
   * over as STRINGS, and list is not necessarily what was charged. */
  usd: number | string | null;
  /** 0092: what LS actually COLLECTED, in minor units of total_currency. */
  total_minor: number | string | null;
  /** 0092: the currency those minor units are denominated in (lower-cased). */
  total_currency: string | null;
  /** 0092: LS's own order status — usually "paid", but the delayed payment
   * methods deliver "pending", which must not be booked as collected. */
  order_status: string | null;
  refunded_at: string | null;
  /** The PURCHASE date. payments is a time series and a pack can be claimed
   * months after it was bought — see recordPackRevenue. */
  created_at: string | null;
};

/** Everything the revenue row needs, read back FROM THE BIND (bindParkedPacks).
 * Three of these columns arrive with 0092, which is exactly why the probe that
 * runs first names none of them. */
const PACK_REVENUE_COLS = "ls_order_id, pack_key, usd, total_minor, total_currency, order_status, refunded_at, created_at";

/** Caller entry point — creates the service-role client and reconciles. */
export async function claimLsPurchases(userId: string | null | undefined, verifiedEmail: string | null | undefined): Promise<number> {
  let db: ClaimDb;
  try {
    db = createAdminClient() as unknown as ClaimDb;
  } catch (e) {
    // createAdminClient() THROWS on a missing SUPABASE_SERVICE_ROLE_KEY, and
    // this function is no longer route-only: dashboard/layout.tsx calls it
    // during a PAGE RENDER, where an escaping throw blanks the dashboard for
    // every adult. The "never throws" contract has to start at the very first
    // statement, not inside claimLsPurchasesWith's try.
    console.error("billing.ls.claim_client_failed", { user: userId, err: (e as Error).message });
    return 0;
  }
  try {
    return await claimLsPurchasesWith(db, userId, verifiedEmail);
  } catch (e) {
    // The contract's LAST NET. Everything below is written to be total, so
    // reaching here means a later edit broke that — and on a render path the
    // way you find out is a blank dashboard for every adult. Its own log key,
    // precisely so "this cannot happen" is visible when it does.
    console.error("billing.ls.claim_unhandled", { user: userId, err: (e as Error).message });
    return 0;
  }
}

function toNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Is the stamped charge denominated in the one currency a payments row can
 * hold for an LS sale? A missing currency means "not stamped" (pre-0092), which
 * for this USD-priced catalogue reads as USD. */
function usdCharge(p: ParkedPack): boolean {
  return (p.total_currency ?? "usd").toLowerCase() === "usd";
}

/** What to book for this pack, in the MINOR UNITS payments.amount stores.
 *
 * WHY NOT SIMPLY `usd`. credit_purchases.usd is the CATALOGUE list price — 0086
 * annotates it "display/reconciliation only" — a TS constant (packs.ts) copied
 * in by the webhook, so it cannot see a discount code. LS's `total` is what the
 * buyer was actually charged, and it is what the webhook's OWN payments row
 * uses (handlers.ts). Pricing the two writers from two different definitions of
 * "the amount" would make "Collected to date" a single series built out of two
 * incompatible numbers, so the collected total (0092's total_minor) wins
 * wherever the webhook stamped it, and the catalogue is the fallback for the
 * sales that predate that column.
 *
 * TAX, stated plainly because this is easy to misread as "net revenue": LS is
 * Merchant of Record, so `total` can include VAT the business never keeps. Both
 * writers now share that definition — the invariant this function exists to
 * protect — but netting tax out is a console-side decision, not a reason to
 * fork the two paths.
 *
 * CURRENCY: payments_currency_check (0023) admits only 'myr' and 'usd', so a
 * charge denominated in anything else cannot be recorded faithfully. Booking
 * foreign minor units as dollars would be worse than booking list, so that case
 * falls back and the caller logs it.
 *
 * numeric(8,2) arrives as a STRING ("8.00") — PostgREST serialises postgres
 * numerics as text to protect precision, so `usd * 100` on the raw value is a
 * trap (string coercion, or NaN). Returns null when there is no usable price at
 * all: an invented amount would silently corrupt the console's revenue total,
 * so the caller logs and skips instead. */
function packAmountMinor(p: ParkedPack): number | null {
  const charged = toNumber(p.total_minor);
  if (charged !== null && usdCharge(p)) return Math.round(charged);
  const list = toNumber(p.usd);
  if (list !== null) return Math.round(list * 100);
  const pack = CREDIT_PACKS.find((x) => x.key === p.pack_key);
  return pack ? Math.round(pack.usd * 100) : null;
}

/** One payments row per pack we just bound, mirroring field-for-field the shape
 * the webhook writes so the console reads one consistent revenue series
 * regardless of which path recorded the sale. Never throws; each row is
 * independent, so one bad pack cannot cost the others their record. */
async function recordPackRevenue(db: ClaimDb, userId: string, packs: ParkedPack[]): Promise<void> {
  for (const p of packs) {
    // A refund already voided this pack's contribution to the balance; it must
    // not read as collected revenue either. (handlers.ts's refund path stamps
    // payments.status='refunded' on a row that exists — for a pack refunded
    // while still parked, NO row is the correct answer, not a refunded one.)
    // This reads refunded_at as of THE BIND, not as of an earlier probe: a
    // refund landing mid-claim slipped through the stale snapshot and left a
    // 'paid' row for returned money that nothing afterwards would correct.
    if (p.refunded_at) continue;
    // No ls_order_id means no idempotency key: payments_ls_order_uq is a plain
    // unique index on that column and postgres treats NULLs as distinct, so an
    // insert here could duplicate on a re-claim. Every LS-written pack carries
    // one; anything else is a manual row and stays out of the revenue total.
    if (!p.ls_order_id) {
      console.warn("billing.ls.pack_payment_skipped_no_order", { user: userId, pack: p.pack_key });
      continue;
    }
    if (p.total_minor != null && !usdCharge(p)) {
      // Recorded at list price below. Surfaced because it is the one case where
      // the figure in the console is knowably not the figure LS collected.
      console.warn("billing.ls.pack_payment_foreign_currency", { user: userId, order: p.ls_order_id, currency: p.total_currency });
    }
    const amount = packAmountMinor(p);
    if (amount === null) {
      console.warn("billing.ls.pack_payment_skipped_no_price", { user: userId, order: p.ls_order_id, pack: p.pack_key });
      continue;
    }
    const { error } = await db.from("payments").insert({
      user_id: userId, // the whole reason this row has to wait for the claim
      school_id: null, // LS packs are personal (B2C) — never school-scoped
      provider: "lemonsqueezy",
      ls_order_id: p.ls_order_id,
      amount, // MINOR UNITS
      // Packs are a USD-priced catalogue (packs.ts `usd`) and the webhook
      // lower-cases LS's currency; a charge stamped in any other currency was
      // rejected by packAmountMinor above and is booked in USD at list.
      currency: "usd",
      plan_key: p.pack_key,
      // Mirrors the webhook's `attrs.status ?? "paid"` instead of asserting
      // "paid": LS's delayed payment methods can deliver an order as "pending",
      // and collectedUsd() (utils/financials.ts) counts only PAID_STATUSES — so
      // hard-coding here would book money that was never collected, with no
      // later event to correct it if that order ends up failing.
      status: p.order_status ?? "paid",
      // Dated to the PURCHASE, exactly as 0092's backfill dates its rows. A
      // pack can be claimed months after it was bought and "Collected to date"
      // is a time series: defaulting to now() would move real revenue into the
      // month the buyer happened to next sign in, and would make the backfilled
      // rows and the go-forward rows two different facts. Omitted rather than
      // nulled when absent — payments.created_at is NOT NULL with a default.
      ...(p.created_at ? { created_at: p.created_at } : {}),
    });
    if (!error) continue;
    if (error.code === "23505") {
      // Already recorded — the webhook got there first (buyer bound at webhook
      // time), 0092's backfill did, or a second tab claimed the same rows
      // concurrently. The unique ls_order_id is exactly what makes that race
      // harmless: both sessions belong to the same verified email, so the row
      // they would each write is identical.
      continue;
    }
    // The credits are already bound and spendable. Revenue bookkeeping must
    // never be allowed to undo or block that — log loudly and carry on; 0092's
    // backfill re-runs to pick up whatever was missed here.
    console.warn("billing.ls.pack_payment_record_failed", { user: userId, order: p.ls_order_id, err: error.message });
  }
}

/** Bind every credit pack (0086) parked under this verified email, then record
 * each one's revenue. Returns how many parked packs were bound. Self-contained
 * and NON-THROWING so a pack problem can never cost the caller their
 * subscription claim. */
async function bindParkedPacks(db: ClaimDb, userId: string, email: string): Promise<number> {
  let bound: ParkedPack[] = [];
  let probed = 0;
  try {
    // PROBE, then bind. This runs on every dashboard render and the
    // overwhelmingly common answer is "nothing parked", so the cheap case has to
    // stay one index probe — credit_purchases_claim_idx (claim_email) WHERE
    // owner_id IS NULL — that returns nothing and writes nothing.
    //
    // It names only a column that has existed since 0086: the probe must never
    // be the thing that breaks while a later migration is still pending.
    const { data, error: readErr } = await db
      .from("credit_purchases")
      .select("ls_order_id")
      .is("owner_id", null)
      .eq("claim_email", email);
    if (readErr) {
      // A failed read is NOT "nothing parked". supabase-js resolves errors
      // rather than throwing them, so swallowing this would turn the one
      // remaining bind path into a silent no-op on every render — the same
      // shape of silent failure that hid this incident for every pack ever
      // sold. Log it, then fall through to the bind: "unknown" must mean "try",
      // never "skip".
      console.error("billing.ls.pack_read_failed", { user: userId, err: readErr.message });
    } else {
      probed = (data ?? []).length;
      if (probed === 0) return 0;
    }

    // ONE statement does the bind AND names the rows to bill for. .select() on
    // an UPDATE returns exactly the rows the statement matched, as of its own
    // snapshot, which closes two holes a separate read could not:
    //   · a pack that arrives (webhook) between the probe and the bind is bound
    //     by the claim_email predicate either way — taking the recordable set
    //     from a probe read BEFORE it dropped that sale's revenue row forever,
    //     because a bound row never matches `owner_id is null` again and 0092
    //     is a one-shot repair, not a sweep.
    //   · refunded_at is read post-bind, so a refund committed mid-claim is
    //     seen (recordPackRevenue skips it) instead of booking returned money.
    // Race-safe by the same `.is("owner_id", null)` predicate the probe used: a
    // concurrent claim can only take rows FROM us, never hand us someone
    // else's. Failing here leaves the pack parked and reclaimable next render.
    const { data: boundRows, error } = await db
      .from("credit_purchases")
      .update({ owner_id: userId, claim_email: null })
      .is("owner_id", null)
      .eq("claim_email", email)
      .select(PACK_REVENUE_COLS);
    if (error) {
      // CREDITS BEFORE REVENUE, enforced rather than assumed. The likeliest
      // cause is 0092 not yet applied (three of those columns are its), and the
      // buyer must not pay for a deploy-order mistake: re-run the bind BLIND —
      // the exact statement that shipped before the revenue row existed — and
      // let 0092's re-runnable backfill supply the bookkeeping afterwards.
      console.error("billing.ls.pack_bind_select_failed", { user: userId, err: error.message });
      const { error: blindErr } = await db
        .from("credit_purchases")
        .update({ owner_id: userId, claim_email: null })
        .is("owner_id", null)
        .eq("claim_email", email);
      if (blindErr) {
        console.error("billing.ls.pack_bind_failed", { user: userId, err: blindErr.message });
        return 0; // nothing bound => nothing to record
      }
      console.warn("billing.ls.packs_bound_without_revenue", { user: userId, count: probed });
      return probed;
    }
    bound = (boundRows ?? []) as ParkedPack[];
    if (bound.length === 0) return 0; // another tab got there first
  } catch (e) {
    console.error("billing.ls.pack_claim_failed", { user: userId, err: (e as Error).message });
    return 0;
  }

  // Strictly AFTER the bind is committed, and inside its own guard: the credits
  // are what the buyer paid for, the payments row is bookkeeping we can rebuild.
  try {
    await recordPackRevenue(db, userId, bound);
  } catch (e) {
    console.warn("billing.ls.pack_payment_record_failed", { user: userId, err: (e as Error).message });
  }
  console.log("billing.ls.packs_claimed", { user: userId, count: bound.length });
  return bound.length;
}

/** Testable core. Returns the number of SUBSCRIPTIONS claimed (0 when there is
 * nothing to do — the cheap common case; a pack-only claim rides along and is
 * deliberately not counted here, since the return value reports entitlement
 * grants, not credits). Never throws: reconciliation must not break sign-in, a
 * billing-status read, or a dashboard render. */
export async function claimLsPurchasesWith(db: ClaimDb, userId: string | null | undefined, verifiedEmail: string | null | undefined): Promise<number> {
  const email = (verifiedEmail ?? "").trim().toLowerCase();
  if (!userId || !email) return 0;

  // Credit packs (0086) park the same way subscriptions do — bind them FIRST,
  // and unconditionally: a pack is very often the ONLY thing parked, because
  // the in-app buy chip links straight to the LS hosted checkout. The balance
  // then surfaces through my_fair_use() with no entitlement needed.
  //
  // Deliberately OUTSIDE the try below — a pack problem must not cost the
  // subscription claim — and wrapped in one of its own: bindParkedPacks is
  // written to be total, but the caller is now a page render, so that guarantee
  // gets a belt as well as braces.
  let packsBound = 0;
  try {
    packsBound = await bindParkedPacks(db, userId, email);
  } catch (e) {
    console.error("billing.ls.pack_claim_failed", { user: userId, err: (e as Error).message });
  }

  try {
    const { data } = await db
      .from("subscriptions")
      .select("ls_subscription_id, plan_key, status, current_period_end")
      .eq("provider", "lemonsqueezy")
      .is("user_id", null)
      .eq("claim_email", email);
    const parked = (data ?? []) as ParkedSub[];

    // Bind the customer mapping (portal URL etc.). MOVED ABOVE the "no parked
    // subscriptions" early return on 2026-08-19: a pack-only buyer parks a
    // billing_customers row too, and returning first left them unmapped
    // forever — that row is how they reach their own LS receipts (an unmapped
    // buyer gets a 404 out of /api/billing/portal) and how resolveIdentity
    // recognises them on their NEXT purchase.
    //
    // WHY THE GATE IS SAFE, since it is what stops this from being self-healing:
    // an orphaned mapping can outlive a claim only if the purchase that created
    // it was bound by something OTHER than this function — which today means
    // the single row bound by hand during the incident. Every purchase that
    // parks from here on reaches this line with something parked, so the gate is
    // true exactly when a mapping needs binding. 0092 repairs the hand-bound
    // legacy rows in bulk, rather than making every no-op dashboard render pay
    // for a write to catch a state that no longer arises.
    if (packsBound > 0 || parked.length > 0) {
      await db
        .from("billing_customers")
        .update({ user_id: userId })
        .eq("provider", "lemonsqueezy")
        .is("user_id", null)
        .eq("email", email);
    }

    if (parked.length === 0) return 0;

    let claimed = 0;
    for (const s of parked) {
      // Race-safe: only take it if it's still unclaimed.
      const { error: subErr } = await db
        .from("subscriptions")
        .update({ user_id: userId, claim_email: null, updated_at: new Date().toISOString() })
        .eq("ls_subscription_id", s.ls_subscription_id)
        .is("user_id", null);
      if (subErr || !s.plan_key) continue;

      const active = lsActiveFromStored(s.status ?? "", s.current_period_end);
      const { error: entErr } = await db.from("entitlements").upsert(
        {
          user_id: userId,
          school_id: null, // personal (B2C) — never school-scoped
          provider: "lemonsqueezy",
          plan_key: s.plan_key,
          active,
          status: s.status,
          current_period_end: s.current_period_end,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,plan_key" },
      );
      if (!entErr) claimed++;
    }

    if (claimed > 0) console.log("billing.ls.claimed", { user: userId, count: claimed });
    return claimed;
  } catch (e) {
    console.error("billing.ls.claim_failed", { user: userId, err: (e as Error).message });
    return 0;
  }
}
