import { describe, it, expect } from "vitest";
import { SHARED_DEMO_PASSWORD, demoAccountPassword, partitionByDemo, demoSchoolIds } from "../demo";

describe("demoAccountPassword — what the console's Password column shows", () => {
  it("seed-school.ts tenant adults (@{slug}.sketchcast.app subdomains) get the shared demo password", () => {
    expect(demoAccountPassword("principal@demo.sketchcast.app")).toBe(SHARED_DEMO_PASSWORD);
    expect(demoAccountPassword("teacher3@demo.sketchcast.app")).toBe(SHARED_DEMO_PASSWORD);
    expect(demoAccountPassword("parent@demo.sketchcast.app")).toBe(SHARED_DEMO_PASSWORD);
    expect(demoAccountPassword("teacher1@demo2.sketchcast.app")).toBe(SHARED_DEMO_PASSWORD);
  });

  it("seeded tenant students are covered only WITH a school — the seeder always attaches one", () => {
    expect(demoAccountPassword("aisha.rahman@students.sketchcast.app", "school-1")).toBe(SHARED_DEMO_PASSWORD);
    expect(demoAccountPassword("wei.jian@students.sketchcast.app", "school-1")).toBe(SHARED_DEMO_PASSWORD);
  });

  it("the 6/29 standalone seed students (students domain, NO school) show — : their password predates the seeder", () => {
    expect(demoAccountPassword("julia.rossi@students.sketchcast.app", null)).toBeNull();
    expect(demoAccountPassword("emma.wilson@students.sketchcast.app")).toBeNull();
  });

  it("hand-made accounts on the BARE domain are not covered (principal.test was founder-created)", () => {
    expect(demoAccountPassword("principal.test@sketchcast.app")).toBeNull();
    expect(demoAccountPassword("principal.test@sketchcast.app", "test-academy-id")).toBeNull();
  });

  it("older supabase/seed_demo.mjs accounts are NOT covered (local-only, different password)", () => {
    expect(demoAccountPassword("demo.principal@sketchcast.app")).toBeNull();
    expect(demoAccountPassword("demo.s1@students.sketchcast.app")).toBeNull();
    expect(demoAccountPassword("Demo.S2@students.sketchcast.app", null)).toBeNull(); // case-insensitive
  });

  it("missing email shows — , never a password that might not work", () => {
    expect(demoAccountPassword(undefined)).toBeNull();
    expect(demoAccountPassword("")).toBeNull();
  });

  it("any account the caller KNOWS is demo shares the password (2026-08-18 reset: 53/53 verified)", () => {
    // The founder's consumer-demo accounts match no provenance pattern —
    // the is_demo flag answers instead.
    expect(demoAccountPassword("muqtadar1984+hsdemo@gmail.com", null, true)).toBe(SHARED_DEMO_PASSWORD);
    expect(demoAccountPassword("adam.demo@students.sketchcast.app", null, true)).toBe(SHARED_DEMO_PASSWORD);
    // And the flag never widens coverage for REAL accounts.
    expect(demoAccountPassword("someone@gmail.com", null, false)).toBeNull();
    expect(demoAccountPassword("someone@gmail.com", null, null)).toBeNull();
  });
});

describe("partitionByDemo — roster split for the Users tabs", () => {
  it("only is_demo === true lands in the demo bucket; false/null/missing stay real", () => {
    const rows = [
      { id: "a", is_demo: true },
      { id: "b", is_demo: false },
      { id: "c", is_demo: null },
      { id: "d" },
    ];
    const { real, demo } = partitionByDemo(rows);
    expect(demo.map((r) => r.id)).toEqual(["a"]);
    expect(real.map((r) => r.id)).toEqual(["b", "c", "d"]);
  });

  it("empty input yields two empty lists", () => {
    expect(partitionByDemo([])).toEqual({ real: [], demo: [] });
  });
});

describe("demoSchoolIds — which schools the Overview excludes", () => {
  it("a school whose members are all demo is a demo school", () => {
    const ids = demoSchoolIds([
      { school_id: "s1", is_demo: true },
      { school_id: "s1", is_demo: true },
    ]);
    expect(ids.has("s1")).toBe(true);
  });

  it("one real member keeps the school real", () => {
    const ids = demoSchoolIds([
      { school_id: "s1", is_demo: true },
      { school_id: "s1", is_demo: false },
      { school_id: "s2", is_demo: true },
    ]);
    expect(ids.has("s1")).toBe(false);
    expect(ids.has("s2")).toBe(true);
  });

  it("members with null/absent is_demo count as real; profiles without a school are ignored", () => {
    const ids = demoSchoolIds([
      { school_id: "s1", is_demo: null },
      { school_id: null, is_demo: true },
      { is_demo: true },
    ]);
    expect(ids.size).toBe(0);
  });
});
