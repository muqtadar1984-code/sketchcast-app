# Staff console — dedicated subdomain + sign-in

The platform console (staff-only ops: users, schools, issues, content, audit,
auto-fix) runs on its **own subdomain** — `console.sketchcast.app` — with its **own
sign-in** at `/staff-login`, physically separated from the teacher app
(`app.sketchcast.app`). Console access is **hard-restricted to `@sketchcast.app`
accounts**.

Both hosts are served by the **same Next.js deployment**. A single env var,
`NEXT_PUBLIC_CONSOLE_HOST`, turns the whole thing on. Unset ⇒ legacy behavior
(console at `app.sketchcast.app/console`, no subdomain, no domain gate) — so the
code ships dormant and flipping the env var is fully reversible.

## How it works

```
console.sketchcast.app/            → /staff-login (logged out) or /console (staff)
console.sketchcast.app/staff-login → dark, staff-branded sign-in; @sketchcast.app only
console.sketchcast.app/console/*   → the console (server guard re-checks staff)
console.sketchcast.app/<anything>  → bounced into the console world
app.sketchcast.app/console         → /dashboard (console does not exist on the main host)
```

- **Host routing** lives in the proxy (`src/utils/supabase/proxy.ts`) via the pure,
  unit-tested decision function `consoleRoute()` in `src/utils/console-routing.ts`.
- **Session isolation** is automatic: Supabase SSR cookies are host-scoped (no cookie
  `domain`), so a console session on `console.sketchcast.app` is separate from any
  teacher session on `app.sketchcast.app`. Signing into one does not sign you into
  the other.
- **The domain gate** is in `src/utils/platform-admin.ts` — `platformAdminUser()`
  returns null for any non-`@sketchcast.app` email once the subdomain is on, so a
  gmail can never be staff even if it's in `FOUNDER_EMAILS`. Staff = `@sketchcast.app`
  **and** (founder allowlist **or** an unrevoked `platform_admins` row).
- **Every `/api/console/*` and `/api/autofix/*` route** still guards itself with
  `isPlatformAdminRequest()` (which enforces the same domain gate) — the host routing
  is defense in depth, not the only lock.

## One-time setup (to activate)

1. **DNS** — add a record for `console.sketchcast.app` pointing at Vercel
   (CNAME → `cname.vercel-dns.com`, or per Vercel's instructions). On Cloudflare,
   set it **DNS-only** (grey cloud) unless you've configured Vercel↔Cloudflare proxying.
2. **Vercel** — Project → Settings → Domains → add `console.sketchcast.app` to the
   **same** project as `app.sketchcast.app`. Wait for the certificate to issue.
3. **Vercel env** (Production): set
   ```
   NEXT_PUBLIC_CONSOLE_HOST=console.sketchcast.app
   ```
   Setting this alone enables the console (it implies `FEATURE_PLATFORM_CONSOLE`),
   but for clarity keep `FEATURE_PLATFORM_CONSOLE=true` set as well — it already is
   in prod. Recommended cleanup while you're there: set `FOUNDER_EMAILS` to only your
   `@sketchcast.app` staff (or unset it — it defaults to `muqtadar.quraishi@sketchcast.app`).
   The gmail is now blocked from the console by the domain gate regardless.
4. **Redeploy** (env changes need a new deployment).
5. **Your login** — `muqtadar.quraishi@sketchcast.app` is already a `platform_admins`
   row (independent of `FOUNDER_EMAILS`). Set its password via the one-time recovery
   link, then sign in at `https://console.sketchcast.app/staff-login`.

To pause/revert: unset `NEXT_PUBLIC_CONSOLE_HOST` and redeploy — the console returns
to `app.sketchcast.app/console` with the legacy allowlist behavior.

## Adding another staff member

1. They need a real `@sketchcast.app` account (create it, or they sign up).
2. Grant console access with a `platform_admins` row:
   ```sql
   insert into platform_admins (user_id, granted_by, note)
   select p.id, null, 'ops'
   from profiles p
   join auth.users u on u.id = p.id
   where lower(u.email) = 'name@sketchcast.app'
   on conflict (user_id) do update set revoked_at = null;
   ```
3. Revoke: `update platform_admins set revoked_at = now() where user_id = '…';`

## Files

| Piece | Path |
|---|---|
| Host-routing decision (pure, tested) | `src/utils/console-routing.ts` (+ `__tests__/console-routing.test.ts`) |
| Proxy wiring | `src/utils/supabase/proxy.ts` |
| Domain gate + host-aware redirect | `src/utils/platform-admin.ts` |
| Staff sign-in page | `src/app/staff-login/page.tsx` |
| Host-aware sign-out | `src/app/auth/signout/route.ts` |
| Flag helper | `src/utils/flags.ts` → `consoleSubdomainEnabled()` |
