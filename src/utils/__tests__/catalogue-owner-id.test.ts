import { describe, it, expect, afterEach } from "vitest";
import { catalogueOwnerId } from "../flags";

// CATALOGUE_OWNER_ID is the second lock in front of every catalogue
// `generations` insert (Generate kit, Retry, Regenerate, Compose): the profile
// the rows are attributed to. It used to be read THREE different ways — the
// kit page tested the variable for truthiness, the questions page for the
// uuid shape, the routes trimmed and lower-cased it — so a value with a
// trailing space (the realistic Vercel paste) enabled the Generate button on
// one page while every click answered 409 "the catalogue owner is not
// configured". catalogue-routes.test.ts pins that every page and route reads
// through this one helper; these pin what the helper answers, so the button
// a page shows and the 409 a route gives cannot disagree again.

const KEY = "CATALOGUE_OWNER_ID";
// A placeholder, deliberately not the live system account's id: what is under
// test is the shape rule, which is identical whichever uuid it runs on.
const OWNER = "0f1e2d3c-4b5a-4697-8877-66554433aa11";

afterEach(() => {
  delete process.env[KEY];
});

describe("catalogueOwnerId — one reader for the pages and the routes", () => {
  it("is null when the variable is unset or blank — 'not configured', never an empty owner", () => {
    expect(catalogueOwnerId()).toBeNull();
    process.env[KEY] = "";
    expect(catalogueOwnerId()).toBeNull();
    process.env[KEY] = "   ";
    expect(catalogueOwnerId()).toBeNull();
  });

  it("returns the uuid trimmed and lower-cased — the exact value the routes insert as owner_id", () => {
    process.env[KEY] = OWNER;
    expect(catalogueOwnerId()).toBe(OWNER);
    // the Vercel paste: surrounding whitespace, a newline, upper-case hex
    process.env[KEY] = `  ${OWNER.toUpperCase()} \n`;
    expect(catalogueOwnerId()).toBe(OWNER);
  });

  it("is null for anything that is not a uuid, so a page cannot show Generate for a value a route would refuse", () => {
    for (const junk of ["true", "catalogue@sketchcast.app", OWNER.slice(0, -1), `${OWNER}1`, OWNER.replace(/-/g, ""), "not-a-uuid", `"${OWNER}"`]) {
      process.env[KEY] = junk;
      expect(catalogueOwnerId(), junk).toBeNull();
    }
  });
});
