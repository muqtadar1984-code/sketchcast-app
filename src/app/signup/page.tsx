"use client";

import { Suspense, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/utils/supabase/client";
import { LogoMark } from "../dashboard/icons";
import OAuthButton from "@/components/oauth-button";
import AuthError from "@/components/auth-error";

export default function SignupPage() {
  const router = useRouter();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"teacher" | "student">("teacher");
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
        data: { full_name: fullName, role },
        emailRedirectTo: `${location.origin}/auth/confirm`,
      },
    });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    // If email confirmation is OFF, a session is returned and we go straight in.
    if (data.session) {
      router.push("/dashboard");
      router.refresh();
      return;
    }
    setNotice("Check your email to confirm your account, then sign in.");
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-[#FCFCFA] px-4">
      <div className="w-full max-w-sm card rounded-2xl p-8">
        <div className="flex items-center gap-2.5 mb-1">
          <LogoMark size={34} />
          <h1 className="text-2xl">Create your account</h1>
        </div>
        <p className="text-sm text-[#5B6470] mt-1 mb-6">Free for teachers &amp; students</p>

        <Suspense fallback={null}>
          <AuthError />
        </Suspense>

        <form onSubmit={onSubmit} className="space-y-4">
          <input
            required placeholder="Full name" value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className="field w-full h-11 px-3 text-[#14181F]"
          />
          <input
            type="email" required placeholder="Email" value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="field w-full h-11 px-3 text-[#14181F]"
          />
          <input
            type="password" required minLength={6} placeholder="Password (min 6 chars)" value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="field w-full h-11 px-3 text-[#14181F]"
          />
          <div className="flex gap-2">
            {(["teacher", "student"] as const).map((r) => (
              <button
                key={r} type="button" onClick={() => setRole(r)}
                className={`flex-1 h-11 rounded-lg border text-sm font-medium capitalize ${
                  role === r
                    ? "border-[#1FB8A6] bg-[#E2F4F1] text-[#0C8175]"
                    : "border-[#E6E8E4] bg-white text-[#5B6470]"
                }`}
              >
                {r}
              </button>
            ))}
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          {notice && <p className="text-sm text-[#0C8175]">{notice}</p>}
          <button type="submit" disabled={loading} className="btn-primary w-full h-11">
            {loading ? "Creating…" : "Create account"}
          </button>
        </form>

        {role === "teacher" && (
          <>
            <div className="flex items-center gap-3 my-5">
              <span className="h-px flex-1 bg-[#E6E8E4]" />
              <span className="text-xs text-[#98A0A9]">or</span>
              <span className="h-px flex-1 bg-[#E6E8E4]" />
            </div>
            <OAuthButton provider="google" mode="up" />
          </>
        )}

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
