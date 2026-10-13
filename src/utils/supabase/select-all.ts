// Read a WHOLE table through PostgREST, which caps any single select at the
// project's max-rows (1000 by default) no matter what .limit() asks for. The
// console's metric pages fold whole tables into Maps — generations passed
// 1000 rows on 2026-10-08 and every number built on them (kits per teacher,
// generations by kind, failure rate, spend) was silently computed on an
// arbitrary 1000-row subset. This pages with .range() until a short page.
//
// `build` must return a FRESH query each call: supabase-js builders are
// mutable, so re-using one would stack range() on range().

export const SELECT_ALL_PAGE = 1000;

export type PageResult<T> = { data: T[] | null; error: { message: string } | null };
export type RangedQuery<T> = { range: (from: number, to: number) => PromiseLike<PageResult<T>> };

export async function selectAll<T>(
  build: () => RangedQuery<T>,
  opts: { pageSize?: number; max?: number } = {},
): Promise<{ data: T[]; error: { message: string } | null }> {
  const pageSize = opts.pageSize ?? SELECT_ALL_PAGE;
  const max = opts.max ?? Infinity;
  const out: T[] = [];
  let from = 0;
  while (out.length < max) {
    const to = Math.min(from + pageSize, max) - 1;
    const { data, error } = await build().range(from, to);
    if (error) return { data: out, error };
    const page = data ?? [];
    out.push(...page);
    if (page.length < to - from + 1) break; // a short page is the last page
    from = to + 1;
  }
  return { data: out, error: null };
}
