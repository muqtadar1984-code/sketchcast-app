/**
 * Parse-check for supabase/migrations/0093_subscription_revenue.sql — the
 * operator applies it by hand, so this is the only automated eye on the file.
 * It pins the promises that cost real money if they are ever edited away:
 *
 *  • THE REPAIR IS GENERAL, NOT A RECEIPT. Section 4 must identify a
 *    booked-gross row from evidence IN the row (credit_purchases.usd, the
 *    catalogue list price) and never from a hard-coded order id, amount or tax
 *    rate. The live numbers — 944, 800, 999, 1179, order 9261766 — belong in
 *    the prose and in the column comments; the instant one appears in an
 *    expression the migration stops repairing the NEXT sale.
 *  • IT CAN ONLY EVER REDUCE. `p.amount > cp.total_minor` is what keeps the
 *    three untaxed $8.00 rows at 800 while 9261766 comes down from 944.
 *  • THE SCHEMA STOPS TEACHING THE GROSS MEANING. 0092 shipped
 *    credit_purchases.total_minor as "what Lemon Squeezy actually collected";
 *    under the founder's 2026-08-22 net-of-tax decision that is wrong, and
 *    0093 must correct it with `comment on column` (renaming an applied column
 *    is not free — the meaning moves, the name does not).
 *  • IT REPORTS WHAT IT CANNOT DECIDE. Detection is `stored > list`, which
 *    expands to `tax > discount`: a gross row whose discount beat its tax is
 *    invisible and stays booked gross. `below_list` and `no_money_stamp` are
 *    the counters that stop the notice printing all zeros over such a row.
 *
 * Run: npx vitest run src/utils/__tests__/migration-0093-net-of-tax.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  path.resolve(__dirname, "../../../supabase/migrations/0093_subscription_revenue.sql"),
  "utf-8",
);

/** Prose stripped; SQL string literals (the `comment on` bodies) kept. */
const code = sql.replace(/--[^\n]*/g, "");

/** What actually OPERATES on rows: `--` prose gone, and the two places prose is
 *  legitimately spelled as SQL — `comment on … is '…';` and the RAISE NOTICE
 *  message — gone with it. Operational literals ('lemonsqueezy', 'usd', 'paid')
 *  are deliberately KEPT, because a hard-coded order id would be a string
 *  literal too (ls_order_id is text) and stripping all quotes would hide the
 *  exact mutation this file exists to catch. Doubled quotes inside a literal
 *  are consumed by the same pass, hence `''` before a lone `'`. */
const executable = code
  .replace(/comment on[^']*'(?:''|[^'])*'\s*;/gi, "")
  .replace(/raise notice\s*'(?:''|[^'])*'/gi, "raise notice ''");

describe("0093_subscription_revenue.sql — the net-of-tax repair", () => {
  it("hard-codes NO amount, order id or tax rate in any executable statement", () => {
    // The whole difference between a repair and a receipt. A migration that
    // names one sale silently does nothing for the second one, and the header
    // of the file commits to exactly this in prose — so pin it in code.
    const literals = [...new Set((executable.match(/\b\d+\b/g) ?? []))].sort();
    // 100 = minor-unit conversion; 2 = the upper band that protects a
    // multi-unit order from being repaired down to a single unit; 1 = select 1.
    expect(literals).toEqual(["1", "100", "2"]);
    // Said the other way round, so a future reader sees WHICH numbers must
    // never migrate out of the prose and into the SQL.
    for (const n of ["944", "1179", "999", "9261766", "9261749", "8235804", "1400", "2400"]) {
      expect(executable).not.toContain(n);
    }
  });

  it("identifies a gross row by the list-price band, and refuses the multi-unit case", () => {
    // list - discount + tax > list  ⟺  tax > discount. Above 2x list is a
    // quantity>1 order this codebase cannot credit correctly either, and
    // repairing it down to list would delete half a genuine sale.
    expect(executable).toMatch(/cp\.total_minor\s*>\s*round\(cp\.usd \* 100\)::int\s*$/m);
    expect(executable).toMatch(/cp\.total_minor\s*<\s*round\(cp\.usd \* 100\)::int \* 2/);
    expect(executable).toMatch(/set total_minor = round\(cp\.usd \* 100\)::int/);
  });

  it("reconciles payments DOWNWARD only — the three untaxed $8.00 rows are unreachable", () => {
    expect(executable).toMatch(/set amount = cp\.total_minor/);
    expect(executable).toMatch(/p\.amount\s*>\s*cp\.total_minor/);
    // One assignment to payments.amount in the whole file, and it is that one:
    // any second writer is a second definition of "the amount".
    expect(executable.match(/set amount\s*=/g)).toHaveLength(1);
  });

  it("corrects 0092's column comment so the schema stops describing the gross era", () => {
    const target = /comment on column public\.credit_purchases\.total_minor is\s*'((?:''|[^'])*)'/;
    const body = code.match(target)?.[1];
    expect(body).toBeTruthy();
    expect(body).toMatch(/NET OF TAX/);
    expect(body).toMatch(/subtotal - discount_total/);
    expect(body).toMatch(/NOT attributes\.total/);
    // And no inline DDL comment anywhere in the file may still teach it.
    expect(sql).not.toMatch(/what LS COLLECTED/i);
  });

  it("counts the rows whose tax content it CANNOT decide, so the notice never lies", () => {
    // A gross row with a discount larger than its tax reads at or below list and
    // is indistinguishable from a correct net sale — no predicate can separate
    // them, so both are reported instead of one being silently skipped.
    expect(executable).toMatch(/select count\(\*\) into below_list/);
    expect(executable).toMatch(/cp\.total_minor\s*<\s*round\(cp\.usd \* 100\)::int/);
    // …and a booked sale whose money stamp never landed (total_minor NULL):
    // every other predicate in section 4 requires total_minor, so without this
    // it would be invisible to all of them.
    expect(executable).toMatch(/select count\(\*\) into no_money_stamp/);
    expect(executable).toMatch(/cp\.total_minor is null/);
    // Both reach the operator: declared, computed AND passed to the notice.
    // (The message literal itself contains semicolons, so the argument list is
    // taken from AFTER its closing quote — a `[^;]*` from the start of the
    // statement would stop inside the prose.)
    const args = code.match(/raise notice '0093 §4(?:''|[^'])*'\s*,([^;]*);/)?.[1] ?? "";
    expect(args).toMatch(/below_list/);
    expect(args).toMatch(/no_money_stamp/);
  });

  it("prices the subscription backfill from the stored NET column, never a list constant", () => {
    // PLAN_PRICES_USD_MONTHLY would give 999 for the one live sale — the right
    // answer for the wrong reason, and wrong on the first discounted or
    // prorated row. The backfill must read what lsNetOfTax stamped.
    expect(executable).toMatch(/then si\.total_minor/);
    expect(executable).toMatch(/else si\.total_usd_minor/);
    // A refund must still stop the money counting, on a re-run as much as the
    // first run: the standing reconcile against the durable refund fact.
    expect(code).toMatch(/set status = 'refunded'/);
    expect(executable).toMatch(/si\.refunded_at\s*is not null/);
  });

  it("is re-runnable: every DDL statement is guarded, and the repair is self-limiting", () => {
    // The runbook applies this file TWICE (section 6 must run again after the
    // deploy), so a second run has to be inert rather than destructive.
    // `create\s` and not `create` — otherwise the column `created_at` inside
    // the CREATE TABLE body matches as a statement head.
    const heads = executable.match(/^\s*(create\s|alter table \S+ add column|drop index)[^\n;(]*/gim) ?? [];
    expect(heads.length).toBeGreaterThanOrEqual(5);
    for (const m of heads) expect(m.toLowerCase()).toMatch(/if (not )?exists/);
    // Section 4's predicates are stated against the CURRENT stored value, so
    // once a row is at list, `>` is false and nothing is written again.
    expect(executable).not.toMatch(/already_repaired|repair_done|migration_flag/i);
  });
});
