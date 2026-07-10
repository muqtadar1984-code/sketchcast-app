"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { LogoMark } from "../../dashboard/icons";

// Choose a new password. Reached two ways, both with a session already set:
//   1. a recovery email — /auth/confirm verifies the OTP and lands here;
//   2. the dashboard redirect while profiles.must_reset_password is set
//      (temp password handed out by a teacher/parent/admin, or a freshly
//      provisioned student login).
// On success we clear must_reset_password through the user's OWN RLS update —
// it's one of the column-granted self-serve profile fields (migration 0010) —
// then head to the dashboard.
export default function UpdatePasswordPage() {
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
      setError("Password must be at least 8 characters.");
      return;
    }
    if (pw !== pw2) {
      setError("The two passwords don't match.");
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

  return (
    <main className="min-h-screen flex items-center justify-center bg-[#FCFCFA] px-4">
      <div className="w-full max-w-sm card rounded-2xl p-8">
        <div className="flex items-center gap-2.5 mb-1">
          <LogoMark size={34} />
          <h1 className="text-2xl">
            SketchCast <span className="text-[#0C8175]">AI</span>
          </h1>
        </div>
        <p className="text-sm text-[#5B6470] mt-1 mb-6">Choose a new password</p>

        {session === "checking" && <p className="text-sm text-[#5B6470]">One moment…</p>}

        {session === "none" && (
          <div className="space-y-4">
            <p className="text-sm text-[#14181F] bg-[#FFF1D6] rounded-lg px-3 py-2.5">
              This link has expired or you&apos;re not signed in.
            </p>
            <p className="text-sm text-[#5B6470]">
              <Link href="/login/forgot" className="text-[#0C8175] font-medium hover:underline">
                Request a new reset link
              </Link>{" "}
              or{" "}
              <Link href="/login" className="text-[#0C8175] font-medium hover:underline">
                sign in
              </Link>
              .
            </p>
          </div>
        )}

        {session === "ok" && (done ? (
          <p className="text-sm text-[#14181F] bg-[#E2F4F1] rounded-lg px-3 py-2.5">
            Password updated — taking you to your dashboard…
          </p>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <input
              type="password" required placeholder="New password (min 8 characters)" value={pw}
              onChange={(e) => setPw(e.target.value)} minLength={8} autoComplete="new-password"
              className="field w-full h-11 px-3 text-[#14181F]"
            />
            <input
              type="password" required placeholder="Repeat new password" value={pw2}
              onChange={(e) => setPw2(e.target.value)} minLength={8} autoComplete="new-password"
              className="field w-full h-11 px-3 text-[#14181F]"
            />
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button type="submit" disabled={busy} className="btn-primary w-full h-11">
              {busy ? "Saving…" : "Set new password"}
            </button>
          </form>
        ))}
      </div>
    </main>
  );
}
