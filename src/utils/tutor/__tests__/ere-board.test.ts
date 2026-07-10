/**
 * AI Tutor Phase 1 — the persistent TAL board, as the app actually uses it.
 * These tests exercise the VENDORED engine (`@/ere`) through the app's module
 * resolution, so they'd catch a broken vendor sync as much as an engine bug.
 * They assert the two Phase-1 guarantees the /api/tutor/turn route relies on:
 *   1. The board PERSISTS + MUTATES across a reload — serialize to JSON (a DB
 *      boundary), resume in a fresh session, and a follow-up turn changes the
 *      SAME objects (not new ones), with event numbering continuing.
 *   2. The gateway is a hard validation FENCE: only valid, catalog-grounded TAL
 *      applies; anything else returns not-ok so the route degrades to text.
 * Covers all three anchor subjects (biology / physics / algorithms).
 * Run: npx vitest run
 */

import { describe, expect, it } from "vitest";
import {
  BoardSession,
  SceneGraph,
  StubNarrator,
  renderSvg,
  starterLibrary,
  generateTal,
  type CompleteFn,
  type TalProgram,
} from "@/ere";

const prog = (actions: readonly unknown[], scene = "board", turn = 1): TalProgram =>
  ({ tal: "0.1", scene, turn, actions: [...actions] }) as unknown as TalProgram;

// A model stand-in that always replies with the same program (JSON).
const replyWith = (program: unknown): CompleteFn => async () => JSON.stringify(program);

type Graph = BoardSession["graph"];

const cases = [
  {
    subject: "biology",
    ref: "bio.heart",
    turn1: [
      { op: "place", ref: "bio.heart", as: "h", at: { region: "center" } },
      { op: "draw", target: "h" },
      { op: "set_state", target: "h", state: "flow.deox_enters_ra" },
    ],
    afterTurn1: (g: Graph) => expect(g.nodes.get("h")?.state).toBe("flow.deox_enters_ra"),
    turn2: [{ op: "step", target: "h", step: "advance_flow" }],
    afterTurn2: (g: Graph) => expect(g.nodes.get("h")?.state).toBe("flow.ra_to_rv"),
  },
  {
    subject: "physics",
    ref: "phys.circuit",
    turn1: [
      { op: "place", ref: "phys.circuit", as: "c", at: { region: "center" } },
      { op: "draw", target: "c" },
      { op: "set_state", target: "c", state: "open" },
    ],
    afterTurn1: (g: Graph) => expect(g.nodes.get("c")?.state).toBe("open"),
    turn2: [{ op: "set_state", target: "c", state: "closed" }],
    afterTurn2: (g: Graph) => expect(g.nodes.get("c")?.state).toBe("closed"),
  },
  {
    subject: "algorithms",
    ref: "algo.array",
    turn1: [
      { op: "place", ref: "algo.array", as: "arr", at: { region: "center" }, props: { values: [4, 2, 7] } },
      { op: "draw", target: "arr" },
      { op: "step", target: "arr", step: "swap", args: { i: 0, j: 1 } },
    ],
    afterTurn1: (g: Graph) => expect(g.nodes.get("arr")?.props?.values).toEqual([2, 4, 7]),
    turn2: [{ op: "step", target: "arr", step: "swap", args: { i: 1, j: 2 } }],
    afterTurn2: (g: Graph) => expect(g.nodes.get("arr")?.props?.values).toEqual([2, 7, 4]),
  },
] as const;

describe("persistent board: reload + mutate across two turns (3 subjects)", () => {
  for (const c of cases) {
    it(`${c.subject}: a reloaded board mutates the SAME object, not a new one`, async () => {
      // Turn 1 in the first "request".
      const s1 = new BoardSession("board", starterLibrary(), new StubNarrator());
      const t1 = await s1.runTurn(prog(c.turn1, "board", 1));
      expect(t1.ok).toBe(true);
      c.afterTurn1(s1.graph);

      // Persist to JSON (a DB boundary) and resume in a brand-new session object.
      const snapshot = JSON.parse(JSON.stringify(s1.graph.toJSON()));
      const seq = s1.log.seq;
      const restored = SceneGraph.fromJSON(snapshot, starterLibrary());
      expect(restored.stateHash()).toBe(s1.graph.stateHash()); // round-trip identity
      expect(renderSvg(restored, starterLibrary())).toBe(renderSvg(s1.graph, starterLibrary()));

      const s2 = BoardSession.fromSnapshot("board", starterLibrary(), new StubNarrator(), snapshot, seq);
      const t2 = await s2.runTurn(prog(c.turn2, "board", 2));
      expect(t2.ok).toBe(true);
      c.afterTurn2(s2.graph);
      // Still ONE instance of the object — the follow-up built on it, didn't re-place.
      expect([...s2.graph.nodes.values()].filter((n) => n.ref === c.ref)).toHaveLength(1);
      // New events continue numbering from where the persisted log left off.
      if (t2.ok) expect(t2.events.every((e) => e.seq >= seq)).toBe(true);
    });
  }
});

describe("gateway is the /turn route's validation fence", () => {
  const grounding = { chapterTitle: "The Heart", conceptText: "The heart pumps blood through four chambers." };

  it("valid, catalog-grounded TAL → ok, and applies to the board", async () => {
    const session = new BoardSession("board", starterLibrary(), new StubNarrator());
    const actions = [
      { op: "speak", id: "s1", text: "Here is the heart." },
      { op: "place", ref: "bio.heart", as: "h", at: { region: "center" } },
      { op: "draw", target: "h", sync: { with: "s1", at: "end" } },
    ];
    const gen = await generateTal({
      complete: replyWith({ tal: "0.1", scene: "board", turn: 1, actions }),
      library: starterLibrary(),
      scene: session.graph,
      turn: 1,
      grounding,
      studentMessage: "show me the heart",
      subjects: ["biology"],
    });
    expect(gen.ok).toBe(true);
    if (gen.ok) {
      const applied = await session.runTurn(gen.program as TalProgram);
      expect(applied.ok).toBe(true);
      expect(session.graph.nodes.get("h")?.ref).toBe("bio.heart");
    }
  });

  it("prose with no JSON (twice) → not ok → route falls back to text", async () => {
    const session = new BoardSession("board", starterLibrary(), new StubNarrator());
    const gen = await generateTal({
      complete: async () => "Sorry, I can't draw that.", // repair pass also yields no JSON
      library: starterLibrary(),
      scene: session.graph,
      turn: 1,
      grounding,
      studentMessage: "hi",
      subjects: ["biology"],
    });
    expect(gen.ok).toBe(false);
  });

  it("references an object NOT in the catalog → not ok (never invents refs)", async () => {
    const session = new BoardSession("board", starterLibrary(), new StubNarrator());
    const gen = await generateTal({
      complete: replyWith({
        tal: "0.1",
        scene: "board",
        turn: 1,
        actions: [{ op: "place", ref: "bio.dragon", as: "d", at: { region: "center" } }],
      }),
      library: starterLibrary(),
      scene: session.graph,
      turn: 1,
      grounding,
      studentMessage: "draw a dragon",
      subjects: ["biology"],
    });
    expect(gen.ok).toBe(false);
  });
});
