-- 0168: readiness waivers (R1; founder 2026-10-29). An editor may decide, on a book's Gaps tab, that one failing
-- readiness check does not block THAT book — e.g. an article was revised but its kit and video were not rebuilt,
-- and the old kit still teaches the topic. The books runner hands the book's active waivers to the readiness audit
-- (publishing.schemas.Waiver): the check still runs and is recorded, its failure becomes a warning naming who
-- waived it, when and why. A waiver is a record: it is never edited or deleted, only revoked (once).
--
-- Additive and idempotent. Same protection as 0161: RLS on, no policies, nothing granted to anon or authenticated —
-- only server routes (service role).

create table if not exists public.pub_readiness_waivers (
  id           bigserial primary key,
  work_uid     text not null references public.pub_works(uid) on delete cascade,
  topic_id     uuid not null,
  topic_title  text,
  check_code   text not null check (check_code ~ '^B([1-9]|1[01])$'),
  language     text,
  sub_status   text,                          -- only this kind of failure; null = any failure of the check
  reason       text not null check (length(trim(reason)) > 0),
  waived_by    text not null,                 -- the member's email
  waived_at    timestamptz not null default now(),
  revoked_by   text,
  revoked_at   timestamptz,
  constraint pub_readiness_waivers_revoked check ((revoked_by is null) = (revoked_at is null))
);
create index if not exists pub_readiness_waivers_work_idx on public.pub_readiness_waivers (work_uid) where revoked_at is null;
-- one active waiver per book, topic, check, language and kind of failure
create unique index if not exists pub_readiness_waivers_active_uq on public.pub_readiness_waivers
  (work_uid, topic_id, check_code, coalesce(language, ''), coalesce(sub_status, '')) where revoked_at is null;

-- never deleted; the only change ever allowed is revoking an active waiver (revoked_by + revoked_at, nothing else)
create or replace function public.pub_readiness_waivers_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'pub_readiness_waivers is a record: revoke a waiver instead of deleting it';
  end if;
  if old.revoked_at is not null or new.revoked_at is null
     or (to_jsonb(new) - 'revoked_by' - 'revoked_at') <> (to_jsonb(old) - 'revoked_by' - 'revoked_at') then
    raise exception 'pub_readiness_waivers: the only change allowed is revoking an active waiver';
  end if;
  return new;
end $$;
drop trigger if exists pub_readiness_waivers_guard on public.pub_readiness_waivers;
create trigger pub_readiness_waivers_guard before update or delete on public.pub_readiness_waivers
  for each row execute function public.pub_readiness_waivers_guard();

alter table public.pub_readiness_waivers enable row level security;
revoke all on public.pub_readiness_waivers from anon, authenticated;
revoke all on sequence public.pub_readiness_waivers_id_seq from anon, authenticated;
revoke all on function public.pub_readiness_waivers_guard() from public, anon, authenticated;
