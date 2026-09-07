# Question bank and worksheet composer (Library portal, Phase 3)

Every canonical topic carries a **question bank**: rows in `topic_questions`
(migration 0112 §5), written by the worker from the topic's **approved English
knowledge article**, reviewed **one item at a time** by a named reviewer, and
**composed** into worksheets from the approved items by a **blueprint**. The
bank is rows, not documents — worksheets now, exam papers and mock exams later
(plan §1.7) are renderings of the same rows.

Portal: `/library/topics/[id]/questions` (the bank) and `/library/blueprints`
(the presets). Pure logic: `src/utils/catalogue/questions.ts`, tested in
`src/utils/__tests__/catalogue-questions.test.ts`. Routes:
`/api/library/topics/[id]/questions`, `/api/library/topics/[id]/compose`,
`/api/library/blueprints`. Worker: `catalogue/questions.py` (the writer),
`catalogue/composer.py` (the composer), `docgen/bank_worksheet.py` (the
rendering). Spec: *Phase 3 — Catalogue kits: build spec*, decisions 8–10.

## The item

| column | meaning |
|---|---|
| `topic_id`, `article_id` | the topic, and the article VERSION the item was written from (edits are validated against that version's objectives, claims and misconceptions) |
| `language` | `en` in Phase 3; translations arrive with the translate phase (`source_question_id` links them) |
| `item_type` | `mcq` · `true_false` · `fill_blank` · `match` · `assertion_reason` (objective) · `short_answer` · `long_answer` · `numerical` · `diagram_label` (subjective) |
| `answer_mode` | `objective` / `subjective` — **derived from the type**, never edited on its own |
| `objective_ref` | the article objective the item serves (required; every item serves one) |
| `claim_ref` | the article claim it draws on (optional) |
| `difficulty` | 1–5 |
| `cognitive_level` | `recall` · `understand` · `apply` · `analyse` · `evaluate` · `create` |
| `marks`, `est_seconds` | what it is worth, how long it takes (the worksheet sizes its ruled answer space from these) |
| `stem` | the question text (no raw HTML) |
| `options` | MCQ: exactly four `[{key: "A", text}]`; assertion–reason: a keyed list; match: the worker's pairs object |
| `answer` | MCQ `{"key": "B"}`; true/false `{"value": true}`; otherwise a non-empty object — `{"text": …}` for prose, the worker's own shape for numerical / match |
| `distractor_rationale` | MCQ only: `{"A": {"why_wrong", "misconception_ref"?}, …}` for **every** non-answer key — what the answer key prints and what the portal's ◆ misconception tooltip reads (the ref names an article misconception) |
| `marking_scheme` | `[{point, marks}]` — required for a subjective item; when present it must add up to `marks` |
| `explanation`, `tags` | for the answer key / for filtering |
| `content_hash` | `sha1(item_type + "\|" + canonical_key(stem))` — `canonical_key` is the catalogue's one normalisation (`key.ts` / `catalogue/key.py`), so a re-typed stem with the same words is the same item; `unique (topic_id, language, content_hash)` |
| `status` | `draft` → `approved` \| `rejected`; anything → `retired` |
| `reviewer_id`, `reviewed_at`, `notes` | who decided, when, why (reject notes feed *Regenerate rejected*) |

### The validator (portal `validateQuestionEdit` ↔ worker validator)

The same rules run in both places, **per item type**, so an inline edit in the
portal can never save an item the worker would have refused to write. Where
the worker *repairs* a model's output (re-keys four unkeyed options A–D,
accepts an answer by its text, drops an unknown diagram label with a note) the
portal *refuses* a human's edit with the reason — a narrower acceptance, never
a wider one:

- `item_type` known; `answer_mode` derived from it.
- `stem` required, ≤ 2000 chars, **no raw HTML** (`<` followed by a letter, `/`
  or `!` is refused; `a < b` is fine).
- `objective_ref` names an article objective; `claim_ref` (optional) a claim.
- `difficulty` 1..5; `cognitive_level` known; `marks` 1..50; `est_seconds`
  10..3600 or null.
- **mcq**: exactly 4 options **keyed A–D** (each once; the row editor shows the
  key as a fixed letter by position — `bank_worksheet` prints the raw key, so a
  stray "E" would reach paper); texts unique after trim + case-fold
  (**duplicate options refused**); `answer.key` **among the options**; a
  `why_wrong` for **every** distractor (**a distractor without one is
  refused**); a `misconception_ref`, when given, names an article misconception.
- **assertion_reason**: the mcq option and answer rules; `why_wrong` is
  **optional** per distractor (the four statements are standard) but bounded,
  with a resolving `misconception_ref` when given; no rationale ⇒ stored `null`.
- **true_false**: `answer.value` boolean (`"true"` / `"false"` coerced).
- **fill_blank**: the stem must **show its blank** (two or more underscores, an
  ellipsis `…` or three dots — the worker's `_BLANK_RE`); `answer.text`
  required (≤ 300), `answer.accept[]` optional alternatives.
- **match**: **3–8 `{left, right}` pairs**, both sides non-empty and unique
  (case-folded), read from `pairs` / `options.pairs` / `answer.pairs` and
  stored as `options {pairs}` **and** `answer {pairs}` (the worker's shape).
- **numerical**: `answer.value` a finite number; `unit` (≤ 40) and `tolerance`
  (a number, stored absolute) optional; stored `{value, unit, tolerance}`.
- **diagram_label**: a figure key (`options.figure_key`) and **2–8 labels**;
  checked against the article version's **rendered, labelled figures**
  (`article_figures` where `status = 'rendered'`, the worker's
  `labelled_figures`): the key must name one and every label must be one of its
  labels. Stored as `options {figure_key, caption}` and `answer {labels: [{n,
  label}]}`; a missing marking scheme is **derived as one mark per label** and
  `marks` follows it (the worker's rule — a derivation, not a repair).
- **short_answer / long_answer**: `answer.text` required (≤ 2000, the worker's
  `TEXT_MAX`).
- `marking_scheme` rows `{point, marks > 0}`; **required for a subjective
  item**; a non-empty scheme **adds up to `marks`**.
- `explanation` ≤ 2000, no raw HTML; ≤ 20 tags of ≤ 40 chars.

Every problem is named at once (the row editor shows them all before the
round trip). `catalogue-questions.test.ts` pins one refusal per type.

## Writing items: the `topic_questions` job

An **observer job** (`generation_id` and `book_id` NULL) with
`jobs.params {topic_id, article_id, language: "en", hints?, target?}`, one live
per (topic, language) — the friendly pre-check in the route plus 0115's
`jobs_one_live_questions` index (a 23505 is the same 409). Enqueued
automatically at kit creation and on demand from the bank page:

- **Generate questions** — default target **30 drafts**: 15 objective (8 mcq,
  3 true_false, 2 fill_blank, 1 match, 1 assertion_reason) + 15 subjective
  (8 short_answer, 3 long_answer, 2 numerical when the subject allows else
  short_answer, 2 diagram_label when the article has rendered figures with
  labels else short_answer). One **coverage top-up** retry names the
  objectives with fewer than two items. A 23505 on insert counts as a
  duplicate, not a failure. Summary in `jobs.stage`.
- **Regenerate rejected** — the same job; its hints are the rejected items'
  review notes and stems (`rejectedHints`, newest first, capped at 4000
  chars) followed by the member's own hints, so the writer avoids or fixes
  exactly what a reviewer refused.

Both need `FEATURE_CATALOGUE_GENERATE=true` (else 409) and an approved
English article (else 400). The worker's last lane runs catalogue jobs only
when no user builder is live and the quota window is open (spec decision 12).

## Review: per item, guarded, audited

| action | role | from → to | notes |
|---|---|---|---|
| **approve** `{questionIds[]}` | approve | draft → approved | reviewer id + time recorded |
| **reject** `{questionIds[], notes}` | approve | draft \| approved → rejected | notes **required** |
| **retire** `{questionIds[]}` | edit_article | draft \| approved \| rejected → retired | out of the bank; never composed |
| **save** `{questionId, item}` | edit_article | draft stays draft; **approved → draft** | validator first; hash recomputed; a 23505 = "duplicate of another item" |

Bulk actions take up to 200 ids of the topic. Every transition is a
**status-guarded UPDATE read back** (`…eq/in("status")…select("id")`): zero
rows means every id moved between the read and the write (another reviewer)
and answers 409 with nothing written or audited; a partial result reports
`approved` / `skipped`. Approving **items** is a route write — per-item review
is not a plan gate (spec decision 7; the kit's gate is the RPC). Every action
is audited on the topic as `library_questions_generate` / `question_save` /
`questions_approve` / `questions_reject` / `questions_retire`.

An approved item that is **edited** goes back to draft with a note appended
("Edited after approval … needs re-review"): a reviewer approved the words
that were there, not the new ones.

## The maturity ladder

`topics.bank_maturity` is kept by a **database trigger** (0112
`topic_questions_maturity_sync`) from the count of **approved English items**;
no route writes it. `MATURITY_LADDER` / `nextRung` mirror it so the page can
say "next rung: N more approved items":

| approved | rung |
|---|---|
| < 10 | none |
| 10 | basic |
| 20 | good |
| 30 | strong |
| 50 | assessment |
| 100 | exam_ready |

A blueprint's `min_maturity` is the **cheap pre-check** only: the ladder
counts both answer modes, so `basic` does not by itself guarantee ten
objective items for "all objective" — the composer checks per bucket.

## Blueprints (`question_set_blueprints`)

`{name (unique), scope: worksheet | paper | mock_exam, spec, min_maturity:
basic … exam_ready, status: active | retired}`, twelve presets seeded by 0112
(Remedial / Standard / Challenge × all objective / all subjective / 50-50 /
40-60). Curators (`curate`) create, edit, retire and reactivate at
`/library/blueprints`; nothing is deleted (`question_sets` reference them
`on delete restrict`). `validateBlueprintSpec`:

- `preset` ∈ remedial | standard | challenge | custom
- `objective_ratio` 0..1
- `difficulty_mix` keys `"1"`..`"5"`, non-negative weights **summing to 1
  (±0.01)**, at least one positive (zero weights are dropped)
- `count` 1..60, `total_marks` 1..200

## The composer arithmetic (portal `composePlan` / `canCompose` ↔ worker `compose`)

Deterministic, mirrored byte-for-byte in meaning, so the preset the portal
offers is one the worker will fill and the 409 names exactly the buckets the
worker would raise `Unsatisfiable` on:

1. **Modes**: split `count` between objective and subjective by
   `objective_ratio` with the **largest-remainder** method — each gets
   floor(count × share); the leftover goes to the larger fraction; a **tie
   goes to objective** (position order).
2. **Difficulties**: within each mode, split that mode's count over
   `difficulty_mix` the same way — floors, then leftovers to the largest
   fractions, **ties to the lower difficulty** (`"1"` before `"5"`); a zero
   weight never receives a leftover.
3. **Fill each bucket exactly** from the topic's approved items of that mode
   and difficulty, spreading across `objective_ref` round-robin, drawing with
   `random.Random(seed)`. A short bucket ⇒ **`Unsatisfiable`, listing every
   short bucket — never pad, never round up.**

Worked example — *Standard · 50/50* (`count 10, ratio 0.5, mix {2: .3, 3: .5,
4: .2}`): modes 5 / 5; each mode 1.5 / 2.5 / 1 → floors 1 / 2 / 1 (4), one
leftover → the earlier of the two .5 fractions, difficulty 2 → **{2: 2, 3: 2,
4: 1}** per mode. *Remedial · all objective* (`ratio 1, mix {1: .5, 2: .4,
3: .1}`): 10 / 0; objective 5 / 4 / 1 exactly.

The portal runs `canCompose(spec, modeCounts(items), {have: topic.bank_maturity,
need: blueprint.min_maturity})` for every active blueprint and greys the
option with the reasons (`"bank maturity is basic; this blueprint needs
good"`, `"objective difficulty 3: need 2, have 1"`).

## How Compose renders

`POST /api/library/topics/[id]/compose {blueprintId, seed?}` (**`generate`** —
composing inserts a `generations` row the worker builds, the action every other
catalogue generations insert asks for; editing the items is `edit_article`;
`FEATURE_CATALOGUE_GENERATE` and `CATALOGUE_OWNER_ID` — read through
`catalogueOwnerId()` — required, else 409):

1. The blueprint must be active with a valid spec; `canCompose` against the
   live approved counts must pass (else 409 with `reasons` and the `plan`).
2. A `question_sets` row is written: `{blueprint_id, topic_ids: [topic],
   language: "en", question_ids: [], seed, requested_by}` — `question_ids`
   stays empty until the worker composes.
3. **One `generations` row of kind `worksheet`** owned by the catalogue system
   account (`CATALOGUE_OWNER_ID`), `book_id` / `chapter_ref` NULL, `params
   {catalogue: true, topic_id, question_set_id, blueprint_id, seed, language,
   curriculum_header}`. `create_job_for_generation()` (0115) queues the job and
   copies the catalogue flag into `jobs.params`, so the worker's **last lane**
   takes it only when no user builder is live and the quota window is open. A
   42501 (the 0112 guard: the owner is not a platform admin) is a 409 and the
   set row is taken back out — no set ever points at nothing.
4. `question_sets.rendered_generation_id` ← the generation; audited on the
   topic as `library_compose` with the plan and the header lines.
5. The worker's catalogue branch sees `params.question_set_id`, calls
   `catalogue.composer.render_question_set(…)`, which composes (step 3 above),
   fills `question_ids`, and renders `docgen/bank_worksheet.py`: a **student
   DOCX** (curriculum header under the subtitle, page breaks between the
   objective and subjective sections, MCQ options A–D, match pairs table,
   ruled answer space sized by `est_seconds` / `marks`) and a **separate answer
   key** (answers, distractor rationale, marking scheme, explanations),
   uploaded as artifacts `docx` and `answer_key_docx` exactly like a chapter
   document. No `questions.json` for composed sets in Phase 3.

The bank page lists past sets with the generation's status (from `jobs`) and
signed one-hour links to both files, named by `docDownloadName("worksheet",
…)` — *Worksheet.docx* and *Worksheet Answer Key.docx*.

### The curriculum header (spec decision 10)

`params.curriculum_header` is a list of lines, one per curriculum the topic
maps to — `Cambridge Lower Secondary Science 0893 · 7Bs.01, 7Bs.02`, `CBSE
Science 086 · Class 9 · Cell — the basic unit of life` — composed by the portal
(`curriculumHeaderLines(mappings)` in `src/utils/catalogue/kit.ts`, the kit
route's own helper, so a composed worksheet carries the same header as the
kit's documents) and by the worker (`catalogue/kit.py curriculum_header_lines`)
for kit documents. `dx.new_doc(..., header_lines=[…])` renders it as a small
block under the subtitle.

## What the reviewer sees

A `reviewer` reads the bank, approves and rejects; Edit and Retire are hidden
(`edit_article`), and Generate, Regenerate rejected and Compose are hidden
(`generate` — they spend model calls or build capacity); the routes answer 404
to a reviewer who POSTs them anyway (`libraryAllows` per action, checked before
any client is opened). Today editor and admin hold both actions; the split is
what lets a future subject editor edit items without spending capacity.
Blueprints are `curate`. Every member sees the coverage bars (the
approved / live count per article objective — a thin objective, under two,
is what the next generate tops up), the maturity ladder, the ⚠ duplicate
warning (two non-retired items whose stems open with the same eight words,
`canonicalKey`'d) and the ◆ misconception tooltip.
