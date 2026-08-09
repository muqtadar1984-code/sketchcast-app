-- 0078 — Stop charging for a lesson that was deleted before anything ran.
--
-- THE INCIDENT. A teacher queued a 6-piece kit at 2026-08-09 01:43:10.296552+00.
-- All six generations inserted in one statement, `credit_ledger_write` (0059)
-- wrote six ledger rows, and six jobs were queued. About a minute later she
-- deleted the presentation — before the worker had claimed its job. The job
-- cascaded away with the generation (`jobs_generation_id_fkey` is ON DELETE
-- CASCADE). The ledger row did not: it has deliberately NO foreign key
-- (0059_lesson_credits.sql:42). She was charged a credit for a video that was
-- never rendered. Her five sibling documents from the same statement all
-- survive, `status='done'`, each with artifacts and a `done` job carrying
-- usage — so the presentation is provably the only piece that never ran.
--
-- WHAT IS NOT WRONG HERE. 0059's delete-proofing is correct and stays. A user
-- who generates a kit, uses it, and then deletes it to free quota MUST still be
-- charged; that is the whole reason the ledger outlives the generations row,
-- and it is the same lesson 0046 taught for books and 0057 for the trial pin.
-- The only thing being fixed is the case where NOTHING was consumed.
--
-- The gap is that 0059 has exactly one voiding path — `credit_ledger_sync`,
-- which fires on status → 'error' (0059:102-104). That is an UPDATE trigger. A
-- DELETE is not an UPDATE, and prod `pg_trigger` on public.generations carries
-- no DELETE trigger at all, so a delete has never been able to refund anything.
--
-- MEASURED BLAST RADIUS (prod pblaxsqhjwlqbrwbraxy, read live, not estimated):
-- 68 ledger rows whose generation_id no longer resolves, across 3 users; 56 of
-- them non-voided, 63 units. Of 185 ledger rows ever written, ~27% now point at
-- nothing. Live financial impact today is one unit for one user — Sara's and
-- Muqtadar's orphans are all July, outside `promo_credit_from()` (2026-08-07
-- 13:00+00) and outside date_trunc('month', now()), so they count on no tier.
--
-- NOTE ON `credit_ledger.billable`: it is a DEAD column from the 0061
-- experiment that was reverted per the founder (0061_revision_papers.sql:22).
-- Nothing reads it — `fair_use_used` (0075:65-68), `enforce_fair_use` and
-- `my_fair_use` all key on `not voided`. This migration neither reads nor
-- writes it. Dropping it is a separate change, after grepping console and
-- analytics for a `select *` that destructures positionally.
--
-- DELIBERATELY NOT INCLUDED: the diagnosis offered an optional guard inside
-- `delete_my_generation` that raises when the job is already `processing`. It
-- is a founder call (it removes the user's only escape from a running job) and
-- the money is handled either way by the trigger below, so it is left out. The
-- UI blocks that case instead (src/app/dashboard/delete-lesson.tsx).
--
-- Idempotent. Requires 0059 and 0041 (jobs.attempts).

-- ── 1. Why a row was voided ──────────────────────────────────────────────────
-- `voided` is about to carry two distinct meanings: "the worker failed us" and
-- "nothing ever ran". They have different accounting and different support
-- answers, and once merged they cannot be separated retroactively — which is
-- exactly what made the 68 orphans undiagnosable in the first place.
alter table public.credit_ledger add column if not exists void_reason text;
comment on column public.credit_ledger.void_reason is
  'Why this row was refunded: worker_error (0059 credit_ledger_sync) or unconsumed_on_delete (0078). NULL on live rows.';

-- Every row voided before this migration was voided by exactly one code path:
-- credit_ledger_sync on status → 'error'. Label them so the two causes stay
-- distinguishable from here on. Runs BEFORE the §4 backfill so the one ghost
-- row below is not swept into 'worker_error'.
update public.credit_ledger
   set void_reason = 'worker_error'
 where voided and void_reason is null;

-- Keep the 0059 error path labelled going forward, otherwise every future
-- worker-error void lands with a NULL reason and the column stops meaning
-- anything within a week. Body is 0059:92-106 verbatim plus `void_reason`.
create or replace function public.credit_ledger_sync() returns trigger
  language plpgsql security definer set search_path = public as
$$
begin
  if new.kind = 'presentation'
     and (new.params->>'video_parts') is distinct from (old.params->>'video_parts') then
    update credit_ledger
       set units = greatest(coalesce((new.params->>'video_parts')::int, 1), 1)
     where generation_id = new.id and not voided;
  end if;
  if new.status = 'error' and new.status is distinct from old.status then
    update credit_ledger set voided = true, void_reason = 'worker_error'
     where generation_id = new.id;
  end if;
  return null;
end $$;

-- Rebind explicitly. `create or replace function` keeps the existing trigger
-- pointed at the same OID *if* 0059 created it in `public` — it did — but if it
-- had landed anywhere else the replace above would have made a second function
-- and worker-error voids would go on writing NULL reasons with nothing to show
-- for it. Re-issuing 0059:107-109 verbatim removes the assumption.
drop trigger if exists credit_ledger_sync on public.generations;
create trigger credit_ledger_sync after update of params, status on public.generations
  for each row execute function public.credit_ledger_sync();

-- ── 2. Void a credit when the job provably never ran ─────────────────────────
-- WHY **BEFORE** DELETE, not AFTER. The evidence this rule depends on — the
-- jobs row and the artifacts rows — is destroyed by the same statement that
-- creates the ghost, because both FKs are ON DELETE CASCADE. Those cascades are
-- implemented as internal RI AFTER-row triggers (RI_ConstraintTrigger_a_*), and
-- user AFTER triggers fire in NAME order against them: relying on that ordering
-- is a collation-dependent coin flip. At BEFORE DELETE time the jobs and
-- artifacts rows are guaranteed to still be there.
--
-- WHY `FOR UPDATE` ON THE JOB ROW. It closes the live race with the worker's
-- claim (worker/client.py:47-53 — an atomic CAS `update … set status =
-- 'processing' … where id = ? and status = 'queued'`). If the worker's claim
-- commits first, this trigger reads 'processing' and declines to void. If this
-- trigger locks first, the worker's claim blocks on the row, then matches zero
-- rows after the cascade and returns None. Either way nobody is charged for
-- compute that did not happen, and nobody escapes a charge for compute that
-- did. Cost: a user's delete can now block behind a claim for the duration of
-- that statement (milliseconds), which is new contention on a path that
-- previously took no lock at all.
--
-- WHY EACH CLAUSE. Every one is independently conservative:
--   · status = 'queued'  — the job was never claimed.
--   · attempts = 0       — defeats the requeue reaper (worker/client.py:110-112
--                          resets a stale job to 'queued', progress 0, and
--                          bumps attempts). A job that already burned compute
--                          can be sitting in 'queued' with progress 0, so
--                          status alone is NOT sufficient.
--   · progress = 0       — defeats a partial claim.
--   · no artifacts       — defeats both; anything written is proof of work.
--
-- WHY NOT `jobs.usage`. Of 138 completed production jobs, 124 carry usage and
-- 14 do not (presentation 20/25, worksheet 18/21, index_book 15/20). A
-- usage-based rule would refund real work about 10% of the time. `jobs.stage`
-- is likewise unusable: NULL on all 159 prod rows (the 0053 column was never
-- populated).
--
-- MISSING JOB ⇒ DO NOT VOID. A generation with no job row provably could not
-- have run, and it stays charged anyway. That is deliberate: a missing job is
-- equally consistent with "it ran and something cleaned up after it". The fix
-- is conservative in the direction of charging, which is 0059's default.
--
-- SECURITY DEFINER because credit_ledger does `revoke all … from anon,
-- authenticated` (0059:54) — the deleting user cannot write it directly.
--
-- KNOWN BEHAVIOUR CHANGE, flagged rather than discovered later: the free-doc
-- bound in enforce_fair_use (3 per unit/kind/month) counts `not cl.voided`
-- ledger rows (0075:206-212), so voiding here hands that attempt back. Nothing
-- was generated, so this is arguably correct — but it IS a relaxation of a
-- limit 0059 hardened specifically against insert-then-delete, and it should be
-- a decision rather than a side effect.
create or replace function public.credit_ledger_void_unconsumed() returns trigger
  language plpgsql security definer set search_path = public as
$$
begin
  -- A generation that ever left 'queued' has been through the worker. Cheap
  -- exit that also keeps the lock below off the common delete path.
  if old.status::text <> 'queued' then
    return old;
  end if;

  -- Lock this generation's job row(s) — normally exactly one; nothing in the
  -- schema enforces that, so lock the set. PERFORM sets FOUND, giving us the
  -- "no job ⇒ decline" case directly.
  perform 1 from jobs j where j.generation_id = old.id for update;
  if not found then
    return old;
  end if;

  -- Any job row that has been touched at all disqualifies the whole generation.
  if exists (
    select 1 from jobs j
    where j.generation_id = old.id
      and (j.status::text <> 'queued' or j.progress <> 0 or j.attempts <> 0)
  ) then
    return old;
  end if;

  -- Anything written is proof the worker got somewhere.
  if exists (select 1 from artifacts a where a.generation_id = old.id) then
    return old;
  end if;

  update credit_ledger
     set voided = true, void_reason = 'unconsumed_on_delete'
   where generation_id = old.id and not voided;

  return old;
end $$;

drop trigger if exists credit_ledger_void_unconsumed on public.generations;
create trigger credit_ledger_void_unconsumed
  before delete on public.generations
  for each row execute function public.credit_ledger_void_unconsumed();

-- ── 3. Backfill: exactly one row ─────────────────────────────────────────────
-- Hadil MESLEM's part-2 presentation. kind 'presentation', units 1, part 2,
-- book 5bd0d381-ab34-4b67-aa7e-a527126b9f9f, chapter 1, created
-- 2026-08-09 01:43:10.296552+00, generation 3276f74c-9b12-44af-acd5-d42e358a641b.
--
-- This is the ONLY orphan in the entire population of 68 whose non-consumption
-- is provable from surviving data: its five same-statement siblings (identical
-- insert timestamp — lesson_plan ad7d75f3…, activity a48c94d7…, worksheet
-- 5a49b331…, exam_paper 64e07eea…, case_study da0835ef…) are all alive,
-- 'done', with artifacts and a done job carrying usage. The presentation alone
-- is missing from a batch that otherwise completed. It is also the only orphan
-- inside a live counting window: it takes Hadil from 18/24 to 17/24 in the
-- promo window. Guarded on the id so re-running is a no-op.
update public.credit_ledger
   set voided = true, void_reason = 'unconsumed_on_delete'
 where id = '3034d1e4-297f-41a4-978a-522394d21671'
   and not voided;

-- THE OTHER 55 NON-VOIDED ORPHANS STAY STANDING (Sara 30, Muqtadar 25). Not
-- because they were certainly consumed, but because it cannot be shown that
-- they were not, and 0059's default is to charge. Every one of them belongs to
-- a batch that was deleted in its ENTIRETY — zero same-batch siblings survive
-- for any of the 55 — which is the signature of "generated a kit, used it,
-- cleaned up the library", precisely the behaviour 0059 was written to charge
-- for. Their jobs, artifacts, artifact_views, submissions, student_progress and
-- generation_shares all cascaded away; platform_issues.generation_id was nulled
-- rather than kept; platform_audit_log records no generation-delete action; and
-- storage.objects holds nothing under their {book_id}/{generation_id}/ prefixes
-- — which proves nothing, because delete_my_generation hands the client the
-- unreferenced paths and the client removes them, so a fully-consumed
-- generation leaves exactly the same empty prefix. Voiding them would be
-- guessing in the user's favour with no evidence, on rows that cost nobody
-- anything today (both users' orphans fall outside every counting window).
--
-- `units > 1` on a presentation is NOT usable as proof that credit_ledger_sync
-- ran: since 0061, credit_ledger_write seeds units from the book's chapter
-- part-map at INSERT time, so units > 1 is equally consistent with never having
-- run at all.
