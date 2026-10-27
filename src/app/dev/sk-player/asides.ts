// SK B2 harness — one canned live aside per Chapter 2 unit, built at the
// moment of the barge-in from the unit's HIT MAP (what the clip has drawn so
// far), so the answer lands on the pixels the video drew. In production the
// program comes from B4's teacher turn; here it stands in for it and goes
// through the same gate (`validateAside`) before it reaches the board.

import { hitBox, lastDrawnAt, type Action, type Aside, type Gesture, type HitMap } from "@/sk/board/engine";
import type { LiveAside } from "@/sk/board/runtime";

/** The S1 fixture's spoken aside ("Is the eyepiece the top lens?"), reused for
 * s2 (the same light-microscope illustration) so one unit exercises the
 * audio-clocked live overlay with word marks for the mouth. */
export type S1Aside = Pick<Aside, "question" | "audio" | "marks" | "actions" | "gestures">;

type Canned = { question: string; target?: string; note: string };
const CANNED: Record<string, Canned> = {
  s1: { question: "Where do cells come from?", note: "all cells come from cells" },
  s2: { question: "Is the eyepiece the top lens?", target: "ill.eyepiece lens", note: "×10" },
  s3: { question: "Why lowest power first?", target: "w2", note: "wide view → find it first" },
  s4: { question: "Why add iodine?", target: "ill.iodine drop", note: "stains the nucleus" },
  s5: { question: "Why multiply, not add?", target: "w1", note: "each lens magnifies the last" },
  s6: { question: "Why no shading?", target: "w3", note: "lines only = clear record" },
};

/** The live aside for `unit` when the student asks at clock time t (ms). */
export function liveAsideFor(unit: string, hm: HitMap, t: number, s1?: S1Aside | null): LiveAside {
  const c = CANNED[unit] ?? { question: "What is that?", note: "this one" };
  // Target: the unit's canned element if the clip has drawn it by now, else the latest drawn element.
  const drawn = lastDrawnAt(hm, t);
  let target = c.target && hitBox(hm, c.target) ? c.target : (drawn ?? Object.keys(hm.elements)[0] ?? "");
  if (c.target?.includes(".") && hitBox(hm, c.target)) target = c.target; // a region is always visible once its asset is
  const u = hm.world.h / 100;
  const b = hitBox(hm, target) ?? { x: 100, y: 100, w: 200, h: 40 };

  if (unit === "s2" && s1) {
    // The S1 aside, re-targeted from the fixture's "mic" to the packager's "ill".
    const actions = s1.actions.map((a) => ("target" in a ? { ...a, target: a.target.replace(/^mic(?=\.|$)/, "ill") } : a)) as Action[];
    const gestures = s1.gestures.map((g) => (g.target ? { ...g, target: g.target.replace(/^mic(?=\.|$)/, "ill") } : g)) as Gesture[];
    return { question: s1.question, program: { actions, gestures, duration_ms: s1.audio.duration_ms + 800 }, speech: { uri: "/sk-s1/u4/" + s1.audio.uri, marks: s1.marks } };
  }

  // Wall-clocked: circle the target, then handwrite the note under it (board units).
  const x = Math.min(70, b.x / u);
  const y = Math.min(92, (b.y + b.h) / u + 4.5);
  const actions: Action[] = [
    { op: "highlight", id: "la1", target, style: "circle", t: 200, dur: 700 },
    { op: "write", id: "la2", text: c.note, at: { x, y }, size: 3.6, t: 1000, dur: 1800 },
  ];
  const gestures: Gesture[] = [
    { t: 0, kind: "point", target, until: 1000 },
    { t: 1000, kind: "write", target, until: 2800 }, // the hand follows the live pen; the target only has to resolve
  ];
  return { question: c.question, program: { actions, gestures, duration_ms: 3600 } };
}
