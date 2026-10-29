/**
 * SK S3 slice D — the Shell ⇄ kit player bridge (tutor-bridge.ts), on a fake
 * controller port: the port slot (last mount wins, an unmount clears only its
 * own), state() for the collector, and every tutor move mapped onto the port.
 */
import { describe, expect, it } from "vitest";
import { createTutorBridge, currentTutorPort, registerTutorPort, type TutorPort } from "../tutor-bridge";
import { collect } from "../collector";
import type { SkTutorState } from "../../types";
import { sanitizeTutor } from "../../context";

const KIT = "4885bc51-0e65-4252-bb41-88df6bcc28bc";

function fakePort(state: Partial<SkTutorState> = {}) {
  const calls: string[] = [];
  let playing = false;
  const st: SkTutorState = {
    product: "cells",
    chapter: "5",
    kit: KIT,
    k: 1,
    key: "p1:s002",
    segments: [
      { k: 0, key: "p1:s001", heading: "Why cells specialise" },
      { k: 1, key: "p1:s002", heading: "Red blood cells" },
      { k: 2, key: "p1:s003", heading: "Tissues and organs" },
    ],
    ...state,
  };
  const port: TutorPort = {
    state: () => st,
    playing: () => playing,
    play: () => {
      calls.push("play");
      playing = true;
    },
    pause: () => {
      calls.push("pause");
      playing = false;
    },
    restart: () => calls.push("restart"),
    section: (k) => calls.push(`section:${k}`),
    slide: (k) => calls.push(`slide:${k}`),
    practise: (k) => calls.push(`practise:${k}`),
  };
  return { port, calls };
}

describe("the port slot", () => {
  it("last mount wins; an unmount clears only its own port", () => {
    const a = fakePort();
    const b = fakePort();
    const offA = registerTutorPort(a.port);
    const offB = registerTutorPort(b.port);
    expect(currentTutorPort()).toBe(b.port);
    offA();
    expect(currentTutorPort()).toBe(b.port);
    offB();
    expect(currentTutorPort()).toBeNull();
  });
});

describe("the bridge", () => {
  it("no player open: no state, every move answers so", async () => {
    const bridge = createTutorBridge(() => null);
    expect(bridge.state()).toBeUndefined();
    expect(bridge.playing()).toBe(false);
    expect(await bridge.run("play", {})).toEqual({ ok: false, summary: "The lesson player is not open." });
  });

  it("each move reaches the port; a section the player does not have is refused", async () => {
    const { port, calls } = fakePort();
    const bridge = createTutorBridge(() => port);
    expect(await bridge.run("play", {})).toMatchObject({ ok: true, plays: true });
    expect(bridge.playing()).toBe(true);
    expect(await bridge.run("pause", {})).toMatchObject({ ok: true });
    expect(await bridge.run("restart", {})).toMatchObject({ ok: true, plays: true });
    expect(await bridge.run("section", { k: 2, key: "p1:s003" })).toMatchObject({ ok: true, plays: true });
    expect(await bridge.run("slide", {})).toMatchObject({ ok: true }); // the current section (k 1)
    expect(await bridge.run("practise", { k: 0 })).toMatchObject({ ok: true });
    expect(await bridge.run("section", { k: 7 })).toEqual({ ok: false, summary: "No such section." });
    expect(calls).toEqual(["play", "pause", "restart", "section:2", "slide:1", "practise:0"]);
  });

  it("state() rides with every turn through the collector and survives the server's sanitizer", () => {
    const { port } = fakePort({ watched: [0], practised: [], playing: false, mode: "video" });
    const bridge = createTutorBridge(() => port);
    const c = collect({ location: { pathname: "/sk/cells/5", search: "" }, now: new Date("2026-10-29T10:00:00Z"), tutor: bridge.state() });
    expect(c.tutor?.kit).toBe(KIT);
    expect(sanitizeTutor(c.tutor)).toEqual({ ...port.state(), watched: [0], practised: [] });
    // A malformed kit id drops the whole state server-side.
    expect(sanitizeTutor({ ...port.state(), kit: "../../etc" })).toBeUndefined();
  });

  it("the default bridge reads whichever player is registered when a turn is sent", async () => {
    const bridge = createTutorBridge();
    expect(bridge.state()).toBeUndefined();
    const { port, calls } = fakePort();
    const off = registerTutorPort(port);
    expect(bridge.state()?.key).toBe("p1:s002");
    await bridge.run("section", { k: 0 });
    expect(calls).toEqual(["section:0"]);
    off();
    expect(bridge.state()).toBeUndefined();
  });
});
