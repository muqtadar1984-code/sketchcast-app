"use client";

import { useState } from "react";
import { createClient } from "@/utils/supabase/client";
import type { Dictionary } from "@/i18n/dictionaries";

// Self-serve password recovery — adults with real emails only. Student IDs
// (no "@") map to synthetic @students.sketchcast.app addresses that receive no
// mail, so students are pointed at their teacher/parent instead. The response
// message is the same whether or not the address exists (no enumeration).
//
// The interactive half of /login/forgot; the page around it is a Server
// Component that resolves these words from the request's dictionary.
export default function ForgotForm({ t }: { t: Dictionary["app"]["forgot"] }) {
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

  if (sent) {
    return <p className="text-sm text-[#14181F] bg-[#E2F4F1] rounded-lg px-3 py-2.5">{t.sent}</p>;
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <input
        required placeholder={t.emailPlaceholder} value={email}
        onChange={(e) => { setEmail(e.target.value); setStudentHint(false); }}
        className="field w-full h-11 px-3 text-[#14181F]"
      />
      {studentHint && (
        <p className="text-sm text-[#9A6400] bg-[#FFF1D6] rounded-lg px-3 py-2">{t.studentHint}</p>
      )}
      <button type="submit" disabled={loading} className="btn-primary w-full h-11">
        {loading ? t.sending : t.send}
      </button>
    </form>
  );
}
