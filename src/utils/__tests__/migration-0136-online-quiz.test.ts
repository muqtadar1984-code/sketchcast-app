/**
 * Parse-check for supabase/migrations/0136_online_quiz_blueprint.sql (catalogue
 * Phase D part 2): the seeded "Online quiz" blueprint must be the spec the kit
 * route composes from (QUIZ_BLUEPRINT_SPEC) — the two are changed together —
 * idempotent on the name, scope worksheet, maturity basic. Data only: no DDL.
 * Run: npx vitest run src/utils/__tests__/migration-0136-online-quiz.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { QUIZ_BLUEPRINT_NAME, QUIZ_BLUEPRINT_SPEC, validateBlueprintSpec } from "../catalogue/questions";

const SQL = readFileSync(path.join(process.cwd(), "supabase/migrations/0136_online_quiz_blueprint.sql"), "utf8");

describe("0136_online_quiz_blueprint.sql", () => {
  it("seeds the Online quiz blueprint idempotently, as a worksheet-scope preset needing a basic bank", () => {
    expect(SQL).toMatch(/insert into public\.question_set_blueprints \(name, scope, spec, min_maturity\)/);
    expect(SQL).toMatch(new RegExp(`'${QUIZ_BLUEPRINT_NAME}',\\s*\n\\s*'worksheet'`));
    expect(SQL).toMatch(/'basic'\s*\n\)\s*\non conflict \(name\) do nothing;/);
  });

  it("seeds EXACTLY the app's QUIZ_BLUEPRINT_SPEC", () => {
    const m = /'(\{"preset":"quiz".*?\})'::jsonb/.exec(SQL);
    expect(m, "the spec literal").toBeTruthy();
    const seeded = JSON.parse(m![1]);
    expect(seeded).toEqual(QUIZ_BLUEPRINT_SPEC);
    const v = validateBlueprintSpec(seeded);
    expect(v.ok, v.errors.join(" | ")).toBe(true);
    if (v.ok) expect(v.spec.fill).toBe("nearest");
  });

  it("contains no DDL", () => {
    expect(SQL).not.toMatch(/\b(create|alter|drop)\s+(table|type|function|policy|index|view)\b/i);
  });
});
