// sk.note_gap (signal A): an API-safe tool name, clean arguments, and it never
// changes the fast model's escalation (routing.ts escalationReason).
import { describe, expect, it } from "vitest";
import { NOTE_GAP_API_NAME, NOTE_GAP_RESULT, NOTE_GAP_TOOL, NOTE_GAP_TOOL_DEF, NOTE_GAP_WANTED_MAX, isNoteGapCall, parseNoteGap } from "../note-gap";
import { API_TOOL_NAME_RE, fromApiToolName, toApiToolName } from "@/sk/shell/registry";
import { escalationReason } from "@/sk/shell/routing";
import { buildShellPrompt } from "@/sk/shell/prompt";
import { REGISTRY } from "@/sk/capabilities";
import { makeCtx } from "@/sk/shell/__tests__/fixtures";

describe("the tool", () => {
  it("is API-safe and maps to its dotted name", () => {
    expect(NOTE_GAP_TOOL_DEF.name).toBe(NOTE_GAP_API_NAME);
    expect(API_TOOL_NAME_RE.test(NOTE_GAP_API_NAME)).toBe(true);
    expect(toApiToolName(NOTE_GAP_TOOL)).toBe(NOTE_GAP_API_NAME);
    expect(fromApiToolName(NOTE_GAP_API_NAME)).toBe(NOTE_GAP_TOOL);
    expect(isNoteGapCall(NOTE_GAP_API_NAME) && isNoteGapCall(NOTE_GAP_TOOL)).toBe(true);
    expect(isNoteGapCall("navigate")).toBe(false);
  });
  it("is not a registry capability (no handler, no audit row, no permission entry)", () => {
    expect(REGISTRY.some((c) => c.meta.name === NOTE_GAP_TOOL)).toBe(false);
  });
  it("its result is data that asks for nothing more", () => {
    expect(NOTE_GAP_RESULT).toMatch(/^<tool_result data_only="true">/);
    expect(NOTE_GAP_RESULT).toContain('"ok":true');
  });
});

describe("parseNoteGap", () => {
  it("cleans and caps wanted / why", () => {
    expect(parseNoteGap({ wanted: "  email   the class ", why: " no email " })).toEqual({ wanted: "email the class", why: "no email" });
    expect(parseNoteGap({ wanted: "x".repeat(500) })!.wanted).toHaveLength(NOTE_GAP_WANTED_MAX);
    expect(parseNoteGap({ wanted: "a" })).toEqual({ wanted: "a", why: null });
  });
  it("no wanted → null", () => {
    expect(parseNoteGap({})).toBeNull();
    expect(parseNoteGap(null)).toBeNull();
    expect(parseNoteGap({ wanted: 3 })).toBeNull();
  });
});

describe("escalation ignores the note", () => {
  const call = { id: "g", name: NOTE_GAP_API_NAME, args: { wanted: "x" } };
  const teach = new Set(["board.explain"]);
  it("a low-confidence answer still escalates when the note rides along", () => {
    expect(escalationReason([call], "I'm not sure.", teach)).toBe("low_confidence");
    expect(escalationReason([], "I'm not sure.", teach)).toBe("low_confidence");
  });
  it("a plain answer with the note does not escalate", () => {
    expect(escalationReason([call], "I can't email the class from here.", teach)).toBeNull();
  });
  it("a teaching tool beside the note still escalates", () => {
    expect(escalationReason([call, { id: "b", name: "board__explain", args: {} }], "", teach)).toBe("tool:board.explain");
  });
});

describe("the prompt rule", () => {
  const ctx = makeCtx({ path: "/dashboard" });
  it("is there only when the call has the tool", () => {
    expect(buildShellPrompt({ ctx, capabilities: [], noteGap: true })).toContain(NOTE_GAP_API_NAME);
    expect(buildShellPrompt({ ctx, capabilities: [] })).not.toContain(NOTE_GAP_API_NAME);
  });
});
