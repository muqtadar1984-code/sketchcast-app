import { describe, it, expect } from "vitest";
import { selectAll } from "../select-all";

// A PostgREST stand-in: N rows, served by range(from, to) inclusive, capped at
// `cap` rows per call the way max-rows caps a real request.
function table(n: number, cap = 1000) {
  const rows = Array.from({ length: n }, (_, i) => ({ id: i }));
  const calls: [number, number][] = [];
  const build = () => ({
    range: (from: number, to: number) => {
      calls.push([from, to]);
      return Promise.resolve({ data: rows.slice(from, Math.min(to + 1, from + cap)), error: null });
    },
  });
  return { build, calls };
}

describe("selectAll — a whole table past the PostgREST row cap", () => {
  it("reads every row of a table larger than one page", async () => {
    const t = table(1519);
    const { data, error } = await selectAll(t.build);
    expect(error).toBeNull();
    expect(data.length).toBe(1519);
    expect(data[1518]).toEqual({ id: 1518 });
    expect(t.calls).toEqual([[0, 999], [1000, 1999]]);
  });

  it("stops after one call when the table fits in a page, and on an exact page boundary after two", async () => {
    const small = table(321);
    expect((await selectAll(small.build)).data.length).toBe(321);
    expect(small.calls).toEqual([[0, 999]]);
    const exact = table(1000);
    expect((await selectAll(exact.build)).data.length).toBe(1000);
    expect(exact.calls).toEqual([[0, 999], [1000, 1999]]); // the empty second page is what proves the end
  });

  it("honours a hard max, like the jobs panel's newest-2000 window", async () => {
    const t = table(5000);
    const { data } = await selectAll(t.build, { max: 2000 });
    expect(data.length).toBe(2000);
    expect(t.calls).toEqual([[0, 999], [1000, 1999]]);
  });

  it("returns what it has plus the error when a page fails", async () => {
    let n = 0;
    const build = () => ({
      range: (from: number, to: number) =>
        Promise.resolve(
          n++ === 0
            ? { data: Array.from({ length: to - from + 1 }, (_, i) => ({ id: i })), error: null }
            : { data: null, error: { message: "boom" } },
        ),
    });
    const { data, error } = await selectAll(build);
    expect(data.length).toBe(1000);
    expect(error?.message).toBe("boom");
  });

  it("builds a fresh query per page so ranges never stack", async () => {
    let built = 0;
    const t = table(2500);
    const build = () => {
      built++;
      return t.build();
    };
    await selectAll(build);
    expect(built).toBe(3);
  });
});
