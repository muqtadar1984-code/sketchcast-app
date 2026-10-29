// SK S6 slice A — DELETE /api/sk/memory ("Delete my SK memory", design
// decision 7): session-gated, own memory, and a VERIFIED child's with
// ?child=<id>. The delete logic itself is in src/sk/__tests__/s6-memory.test.ts.
// Run: node node_modules/vitest/vitest.mjs run src/app/api/sk/__tests__/memory.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHILD, PARENT, S6Db, s6World, UNLINKED_CHILD } from "@/sk/__tests__/s6-fake-db";

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), createAdminClient: vi.fn() }));
vi.mock("@/utils/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/utils/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));

import { DELETE } from "@/app/api/sk/memory/route";

let session: S6Db;
let admin: S6Db;

function signedIn(id: string | null) {
  mocks.createClient.mockResolvedValue(Object.assign(session, { auth: { getUser: async () => ({ data: { user: id ? { id } : null } }) } }));
}
const del = (q = "") => DELETE(new Request(`http://x/api/sk/memory${q}`, { method: "DELETE" }));

beforeEach(() => {
  session = s6World();
  session.rows("sk_workflow_facts").push({ owner_id: PARENT, kind: "recent_kit", key: "k" });
  admin = new S6Db({
    sk_learning_facts: [
      { id: "l1", student_id: CHILD },
      { id: "l2", student_id: UNLINKED_CHILD },
    ],
    sk_sessions: [
      { id: "s1", student_id: CHILD, history: [{ role: "user", text: "q" }] },
      { id: "s2", student_id: UNLINKED_CHILD, history: [{ role: "user", text: "q" }] },
    ],
    sk_events: [],
  });
  mocks.createAdminClient.mockReturnValue(admin);
  // SK switched OFF: deleting your memory must still work.
  delete process.env.FEATURE_SK;
});
afterEach(() => vi.clearAllMocks());

describe("DELETE /api/sk/memory", () => {
  it("401 when not signed in; nothing is touched", async () => {
    signedIn(null);
    const res = await del();
    expect(res.status).toBe(401);
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(session.log).toEqual([]);
  });
  it("own: deletes the caller's memory and returns counts (works with FEATURE_SK off)", async () => {
    signedIn(PARENT);
    const res = await del();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, scope: "own", deleted: { workflowFacts: 1, learningFacts: 0, sessionsCleared: 0, turnsCleared: 0 } });
    expect(session.rows("sk_workflow_facts")).toEqual([]);
  });
  it("?child=: a verified parent deletes that child's learning facts and tutor history", async () => {
    signedIn(PARENT);
    const res = await del(`?child=${CHILD}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, scope: "child", deleted: { workflowFacts: 0, learningFacts: 1, sessionsCleared: 1, turnsCleared: 0 } });
    expect(admin.rows("sk_learning_facts").map((r) => r.id)).toEqual(["l2"]);
    expect(admin.rows("sk_sessions").find((r) => r.id === "s2")!.history).toHaveLength(1);
    // the parent's own workflow facts are untouched by a child delete
    expect(session.rows("sk_workflow_facts")).toHaveLength(1);
  });
  it("?child= an unlinked child → 403, and the service-role client is never made", async () => {
    signedIn(PARENT);
    const res = await del(`?child=${UNLINKED_CHILD}`);
    expect(res.status).toBe(403);
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(admin.rows("sk_learning_facts")).toHaveLength(2);
  });
  it("?child= that is not an id → 400", async () => {
    signedIn(PARENT);
    expect((await del("?child=me")).status).toBe(400);
  });
});
