-- 0132: catalogue Phase C — a teacher's own copy of a catalogue document.
--
-- Plan: "SketchCast Feature Plan - Catalogue Pages and Weekly Kits.md" §5.3.
-- Unlocking a topic (0128) grants access to the MASTER files, which belong to
-- the catalogue system account. Assigning to a class, grading submissions and
-- the student views are all owner-scoped (generation_shares, submissions and
-- student_progress require generations.owner_id = auth.uid()), so the moment a
-- teacher wants to ASSIGN a piece they need a row of their own. That row is a
-- library copy: a generations row the teacher owns, pointing at the SAME
-- storage paths — no file is copied, no job is queued, no credit is spent
-- (the 0129 copy flag). The master stays immutable: catalogue rows refuse
-- client updates (0112) and delete_my_generation only removes paths nothing
-- else references (0073).
--
-- Lineage for the future editor (plan §8.1): params.catalogue_ref records
-- topic → kit → source document → article version. A copy that still points
-- at master paths is read-only; the editor must copy the file under
-- <owner>/<copy_id>/ and repoint only the copy's artifacts row first.
--
-- Clients cannot forge a copy: inserts/updates carrying params.catalogue_ref
-- are refused by RLS (same shape as gen_no_catalogue_insert); only this
-- SECURITY DEFINER function writes the key.

-- The one insert trigger 0129 did not cover: enforce_beta_generation_cap
-- (the trial pin) runs for owner-authenticated inserts and would pin a trial
-- teacher's free kit to the copy's NULL book (NOT NULL violation on
-- trial_pin.book_id — found by this migration's dry run). Same guard as 0129,
-- patched in place from the live definition at a unique anchor.
do $patch$
declare
  guard constant text :=
    '-- 0132: a finished COPY (adopt_*) is not a generation: no trial pin, no chapter cap.' || chr(10) ||
    '  if tg_op = ''INSERT'' and new.status = ''done'' and public.generation_copy_in_progress() then' || chr(10) ||
    '    return new;' || chr(10) ||
    '  end if;' || chr(10) || '  ';
  anchor constant text := '-- Worker fast-path: service-role UPDATEs skip every guard';
  d text;
  n int;
begin
  d := pg_get_functiondef('public.enforce_beta_generation_cap'::regproc);
  if position('generation_copy_in_progress()' in d) > 0 then
    raise notice '0132: enforce_beta_generation_cap already guarded, skipped';
  else
    n := (length(d) - length(replace(d, anchor, ''))) / length(anchor);
    if n <> 1 then
      raise exception '0132: anchor in enforce_beta_generation_cap occurs % times (expected 1); re-check before applying', n;
    end if;
    execute replace(d, anchor, guard || anchor);
    raise notice '0132: enforce_beta_generation_cap guarded';
  end if;
end
$patch$;

create or replace function public.adopt_catalogue_piece(p_source uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  me        uuid := auth.uid();
  reason    text;
  src       record;
  kit       record;
  my_school uuid;
  existing  uuid;
  new_id    uuid;
begin
  if me is null then
    raise exception 'not signed in' using errcode = 'insufficient_privilege';
  end if;
  reason := catalogue_ineligible_reason(me);
  if reason is not null then
    raise exception 'catalogue: %', reason using errcode = 'insufficient_privilege';
  end if;

  -- The source must be a piece of an APPROVED kit (the current one, or an
  -- earlier approved kit of the same topic — copies pin their version).
  select k.id as kit_id, k.topic_id, k.article_id, k.language, k.status
    into kit
  from topic_kits k
  where k.status = 'approved'
    and (k.presentation_generation_id = p_source
         or exists (select 1 from jsonb_each_text(coalesce(k.doc_generation_ids, '{}'::jsonb)) d
                    where nullif(d.value, '')::uuid = p_source))
  order by coalesce(k.reviewed_at, k.updated_at, k.created_at) desc
  limit 1;
  if kit.kit_id is null then
    raise exception 'that document is not part of an approved catalogue kit' using errcode = 'no_data_found';
  end if;

  -- Access = an unlock row for the topic, the topic still in the catalogue,
  -- and an eligible account (catalogue_has_access, 0128/0130).
  if not catalogue_has_access(kit.topic_id) then
    raise exception 'unlock this topic first' using errcode = 'insufficient_privilege';
  end if;

  select g.* into src
  from generations g
  where g.id = p_source and g.status = 'done' and g.removed_at is null;
  if src.id is null then
    raise exception 'that document is not available' using errcode = 'no_data_found';
  end if;

  -- Idempotent: one copy per (owner, source document).
  select g.id into existing
  from generations g
  where g.owner_id = me
    and g.removed_at is null
    and (g.params -> 'catalogue_ref' ->> 'source_generation_id')::uuid = p_source
  limit 1;
  if existing is not null then
    return existing;
  end if;

  select p.school_id into my_school from profiles p where p.id = me;

  -- 0129: this insert is a COPY — no job, no metering.
  perform set_config('sketchcast.generation_copy', 'on', true);

  insert into generations (kind, book_id, chapter_ref, title, owner_id, school_id, status, params)
  values (src.kind, null, null, src.title, me, my_school, 'done',
          jsonb_build_object('catalogue_ref', jsonb_build_object(
            'topic_id', kit.topic_id,
            'topic_kit_id', kit.kit_id,
            'source_generation_id', p_source,
            'article_id', kit.article_id,
            'article_version', (select a.version from topic_articles a where a.id = kit.article_id),
            'language', kit.language,
            'adopted_at', now())))
  returning id into new_id;

  insert into artifacts (generation_id, kind, storage_path)
  select new_id, a.kind, a.storage_path
  from artifacts a
  where a.generation_id = p_source;

  perform set_config('sketchcast.generation_copy', '', true);

  insert into catalogue_events (user_id, topic_id, event, meta)
  values (me, kit.topic_id, 'adopt', jsonb_build_object('kind', src.kind::text, 'source', p_source, 'copy', new_id));

  return new_id;
end
$$;

comment on function public.adopt_catalogue_piece(uuid) is
  'Catalogue Phase C: the caller''s own library copy of one catalogue document (same storage paths, status done, params.catalogue_ref lineage). Requires an unlock of the topic. Idempotent per (owner, source). Never queues a job or spends a credit (0129 copy flag).';

revoke all on function public.adopt_catalogue_piece(uuid) from public, anon;
grant execute on function public.adopt_catalogue_piece(uuid) to authenticated;

-- Only this function may write params.catalogue_ref.
-- ⚠️ As applied, these two were PERMISSIVE and refused nothing (Postgres ORs
-- permissive policies). 0133 recreates them AS RESTRICTIVE; kept here as applied.
drop policy if exists gen_no_catalogue_ref_insert on public.generations;
create policy gen_no_catalogue_ref_insert on public.generations
  for insert to authenticated
  with check (not (coalesce(params, '{}'::jsonb) ? 'catalogue_ref'));
drop policy if exists gen_no_catalogue_ref_update on public.generations;
create policy gen_no_catalogue_ref_update on public.generations
  for update to authenticated
  using (true)
  with check (not (coalesce(params, '{}'::jsonb) ? 'catalogue_ref'));
