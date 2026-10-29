/**
 * S4 — resolveChild and ctx.children: a parent's question is only ever about
 * one of HER verified children. By name or id against ctx.children only; two
 * plausible matches ask; no child named + 2 children = all of them; any other
 * id (a sibling's family, a classmate, a forged uuid) is refused.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/capabilities/__tests__/child-scope.test.ts
 */
import { describe, expect, it } from "vitest";
import { isVerifiedChild, resolveChild, verifiedChildren } from "../child-scope";
import { buildContext, childrenFromLinks, loadContext } from "@/sk/shell/context";
import { ALL_FLAGS, NOW, fakeSession, makeCtx } from "@/sk/shell/__tests__/fixtures";
import { A1, A2, B1, LINKS, PA, PB, X, parentCtx } from "./parent-fixtures";

const ids = (r: ReturnType<typeof resolveChild>) => (r.kind === "children" ? r.children.map((c) => c.id) : r.kind);

describe("childrenFromLinks", () => {
  it("keeps only the parent's own links, with first name, source, verified and school", () => {
    const kids = childrenFromLinks(PA, LINKS);
    expect(kids.map((k) => [k.id, k.firstName, k.source, k.verified, k.schoolId])).toEqual([
      [A1, "Aisyah", "self", true, null],
      [A2, "Adam", "school", true, expect.any(String)],
    ]);
    expect(childrenFromLinks(PB, LINKS).map((k) => k.id)).toEqual([B1]);
  });
  it("marks an unverified link and drops duplicates and self-links", () => {
    const kids = childrenFromLinks(PA, [
      { parent_id: PA, child_id: A1, source: "self", verified_at: null, profiles: { full_name: "Aisyah Rahman" } },
      { parent_id: PA, child_id: A1, source: "self", verified_at: "2026-01-01", profiles: { full_name: "Aisyah Rahman" } },
      { parent_id: PA, child_id: PA, source: "self", verified_at: "2026-01-01", profiles: { full_name: "Me" } },
    ]);
    expect(kids).toHaveLength(1);
    expect(kids[0].verified).toBe(false);
  });
  it("buildContext carries children; loadContext reads them from the parent's own links", async () => {
    const ctx = buildContext({ user: { id: PA, email: null }, role: "parent", schoolId: null, hat: null, coordinatorScope: [], plan: "pro", staff: false, flags: ALL_FLAGS, collector: null, now: NOW, children: childrenFromLinks(PA, LINKS) });
    expect(ctx.children?.map((c) => c.firstName)).toEqual(["Aisyah", "Adam"]);
    const prev = process.env.FEATURE_PARENT_PORTAL;
    process.env.FEATURE_PARENT_PORTAL = "true";
    try {
      const log: string[] = [];
      const loaded = await loadContext({ session: fakeSession({ parent_links: LINKS, coordinator_scope: [], schools: [{ config: {} }] }, { log }), admin: null, user: { id: PA, email: "pa@x" }, profile: { role: "parent", school_id: null }, collector: null, now: NOW });
      expect(loaded.children?.map((c) => c.id)).toEqual([A1, A2]); // PB's link dropped in code
      expect(loaded.flags.hasChildren).toBe(true);
      expect(loaded.flags.schoolParent).toBe(true);
      expect(log.some((l) => l.startsWith("parent_links.eq") && l.includes(PA))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.FEATURE_PARENT_PORTAL;
      else process.env.FEATURE_PARENT_PORTAL = prev;
    }
  });
});

describe("resolveChild", () => {
  const ctx = parentCtx(PA);
  it("no child named + 2 children → both (one block each)", () => {
    expect(ids(resolveChild(ctx, undefined))).toEqual([A1, A2]);
    expect(ids(resolveChild(ctx, "my kids"))).toEqual([A1, A2]);
    expect(ids(resolveChild(ctx, "anak-anak saya"))).toEqual([A1, A2]);
    expect(ids(resolveChild(ctx, "أطفالي"))).toEqual([A1, A2]);
    expect(ids(resolveChild(ctx, "both"))).toEqual([A1, A2]);
  });
  it("one child → that child", () => {
    expect(ids(resolveChild(parentCtx(PB), undefined))).toEqual([B1]);
    expect(ids(resolveChild(parentCtx(PB), "my son"))).toEqual([B1]);
  });
  it("by first name, full name, possessive, prefix, or id", () => {
    expect(ids(resolveChild(ctx, "Aisyah"))).toEqual([A1]);
    expect(ids(resolveChild(ctx, "adam rahman"))).toEqual([A2]);
    expect(ids(resolveChild(ctx, "Adam's"))).toEqual([A2]);
    expect(ids(resolveChild(ctx, "Ais"))).toEqual([A1]);
    expect(ids(resolveChild(ctx, A2))).toEqual([A2]);
  });
  it("ambiguous → ask with the parent's own children only", () => {
    const r = resolveChild(ctx, "Rahman");
    expect(r.kind).toBe("ask");
    if (r.kind === "ask") expect(r.candidates.map((c) => c.id).sort()).toEqual([A1, A2].sort());
  });
  it("a child id not in ctx.children is REFUSED (another family, a classmate, a forged uuid)", () => {
    for (const forged of [B1, X, "99999999-9999-4999-8999-999999999999"]) expect(resolveChild(ctx, forged)).toEqual({ kind: "refused", reason: "not_linked" });
    expect(resolveChild(ctx, "Zara")).toEqual({ kind: "refused", reason: "not_linked" });
    expect(isVerifiedChild(ctx, B1)).toBe(false);
    expect(isVerifiedChild(ctx, A1)).toBe(true);
  });
  it("an unverified link is never answered about; no links = no children", () => {
    const u = parentCtx(PA);
    u.children = u.children!.map((c) => (c.id === A2 ? { ...c, verified: false } : c));
    expect(resolveChild(u, "Adam").kind).toBe("unverified");
    expect(resolveChild(u, A2).kind).toBe("unverified");
    expect(ids(resolveChild(u, undefined))).toEqual([A1]);
    expect(verifiedChildren(u).map((c) => c.id)).toEqual([A1]);
    expect(isVerifiedChild(u, A2)).toBe(false);
    expect(resolveChild(makeCtx({ role: "parent", userId: PA }), undefined)).toEqual({ kind: "refused", reason: "no_children" });
  });
  it("the page's selected learner narrows the default only when it is a verified child", () => {
    const onPage = makeCtx({ role: "parent", userId: PA, selection: { learnerId: A2 } });
    onPage.children = childrenFromLinks(PA, LINKS);
    expect(ids(resolveChild(onPage, undefined))).toEqual([A2]);
    const forged = makeCtx({ role: "parent", userId: PA, selection: { learnerId: B1 } });
    forged.children = childrenFromLinks(PA, LINKS);
    expect(ids(resolveChild(forged, undefined))).toEqual([A1, A2]);
  });
});
