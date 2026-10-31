import Link from "next/link";
import { notFound } from "next/navigation";
import { skAccessAllowed } from "@/utils/flags";
import { createClient } from "@/utils/supabase/server";
import { getDictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";
import { dirFor } from "@/i18n/locales";
import { childPicker, type LinkedChild } from "@/sk/book-activate";
import { verifiedChildren } from "@/sk/book-redeem";
import ActivateForm from "./activate-form";

// /activate — the page printed in every book: activate a code card (SKB…,
// one per copy) or a KDP copy (the edition code SKE-… printed in the book
// plus the buyer's Amazon order number). Distribution plan §6. The routes
// under /api/sk/{redeem,activate} carry the authoritative checks; this page
// only renders the form. Behind NEXT_PUBLIC_FEATURE_SK like the student page,
// and 404 to anyone skAccessAllowed() refuses while an allow-list is in force.
//
// SK S4 slice D (design 2026-10-29, decision 3): a signed-in parent with
// VERIFIED linked children activates FOR A CHILD — one child is preselected,
// two or more must be chosen (no default). A parent with no linked child
// keeps today's behaviour (the grant is theirs) with a note saying so.
// Students and teachers see the form as before. The children are read with
// the user-session client (parent_links' own RLS: parent_id = auth.uid()); the
// RPC re-checks the verified link whatever the browser sends.
//
// Printed URL:    https://app.sketchcast.app/activate
// Button label:   "Activate my book"

export const dynamic = "force-dynamic";

export default async function ActivatePage() {
  if (process.env.NEXT_PUBLIC_FEATURE_SK !== "true") notFound();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!(await skAccessAllowed(user))) notFound();
  const locale = await resolveLocale();
  const t = (await getDictionary(locale)).activate;

  let picker = childPicker(null, []);
  if (user) {
    const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
    const role = (profile?.role as string | null) ?? null;
    const children: LinkedChild[] = role === "student" ? [] : await verifiedChildren(supabase, user.id);
    picker = childPicker(role, children);
  }

  const [before, after] = t.signIn.split("{link}");
  return (
    <main className="min-h-screen bg-[#F6F7F5] p-4 sm:p-8" dir={dirFor(locale)} lang={locale}>
      <div className="mx-auto max-w-md rounded-2xl bg-white p-5 sm:p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-slate-900">{t.title}</h1>
        <p className="mt-2 text-sm text-slate-600">{t.intro}</p>
        {user ? (
          <ActivateForm t={t} picker={picker} />
        ) : (
          <p className="mt-6 text-sm text-slate-700">
            {before}
            <Link href="/login?next=/activate" className="font-medium text-emerald-700 underline">
              {t.signInLink}
            </Link>
            {after ?? ""}
          </p>
        )}
      </div>
    </main>
  );
}
