"use client";

import { Suspense, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/utils/supabase/client";
import { LogoMark } from "../dashboard/icons";
import OAuthButton from "@/components/oauth-button";
import AuthError from "@/components/auth-error";

// Public "Set up your school" (option C). Create an account (email or Google),
// then name your NEW school on the next step and become its admin. Both paths
// funnel through /schoolsignup/finish.
export default function SchoolSignupPage() {
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
    setNotice("Check your email to confirm your account — then you'll name your school.");
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-[#FCFCFA] px-4">
      <div className="w-full max-w-sm card rounded-2xl p-8">
        <div className="flex items-center gap-2.5 mb-1">
          <LogoMark size={34} />
          <h1 className="text-2xl">Set up your school</h1>
        </div>
        <p className="text-sm text-[#5B6470] mt-1 mb-6">
          Create your school on SketchCast, then invite your teachers.
        </p>

        <Suspense fallback={null}>
          <AuthError />
        </Suspense>

        <form onSubmit={onSubmit} className="space-y-4">
          <input
            required
            placeholder="Your full name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className="field w-full h-11 px-3 text-[#14181F]"
          />
          <input
            type="email"
            required
            placeholder="Work email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="field w-full h-11 px-3 text-[#14181F]"
          />
          <input
            type="password"
            required
            minLength={6}
            placeholder="Create a password (min 6 chars)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="field w-full h-11 px-3 text-[#14181F]"
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          {notice && <p className="text-sm text-[#0C8175]">{notice}</p>}
          <button type="submit" disabled={loading} className="btn-primary w-full h-11">
            {loading ? "Creating…" : "Continue"}
          </button>
        </form>

        <div className="flex items-center gap-3 my-5">
          <span className="h-px flex-1 bg-[#E6E8E4]" />
          <span className="text-xs text-[#98A0A9]">or</span>
          <span className="h-px flex-1 bg-[#E6E8E4]" />
        </div>
        <OAuthButton provider="google" mode="up" next="/schoolsignup/finish" />
        <p className="text-xs text-[#98A0A9] mt-3">You&apos;ll name your school on the next step.</p>

        <p className="text-sm text-[#5B6470] mt-6 text-center">
          Already have an account?{" "}
          <Link href="/login" className="text-[#0C8175] font-medium hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
