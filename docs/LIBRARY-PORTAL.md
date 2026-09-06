# Library portal — library.sketchcast.app

The topic-catalogue portal (canonical topics, knowledge articles, kit review,
YouTube publishing — see *SketchCast Feature Plan - Topic Catalogue and YouTube
Channel*) runs on its **own subdomain**, `library.sketchcast.app`, with its **own
sign-in** at `/library-login`. It is the third host served by the **same Next.js
deployment**, next to the teacher app (`app.sketchcast.app`) and the staff console
(`console.sketchcast.app`), and it copies the console pattern exactly.

One env var, `NEXT_PUBLIC_LIBRARY_HOST`, turns it on. Unset ⇒ the portal **does not
exist anywhere**: `/library` and `/library-login` redirect to `/dashboard` on every
host.

## Who gets in

**Membership, never the e-mail domain.** The founder's decision (2026-09-06): the
console controls who has access, and an outside subject reviewer can be added
without becoming staff.

| Who | How | Role |
|---|---|---|
| Platform staff (an unrevoked `platform_admins` row, or `FOUNDER_EMAILS`) | implicit | `admin` — everything, including publishing |
| Anyone else | a `library_members` row (migration 0110), granted from the console Users page → **Library access** | `editor` or `reviewer` |

Roles (`src/utils/library-routing.ts`, `libraryAllows`):

- `admin` — curate, edit and approve articles, generate, review, **publish to YouTube**.
- `editor` — everything but publish.
- `reviewer` — approve or reject only (articles, kits, translations, question items).

The database answers with one string, `library_role(uid)`; the guards in
`src/utils/library-access.ts` read it:

- `requireLibraryMember()` — the `/library` layout guard; non-members are bounced to
  `/library-login?error=not-member` on the portal host, to `/dashboard` elsewhere.
- `isLibraryMemberRequest(action?)` — every `/api/library/*` route guards itself;
  callers answer **404** on null so the portal is not probeable. Pass an action to
  also require the role to allow it.

## How routing works

```
library.sketchcast.app/               → /library-login (logged out) or /library (member)
library.sketchcast.app/library-login  → portal-branded sign-in; no domain rule
library.sketchcast.app/library/*      → the portal (server guard checks membership)
library.sketchcast.app/<anything>     → bounced into the portal world
app.sketchcast.app/library            → /dashboard (the portal does not exist here)
console.sketchcast.app/library        → /dashboard (nor here)
```

- Decision layer: `libraryRoute()` in `src/utils/library-routing.ts`, unit-tested in
  `src/utils/__tests__/library-routing.test.ts`; wired in `src/utils/supabase/proxy.ts`
  after the console block.
- Session isolation is automatic: Supabase SSR cookies are host-scoped, so a portal
  session is separate from any console or teacher session.
- Sign-out on the portal host lands on `/library-login` (`src/app/auth/signout/route.ts`).
- On the school host, `library` and `library-login` are reserved segments so they can
  never be read as tenant slugs.

## One-time setup (to activate)

1. **DNS** — add `library.sketchcast.app` pointing at Vercel (CNAME →
   `cname.vercel-dns.com`); on Cloudflare keep it DNS-only unless Vercel↔Cloudflare
   proxying is configured.
2. **Vercel** — Project → Settings → Domains → add `library.sketchcast.app` to the
   same project. Wait for the certificate.
3. **Vercel env (Production)** — `NEXT_PUBLIC_LIBRARY_HOST=library.sketchcast.app`.
4. **Redeploy** (env changes need a new deployment).
5. **Migration 0110** applied by the founder (and 0109 for the staff tier).
6. **Members** — Sara: console Users → her account → **Make staff** (admin of the
   portal implicitly, staff tier for the product). An outside reviewer: **Library
   access** → `reviewer` or `editor`.

Local dev: `NEXT_PUBLIC_LIBRARY_HOST=localhost` (the port is ignored) serves the
portal on `http://localhost:3000/library`.

To pause: unset `NEXT_PUBLIC_LIBRARY_HOST` and redeploy — the portal vanishes; no
data is touched.
