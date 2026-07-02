import Link from "next/link";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { LogoMark } from "../../dashboard/icons";
import InviteClient from "./invite-client";

const ROLE_LABEL: Record<string, string> = { school_admin: "School admin", teacher: "Teacher" };
const REASON: Record<string, string> = {
  invalid: "This invitation link is invalid.",
  expired: "This invitation has expired.",
  email: "That invitation is for a different email address — sign out and use that email.",
  apply: "Something went wrong accepting the invitation. Please try again.",
  server: "Invites aren't configured on the server.",
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen flex items-center justify-center bg-[#FCFCFA] px-4">
      <div className="w-full max-w-sm card rounded-2xl p-8">
        <div className="flex items-center gap-2.5 mb-4">
          <LogoMark size={30} />
          <span className="text-xl font-display">
            SketchCast <span className="text-[#0C8175]">AI</span>
          </span>
        </div>
        {children}
      </div>
    </main>
  );
}

// Public invite-acceptance page. The token IS the secret, so we read the invite
// with the service role (RLS would hide it from an anonymous visitor). Elevation
// happens in /invite/[token]/accept after the invitee authenticates.
export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ e?: string }>;
}) {
  const { token } = await params;
  const { e } = await searchParams;

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return (
      <Shell>
        <p className="text-sm text-red-600">Invites aren&apos;t available right now.</p>
      </Shell>
    );
  }

  const { data: invite } = await admin
    .from("invites")
    .select("email, role, accepted_at, expires_at, schools(name)")
    .eq("token", token)
    .maybeSingle();

  // (server component, rendered once per request — Date.now is fine here)
  // eslint-disable-next-line react-hooks/purity
  const dead = !invite || invite.accepted_at || new Date(invite.expires_at).getTime() < Date.now();
  if (dead) {
    const msg = invite?.accepted_at
      ? "This invitation has already been used."
      : !invite
        ? "This invitation link is invalid."
        : "This invitation has expired.";
    return (
      <Shell>
        <h1 className="text-xl mb-1">Invitation unavailable</h1>
        <p className="text-sm text-[#5B6470] mb-4">{msg}</p>
        <Link href="/login" className="text-sm text-[#0C8175] font-medium hover:underline">
          Go to sign in
        </Link>
      </Shell>
    );
  }

  const s = invite.schools as unknown;
  const schoolName =
    (Array.isArray(s) ? s[0]?.name : (s as { name?: string } | null)?.name) || "your school";
  const roleLabel = ROLE_LABEL[invite.role] || invite.role;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <Shell>
      <h1 className="text-xl mb-1">You&apos;re invited</h1>
      <p className="text-sm text-[#5B6470] mb-1">
        Join <span className="font-medium text-[#14181F]">{schoolName}</span> as{" "}
        <span className="chip bg-[#E2F4F1] text-[#0C8175]">{roleLabel}</span>
      </p>
      <p className="text-xs text-[#98A0A9] mb-5">for {invite.email}</p>
      {e && REASON[e] && (
        <p role="alert" className="text-sm text-red-600 mb-4">
          {REASON[e]}
        </p>
      )}
      <InviteClient token={token} email={invite.email} signedInEmail={user?.email ?? null} />
    </Shell>
  );
}
