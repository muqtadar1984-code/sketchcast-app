-- 0143_delete_translation_kit — remove one REJECTED or FAILED translation (2026-10-18)
--
-- Founder, 2026-10-18, on the Translations rows of a topic: "add an x mark to
-- the rejected and failed generation to be able to delete manually" — and,
-- earlier, "we don't need to store [failed translations]". Re-runs leave a
-- rejected or failed kit behind each time; this deletes one, completely, in
-- ONE transaction. The portal removes the storage objects afterwards with the
-- paths this function returns (storage is not reachable from SQL).
--
-- What it refuses (a check_violation with a sentence for the portal):
--   * an English kit, or a kit that is not a translation (source_kit_id null);
--   * any status other than rejected or failed — never an approved, in-review
--     or generating translation;
--   * a kit with a live job on any of its generations;
--   * a kit with a video on YouTube (a topic_publications row with an id);
--   * a kit another translation derives from (a Jawi kit from a Malay one).
--
-- What it removes:
--   * the kit's generations — its presentation, deck, documents, bank, quiz
--     and lesson plan, retried ones included — and with them (cascade) their
--     jobs, artifacts and views; the few NO ACTION references to them
--     (platform_issues, present_items, question_sets.rendered_generation_id,
--     topic_kits.presentation_generation_id) are cleared first;
--   * the kit's own question set (translation.stage.quiz.question_set_id);
--   * its bank items (topic_questions.translation_kit_id), after clearing any
--     item that names one of them as its source;
--   * the kit row (its publications cascade — there are none, see above);
--   * its translated article version, when it is a translation, not approved,
--     and nothing else (no kit, no item) still points at it.
-- English content, approved translations and the source kit are never touched.
--
-- Service role only; the portal's kit route calls it as a Library approver.

create or replace function public.delete_translation_kit(p_kit uuid, p_actor uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  k         topic_kits%rowtype;
  v_gens    uuid[];
  v_items   uuid[];
  v_paths   text[];
  v_set     uuid;
  v_art     uuid;
  v_art_del boolean := false;
  a         topic_articles%rowtype;
begin
  select * into k from topic_kits where id = p_kit for update;
  if not found then
    raise exception 'kit % not found', p_kit using errcode = 'check_violation';
  end if;
  if coalesce(k.language, 'en') = 'en' or k.source_kit_id is null then
    raise exception 'only a translation can be deleted here; % is an English kit', p_kit using errcode = 'check_violation';
  end if;
  if k.status not in ('rejected', 'failed') then
    raise exception 'translation % is %, not rejected or failed — only a rejected or failed translation is deleted', p_kit, k.status
      using errcode = 'check_violation';
  end if;
  if exists (select 1 from topic_kits c where c.source_kit_id = p_kit) then
    raise exception 'another translation is derived from %; delete that one first', p_kit using errcode = 'check_violation';
  end if;
  if exists (select 1 from topic_publications p where p.topic_kit_id = p_kit and p.youtube_video_id is not null) then
    raise exception 'translation % has a video on YouTube; it is not deleted here', p_kit using errcode = 'check_violation';
  end if;

  -- every generation of the kit: the pointers on the row, and every
  -- generation whose params name the kit (retried ones included)
  select coalesce(array_agg(distinct g.id), '{}') into v_gens
    from generations g
   where g.id = k.presentation_generation_id
      or g.id::text in (select value from jsonb_each_text(coalesce(k.doc_generation_ids, '{}'::jsonb)))
      or g.params->>'kit_id' = p_kit::text
      or g.params->'translation'->>'kit_id' = p_kit::text;

  if exists (select 1 from jobs j where j.generation_id = any (v_gens) and j.status in ('queued', 'processing')) then
    raise exception 'translation % still has a job running; wait for it to finish', p_kit using errcode = 'check_violation';
  end if;

  select coalesce(array_agg(x.storage_path), '{}') into v_paths
    from artifacts x where x.generation_id = any (v_gens) and x.storage_path is not null;

  -- the NO ACTION references, cleared before the deletes
  update topic_kits set presentation_generation_id = null where id = p_kit;
  update platform_issues set generation_id = null where generation_id = any (v_gens);
  update present_items set generation_id = null where generation_id = any (v_gens);
  update question_sets set rendered_generation_id = null where rendered_generation_id = any (v_gens);
  update catalogue_unlocks set first_kit_id = null where first_kit_id = p_kit;

  -- the kit's own question set (the translated quiz)
  begin
    v_set := nullif(k.translation->'stage'->'quiz'->>'question_set_id', '')::uuid;
  exception when others then
    v_set := null;
  end;
  if v_set is not null then
    delete from question_sets where id = v_set;
  end if;

  -- the bank items staged (or retired) for this kit
  select coalesce(array_agg(q.id), '{}') into v_items from topic_questions q where q.translation_kit_id = p_kit;
  update topic_questions set source_question_id = null where source_question_id = any (v_items);
  update topic_questions set source_item_id = null where source_item_id = any (v_items);
  delete from topic_questions where id = any (v_items);

  delete from generations where id = any (v_gens);

  v_art := k.article_id;
  delete from topic_kits where id = p_kit;

  -- the translated article version, when nothing else needs it
  select * into a from topic_articles where id = v_art;
  if found and coalesce(a.language, 'en') <> 'en' and a.status <> 'approved'
     and not exists (select 1 from topic_kits o where o.article_id = v_art)
     and not exists (select 1 from topic_questions o where o.article_id = v_art) then
    update topic_articles set source_article_id = null where source_article_id = v_art;
    delete from topic_articles where id = v_art;
    v_art_del := true;
  end if;

  insert into platform_audit_log (actor_id, action, target_kind, target_id, detail)
  values (p_actor, 'library_kit_translation_delete', 'topic', k.topic_id,
          jsonb_build_object('kit_id', p_kit, 'language', k.language, 'status', k.status,
                             'source_kit_id', k.source_kit_id, 'generations', coalesce(array_length(v_gens, 1), 0),
                             'items', coalesce(array_length(v_items, 1), 0), 'article_deleted', v_art_del,
                             'files', coalesce(array_length(v_paths, 1), 0)));

  return jsonb_build_object('kit_id', p_kit, 'topic_id', k.topic_id, 'language', k.language,
                            'generations', coalesce(array_length(v_gens, 1), 0),
                            'items', coalesce(array_length(v_items, 1), 0),
                            'article_deleted', v_art_del, 'storage_paths', to_jsonb(v_paths));
end $$;

revoke all on function public.delete_translation_kit(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_translation_kit(uuid, uuid) to service_role;

comment on function public.delete_translation_kit(uuid, uuid) is
  'Delete one REJECTED or FAILED translation kit with its generations, items, question set and unused article version, in one transaction; returns the storage paths for the portal to remove (0143).';
