/**
 * SK S3 slice C — the remediation ladder and kit attempts through
 * POST /api/sk/kit/answer, on the chapter 5 kit with REAL production bank
 * rows (src/sk/__tests__/remediation-fixtures.ts) and the schema-checking fake
 * database (sk_sessions, sk_events, item_attempts, sk_objective_mastery refuse
 * what Postgres refuses).
 *
 * Holds the S3 acceptance test (Final Plan §6 S3): "remediation ladder test:
 * wrong mcq → misconception named from the bank → hint → slide(k) →
 * verification item".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));

import { POST as answer } from "@/app/api/sk/kit/answer/route";
import { SupabaseEntitlements } from "@/sk/entitlement";
import { SupabaseItemBank } from "@/sk/items-supabase";
import type { KitGrade } from "@/sk/kit-player";
import { __setKitDepsForTests, type KitAdmin, type KitDeps } from "@/sk/kit-server";
import { kitSessionProduct } from "@/sk/kit-answer";
import { MASTERY_RULE_VERSION } from "@/sk/mastery";
import { ProductKits } from "@/sk/product-kits";
import { SupabaseSessionStore } from "@/sk/store-supabase";
import type { FakeDb } from "@/sk/__tests__/fake-supabase";
import { kitManifest, kitWorld, SLUG, STUDENT, T0 } from "@/sk/__tests__/kit-fixtures";
import { CH5_KIT, ch5Manifest, GENES_MCQ, O1_KEY, O2_KEY, RBC_FILL, RBC_MCQ, seedCh5, UNMAPPED_ITEM } from "@/sk/__tests__/remediation-fixtures";

const signedIn = (id: string | null) => mocks.createClient.mockResolvedValue({ auth: { getUser: async () => ({ data: { user: id ? { id } : null } }) } });
let n = 0;
const eid = () => `0192f5c0-0000-7000-8000-${String(++n).padStart(12, "0")}`;
let clock = T0;

function install(): FakeDb {
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
  };
  __setKitDepsForTests(deps);
  return db;
}

const send = async (itemId: string, response: unknown, over: Record<string, unknown> = {}) => {
  const res = await answer(new Request("http://x/api/sk/kit/answer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ product: SLUG, chapter: "5", itemId, response, eventId: eid(), ...over }) }));
  return { status: res.status, body: (await res.json()) as KitGrade & { error?: string; reason?: string } };
};
const mastery = (db: FakeDb, key: string) => db.rows("sk_objective_mastery").find((r) => r.student_id === STUDENT && r.objective_key === key) ?? null;

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

describe("S3 acceptance", () => {
  it("remediation ladder: wrong mcq → misconception from the bank → hint → slide(k) → verification item", async () => {
    const db = install();

    // 1. Wrong: option A, the distractor whose rationale names misconception m2.
    const a1 = await send(RBC_MCQ, "The nucleus would make the cell too red.");
    expect(a1.status).toBe(200);
    expect(a1.body).toMatchObject({ outcome: "incorrect", attemptNo: 1, triesLeft: 2, reveal: null });
    expect(a1.body.rungs).toEqual([
      {
        rung: 1,
        kind: "misconception",
        misconception: "Red blood cells have a nucleus like other cells and the nucleus makes them red.",
        correction: "Mature mammalian red blood cells have no nucleus. This leaves room for haemoglobin, and haemoglobin is what makes them red.",
      },
    ]);

    // 2. Wrong again → the hint (from the explanation; no answer text, no key).
    const a2 = await send(RBC_MCQ, "The cell can then divide more quickly.");
    expect(a2.body).toMatchObject({ outcome: "incorrect", attemptNo: 2, triesLeft: 1, reveal: null });
    expect(a2.body.rungs).toEqual([{ rung: 2, kind: "hint", text: "Losing the nucleus frees internal space so more haemoglobin fits, and each cell carries more oxygen.", from: "explanation" }]);
    for (const a of [a1, a2]) expect(JSON.stringify(a.body)).not.toContain("More space is available for haemoglobin");

    // 3. Wrong a third time → slide(k) of the section that teaches o2, and the
    //    check question: a DIFFERENT bank item on the same objective, keyless.
    const a3 = await send(RBC_MCQ, "The cell can then repair itself more easily.");
    expect(a3.body).toMatchObject({ outcome: "incorrect", attemptNo: 3, triesLeft: 0 });
    expect(a3.body.rungs).toEqual([
      { rung: 3, kind: "slide", k: 1, key: "p1:s002", heading: "Red blood cells" },
      { rung: 4, kind: "verify", itemId: RBC_FILL, via: "objective", item: { id: RBC_FILL, type: "fill_blank", prompt: "The red protein in red blood cells that binds to oxygen in the lungs is called ____.", marks: 1 } },
    ]);
    expect(a3.body.reveal).toEqual({ answer: "B. More space is available for haemoglobin.", explanation: "Losing the nucleus frees internal space so more haemoglobin fits, and each cell carries more oxygen." });
    expect(mastery(db, O2_KEY)).toMatchObject({ status: "needs_work", independent: false, rule_version: MASTERY_RULE_VERSION });

    // Every rung used is on the record: the attempts after a rung are assisted.
    const rows = db.rows("item_attempts").filter((r) => r.item_id === RBC_MCQ);
    expect(rows.map((r) => [r.attempt_no, r.hints_used, r.hint_used, r.objective_key, r.purpose, r.check_size])).toEqual([
      [1, 0, false, O2_KEY, "unit", 1],
      [2, 1, true, O2_KEY, "unit", 1],
      [3, 2, true, O2_KEY, "unit", 1],
    ]);
    expect(new Set(rows.map((r) => r.check_key)).size).toBe(1);

    // 4. The check question, right first time with no help → the objective is mastered.
    const v = await send(RBC_FILL, "haemoglobin");
    expect(v.body).toMatchObject({ outcome: "correct", attemptNo: 1, triesLeft: 0, rungs: [], reveal: null });
    expect(mastery(db, O2_KEY)).toMatchObject({ status: "mastered", independent: true });
  });
});

describe("attempts are counted and recorded on the server", () => {
  it("ignores a client attemptNo; a repeated eventId replays the stored reply and grades nothing again", async () => {
    const db = install();
    const id = eid();
    const first = await send(RBC_MCQ, "The nucleus would make the cell too red.", { eventId: id, attemptNo: 3 });
    expect(first.body.attemptNo).toBe(1);
    const again = await send(RBC_MCQ, "More space is available for haemoglobin.", { eventId: id, attemptNo: 1 });
    expect(again.body).toEqual(first.body);
    expect(db.rows("item_attempts")).toHaveLength(1);
    expect((await send(RBC_MCQ, "The cell can then divide more quickly.", { attemptNo: 1 })).body.attemptNo).toBe(2);
  });

  it("two different eventIds at once take attempts 1 and 2, never the same one", async () => {
    const db = install();
    const [x, y] = await Promise.all([send(RBC_MCQ, "The nucleus would make the cell too red."), send(RBC_MCQ, "The cell can then divide more quickly.")]);
    expect([x.body.attemptNo, y.body.attemptNo].sort()).toEqual([1, 2]);
    expect(db.rows("item_attempts").map((r) => r.attempt_no).sort()).toEqual([1, 2]);
  });

  it("at most 3 attempts: a 4th is refused and nothing is written; a right answer closes the item", async () => {
    const db = install();
    for (const r of ["The nucleus would make the cell too red.", "The cell can then divide more quickly.", "The cell can then repair itself more easily."]) await send(RBC_MCQ, r);
    const fourth = await send(RBC_MCQ, "More space is available for haemoglobin.");
    expect(fourth.status).toBe(409);
    expect(fourth.body.reason).toBe("no_tries");
    expect(db.rows("item_attempts")).toHaveLength(3);
    await send(GENES_MCQ, "Different genes are switched on in each, so different proteins are made.");
    expect((await send(GENES_MCQ, "Different genes are switched on in each, so different proteins are made.")).status).toBe(409);
  });

  it("one open kit session per student × kit × chapter, reused, product_id kit:<generation>", async () => {
    const db = install();
    await send(RBC_MCQ, "The nucleus would make the cell too red.");
    await send(GENES_MCQ, "They contain different sets of genes.");
    const sessions = db.rows("sk_sessions");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ student_id: STUDENT, product_id: kitSessionProduct(CH5_KIT), chapter: 5, status: "open" });
    expect(new Set(db.rows("item_attempts").map((r) => r.session_id))).toEqual(new Set([sessions[0]!.id]));
  });
});

describe("kit objective mastery (sk_objective_mastery, rule sk-b5.1)", () => {
  it("independent (right at attempt 1, no rung) → mastered", async () => {
    const db = install();
    await send(GENES_MCQ, "Different genes are switched on in each, so different proteins are made.");
    expect(db.rows("item_attempts")[0]).toMatchObject({ objective_key: O1_KEY, independent: true, hints_used: 0 });
    expect(mastery(db, O1_KEY)).toMatchObject({ status: "mastered", independent: true });
  });

  it("assisted (right after a rung) → provisional", async () => {
    const db = install();
    expect((await send(GENES_MCQ, "They contain different sets of genes.")).body.rungs[0]).toMatchObject({ rung: 1, kind: "misconception", misconception: "Specialised cells are different because they contain different genes." });
    const right = await send(GENES_MCQ, "Different genes are switched on in each, so different proteins are made.");
    expect(right.body).toMatchObject({ outcome: "correct", attemptNo: 2, rungs: [] });
    expect(db.rows("item_attempts")[1]).toMatchObject({ hint_used: true, hints_used: 1, independent: false });
    expect(mastery(db, O1_KEY)).toMatchObject({ status: "provisional", independent: false });
  });

  it("unmapped item (no article objective) → attempt stored with objective_key null, no mastery row", async () => {
    const db = install();
    const r = await send(UNMAPPED_ITEM, false);
    expect(r.body).toMatchObject({ outcome: "incorrect", attemptNo: 1 });
    // Not an mcq and no rationale: rung 1 is skipped; no explanation or objective, so no hint — slide(k) is next.
    expect(r.body.rungs).toEqual([{ rung: 3, kind: "slide", k: 2, key: "p1:s003", heading: "Tissues and organs" }]);
    expect(db.rows("item_attempts")[0]).toMatchObject({ objective_key: null, hints_used: 0 });
    await send(UNMAPPED_ITEM, true);
    expect(db.rows("sk_objective_mastery")).toEqual([]);
  });
});
