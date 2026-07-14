"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/utils/supabase/client";
import { studentEmail } from "@/utils/student";
import type { PortalRole } from "@/utils/school-routing";

// Tenant + role-scoped sign-in. Same auth flow as /login (students type their
// ID, which maps to the synthetic address), with one extra server round-trip:
// /api/school-portal/verify confirms the signed-in account actually belongs to
// THIS school and fits THIS door — a mismatch signs the session straight back
// out, so a teacher from another school can never "land" in the wrong portal.
export default function PortalLogin({ slug, role }: { slug: string; role: PortalRole }) {
  const router = useRouter();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const supabase = createClient();
    const loginEmail = identifier.includes("@") ? identifier.trim() : studentEmail(identifier);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email: loginEmail, password });
    if (signInError) {
      setLoading(false);
      setError(signInError.message);
      return;
    }

    const res = await fetch("/api/school-portal/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, role }),
    });
    const body = (await res.json().catch(() => ({}))) as { redirect?: string; error?: string };
    if (!res.ok) {
      await supabase.auth.signOut();
      setLoading(false);
      setError(body.error ?? "This account can't use this school's portal.");
      return;
    }
    router.push(body.redirect ?? "/dashboard");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <input
        required
        placeholder={role === "student" ? "Student ID" : "Email"}
        value={identifier}
        onChange={(e) => setIdentifier(e.target.value)}
        className="field w-full h-11 px-3 text-[#14181F]"
        autoCapitalize="none"
        autoCorrect="off"
      />
      <input
        type="password"
        required
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="field w-full h-11 px-3 text-[#14181F]"
      />
      {role !== "student" && (
        <div className="flex justify-end">
          <Link href="/login/forgot" className="text-xs text-[#0C8175] font-medium hover:underline">
            Forgot password?
          </Link>
        </div>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button type="submit" disabled={loading} className="btn-primary w-full h-11">
        {loading ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
