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

## Screens (Phase 1 — taxonomy; Phase 2a — the catalogue layer; Phase 2b — the knowledge article)

The tabs in `src/app/library/library-header.tsx`. Every screen is a Server Component
that reads with the service role (`createAdminClient`) and decides which controls to
render with `libraryAllows(member.role, action)`; every control POSTs an
`/api/library/*` route that re-checks the role itself and writes `platform_audit_log`
(`action = library_<verb>`). Pure logic (`canonicalKey`, the status machine, node
kinds and the curriculum tree, `resolveCandidate`, coverage, filters) lives in
`src/utils/catalogue/` and is tested in `src/utils/__tests__/catalogue-*.test.ts`. When
migration **0112** (the tables) is not applied the screens show an explanatory banner
and the routes answer **409** with the hint; when **0113** (the catalogue layer:
`curriculum_nodes.kind`, `topic_candidates.node_ids` / `rationale`, `jobs.params`) is
not applied, a *column*-missing error is told apart from a *table*-missing one
(`missingMigration`) and the banner / 409 names 0113 instead. A missing
`article_figures.render_error` — the one column **0114** adds — names 0114
(`ARTICLE_JOBS_MIGRATION`); the topic page then shows the figures *without* their
render errors instead of failing.

**The catalogue layer (0113, plan Phase 2a).** A curriculum node has a **kind** —
`strand | sub_strand | objective | unit | chapter | topic` — read from the column,
else inferred from the code's shape the way the 0113 backfill did (`nodeKind`), never
from depth. Groups (strand, sub-strand, unit) hold leaves (objective, topic, chapter);
a topic maps to leaves, and a group counts as **covered** when every one of its
objectives is mapped — or when a mapping points at the group itself, which covers each
objective under it (`coveredSet` / `coverageOf` with the tree). A **grouped
candidate** proposes one topic for a group of objectives: `node_id` is the anchor
(the sub-strand / unit), `node_ids` the objectives to map, `rationale` the model's
reason. The worker job **`topic_derive`** reads `{curriculum_id}` from `jobs.params`
and files them.

**The knowledge article (0112 §3 + 0114, plan Phase 2b).** One topic has
**versions** of its article per language (`topic_articles`, `version` 1..n; Phase 2b
authors `en`, translations arrive with the translate phase). A version is `draft` →
`in_review` → `approved` (or `rejected`); approving one **supersedes** the previously
approved version of that language, so at most one is approved at a time (the 0112
partial unique index). The body is structured — title, objectives, ordered sections
(markdown, the figure keys they place, the objectives they cover), glossary,
misconceptions, worked examples, claims (each tied to its section), a depth rationale
— and its **figures** are specs (`article_figures`: `figure_key`, caption, `spec
{subject, parts, style?, notes?}`) that the worker renders through the visual library
and links by `visual_asset_id`; `render_error` (0114) says why a render failed. Two
**observer jobs** carry the work in `jobs.params`: **`topic_article`**
`{topic_id, language, hints?, source_article_id?}` writes the next version as a draft
(from the named source version — "New version from this"), **`figure_render`**
`{article_id}` renders that version's figures; one live job per target
(`jobs_one_live_article`, `jobs_one_live_figure_render`). **Approval is a named
reviewer's act**: the only writer of `approved` is `approve_topic_article(p_article,
p_reviewer, p_notes)` (0112), which supersedes, approves, moves the topic to
`article_approved` and audits in one transaction — no route sets the status itself
(asserted by `catalogue-routes.test.ts`). The pure rules — `validateArticle` (the Save
gate: bounded lists, unique ids, every cross-reference resolving inside the article,
a normalised body out), `wordCount`, the `can*` status predicates, `sectionDiff` (pairs
sections by id, then the leftovers by order, so a regenerated draft still compares),
`latestArticles` — live in `src/utils/catalogue/article.ts`, tested in
`catalogue-article.test.ts`.

| Screen | What it shows | Actions | Who |
|---|---|---|---|
| `/library` | Overview: the **review queues** — *Articles awaiting review* (`topic_articles.status = in_review`) and *Article drafts* (`draft`), two head counts (never a scan) linking to `/library/topics?article=in_review` / `?article=draft`; then the doors into the screens, greyed for roles that cannot act there. A missing 0112 leaves the queues unshown with a note | — | any member |
| `/library/topics` | Canonical topics; filters subject · curriculum · grade · **sub-strand / unit** (`?node=`: topics mapped to that group **or to any objective under it**, since mappings point at either; the select lists the curriculum's `sub_strand` / `unit` nodes, narrowed to the grade; a group with more than 150 nodes under it — the id list travels in the URL — is not filtered by, and the page asks for a sub-strand instead) · status · **article state** (`?article=draft\|in_review\|approved\|none` — the overview's queue links land here: topics with a version in that state, *any* version, so a topic with a draft and an approved version matches both; `none` = no version at all, PostgREST's null filter on the embed) · free text (GET querystring, paginated in Postgres; a `?page=` past the end lands on the last page; `%`/`_` in the search box are searched for, not wildcards); title, subject, status chip, **article chip** (the status of the topic's latest `en` version — one grouped query for the page's ids, reduced by `latestArticles` — or *none*), bank-maturity chip, #mappings, updated | **New topic** (title → canonical key + manual alias) → `POST /api/library/topics`; a key somebody already holds — as their `canonical_key` **or as one of their aliases** — is refused with **409** `{existingId, existingTitle, existingStatus, via}` BEFORE anything is written (a topic merged away is followed to the live topic that now holds its name; a retired holder is named as such) | list: any member; New topic: editor, admin |
| `/library/topics/[id]` | Header (title, subject, summary, teacher avatar), status + maturity chips, pipeline position, aliases, curriculum mappings with the **depth node** selector (a chip for reviewers), prerequisites (and "required by"), open candidates suggesting it, audit trail | `POST /api/library/topics/[id]` with `{action}`: **update**, **alias_add / alias_remove**, **mapping_add** (curriculum → node search → full/partial; the picker shows each hit's kind and child count, and when the picked node has children the panel offers **"Map all N objectives"** — `{mapChildren: true}` maps every direct child instead of the group, answering `{ok, mapped}` and auditing the count) **/ mapping_remove**, **prereq_add / prereq_remove** (topic search), **set_depth** (one of the mapped nodes), **Approve** (candidate → approved), **Retire** (any → retired), **Reopen** (retired → candidate, in_review → generating, video_approved → in_review), **Merge into…** (aliases, mappings, open candidates and prerequisite references move to the target; this title becomes a manual alias of the target; this topic retires). The merge is not one transaction: its steps are idempotent, a failure answers `{error, step}` (500, or 409 on a unique violation) and is audited as `library_topic_merge_failed`, and clicking Merge again with the same target completes it | read: any member; Approve: reviewer, editor, admin; everything else: editor, admin |
| `/library/topics/[id]` — **Article panel** | The version list (version, status chip, author `model`/`staff`, words, reviewer + date, updated; "from vN" for a version written from another), the **latest `topic_article` job** (status, progress, error), one selected version: read-only rendering (objectives, sections with their placed figures — signed previews of the `visual-assets` bucket, one hour, one `createSignedUrls` call for the page — claims per section, glossary, misconceptions, worked examples, depth rationale; a figure named but missing, or a claim pointing at a vanished section, is flagged), its **latest `figure_render` job**, review notes; the **editor** for a `draft` / `in_review` version (title, objectives, sections with markdown + figure keys + covered objectives, figures with key / caption / `spec.subject` / parts as a tag list / style / notes, glossary, misconceptions, worked examples, claims with their section, depth rationale; the renderer's fields — status chip, preview, `render_error` — shown, never edited; `validateArticle` runs in the browser first so every problem shows before the round trip, the word count updates live); a **Compare** view of any two versions (`sectionDiff`: same / changed with the changed fields highlighted / added / removed, plus a title change) | `POST /api/library/topics/[id]/article` with `{action}` — **Write article / Write a new version** `{action: "generate", hints?, sourceArticleId?}` → ONE `public.jobs` row `{type: 'topic_article', params: {topic_id, language: 'en', hints, source_article_id}, book_id: null, generation_id: null, status: 'queued'}`; refused (400) for a `candidate` or `retired` topic and (409, `{jobId}`) while an article job is queued or processing for the topic (check-then-insert; `jobs_one_live_article` under a race, its 23505 is the same 409). **Save** `{action: "save", articleId, article}` → `validateArticle` (400 with **every** error in `errors`), the validated body written with `word_count` recomputed, figures **upserted by `figure_key`** (editable columns only, so a rendered figure keeps its asset), a figure the editor dropped **deleted only while still `draft`** (a rendered / approved one is kept and reported in `figuresKept`); 409 for an approved / superseded / rejected version — those are read-only, with **New version from this** instead. **Submit for review** `{action: "submit", articleId}` (draft → in_review, 409 otherwise). **Render figures** `{action: "render_figures", articleId}` → ONE `jobs` row `{type: 'figure_render', params: {article_id}, book_id: null, generation_id: null, status: 'queued'}`; 400 with no figures, 409 while a render is live for the version (`jobs_one_live_figure_render`). **Approve** `{action: "approve", articleId, notes?}` → `approve_topic_article(p_article, p_reviewer = the member, p_notes)` and nothing else — the RPC's refusals (not reviewable, vanished) are the 409; audited by the RPC. **Reject** `{action: "reject", articleId, notes}` — notes **required** — draft \| in_review → `rejected` with the reviewer and time. An article id from another topic is a 404. Every action but approve is audited on the **topic** (`library_article_generate` / `_save` / `_submit` / `_reject`, `library_figures_render`) so the topic's trail shows the article's history | read: any member; generate, save, submit, render: **editor, admin** (`edit_article`); approve, reject: **reviewer, editor, admin** (`approve`) |
| `/library/curricula` | Every curriculum with a coverage bar over its **objectives** (leaf nodes, covered through the tree), its **latest `topic_derive` job** (status, progress / `jobs.stage`, error) and its **open derived candidates** (a link into Candidates); `?curriculum=<id>` opens its nodes as a tree grouped by **kind** — grade → strand (collapsible) → sub-strand / unit → objectives — each node with a kind chip (dashed when inferred from the code), each group with **"n/m objectives mapped"**, each node with the covering topics (coverage + status chips) or "covered by its group"; uncovered nodes are flagged | **Derive topics** → `POST /api/library/derive {curriculumId}`: inserts ONE `public.jobs` row `{type: 'topic_derive', params: {curriculum_id}, book_id: null, generation_id: null, status: 'queued'}` — an observer job, never a `generations` row; refused (409) while a derive is queued or processing for that curriculum (check-then-insert, and the partial unique index `jobs_one_live_derive` on `params->>'curriculum_id'` enforces it under a race; its 23505 is the same 409), and for a curriculum with no nodes. **Create topic from node** → `POST /api/library/curricula {nodeId, title?, subject?, childIds?}`: candidate topic + `curriculum` alias; a **leaf maps itself**; a **group lists its objectives with tick boxes (all ticked)** and the route maps **every ticked child** as `full` — the group itself is not mapped — answering `{ok, id, mapped}`; the same 409-with-owner as New topic ("map the node to it instead"); audited on the node (`topic_create_from_node`, with `mappings` and the child codes) and on the topic (`topic_create` with `from_node`) | list: any member; Derive, Create: editor, admin |
| `/library/candidates` | The unmapped queue (`topic_candidates.status = open`): book candidates grouped by book; curriculum candidates grouped by **curriculum, then grade**, each showing `raw_title`, the model's **rationale**, the **anchor** node (grade · sub-strand / unit, with its kind chip) and the **objective codes in `node_ids`** (titles fetched in one chunked query), plus the normalized key and the **suggested** topic from the alias match | **Merge into suggested**, **Merge into…** (topic search), **Create topic**, **Dismiss** → `POST /api/library/candidates` `{candidateId, mode, topicId?}`; **create** maps every node in `node_ids` (or `node_id` when `node_ids` is empty) as `full` and adds the alias, **merge** adds those mappings and the alias to the target, **dismiss** touches only the row; every name the plan would attach is checked for an owner BEFORE any write, and a 409 names the topic that holds it (`existingId`) and offers a one-click merge; a conflict that still appears (a lost race) takes a just-created topic back out and answers the same 409 — never a 200; the objectives to map are looked up first and the ones deleted since the derive (`node_ids` has no foreign key) are **dropped** (`dropped_missing_nodes` in the answer and the audit row) rather than failing with a 23503, and a mapping write that fails all the same answers 500 `{error, step: "mappings"}` after taking a just-created topic back out. **Create all unmatched (N)** per curriculum → `POST /api/library/candidates/bulk {curriculumId, subject?}`: every open curriculum candidate of that curriculum with no suggested topic is created the same way (up to **25 per click**; `remaining` says how many are left; a row's `node_ids` mappings go in one upsert) — a key already held is **skipped**, not merged, and reported `{candidateId, raw_title, key, reason, existingId, existingTitle, outcome}`; a skipped row is **settled** so it does not come back on the next click: the holder becomes its `suggested_topic_id` (a one-click **Merge into suggested** in the queue; audited `candidate_suggest`), and a title with no canonical key is **dismissed** by the member (audited `candidate_dismiss` with the reason); a lost race takes the topic back out and skips too; objectives deleted since the derive (`node_ids` has no foreign key) are looked up once for the batch and **dropped** from the mappings (`dropped_missing_nodes` per created row and in its audit row) instead of failing the row; a database error stops the batch (`failed` with its `step`, 500) with what was done so far — a mapping failure takes that row's topic back out first; audited per created topic (`candidate_create`, `bulk: true`) and once per batch on the curriculum (`candidates_bulk_create`) | read: any member (read-only note for reviewers); resolve, bulk: editor, admin |
| `/library/harvest` | Books on the platform (not taken down), owner e-mail (**editors and admins only** — reviewers see `—`, the e-mails are neither fetched nor searched for them), grade · subject, pages, uploaded, candidates already harvested (open/total), latest `topic_harvest` job (status, progress, error) | **Harvest** → `POST /api/library/harvest {bookId}`: inserts ONE `public.jobs` row `{type: 'topic_harvest', book_id, generation_id: null, status: 'queued'}` — an observer job, never a `generations` row; refused (409) while a harvest is queued or processing for that book (the partial unique index `jobs_one_live_harvest` enforces it under a race; its 23505 is the same 409), and for books that are not `ready` | read: any member; Harvest: editor, admin |

Pickers used by the panels (any member): `GET /api/library/topics?q=&limit=&all=1`
(topic search; retired hidden unless `all=1`) and
`GET /api/library/curricula/[id]/nodes?q=&grade=&limit=` (node search within one
curriculum; each hit carries its resolved `kind` and its direct-`children` count).

Route shape is guarded by `src/utils/__tests__/catalogue-routes.test.ts`: Node runtime,
`isLibraryMemberRequest(…)` as the first await of every handler (404 on null), no
`generations` access anywhere under `/api/library`, `jobs` inserted from exactly the
harvest, derive and article routes (all observer jobs), an audit row from every POST,
the Phase 2a invariants (grouped candidates map `node_ids`; create-from-node maps the
ticked children; the bulk create checks every key once — insertTopic's own check —
skips a taken one and settles the skipped row; both candidate create paths look the
planned nodes up first and take a topic they could not map back out), and the Phase 2b
invariants (the article route checks the role per action before it opens a client;
a version is approved **only** through `approve_topic_article()` with the reviewer's
id and no `topic_articles` write anywhere carries `status: 'approved'`; both article
jobs check for a live one before inserting, keyed like their 0114 index, and read a
23505 back as the 409; submit and reject are guarded transitions and reject needs
notes; save validates before it writes, upserts figures by key and deletes only draft
figures).

Later phases add to `/library/topics/[id]` the kit review, translate and publish
panels, and the `/library/topics/[id]/questions` and `/library/blueprints` screens
(plan §7.2).
