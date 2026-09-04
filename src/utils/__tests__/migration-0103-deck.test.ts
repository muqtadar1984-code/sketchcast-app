/**
 * Parse-check for supabase/migrations/0103_deck_kind.sql — applied by hand in
 * two steps, so this is the only automated eye on the file. What must hold:
 *  • STEP 1 adds the 'deck' label to generation_kind (idempotently);
 *  • enforce_fair_use gains a `new.kind::text = 'deck'` branch that requires
 *    the unit's lesson (has_lesson), caps regeneration at 3 a month
 *    (kind_rows >= 3) and RETURNS before any credit check — the deck is free
 *    with its lesson, so fair_use_avail / fair_use_used must not be reachable
 *    from it;
 *  • the branch sits after the exam branch and before the presentation one, so
 *    the school_suspended / school_expired / console-override checks at the top
 *    still run first;
 *  • reject_double_submit lists 'deck' (a double click must not queue two);
 *  • THE FREE-RIDE GUARANTEE: the file does NOT redefine credit_ledger_write,
 *    fair_use_used or fair_use_used_since. Those three name the six billable
 *    kinds on purpose; adding 'deck' to any of them would silently make a kit
 *    7 credits.
 * Run: npx vitest run src/utils/__tests__/migration-0103-deck.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const raw = readFileSync(path.resolve(__dirname, "../../../supabase/migrations/0103_deck_kind.sql"), "utf-8");

// The file is committed LF, but core.autocrlf=true (set on the founder's
// checkout) hands a fresh clone CRLF — and the branch markers below are
// matched with a literal "\n", so an unnormalised read found no `return new;
// end if;` and two cases failed with end = -1. Normalise first; the CRLF
// case at the bottom pins that this stays true.
const normalise = (text: string) => {
  const code = text.replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "").toLowerCase();
  const fn = (name: string) => {
    const m = code.match(new RegExp(`create or replace function public\\.${name}\\(\\)([\\s\\S]*?)\\$\\$;`));
    if (!m) throw new Error(`${name} not found`);
    return m[1];
  };
  return { code, fn };
};
const { code, fn } = normalise(raw);

/** The deck branch of enforce_fair_use: from its `if` to its own `return new; end if;`. */
const deckBranch = (body: string) => {
  const start = body.search(/if new\.kind::text = 'deck' then/);
  const end = body.indexOf("return new;\n  end if;", start);
  return { start, end, branch: body.slice(start, end) };
};

describe("0103_deck_kind.sql", () => {
  it("adds the enum label idempotently (STEP 1, committed on its own)", () => {
    expect(code).toMatch(/alter type generation_kind add value if not exists 'deck';/);
    // Only that one enum change — artifact_kind already has deck_pptx.
    expect(code.match(/alter type/g)?.length).toBe(1);
  });

  it("redefines both guard functions as SECURITY DEFINER with a pinned search_path", () => {
    for (const name of ["enforce_fair_use", "reject_double_submit"]) {
      const body = fn(name);
      expect(body).toMatch(/security definer/);
      expect(body).toMatch(/set search_path = public/);
    }
  });

  it("the deck branch needs the unit's lesson and caps regeneration at 3 a month", () => {
    const body = fn("enforce_fair_use");
    // The branch ends at its own `return new; end if;` — everything it does
    // lives between those two markers.
    const { start, end, branch } = deckBranch(body);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(branch).toMatch(/pg_advisory_xact_lock\(hashtext\('fair_use:' \|\| new\.owner_id::text\)\)/);
    expect(branch).toMatch(/p\.kind = 'presentation' and p\.status <> 'error'/);
    expect(branch).toMatch(/\) into has_lesson;/);
    expect(branch).toMatch(/if not has_lesson then\s+raise exception/);
    expect(branch).toMatch(/d\.kind::text = 'deck' and d\.status <> 'error'/);
    expect(branch).toMatch(/d\.created_at >= date_trunc\('month', now\(\)\)/);
    expect(branch).toMatch(/if kind_rows >= 3 then\s+raise exception/);
    // Unlimited tiers skip both guards, exactly as the documents do.
    expect(branch).toMatch(/if caps\.parts_cap >= 2147483647 then\s+return new;/);
  });

  it("the deck branch returns BEFORE any credit check — free with its lesson", () => {
    const body = fn("enforce_fair_use");
    const { start, end, branch } = deckBranch(body);
    expect(end).toBeGreaterThan(start);
    for (const credit of ["fair_use_avail(", "fair_use_used(", "fair_use_used_since(", "fair_use_purchased_remaining(", "credit_ledger"]) {
      expect(branch).not.toContain(credit);
    }
    // And positionally: the branch's return precedes the first credit call in
    // the whole function, so no reordering can route a deck past a meter.
    const firstCredit = Math.min(
      ...["fair_use_avail(", "fair_use_used("].map((s) => body.indexOf(s)).filter((i) => i >= 0),
    );
    expect(end).toBeLessThan(firstCredit);
  });

  it("sits after the exam branch and before the presentation branch", () => {
    const body = fn("enforce_fair_use");
    const exam = body.search(/if new\.kind::text = 'exam' then/);
    const deck = body.search(/if new\.kind::text = 'deck' then/);
    const pres = body.search(/if new\.kind = 'presentation' then/);
    const docs = body.search(/if new\.kind in \('worksheet', 'exam_paper', 'lesson_plan', 'activity', 'case_study'\) then/);
    expect(exam).toBeGreaterThan(0);
    expect(deck).toBeGreaterThan(exam);
    expect(pres).toBeGreaterThan(deck);
    expect(docs).toBeGreaterThan(pres);
    // The locked school states still come first, for every kind.
    expect(body.search(/tier = 'school_suspended'/)).toBeLessThan(exam);
    expect(body.search(/tier = 'school_expired'/)).toBeLessThan(exam);
  });

  it("keeps the six billable kinds' branches intact (prod body, not a rewrite)", () => {
    const body = fn("enforce_fair_use");
    expect(body).toMatch(/tier = 'promo'/);
    expect(body).toMatch(/tier = 'school_trial'/);
    expect(body).toMatch(/fair_use_used_since\(new\.owner_id, school_trial_anchor\(new\.owner_id\)\)/);
    expect(body).toMatch(/\(new\.params->>'revision'\) = 'true'/);
    expect(body).toMatch(/cumulative_count >= 12/);
    expect(body).toMatch(/fair_use_purchased_remaining\(new\.owner_id\)/);
  });

  it("reject_double_submit lists 'deck' beside the six kinds", () => {
    const body = fn("reject_double_submit");
    expect(body).toMatch(
      /if new\.kind::text not in\s+\('presentation','worksheet','lesson_plan','activity','exam_paper','case_study','deck'\)/,
    );
    expect(body).toMatch(/interval '10 seconds'/);
    expect(body).toMatch(/errcode = 'unique_violation'/);
  });

  it("does not redefine the metering functions — the deck never enters the ledger", () => {
    expect(code).not.toContain("credit_ledger_write");
    expect(code).not.toMatch(/function public\.fair_use_used\(/);
    expect(code).not.toMatch(/function public\.fair_use_used_since\(/);
    expect(code).not.toMatch(/function public\.fair_use_avail\(/);
    expect(code).not.toMatch(/function public\.credit_ledger_sync\(/);
    expect(code).not.toMatch(/function public\.credit_ledger_void_unconsumed\(/);
    // Exactly the two guards, nothing else.
    expect(code.match(/create or replace function/g)?.length).toBe(2);
  });

  it("changes no data and no tables", () => {
    const outside = code.replace(/as\s*\$\$[\s\S]*?\$\$;/g, "");
    expect(outside).not.toMatch(/\b(insert|update|delete|alter table|drop)\b/);
  });

  it("survives a CRLF checkout (core.autocrlf=true) — the branch markers still match", () => {
    // The same bytes git hands a Windows clone: every line ending doubled.
    const crlfRaw = raw.replace(/\r?\n/g, "\r\n");
    const crlf = normalise(crlfRaw);
    expect(crlf.code).toBe(code);
    const { start, end } = deckBranch(crlf.fn("enforce_fair_use"));
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    // And an un-normalised read really would miss the marker — the reason
    // this case exists.
    expect(crlfRaw.toLowerCase().indexOf("return new;\n  end if;")).toBe(-1);
  });
});
