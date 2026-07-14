import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { consoleHostname, consoleRoute, bareHost, STAFF_LOGIN_PATH } from "@/utils/console-routing";
import { schoolHostname, schoolRoute } from "@/utils/school-routing";

// Refreshes the Supabase auth session on every request and guards routes.
// Called from src/proxy.ts (Next.js 16's renamed "middleware").
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // IMPORTANT: do not run code between createServerClient and getUser().
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;

  // A redirect that CARRIES the freshly-rotated Supabase auth cookies from
  // `response`. getUser() above may refresh an expired token and queue new
  // Set-Cookie headers on `response`; a bare NextResponse.redirect() would drop
  // them, so the browser would follow the redirect still holding the stale token.
  const redirectTo = (pathname: string, clearSearch = false) => {
    const url = request.nextUrl.clone();
    url.pathname = pathname;
    if (clearSearch) url.search = "";
    const redirect = NextResponse.redirect(url);
    response.cookies.getAll().forEach((c) => redirect.cookies.set(c));
    return redirect;
  };

  // ── Console subdomain routing (dormant unless NEXT_PUBLIC_CONSOLE_HOST is set) ──
  // The staff console lives on its own host with its own sign-in; the teacher app
  // lives on the main host. This keeps the two worlds physically separate.
  const host = request.headers.get("host");
  const cfgHost = consoleHostname();
  if (cfgHost) {
    const decision = consoleRoute({ consoleHostname: cfgHost, host: host ?? "", path, hasUser: !!user });
    if (decision.type === "redirect") return redirectTo(decision.path, true);
    // On the console host every route is handled by the rules above — never fall
    // through to the teacher-app guards (which key off /login and /dashboard).
    if (bareHost(host) === cfgHost) return response;
  } else if (path === STAFF_LOGIN_PATH) {
    // The staff login exists only as part of the subdomain feature. While that's
    // off, it must not be a reachable page on the teacher host.
    return redirectTo("/login");
  }

  // ── School-portal host (dormant unless NEXT_PUBLIC_SCHOOL_HOST is set) ──────
  // school.sketchcast.app/{slug}/… serves each school's landing + role logins by
  // REWRITING to the internal /school/{slug}/… routes — same deployment, tenant
  // resolved server-side from the slug, data still guarded by RLS on school_id.
  const sHost = schoolHostname();
  if (sHost && bareHost(host) === sHost) {
    const decision = schoolRoute({ schoolHostname: sHost, host: host ?? "", path });
    if (decision.type === "rewrite") {
      // Carry the freshly-rotated auth cookies, same as redirectTo above.
      const url = request.nextUrl.clone();
      url.pathname = decision.path;
      const rewrite = NextResponse.rewrite(url);
      response.cookies.getAll().forEach((c) => rewrite.cookies.set(c));
      return rewrite;
    }
    // pass → reserved paths (/auth, /api, /dashboard, …) fall through to the
    // standard guards below, which work unchanged on this host.
  }

  // ── Teacher-app guards (main host, and legacy mode when the subdomain is off) ──
  const isAuthRoute = path.startsWith("/auth"); // confirm/signout handlers
  const isAuthPage = path === "/login" || path === "/signup";
  const isProtected = path.startsWith("/dashboard");

  if (!user && isProtected) return redirectTo("/login");
  if (user && isAuthPage) return redirectTo("/dashboard");

  // isAuthRoute passes through untouched (token verification / signout).
  void isAuthRoute;
  return response;
}
