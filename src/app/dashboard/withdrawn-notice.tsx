import { createClient } from "@/utils/supabase/server";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";
import { fmt } from "@/i18n/format";
import DismissWithdrawn from "./dismiss-withdrawn";

// "Your school replaced this book, so these kits are gone."
//
// A teacher who opens the Library to find a term's work missing will file a
// support ticket, and rightly. This is the answer, placed where the gap is
// rather than behind a bell icon — the kits were here, so the explanation is
// here too.
//
// It can only exist because 0071 snapshots the book's title onto the kit at
// withdrawal: `books_not_removed` is RESTRICTIVE, so the moment leadership
// retires a book it becomes unreadable to the teacher (verified against prod —
// exactly 0 rows), and nothing could name it afterwards.
//
// One entry per WITHDRAWAL, not per kit: retiring a book with forty kits is one
// event a teacher needs to understand, not forty notifications.
export default async function WithdrawnNotice() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // Best-effort throughout: this is an explanation, and failing to render it
  // must never take the Library down with it.
  const { data: seenRow } = await supabase
    .from("profiles")
    .select("books_seen_at")
    .eq("id", user.id)
    .maybeSingle();
  const seenAt = (seenRow as { books_seen_at?: string | null } | null)?.books_seen_at ?? null;

  let q = supabase
    .from("generations")
    .select("withdrawn_at, withdrawn_book_title")
    .eq("owner_id", user.id)
    .not("withdrawn_at", "is", null)
    .order("withdrawn_at", { ascending: false })
    .limit(200);
  if (seenAt) q = q.gt("withdrawn_at", seenAt);
  const { data, error } = await q;
  if (error || !data?.length) return null;

  // Group by the withdrawal instant — every kit retired in one act shares the
  // same now() — so the reader is told "this book went, and took N of yours".
  const events = new Map<string, { book: string | null; kits: number; at: string }>();
  for (const r of data as { withdrawn_at: string; withdrawn_book_title: string | null }[]) {
    const key = `${r.withdrawn_at}|${r.withdrawn_book_title ?? ""}`;
    const cur = events.get(key);
    if (cur) cur.kits += 1;
    else events.set(key, { book: r.withdrawn_book_title, kits: 1, at: r.withdrawn_at });
  }
  const list = [...events.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 4);
  if (!list.length) return null;

  const dict = await getDictionary(await resolveLocale());
  const t = dict.library.withdrawn;
  // The watermark to write on dismiss: the newest thing being acknowledged, so
  // a withdrawal that lands mid-read is not silently marked as seen.
  const newest = list[0].at;

  return (
    <section className="card px-5 py-3.5 mb-6 border-[#E6E8E4] bg-[#FAFBF9] flex items-start justify-between gap-4">
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium text-[#14181F]">{t.title}</p>
        <ul className="text-sm text-[#5B6470] space-y-0.5">
          {list.map((e) => (
            <li key={`${e.at}-${e.book ?? ""}`} className="[overflow-wrap:anywhere]">
              {e.book
                ? fmt(e.kits === 1 ? t.itemOne : t.itemMany, { book: e.book, n: e.kits })
                : fmt(e.kits === 1 ? t.itemUnknownOne : t.itemUnknownMany, { n: e.kits })}
            </li>
          ))}
        </ul>
        <p className="text-xs text-[#98A0A9]">{t.workKept}</p>
      </div>
      <DismissWithdrawn seenAt={newest} label={t.dismiss} />
    </section>
  );
}
