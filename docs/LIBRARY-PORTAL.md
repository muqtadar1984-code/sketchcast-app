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
(asserted by `catalogue-routes.test.ts`). Every other status transition (save, submit,
reject) is a **status-guarded UPDATE read back** (`…eq/in("status")…select("id")`): zero
rows means the version moved between the read and the write — a reviewer approved or
rejected it while the editor was typing — and the route answers **409** without writing
or auditing anything, so an approved version is never overwritten by a Save that
started earlier. The pure rules — `validateArticle` (the Save gate: bounded lists and
strings — `spec.style` 120, `spec.notes` 500 — unique ids, every cross-reference
resolving inside the article, **no raw HTML** in `body_md`, `problem`, `solution_md`,
glossary `definition` or misconception `correction` — `<` followed by a letter, `/` or
`!` is refused naming the field, `a < b` is fine — a `body_md` that is present but not a
string is an error, and a normalised body out), `wordCount`, the `can*` status
predicates (`canRenderFigures`: draft, in review, approved), `figureNeedsReset` (a
rendered or reviewed figure whose `spec` — subject, parts as a set, style, notes; not
the caption — changed goes back to draft), `sectionDiff` (pairs sections by id, then the
leftovers by order, so a regenerated draft still compares), `articleSummaries` (per
topic: the approved version, the newest pending one, the newest at all) — live in
`src/utils/catalogue/article.ts`, tested in `catalogue-article.test.ts`.

| Screen | What it shows | Actions | Who |
|---|---|---|---|
| `/library` | Overview: the **review queues** — *Articles awaiting review* (`topic_articles.status = in_review`) and *Article drafts* (`draft`), two head counts (never a scan) linking to `/library/topics?article=in_review` / `?article=draft`; then the doors into the screens, greyed for roles that cannot act there. A missing 0112 leaves the queues unshown with a note | — | any member |
| `/library/topics` | Canonical topics; filters subject · curriculum · grade · **sub-strand / unit** (`?node=`: topics mapped to that group **or to any objective under it**, since mappings point at either; the select lists the curriculum's `sub_strand` / `unit` nodes, narrowed to the grade; a group with more than 150 nodes under it — the id list travels in the URL — is not filtered by, and the page asks for a sub-strand instead) · status · **article state** (`?article=draft\|in_review\|approved\|none` — the overview's queue links land here: `approved` = the topic **has an approved version**; `draft` / `in_review` = it **has a version pending** in that state, whatever else it has, so a topic with an approved v1 and a draft v2 matches both; `none` = **no version at all**, PostgREST's null filter on the embed) · free text (GET querystring, paginated in Postgres; a `?page=` past the end lands on the last page; `%`/`_` in the search box are searched for, not wildcards); title, subject, status chip, **article chips** — two facts per topic from its `en` versions (one grouped query for the page's ids, reduced by `articleSummaries`): **"approved vN"** when one is approved, and beside it **"vM draft pending"** / **"vM in review"** when a newer version is in flight; a rejected or superseded version never stands in for either (a topic whose every version was rejected shows "vM rejected"; *none* means no version at all), bank-maturity chip, #mappings, updated | **New topic** (title → canonical key + manual alias) → `POST /api/library/topics`; a key somebody already holds — as their `canonical_key` **or as one of their aliases** — is refused with **409** `{existingId, existingTitle, existingStatus, via}` BEFORE anything is written (a topic merged away is followed to the live topic that now holds its name; a retired holder is named as such) | list: any member; New topic: editor, admin |
| `/library/topics/[id]` | Header (title, subject, summary, teacher avatar), status + maturity chips, pipeline position, aliases, curriculum mappings with the **depth node** selector (a chip for reviewers), prerequisites (and "required by"), open candidates suggesting it, audit trail | `POST /api/library/topics/[id]` with `{action}`: **update**, **alias_add / alias_remove**, **mapping_add** (curriculum → node search → full/partial; the picker shows each hit's kind and child count, and when the picked node has children the panel offers **"Map all N objectives"** — `{mapChildren: true}` maps every direct child instead of the group, answering `{ok, mapped}` and auditing the count) **/ mapping_remove**, **prereq_add / prereq_remove** (topic search), **set_depth** (one of the mapped nodes), **Approve** (candidate → approved), **Retire** (any → retired), **Reopen** (retired → candidate, in_review → generating, video_approved → in_review), **Merge into…** (aliases, mappings, open candidates and prerequisite references move to the target; this title becomes a manual alias of the target; this topic retires). The merge is not one transaction: its steps are idempotent, a failure answers `{error, step}` (500, or 409 on a unique violation) and is audited as `library_topic_merge_failed`, and clicking Merge again with the same target completes it | read: any member; Approve: reviewer, editor, admin; everything else: editor, admin |
| `/library/topics/[id]` — **Article panel** | The version list (version, status chip, author `model`/`staff`, words, reviewer + date, updated; "from vN" for a version written from another), the **latest `topic_article` job** (status, progress, error), one selected version: read-only rendering (objectives, sections with their placed figures — signed previews of the `visual-assets` bucket, one hour, one `createSignedUrls` call for the page — claims per section, glossary, misconceptions, worked examples, depth rationale; a figure named but missing, or a claim pointing at a vanished section, is flagged), its **latest `figure_render` job**, review notes; the **editor** for a `draft` / `in_review` version (title, objectives, sections with markdown + figure keys + covered objectives, figures with key / caption / `spec.subject` / parts as a tag list / style / notes, glossary, misconceptions, worked examples, claims with their section, depth rationale; the renderer's fields — status chip, preview, `render_error` — shown, never edited; removing a figure also takes its key out of every section, and a key a stored section names with no figure behind it shows as a removable **orphan chip** in the section's figure list; `validateArticle` runs in the browser first so every problem shows before the round trip, the word count updates live); a **Compare** view of any two versions (`sectionDiff`: same / changed with the changed fields highlighted / added / removed, plus a title change) | `POST /api/library/topics/[id]/article` with `{action}` — **Write article / Write a new version** `{action: "generate", hints?, sourceArticleId?}` → ONE `public.jobs` row `{type: 'topic_article', params: {topic_id, language: 'en', hints, source_article_id}, book_id: null, generation_id: null, status: 'queued'}`; refused (400) for a `candidate` or `retired` topic and (409, `{jobId}`) while an article job is queued or processing for the topic (check-then-insert; `jobs_one_live_article` under a race, its 23505 is the same 409). **Save** `{action: "save", articleId, article}` → `validateArticle` (400 with **every** error in `errors`), the validated body written with `word_count` recomputed **by a status-guarded update read back** — if the version was approved or rejected while the editor was open the update matches nothing and the route answers **409** ("reload") before it touches the figures, so an approved version is never overwritten; then figures **upserted by `figure_key`** (editable columns only, so a rendered figure keeps its asset when the caption changes; but a rendered / reviewed figure whose **`spec` changed** — subject, parts, style, notes — is **reset to `draft`** with `visual_asset_id`, `labels` and `render_error` cleared so the next render redraws it, reported in `figuresReset`), a figure the editor dropped **deleted only while still `draft`** (a rendered / approved one is kept and reported in `figuresKept`); 409 for an approved / superseded / rejected version — those are read-only, with **New version from this** instead. **Submit for review** `{action: "submit", articleId}` (draft → in_review; 409 when it is not a draft, including when the guarded update matched nothing because the draft moved meanwhile — audited only on a real change). **Render figures** `{action: "render_figures", articleId}` → ONE `jobs` row `{type: 'figure_render', params: {article_id}, book_id: null, generation_id: null, status: 'queued'}`; **409 for a rejected or superseded version** (`canRenderFigures`: draft, in review or approved only — the panel hides the button), 400 with no figures, 409 while a render is live for the version (`jobs_one_live_figure_render`). **Approve** `{action: "approve", articleId, notes?}` — the panel asks first ("Approve vN? This supersedes vM and moves the topic to article approved.") — **409 while the topic is still a `candidate`** (approve the topic first; the button says so), else `approve_topic_article(p_article, p_reviewer = the member, p_notes)` and nothing else — the RPC's refusals (not reviewable, vanished) are the 409; audited by the RPC. **Reject** `{action: "reject", articleId, notes}` — notes **required** — draft \| in_review → `rejected` with the reviewer and time; 409 when the guarded update matched nothing (another reviewer's verdict landed first), audited only on a real change. An article id from another topic is a 404. Every action but approve is audited on the **topic** (`library_article_generate` / `_save` / `_submit` / `_reject`, `library_figures_render`) so the topic's trail shows the article's history | read: any member; generate, save, submit, render: **editor, admin** (`edit_article`); approve, reject: **reviewer, editor, admin** (`approve`) |
| `/library/curricula` | Every curriculum with a coverage bar over its **objectives** (leaf nodes, covered through the tree), its **latest `topic_derive` job** (status, progress / `jobs.stage`, error) and its **open derived candidates** (a link into Candidates); `?curriculum=<id>` opens its nodes as a tree grouped by **kind** — grade → strand (collapsible) → sub-strand / unit → objectives — each node with a kind chip (dashed when inferred from the code), each group with **"n/m objectives mapped"**, each node with the covering topics (coverage + status chips) or "covered by its group"; uncovered nodes are flagged | **Derive topics** → `POST /api/library/derive {curriculumId}`: inserts ONE `public.jobs` row `{type: 'topic_derive', params: {curriculum_id}, book_id: null, generation_id: null, status: 'queued'}` — an observer job, never a `generations` row; refused (409) while a derive is queued or processing for that curriculum (check-then-insert, and the partial unique index `jobs_one_live_derive` on `params->>'curriculum_id'` enforces it under a race; its 23505 is the same 409), and for a curriculum with no nodes. **Create topic from node** → `POST /api/library/curricula {nodeId, title?, subject?, childIds?}`: candidate topic + `curriculum` alias; a **leaf maps itself**; a **group lists its objectives with tick boxes (all ticked)** and the route maps **every ticked child** as `full` — the group itself is not mapped — answering `{ok, id, mapped}`; the same 409-with-owner as New topic ("map the node to it instead"); audited on the node (`topic_create_from_node`, with `mappings` and the child codes) and on the topic (`topic_create` with `from_node`) | list: any member; Derive, Create: editor, admin |
| `/library/candidates` | The unmapped queue (`topic_candidates.status = open`): book candidates grouped by book; curriculum candidates grouped by **curriculum, then grade**, each showing `raw_title`, the model's **rationale**, the **anchor** node (grade · sub-strand / unit, with its kind chip) and the **objective codes in `node_ids`** (titles fetched in one chunked query), plus the normalized key and the **suggested** topic from the alias match | **Merge into suggested**, **Merge into…** (topic search), **Create topic**, **Dismiss** → `POST /api/library/candidates` `{candidateId, mode, topicId?}`; **create** maps every node in `node_ids` (or `node_id` when `node_ids` is empty) as `full` and adds the alias, **merge** adds those mappings and the alias to the target, **dismiss** touches only the row; every name the plan would attach is checked for an owner BEFORE any write, and a 409 names the topic that holds it (`existingId`) and offers a one-click merge; a conflict that still appears (a lost race) takes a just-created topic back out and answers the same 409 — never a 200; the objectives to map are looked up first and the ones deleted since the derive (`node_ids` has no foreign key) are **dropped** (`dropped_missing_nodes` in the answer and the audit row) rather than failing with a 23503, and a mapping write that fails all the same answers 500 `{error, step: "mappings"}` after taking a just-created topic back out. **Create all unmatched (N)** per curriculum → `POST /api/library/candidates/bulk {curriculumId, subject?}`: every open curriculum candidate of that curriculum with no suggested topic is created the same way (up to **25 per click**; `remaining` says how many are left; a row's `node_ids` mappings go in one upsert) — a key already held is **skipped**, not merged, and reported `{candidateId, raw_title, key, reason, existingId, existingTitle, outcome}`; a skipped row is **settled** so it does not come back on the next click: the holder becomes its `suggested_topic_id` (a one-click **Merge into suggested** in the queue; audited `candidate_suggest`), and a title with no canonical key is **dismissed** by the member (audited `candidate_dismiss` with the reason); a lost race takes the topic back out and skips too; objectives deleted since the derive (`node_ids` has no foreign key) are looked up once for the batch and **dropped** from the mappings (`dropped_missing_nodes` per created row and in its audit row) instead of failing the row; a database error stops the batch (`failed` with its `step`, 500) with what was done so far — a mapping failure takes that row's topic back out first; audited per created topic (`candidate_create`, `bulk: true`) and once per batch on the curriculum (`candidates_bulk_create`) | read: any member (read-only note for reviewers); resolve, bulk: editor, admin |
| `/library/harvest` | Books on the platform (not taken down), owner e-mail (**editors and admins only** — reviewers see `—`, the e-mails are neither fetched nor searched for them), grade · subject, pages, uploaded, candidates already harvested (open/total), latest `topic_harvest` job (status, progress, error) | **Harvest** → `POST /api/library/harvest {bookId}`: inserts ONE `public.jobs` row `{type: 'topic_harvest', book_id, generation_id: null, status: 'queued'}` — an observer job, never a `generations` row; refused (409) while a harvest is queued or processing for that book (the partial unique index `jobs_one_live_harvest` enforces it under a race; its 23505 is the same 409), and for books that are not `ready` | read: any member; Harvest: editor, admin |

Pickers used by the panels (any member): `GET /api/library/topics?q=&limit=&all=1`
(topic search; retired hidden unless `all=1`) and
`GET /api/library/curricula/[id]/nodes?q=&grade=&limit=` (node search within one
curriculum; each hit carries its resolved `kind` and its direct-`children` count).

Route shape is guarded by `src/utils/__tests__/catalogue-routes.test.ts`: Node runtime,
`isLibraryMemberRequest(…)` as the first await of every handler (404 on null),
`generations` touched **only** by the kit and compose routes — inserted as catalogue rows
behind `catalogueGenerateEnabled()` and `CATALOGUE_OWNER_ID`, never in a file that also
inserts `jobs` (`pipeline-universal.test.ts`) — `jobs` inserted from exactly the harvest,
derive, article and questions routes plus `kit/questions-job.ts` (all observer jobs), no
route writing `topic_kits.status` / `topic_articles.status = 'approved'` (kits are
approved and rejected only through the 0115 RPCs), an audit row from every POST,
the Phase 2a invariants (grouped candidates map `node_ids`; create-from-node maps the
ticked children; the bulk create checks every key once — insertTopic's own check —
skips a taken one and settles the skipped row; both candidate create paths look the
planned nodes up first and take a topic they could not map back out), and the Phase 2b
invariants (the article route checks the role per action before it opens a client;
a version is approved **only** through `approve_topic_article()` with the reviewer's
id and no `topic_articles` write anywhere carries `status: 'approved'`; both article
jobs check for a live one before inserting, keyed like their 0114 index, and read a
23505 back as the 409; save, submit and reject are status-guarded writes read back
with `.select("id")` whose zero rows are a 409 answered before anything else is touched
or audited; reject needs notes; save validates before it writes, upserts figures by
key, resets a rendered figure whose spec changed (`figureNeedsReset` → `FIGURE_RESET`)
and deletes only draft figures; render_figures refuses a rejected / superseded version
before it counts or enqueues; approve refuses while the topic is a candidate, before
the RPC).

## Phase 3 — the kit (migration 0115)

**What a kit is.** A `topic_kits` row (0112) plus ordinary `generations` rows owned by
the **catalogue system account** (`catalogue@sketchcast.app`, a platform admin) with
`book_id` and `chapter_ref` **NULL** and `params.catalogue = true` — the shape 0112's
guards recognise and exempt from dedup, the caps and the ledger. **Generate kit**
inserts five kinds at once, presentation first: `presentation`, `activity`,
`case_study`, `worksheet`, `deck`. The **`lesson_plan` is inserted by the worker**
after the presentation finishes, because it cites the clips the video produced
(`params.clips`, `params.lesson_modes = true` → the three lesson modes). Documents are
one each per topic, never per part. Every generation carries the same params
(`kitGenerationParams` in `src/utils/catalogue/kit.ts`): `catalogue: true`, `topic_id`,
`kit_id`, `article_id`, `language: 'en'`, `narration_style: 'dialogue'`,
`teacher_avatar: 'female' | 'male'`, `tts_voice: 'g-en-f' | 'g-en-m'`, `student_voice:
'g-en-student-m' | 'g-en-student-f'` (the **other** gender's premium student voice), and
`curriculum_header` — one line per curriculum the topic is mapped to
(`curriculumHeaderLines`: `Cambridge Lower Secondary Science 0893 · 7Bs.01, 7Bs.02`;
`CBSE Science 086 · Class 9 · Cell — the basic unit of life`), rendered under the
subtitle of every catalogue document. The teacher avatar defaults to the gender used
**less** across the topic's existing kits, a tie going to female (`nextTeacherAvatar`),
so a regenerated topic alternates faces and voices.

**Lifecycle.** `generating` → `in_review` → `approved` (or `rejected`); `failed` when a
piece errors. The worker owns the middle: when the presentation finishes it writes the
**part plan** (`topic_kits.part_plan`, 0115: `[{part, sections, minutes}]`), the
**chapter timestamps** (`chapters`: `[{part, t, label, section_id?}]`) and the **clips**
(`clips`: `[{part, start, end, label, purpose}]`, 120–240 s aligned to chapter
boundaries) and inserts the lesson plan; when every generation the kit references is
`done` it moves the kit to `in_review` and the topic `generating → in_review`. A failing
generation moves the kit to `failed` (the topic stays `generating`); the portal's
**Retry** re-inserts that one kind and puts the kit back to `generating`. Retry is built
so two operators cannot double-build and so the pointer write cannot lose the worker's:
the failed row is taken **exclusively** first (a compare-and-swap flips
`params.retried` to `true` where it is not set — the loser of two clicks answers 409
"already retried" and inserts nothing; a presentation retried twice is a whole video's
worth of Vertex image calls), the new row carries the failed row's **input params only**
(`retryParamsOf`: decision 1's keys, plus `clips` / `lesson_modes` for a lesson plan —
never the telemetry the worker merged into the failed run), and the kit is repointed by
the RPC **`repoint_kit_generation(p_kit, p_kind, p_generation, p_replaces)`** — one
`jsonb ||` merge on a `generating` kit with a compare-and-swap on the id being replaced,
so the `lesson_plan` id the worker merges in meanwhile (`insert_lesson_plan`) survives
and a pointer somebody else moved is reported (audited `library_kit_retry_unpointed`),
never overwritten — and the row queued behind a refused repoint is **cancelled** rather
than left to build as an orphan: its job is taken out of the queue while still `queued`
(the catalogue lane runs off-peak with no builder live, so it normally sits for hours),
the generation is marked `error`, and the failed row's lock is released so Retry can be
tried again once the kit is back to `generating`; a job the worker had already claimed
cannot be recalled — it builds unreferenced and the audit row says so (`cancelled:
false`). The worker's own pointer write in `insert_lesson_plan` is still a
read-modify-write; the RPC is there for it to call (a follow-up in the worker repo).
The 0115 trigger `create_job_for_generation()` copies `{catalogue:
true, topic_id, kit_id, question_set_id}` into `jobs.params`, which is how the worker
keeps catalogue jobs out of the user lanes and builds them only in its **off-peak
window** when no teacher's builder is live (never-starve, decision 12).

**Gate 2 = the RPCs.** `approve_topic_kit(p_kit, p_reviewer, p_notes)` (in_review →
approved; topic in_review → video_approved; audit `library_kit_approve`) and
`reject_topic_kit(p_kit, p_reviewer, p_reason, p_notes)` (in_review | approved →
rejected; reason from the 0112 list and notes **required**; topic video_approved →
in_review so a pulled approval reopens review; audit `library_kit_reject`) — SECURITY
DEFINER, service role only, `check_violation` (23514) when the kit is not in an accepting
status, `no_data_found` (P0002) when missing. Both check the **topic** too — approve
needs it `in_review`, reject `in_review` or `video_approved` — because the kit Regenerate
leaves behind at `in_review` (the topic already back at `generating`) is history, not a
candidate: approving it would leave two approved kits on one topic. Approve also checks
that the kit's **article is still the approved version**: a kit built from v1 is not
approved after v2 supersedes it; it is regenerated (the article is the kit's source of
truth). The kit route mirrors the three checks (`kitAcceptsApprove` / `kitAcceptsReject`
in `kit.ts`) so the panel's disabled button and the 409 say the same sentence. **No route
writes `topic_kits.status = 'approved'` or `'rejected'`** (asserted by
`catalogue-routes.test.ts` and `migration-0115-catalogue-kits.test.ts`). Approval is
enforced twice: the panel hides the buttons and the worker re-checks (a catalogue
generation whose article is not approved, or whose kit is missing or rejected, fails
before any model call).

**Env vars.**

| Where | Variable | Meaning |
|---|---|---|
| Vercel (app) | `FEATURE_CATALOGUE_GENERATE=true` | `catalogueGenerateEnabled()` — the first lock in front of every catalogue `generations` insert (Generate kit, Retry, Regenerate, Compose). Off ⇒ the routes answer **409** with a plain sentence and the kit panel disables its buttons saying why. Off by default: a kit spends the same Vertex image capacity real lessons do. |
| Vercel (app) | `CATALOGUE_OWNER_ID` | The system account's profile id (`9d41e12e-e9c9-4b82-b3a9-3421c2c57726`); the owner of every catalogue generation. Read by ONE helper, `catalogueOwnerId()` in `flags.ts` (trim, lower-case, must be a uuid) — the routes and both portal pages — so a malformed value greys the buttons with the same sentence the routes answer. Unset or malformed ⇒ **409** "not configured". An owner that is not a platform admin trips 0112's guard (42501) ⇒ **409** "the catalogue owner is not a platform admin". |
| Railway (worker) | `CATALOGUE_WINDOW_UTC` | The off-peak window for the catalogue lane, default `20:00-05:00`; `always` disables the window (local testing only). The lane also waits for every user builder to finish. |
| Railway (worker) | `CATALOGUE_PART_TARGET_MIN` | Target minutes per video part (default 17; × 130 wpm = the words budget); hard ceiling 20 min. Parts close only at article-section boundaries. |

| Screen | What it shows | Actions | Who |
|---|---|---|---|
| `/library` | Two more **review queues**: *Kits awaiting review* (`topic_kits.status = in_review`, → `/library/topics?status=in_review`) and *Question items awaiting review* (`topic_questions.status = draft`); a **Blueprints** door | — | any member |
| `/library/topics/[id]` — **Kit panel** | **Generate kit** (teacher avatar radio, default alternating; disabled with the reason when the flag is off, the owner is unset, a kit is generating, the topic is not `article_approved` or the English article is not approved — `kitAcceptsGenerate`), the **current kit**: status chip (`rejected · <reason>`), teacher and the two voice ids, progress (`kitProgress`: "3/6 done · 1 failed"), reviewer + date, review notes; **one row per piece** in kit order (kind label, generation status, the latest **builder** job's progress / stage / error — an observer job pointing at the generation is not the build), documents as signed download links (`docDownloadName`), the **video parts inline** (`<video controls>`, signed for an hour, ordered by extracted part number — `sortVideoArtifacts`, never by path string), each with its **chapter timestamps**; the **part plan**; the **clip list** (view; **Edit clips** for `generate` roles on an `in_review` / `approved` / `rejected` / `failed` kit — mm:ss inside a known part, 30 s–10 min, label ≤ 80, `validateClips` in the browser first); **Retry** next to a failed piece; **Regenerate kit**; **Approve video / Reject** (reason select + notes) for `approve` roles; **earlier kits** collapsed as history. A missing `part_plan` column (0115 not applied) shows the kits without their plan and says so. The header line gains **Question bank →** (`/library/topics/[id]/questions`) | `POST /api/library/topics/[id]/kit` with `{action}`: **generate** `{teacherAvatar?}` — acceptance, the two locks, one `topic_kits` row, the topic moved `article_approved → generating` by a **guarded UPDATE read back** (the race lock: the loser of two clicks takes its kit row out and answers 409), the five `generations` rows (`kitGenerationRows`), the kit repointed at them, ONE `topic_questions` job (`kit/questions-job.ts`: live pre-check keyed like `jobs_one_live_questions`, a 23505 or a live job = "already runs", not a failure), audited `library_kit_generate`; a failed generations insert marks the kit `failed` with the reason and puts the topic back; once the generations exist a later failure is audited too — the bank job is best-effort (`warning` on the 200, `questions_job_error` in the audit row) and a failed pointer write answers 500 naming the generation ids. **retry** `{kitId, kind}` — the kind's generation must be `error` and not already retried; it is taken exclusively (`params.retried` CAS, 409 when somebody else got there), kit `failed \| generating → generating` guarded and read back, one row with the failed row's whitelisted params (`retryParamsOf`), the pointer through `repoint_kit_generation` (409 + `library_kit_retry_unpointed` when the pointer moved — the new row's job is cancelled while still `queued` and the generation marked `error`, so nothing orphaned is built, and the failed row is unlocked for another Retry); `library_kit_retry`. **regenerate** `{kitId}` — an `in_review` / `rejected` kit whose article is still the approved one, topic `in_review → generating` guarded, a NEW kit with the old kit's avatar and `source_kit_id`; `library_kit_regenerate`. **save_clips** `{kitId, clips}` — `validateClips` against `part_plan` (400 with every error), guarded write on an editable status; `library_kit_clips_save`. **approve** `{kitId, notes?}` → `kitAcceptsApprove` (kit `in_review`, topic `in_review`, the kit's article still `approved` — else 409 with the reason) then `approve_topic_kit`; **reject** `{kitId, reason, notes}` → `kitAcceptsReject` (kit `in_review \| approved`, topic `in_review \| video_approved`) then `reject_topic_kit` — the RPCs check the same, their refusals are the 409 and they audit themselves. A kit id from another topic is a 404 | read: any member; generate, retry, regenerate, save_clips: **editor, admin** (`generate`); approve, reject: **reviewer, editor, admin** (`approve`) |

The question bank (`/library/topics/[id]/questions`, `/library/blueprints`, the
`questions`, `compose` and `blueprints` routes) is documented in `docs/QUESTION-BANK.md`.
The translate panel arrives with its phase (plan §7.2).

## Phase 4 — publishing to YouTube (DARK)

**Nothing publishes anything today.** The channel has not been created, the YouTube API
project has not passed the compliance audit and the OAuth consent has not been run, so
the whole phase ships behind `FEATURE_CATALOGUE_PUBLISH` (off) — the panel shows the
state and the description preview with the button disabled and the reason under it. What
is useful now is exactly that preview: a wrong curriculum code or a broken timestamp list
is cheap to fix here and public afterwards.

**Publishing is ADMIN ONLY.** `libraryAllows` grants the `publish` action to `admin` and
to nobody else (plan §7.1): an outside subject reviewer may be trusted to approve a video
and must not be able to put it on the company's channel. `POST
/api/library/topics/[id]/publish` asks for that action for BOTH of its actions and
answers a reviewer or editor with the same 404 a non-member gets.

**The route writes exactly one row: the job.** `{action: 'publish' | 'retry', kitId,
privacy?}` enqueues ONE `topic_publish` observer job (`generation_id` and `book_id` NULL,
its input in `jobs.params` — `{kit_id, topic_id, language, privacy}`) and the worker does
the rest. It inserts no `generations` (the video already exists as the kit's artifact —
no model call is made), writes no `topic_publications` (only the worker knows what
YouTube accepted) and never touches `topic_kits.status`: gate 2 is the kit's `approved`
status, which `approve_topic_kit()` (0115) owns. `publish` and `retry` enqueue the same
job — the job is idempotent, a part that already holds a `youtube_video_id` is skipped —
and differ only in what the panel offers: **Publish** before any run has touched a part,
**Finish publishing** afterwards, so a run stopped by the per-run upload cap
(`YOUTUBE_MAX_PARTS_PER_RUN`) or a failure is completed rather than restarted.

**Four refusals, enforced twice** (plan §1.3, `utils/catalogue/publish.ts` `canPublish` —
one function so the panel's disabled button, the route's 409 and the worker's refusal say
the same sentence): the kit is `approved`; the topic is `video_approved` (or already
`published`, so a capped run can be finished); the kit's **article is still the approved
version** (a video built from superseded text is regenerated, not published); and
`topics.bank_maturity` is not `none` (a published video's description links teachers to
its worksheet, and a link into an empty bank is worse than no video, plan §1.7). The
WORKER re-checks all four before its first network call.

**Privacy is `private`, whatever the flag says.** `publishPrivacyAccepts` accepts only
`private`: an API project that has not passed the compliance audit cannot create an
unlisted or public video, and the privacy is flipped later by a deliberate step, not by a
checkbox on the queue form. A non-`private` request is a 409 even with the flag on.

**One live publish per kit.** 0116 adds `jobs_one_live_publish` — a partial unique index
on `jobs ((params->>'kit_id')) where type = 'topic_publish' and status in ('queued',
'processing')`. The route pre-checks with the same key and maps the 23505 to the same 409
naming the live job. This one matters more than its siblings: two concurrent publishes of
one kit would upload the same part twice to a channel with a ~100 uploads/day quota, and
a duplicate video cannot be taken back quietly. 0116 adds **nothing else** — no table, no
RPC, and no credential column: every YouTube credential lives in the worker's
environment.

The enqueue is audited `library_publish` on the topic, with the kit, the job, the action,
the privacy and what the channel already held (`already_published`, `already_failed`), so
a partial publish reads back from the trail. Nothing is audited for a publish that was
refused.

| Screen | What it shows | Actions | Who |
|---|---|---|---|
| `/library/topics/[id]` — **Publish block** (inside the Kit panel, only for an `approved` kit) | The dark note (no channel, no compliance audit, private only); one row per video part — state (`published` / `failed` / `not yet`, decided by the presence of a `youtube_video_id`, so a caption failure never demotes a live video), the YouTube id as a link, the privacy, captions / thumbnail / playlists / date, and the row's error; **what will be posted** — the title (`<Topic>`, or `<Topic> — Part k of N`) and the full description per part: the topic summary, the curriculum header lines the documents carry, the chapter timestamps (posted only when YouTube would read them — three or more marks from `0:00`, else the block is dropped and the panel says why), the next-part pointer and the UTM-tagged sketchcast.app link | `POST /api/library/topics/[id]/publish` `{action: 'publish' \| 'retry', kitId, privacy?}` | read: **any member** (a reviewer who approved the video sees whether it reached the channel); the button: **admin only** (`publish`) |

**Env vars.**

| Where | Variable | Meaning |
|---|---|---|
| Vercel (app) | `FEATURE_CATALOGUE_PUBLISH=true` | `cataloguePublishEnabled()` — the app's whole share of the lock. Off ⇒ the publish route answers **409** with the "channel is not created / audit not passed" sentence and the panel disables its button saying the same. Turn it on only after the channel exists, the API project has passed the compliance audit and the worker holds a refresh token. |
| Railway (worker) | `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET` | The OAuth client of the audited API project. **Never** stored in the database or this repo. |
| Railway (worker) | `YOUTUBE_REFRESH_TOKEN_<LANG>` | One refresh token per channel / language, minted once by `scripts/youtube_oauth.py` and pasted into Railway by the founder. |
| Railway (worker) | `YOUTUBE_MAX_PARTS_PER_RUN` | Parts uploaded per publish run (default 5). `captions.insert` costs 400 of the 10,000 daily quota units, so about 7 fully captioned videos fit in a day; what a run left over is reported in its summary and finished by the next **Finish publishing**. |
