/**
 * Parse-check for supabase/migrations/0108_trial_kit_seven_pieces.sql —
 * applied by hand by the founder, so this is the only automated eye on it.
 *
 * The change is ONE string. `enforce_beta_generation_cap` raises "Your free
 * trial includes the full kit (all six content types) …", the app prints that
 * Postgres message verbatim (there is no friendly remap), and the tooltip
 * beside it now says SEVEN. 0108 restates the function with that one wording
 * fixed. What must hold:
 *  • the restated function is 0058's, byte-for-byte, with only the message
 *    changed — this is the whole safety argument, so it is asserted directly
 *    rather than eyeballed;
 *  • the DDL says seven and no longer says six;
 *  • it agrees with the app copy that fires on the same screen
 *    (library.kit.trialLockedHint / trialPickHint, all ten locales);
 *  • it redefines that one function and nothing else, and writes no data.
 * Run: npx vitest run src/utils/__tests__/migration-0108-trial-message.test.ts
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS = path.resolve(__dirname, "../../../supabase/migrations");
const read = (file: string) => readFileSync(path.join(MIGRATIONS, file), "utf-8").replace(/\r\n/g, "\n");

const raw = read("0108_trial_kit_seven_pieces.sql");
const prior = read("0058_parent_trial_pin.sql");

const OLD_MSG = "all six content types";
const NEW_MSG = "all seven content types";

/** The `create or replace function enforce_beta_generation_cap() … end $$;`
 * block, lifted out of whichever file it is in. */
const functionBlock = (sql: string) => {
  const start = sql.indexOf("create or replace function enforce_beta_generation_cap()");
  const endMarker = "\nend $$;\n";
  const end = sql.indexOf(endMarker, start);
  expect(start, "function not found").toBeGreaterThan(-1);
  expect(end, "function end not found").toBeGreaterThan(-1);
  return sql.slice(start, end + endMarker.length);
};

/** Comment-stripped, lowercased DDL — the header quotes the OLD wording in its
 * DOWN block, so stripping comments is what keeps "the file no longer says six"
 * an honest assertion. */
const code = raw.replace(/--[^\n]*/g, "").toLowerCase();

describe("0108_trial_kit_seven_pieces.sql", () => {
  it("is 0058's function with ONLY the message changed", () => {
    const now = functionBlock(raw);
    const before = functionBlock(prior);
    // Put the old wording back and the two must be indistinguishable.
    expect(now.replace(NEW_MSG, OLD_MSG)).toBe(before);
    // …and the swap really happened.
    expect(now).not.toBe(before);
  });

  it("changes exactly one occurrence, in the raise", () => {
    const fn = functionBlock(raw);
    expect(fn.split(NEW_MSG).length - 1).toBe(1);
    expect(fn).not.toContain(OLD_MSG);
    expect(fn).toContain(
      "raise exception 'Your free trial includes the full kit (all seven content types) for one part of one chapter, and yours is already started. Upgrade to unlock the rest of the book.'",
    );
  });

  it("says the same number as the tooltip on the same screen, in all ten locales", () => {
    // The failure this exists for: the button's title says seven and the red
    // error under it says six. Both halves are pinned here.
    const dir = path.resolve(__dirname, "../../i18n/messages");
    const locales = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(locales.length).toBe(10);
    for (const file of locales) {
      const kit = JSON.parse(readFileSync(path.join(dir, file), "utf-8")).library.kit;
      for (const key of ["trialLockedHint", "trialPickHint"] as const) {
        expect(kit[key], `${file} ${key}`).toBeTruthy();
        expect(kit[key], `${file} ${key} still says six`).not.toContain(OLD_MSG);
      }
    }
    // English is the one whose wording can be compared to the DB's directly.
    const en = JSON.parse(readFileSync(path.join(dir, "en.json"), "utf-8")).library.kit;
    expect(en.trialLockedHint).toContain(NEW_MSG);
    expect(en.trialPickHint).toContain(NEW_MSG);
  });

  it("preserves the function's exact shape — trigger, definer, search_path", () => {
    expect(code).toMatch(/create or replace function enforce_beta_generation_cap\(\) returns trigger/);
    expect(code).toMatch(/language plpgsql security definer set search_path = public as/);
    expect(code.match(/\$\$/g)?.length).toBe(2);
    expect(code).toMatch(/^\s*begin;/m);
    expect(code).toMatch(/^\s*commit;/m);
  });

  it("redefines that one function and NOTHING else", () => {
    expect(code.match(/create or replace function/g)?.length).toBe(1);
    // It must not drift into the metering functions the trial also passes
    // through — a cap change is not this file's business.
    for (const other of ["fair_use_caps", "credit_ledger_write", "fair_use_used", "my_trial_pin"]) {
      expect(code).not.toContain(`function ${other}`);
      expect(code).not.toContain(`function public.${other}`);
    }
  });

  it("changes no data and no tables", () => {
    const outside = code.replace(/as\s*\$\$[\s\S]*?\$\$;/g, "");
    expect(outside).not.toMatch(/\b(insert|update|delete|alter table|drop|create table|truncate)\b/);
  });

  it("carries the header the founder applies it from", () => {
    expect(raw).toMatch(/^-- 0108_trial_kit_seven_pieces/);
    expect(raw).toMatch(/NOT APPLIED BY ANY AGENT\. The founder applies prod schema changes\./);
    for (const section of ["WHAT IT DOES", "WHY THE COUNT IS SEVEN AND NOT SIX", "WHY IT IS SAFE", "DOWN"]) {
      expect(raw).toContain(`-- ${section}`);
    }
  });

  it("hashes back to the function RUNNING in prod once the wording is undone", () => {
    // The strongest form of "this file changes nothing but a message": take the
    // body 0108 installs, put the old wording back, and it must be byte-for-byte
    // pg_proc.prosrc as read from production on 2026-09-06. prosrc there carries
    // CRLF (0058 was applied from a core.autocrlf=true checkout), so the
    // comparison is made in CRLF and is therefore checkout-independent.
    const PROD_PROSRC_MD5 = "34a519c21b9a9b8d1f51ba0f724eed49";
    // Postgres length(prosrc) counts CHARACTERS; md5(prosrc) hashes the UTF-8
    // bytes. The body carries em dashes, so the two differ — compare each in
    // its own unit.
    const PROD_PROSRC_CHARS = 8259;
    const fn = functionBlock(raw);
    const open = fn.indexOf("$$", fn.indexOf("\n$$") + 1) + 2;
    const close = fn.lastIndexOf("$$;");
    const body = fn.slice(open, close).replace(/\n/g, "\r\n");
    const restored = body.replace(NEW_MSG, OLD_MSG);
    expect(restored.length).toBe(PROD_PROSRC_CHARS);
    expect(createHash("md5").update(restored, "utf-8").digest("hex")).toBe(PROD_PROSRC_MD5);
    // And the shipped body differs from it by exactly the five added letters.
    expect(body.length).toBe(PROD_PROSRC_CHARS + "seven".length - "six".length);
  });
});
