"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { isStaffDomain, STAFF_DOMAIN } from "@/utils/console-routing";
import { LogoMark } from "../dashboard/icons";

// Staff sign-in for the console subdomain (console.sketchcast.app). Deliberately
// separate from the teacher /login: staff-branded, and it refuses any non
// @sketchcast.app account right here (the server guard re-checks — this is UX).
// It lives at a top-level path (not /console/*) so it is NOT wrapped by the
// console layout's requirePlatformAdmin guard, which would bounce a logged-out
// visitor straight back and loop.

function StaffLoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const notStaff = params.get("error") === "not-staff";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // When we arrived via ?error=not-staff we show the message immediately (no
  // session probe); otherwise we probe once and only reveal the form if logged out.
  const [checking, setChecking] = useState(!notStaff);

  // Already signed in as staff? Go straight to the console. But if we arrived
  // here because the account ISN'T staff (?error=not-staff), don't auto-forward —
  // that would loop against the console guard. Show the message instead.
  useEffect(() => {
    if (notStaff) return;
    let active = true;
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!active) return;
      if (user) router.replace("/console");
      else setChecking(false);
    });
    return () => {
      active = false;
    };
  }, [notStaff, router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const addr = email.trim().toLowerCase();
    if (!isStaffDomain(addr)) {
      setError(`Console access is for SketchCast staff only (${STAFF_DOMAIN} addresses).`);
      return;
    }
    setLoading(true);
    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({ email: addr, password });
    if (signInError) {
      setLoading(false);
      setError(signInError.message);
      return;
    }
    // Defense in depth: never leave a non-staff session alive on this host.
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!isStaffDomain(user?.email)) {
      await supabase.auth.signOut();
      setLoading(false);
      setError(`Console access is for SketchCast staff only (${STAFF_DOMAIN} addresses).`);
      return;
    }
    router.push("/console");
    router.refresh();
  }

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace("/staff-login");
    router.refresh();
  }

  if (checking) return null;

  if (notStaff) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-[#F5C6C6]">
          You&apos;re signed in, but this account isn&apos;t a SketchCast staff account. The console
          is restricted to {STAFF_DOMAIN} staff.
        </p>
        <button onClick={signOut} className="btn-primary w-full h-11">
          Sign out &amp; use a staff account
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <input
        required
        type="email"
        autoComplete="username"
        placeholder="you@sketchcast.app"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="field w-full h-11 px-3 text-white bg-white/5 placeholder:text-white/40 border-white/15"
      />
      <input
        type="password"
        autoComplete="current-password"
        required
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="field w-full h-11 px-3 text-white bg-white/5 placeholder:text-white/40 border-white/15"
      />
      {error && <p className="text-sm text-[#F5C6C6]">{error}</p>}
      <button type="submit" disabled={loading} className="btn-primary w-full h-11">
        {loading ? "Signing in…" : "Enter the console"}
      </button>
    </form>
  );
}

export default function StaffLoginPage() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-[#0E1420] px-4">
      <div className="w-full max-w-sm rounded-2xl p-8 bg-[#161E2E] border border-white/10 shadow-xl">
        <div className="flex items-center gap-2.5 mb-1">
          <LogoMark size={34} />
          <h1 className="text-2xl text-white">
            SketchCast <span className="text-[#3BD1BE]">Staff</span>
          </h1>
        </div>
        <p className="text-sm text-white/50 mt-1 mb-6">
          Platform console · {STAFF_DOMAIN} accounts only
        </p>
        <Suspense fallback={null}>
          <StaffLoginForm />
        </Suspense>
      </div>
    </main>
  );
}
