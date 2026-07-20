// Session-only login cookies.
//
// By default @supabase/ssr writes the auth cookies with a 400-day maxAge, so a
// login is "remembered" across browser restarts and shared by every tab. The
// founder wants a login NOT to persist — closing the browser should require
// signing in again (privacy on shared/laptop machines). @supabase/ssr hard-codes
// that 400-day maxAge AFTER spreading any cookieOptions (its constants.js), so
// passing cookieOptions can't change it; the only reliable lever is to drop the
// persistence in the setAll callbacks WE control, at every write site (browser
// client, server client, and the proxy/middleware).
//
// Stripping maxAge (when it's a positive, long-lived value) turns the cookie
// into a SESSION cookie: it lives while the browser is open (so the app works
// normally, tokens still refresh) and is cleared when the browser fully closes.
// A DELETION (Supabase clears a cookie with maxAge = 0) is left intact, so
// sign-out still removes the cookie immediately.
//
// Note: on mobile, browsers often keep the process alive across "closes", so the
// clear-on-close effect is weaker there — this is inherent to session cookies.
export function sessionScoped<T extends object>(options: T | undefined): T {
  const o = { ...(options ?? ({} as T)) } as T & { maxAge?: number };
  if (typeof o.maxAge === "number" && o.maxAge > 0) {
    delete o.maxAge;
  }
  return o;
}
