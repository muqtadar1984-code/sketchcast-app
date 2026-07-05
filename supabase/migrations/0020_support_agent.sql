-- 0020 — AI support agent: content-linked issues + diagnosis storage.
--
-- Reuses the platform console's issue system (0014) rather than a new silo:
-- an agent run IS a platform_issues row, enriched with content references and
-- the structured diagnosis. The worker gains a 'support_diagnose' job type
-- (jobs.type is text — no enum change); jobs.issue_id links a diagnosis job to
-- its issue. Additive + inert until the worker/app releases ship. One
-- execution. Idempotent.

alter table public.platform_issues add column if not exists
  book_id uuid references public.books(id) on delete set null;
alter table public.platform_issues add column if not exists
  generation_id uuid references public.generations(id) on delete set null;
alter table public.platform_issues add column if not exists
  job_id uuid;                                  -- the failed job, when auto-triggered
alter table public.platform_issues add column if not exists
  trigger_source text not null default 'manual'
  check (trigger_source in ('auto', 'manual'));
-- Structured agent output. USER-SAFE ONLY (reporters can read their own rows):
-- {category, confidence, user_message, recommended_action}. Staff-only detail
-- goes to platform_audit_log, never here.
alter table public.platform_issues add column if not exists diagnosis jsonb;
alter table public.platform_issues add column if not exists
  agent_action text
  check (agent_action is null or agent_action in
         ('self_heal_retry', 'user_fix', 'regenerated', 'regenerated_pending',
          'escalated', 'none'));

-- Content-problem categories for the report form + auto-trigger.
alter table public.platform_issues drop constraint if exists platform_issues_category_check;
alter table public.platform_issues add constraint platform_issues_category_check
  check (category in ('video','deck_docs','quiz','upload','login','speed','other',
                      'wrong_chapter','poor_quality','missing_parts','generation_failed'));

create index if not exists pi_generation_idx on public.platform_issues (generation_id);
create index if not exists pi_book_idx       on public.platform_issues (book_id);

alter table public.jobs add column if not exists issue_id uuid;

-- ── Close a cross-tenant primitive (found in adversarial review) ─────────────
-- 0001's gen_write validated only owner_id, so a hostile client could insert a
-- generation THEY own that references ANOTHER tenant's book_id (the FK only
-- requires existence). Everything downstream keys off the generation owner, so
-- that stray reference could leak/act on foreign content. Constrain book_id to
-- books the user may actually use (their own, or their school's library, not
-- taken down). SECURITY DEFINER helper avoids policy-in-policy recursion.
create or replace function public.can_use_book(bid uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select exists (
     select 1 from books b
     where b.id = bid
       and b.removed_at is null
       and (b.owner_id = auth.uid()
            or (b.school_id is not null and b.school_id = current_school_id()))
   ) $$;

drop policy if exists gen_write on public.generations;
create policy gen_write on public.generations for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid()
              and (book_id is null or can_use_book(book_id)));
