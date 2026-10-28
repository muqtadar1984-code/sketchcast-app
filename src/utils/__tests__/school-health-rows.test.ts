/**
 * fetchSchoolHealthRows issues its six independent table reads together and
 * only the teacher-name lookup (which needs the classes) after them — the
 * shape learners.risk relies on for its one-read-per-turn (fix/sk-speed).
 * Run: node node_modules/vitest/vitest.mjs run src/utils/__tests__/school-health-rows.test.ts
 */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchSchoolHealthRows } from "../school-health";

type Row = Record<string, unknown>;

/* eslint-disable @typescript-eslint/no-explicit-any */
function gatedClient(tables: Record<string, Row[]>) {
  const started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const from = (table: string) => {
    started.push(table);
    const b: any = {};
    for (const m of ["select", "in", "eq"]) b[m] = () => b;
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => gate.then(() => ({ data: tables[table] ?? [], error: null })).then(res, rej);
    return b;
  };
  return { started, release, client: { from } as unknown as SupabaseClient };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe("fetchSchoolHealthRows", () => {
  it("starts classes, enrollments, shares, progress, submissions and generations together; profiles only after the classes arrive", async () => {
    const c = gatedClient({
      classes: [{ id: "c1", name: "7B", grade: "1", teacher_id: "t1" }],
      enrollments: [{ class_id: "c1", student_id: "s1", profiles: { full_name: "Aisha", username: null, parent_email: null } }],
      profiles: [{ id: "t1", full_name: "Nurul", username: null }],
    });
    const pending = fetchSchoolHealthRows(c.client);
    await new Promise((r) => setTimeout(r, 0));
    expect([...c.started].sort()).toEqual(["classes", "enrollments", "generation_shares", "generations", "student_progress", "submissions"]);
    c.release();
    const rows = await pending;
    expect(c.started.at(-1)).toBe("profiles");
    expect(rows).toEqual({
      classes: [{ id: "c1", name: "7B", grade: "1", teacher_id: "t1" }],
      enrollments: [{ class_id: "c1", student_id: "s1", full_name: "Aisha", username: null, parent_email: null }],
      shares: [],
      progress: [],
      submissions: [],
      generations: [],
      teacherNames: { t1: "Nurul" },
    });
  });
});
