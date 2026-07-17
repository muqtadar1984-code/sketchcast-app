import { redirect } from "next/navigation";
import { createClient } from "@/utils/supabase/server";
import AppHeader from "../app-header";
import { InkUnderline } from "@/components/ink-mark";
import { parentPortalEnabled } from "@/utils/flags";
import { enforceHat } from "@/utils/hats-server";
import InviteManager, { type InviteRow, type SchoolStudent } from "./invite-manager";

// School-admin only: issue email invites for school_admin / teacher / parent
// roles. Elevated roles are GRANTED here, never self-selected at signup;
// parent invites carry a child mapping.
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
  // One-hat mode: Invites are the Principal hat's onboarding tool.
  const hatAway = await enforceHat(supabase, role, (profile?.school_id as string | null) ?? null, "principal");
  if (hatAway) redirect(hatAway);

  const { data: invitesRaw } = await supabase
    .from("invites")
    .select("id, email, role, token, accepted_at, expires_at, created_at")
    .order("created_at", { ascending: false });
  const invites = (invitesRaw ?? []) as InviteRow[];

  // The school's students, for parent-invite child mapping (RLS: the admin can
  // read their own school's profiles). parent_email drives suggested matches.
  let students: SchoolStudent[] = [];
  if (parentPortalEnabled()) {
    const { data: stuRaw } = await supabase
      .from("profiles")
      .select("id, full_name, username, parent_email, role")
      .eq("school_id", profile!.school_id)
      .eq("role", "student");
    students = ((stuRaw ?? []) as { id: string; full_name: string | null; username: string | null; parent_email: string | null }[])
      .map((s) => ({
        id: s.id,
        name: s.full_name || s.username || "Student",
        username: s.username,
        parentEmail: s.parent_email,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  return (
    <div className="min-h-screen bg-[#FCFCFA] text-[#14181F]">
      <AppHeader />
      <main className="max-w-3xl mx-auto px-6 py-10">
        <h1 className="text-4xl mb-2">Invites</h1>
        <InkUnderline className="block h-3 w-28 mb-3" />
        <p className="text-[#5B6470] mb-7">
          Invite parents to your school by email — each invite carries the child mapping. Teacher and
          admin accounts are set up, edited and removed by SketchCast for you: contact support to add
          or change staff.
        </p>
        <InviteManager
          invites={invites}
          schoolId={(profile?.school_id as string | null) ?? null}
          students={students}
          parentEnabled={parentPortalEnabled()}
        />
      </main>
    </div>
  );
}
