"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/utils/supabase/client";
import { BOOKS_HOME } from "@/utils/books-routing";
import { LogoMark } from "../dashboard/icons";

// Sign-in for the book app (books.sketchcast.app). Separate from the teacher
// /login, the staff /staff-login and the Library login: book-app branded. Only
// @sketchcast.app accounts can ever enter (books-access.ts decides after
// sign-in: the founder by default, everyone else by a grant). It lives at a
// top-level path (not /books/*) so the books layout guard does not wrap it,
// which would bounce a logged-out visitor straight back and loop.

function BooksLoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const notMember = params.get("error") === "not-member";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // When we arrived via ?error=not-member we show the message immediately (no
  // session probe); otherwise we probe once and only reveal the form if logged out.
  const [checking, setChecking] = useState(!notMember);

  // Already signed in? Go to the portal (the layout guard decides membership).
  // But if we arrived here because the account ISN'T a member, don't
  // auto-forward — that would loop against the guard. Show the message instead.
  useEffect(() => {
    if (notMember) return;
    let active = true;
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!active) return;
      if (user) router.replace(BOOKS_HOME);
      else setChecking(false);
    });
    return () => {
      active = false;
    };
  }, [notMember, router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });
    setLoading(false);
    if (signInError) {
      setError(signInError.message);
      return;
    }
    // Membership is checked server-side by the portal layout; a non-member
    // comes straight back here with ?error=not-member.
    router.push(BOOKS_HOME);
    router.refresh();
  }

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace("/books-login");
    router.refresh();
  }

  if (checking) return null;

  if (notMember) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-[#F5C6C6]">
          You&apos;re signed in, but this account has no access to the book app. Only @sketchcast.app
          staff accounts can be given access, and the founder grants it.
        </p>
        <button onClick={signOut} className="btn-primary w-full h-11">
          Sign out &amp; use another account
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
        {loading ? "Signing in…" : "Enter the book app"}
      </button>
    </form>
  );
}

export default function BooksLoginPage() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-[#1A1610] px-4">
      <div className="w-full max-w-sm rounded-2xl p-8 bg-[#241F16] border border-white/10 shadow-xl">
        <div className="flex items-center gap-2.5 mb-1">
          <LogoMark size={34} />
          <h1 className="text-2xl text-white">
            SketchCast <span className="text-[#E8C27A]">Books</span>
          </h1>
        </div>
        <p className="text-sm text-white/50 mt-1 mb-6">Study-guide books · SketchCast staff only</p>
        <Suspense fallback={null}>
          <BooksLoginForm />
        </Suspense>
      </div>
    </main>
  );
}
