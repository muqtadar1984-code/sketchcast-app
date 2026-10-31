// SK gap tracker — the nightly grouping: strict JSON validation, existing vs
// new themes, noise, bad replies, and fixed themes that come back.
// Run: node node_modules/vitest/vitest.mjs run src/sk/gaps/__tests__/group.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGroupingPrompt, GROUP_MODEL, groupNewGaps, parseGrouping, type GapForGrouping, type ThemeForGrouping } from "@/sk/gaps/group";
import { FakeDb, type Row } from "./fake-db";

const NOW = new Date("2026-10-31T20:00:00.000Z");

const gap = (id: string, created_at: string, question: string, extra: Partial<Row> = {}): Row => ({
  id,
  created_at,
  turn_id: `turn-${id}`,
  question,
  wanted: null,
  reply: "I can't do that from here.",
  signal: "self",
  role: "teacher",
  status: "new",
  theme_id: null,
  text_purged_at: null,
  ...extra,
});
const theme = (id: string, title: string, extra: Partial<Row> = {}): Row => ({
  id,
  title,
  summary: `${title} summary`,
  status: "open",
  updated_at: "2026-10-01T00:00:00.000Z",
  last_seen_at: "2026-10-20T00:00:00.000Z",
  fixed_pr: null,
  note: null,
  ...extra,
});

const reply = (o: unknown) => vi.fn(async () => ({ text: typeof o === "string" ? o : JSON.stringify(o), usage: { input_tokens: 10_000, output_tokens: 2_000 } }));

let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("parseGrouping", () => {
  const gapAlias = new Map([
    ["g1", "G1"],
    ["g2", "G2"],
    ["g3", "G3"],
    ["g4", "G4"],
  ]);
  const themeAlias = new Map([["t1", "T1"]]);

  it("maps existing, new and noise; leaves the unplaced as skipped", () => {
    const plan = parseGrouping(
      JSON.stringify({
        new_themes: [{ key: "n1", title: "Email a worksheet to the class", summary: "Teachers want SK to send it." }],
        assign: [
          { gap: "g1", theme: "t1" },
          { gap: "g2", theme: "n1" },
          { gap: "g3", theme: "noise" },
        ],
      }),
      gapAlias,
      themeAlias,
    );
    expect([...plan.existing]).toEqual([["T1", ["G1"]]]);
    expect(plan.newThemes).toEqual([{ key: "n1", title: "Email a worksheet to the class", summary: "Teachers want SK to send it.", gapIds: ["G2"] }]);
    expect(plan.noise).toEqual(["G3"]);
    expect(plan.skipped).toEqual(["G4"]);
  });

  it("drops unknown gap ids, unknown theme ids, duplicates and malformed new themes", () => {
    const plan = parseGrouping(
      "```json\n" +
        JSON.stringify({
          new_themes: [
            { key: "n1", title: "" }, // no title → not a theme
            { key: "t1", title: "Collides with an existing alias" },
            { key: "n2", title: "x".repeat(150), summary: "y".repeat(500) },
            { key: "n2", title: "Duplicate key" },
          ],
          assign: [
            { gap: "g9", theme: "t1" }, // unknown miss
            { gap: "g1", theme: "t7" }, // unknown theme → stays new
            { gap: "g2", theme: "n1" }, // undeclared new theme → stays new
            { gap: "g3", theme: "n2" },
            { gap: "g3", theme: "noise" }, // duplicate: first wins
            { gap: "g4", theme: 5 },
            "junk",
          ],
        }) +
        "\n```",
      gapAlias,
      themeAlias,
    );
    expect(plan.existing.size).toBe(0);
    expect(plan.noise).toEqual([]);
    expect(plan.newThemes).toHaveLength(1);
    expect(plan.newThemes[0].title).toHaveLength(80);
    expect(plan.newThemes[0].summary).toHaveLength(300);
    expect(plan.newThemes[0].gapIds).toEqual(["G3"]);
    expect(plan.skipped.sort()).toEqual(["G1", "G2", "G4"]);
  });

  it("throws on a reply that is not a usable JSON object", () => {
    expect(() => parseGrouping("Sorry, I cannot help.", gapAlias, themeAlias)).toThrow(/no JSON object/);
    expect(() => parseGrouping("{not json}", gapAlias, themeAlias)).toThrow(/not valid JSON/);
    expect(() => parseGrouping('{"new_themes": []}', gapAlias, themeAlias)).toThrow(/assign/);
  });
});

describe("buildGroupingPrompt", () => {
  it("uses short aliases, never real ids, and trims long text", () => {
    const gaps = [gap("uuid-gap-1", "2026-10-30T00:00:00Z", "q".repeat(1000))] as GapForGrouping[];
    const themes = [theme("uuid-theme-1", "Send email")] as ThemeForGrouping[];
    const { user, gapAlias, themeAlias } = buildGroupingPrompt(gaps, themes);
    expect(user).not.toContain("uuid-");
    expect(user).toContain('"id":"g1"');
    expect(user).toContain('"id":"t1"');
    expect(user).not.toContain("q".repeat(401));
    expect(gapAlias.get("g1")).toBe("uuid-gap-1");
    expect(themeAlias.get("t1")).toBe("uuid-theme-1");
  });
});

describe("groupNewGaps", () => {
  const world = () =>
    new FakeDb({
      sk_gaps: [
        gap("G1", "2026-10-29T10:00:00.000Z", "Can you email this worksheet to my class?"),
        gap("G2", "2026-10-30T10:00:00.000Z", "Make a test paper from chapters 2, 3 and 4"),
        gap("G3", "2026-10-30T11:00:00.000Z", "asdfgh"),
        gap("G4", "2026-10-30T12:00:00.000Z", "Kirim lembaran kerja ini ke kelas saya"),
        gap("OLD", "2026-07-01T00:00:00.000Z", "", { text_purged_at: "2026-10-01T00:00:00Z", question: null }),
        gap("DONE", "2026-10-30T00:00:00.000Z", "already grouped", { status: "grouped", theme_id: "T-EMAIL" }),
      ],
      sk_gap_themes: [theme("T-EMAIL", "Email a worksheet to the class")],
    });

  it("groups into existing and new themes, dismisses noise, bumps last_seen, logs cost", async () => {
    const db = world();
    const call = reply({
      new_themes: [{ key: "n1", title: "Make a test paper from several chapters", summary: "Multi-chapter papers." }],
      assign: [
        { gap: "g1", theme: "t1" },
        { gap: "g2", theme: "n1" },
        { gap: "g3", theme: "noise" },
        { gap: "g4", theme: "t1" },
      ],
    });
    const r = await groupNewGaps(db, { now: NOW, call });

    expect(r).toMatchObject({ status: "ok", gaps: 4, grouped: 3, dismissed: 1, newThemes: 1, reopened: 0, skipped: 0 });
    expect(call).toHaveBeenCalledTimes(1);
    expect((call.mock.calls[0] as unknown as [{ model: string }])[0].model).toBe(GROUP_MODEL);

    const byId = new Map(db.tables.sk_gaps.map((g) => [g.id, g]));
    expect(byId.get("G1")).toMatchObject({ status: "grouped", theme_id: "T-EMAIL" });
    expect(byId.get("G4")).toMatchObject({ status: "grouped", theme_id: "T-EMAIL" });
    expect(byId.get("G3")).toMatchObject({ status: "dismissed", theme_id: null });
    expect(byId.get("OLD")).toMatchObject({ status: "new" }); // purged text is never sent

    const newTheme = db.tables.sk_gap_themes.find((t) => t.id !== "T-EMAIL")!;
    expect(newTheme).toMatchObject({ title: "Make a test paper from several chapters", status: "open", last_seen_at: "2026-10-30T10:00:00.000Z" });
    expect(byId.get("G2")).toMatchObject({ status: "grouped", theme_id: newTheme.id });

    const email = db.tables.sk_gap_themes.find((t) => t.id === "T-EMAIL")!;
    expect(email).toMatchObject({ status: "open", last_seen_at: "2026-10-30T12:00:00.000Z", updated_at: NOW.toISOString() });

    // Oldest first, capped, text-bearing new misses only.
    const read = db.calls.find((c) => c.table === "sk_gaps" && c.op === "select")!;
    expect(read.filters).toEqual([
      ["eq", "status", "new"],
      ["is", "text_purged_at", null],
    ]);
    expect(read.order).toEqual([{ col: "created_at", asc: true }]);
    expect(read.limit).toBe(300);
    // Every gap write is guarded by status='new'.
    for (const c of db.calls.filter((c) => c.table === "sk_gaps" && c.op === "update")) expect(c.filters).toContainEqual(["eq", "status", "new"]);

    const line = log.mock.calls.find((c: unknown[]) => c[0] === "sk-gaps.group")!;
    expect(JSON.parse(line[1] as string)).toMatchObject({ status: "ok", usage: { input_tokens: 10_000, output_tokens: 2_000, usd: 0.002 } });
  });

  it("makes no model call when nothing is new", async () => {
    const db = new FakeDb({ sk_gaps: [gap("X", "2026-10-30T00:00:00Z", "q", { status: "grouped" })], sk_gap_themes: [] });
    const call = reply({ assign: [] });
    const r = await groupNewGaps(db, { now: NOW, call });
    expect(r.status).toBe("empty");
    expect(call).not.toHaveBeenCalled();
  });

  it("writes nothing on a bad reply, and does not throw", async () => {
    const db = world();
    const before = JSON.stringify(db.tables);
    const r = await groupNewGaps(db, { now: NOW, call: reply("I'm sorry, here are the themes: …") });
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/JSON/);
    expect(r.usage.input_tokens).toBe(10_000); // the call still cost money: logged
    expect(JSON.stringify(db.tables)).toBe(before);
  });

  it("returns failed (no throw) when the model call itself fails", async () => {
    const db = world();
    const r = await groupNewGaps(db, { now: NOW, call: vi.fn(async () => Promise.reject(new Error("ThrottlingException"))) });
    expect(r).toMatchObject({ status: "failed", error: "ThrottlingException", grouped: 0 });
    expect(db.tables.sk_gaps.filter((g) => g.status === "new")).toHaveLength(5);
  });

  it("does not insert a new theme that gets no valid miss", async () => {
    const db = world();
    const r = await groupNewGaps(db, {
      now: NOW,
      call: reply({ new_themes: [{ key: "n1", title: "Orphan theme" }], assign: [{ gap: "g1", theme: "t1" }] }),
    });
    expect(r).toMatchObject({ status: "ok", grouped: 1, newThemes: 0, skipped: 3 });
    expect(db.tables.sk_gap_themes).toHaveLength(1);
  });

  it("reopens a fixed theme when a miss created AFTER the fix lands on it", async () => {
    const db = world();
    Object.assign(db.tables.sk_gap_themes[0], { status: "fixed", fixed_pr: "#240", updated_at: "2026-10-30T00:00:00.000Z", note: "Shipped." });
    const r = await groupNewGaps(db, { now: NOW, call: reply({ assign: [{ gap: "g1", theme: "t1" }, { gap: "g4", theme: "t1" }] }) });
    expect(r.reopened).toBe(1);
    const t = db.tables.sk_gap_themes[0];
    expect(t.status).toBe("open");
    expect(t.fixed_pr).toBe("#240");
    // G1 (29 Oct) predates the fix; only G4 (30 Oct 12:00) came back.
    expect(t.note).toBe("Shipped.\nCame back after fix (#240): 1 new miss by 2026-10-31.");
  });

  it("keeps a fixed theme fixed (and its fix time) when only older misses land on it", async () => {
    const db = world();
    Object.assign(db.tables.sk_gap_themes[0], { status: "fixed", fixed_pr: "#240", updated_at: "2026-10-30T23:00:00.000Z" });
    const r = await groupNewGaps(db, { now: NOW, call: reply({ assign: [{ gap: "g1", theme: "t1" }] }) });
    expect(r.reopened).toBe(0);
    expect(db.tables.sk_gap_themes[0]).toMatchObject({ status: "fixed", updated_at: "2026-10-30T23:00:00.000Z", last_seen_at: "2026-10-29T10:00:00.000Z" });
  });
});
