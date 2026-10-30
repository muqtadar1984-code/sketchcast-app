/**
 * The lesson map prepared at adopt time (utils/present/adopt-map.ts), over the
 * real deriveAndStore and an in-memory database (no model is ever called live:
 * every derive gets a stub `call`).
 *   - the source already has a map → her copy gets it COPIED: ready, no model call;
 *   - the first copy of a source → ONE build (the two Haiku passes), and a
 *     second adopt of the same kit (idempotent) builds nothing more;
 *   - the Shell off for her → nothing is built;
 *   - one sk_actions row (manifest.build, via adopt).
 * Run: node node_modules/vitest/vitest.mjs run src/utils/__tests__/present-adopt-map.test.ts
 */
import { describe, expect, it, vi } from "vitest";
import { prepareAdoptedMap, type AdoptMapDeps } from "@/utils/present/adopt-map";
import { deriveAndStore, type ModelCall } from "@/sk/manifest/service";
import { readManifest } from "@/sk/manifest/store";
import type { SkActionRow } from "@/sk/shell/types";
import { A_GEN, ANNE, NOW, SRC, model, world } from "@/sk/manifest/__tests__/adopted-world";

/* eslint-disable @typescript-eslint/no-explicit-any */
function session(user: { id: string } | null) {
  return {
    auth: { getUser: async () => ({ data: { user } }) },
    from: () => {
      const b: any = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = async () => ({ data: { role: "teacher", school_id: null }, error: null });
      return b;
    },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function deps(admin: unknown, call: ModelCall, over: Partial<AdoptMapDeps> = {}) {
  const audit: SkActionRow[] = [];
  const d: AdoptMapDeps = {
    session: session({ id: ANNE }),
    admin,
    derive: (a, g) => deriveAndStore(a, g, { now: NOW, call }),
    audit: async (r) => void audit.push(r),
    shellOn: async () => true,
    ...over,
  };
  return { d, audit };
}

describe("prepareAdoptedMap", () => {
  it("the source already has a map → her copy's map is copied: ready, no model call", async () => {
    const a = world();
    await deriveAndStore(a, SRC, { now: NOW, call: model }); // the SK tutor built the source's map
    const call = vi.fn(model);
    const { d, audit } = deps(a, call);
    const out = await prepareAdoptedMap(d, A_GEN);
    expect(out).toEqual({ ran: true, status: "ready", copiedFrom: SRC });
    expect(call).not.toHaveBeenCalled();
    expect((await readManifest(a, A_GEN, NOW)).status).toBe("ready");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_id: ANNE, action: "manifest.build", kind: "job", params: { generationId: A_GEN, via: "adopt" }, ok: true, result: { status: "ready", copiedFrom: SRC }, generation_id: A_GEN });
  });

  it("the first copy of a source builds ONCE; adopting it again builds nothing more", async () => {
    const a = world();
    const call = vi.fn(model);
    const { d } = deps(a, call);
    expect(await prepareAdoptedMap(d, A_GEN)).toEqual({ ran: true, status: "ready", copiedFrom: null });
    expect(call).toHaveBeenCalledTimes(2); // one derivation = the concept pass + the item pass
    expect(await prepareAdoptedMap(d, A_GEN)).toEqual({ ran: true, status: "ready", copiedFrom: null });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("the Shell off for her, or no user → nothing is built", async () => {
    const derive = vi.fn();
    expect(await prepareAdoptedMap({ session: session({ id: ANNE }), admin: world(), derive, shellOn: async () => false }, A_GEN)).toEqual({ ran: false, why: "shell_off" });
    expect(await prepareAdoptedMap({ session: session(null), admin: world(), derive }, A_GEN)).toEqual({ ran: false, why: "no_user" });
    expect(derive).not.toHaveBeenCalled();
  });

  it("never throws", async () => {
    const out = await prepareAdoptedMap({ session: session({ id: ANNE }), admin: world(), derive: async () => Promise.reject(new Error("boom")), shellOn: async () => true }, A_GEN);
    expect(out).toEqual({ ran: false, why: "error" });
  });
});
