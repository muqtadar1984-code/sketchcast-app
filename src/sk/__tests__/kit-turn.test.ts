// SK S3 slice B — the kit "explain" turn (src/sk/kit-turn.ts), and the
// METERING REGRESSION: a student explain turn on kit content writes exactly one
// sk_usage live_turns through the loop's own write point, on the production
// wiring (SupabaseSessionStore + SupabaseEntitlements over the strict fake).
import { describe, expect, it } from "vitest";
import { StubProvider } from "@/utils/assistant/providers/stub";
import { LIVE_ENDED_TEXT } from "../access-notice";
import { SupabaseEntitlements } from "../entitlement";
import { runKitExplain, type KitTurnDeps } from "../kit-turn";
import { SupabaseSessionStore } from "../store-supabase";
import { NO_TEACHER_TEXT } from "../teacher";
import type { SseEvent } from "../types";
import { PRODUCT, SLUG } from "./cells-fixtures";
import { kitManifest, NARRATION_0 } from "./kit-fixtures";
import { cellsDb, staffGrant, STUDENT } from "./supabase-loop-deps";

const T0 = Date.parse("2026-10-15T10:00:00Z");
const now = () => T0;

function harness(opts: { teacher?: StubProvider; expiredTutor?: boolean } = {}) {
  const grant = staffGrant(T0);
  const db = cellsDb(now, { grants: [opts.expiredTutor ? { ...grant, tutor_expires_at: new Date(T0 - 1000).toISOString() } : grant] });
  const store = new SupabaseSessionStore(db, { now, pollMs: 1, inflightTimeoutMs: 500 });
  const deps: KitTurnDeps = { store, entitlements: new SupabaseEntitlements(db), teacherProvider: opts.teacher, now };
  return { db, store, deps };
}

async function run(deps: KitTurnDeps, segmentKey = "p1:s001", question?: string): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const ev of runKitExplain(deps, { studentId: STUDENT, productSlug: SLUG, manifest: kitManifest(), segmentKey, question, language: "English" })) out.push(ev);
  return out;
}
const text = (evs: SseEvent[]) => evs.filter((e) => e.event === "text").map((e) => e.data).join("");
const done = (evs: SseEvent[]) => evs.find((e) => e.event === "done")!.data as { metered?: { live_turns: number }; label: string; trimmed?: boolean };

describe("kit explain: metering stays in place", () => {
  it("one explain turn on kit content → exactly one sk_usage live_turns, keyed on the product uuid and month", async () => {
    const teacher = new StubProvider([{ text: ["A cell is the smallest unit of life. ", "Every living thing is made of cells."] }]);
    const h = harness({ teacher });
    const evs = await run(h.deps);
    expect(text(evs)).toBe("A cell is the smallest unit of life. Every living thing is made of cells.");
    expect(done(evs)).toMatchObject({ metered: { live_turns: 1, generated_segments: 0 }, label: "grounded" });
    expect(teacher.calls).toHaveLength(1);
    expect(h.db.rows("sk_usage")).toEqual([{ user_id: STUDENT, product_id: PRODUCT, period: "2026-10", live_turns: 1, generated_segments: 0, interactive_ms: 0, updated_at: expect.any(String) }]);
    await run(h.deps, "p1:s001", "why are cells small?");
    expect(h.db.rows("sk_usage")[0]).toMatchObject({ live_turns: 2 });
  });

  it("the model is given the section's narration as DATA, and nothing else's", async () => {
    const teacher = new StubProvider([{ text: ["A cell is the smallest unit of life."] }]);
    const h = harness({ teacher });
    await run(h.deps);
    const sys = teacher.calls[0]!.system;
    expect(sys).toContain('<teaching data_only="true">');
    expect(sys).toContain(NARRATION_0);
    expect(sys).not.toContain("Plant cells have a cell wall");
  });

  it("without tutor access: SK's own line, no model call, nothing metered", async () => {
    const teacher = new StubProvider([{ text: ["never"] }]);
    const h = harness({ teacher, expiredTutor: true });
    const evs = await run(h.deps);
    expect(text(evs)).toBe(LIVE_ENDED_TEXT);
    expect(done(evs).metered).toBeUndefined();
    expect(teacher.calls).toHaveLength(0);
    expect(h.db.rows("sk_usage")).toEqual([]);
  });

  it("no teacher wired: SK says so and nothing is metered", async () => {
    const h = harness();
    const evs = await run(h.deps);
    expect(text(evs)).toBe(NO_TEACHER_TEXT);
    expect(h.db.rows("sk_usage")).toEqual([]);
  });

  it("an unknown section: no model call, nothing metered", async () => {
    const teacher = new StubProvider([{ text: ["never"] }]);
    const h = harness({ teacher });
    const evs = await run(h.deps, "p9:nope");
    expect(done(evs).label).toBe("declined");
    expect(teacher.calls).toHaveLength(0);
    expect(h.db.rows("sk_usage")).toEqual([]);
  });

  it("§9.3: a sentence with a number the kit never says is dropped; if nothing survives SK reads the heading and points (still metered)", async () => {
    const teacher = new StubProvider([{ text: ["There are 37 trillion cells in you."] }]);
    const h = harness({ teacher });
    const evs = await run(h.deps);
    expect(text(evs)).toBe("What is a cell? Cells are the basic unit of life.");
    expect(done(evs)).toMatchObject({ trimmed: true, metered: { live_turns: 1 } });
    expect(h.db.rows("sk_usage")[0]).toMatchObject({ live_turns: 1 });
  });
});
