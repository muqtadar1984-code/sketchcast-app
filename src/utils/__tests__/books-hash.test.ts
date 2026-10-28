import { describe, expect, it } from "vitest";
import { canonicalSha } from "../books/hash";

// Reference hashes from Python: hashlib.sha256(json.dumps({...}, sort_keys=True, ensure_ascii=False).encode()).
// The app's approval hash must equal the engine's (publishing/tools/books_import.py canonical_sha) byte for byte;
// it was also checked against all 60 stored Biology chapter texts (2026-10-28: 60/60).
describe("canonicalSha", () => {
  it("matches Python on accents, quotes, newlines, tabs, CJK, U+2028, null/bool/int/float", () => {
    const body = {
      sections: [{ sid: "s1", heading: "Cells \u2013 the basics", blocks: [{ type: "p", text: "Caf\u00e9 \"quoted\"\nnew line\ttab \u00e9 \u00fc \u4e2d \u2028 end", z: null, a: true, n: 3, f: 0.5 }] }],
      exercises: [{ xid: "x1", stem: "2 \u00d7 3 = ?", options: ["6", "5"], marks: 2 }],
    };
    expect(canonicalSha(body)).toBe("8162d52c787ff45b23cc280e68f2684926485ee53d207b973a677eccc8666747");
  });

  it("matches Python on an empty chapter", () => {
    expect(canonicalSha({ sections: [], exercises: [] })).toBe("fb7af243bc06ac75dc985cb673d8fe3697c7b351bb7a0d95049073034b49e7bb");
  });

  it("matches Python on nested key order, control characters and backslashes", () => {
    const body = { sections: [{ b: { y: 1, x: [1, 2, { k: "\u0001ctl" }] }, a: "back\\slash" }], exercises: [{ answer: "\u00bd \u2265 \u2153" }] };
    expect(canonicalSha(body)).toBe("de75b9a4e36f0d0e5967c7f709808b21858e59dac7809f89e77b2ef44faf8832");
  });

  it("ignores everything but sections and exercises", () => {
    const a = canonicalSha({ sections: [], exercises: [] });
    expect(canonicalSha({ sections: [], exercises: [], gate_d: { x: 1 }, review: {} } as never)).toBe(a);
  });
});
