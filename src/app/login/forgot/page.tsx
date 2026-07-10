"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/utils/supabase/client";
import { LogoMark } from "../../dashboard/icons";

// Self-serve password recovery — adults with real emails only. Student IDs
// (no "@") map to synthetic @students.sketchcast.app addresses that receive no
// mail, so students are pointed at their teacher/parent instead. The response
// message is the same whether or not the address exists (no enumeration).
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [studentHint, setStudentHint] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const value = email.trim();
    if (!value) return;
    if (!value.includes("@")) {
      // A student ID, not an email — recovery mail can't reach it.
      setStudentHint(true);
      return;
    }
    setStudentHint(false);
    setLoading(true);
    const supabase = createClient();
    // The recovery link lands on /auth/confirm (verifies the OTP → session),
    // then /auth/update-password. Result deliberately ignored: same message
    // either way so the form can't probe which emails exist.
    await supabase.auth.resetPasswordForEmail(value, {
      redirectTo: `${window.location.origin}/auth/confirm?next=/auth/update-password`,
    });
    setLoading(false);
    setSent(true);
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
        <p className="text-sm text-[#5B6470] mt-1 mb-6">Reset your password</p>

        {sent ? (
          <p className="text-sm text-[#14181F] bg-[#E2F4F1] rounded-lg px-3 py-2.5">
            If an account exists for that email, a reset link is on its way.
            Check your inbox (and spam folder).
          </p>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <input
              required placeholder="Your email" value={email}
              onChange={(e) => { setEmail(e.target.value); setStudentHint(false); }}
              className="field w-full h-11 px-3 text-[#14181F]"
            />
            {studentHint && (
              <p className="text-sm text-[#9A6400] bg-[#FFF1D6] rounded-lg px-3 py-2">
                That looks like a student ID. Student accounts don&apos;t have an
                email — ask your teacher or parent to reset your password from
                their dashboard.
              </p>
            )}
            <button type="submit" disabled={loading} className="btn-primary w-full h-11">
              {loading ? "Sending…" : "Send reset link"}
            </button>
          </form>
        )}

        <p className="text-sm text-[#5B6470] mt-6 text-center">
          Remembered it?{" "}
          <Link href="/login" className="text-[#0C8175] font-medium hover:underline">
            Back to sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
