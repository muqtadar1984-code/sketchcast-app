"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import OAuthButton from "@/components/oauth-button";
import { fmt } from "@/i18n/format";
import type { Dictionary } from "@/i18n/dictionaries";

// Accept-invite UI. Redemption (role elevation) always runs server-side at
// /invite/[token]/accept after auth; this just gets the invitee authenticated
// with the INVITED email so that route's email check passes.
//
// Its words come from the (server) invite page, which already resolved the
// dictionary to read the invite itself.
export default function InviteClient({
  token,
  email,
  signedInEmail,
  country,
  t,
  auth,
  oauth,
}: {
  token: string;
  email: string;
  signedInEmail: string | null;
  /** The edge's guess at where this invitee is, from the invite page's server
   * render. Null is normal and simply sends nothing. */
  country: string | null;
  t: Dictionary["app"]["invite"];
  auth: Dictionary["app"]["auth"];
  oauth: Dictionary["app"]["oauth"];
}) {
  const router = useRouter();
  const acceptPath = `/invite/${token}/accept`;
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Already signed in → accept if the email matches, else tell them to switch.
  if (signedInEmail) {
    if (signedInEmail.toLowerCase() === email.toLowerCase()) {
      return (
        <button onClick={() => router.push(acceptPath)} className="btn-primary w-full h-11">
          {t.accept}
        </button>
      );
    }
    return (
      <div>
        <p className="text-sm text-[#5B6470] mb-3">
          {fmt(t.wrongAccount, { signedIn: signedInEmail, invited: email })}
        </p>
        <form action="/auth/signout" method="post">
          <button className="btn-ghost w-full h-11">{auth.signOut}</button>
        </form>
      </div>
    );
  }

  async function signUp(ev: React.FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const supabase = createClient();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: name, ...(country ? { country } : {}) },
        // After confirming their email, land straight back on the accept route —
        // without this, invitees had to manually reopen the invite link.
        emailRedirectTo: `${location.origin}/auth/confirm?next=${encodeURIComponent(acceptPath)}`,
      },
    });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    if (data.session) {
      router.push(acceptPath);
      return;
    }
    setNotice(t.confirmEmail);
  }

  return (
    <div>
      <form onSubmit={signUp} className="space-y-3">
        <input
          required
          placeholder={auth.fullName}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="field w-full h-11 px-3"
        />
        <input value={email} readOnly aria-label={t.invitedEmail} className="field w-full h-11 px-3 bg-[#F5F6F3] text-[#5B6470]" />
        <input
          type="password"
          required
          minLength={6}
          placeholder={t.createPassword}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="field w-full h-11 px-3"
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
        {notice && <p className="text-sm text-[#0C8175]">{notice}</p>}
        <button type="submit" disabled={busy} className="btn-primary w-full h-11">
          {busy ? t.creating : t.submit}
        </button>
      </form>

      <div className="flex items-center gap-3 my-4">
        <span className="h-px flex-1 bg-[#E6E8E4]" />
        <span className="text-xs text-[#98A0A9]">{auth.or}</span>
        <span className="h-px flex-1 bg-[#E6E8E4]" />
      </div>
      <OAuthButton provider="google" mode="up" next={acceptPath} t={oauth} />
      <p className="text-xs text-[#98A0A9] mt-3">{fmt(t.googleHint, { email })}</p>
    </div>
  );
}
