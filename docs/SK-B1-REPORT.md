# SK B1a + B1b (app side) — report

Date: 2026-10-27. Branch: `feat/sk-b1-content` (PR against `main`, not merged).
Plan: `SketchCast SK AI Tutor - Architecture and Implementation Plan 2026-10-26.md`
Revision 3, §3, §10, §15 rows B1a/B1b. Contracts: `docs/SK-CONTRACTS.md` §6.

**Nothing in this work touched production** (`pblaxsqhjwlqbrwbraxy`). Production was
only *read* (catalogue schema and the reference rows below). Everything was applied
to the Supabase branch database **`sk-b1`** (project ref `grxsibudgjgepecxbyke`),
which is left in place for the founder to inspect.

> The branch costs **$0.01344 per hour** (about $0.32/day, $9.80/month) while it
> exists. Delete it from the dashboard (or with the Supabase MCP `delete_branch`)
> once reviewed; everything on it is reproducible from this PR.

## 1. What is in the PR

| File | What |
|---|---|
| `supabase/migrations/0156_sk_book_content.sql` | `sk_book_products`, `sk_book_units`, `teaching_objectives`, `objective_curriculum_map`, `sk_book_blocks`; `topic_questions.teaching_objective_id` (plain FK, on delete set null); RLS + policies |
| `supabase/migrations/0156_sk_book_content_rollback.sql` | drops them again (repo convention) |
| `supabase/tests/0156_rls_test.sql` | RLS + gate checks in the repo's `_expect` / `_act_as` style (ran clean on the branch) |
| `tools/sk/export-lib.ts` | the exporter's pure rules (units, objective rewrite, node-code resolution, exercise → unit, stamp-vs-insert, `topic_questions` row shape, auto-markable count) |
| `tools/sk/export-chapter.ts` | the CLI: `npx tsx tools/sk/export-chapter.ts <chNN-draft.json> [--emit-sql out.sql \| --dry-run] [--topic key] [--manuscript-version v]` |
| `src/__tests__/sk-export-chapter.test.ts` | 19 vitest cases for the pure rules |
| `docs/SK-B1-REPORT.md` | this file |

Local gates on the worktree: `npx tsc --noEmit` clean, `npx eslint` clean on the new
files, `npx vitest run src/__tests__/sk-export-chapter.test.ts` 19/19.

### Schema notes (what differs from the brief's sketch, and why)

* `sk_book_units.order` is named **`sort_order`** (`order` is a reserved word).
  A second unique key `(product_id, chapter, section_sid)` pins one unit per section.
* `teaching_objectives` is **unique on `(product_id, chapter, unit_key)`** (plan §10:
  one per unit) with a composite FK to the unit, and a check that `validated`
  needs `validated_by` + `validated_at`.
* `objective_curriculum_map` has a check that **`verified`/`rejected` need
  `reviewed_by` + `reviewed_at`** — a model can only ever leave a row `proposed`.
  Unique on `(teaching_objective_id, curriculum_node_id)`. `map_confidence numeric(3,2)` in 0..1.
* `sk_book_blocks` carries `(product_id, chapter, section_sid, block_index)` unique,
  `body` = the drafted block minus `source_refs`, and `unit_key` as a nullable
  composite FK to the unit.
* Access: RLS on everywhere, `revoke all` from `anon`/`authenticated`; `authenticated`
  gets `select` on products (status `approved`), their units, and `validated`
  objectives of approved products only. The map, the blocks and `topic_questions`
  stay service-role only (questions and mark schemes are never exposed, contracts §1.2).
* No `sk_book_items` table: the exercises went to `topic_questions` (section 4).

## 2. What was applied to branch `sk-b1`, in order

1. **Branch created** 2026-10-26 19:27 UTC with the Supabase MCP (`create_branch`,
   name `sk-b1`, cost confirmed).
2. **The branch came up with an empty `public` schema** (status `MIGRATIONS_FAILED`).
   Supabase replays the migration history recorded in production's
   `supabase_migrations.schema_migrations`, and that history starts at 0068
   (`notices`, 2026-08-02): migrations 0001–0067 were never recorded, so the replay
   failed on its first statement. Pushing the repo's own 145 migration files needs a
   Supabase personal access token (Management API or `supabase db push`), which this
   session did not have. So instead:
3. **Bootstrap of the catalogue subset**, cloned from production's catalog
   (`pg_attribute`, `pg_constraint`, `pg_indexes`, `pg_get_functiondef`): `profiles`,
   `curricula`, `curriculum_nodes`, `topics`, `topic_articles`, `topic_questions`,
   the `user_role` enum, `touch_updated_at()`, `topic_bank_maturity()` and the
   `topic_questions_maturity_sync` trigger. Deliberate deviations: `profiles` has no
   `schools` FK and no policies; `topics` has no slug trigger (needs
   `catalogue_slugify` + `topic_slug_redirects`); `topic_questions.translation_kit_id`
   has no FK (no `topic_kits`). Nothing else exists on the branch. The file is in the
   session scratchpad (`branch-bootstrap.sql`), not in the repo, because it is a
   workaround, not a migration.
4. **Reference rows copied from production** (read-only selects, inserted on the
   branch with their production ids): the `cambridge_ls_science_0893` curriculum;
   its **47 Biology nodes** (3 strands, 9 sub-strands, 35 objectives; the Chemistry,
   Physics, Earth and TWS nodes — 219 rows — were not copied); the topic
   `using_a_microscope_and_calculating_magnification` (`a7556017-…`); its approved
   English article (`459c0b72-…`, objectives o1–o6 verbatim, body jsonb left empty);
   and its **31 approved English bank items** (`reviewer_id` set null). The cloned
   trigger recomputed `topics.bank_maturity = 'strong'`, matching production.
5. **Migration 0156 applied** with `apply_migration` (it is the branch's only
   recorded migration), verbatim from the repo file. Clean.
6. **Chapter 2 exported** with `npx tsx tools/sk/export-chapter.ts ch02-draft.json
   --emit-sql ch02-export.sql` and the SQL applied through the MCP in five chunks
   (the same statements; the SQL is one idempotent transaction when run as a file).
   Its final summary statement returned:

   ```json
   {"product_id":"d7a8282a-1f23-4ae8-8008-40e3ae458c13","units":6,"objectives":6,"maps":6,
    "blocks":90,"missing_codes":[],"topic_found":true,"stamped":12,"inserted":3}
   ```
7. **Verification**: every one of the 90 blocks was hashed on the branch
   (`md5` of its text / wrong / problem / caption / items / rows, and of its
   `source_refs`) and compared with the same hashes computed from
   `ch02-draft.json`: 90/90 identical, in section order and under the right unit.
   The 3 inserted items' stems hash-match the draft; the 12 stamped items carry the
   expected unit.
8. **`supabase/tests/0156_rls_test.sql` ran on the branch** and completed without
   raising (every check raises on failure; a deliberate `raise exception` probe
   confirmed that errors do surface through the connector). It rolls itself back.

## 3. Counts on the branch (chapter 2, product `cells-structure-function-organisation`)

| Table | Rows | Notes |
|---|---|---|
| `sk_book_products` | 1 | `status = 'draft'`, `curriculum_id` = 0893, `manuscript_version = ch02-draft@be9e0e1` (sha1 of the file) |
| `sk_book_units` | 6 | u1=s1 … u6=s6, titles = the plan's section headings |
| `teaching_objectives` | 6 | all `draft` |
| `objective_curriculum_map` | 6 | all `proposed`, `supports`, 0.50, `mapped_by = 'model'` (section 5) |
| `sk_book_blocks` | 90 | s1 15 · s2 16 · s3 12 · s4 18 · s5 21 · s6 8 |
| `topic_questions` with `teaching_objective_id` | 14 | 12 existing approved bank items stamped + 2 new draft book items (x11, x14) |
| `topic_questions` new draft book items | 3 | x11 → u1, x14 → u3, x15 unassigned (no source refs) |

The six units and their draft objectives (rule: the plan section's purpose rewritten
into "Students can …" form, author-facing trailing clauses cut; **no model call**):

| Unit | Section | Draft teaching objective (status `draft`) |
|---|---|---|
| u1 | s1 Too small to see: why we need a microscope | Students can explain that all organisms are made of cells, that microorganisms are typically single-celled, and that cells (measured in micrometres) are too small for the eye to see unaided, so a microscope is needed. |
| u2 | s2 Parts of a light microscope | Students can describe the names and jobs of the main parts of a light microscope and the path of light through a thin specimen to the eye. |
| u3 | s3 Using the microscope safely and focusing | Students can describe the step-by-step method for carrying, setting up and focusing, starting at low power and using only the fine focus knob at higher power. |
| u4 | s4 Making a temporary slide | Students can prepare wet mounts of onion epidermis and cheek cells, why a stain and a coverslip are used, how the two cell types look, and that the colour seen is mostly from the stain. |
| u5 | s5 Magnification and actual size | Students can describe total magnification (eyepiece × objective), magnification = image size ÷ actual size and its rearrangements, matching units (mm to µm by ×1000), resolution, and why higher magnification is not always better. |
| u6 | s6 Drawing what you see | Students can describe the rules of a scientific cell drawing (pencil lines, no shading, ruled non-crossing label lines, title, stated magnification) and how to work out the magnification of a drawing. |

These are drafts for the reviewer to edit before validating: u4 in particular is a
mechanical rewrite of a "Teach how to … , why …, how …" purpose and reads awkwardly.
The exporter never overwrites a `validated` objective on a re-run.

## 4. Exercises: which path, and the item ↔ objective link

**Path taken: `topic_questions`.** The chapter's catalogue topic exists in production
(`using_a_microscope_and_calculating_magnification`, `video_approved`, 91 items in
three languages, `depth_node = 7Bs.01`), so no `sk_book_items` table was created. On
the branch the topic and its 31 English items were seeded from production (section 2)
so that the import exercised the real path.

The decisive finding: **12 of the 15 chapter exercises were authored from existing
bank items** — their `source_item_id` is a `topic_questions.id`, and in six cases the
stem is a rewrite (x2 turns the bank's true/false item into an mcq; x4 is the bank's
coverslip fill-blank verbatim). Inserting them would duplicate approved items, so the
exporter **stamps the existing item's `teaching_objective_id`** when the item exists
and inserts a draft book copy only when it does not (`action: stamp | insert`,
unit-tested). Provenance of inserted copies is kept in `tags`
(`sk-book`, `book:<slug>`, `ch:2`, `xid:x11`, `tier:…`) and `notes` (source refs).

| xid | type | tier | unit | action | bank item |
|---|---|---|---|---|---|
| x1 | mcq | guided | u1 | stamp | a48f35f1 (mcq, o1) |
| x2 | mcq | guided | u1 | stamp | 5788dd4a (true_false, o1) |
| x3 | match | guided | u2 | stamp | 11c605d4 (match, o2) |
| x4 | fill_blank | guided | u4 | stamp | a5c8ebbe (fill_blank, o4) |
| x5 | mcq | guided | u5 | stamp | 71acf08b (mcq, o5) |
| x6 | short_answer | independent | u2 | stamp | fe1ef121 (short_answer, o2) |
| x7 | short_answer | independent | u3 | stamp | e46eba63 (short_answer, o3) |
| x8 | short_answer | independent | u3 | stamp | c121b878 (mcq, o3) |
| x9 | short_answer | independent | u5 | stamp | 1c37dd99 (numerical, o5) |
| x10 | short_answer | independent | u4 | stamp | 342866a5 (short_answer, o4) |
| x11 | short_answer | challenge | u1 | insert | — |
| x12 | short_answer | independent | u5 | stamp | 906d5688 (numerical, **o6**) |
| x13 | short_answer | challenge | u5 | stamp | 7b328956 (short_answer, o5) |
| x14 | mcq | independent | u3 | insert | — |
| x15 | short_answer | independent | — | insert, no objective | — (no source refs) |

Unit assignment follows the manuscript plan: an exercise goes to the plan section
that cites the most of its source refs (an `item:` ref outweighs claims; ties go to
the earlier section). One case to check: x12 (a 48 mm → 60 µm actual-size
calculation) sits in u5 by the plan's refs while the bank files its source item under
article objective o6 (drawing).

The article's six objectives o1–o6 line up one-to-one with the six sections
(s1 → o1 … s6 → o6). That is the cheapest route to "100% of Chapter 2 items mapped"
(B1b acceptance): stamp all 31 English bank items by `objective_ref → unit`, not only
the 12 the chapter cites. The exporter does not do this today because the brief
scoped it to the chapter's `exercises[]`; it is a one-statement follow-up once the
founder confirms the o↔s correspondence.

### Auto-markable items per unit (plan needs ≥ 3; nothing was generated)

Counting mcq, true_false, fill_blank, match, numeric/numerical. **From the chapter's
own exercises:**

| Unit | auto-markable | items | short by |
|---|---|---|---|
| u1 | 2 | x1, x2 | 1 |
| u2 | 1 | x3 | 2 |
| u3 | 1 | x14 | 2 |
| u4 | 1 | x4 | 2 |
| u5 | 1 | x5 | 2 |
| u6 | 0 | — | 3 |

Six of fifteen, consistent with plan §10's "6 auto-markable exercises out of 14".
**Counting the approved English bank by article objective** (31 items; on
production the same rows), if o1–o6 are accepted as u1–u6:

| Unit (objective) | mcq | true_false | fill_blank | match | numerical | assertion_reason | auto-markable | short by |
|---|---|---|---|---|---|---|---|---|
| u1 (o1) | 2 | 1 | – | – | – | – | 3 | 0 |
| u2 (o2) | 2 | – | 1 | 1 | – | – | 4 | 0 |
| u3 (o3) | 1 | 1 | – | – | – | 1 | 2 (3 with assertion_reason) | 1 (0) |
| u4 (o4) | 1 | – | 1 | – | – | – | 2 | 1 |
| u5 (o5) | 2 | 1 | – | – | 1 | – | 4 | 0 |
| u6 (o6) | 1 | – | – | – | 1 | – | 2 | 1 |

Note the bank stores `numerical` items as `answer_mode = 'subjective'` (with
`{value, unit, tolerance}` answers); the exporter follows the bank's convention, so
whether `numerical` counts as deterministic is a grader decision for B5. `assertion_reason`
is keyed like an mcq and is objective-mode.

## 5. The proposed objective → curriculum rows (for the founder to verify)

All six are `status = 'proposed'`, `relation = 'supports'`, `map_confidence = 0.50`,
`mapped_by = 'model'`. They were derived mechanically from the plan sections'
`node_codes` — every section of Chapter 2 cites the single code **7Bs.01**
("Understand that all organisms are made of cells and microorganisms are typically
single celled."). No code was missing from `curriculum_nodes`; none was invented.

| Unit | teaching_objective_id | map_id | node |
|---|---|---|---|
| u1 | `8d583b3b-c092-4eed-8320-58f51b6888ad` | `658edc8f-eabe-4122-a66a-71c734678bff` | 7Bs.01 |
| u2 | `96794bf7-f582-4e14-abc7-40b86e0e4b88` | `d47daca9-1e43-426b-b210-59c060481d92` | 7Bs.01 |
| u3 | `8d798fea-e468-4a74-927e-7df85e71af95` | `0920f250-d88c-4074-a3b5-fd44ab77f9fe` | 7Bs.01 |
| u4 | `d8b69af0-fe88-4275-a076-054427d7d83e` | `4e14f2ac-fff0-46ad-8381-6b910787216e` | 7Bs.01 |
| u5 | `e3eaa67d-5a4f-461a-9a7e-15e6af1e700d` | `177192ba-020b-499a-b295-2afdfe013984` | 7Bs.01 |
| u6 | `6256c5a5-5f34-4aa9-be18-48b8e123e562` | `b2b9c075-8998-447a-8889-c07c11281dd3` | 7Bs.01 |

(ids are the branch's; a production run will mint new ones.)

What the reviewer is really deciding: 7Bs.01 is the only content objective the chapter
cites, but only **u1** teaches it. u2–u6 are microscope and magnification *skills*
that Cambridge files under Thinking and Working Scientifically (the draft's
chapter-level `tws` list names 7TWSa.05, 7TWSc.02, 7TWSc.05, 7TWSm.02, 8TWSa.05).
Under the no-forced-mapping rule the honest outcome may be: u1 `covers` 7Bs.01
(verified); u2–u6 either `supports` 7Bs.01 (verified, low confidence) or **rejected**
and shown as "SketchCast topic", never as curriculum coverage. Either is a one-line
`update … set status, relation, map_confidence, reviewed_by, reviewed_at, mapped_by = 'human'`
per row; the migration's check constraint refuses a verification without a reviewer.
All five TWS codes **do exist** in production's `curriculum_nodes` (7TWSa.05 "Present
and interpret observations and measurements appropriately", 7TWSc.02 "Decide what
equipment is required … and use it", 7TWSc.05 "Carry out practical work safely",
7TWSm.02 "Use symbols and formulae to represent scientific ideas", 8TWSa.05), so a
human can add `objective_curriculum_map` rows for u2–u6 against them (`mapped_by =
'human'`). The exporter proposes nothing for them because the draft lists them at
chapter level (`tws`), not per section, and the rule never guesses a section. They
were not copied to the branch (only the Biology strand was).

## 6. What blocks B1b

1. **Human review** (the founder): edit and validate the six draft objectives; verify
   or reject the six proposed map rows. Nothing reports as curriculum coverage until then.
2. **≥ 3 auto-markable check items per unit**: the chapter's exercises fall short in
   every unit; stamping the existing bank by objective closes it for u1, u2, u5 (and u3
   if assertion_reason counts); **u4 and u6 still need one deterministic item each**
   (two for u3 if assertion_reason does not count). No items were generated.
3. **`docgen/questions.py`** (worker repo) must keep `bank_item_id` + `teaching_objective_id`
   per item in quiz files (plan §10) — not part of this app PR.
4. **Production**: applying 0156 and running the export against production are
   separate founder approvals. The CLI refuses a production URL unless
   `SK_ALLOW_PRODUCTION=1` is set. On production the run will stamp the 12 existing
   items and insert 3 draft copies; nothing else changes in `topic_questions`.
5. **Full-fidelity branch**: a branch that carries the whole app schema needs a
   Supabase personal access token (dashboard → Account → Access tokens) so a script
   can push the 145 repo migrations through the Management API; this session had none.
   The current branch is enough to inspect Chapter 2 and the five new tables.
6. **Direct mode not exercised live**: the supabase-js path of the exporter (`SUPABASE_URL`
   + `SUPABASE_SERVICE_ROLE_KEY`) shares the row-building with the SQL path and is
   type-checked, but no service-role key for the branch was obtainable through the
   MCP, so only `--emit-sql` ran against a database. First direct run should be on a
   branch.

## 7. How to reproduce

```bash
# in the app repo, on feat/sk-b1-content
npx vitest run src/__tests__/sk-export-chapter.test.ts
npx tsx tools/sk/export-chapter.ts "<…>/manuscripts/cells-structure-function-organisation/ch02-draft.json" --dry-run
npx tsx tools/sk/export-chapter.ts "<…>/ch02-draft.json" --emit-sql ch02-export.sql   # then run the file on a branch
# or, with a BRANCH service key:
SUPABASE_URL=https://grxsibudgjgepecxbyke.supabase.co SUPABASE_SERVICE_ROLE_KEY=… npx tsx tools/sk/export-chapter.ts "<…>/ch02-draft.json"
```

Re-runs are idempotent: product/units upsert, draft objectives are rewritten but
validated ones are kept, reviewed map rows are never touched, blocks are replaced for
the chapter, stamps are re-applied, inserted copies upsert on `(topic_id, language, content_hash)`.
