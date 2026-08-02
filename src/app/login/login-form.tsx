"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/utils/supabase/client";
import { studentEmail } from "@/utils/student";
import type { Dictionary } from "@/i18n/dictionaries";

// The sign-in form itself — the only interactive part of /login, split out so
// the page around it stays a Server Component and can resolve the dictionary.
// Its words arrive as props; the type import is type-only and erased, so the
// server-only dictionary module never reaches the browser bundle.
//
// Supabase's own auth errors are shown verbatim (error.message): they come from
// the auth server, not from us, and translating them belongs with the rest of
// the API error work.
export default function LoginForm({
  t,
  auth,
}: {
  t: Dictionary["app"]["login"];
  auth: Dictionary["app"]["auth"];
}) {
  const router = useRouter();
  // ?email= prefills the field — makes per-role login links bookmarkable
  // (e.g. teacher.sketchcast.app/login?email=demo.teacher1@sketchcast.app for
  // side-by-side multi-account testing across subdomains).
  const prefill = useSearchParams().get("email") ?? "";
  const [email, setEmail] = useState(prefill);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const supabase = createClient();
    // Teachers sign in with their email; invited students use their ID (no "@"),
    // which maps to the synthetic student login address.
    const loginEmail = email.includes("@") ? email.trim() : studentEmail(email);
    const { error } = await supabase.auth.signInWithPassword({ email: loginEmail, password });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <input
        required placeholder={t.emailOrId} value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="field w-full h-11 px-3 text-[#14181F]"
      />
      <input
        type="password" required placeholder={auth.password} value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="field w-full h-11 px-3 text-[#14181F]"
      />
      <div className="flex justify-end">
        <Link href="/login/forgot" className="text-xs text-[#0C8175] font-medium hover:underline">
          {t.forgot}
        </Link>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button type="submit" disabled={loading} className="btn-primary w-full h-11">
        {loading ? t.signingIn : auth.signIn}
      </button>
    </form>
  );
}
