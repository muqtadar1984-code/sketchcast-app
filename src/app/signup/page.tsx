"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/utils/supabase/client";

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
    <main className="min-h-screen flex items-center justify-center bg-[#FBF6EC] px-4">
      <div className="w-full max-w-sm bg-white rounded-2xl border border-[#EBE3D3] p-8">
        <h1 className="text-2xl font-medium text-[#2C2A26]" style={{ fontFamily: "Georgia, serif" }}>
          Create your account
        </h1>
        <p className="text-sm text-[#6F6A5F] mt-1 mb-6">Free for teachers &amp; students</p>

        <form onSubmit={onSubmit} className="space-y-4">
          <input
            required placeholder="Full name" value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className="w-full h-11 px-3 rounded-lg border border-[#EBE3D3] bg-white text-[#2C2A26] outline-none focus:border-[#2E6B4E]"
          />
          <input
            type="email" required placeholder="Email" value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full h-11 px-3 rounded-lg border border-[#EBE3D3] bg-white text-[#2C2A26] outline-none focus:border-[#2E6B4E]"
          />
          <input
            type="password" required minLength={6} placeholder="Password (min 6 chars)" value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full h-11 px-3 rounded-lg border border-[#EBE3D3] bg-white text-[#2C2A26] outline-none focus:border-[#2E6B4E]"
          />
          <div className="flex gap-2">
            {(["teacher", "student"] as const).map((r) => (
              <button
                key={r} type="button" onClick={() => setRole(r)}
                className={`flex-1 h-11 rounded-lg border text-sm font-medium capitalize ${
                  role === r
                    ? "border-[#2E6B4E] bg-[#EAF1EC] text-[#2E6B4E]"
                    : "border-[#EBE3D3] bg-white text-[#6F6A5F]"
                }`}
              >
                {r}
              </button>
            ))}
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          {notice && <p className="text-sm text-[#2E6B4E]">{notice}</p>}
          <button
            type="submit" disabled={loading}
            className="w-full h-11 rounded-lg bg-[#2E6B4E] text-white font-medium hover:bg-[#255A41] disabled:opacity-60"
          >
            {loading ? "Creating…" : "Create account"}
          </button>
        </form>

        <p className="text-sm text-[#6F6A5F] mt-6 text-center">
          Already have an account?{" "}
          <Link href="/login" className="text-[#2E6B4E] font-medium hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
