"use client";

import { Suspense, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/utils/supabase/client";
import { LogoMark } from "../dashboard/icons";
import { studentEmail } from "@/utils/student";
import OAuthButton from "@/components/oauth-button";
import AuthError from "@/components/auth-error";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
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
    <main className="min-h-screen flex items-center justify-center bg-[#FCFCFA] px-4">
      <div className="w-full max-w-sm card rounded-2xl p-8">
        <div className="flex items-center gap-2.5 mb-1">
          <LogoMark size={34} />
          <h1 className="text-2xl">
            SketchCast <span className="text-[#0C8175]">AI</span>
          </h1>
        </div>
        <p className="text-sm text-[#5B6470] mt-1 mb-6">Sign in to your account</p>

        <Suspense fallback={null}>
          <AuthError />
        </Suspense>

        <form onSubmit={onSubmit} className="space-y-4">
          <input
            required placeholder="Email or student ID" value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="field w-full h-11 px-3 text-[#14181F]"
          />
          <input
            type="password" required placeholder="Password" value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="field w-full h-11 px-3 text-[#14181F]"
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button type="submit" disabled={loading} className="btn-primary w-full h-11">
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <div className="flex items-center gap-3 my-5">
          <span className="h-px flex-1 bg-[#E6E8E4]" />
          <span className="text-xs text-[#98A0A9]">or</span>
          <span className="h-px flex-1 bg-[#E6E8E4]" />
        </div>
        <OAuthButton provider="google" mode="in" />

        <p className="text-sm text-[#5B6470] mt-6 text-center">
          New here?{" "}
          <Link href="/signup" className="text-[#0C8175] font-medium hover:underline">
            Create an account
          </Link>
        </p>
      </div>
    </main>
  );
}
