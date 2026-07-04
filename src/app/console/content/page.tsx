import { createAdminClient } from "@/utils/supabase/admin";
import { InkUnderline } from "@/components/ink-mark";
import TakedownButton from "./takedown-button";

// All books + generations across the platform, incl. removed ones — with
// takedown/restore. Soft-delete only: rows are hidden+frozen for school-side
// users, never destroyed, and every action is audited.

export const dynamic = "force-dynamic";

export default async function ConsoleContentPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const admin = createAdminClient();

  const [booksQ, gensQ, profilesQ] = await Promise.all([
    admin.from("books").select("*").order("created_at", { ascending: false }).limit(200),
    admin.from("generations").select("*").order("created_at", { ascending: false }).limit(200),
    admin.from("profiles").select("id, full_name, username"),
  ]);
  const nameOf = new Map(
    ((profilesQ.data ?? []) as { id: string; full_name: string | null; username: string | null }[]).map(
      (p) => [p.id, p.full_name || p.username || "User"] as const,
    ),
  );

  type Row = Record<string, unknown>;
  const opsReady = (booksQ.data ?? []).length === 0 || "removed_at" in ((booksQ.data ?? [])[0] as Row);
  const needle = (q ?? "").trim().toLowerCase();
  const match = (r: Row, owner: string) =>
    !needle ||
    [(r.title as string) ?? "", owner, (r.kind as string) ?? ""].some((v) => v.toLowerCase().includes(needle));

  const books = ((booksQ.data ?? []) as Row[]).filter((b) => match(b, nameOf.get(b.owner_id as string) ?? ""));
  const gens = ((gensQ.data ?? []) as Row[]).filter((g) => match(g, nameOf.get(g.owner_id as string) ?? ""));

  const removedBadge = (r: Row) =>
    opsReady && r.removed_at != null ? (
      <span className="chip font-sans bg-[#FFE9E3] text-[#B3401F]">removed</span>
    ) : null;

  return (
    <main className="max-w-6xl mx-auto px-6 py-10">
      <h1 className="text-4xl mb-2">Content</h1>
      <InkUnderline className="block h-3 w-28 mb-3" />
      <p className="text-[#5B6470] mb-5">
        Every book and generation, including taken-down ones. Takedown hides content from all school-side
        users and freezes the row — recoverable, audited, nothing is deleted.
      </p>
      {!opsReady && (
        <p className="text-sm text-[#9A6400] bg-[#FFF9EE] rounded-lg px-4 py-2.5 mb-5">
          Takedown needs migration <span className="font-medium">0015</span> applied first.
        </p>
      )}

      <form method="get" className="mb-6">
        <input name="q" defaultValue={q ?? ""} placeholder="Search title, owner, kind…" className="field w-full sm:w-96 h-10 px-3" />
      </form>

      <h2 className="text-xl mb-3">Books ({books.length})</h2>
      <div className="card divide-y divide-[#EEF0EC] mb-8">
        {books.map((b) => (
          <div key={b.id as string} className="px-5 py-2.5 flex items-center justify-between gap-3 text-sm">
            <span className="min-w-0 truncate">
              <span className="font-medium">{(b.title as string) || "Untitled"}</span>
              <span className="text-[#5B6470]"> · {nameOf.get(b.owner_id as string) ?? "?"}</span>
              <span className="text-xs text-[#98A0A9]"> · {b.status as string}</span>
            </span>
            <span className="flex items-center gap-2 shrink-0">
              {removedBadge(b)}
              {opsReady && (
                <TakedownButton targetId={b.id as string} targetKind="book" removed={b.removed_at != null} />
              )}
            </span>
          </div>
        ))}
        {books.length === 0 && <div className="px-5 py-6 text-sm text-[#5B6470]">No books{needle ? " match" : ""}.</div>}
      </div>

      <h2 className="text-xl mb-3">Generations ({gens.length})</h2>
      <div className="card divide-y divide-[#EEF0EC]">
        {gens.map((g) => (
          <div key={g.id as string} className="px-5 py-2.5 flex items-center justify-between gap-3 text-sm">
            <span className="min-w-0 truncate">
              <span className="font-medium">{(g.title as string) || (g.kind as string) || "generation"}</span>
              <span className="text-[#5B6470]"> · {nameOf.get(g.owner_id as string) ?? "?"}</span>
              <span className="text-xs text-[#98A0A9]"> · {g.status as string}</span>
            </span>
            <span className="flex items-center gap-2 shrink-0">
              {removedBadge(g)}
              {opsReady && (
                <TakedownButton targetId={g.id as string} targetKind="generation" removed={g.removed_at != null} />
              )}
            </span>
          </div>
        ))}
        {gens.length === 0 && <div className="px-5 py-6 text-sm text-[#5B6470]">No generations{needle ? " match" : ""}.</div>}
      </div>
    </main>
  );
}
