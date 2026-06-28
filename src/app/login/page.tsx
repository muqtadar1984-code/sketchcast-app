"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/utils/supabase/client";

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
    const { error } = await supabase.auth.signInWithPassword({ email, password });
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
      <div className="w-full max-w-sm bg-white rounded-2xl border border-[#EBE3D3] p-8">
        <h1 className="text-2xl font-medium text-[#2C2A26]" style={{ fontFamily: "Georgia, serif" }}>
          SketchCast <span className="text-[#2E6B4E]">AI</span>
        </h1>
        <p className="text-sm text-[#6F6A5F] mt-1 mb-6">Sign in to your account</p>

        <form onSubmit={onSubmit} className="space-y-4">
          <input
            type="email" required placeholder="Email" value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full h-11 px-3 rounded-lg border border-[#EBE3D3] bg-white text-[#2C2A26] outline-none focus:border-[#2E6B4E]"
          />
          <input
            type="password" required placeholder="Password" value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full h-11 px-3 rounded-lg border border-[#EBE3D3] bg-white text-[#2C2A26] outline-none focus:border-[#2E6B4E]"
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            type="submit" disabled={loading}
            className="w-full h-11 rounded-lg bg-[#2E6B4E] text-white font-medium hover:bg-[#255A41] disabled:opacity-60"
          >
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
