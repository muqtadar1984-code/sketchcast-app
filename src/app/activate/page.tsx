import Link from "next/link";
import { notFound } from "next/navigation";
import { skUserAllowed } from "@/utils/flags";
import { createClient } from "@/utils/supabase/server";
import ActivateForm from "./activate-form";

// /activate — the page printed in every book: activate a code card (SKB…,
// one per copy) or a KDP copy (the edition code SKE-… printed in the book
// plus the buyer's Amazon order number). Distribution plan §6. The routes
// under /api/sk/{redeem,activate} carry the authoritative checks; this page
// only renders the form. Behind NEXT_PUBLIC_FEATURE_SK like the student page,
// and 404 to anyone off the SK_ALLOWED_EMAILS list while that is in force.
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
  if (process.env.SK_ALLOWED_EMAILS && !skUserAllowed(user)) notFound();
  return (
    <main className="min-h-screen bg-[#F6F7F5] p-4 sm:p-8">
      <div className="mx-auto max-w-md rounded-2xl bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-slate-900">Activate your book</h1>
        <p className="mt-2 text-sm text-slate-600">
          Enter the code printed in your book. Book access is yours for good; SK tutoring runs for 30 days from today.
        </p>
        {user ? (
          <ActivateForm />
        ) : (
          <p className="mt-6 text-sm text-slate-700">
            Please{" "}
            <Link href="/login?next=/activate" className="font-medium text-emerald-700 underline">
              sign in
            </Link>{" "}
            first, then come back to this page.
          </p>
        )}
      </div>
    </main>
  );
}
