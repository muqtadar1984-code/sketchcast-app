"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { isDisposableEmail } from "@/utils/disposable-email";
import type { Dictionary } from "@/i18n/dictionaries";

// The account half of "Set up your school" — create the account here, name the
// school on /schoolsignup/finish. Split out of the page so the page can stay a
// Server Component and resolve the copy from the request's dictionary.
export default function SchoolSignupForm({
  t,
  auth,
  country,
}: {
  t: Dictionary["app"]["schoolSignup"];
  /** The shared auth strings — this form only needs the disposable-address
   * refusal, which /signup and the invite form word identically. */
  auth: Dictionary["app"]["auth"];
  /** The edge's guess at where this school is, from the page's server render.
   * Null is normal and simply sends nothing. */
  country: string | null;
}) {
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
    // Disposable addresses are refused by the database (0117); asking first is
    // what turns "Database error saving new user" into a sentence.
    if (await isDisposableEmail(supabase, email)) {
      setLoading(false);
      setError(auth.disposableEmail);
      return;
    }
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName, ...(country ? { country } : {}) },
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
