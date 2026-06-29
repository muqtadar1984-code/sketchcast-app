"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/utils/supabase/client";
import { LogoMark } from "../dashboard/icons";
import { studentEmail } from "@/utils/student";

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
    <main className="min-h-screen flex items-center justify-center bg-[#FBF6EC] px-4">
      <div className="w-full max-w-sm card rounded-2xl p-8">
        <div className="flex items-center gap-2.5 mb-1">
          <LogoMark size={34} />
          <h1 className="text-2xl">
            SketchCast <span className="text-[#2E6B4E]">AI</span>
          </h1>
        </div>
        <p className="text-sm text-[#6F6A5F] mt-1 mb-6">Sign in to your account</p>

        <form onSubmit={onSubmit} className="space-y-4">
          <input
            required placeholder="Email or student ID" value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="field w-full h-11 px-3 text-[#2C2A26]"
          />
          <input
            type="password" required placeholder="Password" value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="field w-full h-11 px-3 text-[#2C2A26]"
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button type="submit" disabled={loading} className="btn-primary w-full h-11">
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="text-sm text-[#6F6A5F] mt-6 text-center">
          New here?{" "}
          <Link href="/signup" className="text-[#2E6B4E] font-medium hover:underline">
            Create an account
          </Link>
        </p>
      </div>
    </main>
  );
}
