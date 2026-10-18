/**
 * Parse-check for supabase/migrations/0143_delete_translation_kit.sql — the X
 * on a rejected or failed translation row (founder, 2026-10-18). What must
 * hold: it refuses anything but a translation that is rejected or failed,
 * with no live job, no posted video and no derived kit; it clears the NO
 * ACTION references before deleting; it never deletes an approved article;
 * it is service-role only; a rollback drops it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MIG = path.resolve(__dirname, "../../../supabase/migrations");
const read = (f: string) => readFileSync(path.join(MIG, f), "utf-8").replace(/\r\n/g, "\n");
const M = read("0143_delete_translation_kit.sql");
const R = read("0143_delete_translation_kit_rollback.sql");
const code = M.split("\n").map((l) => l.replace(/--.*$/, "").trimEnd()).join("\n");

describe("0143 delete_translation_kit", () => {
  it("refuses an English kit, any other status, a live job, a posted video and a derived kit", () => {
    expect(code).toMatch(/coalesce\(k\.language, 'en'\) = 'en' or k\.source_kit_id is null/);
    expect(code).toMatch(/k\.status not in \('rejected', 'failed'\)/);
    expect(code).toMatch(/j\.status in \('queued', 'processing'\)/);
    expect(code).toMatch(/youtube_video_id is not null/);
    expect(code).toMatch(/c\.source_kit_id = p_kit/);
  });

  it("clears the NO ACTION references before the deletes, generations before the kit", () => {
    const at = (s: string) => code.indexOf(s);
    for (const ref of ["platform_issues set generation_id = null", "present_items set generation_id = null",
      "question_sets set rendered_generation_id = null", "catalogue_unlocks set first_kit_id = null",
      "topic_kits set presentation_generation_id = null"]) {
      expect(at(ref)).toBeGreaterThan(-1);
      expect(at(ref)).toBeLessThan(at("delete from generations"));
    }
    expect(at("delete from topic_questions")).toBeLessThan(at("delete from topic_kits where id = p_kit"));
    expect(at("delete from generations")).toBeLessThan(at("delete from topic_kits where id = p_kit"));
  });

  it("deletes the article version only when it is a translation, not approved and unused", () => {
    expect(code).toMatch(/a\.status <> 'approved'/);
    expect(code).toMatch(/coalesce\(a\.language, 'en'\) <> 'en'/);
    expect(code).toMatch(/not exists \(select 1 from topic_kits o where o\.article_id = v_art\)/);
  });

  it("is service-role only, audited, and returns the storage paths", () => {
    expect(code).toMatch(/revoke all on function public\.delete_translation_kit\(uuid, uuid\) from public, anon, authenticated/);
    expect(code).toMatch(/grant execute on function public\.delete_translation_kit\(uuid, uuid\) to service_role/);
    expect(code).toMatch(/'library_kit_translation_delete'/);
    expect(code).toMatch(/'storage_paths', to_jsonb\(v_paths\)/);
    expect(R).toMatch(/drop function if exists public\.delete_translation_kit\(uuid, uuid\)/);
  });
});
