/**
 * Availability vocabulary (SK S0 slice C): every state is reachable, the
 * decision order holds (best first), the unknown-lock case is its own honest
 * state, and the text matcher behaves.
 * Run: node node_modules/vitest/vitest.mjs run src/utils/__tests__/availability.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  AVAILABILITY_ORDER,
  availabilityRank,
  decideAvailability,
  normText,
  queryTokens,
  textMatches,
  type AvailabilityInput,
  type AvailabilityState,
  type UnlockAllowance,
} from "../availability";

const allowance = (over: Partial<UnlockAllowance> = {}): UnlockAllowance => ({
  eligible: true,
  reason: null,
  tier: "pro",
  cap: 4,
  used: 2,
  resets_at: "2026-11-02T00:00:00Z",
  ...over,
});

const empty = (topic = "Specialised cells"): AvailabilityInput => ({ topic, library: [], catalogue: [], skBooks: [], allowance: null });

describe("textMatches / normText", () => {
  it("is case- and punctuation-insensitive and matches the whole query as a substring", () => {
    expect(normText("  Specialised Cells: Part 1! ")).toBe("specialised cells part 1");
    expect(textMatches("specialised cells", ["Cells — specialised cells and tissues"])).toBe(true);
  });
  it("matches when every token (≥3 letters) appears across the fields", () => {
    expect(textMatches("cell biology", ["Biology", null, "The cell"])).toBe(true);
    expect(textMatches("cell chemistry", ["Biology", "The cell"])).toBe(false);
  });
  it("drops short tokens unless the query is only short words", () => {
    expect(queryTokens("the cell of life")).toEqual(["the", "cell", "life"]);
    expect(queryTokens("a of")).toEqual(["a", "of"]);
  });
  it("matches nothing on an empty query or empty fields", () => {
    expect(textMatches("", ["Biology"])).toBe(false);
    expect(textMatches("cells", [null, undefined, ""])).toBe(false);
  });
});

describe("decideAvailability — every state", () => {
  const one = (input: Partial<AvailabilityInput>): AvailabilityState => decideAvailability({ ...empty(), ...input }).state;

  it("not_found when nothing matched", () => {
    const d = decideAvailability(empty());
    expect(d.state).toBe("not_found");
    expect(d.rows).toEqual([]);
    expect(d.summary).toMatch(/^No — nothing matches 'Specialised cells'/);
  });
  it("in_library for an own kit or book", () => {
    expect(one({ library: [{ kind: "kit", id: "g1", title: "Specialised cells", where: "my_library", subject: "Biology" }] })).toBe("in_library");
    expect(one({ library: [{ kind: "book", id: "b1", title: "Biology", where: "my_library", subject: "Biology" }] })).toBe("in_library");
  });
  it("on_school_shelf for a shelf book", () => {
    expect(one({ library: [{ kind: "book", id: "b2", title: "Biology", where: "school_shelf", subject: "Biology" }] })).toBe("on_school_shelf");
  });
  it("in_catalogue_unlocked / in_catalogue_locked / in_catalogue by the unlocked flag", () => {
    const c = (unlocked: boolean | null) => [{ slug: "specialised-cells", title: "Specialised Cells", subject: "Biology", language: "en", unlocked }];
    expect(one({ catalogue: c(true) })).toBe("in_catalogue_unlocked");
    expect(one({ catalogue: c(false) })).toBe("in_catalogue_locked");
    expect(one({ catalogue: c(null) })).toBe("in_catalogue");
  });
  it("sk_book_activated / sk_book_not_activated", () => {
    const b = (activated: boolean) => [{ id: "p1", slug: "cambridge-biology", title: "Cambridge Biology", subject: "Biology", activated }];
    expect(one({ skBooks: b(true) })).toBe("sk_book_activated");
    expect(one({ skBooks: b(false) })).toBe("sk_book_not_activated");
  });
  it("in_catalogue_not_yet for a topic without a kit", () => {
    expect(one({ catalogueTopicsOnly: [{ slug: "osmosis", title: "Osmosis", subject: "Biology" }] })).toBe("in_catalogue_not_yet");
  });
});

describe("decideAvailability — decision order and summaries", () => {
  it("ranks by AVAILABILITY_ORDER: usable now, then obtainable, then promised", () => {
    expect(AVAILABILITY_ORDER).toEqual([
      "in_library",
      "on_school_shelf",
      "in_catalogue_unlocked",
      "sk_book_activated",
      "in_catalogue",
      "in_catalogue_locked",
      "sk_book_not_activated",
      "in_catalogue_not_yet",
      "not_found",
    ]);
    expect(availabilityRank("in_library")).toBe(0);
    expect(availabilityRank("not_found")).toBe(8);
  });

  it("puts the best source first whatever order the inputs came in", () => {
    const d = decideAvailability({
      topic: "cells",
      skBooks: [{ id: "p1", slug: "bio", title: "Cambridge Biology", subject: "Biology", activated: false }],
      catalogue: [{ slug: "specialised-cells", title: "Specialised Cells", subject: "Biology", language: "en", unlocked: false }],
      library: [{ kind: "book", id: "b2", title: "Biology", where: "school_shelf", subject: "Biology" }],
      catalogueTopicsOnly: [{ slug: "osmosis", title: "Osmosis", subject: null }],
      allowance: allowance(),
    });
    expect(d.rows.map((r) => r.state)).toEqual(["on_school_shelf", "in_catalogue_locked", "sk_book_not_activated", "in_catalogue_not_yet"]);
    expect(d.state).toBe("on_school_shelf");
    expect(d.summary).toBe("Yes — 'Biology' is on the school shelf (4 matches in all).");
  });

  it("keeps the caller's order within a rank (own things newest first)", () => {
    const d = decideAvailability({
      ...empty(),
      library: [
        { kind: "kit", id: "g-new", title: "Cells (new)", where: "my_library", subject: null },
        { kind: "kit", id: "g-old", title: "Cells (old)", where: "my_library", subject: null },
      ],
    });
    expect(d.rows.map((r) => r.id)).toEqual(["g-new", "g-old"]);
  });

  it("a locked kit carries the unlock allowance and says it in words", () => {
    const d = decideAvailability({
      ...empty(),
      catalogue: [{ slug: "specialised-cells", title: "Specialised Cells", subject: "Biology", language: "en", unlocked: false }],
      allowance: allowance(),
    });
    expect(d.rows[0]).toMatchObject({ state: "in_catalogue_locked", unlockEligible: true, unlockUsed: 2, unlockCap: 4, unlockResetsAt: "2026-11-02T00:00:00Z" });
    expect(d.summary).toBe("There is a kit 'Specialised Cells' but it is locked. 2 of 4 unlocks used this week.");
  });

  it("an unlocked kit carries no allowance columns and reads as a yes", () => {
    const d = decideAvailability({
      ...empty(),
      catalogue: [{ slug: "specialised-cells", title: "Specialised Cells", subject: "Biology", language: "en", unlocked: true }],
      allowance: allowance(),
    });
    expect(d.rows[0]).toMatchObject({ state: "in_catalogue_unlocked", unlockEligible: null, unlockUsed: null, unlockCap: null });
    expect(d.summary).toBe("Yes — 'Specialised Cells' is in the catalogue and unlocked.");
  });

  it("the unknown-lock state says so instead of guessing, and still carries the allowance", () => {
    const d = decideAvailability({
      ...empty(),
      catalogue: [{ slug: "specialised-cells", title: "Specialised Cells", subject: "Biology", language: "en", unlocked: null }],
      allowance: allowance({ cap: null }),
    });
    expect(d.state).toBe("in_catalogue");
    expect(d.summary).toBe("There is a catalogue kit 'Specialised Cells'; whether you have unlocked it is not visible from here — open Kits to check. You can unlock it now.");
    expect(d.rows[0].unlockCap).toBeNull();
  });

  it("an ineligible allowance names the reason; a spent cap says so", () => {
    const row = { slug: "x", title: "X", subject: null, language: "en", unlocked: false as boolean | null };
    expect(decideAvailability({ ...empty("X"), catalogue: [row], allowance: allowance({ eligible: false, reason: "coming_soon" }) }).summary).toMatch(/Unlocking is not open yet\.$/);
    expect(decideAvailability({ ...empty("X"), catalogue: [row], allowance: allowance({ eligible: false, reason: "suspended" }) }).summary).toMatch(/cannot unlock kits right now\.$/);
    expect(decideAvailability({ ...empty("X"), catalogue: [row], allowance: allowance({ used: 4 }) }).summary).toMatch(/All 4 unlocks used this week\.$/);
    expect(decideAvailability({ ...empty("X"), catalogue: [row], allowance: null }).summary).toBe("There is a kit 'X' but it is locked.");
  });

  it("the SK book states read as the founder said them", () => {
    const b = (activated: boolean) => [{ id: "p1", slug: "cambridge-biology", title: "Cambridge Biology", subject: "Biology", activated }];
    expect(decideAvailability({ ...empty(), skBooks: b(true) }).summary).toBe("Yes — the SK book 'Cambridge Biology' is activated for you.");
    expect(decideAvailability({ ...empty(), skBooks: b(false) }).summary).toBe("The SK book 'Cambridge Biology' exists but is not activated for you.");
  });

  it("rows are flat (string | number | boolean | null) so they can be quoted as facts", () => {
    const d = decideAvailability({
      topic: "cells",
      library: [{ kind: "kit", id: "g1", title: "Cells", where: "my_library", subject: "Biology" }],
      catalogue: [{ slug: "cells", title: "Cells", subject: null, language: "ms", unlocked: false }],
      skBooks: [{ id: "p1", slug: "bio", title: "Bio", subject: null, activated: true }],
      allowance: allowance(),
    });
    for (const r of d.rows) for (const v of Object.values(r)) expect(["string", "number", "boolean"].includes(typeof v) || v === null).toBe(true);
  });
});
