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

## Screens (Phase 1 — taxonomy)

The tabs in `src/app/library/library-header.tsx`. Every screen is a Server Component
that reads with the service role (`createAdminClient`) and decides which controls to
render with `libraryAllows(member.role, action)`; every control POSTs an
`/api/library/*` route that re-checks the role itself and writes `platform_audit_log`
(`action = library_<verb>`). Pure logic (`canonicalKey`, the status machine,
`resolveCandidate`, coverage, filters) lives in `src/utils/catalogue/` and is tested in
`src/utils/__tests__/catalogue-*.test.ts`. When migration **0112** is not applied the
screens show an explanatory banner and the routes answer **409** with the hint.

| Screen | What it shows | Actions | Who |
|---|---|---|---|
| `/library` | Overview: doors into the screens, greyed for roles that cannot act there | — | any member |
| `/library/topics` | Canonical topics; filters subject · curriculum · grade · status · free text (GET querystring, paginated in Postgres; a `?page=` past the end lands on the last page; `%`/`_` in the search box are searched for, not wildcards); title, subject, status chip, bank-maturity chip, #mappings, updated | **New topic** (title → canonical key + manual alias) → `POST /api/library/topics`; a key somebody already holds — as their `canonical_key` **or as one of their aliases** — is refused with **409** `{existingId, existingTitle, existingStatus, via}` BEFORE anything is written (a topic merged away is followed to the live topic that now holds its name; a retired holder is named as such) | list: any member; New topic: editor, admin |
| `/library/topics/[id]` | Header (title, subject, summary, teacher avatar), status + maturity chips, pipeline position, aliases, curriculum mappings with the **depth node** selector (a chip for reviewers), prerequisites (and "required by"), open candidates suggesting it, audit trail | `POST /api/library/topics/[id]` with `{action}`: **update**, **alias_add / alias_remove**, **mapping_add** (curriculum → node search → full/partial) **/ mapping_remove**, **prereq_add / prereq_remove** (topic search), **set_depth** (one of the mapped nodes), **Approve** (candidate → approved), **Retire** (any → retired), **Reopen** (retired → candidate, in_review → generating, video_approved → in_review), **Merge into…** (aliases, mappings, open candidates and prerequisite references move to the target; this title becomes a manual alias of the target; this topic retires). The merge is not one transaction: its steps are idempotent, a failure answers `{error, step}` (500, or 409 on a unique violation) and is audited as `library_topic_merge_failed`, and clicking Merge again with the same target completes it | read: any member; Approve: reviewer, editor, admin; everything else: editor, admin |
| `/library/curricula` | Every curriculum with a coverage bar; `?curriculum=<id>` opens its nodes grouped grade → strand → sub-strand, each with the covering topics (coverage + status chips) and a coverage bar per group; uncovered nodes are flagged | **Create topic from node** (candidate topic + `curriculum` alias + full mapping) → `POST /api/library/curricula`; the same 409-with-owner as New topic ("map the node to it instead"); audited on the node (`topic_create_from_node`) and on the topic (`topic_create` with `from_node`) | list: any member; Create: editor, admin |
| `/library/candidates` | The unmapped queue (`topic_candidates.status = open`) grouped by book or curriculum, each with its normalized key, node (if any) and the **suggested** topic from the harvester's alias match | **Merge into suggested**, **Merge into…** (topic search), **Create topic**, **Dismiss** → `POST /api/library/candidates` `{candidateId, mode, topicId?}`; every name the plan would attach is checked for an owner BEFORE any write, and a 409 names the topic that holds it (`existingId`) and offers a one-click merge; a conflict that still appears (a lost race) takes a just-created topic back out and answers the same 409 — never a 200 | read: any member (read-only note for reviewers); resolve: editor, admin |
| `/library/harvest` | Books on the platform (not taken down), owner e-mail (**editors and admins only** — reviewers see `—`, the e-mails are neither fetched nor searched for them), grade · subject, pages, uploaded, candidates already harvested (open/total), latest `topic_harvest` job (status, progress, error) | **Harvest** → `POST /api/library/harvest {bookId}`: inserts ONE `public.jobs` row `{type: 'topic_harvest', book_id, generation_id: null, status: 'queued'}` — an observer job, never a `generations` row; refused (409) while a harvest is queued or processing for that book (the partial unique index `jobs_one_live_harvest` enforces it under a race; its 23505 is the same 409), and for books that are not `ready` | read: any member; Harvest: editor, admin |

Pickers used by the panels (any member): `GET /api/library/topics?q=&limit=&all=1`
(topic search; retired hidden unless `all=1`) and
`GET /api/library/curricula/[id]/nodes?q=&grade=&limit=` (node search within one
curriculum).

Later phases add to `/library/topics/[id]` the article editor, kit review, translate and
publish panels, and the `/library/topics/[id]/questions` and `/library/blueprints`
screens (plan §7.2).
