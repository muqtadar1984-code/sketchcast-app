# Generation surge plan — absorbing "Generate all" bursts, and operator tooling

Status: **PLAN for founder approval** · 2026-10-22 · no code, no migrations, no prod writes in this PR.

Trigger: on 2026-10-22 Sara (teacher, book "Sci 7" `c3654e41`) pressed **Generate all** at 06:48:56 UTC,
32 s after a re-index started. The part-map race itself is fixed separately (app #115 migration 0152 +
worker #312). This plan is about everything *around* it: how the system absorbs a burst, and what staff
can do when one goes wrong.

---

## 1. What actually happened (measured, read-only SQL on prod, 09:15 UTC)

### 1.1 Size of the burst

| | |
|---|---|
| Generations queued by one click (06:48:56 → 06:52:53) | **~250** (7 kinds × every part of 7 chapters, plus re-clicks) |
| Share of the last 30 days' non-catalogue generations | **246 of ~528 ≈ 47 %** (UTC hour 06 alone) |
| Jobs waiting at 06:50 | **202** (only 2 owners waiting: Sara + the auto-translate agent) |
| Worker throughput while draining | **~17 jobs finished / 10 min** (flat 06:50 → 08:50) |
| Concurrent jobs running | 7–16 |
| Time to drain | **~2 h 20 min** (06:49 → ~09:10) |

### 1.2 Where the time went (`generations.params.timings`, 229 of Sara's generations with timings)

| kind | n | queue_wait p50 | queue_wait max | work p50 | lease_wait Σ | cooldown_wait Σ | rate_limit_wait Σ |
|---|---|---|---|---|---|---|---|
| presentation (video) | 14 | **110 min** | 139 min | 12.7 min | 3.7 min | 10.8 min | 1.1 min |
| deck | 30 | 91 min | 143 min | 6.4 min | 2.2 min | 0.9 min | 0 |
| lesson_plan | 37 | 58 min | 115 min | 6.5 min | 9.9 min | 5.7 min | 0.3 min |
| worksheet | 37 | 62 min | 117 min | 4.2 min | 7.2 min | 3.7 min | 0.5 min |
| exam_paper | 37 | 61 min | 117 min | 4.7 min | 7.5 min | 5.4 min | 0.4 min |
| case_study | 37 | 61 min | 118 min | 4.5 min | 8.6 min | 2.9 min | 0 |
| activity | 37 | 62 min | 117 min | 4.7 min | 10.3 min | 4.2 min | 0.2 min |
| **all** | **229** | **68 min** | **143 min** | 5.1 min | **49.5 min** | **33.5 min** | **2.4 min** |

Rate-limit counters: 29 retries, 21 text refusals. 151/229 reused an existing analysis.

**Reading:** the first report of "8–13 min" waits understated it badly. Median wait was **over an
hour**, and the deck and video tail exceeded two. Provider back-pressure (lease + cooldown + rate-limit)
totals ~85 min across 229 jobs, i.e. **~22 s per job**. It is real, but it is **not** what made teachers
wait. The wait is **queue depth × FIFO**: 200 jobs ahead of you at ~1.7 jobs/min is an hour, whatever
the providers do. Throughput was flat at ~1.7/min for two hours. That is consistent with the
`vertex_text` lease (4 in flight, `shared/provider_gate.py`) being the binding constraint for doc
kinds, not the image ceiling. Only 14 of the 229 were videos.

> Also worth a look (not in scope): the `prelude` phase is 226–678 s on doc jobs that *reused* their
> analysis. That is most of a doc job's wall time. If prelude can be shortened, throughput rises for
> every user, not just in bursts.

### 1.3 Who else it hurt

- The only other owner waiting was the **auto-translate agent** (`9d41e12e…`). Its Spanish worksheet,
  queued 06:46:11, is **still `queued` at 09:14**. That is the batch lane yielding to users, as designed.
- **No other teacher generated between 06:48 and 09:10**, so no human was starved *this time*. Hours
  10–11 and 14–15 UTC carry 3–5 distinct users a day (30-day histogram). Had Sara clicked at 10:00, every
  one of them would have queued behind ~200 of her jobs for up to two hours. **The system has no
  defence against that today.**

### 1.4 Failures and the support agent's reaction

| failure | count | notes |
|---|---|---|
| `'Properties of materials' has 3 part(s) — part 4 does not exist` | 7 | 06:56–07:16: the original race (ch1 4→3) |
| `'Light' has 5 part(s) — part 6 does not exist` | **6** | **08:12–08:54: a *second* shrink, after the first re-index had finished** |
| Script produced no segments (video) | 3 | one with `output_tokens=0`: truncated/refused reply |
| `'list' object has no attribute 'get'` (worksheet) | 1 | worker bug, separate |

- **17 `platform_issues` + 17 `support_diagnose` jobs** for what is really **3 root causes**. Each
  diagnosis is a Sonnet-5 call, and each escalation emails staff.
- **The support agent ran `reindex_regenerate` 3 times, concurrently, on this same book at 06:58–07:13**
  (`support_agent:regenerated` ×3, each diagnosis job taking ~13 min), while ~180 of the book's jobs
  were still queued. Then 8 more were `regen_blocked_cap`. The `Light` shrink (6→5 parts) surfaced right
  after. **Likely cause:** one of those agent re-indexes re-estimated the part map under the queued jobs.
  That is the same race, triggered by our own agent. The founder should know: **the support agent
  amplified this incident.** Confirming needs the worker logs for those three diagnoses.
- **4 duplicate kits** (20 wasted generations): ch2 part 1 ×4 (06:48:57, 06:51:39, 06:51:59, 06:52:53)
  and ch5 part 1 ×2 (06:49:03, 06:50:01). These are re-clicks 1–3 min apart. The 10 s
  `reject_double_submit` window (0076) cannot see them.

### 1.5 Credits

Sara's ledger rows since 06:40 are all `billable=false` (beta/unmetered), so no money moved. Still:
187 live, 35 voided `unconsumed_on_delete` (the hand cancels), 15 voided `worker_error`. The void paths
worked. For a **paying** teacher the same click would have consumed ~210 credits in one go, against
24 / 72 / 48 a month on Pro / Pro+ / Homeschool. `enforce_fair_use` stops that at the monthly cap, and
the existing `confirm()` shows the cost. So this is mainly a beta/school-account problem, but see the
founder decision D4.

---

## 2. How the system works today (for reviewers)

- **Claim** is Python, not SQL (`worker/client.py:443-504`): `jobs where status='queued'`, optional type
  filters, `deferred_until` respected, **`order by created_at limit 1`**, then an optimistic
  `update … where status='queued'`. **Pure FIFO within a lane; no per-owner fairness, no SKIP LOCKED.**
- **Lanes** (`worker/run.py` `run_once`), in order: tutor sketches → `support_diagnose`/`issue_resolve` →
  `DOC_JOB_TYPES` → other user builders (videos capped by `MAX_VIDEO_JOBS`=4) → catalogue observers →
  catalogue kits (off-peak only, and only with no live user builder).
- **Concurrency:** `WORKER_CONCURRENCY` threads. Provider leases are per provider: `vertex_image` 3 in
  flight, 4/min, 30 s cooldown; `vertex_text` 4 in flight, 20 s cooldown. Lease TTL 180 s.
- **Generate all** (`src/app/dashboard/generate-all-button.tsx`): a native `confirm()` with kit count +
  cost, then **one `generations.insert` per part, sequentially**, 7 rows each (6 billable, the deck
  free). A trigger creates one job per row. **No cap on queued jobs.**
- **Cancel** (✕, `delete-lesson.tsx` → `delete_my_generation`): deletes the generation row. Credit is
  voided by `credit_ledger_void_unconsumed` unless an artifact exists. **There is no cancel for
  `processing`.** The worker has no cancellation check; a delete mid-render only fails later on the FK.
- **Teacher's view of waiting:** `etaLabel` shows only once `processing`. **A queued item shows no
  position and no ETA.** Sara saw ~250 "queued" chips for up to 2 h with no explanation.
- **Support auto-trigger** (`worker/run.py:471-530`) dedupes on `generation_id` only.
- **Autofix:** `autofix-panel.tsx` shows "Attempt auto-fix" for every category. `/api/autofix/dispatch`
  returns 400 for `generation_failed`, `wrong_chapter`, `poor_quality`, `missing_parts`
  (`src/utils/autofix/scope.ts:15-20`).

---

## 3. Part 1 — absorbing a sudden load

### 3.1 Options weighed

| option | what it fixes | cost / risk | verdict |
|---|---|---|---|
| **A. Fair-share claim** (round-robin across owners) | One user can no longer starve others. A second teacher's single kit starts within ~1 job-slot instead of after 200. | Moves claim into a SQL RPC (also gets SKIP LOCKED, fixing the optimistic-claim race). Touches the hottest path in the worker, so it needs careful tests. | **Do it. Core fix.** |
| **B. Per-owner in-flight cap** (e.g. ≤ 3 processing, ≤ 1 video per owner) | Stops one user occupying every thread and every lease. Leaves headroom for the next arrival. | Trivial inside the same RPC. On a quiet system it slightly slows a lone big batch (threads idle while one owner is capped). Mitigate with "cap applies only when another owner is waiting". | **Do it, with the work-conserving rule.** |
| C. Per-user/per-book **queued** cap (reject above N) | Bounds queue depth. | Bad UX: Generate all half-fails, and the teacher must come back to click again. A+B already make depth harmless to others. | **Not as a hard reject.** Soft version only: see D. |
| **D. Staged Generate all** (queue chapter by chapter as earlier ones finish) | Teacher can cancel/redirect cheaply. A re-index can't orphan 250 jobs. Duplicates surface early. | Needs a "batch" record + a release step (worker or trigger). Credits: reserve at click or at release? (Founder decision D2.) | **Phase 3, after A+B prove out.** With A+B it is a nicety, not a necessity. |
| **E. Confirm-cost step with queue time** | Sets expectations before 250 jobs exist. Doubles as the duplicate check ("ch2 part 1 already has a kit, skip?"). | Small app change; the ETA estimate must be honest (measured throughput, not hope). | **Do it. Cheap, high trust value.** |
| F. Priority lanes (e.g. "single kit" > "bulk") | Similar effect to A for the common case. | A is strictly fairer and needs no classification. Lanes already exist for tutor/support/docs/catalogue; add no more. | **Not separately; A subsumes it.** Keep the existing lanes. |
| G. Autoscale worker threads | Helps only if threads are the constraint. | Measured: they are not. Throughput was flat at 1.7/min with 7–16 running. The binding constraint is consistent with the `vertex_text` lease (4) and per-job prelude time. More threads just queue on the lease. The Vertex image ceiling (~1/min/pool) caps videos regardless. | **No for now.** Instead: (i) measure whether the text quota allows raising `vertex_text` in-flight from 4; (ii) investigate `prelude`. Revisit after the Bedrock text cut-over (separate pool). |
| **H. What the teacher sees** | Hours of silent "queued" become "position 37, est. 08:40, part of your Generate-all batch". | App-only; reads `jobs`. | **Do it.** |

### 3.2 Recommendation

**A + B + E + H now; D later; no autoscaling; no hard caps.**

1. **`claim_next_job` becomes a SQL RPC** (security definer, service role only) that, within the existing
   lane filters:
   - excludes owners/books under an operator **hold** (Part 2, §4.3);
   - excludes owners already at their **in-flight cap** *when another owner has queued work*
     (work-conserving: a lone user still gets every slot);
   - orders by **`(owner's processing count) asc, (owner's oldest queued created_at) asc, created_at asc`**,
     i.e. round-robin by owner, oldest-first inside an owner;
   - claims with `for update skip locked`.

   The Python lanes stay as they are: each lane calls the RPC with its type filter. Catalogue claim RPCs
   (0126) are untouched.
   Proposed starting caps: **3 processing per owner, 1 video per owner**. Tune from the console view.

   *Sara's case replayed:* a second teacher clicking at 06:55 would wait for one doc slot (~5 min), not
   ~200 jobs (~2 h). Sara's own batch finishes at the same time ±, because total work is unchanged.

2. **Generate-all confirm dialog** (replaces the native `confirm()`):
   - "**N kits · M credits · about X h to finish** (Y jobs ahead of you)". X comes from a 7-day measured
     jobs/min per kind, not a constant.
   - **Skips units that already have a non-error kit** (default on), naming them. This kills the 4
     duplicate kits seen today without touching the 10 s guard.
   - Disabled while `index_book` is in flight (0152 enforces it server-side; the UI should say so).

3. **Queued items show position and ETA** (`job-stage.ts`): "Queued · 37th in line · ~40 min". A
   book-level banner during a batch: "Generate all: 42 / 250 done · est. finish 09:10 · [Pause] [Cancel
   remaining]". Pause/cancel use the same server actions as the console (§4), scoped to the caller's own
   rows.

4. **Later (Phase 3): staged release.** A `generation_batches` row per click. Units are inserted
   **held** (`params.deferred_until = 'infinity'` or a batch hold) and released a chapter at a time when
   the previous chapter's jobs leave `queued`. Only worth building if A+B data shows teachers still hurt
   (e.g. re-index during a batch keeps happening, or credit-reserve semantics need it).

### 3.3 What stays as is

- Live users outrank batch (catalogue lanes unchanged; the translate agent kept yielding today, correctly).
- The provider gate and image ceiling: fair-share decides *who* gets the next lease, not how many leases exist.

---

## 4. Part 2 — operator tooling (console)

New page **`/console/queue`** plus a **Queue** tab on `/console/users/[id]` and on the book. Actions go
through the existing `POST /api/console/ops` `action` switch, which is staff-gated by
`isPlatformAdminRequest()` and audits every action to `platform_audit_log`.

### 4.1 See the live queue

- **Global strip:** queued / processing by lane, owners waiting, oldest queued age, jobs/min (last 30 min),
  provider back-pressure (Σ lease/cooldown/rate-limit wait, last 30 min). This replaces the hand SQL in
  `sketchcast-never-starve-production`.
- **Per owner (sorted by queued desc):** queued, processing, error (last 2 h), oldest queued, est. drain
  time, holds. Click through to the per-book list.
- **Per book:** units × kinds grid (queued / processing / done / error), with **duplicates highlighted**
  (same owner+book+chapter_ref+part+kind with >1 non-error row) and **orphans highlighted** (part >
  stored part count; uses the same predicate as 0152's guard).

### 4.2 Cancel (with refunds)

- **Cancel queued** (selection, per book, or per owner): calls the *existing* delete path, so
  `credit_ledger_void_unconsumed` refunds exactly as the teacher's ✕ does today. One RPC
  `staff_cancel_generations(ids[], reason)` locks jobs `for update skip locked`, deletes only rows
  still `queued`, and audits `{ids, refunded_count, reason}`. A preview shows the count + refund before
  confirm. This is what was hand-written today.
- **Stop processing safely** (new):
  - add `jobs.cancel_requested_at`;
  - the worker checks it at stage boundaries (it already renews leases every 45 s and records phases;
    hook the same points) and aborts cleanly: releases leases, marks the job `cancelled` (new status),
    and the generation `error` with `error='cancelled by staff'`;
  - `credit_ledger_sync` voids with reason `staff_cancel` (new; it must never be un-voided by the 0088
    path);
  - teacher sees "Cancelled by SketchCast support". A teacher-facing ✕ on `processing` can reuse this later.

  **Never delete a processing row** (today's FK-failure path wastes the render slot and leaves no record).
- **Merge-day rule stays:** a worker merge restarts in-flight renders. The console shows "N renders in
  flight" next to any deploy guidance.

### 4.3 Pause / resume

- Table `queue_holds(id, scope 'owner'|'book', target_id, until, reason, created_by, created_at,
  released_at)`. The claim RPC (§3.2) skips held targets. Resume = set `released_at`. `until` gives
  auto-expiry (default 24 h) so a forgotten hold can't silently strand a teacher.
- Teacher's UI shows "Paused by SketchCast support" on held items, so a hold never looks like a hang.
- Use cases: pause a doomed batch while you decide; pause during a re-index; pause one user to let a
  school demo through.

### 4.4 Spot duplicates

- The per-book grid (§4.1) plus a **"Cancel duplicates (keep oldest non-error)"** action, routed
  through §4.2 so refunds are uniform.
- Generate-all skip-existing (§3.2) prevents most of them at source.

### 4.5 Support agent: burst dedupe

Today: 17 issues + 17 Sonnet diagnoses + up to 17 staff emails for 3 root causes, plus 3 concurrent
agent re-indexes on a busy book.

1. **Signature dedupe** in `_auto_file_support_issue`: `signature = (owner_id, book_id,
   normalize(error))`, where normalize strips ids, numbers and part indices ("'X' has N part(s) — part M
   does not exist" → one signature per chapter). If an unresolved auto issue with that signature exists
   within 2 h, **attach** the new generation to it (`context.related_generation_ids[]`, a count) and
   enqueue **no** new diagnosis. One issue, one diagnosis, one email, plus a counter: "+12 more like this".
2. **Burst escalation:** ≥ 5 failures from one owner within 15 min → one "burst" issue to staff with
   the signature table and a deep link to `/console/queue?owner=…`. Do not run per-generation diagnoses.
3. **No `reindex_regenerate` while the book has queued/processing jobs or a hold.** The agent must
   escalate instead ("book busy"). Re-indexing under a live queue is exactly the race 0152 guards for
   users; the agent should respect it too. If 0152's guard covers service-role re-index paths, this
   becomes defence in depth; verify when 0152 lands.
4. **Regeneration concurrency:** at most one agent re-index per book at a time (advisory lock on book id).

### 4.6 Autofix button

Hide "Attempt auto-fix" when `workerScopeRefusal(issue.category)` is true. Show instead: "Worker issue:
autofix covers the web app only. Fix in `sketchcast-ai`." Same helper on both sides, so the panel and
`/api/autofix/dispatch` can never disagree again. ~10 lines; can ship in Phase 1.

---

## 5. Phased build order

| phase | scope | repo | deploy risk |
|---|---|---|---|
| **0 — now, no build** | Runbook: the read-only queue SQL from §1, cancel via the existing delete path (as done today), never re-index a book with a live queue. Apply 0152 / merge #312 once Sara's queue is empty (already planned). | — | none |
| **1 — visibility (app only)** | `/console/queue` read-only views (§4.1); autofix button fix (§4.6); teacher queue position/ETA (§3.2.3, read-only part). | app | low: Vercel only, no worker restart |
| **2 — control + fairness** | Migration: `queue_holds`, `jobs.cancel_requested_at`, `cancelled` status, `staff_cancel_generations`, `claim_next_job` RPC with fair-share + caps. Worker: switch lanes to the RPC, cancellation checks, `staff_cancel` void reason. Console actions (§4.2–4.4). Teacher pause/cancel-remaining. | app + worker | **medium**: touches the claim path. Ship the RPC dark behind `FAIR_CLAIM=1`; merge only with an empty queue, off-peak 20:00–05:00 UTC. |
| **3 — support agent** | Signature dedupe, burst escalation, busy-book re-index refusal, per-book advisory lock (§4.5). | worker | low–medium |
| **4 — smarter Generate all** | New confirm dialog with ETA + skip-existing (§3.2.2). Then, only if data says so, staged release (§3.2.4). | app (+ worker for staging) | low / medium |

Phase 3 is independent of 2 and can go first if the support-agent noise is the more urgent pain.

**Acceptance per phase:**
- **Phase 2:** replay a 250-job burst on a test owner and enqueue 1 kit as a second owner. The second
  owner's job starts in < 10 min. A staff cancel of a processing video stops it within one stage, and the
  credit is voided `staff_cancel`. A held owner's jobs are never claimed.
- **Phase 3:** 13 identical part-map failures → 1 issue, 1 diagnosis, 1 email.

---

## 6. Risks

- **Claim RPC regression** stalls *all* generation. Mitigations: feature flag, keep the Python path
  for one release, a test suite on lane filters + deferral + catalogue exclusion, merge only off-peak
  with an empty queue.
- **Work-conserving cap bugs** could idle threads with work waiting. Alert: "queued > 0 and processing
  = 0 for 2 min".
- **Cancellation mid-stage** may leave partial artifacts (uploaded audio, frames). The abort must clean
  up or mark them, and `credit_ledger_void_unconsumed`'s "artifact exists" rule must not then refuse the
  refund. Use the explicit `staff_cancel` reason, not the delete trigger.
- **ETA honesty:** an estimate from 7-day throughput is wrong during a burst. Show a range, and state
  "estimate".
- **Signature dedupe can over-merge** two different bugs with similar text. Keep the raw error per
  related generation, and let staff "split".
- **Holds can strand a teacher** if forgotten. Default expiry, plus holds listed on the console home.

---

## 7. Founder decisions needed

- **D1. Caps.** Per-owner in-flight cap (proposed 3, of which 1 video), applied only when others are
  waiting. Should school accounts (several teachers, one school) share one fair-share bucket or one per
  teacher? *Recommendation: per teacher.*
- **D2. Generate all stays one-shot** (queue everything, fair-share protects others) **or becomes staged**
  (chapter-by-chapter)? *Recommendation: one-shot now, revisit after Phase 2 data.* If staged: are
  credits reserved at click or at release?
- **D3. Teacher self-serve "Pause / Cancel remaining"** on a batch, or staff-only at first?
  *Recommendation: teacher self-serve for their own rows. It is the same action as ✕, in bulk.*
- **D4. Bulk on unmetered/beta accounts:** Sara's ~250 jobs were `billable=false`. Should beta and
  school accounts get a soft daily ceiling (e.g. "more than 100 kits today needs a staff OK")?
- **D5. Support agent's authority:** may it ever re-index a book on its own? *Recommendation: only
  when the book has no live jobs, and at most once per book per day. Today's evidence says it
  amplified the incident.*
- **D6. Raise `vertex_text` in-flight above 4?** Needs a quota check on the Vertex project (and, after
  the Bedrock cut-over, which pool doc kinds use). This is the only "more capacity" lever the data
  supports.

---

## Appendix — queries used (read-only)

```sql
-- per-kind timings for one owner since a time
select kind, count(*),
  percentile_cont(0.5) within group (order by (params->'timings'->'phases'->>'queue_wait')::numeric)/60 qw_p50_min,
  sum(coalesce((params->'timings'->'phases'->>'lease_wait')::numeric,0))/60 lease_min,
  sum(coalesce((params->'timings'->'phases'->>'cooldown_wait')::numeric,0))/60 cooldown_min,
  sum(coalesce((params->'timings'->'phases'->>'rate_limit_wait')::numeric,0))/60 rl_min
from generations
where owner_id = :owner and created_at >= :since and params ? 'timings'
group by rollup(kind);

-- duplicates for a book
select kind, chapter_ref, params->>'part' part, count(*)
from generations where book_id = :book and status <> 'error'
group by 1,2,3 having count(*) > 1;

-- queue depth / owners waiting at a moment
select count(*), count(distinct g.owner_id)
from jobs j left join generations g on g.id = j.generation_id
where j.created_at <= :t and coalesce(j.claimed_at, 'infinity') > :t;
```

Note: deleted (cancelled) generations cascade their jobs away, so historic queue-depth numbers
undercount by the 17 hand-cancelled rows.
