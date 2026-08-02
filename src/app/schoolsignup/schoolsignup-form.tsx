"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import type { Dictionary } from "@/i18n/dictionaries";

// The account half of "Set up your school" — create the account here, name the
// school on /schoolsignup/finish. Split out of the page so the page can stay a
// Server Component and resolve the copy from the request's dictionary.
export default function SchoolSignupForm({ t }: { t: Dictionary["app"]["schoolSignup"] }) {
  const router = useRouter();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setLoading(true);
    const supabase = createClient();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName },
        // If email confirmation is on, land back on the finish step after confirming.
        emailRedirectTo: `${location.origin}/auth/confirm?next=/schoolsignup/finish`,
      },
    });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    if (data.session) {
      router.push("/schoolsignup/finish");
      return;
    }
    setNotice(t.confirmEmail);
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <input
        required
        placeholder={t.yourFullName}
        value={fullName}
        onChange={(e) => setFullName(e.target.value)}
        className="field w-full h-11 px-3 text-[#14181F]"
      />
      <input
        type="email"
        required
        placeholder={t.workEmail}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="field w-full h-11 px-3 text-[#14181F]"
      />
      <input
        type="password"
        required
        minLength={6}
        placeholder={t.createPassword}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="field w-full h-11 px-3 text-[#14181F]"
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      {notice && <p className="text-sm text-[#0C8175]">{notice}</p>}
      <button type="submit" disabled={loading} className="btn-primary w-full h-11">
        {loading ? t.creating : t.continue}
      </button>
    </form>
  );
}
