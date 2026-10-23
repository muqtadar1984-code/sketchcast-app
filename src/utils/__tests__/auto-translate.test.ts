import { describe, expect, it } from "vitest";
import {
  translationsPageLive,
  SILENT_AFTER_MINUTES,
  agentView,
  cleanVerdict,
  controlPatch,
  controlsFor,
  generationIdsOf,
  isAgentControl,
  type CleanKit,
} from "../catalogue/auto-translate";

const NOW = Date.parse("2026-10-21T10:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60000).toISOString();

describe("agentView", () => {
  it("is off when the switch is off", () => {
    const v = agentView({ enabled: false }, { last_tick: ago(0) }, NOW);
    expect(v.mode).toBe("off");
    expect(controlsFor(v.mode, v.enabled, v.dryRun, v.paused)).toEqual(["on"]);
  });

  it("says when the worker is not running it", () => {
    expect(agentView({ enabled: true }, {}, NOW).mode).toBe("silent");
    const v = agentView({ enabled: true }, { last_tick: ago(SILENT_AFTER_MINUTES + 2) }, NOW);
    expect(v.mode).toBe("silent");
    expect(v.headline).toMatch(/has not run the agent for 7 min/);
  });

  it("defaults to dry run and shows what it would queue", () => {
    const v = agentView({ enabled: true }, {
      last_tick: ago(0),
      decision: { action: "wait", why: "dry run: would queue", language: "ar", topic: "Cells", reason: "backlog" },
    }, NOW);
    expect(v.mode).toBe("dry_run");
    expect(v.headline).toBe("Dry run — would queue ar · Cells (backlog).");
    expect(controlsFor(v.mode, v.enabled, v.dryRun, v.paused)).toEqual(["pause", "go_live", "off"]);
  });

  it("orders pause, breaker and throttle", () => {
    const st = { last_tick: ago(1), breaker: true, breaker_reason: "2 failures in a row", paused_until: new Date(NOW + 600000).toISOString() };
    expect(agentView({ enabled: true, paused: true, dry_run: false }, st, NOW).mode).toBe("paused");
    const b = agentView({ enabled: true, dry_run: false }, st, NOW);
    expect(b.mode).toBe("breaker");
    expect(controlsFor(b.mode, b.enabled, b.dryRun, b.paused)[0]).toBe("resume");
    expect(agentView({ enabled: true, dry_run: false }, { ...st, breaker: false }, NOW).mode).toBe("throttled");
  });

  it("running reports the last decision and the work left per language", () => {
    const v = agentView({ enabled: true, dry_run: false, languages: ["ar", "ms"] }, {
      last_tick: ago(0),
      decision: { action: "wait", why: "an Arabic client generation is using Bedrock" },
      remaining: { ar: 40, ms: 48 },
      jawi_waiting: 48,
      cost_warnings: [{ at: ago(60), total_usd: 2.3 }, { at: ago(5), total_usd: 2.1 }],
    }, NOW);
    expect(v.mode).toBe("running");
    expect(v.headline).toBe("Running — an Arabic client generation is using Bedrock.");
    expect(v.remainingTotal).toBe(88);
    expect(v.jawiWaiting).toBe(48);
    expect(v.warnings.map((w) => w.total_usd)).toEqual([2.1, 2.3]);
  });
});

describe("controls", () => {
  it("patch only their own keys; Resume clears the breaker; On never leaves the dry run", () => {
    expect(controlPatch("on", "t")).toEqual({ enabled: true });
    expect(controlPatch("pause", "t")).toEqual({ paused: true });
    expect(controlPatch("resume", "2026-10-21T10:00:00Z")).toEqual({ paused: false, breaker_cleared_at: "2026-10-21T10:00:00Z" });
    expect(controlPatch("go_live", "t")).toEqual({ dry_run: false });
    expect(controlPatch("dry_run", "t")).toEqual({ dry_run: true });
    expect(controlPatch("off", "t")).toEqual({ enabled: false });
    expect(isAgentControl("go_live")).toBe(true);
    expect(isAgentControl("delete")).toBe(false);
  });
});

describe("cleanVerdict", () => {
  const source = { presentation_generation_id: "sp", doc_generation_ids: { deck: "sd", worksheet: "sw", quiz: "" } };
  const kit = (over: Partial<CleanKit> = {}): CleanKit => ({
    id: "k1",
    topic_id: "t1",
    language: "ar",
    status: "in_review",
    translation_status: "in_review",
    precheck: { ok: true, blocking: [], flags: [{ where: "s1", what: "picture redrawn" }], post_render: { ok: true, blocking: [], flags: [] } },
    presentation_generation_id: "p",
    doc_generation_ids: { deck: "d", worksheet: "w" },
    ...over,
  });
  const done = new Map([["p", "done"], ["d", "done"], ["w", "done"]]);

  it("a kit whose checks passed and whose pieces are all done is clean, flags or not", () => {
    expect(cleanVerdict(kit(), source, done)).toEqual({ clean: true });
  });

  it("must be in review", () => {
    expect(cleanVerdict(kit({ status: "approved", translation_status: "approved" }), source, done)).toMatchObject({ clean: false });
  });

  it("a blocking finding, a failed check or no check is not clean", () => {
    expect(cleanVerdict(kit({ precheck: null }), source, done)).toEqual({ clean: false, why: "not checked" });
    expect(cleanVerdict(kit({ precheck: { ok: false, blocking: [{ where: "s", what: "numbers differ" }], flags: [] } }), source, done))
      .toEqual({ clean: false, why: "1 blocking finding" });
    expect(cleanVerdict(kit({ precheck: { ok: true, blocking: [], flags: [], post_render: { ok: false, blocking: [], flags: [] } } }), source, done))
      .toEqual({ clean: false, why: "the post-render check did not pass" });
  });

  it("every piece the English kit has must be here and done", () => {
    expect(cleanVerdict(kit({ doc_generation_ids: { deck: "d" } }), source, done)).toEqual({ clean: false, why: "missing worksheet" });
    expect(cleanVerdict(kit(), source, new Map([["p", "done"], ["d", "error"], ["w", "done"]]))).toEqual({ clean: false, why: "deck error" });
    expect(cleanVerdict(kit(), source, new Map([["d", "done"], ["w", "done"]]))).toEqual({ clean: false, why: "video missing" });
    expect(cleanVerdict(kit(), null, done)).toEqual({ clean: false, why: "the English source kit is gone" });
  });

  it("collects every generation id once", () => {
    expect(generationIdsOf([kit(), source]).sort()).toEqual(["d", "p", "sd", "sp", "sw", "w"]);
  });
});

describe("translationsPageLive", () => {
  it("stays live across the gap between two runs while the agent will queue more", () => {
    expect(translationsPageLive(true, "paused", 0)).toBe(true);
    expect(translationsPageLive(false, "running", 0)).toBe(true);
    expect(translationsPageLive(false, "throttled", 0)).toBe(true);
    expect(translationsPageLive(false, "paused", 2)).toBe(true);
  });
  it("goes quiet when nothing is in flight and nothing will be queued", () => {
    for (const mode of ["off", "dry_run", "paused", "breaker", "silent", null, undefined] as const) {
      expect(translationsPageLive(false, mode, 0)).toBe(false);
    }
  });
});
