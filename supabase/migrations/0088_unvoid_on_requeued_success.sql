-- 0088 — Re-charge the credit when an errored generation is requeued to success.
--
-- THE INCIDENT (verified in prod 2026-08-18, muthudpsbn@gmail.com). Five
-- document generations of a six-piece kit errored; credit_ledger_sync voided
-- their ledger rows — correct, a genuine failure must not burn credits (0059).
-- The jobs were then requeued and every one ran to 'done'. Nothing un-voids a
-- row, so all five stayed voided and the full six-piece kit consumed exactly
-- ONE trial credit. Today the damage is bounded by the trial pin (0057) and
-- the 3/month regen limits, but the same hole undercharges requeued-to-success
-- work on EVERY tier — including purchase-funded rows, where the error void
-- silently restores the paid balance while the artifacts still get delivered.
--
-- THE GAP. Ledger reaction to status is owned by credit_ledger_sync (0059,
-- labelled by 0078): status → 'error' voids with void_reason='worker_error'.
-- The reverse transition has no handler. The worker's finish_job
-- (worker/client.py:201-208) lands success with a plain
-- `update generations set status='done'`, so the trigger already SEES the
-- transition — it just does nothing with it. The fix therefore lives entirely
-- in this trigger: no worker change, and every requeue path (startup reaper,
-- console lever, manual SQL) is covered, because they all converge on that
-- one status write.
--
-- THE RULE. On transition to 'done', un-void the generation's error-path
-- rows. Deliberately NOT on the error → queued/processing legs: credits are
-- charged on delivery, so a retry that fails again must never have shown a
-- charge in between — the refund holds until the work actually lands.
--
-- SCOPE. Only error-path voids are resurrected: void_reason='worker_error'
-- (the 0059/0078 error transition) or NULL (a row voided at INSERT because
-- its generation was born 'error' — credit_ledger_write stamps that void with
-- no reason). 0078's 'unconsumed_on_delete' voids are excluded by predicate:
-- their generations row is already gone so this trigger can never fire for
-- them, but the explicit guard keeps that true even if the firing condition
-- is ever loosened.
--
-- UNITS RESYNC. 0059's video_parts sync clause skips voided rows (`and not
-- voided`), so a presentation whose successful re-run wrote a new part count
-- carries stale units at un-void time. The un-void re-reads new.params so the
-- re-charge is for what was actually delivered — but ONLY when the key is
-- present. The worker writes video_parts solely for multi-part chapter-level
-- lessons (worker/process.py:921, gated n_parts > 1); on a single-part render
-- the key never appears and the primary path keeps the part-map units seeded
-- at insert (0086). An unconditional resync would recharge that same
-- generation at 1 instead, making a requeued success CHEAPER than a
-- first-try success. Keyed on `new.params ? 'video_parts'`, both paths agree.
--
-- POOLS. Nothing pool-specific is needed: the monthly meter and the purchased
-- balance both count `not voided` (fair_use_used and
-- fair_use_purchased_remaining, 0086), so flipping voided back re-draws
-- whichever pool paid — the exact mirror of 0086's "a void restores whichever
-- pool paid". A recharged row counts in its original created_at month.
--
-- Idempotent. Requires 0078 (void_reason) and 0086 (credit_ledger.source).

-- ── 1. The sync trigger learns the success leg ───────────────────────────────
-- Body is 0078's verbatim plus the third clause.
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
  -- 0088: requeued to success — charge on delivery. Un-void the error-path
  -- refund and resync units (the clause above skipped this row while voided).
  if new.status = 'done' and new.status is distinct from old.status then
    update credit_ledger
       set voided = false,
           void_reason = null,
           units = case when new.kind = 'presentation' and new.params ? 'video_parts'
                        then greatest(coalesce((new.params->>'video_parts')::int, 1), 1)
                        else units end
     where generation_id = new.id
       and voided
       and void_reason is distinct from 'unconsumed_on_delete';
  end if;
  return null;
end $$;

-- Rebind explicitly, for the same reason 0078 did: `create or replace` keeps
-- the existing trigger pointed at the same OID only if the function already
-- lived in `public`. Re-issuing removes the assumption.
drop trigger if exists credit_ledger_sync on public.generations;
create trigger credit_ledger_sync after update of params, status on public.generations
  for each row execute function public.credit_ledger_sync();

-- ── 2. Backfill: rows already carrying the requeued-to-success signature ─────
-- A voided error-path row whose generation is ALIVE and 'done' can only mean
-- the generation errored (that is the only way the row got voided, 0078's
-- audit) and was later moved to 'done' — i.e. exactly the requeue-to-success
-- path this migration handles going forward. The work exists; charge it.
-- 0078's Hadil row (unconsumed_on_delete) is excluded twice over: by the
-- void_reason predicate AND by the join (its generation is deleted).
-- Verified against prod 2026-08-18: matches SIX rows across two users — the
-- five muthudpsbn document rows (taking that trial account to its honest 6/6
-- for the rows' month) plus one mahinineda84 presentation with the same
-- requeued-to-done signature from 2026-08-17. Idempotent: a second run finds
-- voided=false and matches nothing.
update public.credit_ledger cl
   set voided = false,
       void_reason = null,
       units = case when g.kind = 'presentation' and g.params ? 'video_parts'
                    then greatest(coalesce((g.params->>'video_parts')::int, 1), 1)
                    else cl.units end
  from public.generations g
 where g.id = cl.generation_id
   and g.status = 'done'
   and cl.voided
   and cl.void_reason is distinct from 'unconsumed_on_delete';
