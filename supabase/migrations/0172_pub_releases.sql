-- 0172: book releases (founder 2026-10-30: "incorporate completed and drafted books … these books should then reflect
-- under the library and SK should have access to it"). The contract between the book app and SK
-- (side-session-notes BOOK-RELEASES-CONTRACT-2026-10-30.md, approved by SK):
--   the book app writes a release — one row here plus books/<slug>/editions/<edition_key>/ (bundle.json, PDFs, cover)
--   SK only reads it (knowledge layer, Library listing, entitlement); neither side writes the other's tables.
--   release_kind 'final' = a Gate E approval; 'draft' = the Gate-D-approved chapters of the current revision.
-- A release is a record: never deleted; the only changes are superseded_by (once, by a newer release of the same
-- work, kind and language) and withdrawal (once, with a reason).
--
-- Additive and idempotent. Same protection as 0161: RLS on, no policies, nothing granted to anon or authenticated —
-- only server routes and the books runner (service role).

create table if not exists public.pub_releases (
  id                 bigserial primary key,
  work_uid           text not null references public.pub_works(uid),
  slug               text not null,
  release_kind       text not null check (release_kind in ('final', 'draft')),
  edition_key        text not null,
  language           text not null,
  revision_key       text not null,
  gate_e_approval_id bigint references public.pub_approvals(id),
  title              text not null,
  subtitle           text,
  subject            text,
  curriculum_code    text,
  grade_band         text,
  age_band           text,
  chapters           jsonb not null,               -- [{chapter, title, content_sha256, gate_d_approval_id, pdf_key}]
  chapter_count      int not null,
  bundle_key         text not null,
  bundle_sha256      text not null,
  digital_pdf_key    text,
  digital_pdf_sha256 text,
  print_pdf_key      text,
  print_pdf_sha256   text,
  cover_key          text,
  cover_sha256       text,
  released_by        text not null,
  released_at        timestamptz not null default now(),
  run_id             bigint references public.pub_runs(id),
  superseded_by      bigint references public.pub_releases(id),
  withdrawn_at       timestamptz,
  withdrawn_reason   text,
  withdrawn_by       text,
  constraint pub_releases_final_has_gate_e check (release_kind <> 'final' or gate_e_approval_id is not null),
  constraint pub_releases_withdrawn check ((withdrawn_at is null) = (withdrawn_reason is null)
                                           and (withdrawn_at is null) = (withdrawn_by is null)),
  unique (work_uid, edition_key)
);
create index if not exists pub_releases_live_idx on public.pub_releases (work_uid, release_kind, language)
  where superseded_by is null and withdrawn_at is null;
create index if not exists pub_releases_new_idx on public.pub_releases (id) where superseded_by is null and withdrawn_at is null;

-- the only changes ever allowed: superseded_by set once on a row not yet superseded; withdrawal set once
create or replace function public.pub_releases_guard() returns trigger language plpgsql as $$
declare
  rest_old jsonb := to_jsonb(old) - 'superseded_by' - 'withdrawn_at' - 'withdrawn_reason' - 'withdrawn_by';
  rest_new jsonb := to_jsonb(new) - 'superseded_by' - 'withdrawn_at' - 'withdrawn_reason' - 'withdrawn_by';
begin
  if tg_op = 'DELETE' then
    raise exception 'pub_releases is a record: withdraw a release instead of deleting it';
  end if;
  if rest_old <> rest_new
     or (old.superseded_by is not null and new.superseded_by is distinct from old.superseded_by)
     or (old.withdrawn_at is not null and (new.withdrawn_at, new.withdrawn_reason, new.withdrawn_by)
                                          is distinct from (old.withdrawn_at, old.withdrawn_reason, old.withdrawn_by)) then
    raise exception 'pub_releases: the only changes allowed are superseded_by (once) and a withdrawal (once)';
  end if;
  return new;
end $$;
drop trigger if exists pub_releases_guard on public.pub_releases;
create trigger pub_releases_guard before update or delete on public.pub_releases
  for each row execute function public.pub_releases_guard();

-- publish a release atomically: insert it and mark the previous live release of the same work, kind and language
-- superseded, so there is always exactly one live one (called by the books runner with the service role)
create or replace function public.pub_release_publish(release jsonb) returns bigint
language plpgsql security invoker as $$
declare
  new_id bigint;
begin
  perform 1 from public.pub_works where uid = release->>'work_uid' for update;   -- one publisher per book at a time
  insert into public.pub_releases
    select * from jsonb_populate_record(null::public.pub_releases,
      release || jsonb_build_object('id', nextval('public.pub_releases_id_seq'), 'released_at', now(),
                                    'superseded_by', null, 'withdrawn_at', null, 'withdrawn_reason', null,
                                    'withdrawn_by', null))
    returning id into new_id;
  update public.pub_releases set superseded_by = new_id
   where work_uid = release->>'work_uid' and release_kind = release->>'release_kind'
     and language = release->>'language' and id <> new_id and superseded_by is null and withdrawn_at is null;
  return new_id;
end $$;

alter table public.pub_releases enable row level security;
revoke all on public.pub_releases from anon, authenticated;
revoke all on sequence public.pub_releases_id_seq from anon, authenticated;
revoke all on function public.pub_releases_guard() from public, anon, authenticated;
revoke all on function public.pub_release_publish(jsonb) from public, anon, authenticated;
grant execute on function public.pub_release_publish(jsonb) to service_role;
