import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import { LogoMark } from "../../dashboard/icons";
import FinishForm from "./finish-form";

// Both signup paths (email + Google) land here after auth to name the new school.
export default async function SchoolFinishPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/schoolsignup");

  const { data: profile } = await supabase
    .from("profiles")
    .select("school_id")
    .eq("id", user.id)
    .single();
  // Already part of a school → nothing to set up here.
  if (profile?.school_id) redirect("/dashboard");

  return (
    <main className="min-h-screen flex items-center justify-center bg-[#FCFCFA] px-4">
      <div className="w-full max-w-sm card rounded-2xl p-8">
        <div className="flex items-center gap-2.5 mb-1">
          <LogoMark size={34} />
          <h1 className="text-2xl">Name your school</h1>
        </div>
        <p className="text-sm text-[#5B6470] mt-1 mb-6">
          Signed in as {user.email}. This creates your school and makes you its admin — you can
          invite teachers right after.
        </p>
        <FinishForm />
      </div>
    </main>
  );
}
