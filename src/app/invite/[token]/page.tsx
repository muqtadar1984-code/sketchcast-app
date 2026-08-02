import { Fragment } from "react";
import Link from "next/link";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { LogoMark } from "../../dashboard/icons";
import InviteClient from "./invite-client";
import { getDictionary, type Dictionary } from "@/i18n/dictionaries";
import { resolveLocale } from "@/i18n/resolve";
import { fmt } from "@/i18n/format";

type InviteMessages = Dictionary["app"]["invite"];

// The invite's role code is the DB enum and never translated — this maps it to
// the dictionary's camelCase keys, so an unrecognised role falls through to the
// raw code rather than a blank chip.
const ROLE_KEY: Record<string, keyof InviteMessages["roles"]> = {
  school_admin: "schoolAdmin",
  teacher: "teacher",
  parent: "parent",
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
  const locale = await resolveLocale();
  const t = await getDictionary(locale);
  const m = t.app.invite;

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return (
      <Shell>
        <p className="text-sm text-red-600">{m.notAvailable}</p>
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
    const msg = invite?.accepted_at ? m.used : !invite ? m.invalid : m.expired;
    return (
      <Shell>
        <h1 className="text-xl mb-1">{m.unavailableTitle}</h1>
        <p className="text-sm text-[#5B6470] mb-4">{msg}</p>
        <Link href="/login" className="text-sm text-[#0C8175] font-medium hover:underline">
          {m.goToSignIn}
        </Link>
      </Shell>
    );
  }

  const s = invite.schools as unknown;
  const schoolName =
    (Array.isArray(s) ? s[0]?.name : (s as { name?: string } | null)?.name) || m.fallbackSchool;
  const roleKey = ROLE_KEY[invite.role as string];
  const roleLabel = roleKey ? m.roles[roleKey] : (invite.role as string);
  const reasonKey = e && e in m.reason ? (e as keyof InviteMessages["reason"]) : null;

  // "Join {school} as {role}" is ONE sentence so a translator owns its word
  // order — split on the placeholders here so the school name keeps its emphasis
  // and the role keeps its chip, wherever in the sentence they land.
  const invited = m.joinAs.split(/(\{school\}|\{role\})/);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <Shell>
      <h1 className="text-xl mb-1">{m.title}</h1>
      <p className="text-sm text-[#5B6470] mb-1">
        {invited.map((piece, i) =>
          piece === "{school}" ? (
            <span key={i} className="font-medium text-[#14181F]">
              {schoolName}
            </span>
          ) : piece === "{role}" ? (
            <span key={i} className="chip bg-[#E2F4F1] text-[#0C8175]">
              {roleLabel}
            </span>
          ) : (
            <Fragment key={i}>{piece}</Fragment>
          ),
        )}
      </p>
      <p className="text-xs text-[#98A0A9] mb-5">{fmt(m.forEmail, { email: invite.email })}</p>
      {reasonKey && (
        <p role="alert" className="text-sm text-red-600 mb-4">
          {m.reason[reasonKey]}
        </p>
      )}
      <InviteClient
        token={token}
        email={invite.email}
        signedInEmail={user?.email ?? null}
        t={m}
        auth={t.app.auth}
        oauth={t.app.oauth}
      />
    </Shell>
  );
}
