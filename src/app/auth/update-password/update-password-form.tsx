"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import type { Dictionary } from "@/i18n/dictionaries";

// Choose a new password. Reached two ways, both with a session already set:
//   1. a recovery email — /auth/confirm verifies the OTP and lands here;
//   2. the dashboard redirect while profiles.must_reset_password is set
//      (temp password handed out by a teacher/parent/admin, or a freshly
//      provisioned student login).
// On success we clear must_reset_password through the user's OWN RLS update —
// it's one of the column-granted self-serve profile fields (migration 0010) —
// then head to the dashboard.
//
// The session check runs in the browser (the recovery session is established
// client-side by the confirm route), so this whole panel is a client component;
// the page above it resolves the words.
export default function UpdatePasswordForm({
  t,
  auth,
  common,
}: {
  t: Dictionary["app"]["updatePassword"];
  auth: Dictionary["app"]["auth"];
  common: Dictionary["common"];
}) {
  const router = useRouter();
  const [session, setSession] = useState<"checking" | "ok" | "none">("checking");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => setSession(user ? "ok" : "none"));
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (pw.length < 8) {
      setError(t.tooShort);
      return;
    }
    if (pw !== pw2) {
      setError(t.mismatch);
      return;
    }
    setBusy(true);
    const supabase = createClient();
    const { error: upErr } = await supabase.auth.updateUser({ password: pw });
    if (upErr) {
      setError(upErr.message);
      setBusy(false);
      return;
    }
    // Clear the forced-change flag (no-op when it wasn't set). Own row +
    // granted column → allowed for every role, students included.
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      await supabase.from("profiles").update({ must_reset_password: false }).eq("id", user.id);
    }
    setDone(true);
    router.push("/dashboard");
    router.refresh();
  }

  if (session === "checking") return <p className="text-sm text-[#5B6470]">{t.checking}</p>;

  if (session === "none") {
    return (
      <div className="space-y-4">
        <p className="text-sm text-[#14181F] bg-[#FFF1D6] rounded-lg px-3 py-2.5">{t.expired}</p>
        {/* Two doors in one sentence: the words between and after the links are
            the translator's to move, so each is its own message. */}
        <p className="text-sm text-[#5B6470]">
          <Link href="/login/forgot" className="text-[#0C8175] font-medium hover:underline">
            {t.requestNewLink}
          </Link>{" "}
          {auth.or}{" "}
          <Link href="/login" className="text-[#0C8175] font-medium hover:underline">
            {t.signInLink}
          </Link>
          .
        </p>
      </div>
    );
  }

  if (done) {
    return <p className="text-sm text-[#14181F] bg-[#E2F4F1] rounded-lg px-3 py-2.5">{t.updated}</p>;
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <input
        type="password" required placeholder={t.newPassword} value={pw}
        onChange={(e) => setPw(e.target.value)} minLength={8} autoComplete="new-password"
        className="field w-full h-11 px-3 text-[#14181F]"
      />
      <input
        type="password" required placeholder={t.repeatPassword} value={pw2}
        onChange={(e) => setPw2(e.target.value)} minLength={8} autoComplete="new-password"
        className="field w-full h-11 px-3 text-[#14181F]"
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button type="submit" disabled={busy} className="btn-primary w-full h-11">
        {busy ? common.saving : t.submit}
      </button>
    </form>
  );
}
