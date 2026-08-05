import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import AppHeader from "../../app-header";
import { InkUnderline } from "@/components/ink-mark";
import BookHealthBadge, { type BookHealth } from "../../book-health-badge";
import { type LibraryMessages } from "../../content-cell";
import WithdrawBook from "./withdraw-book";
import { schoolAnalyticsEnabledFor } from "@/utils/flags";
import { enforceHat } from "@/utils/hats-server";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";
import { htmlLang } from "@/i18n/locales";
import { fmt } from "@/i18n/format";

// The school's shelf, as leadership sees it.
//
// Deliberately NOT the teacher Library: a principal is a librarian here, not a
// lesson author. No chapters, no kit controls, no generate buttons — what the
// school owns, who put it there, and whether it can be retired.
//
// The one exception to "hide the detail" is HEALTH. Central upload concentrates
// the quality risk: a book indexed badly is not one teacher's bad kit any more,
// it is every teacher who reaches for that book (which is exactly how the
// scanned-book mislabel got out). So the one signal that predicts that stays
// visible, right where a book is added.

export const dynamic = "force-dynamic";

type ShelfRow = {
  id: string;
  title: string;
  author: string | null;
  grade: string | null;
  subject: string | null;
  status: string | null;
  created_at: string;
  owner_id: string;
  health: BookHealth | null;
};

export default async function SchoolBooksPage() {
  const locale = await resolveLocale();
  const dict = await getDictionary(locale);
  const t = dict.school.books;
  // The health badge is a Library component and speaks the Library's composed
  // message shape — reuse it rather than teaching it a second one.
  const libraryT: LibraryMessages = { ...dict.library, common: dict.common, utils: dict.utils };
  const lang = htmlLang(locale);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, school_id")
    .eq("id", user.id)
    .single();
  const role = (profile?.role as string | null) ?? null;
  const schoolId = (profile?.school_id as string | null) ?? null;
  if (!role || role === "student" || !schoolId) redirect("/dashboard");
  if (!(await schoolAnalyticsEnabledFor(supabase, schoolId))) redirect("/dashboard");

  // THE authorisation gate. enforceHat below is NOT one — it is presentation
  // only, and returns null whenever there is no `sc_hat` cookie (a teacher who
  // has never used the hat switcher has none) or when FEATURE_ROLE_HATS is off.
  // Without this check any teacher in the school could open the leadership
  // inventory and see a Retire control on every colleague's book; the RPCs
  // would refuse the act, but the surface itself should never render. Same
  // shape as school/page.tsx and school/access/page.tsx.
  const isAdmin = role === "school_admin";
  if (!isAdmin) {
    // Scope in THIS school only — a stale grant from a former school must not
    // open the door (0052).
    const { data: scopes } = await supabase
      .from("coordinator_scope")
      .select("id")
      .eq("school_id", schoolId)
      .limit(1);
    if ((scopes?.length ?? 0) === 0) redirect("/dashboard");
  }

  // One-hat mode: the School pages belong to the leadership hats.
  const hatAway = await enforceHat(supabase, role, schoolId, "leadership");
  if (hatAway) redirect(hatAway);

  // The whole shelf, the reader's own uploads included — this is the school's
  // inventory, not "other people's books". RLS (books_read) already scopes it;
  // the explicit filter is what makes it the SCHOOL's shelf rather than
  // everything the reader may see.
  const { data: booksRaw } = await supabase
    .from("books")
    .select("id, title, author, grade, subject, status, created_at, owner_id, health")
    .eq("school_id", schoolId)
    .order("created_at", { ascending: false });
  const books = (booksRaw ?? []) as unknown as ShelfRow[];

  // Who uploaded what, and how much work now depends on each book. Both are
  // best-effort: a failure here must leave the shelf readable, just plainer.
  const uploaderName = new Map<string, string>();
  const kitCount = new Map<string, number>();
  if (books.length) {
    const ownerIds = [...new Set(books.map((b) => b.owner_id))];
    const [{ data: owners }, { data: gens }] = await Promise.all([
      supabase.from("profiles").select("id, full_name, username").in("id", ownerIds),
      supabase
        .from("generations")
        .select("id, book_id")
        .in(
          "book_id",
          books.map((b) => b.id),
        )
        .is("withdrawn_at", null),
    ]);
    for (const o of (owners ?? []) as { id: string; full_name: string | null; username: string | null }[]) {
      const name = o.full_name || o.username;
      if (name) uploaderName.set(o.id, name);
    }
    for (const g of (gens ?? []) as { book_id: string | null }[]) {
      if (g.book_id) kitCount.set(g.book_id, (kitCount.get(g.book_id) ?? 0) + 1);
    }
  }

  return (
    <div className="min-h-screen bg-[#FCFCFA] text-[#14181F]">
      <AppHeader />
      <main className="max-w-7xl mx-auto px-6 py-10">
        <h1 className="text-4xl mb-2">{t.title}</h1>
        <InkUnderline className="block h-3 w-28 mb-3" />
        <p className="text-[#5B6470] mb-7">{t.intro}</p>

        {books.length === 0 ? (
          <div className="card px-5 py-8 text-sm text-[#5B6470]">{t.empty}</div>
        ) : (
          <div className="card divide-y divide-[#EEF0EC]">
            {books.map((b) => {
              const kits = kitCount.get(b.id) ?? 0;
              return (
                <div key={b.id} className="px-5 py-3.5 flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-display font-medium [overflow-wrap:anywhere]">{b.title}</span>
                      <BookHealthBadge health={b.health} t={libraryT} />
                      {b.status === "indexing" && (
                        <span className="chip bg-[#FFF1D6] text-[#9A6400]">{t.indexing}</span>
                      )}
                    </div>
                    <div className="text-xs text-[#5B6470] mt-0.5">
                      {[
                        b.author || t.unknownAuthor,
                        [b.grade, b.subject].filter(Boolean).join(" · ") || null,
                        uploaderName.get(b.owner_id)
                          ? fmt(t.addedBy, { name: uploaderName.get(b.owner_id)! })
                          : null,
                        new Date(b.created_at).toLocaleDateString(lang),
                      ]
                        .filter(Boolean)
                        .join("  ·  ")}
                    </div>
                    <div className="text-xs text-[#98A0A9] mt-0.5">
                      {kits === 1 ? t.kitsOne : fmt(t.kitsMany, { n: kits })}
                    </div>
                  </div>
                  <div className="shrink-0 self-center">
                    <WithdrawBook bookId={b.id} title={b.title} t={t.withdraw} />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <p className="text-xs text-[#98A0A9] mt-4">{t.note}</p>
      </main>
    </div>
  );
}
