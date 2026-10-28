/**
 * SK Shell memory blob (§5.4, §9.5): seal/open round trip; a tampered blob, a
 * context change (hat/school/role/plan) or a 4-hour gap each start fresh.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/memory.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SK_MEMORY_MAX_ENTITIES, SK_MEMORY_MAX_TURNS, freshMemory, openMemory, rememberTurn, sealMemory, verifyMemory } from "../memory";
import { NOW, makeCtx } from "./fixtures";

const saved = { shell: process.env.SK_SHELL_SECRET, book: process.env.BOOK_CODE_SECRET };
beforeEach(() => {
  process.env.SK_SHELL_SECRET = "unit-test-secret-of-adequate-length";
  delete process.env.BOOK_CODE_SECRET;
});
afterEach(() => {
  if (saved.shell === undefined) delete process.env.SK_SHELL_SECRET;
  else process.env.SK_SHELL_SECRET = saved.shell;
  if (saved.book === undefined) delete process.env.BOOK_CODE_SECRET;
  else process.env.BOOK_CODE_SECRET = saved.book;
});

const ctx = makeCtx();

describe("seal / open", () => {
  it("round-trips a memory and keeps its session id", () => {
    const m = rememberTurn(freshMemory(ctx, NOW), { user: "show 7B", assistant: "Opening.", entities: [{ kind: "class", id: "c1", label: "7B", via: "context.resolve" }] }, NOW);
    const blob = sealMemory(m);
    expect(blob).toMatch(/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/);
    const opened = openMemory(blob, ctx, new Date(NOW.getTime() + 60_000));
    expect(opened.fresh).toBe(false);
    expect(opened.reason).toBe("ok");
    expect(opened.memory.sessionId).toBe(m.sessionId);
    expect(opened.memory.entities).toEqual(m.entities);
    expect(opened.memory.turns).toHaveLength(2);
  });
  it("a missing blob starts fresh", () => {
    const o = openMemory(undefined, ctx, NOW);
    expect(o.fresh).toBe(true);
    expect(o.reason).toBe("none");
    expect(o.memory.contextHash).toBe(ctx.contextHash);
  });
  it("a tampered payload or signature → fresh (reason invalid)", () => {
    const blob = sealMemory(freshMemory(ctx, NOW));
    const [payload, sig] = blob.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), pending: { task: "assign", needs: [] } })).toString("base64url");
    expect(openMemory(`${forgedPayload}.${sig}`, ctx, NOW).reason).toBe("invalid");
    expect(openMemory(`${payload}.${"0".repeat(64)}`, ctx, NOW).reason).toBe("invalid");
    expect(openMemory("garbage", ctx, NOW).reason).toBe("invalid");
    expect(verifyMemory(`${payload}.${sig.slice(0, 10)}`)).toBeNull();
  });
  it("a blob signed under another secret → fresh", () => {
    const blob = sealMemory(freshMemory(ctx, NOW));
    process.env.SK_SHELL_SECRET = "a-different-secret-of-adequate-length";
    expect(openMemory(blob, ctx, NOW).reason).toBe("invalid");
  });
  it("a context change (hat) → fresh (reason context_changed)", () => {
    const blob = sealMemory(freshMemory(ctx, NOW));
    const principal = makeCtx({ role: "school_admin", hat: "principal" });
    const o = openMemory(blob, principal, NOW);
    expect(o.reason).toBe("context_changed");
    expect(o.memory.contextHash).toBe(principal.contextHash);
    expect(openMemory(blob, makeCtx({ plan: "trial" }), NOW).reason).toBe("context_changed");
    expect(openMemory(blob, makeCtx({ schoolId: null }), NOW).reason).toBe("context_changed");
  });
  it("a gap over four hours → fresh; under it → kept", () => {
    const blob = sealMemory(freshMemory(ctx, NOW));
    expect(openMemory(blob, ctx, new Date(NOW.getTime() + 4 * 3600_000 + 1)).reason).toBe("gap");
    expect(openMemory(blob, ctx, new Date(NOW.getTime() + 4 * 3600_000 - 1)).reason).toBe("ok");
  });
  it("falls back to BOOK_CODE_SECRET, then to a per-process secret", () => {
    delete process.env.SK_SHELL_SECRET;
    process.env.BOOK_CODE_SECRET = "book-code-secret-of-adequate-length";
    const blob = sealMemory(freshMemory(ctx, NOW));
    expect(openMemory(blob, ctx, NOW).reason).toBe("ok");
    delete process.env.BOOK_CODE_SECRET;
    const blob2 = sealMemory(freshMemory(ctx, NOW));
    expect(openMemory(blob2, ctx, NOW).reason).toBe("ok"); // same process
    expect(openMemory(blob, ctx, NOW).reason).toBe("invalid"); // other secret
  });
});

describe("rememberTurn", () => {
  it("caps entities at 10 (newest first, de-duplicated) and turns at 6 of ≤400 chars", () => {
    let m = freshMemory(ctx, NOW);
    for (let i = 0; i < 12; i++) {
      m = rememberTurn(m, { user: `q${i} ` + "x".repeat(500), assistant: `a${i}`, entities: [{ kind: "class", id: `c${i}`, label: `C${i}`, via: "t" }, { kind: "class", id: "c0", label: "C0", via: "t" }] }, NOW);
    }
    expect(m.entities).toHaveLength(SK_MEMORY_MAX_ENTITIES);
    expect(m.entities[0].id).toBe("c11");
    expect(m.entities.filter((e) => e.id === "c0")).toHaveLength(1);
    expect(m.turns).toHaveLength(SK_MEMORY_MAX_TURNS);
    expect(m.turns[0]).toEqual({ role: "user", text: expect.stringMatching(/^q9 /) });
    expect(m.turns[0].text.length).toBe(400);
    expect(m.turns[5]).toEqual({ role: "assistant", text: "a11" });
  });
  it("sets and clears a pending task without mutating the input", () => {
    const m0 = freshMemory(ctx, NOW);
    const m1 = rememberTurn(m0, { user: "remind parents", assistant: "Which worksheet?", pending: { task: "remind", needs: ["shareId"] } }, NOW);
    expect(m1.pending).toEqual({ task: "remind", needs: ["shareId"] });
    expect(m0.pending).toBeUndefined();
    const m2 = rememberTurn(m1, { user: "the fractions one", assistant: "Done.", pending: null }, NOW);
    expect(m2.pending).toBeUndefined();
  });
});
