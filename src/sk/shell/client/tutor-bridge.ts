// The SK Shell ⇄ student kit player bridge (S3 slice D) — the S1 Board
// pattern (src/app/present/sk-board-bridge.ts) for /sk. PURE: no React, no
// DOM, no fetch.
//
// Two halves:
//   1. A CONTROLLER PORT the kit player registers while it is mounted
//      (/sk/[product]/[chapter]/kit-player.tsx, one small effect). The Shell
//      panel is mounted by the /sk layout, a sibling of the page, so the port
//      meets it here, in one module-level slot: the last player mounted wins,
//      and an unmount clears the slot only if it is still its own.
//   2. The BRIDGE the panel holds: `state()` is what the collector posts with
//      every turn (SkTutorState — which kit, which section, the headings) and
//      `run(move, args)` performs a `tutor` event the server decided and
//      audited, on whatever port is registered at that moment.
// The server never trusts the state (it re-opens the kit through the kit
// routes' own checks); the bridge never decides a move, it only performs one.

import type { SkTutorMove, SkTutorState } from "../types";

/** What the kit player exposes. Every call acts on the player's own state. */
export type TutorPort = {
  state(): SkTutorState | null;
  /** Is the lesson video playing right now? */
  playing(): boolean;
  /** Carry on with the current section (play to its end). */
  play(): void;
  pause(): void;
  /** The lesson from its first section. */
  restart(): void;
  /** Play section k (0-based position), pausing at its end. */
  section(k: number): void;
  /** Show section k's slide (frame or caption card). */
  slide(k: number): void;
  /** Open the practise panel on section k. */
  practise(k: number): void;
};

let slot: TutorPort | null = null;

/** The kit player's mount: returns the unmount. */
export function registerTutorPort(port: TutorPort): () => void {
  slot = port;
  return () => {
    if (slot === port) slot = null;
  };
}

export function currentTutorPort(): TutorPort | null {
  return slot;
}

export type TutorRun = { ok: boolean; summary: string; plays?: boolean };

export type SkTutorBridge = {
  /** The collector's `tutor` field; undefined when no kit player is open. */
  state(): SkTutorState | undefined;
  run(move: SkTutorMove, args: Record<string, unknown>): Promise<TutorRun>;
  /** For the speech coordinator: SK pauses the video while it speaks. */
  playing(): boolean;
};

const intArg = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
};

export function createTutorBridge(port: () => TutorPort | null = currentTutorPort): SkTutorBridge {
  return {
    state() {
      const p = port();
      return p?.state() ?? undefined;
    },
    playing() {
      return port()?.playing() ?? false;
    },
    async run(move, args) {
      const p = port();
      if (!p) return { ok: false, summary: "The lesson player is not open." };
      const st = p.state();
      const a = args ?? {};
      /** A section the player has: k from the move, else the current one. */
      const sectionK = (): number | null => {
        const k = intArg(a.k) ?? st?.k ?? null;
        if (k === null) return null;
        const segs = st?.segments;
        if (segs?.length && !segs.some((s) => s.k === k)) return null;
        return k;
      };
      try {
        switch (move) {
          case "play":
            p.play();
            return { ok: true, summary: "Playing.", plays: true };
          case "pause":
            p.pause();
            return { ok: true, summary: "Paused." };
          case "restart":
            p.restart();
            return { ok: true, summary: "Playing from the start.", plays: true };
          case "section": {
            const k = sectionK();
            if (k === null) return { ok: false, summary: "No such section." };
            p.section(k);
            return { ok: true, summary: `Playing section ${k + 1}.`, plays: true };
          }
          case "slide": {
            const k = sectionK();
            if (k === null) return { ok: false, summary: "No such section." };
            p.slide(k);
            return { ok: true, summary: `Slide ${k + 1}.` };
          }
          case "practise": {
            const k = sectionK();
            if (k === null) return { ok: false, summary: "No such section." };
            p.practise(k);
            return { ok: true, summary: `Practice for section ${k + 1}.` };
          }
          default:
            return { ok: false, summary: `Unknown move ${String(move)}.` };
        }
      } catch (e) {
        return { ok: false, summary: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
