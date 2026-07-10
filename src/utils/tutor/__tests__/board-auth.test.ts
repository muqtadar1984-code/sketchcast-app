/**
 * Phase 2 shared-board auth + student-event handling — the security-critical
 * seam. The board runs cross-origin (cookieless), so it presents a scoped HMAC
 * token, and its student events are untrusted iframe input that must be validated
 * before they reach the tutor's perception / the append-only log.
 * Run: npx vitest run
 */

import { beforeAll, describe, expect, it } from "vitest";
import { signBoardToken, verifyBoardToken } from "@/utils/tutor/board-token";
import { parseStudentEvents, refHash, boardCors } from "@/utils/tutor/board";

beforeAll(() => {
  process.env.BOARD_TOKEN_SECRET = "unit-test-secret-32-chars-minimum-ok";
  process.env.BOARD_APP_ORIGIN = "https://board.sketchcast.app";
});

describe("board token", () => {
  it("round-trips valid (user, generation) claims", () => {
    const t = signBoardToken("u1", "g1");
    expect(verifyBoardToken(t)).toEqual({ sub: "u1", gen: "g1" });
  });

  it("rejects a tampered signature", () => {
    const t = signBoardToken("u1", "g1");
    expect(verifyBoardToken(t.slice(0, -3) + "zzz")).toBeNull();
  });

  it("rejects a forged payload (sig no longer matches)", () => {
    const t = signBoardToken("u1", "g1");
    const sig = t.slice(t.indexOf(".") + 1);
    const forged = Buffer.from(JSON.stringify({ sub: "u1", gen: "g2", scope: "board", iat: 0, exp: 9999999999 })).toString("base64url");
    expect(verifyBoardToken(`${forged}.${sig}`)).toBeNull();
  });

  it("rejects an expired token", () => {
    const t = signBoardToken("u1", "g1", Date.now() - 3_600_000); // 1h ago; TTL is 10m
    expect(verifyBoardToken(t)).toBeNull();
  });

  it("rejects malformed input without throwing", () => {
    for (const bad of ["", "nodot", "a.b", "..", "x"]) expect(verifyBoardToken(bad)).toBeNull();
  });
});

describe("parseStudentEvents (untrusted iframe input)", () => {
  it("keeps known types, drops the rest, caps + sanitizes", () => {
    const parsed = parseStudentEvents([
      { type: "student.select", target: "cell.nucleus" },
      { type: "student.circle", target: "cell.golgi", payload: { text: "x".repeat(500), n: 3, bad: { deep: 1 } } },
      { type: "student.move", target: "cell" }, // not a deixis type → dropped (no mutation)
      "nope",
      { type: "student.annotate", target: "a".repeat(300) },
    ]);
    expect(parsed.map((e) => e.type)).toEqual(["student.select", "student.circle", "student.annotate"]);
    expect(parsed[1]!.payload?.text).toHaveLength(300); // capped
    expect("bad" in (parsed[1]!.payload ?? {})).toBe(false); // nested object dropped
    expect(parsed[1]!.payload?.n).toBe(3);
    expect(parsed[2]!.target).toHaveLength(120); // target capped
  });

  it("caps the number of events and returns [] for non-arrays", () => {
    const many = Array.from({ length: 60 }, () => ({ type: "student.select", target: "x" }));
    expect(parseStudentEvents(many).length).toBeLessThanOrEqual(25);
    expect(parseStudentEvents(undefined)).toEqual([]);
    expect(parseStudentEvents({})).toEqual([]);
  });
});

describe("refHash (cache disambiguator)", () => {
  it("is '' with no reference, deterministic + distinct otherwise", () => {
    expect(refHash([])).toBe("");
    const golgi = refHash([{ type: "student.circle", target: "cell.golgi" }]);
    const nucleus = refHash([{ type: "student.circle", target: "cell.nucleus" }]);
    expect(golgi).not.toBe("");
    expect(golgi).not.toBe(nucleus); // circling different parts → different cache entry
    expect(refHash([{ type: "student.circle", target: "cell.golgi" }])).toBe(golgi); // stable
  });
});

describe("boardCors", () => {
  it("echoes only the allowlisted origin, never a wildcard", () => {
    expect(boardCors("https://board.sketchcast.app")["Access-Control-Allow-Origin"]).toBe("https://board.sketchcast.app");
    expect(boardCors("https://evil.example")).toEqual({});
    expect(boardCors(null)).toEqual({});
  });
});
