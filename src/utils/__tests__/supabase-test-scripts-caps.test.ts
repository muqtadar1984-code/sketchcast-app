/**
 * The gap that let a cap change ship half-done: supabase/tests/*.sql are
 * HAND-RUN in the Supabase SQL editor, vitest does not execute .sql, and the
 * autofix workflow runs only tsc/eslint/vitest — so three verification scripts
 * could go on asserting `parts_cap('homeschool') = 48` after 0107 raised it to
 * 56, and the first person to find out would be the founder reading
 * "FAIL: homeschool = 48 generations/month" and believing metering had broken.
 *
 * This file reads those scripts as TEXT and ties every cap number in them back
 * to the migration that owns the caps. It cannot run the SQL; it can make sure
 * the SQL is not arguing with the schema.
 *
 * Two kinds of number are checked:
 *  • DIRECT assertions — `_expect_eq((select parts_cap from fair_use_caps('x')),
 *    N, …)`. Found by regex, so a script that adds one is covered for free.
 *  • SEEDED FILLS — the synthetic ledger rows each script inserts to drive a
 *    user to the edge of their quota. These cannot be recognised generically
 *    (they are just integers), so each is pinned by hand below with the
 *    arithmetic that makes it right. Change a cap and these fail, which is the
 *    point: they are the checks that silently stop testing anything otherwise.
 * Run: npx vitest run src/utils/__tests__/supabase-test-scripts-caps.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SUPA = path.resolve(__dirname, "../../../supabase");
const read = (rel: string) => readFileSync(path.join(SUPA, rel), "utf-8").replace(/\r\n/g, "\n");

/** The caps 0107 installs, read out of the migration itself — one source. */
const migration = read("migrations/0107_seven_piece_kit_allowances.sql").replace(/--[^\n]*/g, "");
const capOf = (tier: string) => {
  const m = migration.match(new RegExp(`\\('${tier}',\\s*([0-9]+),`));
  if (!m) throw new Error(`0107 has no row for ${tier}`);
  return Number(m[1]);
};

/** A kit is seven artefacts and six credits — the deck rides free (0103). The
 * caps moved in 0107; this did not, and the scripts' six-row kit blocks are
 * right to stay six rows. */
const KIT_CREDITS = 6;

const scripts = readdirSync(path.join(SUPA, "tests")).filter((f) => f.endsWith(".sql"));

describe("supabase/tests/*.sql agree with the caps in 0107", () => {
  it("has the scripts this file is about", () => {
    expect(scripts).toContain("0086_credit_packs_test.sql");
    expect(scripts).toContain("0088_unvoid_on_requeue_test.sql");
    expect(scripts).toContain("0089_part_map_seed_test.sql");
  });

  it("every direct parts_cap assertion matches the migration", () => {
    const re = /parts_cap from fair_use_caps\('([a-z_]+)'\)\),\s*([0-9]+)/g;
    let found = 0;
    for (const file of scripts) {
      const sql = read(`tests/${file}`);
      for (const m of sql.matchAll(re)) {
        found++;
        expect(Number(m[2]), `${file}: parts_cap('${m[1]}')`).toBe(capOf(m[1]));
      }
    }
    // If this drops to zero the regex has stopped matching and the check is
    // asserting nothing — a green test that proves nothing is the failure mode
    // this whole file exists to prevent.
    expect(found).toBeGreaterThanOrEqual(2);
  });

  it("0086's seeded fills are arithmetic against the live caps", () => {
    const sql = read("tests/0086_credit_packs_test.sql");
    const home = capOf("homeschool");
    const pro = capOf("pro");
    const trial = capOf("trial");

    // §3 fills home-1 units so the NEXT generation is the last on plan quota.
    expect(sql).toContain(`values (H, 'presentation', ${home - 1}, 0, 'plan', now() - interval '1 hour');`);
    expect(sql).toContain(`'homeschool: ${home}th generation admitted on plan quota'`);
    expect(sql).toContain(`'row ${home}/${home} charged to the PLAN pool'`);

    // §6 burns a whole fresh month's quota on top of g3's single unit, so the
    // next row must ride the purchased balance.
    expect(sql).toContain(
      `values (H, 'presentation', ${home}, 0, 'plan'); -- burn this month's quota (${home} + g3 = ${home + 1} used)`,
    );

    // Trial: exactly `trial` generations admitted, the next blocked.
    expect(sql).toContain(`for i in 1..${trial} loop`);
    expect(sql).toContain(`'trial blocked at ${trial + 1} (cap is ${trial} now, was 96)'`);
    expect(sql).toContain(`'trial + purchased balance: ${trial + 1}th generation admitted'`);

    // §7 leaves exactly half a kit's worth of plan room (3 of 6), so a
    // one-statement kit must split 3 plan / 3 purchase.
    const halfKit = KIT_CREDITS / 2;
    expect(sql).toContain(`-- P: ${pro - halfKit}/${pro} plan used, balance 3`);
    expect(sql).toContain(`values (P, 'presentation', ${pro - halfKit}, 0, 'plan', now() - interval '1 hour');`);
    expect(sql).toContain(`values (Q, 'presentation', ${pro - halfKit}, 0, 'plan', now() - interval '1 hour');`);
    // …and the kit itself is still SIX rows: 0107 moved the ceiling, not the
    // price. The deck is absent from this insert on purpose.
    expect(sql).toContain("'six-row kit with 3 plan + 3 purchased available succeeds whole'");
    expect(sql).not.toContain("('deck',");
  });

  it("0088 spends exactly the pro cap before testing the purchase pool", () => {
    const sql = read("tests/0088_unvoid_on_requeue_test.sql");
    expect(sql).toContain(
      `values (P, 'presentation', ${capOf("pro")}, 0, 'plan', now() - interval '1 hour'); -- pro quota spent (0107 cap)`,
    );
  });

  it("0089 burns to two-under the homeschool cap, then overshoots by one", () => {
    const sql = read("tests/0089_part_map_seed_test.sql");
    const home = capOf("homeschool");
    // 7 already used + this fill = home - 2, leaving room to ADMIT one more
    // lesson whose real weight (3 units) then overshoots to home + 1.
    expect(sql).toContain(`-- Burn to ${home - 2}/${home}: available 2`);
    expect(sql).toContain(`values (H, 'presentation', ${home - 2 - 7}, 0, 'plan', now() - interval '1 hour');`);
    expect(sql).toContain(`'used ${home + 1}/${home} — the accepted single-statement overshoot'`);
  });

  it("each script says which caps it is baselined against", () => {
    for (const file of ["0086_credit_packs_test.sql", "0088_unvoid_on_requeue_test.sql", "0089_part_map_seed_test.sql"]) {
      const sql = read(`tests/${file}`);
      expect(sql, `${file} needs a CAP BASELINE note`).toContain("CAP BASELINE: 0107");
    }
  });

  it("no script has been 'fixed' by charging for the deck", () => {
    // The tempting wrong fix for a cap change: make a kit seven ledger rows.
    // It is not — credit_ledger_write names six kinds and the deck is not one.
    for (const file of scripts) {
      const sql = read(`tests/${file}`);
      expect(sql, `${file} inserts a deck credit_ledger row`).not.toMatch(
        /credit_ledger[\s\S]{0,200}'deck'/,
      );
    }
  });
});
