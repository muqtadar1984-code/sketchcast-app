/**
 * Parse-check for supabase/migrations/0107_seven_piece_kit_allowances.sql —
 * applied by hand by the founder, so this is the only automated eye on it.
 *
 * The change: a kit ships SEVEN pieces since 0103 (the deck), so every
 * allowance rises by 7/6. What must hold:
 *  • the seven real tiers carry their new parts_cap, and NOTHING else moves —
 *    docs_cap and books_cap are byte-identical to the 0101 body;
 *  • 'school' keeps its 2147483647 sentinel. Scaling it would overflow int4
 *    (2147483647 * 7 / 6 = 2505397588), and "unlimited" is not a quantity;
 *  • the two locked school states stay at 0;
 *  • every new parts_cap divides EXACTLY by 7, and the quotient equals the kit
 *    count the row comment claims — so the comments stay true and the pricing
 *    page's advertised kit counts do not move;
 *  • the kit counts still agree with PLAN_KITS_PER_MONTH in utils/financials —
 *    the cost model and the database cannot drift apart;
 *  • THE FREE-RIDE GUARANTEE (inherited from 0103): the file does NOT redefine
 *    credit_ledger_write, fair_use_used or fair_use_used_since. Those three
 *    name the six BILLABLE kinds on purpose; adding 'deck' to any of them
 *    would silently make a kit cost 7 credits instead of 6 and make every
 *    existing user worse off. Raising a cap must never become a price rise.
 * Run: npx vitest run src/utils/__tests__/migration-0107-caps.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  PLAN_KITS_PER_MONTH,
  PLAN_KITS_COSTED_PER_MONTH,
  PLAN_GENERATION_CAPS,
  KIT_CREDITS,
} from "../financials";

const raw = readFileSync(
  path.resolve(__dirname, "../../../supabase/migrations/0107_seven_piece_kit_allowances.sql"),
  "utf-8",
);

/** Comment-stripped, CRLF-normalised, lowercased — the DDL only. The header's
 * DOWN block quotes the OLD numbers as `--` comments, so stripping comments is
 * what keeps "the file does not still say 24" honest. */
const normalise = (text: string) =>
  text.replace(/\r\n/g, "\n").replace(/--[^\n]*/g, "").toLowerCase();
const code = normalise(raw);
/** CRLF-normalised but comments KEPT — for asserting on the row comments. */
const withComments = raw.replace(/\r\n/g, "\n");

/** The one VALUES row per tier, read out of the real file. */
const rowOf = (tier: string) => {
  const m = code.match(new RegExp(`\\('${tier}',\\s*([0-9]+),\\s*([0-9]+),\\s*([0-9]+)\\)`));
  if (!m) throw new Error(`tier ${tier} not found in the migration`);
  return { parts: Number(m[1]), docs: Number(m[2]), books: Number(m[3]) };
};

const SENTINEL = 2147483647;

/** tier -> [new parts_cap, docs_cap, books_cap] — every value in the file. */
const EXPECTED: Record<string, [number, number, number]> = {
  trial: [7, 0, SENTINEL],
  promo: [28, 0, 2],
  pro: [28, 0, 2],
  pro_plus: [84, 0, 4],
  family: [14, 0, 2],
  homeschool: [56, 0, 4],
  school: [SENTINEL, SENTINEL, SENTINEL],
  school_trial: [14, 0, 2],
  school_expired: [0, 0, 0],
  school_suspended: [0, 0, 0],
};

/** What each cap was BEFORE (the 0101 body running in prod). */
const OLD_PARTS: Record<string, number> = {
  trial: 6, promo: 24, pro: 24, pro_plus: 72, family: 12,
  homeschool: 48, school: SENTINEL, school_trial: 12,
  school_expired: 0, school_suspended: 0,
};

describe("0107_seven_piece_kit_allowances.sql", () => {
  it("sets every tier's caps to exactly the intended values", () => {
    for (const [tier, [parts, docs, books]] of Object.entries(EXPECTED)) {
      expect({ tier, ...rowOf(tier) }).toEqual({ tier, parts, docs, books });
    }
  });

  it("scales every real allowance by 7/6 and leaves the sentinels alone", () => {
    for (const [tier, old] of Object.entries(OLD_PARTS)) {
      const now = rowOf(tier).parts;
      if (old === SENTINEL || old === 0) {
        // Unlimited and locked are not quantities — they must not be scaled.
        expect(now).toBe(old);
      } else {
        expect(now).toBe((old * 7) / 6);
        expect(now).toBeGreaterThan(old); // never a downgrade for anyone
      }
    }
  });

  it("does not scale 'school' — 7/6 of the sentinel overflows int4", () => {
    expect(rowOf("school").parts).toBe(SENTINEL);
    expect((SENTINEL * 7) / 6).toBeGreaterThan(SENTINEL);
  });

  it("every new allowance divides exactly by 7, to the kit count it claims", () => {
    // The row comments say "1 kit" / "4 kits" / … — the arithmetic behind the
    // pricing page. If a cap stopped dividing, the page would round silently.
    const claimed: Record<string, number> = {
      trial: 1, promo: 4, pro: 4, pro_plus: 12, family: 2,
      homeschool: 8, school_trial: 2,
    };
    for (const [tier, kits] of Object.entries(claimed)) {
      const parts = rowOf(tier).parts;
      expect(parts % 7).toBe(0);
      expect(parts / 7).toBe(kits);
      // …and the count is UNCHANGED: it was parts_cap/6 before.
      expect(OLD_PARTS[tier] / 6).toBe(kits);
    }
  });

  it("the row comments still state the true kit count", () => {
    for (const [row, comment] of [
      ["('trial',      7, 0, 2147483647),", "1 kit"],
      ["('promo',     28, 0, 2),", "4 kits"],
      ["('pro',       28, 0, 2),", "4 kits"],
      ["('pro_plus',  84, 0, 4),", "12 kits"],
      ["('family',    14, 0, 2),", "2 kits"],
      ["('homeschool',56, 0, 4),", "8 kits"],
      ["('school_trial',     14, 0, 2),", "2 kits"],
    ] as const) {
      const line = withComments.split("\n").find((l) => l.includes(row));
      expect(line, `row not found: ${row}`).toBeTruthy();
      expect(line).toContain(comment);
    }
  });

  it("agrees with PLAN_KITS_PER_MONTH — the advertised count cannot drift from the DB", () => {
    expect(rowOf("pro").parts / 7).toBe(PLAN_KITS_PER_MONTH.teacher_pro);
    expect(rowOf("pro_plus").parts / 7).toBe(PLAN_KITS_PER_MONTH.teacher_pro_plus);
    expect(rowOf("family").parts / 7).toBe(PLAN_KITS_PER_MONTH.family);
    expect(rowOf("homeschool").parts / 7).toBe(PLAN_KITS_PER_MONTH.homeschool);
  });

  it("agrees with the CONSOLE'S COST BASIS too — caps ÷ 6, what a kit charges", () => {
    // Two divisors, one source. The migration is the authority for the caps;
    // financials.ts must carry the SAME caps, divide them by 7 for the count it
    // advertises and by 6 for the cost it models. A cap that moved here and not
    // there would silently re-flatter /console/financials.
    const pairs = [
      ["pro", "teacher_pro"],
      ["pro_plus", "teacher_pro_plus"],
      ["family", "family"],
      ["homeschool", "homeschool"],
    ] as const;
    for (const [tier, plan] of pairs) {
      const cap = rowOf(tier).parts;
      expect(cap).toBe(PLAN_GENERATION_CAPS[plan]);
      expect(PLAN_KITS_COSTED_PER_MONTH[plan]).toBeCloseTo(cap / KIT_CREDITS, 10);
      // The allowance always buys MORE than the page promises — never less.
      expect(PLAN_KITS_COSTED_PER_MONTH[plan]).toBeGreaterThan(PLAN_KITS_PER_MONTH[plan]);
    }
  });

  it("preserves the function's exact shape — signature, IMMUTABLE, dollar quoting", () => {
    expect(code).toMatch(/create or replace function public\.fair_use_caps\(tier text\)/);
    expect(code).toMatch(/returns table\(parts_cap integer, docs_cap integer, books_cap integer\)/);
    expect(code).toMatch(/language sql immutable as/);
    expect(code).toMatch(/where t\.k = coalesce\(tier, 'trial'\);/);
    expect(code).toMatch(/\) as t\(k, parts_cap, docs_cap, books_cap\)/);
    // Dollar-quoted with the same tag prod uses, opened and closed.
    expect(code.match(/\$function\$/g)?.length).toBe(2);
    // Wrapped in one transaction.
    expect(code).toMatch(/^\s*begin;/m);
    expect(code).toMatch(/^\s*commit;/m);
  });

  it("redefines fair_use_caps and NOTHING else", () => {
    expect(code.match(/create or replace function/g)?.length).toBe(1);
    expect(code).toMatch(/function public\.fair_use_caps\(/);
  });

  it("THE FREE-RIDE GUARANTEE: it never touches the billable-kind meters", () => {
    // Raising a cap must not become a price rise. These three name the six
    // billable kinds; the deck is absent from them on purpose (0103).
    expect(code).not.toContain("credit_ledger_write");
    expect(code).not.toMatch(/function public\.fair_use_used\(/);
    expect(code).not.toMatch(/function public\.fair_use_used_since\(/);
    expect(code).not.toMatch(/function public\.enforce_fair_use\(/);
    expect(code).not.toMatch(/function public\.my_fair_use\(/);
    // And it does not mention the deck kind at all — it has no business here.
    expect(code).not.toContain("'deck'");
  });

  it("changes no data and no tables", () => {
    const outside = code.replace(/as\s*\$function\$[\s\S]*?\$function\$;/g, "");
    expect(outside).not.toMatch(/\b(insert|update|delete|alter table|drop|create table|truncate)\b/);
  });

  it("carries the header the founder applies it from", () => {
    expect(raw).toMatch(/NOT APPLIED BY ANY AGENT\. The founder applies prod schema changes\./);
    expect(raw).toMatch(/^-- 0107_seven_piece_kit_allowances/);
    for (const section of ["WHAT IT DOES", "DOWN", "ORDER OF OPERATIONS", "NUMBERING"]) {
      expect(raw).toContain(`-- ${section}`);
    }
    // The DOWN block must actually restore the OLD numbers.
    const down = raw.slice(raw.indexOf("-- DOWN"), raw.indexOf("-- NUMBERING"));
    for (const old of ["('trial',      6,", "('pro',       24,", "('pro_plus',  72,", "('homeschool',48,"]) {
      expect(down).toContain(old);
    }
  });

  it("survives a CRLF checkout (core.autocrlf=true)", () => {
    expect(normalise(raw.replace(/\r?\n/g, "\r\n"))).toBe(code);
  });
});
