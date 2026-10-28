-- 0164: `assign` — SK's first confirm-tier action (Final Plan 2026-10-28 §2.5,
-- §4 "Assign work = confirm", §8.2, §9.2).
--
-- sk_assign_with_token(p_token, p_context_hash) — ONE transaction that
--   (1) locks the token row, (2) consumes it through 0163's
--   sk_consume_action_token (same outcomes: not_found / already_used / expired
--   / context_mismatch / done), (3) re-checks BOTH ownerships against the
--   token's stored params — the generation is the user's own, live and done,
--   and the class is the user's own (RLS `shares_owner_class_all` checks only
--   the generation, 0018) — plus the Library's own "assignable" rule (done, not
--   lesson_plan / question_bank), (4) upserts generation_shares on
--   (generation_id, class_id) — the idempotency key §9.2 names — and (5) writes
--   the sk_actions audit row with the token id. Returns jsonb {outcome, …}.
--
-- A refused action BURNS the token (decision, slice D): the params were
-- resolved and ownership-checked by the server when the card was issued, so a
-- refusal at execution means the world changed (kit withdrawn, class handed
-- over) or someone is probing with a stale card. Retrying the same token could
-- never succeed differently; the user asks again and gets a fresh card. The
-- consume therefore stands on refusal (no exception), the share is NOT written,
-- and the app writes the ok=false audit row. The one exception: a token for a
-- DIFFERENT action is refused BEFORE the consume — that is a server dispatch
-- fault, not a user retry, and must not void a card another action could run.
--
-- Same doctrine as 0163: security definer with a pinned search_path, revoked
-- from public/anon/authenticated, executable by the service role only (the
-- /api/sk/act route, after its own token verification against the Context).
--
-- Run as ONE execution. Idempotent.
begin;

create or replace function public.sk_assign_with_token(p_token uuid, p_context_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r             public.sk_action_tokens%rowtype;
  outcome       text;
  v_generation  uuid;
  v_class       uuid;
  v_due         timestamptz;
  v_share       uuid;
  v_school      uuid;
begin
  select * into r from public.sk_action_tokens where id = p_token for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  -- Dispatch fault, not a retry: do not consume a card that belongs to another action.
  if r.action is distinct from 'assign' then
    return jsonb_build_object('outcome', 'refused', 'reason', 'wrong_action');
  end if;

  -- (2) Atomic consume: from here on the token is spent whatever follows.
  outcome := public.sk_consume_action_token(p_token, p_context_hash);
  if outcome <> 'done' then
    return jsonb_build_object('outcome', outcome);
  end if;

  -- (3) The STORED params only — never anything the client sent.
  begin
    v_generation := nullif(r.params->>'generation_id', '')::uuid;
    v_class      := nullif(r.params->>'class_id', '')::uuid;
    v_due        := nullif(r.params->>'due_at', '')::timestamptz;
  exception when others then
    return jsonb_build_object('outcome', 'refused', 'reason', 'bad_params');
  end;
  if v_generation is null or v_class is null then
    return jsonb_build_object('outcome', 'refused', 'reason', 'bad_params');
  end if;
  if not exists (
    select 1 from public.generations g
     where g.id = v_generation
       and g.owner_id = r.user_id
       and g.withdrawn_at is null
       and g.status = 'done'
       and g.kind::text not in ('lesson_plan', 'question_bank')
  ) then
    return jsonb_build_object('outcome', 'refused', 'reason', 'generation_not_assignable');
  end if;
  if not exists (
    select 1 from public.classes c
     where c.id = v_class
       and c.teacher_id = r.user_id
  ) then
    return jsonb_build_object('outcome', 'refused', 'reason', 'class_not_owned');
  end if;

  -- (4) The write. (generation_id, class_id) is unique (0001): a repeat assign
  -- of the same kit to the same class updates the due date, as the Library does.
  insert into public.generation_shares (generation_id, class_id, shared_by, due_at)
  values (v_generation, v_class, r.user_id, v_due)
  on conflict (generation_id, class_id) do update
    set due_at = excluded.due_at,
        shared_by = excluded.shared_by
  returning id into v_share;

  -- (5) The audit row, keyed by the token (§8.2). school_id is a snapshot.
  select c.school_id into v_school from public.classes c where c.id = v_class;
  insert into public.sk_actions
    (actor_id, school_id, action, tier, kind, params, ok, result, generation_id, token_id, at, ms)
  values
    (r.user_id, v_school, 'assign', 'confirm', 'act', r.params, true,
     jsonb_build_object('share_id', v_share), v_generation, p_token, now(), 0);

  return jsonb_build_object(
    'outcome', 'done',
    'share_id', v_share,
    'class_id', v_class,
    'generation_id', v_generation,
    'due_at', v_due
  );
end $$;

revoke all on function public.sk_assign_with_token(uuid, text) from public, anon, authenticated;
grant execute on function public.sk_assign_with_token(uuid, text) to service_role;

commit;
