// SK B2 — board-level replay safety (plan §7, contracts §5): a command with a
// repeated event id returns the stored outcome and performs NOTHING twice.
import { describe, expect, it } from "vitest";
import { uuidv7 } from "../../ids";
import { CommandLog, type BoardCommand } from "../events";

describe("CommandLog", () => {
  it("applies a command once per event id and flags the repeat", () => {
    const log = new CommandLog<number>();
    let effects = 0;
    const cmd: BoardCommand = { eventId: uuidv7(), kind: "pause" };
    const first = log.apply(cmd, () => ++effects);
    const again = log.apply(cmd, () => ++effects);
    const third = log.apply({ ...cmd }, () => ++effects);
    expect(effects).toBe(1);
    expect(first).toMatchObject({ duplicate: false, result: 1, kind: "pause" });
    expect(again).toMatchObject({ duplicate: true, result: 1 });
    expect(third.duplicate).toBe(true);
    expect(log.duplicates).toBe(2);
    expect(log.size).toBe(1);
  });
  it("different event ids are different commands", () => {
    const log = new CommandLog<number>();
    let effects = 0;
    log.apply({ eventId: uuidv7(), kind: "interrupt" }, () => ++effects);
    log.apply({ eventId: uuidv7(), kind: "interrupt" }, () => ++effects);
    expect(effects).toBe(2);
    expect(log.duplicates).toBe(0);
  });
  it("hands a replayed async command the SAME in-flight promise", async () => {
    const log = new CommandLog<Promise<string>>();
    let runs = 0;
    const work = () =>
      new Promise<string>((r) => {
        runs++;
        setTimeout(() => r("done"), 5);
      });
    const cmd: BoardCommand = { eventId: uuidv7(), kind: "interrupt", args: { aside: {} } };
    const a = log.apply(cmd, work).result;
    const b = log.apply(cmd, work).result;
    expect(b).toBe(a);
    expect(await b).toBe("done");
    expect(runs).toBe(1);
  });
  it("refuses an event id that is not a UUID (a junk string must not become a key)", () => {
    const log = new CommandLog();
    expect(() => log.apply({ eventId: "x", kind: "play" }, () => 1)).toThrow(/bad eventId/);
    expect(() => log.apply({ eventId: "", kind: "play" }, () => 1)).toThrow(/bad eventId/);
    expect(() => log.apply({ eventId: "../../etc", kind: "play" }, () => 1)).toThrow(/bad eventId/);
  });
  it("forgets the oldest ids past its capacity (bounded memory), newest still replay-safe", () => {
    const log = new CommandLog<number>(3);
    const ids = [uuidv7(1), uuidv7(2), uuidv7(3), uuidv7(4)];
    for (const id of ids) log.apply({ eventId: id, kind: "seek" }, () => 1);
    expect(log.size).toBe(3);
    expect(log.has(ids[0]!)).toBe(false);
    expect(log.has(ids[3]!)).toBe(true);
  });
});
