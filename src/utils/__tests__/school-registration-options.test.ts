import { describe, it, expect } from "vitest";
import { pickOption, previewSlug, SCHOOL_TYPES, SIZE_BANDS, REGISTRANT_ROLES, CURRICULA } from "../school-registration-options";
import en from "../../i18n/messages/en.json";

describe("previewSlug — what the form promises matches what 0042/0100 mint", () => {
  it("lowercases, collapses runs of non-alphanumerics, trims dashes", () => {
    expect(previewSlug("Sekolah  Kebangsaan (Taman) Bukit!")).toBe("sekolah-kebangsaan-taman-bukit");
    expect(previewSlug("  ABC School  ")).toBe("abc-school");
  });
  it("falls back for a name with nothing usable — and 'school' is itself reserved, so it lands on school-school", () => {
    // Same two steps as the DB: school_slugify() → 'school', then the 0100
    // reserved-slug rule appends -school. Before 0100 such a school got the
    // bare slug `school`, which the portal proxy never routed to a tenant.
    expect(previewSlug("!!!")).toBe("school-school");
    expect(previewSlug("学校")).toBe("school-school");
  });
  it("steers a proxy-reserved word to -school, like set_school_slug()", () => {
    expect(previewSlug("Dashboard")).toBe("dashboard-school");
    expect(previewSlug("Present")).toBe("present-school");
    expect(previewSlug("Dashboard Academy")).toBe("dashboard-academy");
  });
});

describe("pickOption — the route's second gate", () => {
  it("returns the value only when it is in the set", () => {
    expect(pickOption("primary", SCHOOL_TYPES)).toBe("primary");
    expect(pickOption("PRIMARY", SCHOOL_TYPES)).toBeNull();
    expect(pickOption("evil", SIZE_BANDS)).toBeNull();
    expect(pickOption(1, REGISTRANT_ROLES)).toBeNull();
    expect(pickOption(undefined, CURRICULA)).toBeNull();
  });
});

describe("every option has a label in the English dictionary", () => {
  const t = en.app.schoolSignup.finish;
  it("school types", () => {
    for (const k of SCHOOL_TYPES) expect(t.types[k], k).toBeTruthy();
    expect(Object.keys(t.types).sort()).toEqual([...SCHOOL_TYPES].sort());
  });
  it("size bands", () => {
    for (const k of SIZE_BANDS) expect(t.sizes[k], k).toBeTruthy();
    expect(Object.keys(t.sizes).sort()).toEqual([...SIZE_BANDS].sort());
  });
  it("roles", () => {
    for (const k of REGISTRANT_ROLES) expect(t.roles[k], k).toBeTruthy();
    expect(Object.keys(t.roles).sort()).toEqual([...REGISTRANT_ROLES].sort());
  });
  it("curricula", () => {
    for (const k of CURRICULA) expect(t.curriculumOptions[k], k).toBeTruthy();
    expect(Object.keys(t.curriculumOptions).sort()).toEqual([...CURRICULA].sort());
  });
});
