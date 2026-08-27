-- 0095 — A cancel is a cancel: refund the credit when a generation delivered
--        nothing, whatever the job had already started doing.
--
-- THE BUG, measured on prod 2026-08-25. A trial teacher generated a six-artifact
-- kit and received FIVE. The sixth — the presentation, the narrated video, which
-- is the flagship of the kit — had its generation row deleted, and its
-- credit_ledger row is still there, charged and unvoided. Their six trial
-- credits bought five artifacts.
--
-- WHY THE REFUND DID NOT FIRE. credit_ledger_void_unconsumed refused because the
-- job's progress was no longer 0:
--
--     if exists (select 1 from jobs j where j.generation_id = old.id
--                and (j.status <> 'queued' or j.progress <> 0 or j.attempts <> 0))
--     then return old; end if;
--
-- claim_next_job sets progress = 1 the instant the worker picks a job up. So the
-- refund window was only the seconds between INSERT and claim. After that,
-- cancelling cost the credit and returned nothing.
--
-- The teacher was actively invited into that trap. generations.status was written
-- only by finish_job, and only ever to 'done'/'error' — so a row read 'queued'
-- for its whole build, and delete-lesson.tsx shows a CANCEL confirmation for a
-- 'queued' row (it is inert for 'processing', a guard that could never fire
-- because nothing wrote that word). The victim is nearly always the presentation:
-- documents finish in seconds, a video render takes minutes, so it is the one
-- that looks stuck. Two teachers hit it, one of them the founder.
--
-- The worker half of the fix ships alongside this (sketchcast repo,
-- worker/client.py mirror_generation_status): claim writes 'processing', a
-- requeue writes back 'queued', and a poison-pill auto-fail writes 'error' —
-- which also lets credit_ledger_sync void a credit that used to be kept forever
-- by a job that died three times.
--
-- WHAT CHANGES HERE. The test stops being "did the work start?" and becomes "did
-- the teacher get anything?". Artifacts are the only honest answer to that, and
-- they are still present at BEFORE DELETE (artifacts cascade AFTER). Deleting a
-- finished lesson still spends the credit — files were delivered, and deleting a
-- book you generated from has always been a spend, not a refund.
--
-- The jobs lock is kept: it serialises against a worker mid-upload so we cannot
-- read "no artifacts" a moment before it writes one. Its ABSENCE no longer blocks
-- the refund, though — a generation with no job and no artifacts plainly
-- delivered nothing, and the old code returned without voting in exactly that case.

create or replace function public.credit_ledger_void_unconsumed()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- Serialise with the worker (no-op when the job is already gone).
  perform 1 from jobs j where j.generation_id = old.id for update;

  -- Anything delivered? Then the credit is spent, however the row got here.
  if exists (select 1 from artifacts a where a.generation_id = old.id) then
    return old;
  end if;

  update credit_ledger
     set voided = true,
         void_reason = 'unconsumed_on_delete'
   where generation_id = old.id
     and not voided;

  return old;
end
$function$;

-- ── Make the two teachers whole ──────────────────────────────────────────────
-- Scoped to the exact signature of this bug and nothing else: the credit was
-- charged, never voided, its generation is GONE (so no artifact can ever be
-- delivered for it), and the BOOK IS STILL THERE — which is what separates "a
-- single lesson was cancelled" from "a whole book was deleted after being
-- generated from", where the charge is correct and must stand.
--
-- Two rows, both presentations: a trial teacher on 08-24 and the founder's own
-- account on 08-13. Unlike 0089 this backfill only ever moves credits BACK to
-- the user, so it cannot recharge a closed month.
update credit_ledger cl
   set voided = true,
       void_reason = 'refund_0095_cancelled_midrender'
 where not cl.voided
   and cl.generation_id is not null
   and not exists (select 1 from generations g where g.id = cl.generation_id)
   and exists (select 1 from books b where b.id = cl.book_id and b.removed_at is null);
