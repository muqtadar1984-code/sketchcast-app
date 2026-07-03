import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import AppHeader from "../app-header";
import { InkUnderline } from "@/components/ink-mark";
import InviteManager, { type InviteRow } from "./invite-manager";

// School-admin only: issue email invites for school_admin / teacher roles.
// Elevated roles are GRANTED here, never self-selected at signup.
export default async function InvitesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, role, school_id")
    .eq("id", user.id)
    .single();
  const role = (profile?.role as string | null) ?? null;
  if (role !== "school_admin") redirect("/dashboard");

  const { data: invitesRaw } = await supabase
    .from("invites")
    .select("id, email, role, token, accepted_at, expires_at, created_at")
    .order("created_at", { ascending: false });
  const invites = (invitesRaw ?? []) as InviteRow[];

  return (
    <div className="min-h-screen bg-[#FCFCFA] text-[#14181F]">
      <AppHeader />
      <main className="max-w-3xl mx-auto px-6 py-10">
        <h1 className="text-4xl mb-2">Invites</h1>
        <InkUnderline className="block h-3 w-28 mb-3" />
        <p className="text-[#5B6470] mb-7">
          Invite school admins and teachers to your school by email. Elevated roles are granted here —
          never self-selected at signup.
        </p>
        <InviteManager invites={invites} schoolId={(profile?.school_id as string | null) ?? null} />
      </main>
    </div>
  );
}
