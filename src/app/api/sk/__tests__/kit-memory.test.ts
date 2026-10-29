/**
 * SK S6 slice A — the S3 kit tutor and consent (Final Plan §9.5; S6 design
 * decision 3), through POST /api/sk/kit/answer on the chapter 5 kit:
 *   * the attempt (item_attempts) and the objective mastery
 *     (sk_objective_mastery) are EDUCATIONAL RECORDS — written with or
 *     without consent (§9.5: "existing rules");
 *   * the misconception rung 1 names becomes an sk_learning_facts row ONLY
 *     with `transcripts` consent (facts.ts noteLearning);
 *   * the kit session keeps no conversation: history stays [].
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));

import { POST as answer } from "@/app/api/sk/kit/answer/route";
import { SupabaseEntitlements } from "@/sk/entitlement";
import { noteLearning } from "@/sk/facts";
import { SupabaseItemBank } from "@/sk/items-supabase";
import { __setKitDepsForTests, type KitAdmin, type KitDeps } from "@/sk/kit-server";
import { kitSessionProduct } from "@/sk/kit-answer";
import { ProductKits } from "@/sk/product-kits";
import { SupabaseSessionStore } from "@/sk/store-supabase";
import type { FakeDb } from "@/sk/__tests__/fake-supabase";
import { kitManifest, kitWorld, SLUG, STUDENT, T0 } from "@/sk/__tests__/kit-fixtures";
import { CH5_KIT, ch5Manifest, O2_KEY, RBC_MCQ, seedCh5 } from "@/sk/__tests__/remediation-fixtures";
import { S6Db } from "@/sk/__tests__/s6-fake-db";

const PARENT = "11111111-1111-4111-8111-111111111111";
const signedIn = (id: string) => mocks.createClient.mockResolvedValue({ auth: { getUser: async () => ({ data: { user: { id } } }) } });
let n = 0;
const eid = () => `0192f5c0-0000-7000-8000-${String(++n).padStart(12, "0")}`;
let clock = T0;

/** The consent side: the student's profile, a verified parent, consent or not. */
function memoryDb(consent: boolean): S6Db {
  return new S6Db({
    profiles: [{ id: STUDENT, role: "student", school_id: null }],
    parent_links: [{ parent_id: PARENT, child_id: STUDENT, verified_at: "2026-10-01T00:00:00Z" }],
    consents: consent ? [{ child_id: STUDENT, guardian_id: PARENT, scope: "transcripts", revoked_at: null }] : [],
    sk_learning_facts: [],
  });
}

function install(mem: S6Db): FakeDb {
  const db = seedCh5(kitWorld());
  const admin: KitAdmin = { from: (t: string) => db.from(t), storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: "https://signed.example/x" }, error: null }) }) } };
  const read = vi.fn(async (_a: KitAdmin, g: string) => ({ status: "ready" as const, manifest: g === CH5_KIT ? ch5Manifest() : kitManifest(), builtAt: new Date(T0).toISOString() }));
  const entitlements = new SupabaseEntitlements(db);
  const deps: Partial<KitDeps> = {
    kits: new ProductKits(db, entitlements, () => new Date(T0)),
    admin: () => admin,
    read,
    derive: read,
    items: () => new SupabaseItemBank(db),
    store: new SupabaseSessionStore(db, { now: () => clock, pollMs: 1, inflightTimeoutMs: 500 }),
    entitlements,
    now: () => (clock += 1000),
    // the production wiring, pointed at the consent-side fake
    noteLearning: (_a, studentId, note) => noteLearning(mem, studentId, note),
  };
  __setKitDepsForTests(deps);
  return db;
}

const send = async (itemId: string, response: unknown) => {
  const res = await answer(new Request("http://x/api/sk/kit/answer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ product: SLUG, chapter: "5", itemId, response, eventId: eid() }) }));
  return { status: res.status, body: (await res.json()) as { outcome: string; rungs: { rung: number; kind: string }[] } };
};
const WRONG = ["The nucleus would make the cell too red.", "The cell can then divide more quickly.", "The cell can then repair itself more easily."];

beforeEach(() => {
  process.env.FEATURE_SK = "true";
  signedIn(STUDENT);
  clock = T0;
});
afterEach(() => {
  __setKitDepsForTests(null);
  delete process.env.FEATURE_SK;
  vi.clearAllMocks();
});

describe("S6: the kit tutor's memory follows consent; its educational records do not", () => {
  it("WITHOUT consent: the misconception is NOT remembered; attempts and mastery are still recorded (§9.5)", async () => {
    const mem = memoryDb(false);
    const db = install(mem);
    for (const r of WRONG) await send(RBC_MCQ, r);
    expect(mem.rows("sk_learning_facts")).toEqual([]);
    expect(mem.touched("sk_learning_facts")).toEqual([]);
    // educational records: unchanged by consent
    expect(db.rows("item_attempts").filter((r) => r.item_id === RBC_MCQ)).toHaveLength(3);
    expect(db.rows("sk_objective_mastery").find((r) => r.student_id === STUDENT && r.objective_key === O2_KEY)).toMatchObject({ status: "needs_work" });
    // no conversation kept in the kit session
    const s = db.rows("sk_sessions").find((r) => r.product_id === kitSessionProduct(CH5_KIT))!;
    expect(s.history).toEqual([]);
  });

  it("WITH consent: rung 1's named misconception becomes ONE learning fact (no student answer in it)", async () => {
    const mem = memoryDb(true);
    const db = install(mem);
    const a1 = await send(RBC_MCQ, WRONG[0]);
    expect(a1.body.rungs[0]).toMatchObject({ rung: 1, kind: "misconception" });
    await send(RBC_MCQ, WRONG[1]); // rung 2: a hint, nothing new to remember
    const facts = mem.rows("sk_learning_facts");
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      student_id: STUDENT,
      kind: "misconception",
      objective_key: O2_KEY,
      source: "sk.kit.remediation",
      detail: { item_id: RBC_MCQ, misconception: "Red blood cells have a nucleus like other cells and the nucleus makes them red.", attempt_no: 1 },
    });
    expect(JSON.stringify(facts[0])).not.toContain(WRONG[0]);
    expect(db.rows("item_attempts").filter((r) => r.item_id === RBC_MCQ)).toHaveLength(2);
    expect(db.rows("sk_sessions").find((r) => r.product_id === kitSessionProduct(CH5_KIT))!.history).toEqual([]);
  });

  it("a failing memory write never fails the marking", async () => {
    const mem = memoryDb(true);
    mem.fail.add("sk_learning_facts");
    vi.spyOn(console, "error").mockImplementation(() => {});
    install(mem);
    const a1 = await send(RBC_MCQ, WRONG[0]);
    expect(a1.status).toBe(200);
    expect(a1.body.outcome).toBe("incorrect");
  });
});
