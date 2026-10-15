-- 0128: catalogue Phase A — who can see a ready-made kit, and the weekly unlock.
--
-- Plan: "SketchCast Feature Plan - Catalogue Pages and Weekly Kits.md" (rev 3,
-- founder-approved 2026-10-15). Phase A is the data layer only: no app route,
-- page or worker change reads any of this yet.
--
-- TWO OFFERINGS, TWO LEDGERS. Personalized generation keeps its monthly
-- credits (fair_use_caps, credit_ledger, the generations triggers). A
-- catalogue unlock is a different thing — access to files that already exist —
-- and is counted HERE, in catalogue_unlocks, and nowhere else. Nothing in this
-- migration inserts into generations or touches a credit trigger.
--
-- What it adds:
--   topics.slug + topic_slug_redirects   the stable public identity every
--                                        destination (site, YouTube, later
--                                        Pinterest/sales/books) links to
--   catalogue_current_kits()             the ONE place the visibility rule lives
--   public_catalogue()                   the anon-safe projection the static
--                                        site builds from
--   catalogue_unlocks                    one row per (user, topic), permanent
--   catalogue_events                     append-only funnel events (server only)
--   catalogue_weekly_cap / _week_start / _has_access / unlock_catalogue_kit /
--   my_catalogue_allowance               the entitlement
--
-- FUNCTIONS, NOT VIEWS: this schema has no views, and a view in `public` runs
-- with its owner's rights (the Supabase advisor flags it). Every read here is a
-- SECURITY DEFINER function with an explicit grant, the pattern the rest of
-- the schema uses.
--
-- VISIBILITY (founder D6): a topic is in the catalogue when it is not retired,
-- its question bank is approved (bank_maturity <> 'none'), and it has an
-- APPROVED kit whose OWN video is public on YouTube. The kit shown is the
-- most recently approved such kit. Keyed on the KIT, not topics.status: a
-- topic goes back to generating/in_review while staff build a replacement kit,
-- and its published kit must stay visible meanwhile. A newer approved kit that
-- is not yet public is not chosen, and an older kit's public video can never
-- make a newer, unpublished kit visible (the publication must belong to the
-- chosen kit).
--
-- THE WEEKLY CAP (founder D1/F1): trial/promo/school_expired 1, pro/family 5,
-- pro_plus/homeschool 10, school/school_trial/staff unlimited,
-- school_suspended 0. The week starts Monday 00:00 UTC; no rollover. Only
-- rows with source = 'allowance' count. An unlimited tier's unlocks are
-- source = 'unlimited', so a school member whose school then expires starts
-- with their full free allowance instead of being over it.
--
-- CONCURRENCY: unlock_catalogue_kit takes a per-user transaction advisory
-- lock BEFORE it counts. A `select … for update` over the user's unlock rows
-- locks nothing when there are none yet, so two first unlocks could both pass;
-- the advisory lock serialises them whether or not rows exist.
--
-- Rollback: supabase/rollback/0128_catalogue_weekly_kits_down.sql (drops only
-- what this file creates; topics keeps every pre-existing column and row).

-- ════════════════════════════════════════════════════════════════════════════
-- 1. topics.slug — stable public identity
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.catalogue_slugify(t text)
returns text
language sql
immutable
set search_path = public
as $$
  select nullif(btrim(regexp_replace(lower(coalesce(t, '')), '[^a-z0-9]+', '-', 'g'), '-'), '')
$$;

alter table public.topics add column if not exists slug text;

create table if not exists public.topic_slug_redirects (
  old_slug   text primary key,
  topic_id   uuid not null references public.topics(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.topic_slug_redirects enable row level security;
revoke all on public.topic_slug_redirects from anon, authenticated;

comment on table public.topic_slug_redirects is
  'A topic''s former public slugs. The static site emits a redirect for each, so a renamed topic never breaks a link. Read through public_catalogue_redirects().';

-- Backfill: title, else canonical_key, else "topic"; duplicates get -2, -3 …
-- in creation order (the oldest topic keeps the bare slug).
with base as (
  select id,
         coalesce(public.catalogue_slugify(title), public.catalogue_slugify(canonical_key), 'topic') as b,
         row_number() over (
           partition by coalesce(public.catalogue_slugify(title), public.catalogue_slugify(canonical_key), 'topic')
           order by created_at, id) as n
  from public.topics
  where slug is null
)
update public.topics t
   set slug = case when base.n = 1 then base.b else base.b || '-' || base.n end
  from base
 where t.id = base.id;

-- Fill a missing slug, keep it unique against live slugs AND former slugs, and
-- record the old slug when one changes. Staff create topics from the console
-- without a slug; this is what gives them one.
create or replace function public.topics_slug_maintain()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  base text;
  candidate text;
  n int := 1;
begin
  if new.slug is null or btrim(new.slug) = '' then
    base := coalesce(public.catalogue_slugify(new.title), public.catalogue_slugify(new.canonical_key), 'topic');
    candidate := base;
    while exists (select 1 from topics t where t.slug = candidate and t.id <> new.id)
       or exists (select 1 from topic_slug_redirects r where r.old_slug = candidate and r.topic_id <> new.id) loop
      n := n + 1;
      candidate := base || '-' || n;
    end loop;
    new.slug := candidate;
  end if;

  if tg_op = 'UPDATE' and old.slug is not null and new.slug is distinct from old.slug then
    if exists (select 1 from topic_slug_redirects r where r.old_slug = new.slug and r.topic_id <> new.id) then
      raise exception 'slug % was used by another topic; pick a different one', new.slug
        using errcode = 'unique_violation';
    end if;
    -- A topic taking back one of its own former slugs: that slug is live again.
    delete from topic_slug_redirects where old_slug = new.slug;
    insert into topic_slug_redirects (old_slug, topic_id) values (old.slug, new.id)
    on conflict (old_slug) do update set topic_id = excluded.topic_id, created_at = now();
  end if;
  return new;
end
$$;

drop trigger if exists topics_slug_maintain on public.topics;
create trigger topics_slug_maintain
  before insert or update of slug on public.topics
  for each row execute function public.topics_slug_maintain();

alter table public.topics alter column slug set not null;
create unique index if not exists topics_slug_key on public.topics (slug);
alter table public.topics drop constraint if exists topics_slug_format;
alter table public.topics add constraint topics_slug_format
  check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

comment on column public.topics.slug is
  'Stable public identifier (sketchcast.app/topics/<slug>). Never reused; a change records the old slug in topic_slug_redirects. Separate from canonical_key, which is internal.';

-- ════════════════════════════════════════════════════════════════════════════
-- 2. The visibility rule — catalogue_current_kits()
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.catalogue_current_kits()
returns table (
  topic_id     uuid,
  language     text,
  topic_kit_id uuid,
  article_id   uuid,
  approved_at  timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select distinct on (k.topic_id, k.language)
         k.topic_id, k.language, k.id, k.article_id,
         coalesce(k.reviewed_at, k.updated_at, k.created_at)
  from topic_kits k
  join topics t on t.id = k.topic_id
  where k.status = 'approved'
    and t.status <> 'retired'
    and t.bank_maturity <> 'none'
    and exists (
      select 1 from topic_publications p
      where p.topic_kit_id = k.id
        and p.superseded_by is null
        and p.privacy = 'public'
        and p.youtube_video_id is not null)
  order by k.topic_id, k.language,
           coalesce(k.reviewed_at, k.updated_at, k.created_at) desc,
           k.created_at desc, k.id desc
$$;

comment on function public.catalogue_current_kits() is
  'The catalogue visibility rule (founder D6), in one place: one row per (topic, language) — the most recently approved kit whose own video is public, for a non-retired topic with an approved bank. Internal: service role and the catalogue functions only.';

-- ════════════════════════════════════════════════════════════════════════════
-- 3. public_catalogue() — what an anonymous visitor may read
-- ════════════════════════════════════════════════════════════════════════════
-- NEVER returned: storage paths, generation ids, question stems or answers,
-- questions_json, answer keys, internal keys. The bank is described by COUNTS
-- and FLAGS so the page can say "Practice questions (42)" in any locale.

create or replace function public.public_catalogue()
returns table (
  slug                  text,
  title                 text,
  subject               text,
  summary               text,
  language              text,
  languages             text[],
  approved_at           timestamptz,
  objectives            jsonb,
  key_concepts          jsonb,
  sections              jsonb,
  worked_examples       jsonb,
  misconceptions        jsonb,
  curriculum            jsonb,
  videos                jsonb,
  chapters              jsonb,
  kit_pieces            text[],
  question_count        integer,
  has_online_assessment boolean,
  exam_ready            boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with cur as (select * from catalogue_current_kits())
  select
    t.slug,
    coalesce(nullif(a.title, ''), t.title),
    t.subject,
    t.summary,
    cur.language,
    (select array_agg(c2.language order by c2.language) from cur c2 where c2.topic_id = cur.topic_id),
    cur.approved_at,
    a.objectives,
    a.glossary,
    a.sections,
    -- One or two worked examples (R7); the kit carries the rest.
    case when jsonb_typeof(a.worked_examples) = 'array'
         then coalesce((select jsonb_agg(e.value order by e.ord)
                        from jsonb_array_elements(a.worked_examples) with ordinality as e(value, ord)
                        where e.ord <= 2), '[]'::jsonb)
         else '[]'::jsonb end,
    a.misconceptions,
    coalesce((
      select jsonb_agg(jsonb_build_object(
               'curriculum', cu.name, 'curriculum_code', cu.code,
               'code', n.code, 'title', n.title, 'grade', n.grade,
               'coverage', m.coverage)
             order by cu.code, n.sort, n.code)
      from topic_curriculum_map m
      join curriculum_nodes n on n.id = m.node_id
      join curricula cu on cu.id = n.curriculum_id
      where m.topic_id = t.id), '[]'::jsonb),
    coalesce((
      select jsonb_agg(jsonb_build_object('part', p.part, 'youtube_video_id', p.youtube_video_id)
             order by p.part)
      from topic_publications p
      where p.topic_kit_id = k.id and p.superseded_by is null
        and p.privacy = 'public' and p.youtube_video_id is not null), '[]'::jsonb),
    coalesce(k.chapters, '[]'::jsonb),
    array['video'] || coalesce(
      (select array_agg(d.key order by d.key) from jsonb_each_text(coalesce(k.doc_generation_ids, '{}'::jsonb)) d
       where nullif(d.value, '') is not null), array[]::text[]),
    (select count(*)::int from topic_questions q
      where q.topic_id = t.id and q.language = cur.language and q.status = 'approved'),
    exists (
      select 1 from artifacts ar
      where ar.generation_id = nullif(coalesce(k.doc_generation_ids, '{}'::jsonb) ->> 'worksheet', '')::uuid
        and ar.kind = 'questions_json'),
    t.bank_maturity = 'exam_ready'
  from cur
  join topics t       on t.id = cur.topic_id
  join topic_kits k   on k.id = cur.topic_kit_id
  join topic_articles a on a.id = cur.article_id
$$;

comment on function public.public_catalogue() is
  'Anon-safe catalogue projection for the public topic pages (Phase B). Counts and flags only for the bank; no paths, ids, stems or answers.';

create or replace function public.public_catalogue_redirects()
returns table (old_slug text, slug text)
language sql
stable
security definer
set search_path = public
as $$
  select r.old_slug, t.slug
  from topic_slug_redirects r
  join topics t on t.id = r.topic_id
  where exists (select 1 from catalogue_current_kits() c where c.topic_id = t.id)
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 4. Unlocks and events
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.catalogue_unlocks (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  topic_id     uuid not null references public.topics(id) on delete cascade,
  first_kit_id uuid references public.topic_kits(id) on delete set null,
  source       text not null default 'allowance'
               check (source in ('allowance', 'unlimited', 'staff_grant', 'purchase')),
  week_start   date not null,
  unlocked_at  timestamptz not null default now(),
  unique (user_id, topic_id)
);
create index if not exists catalogue_unlocks_user_week
  on public.catalogue_unlocks (user_id, week_start) where source = 'allowance';

alter table public.catalogue_unlocks enable row level security;
drop policy if exists catalogue_unlocks_own_read on public.catalogue_unlocks;
create policy catalogue_unlocks_own_read on public.catalogue_unlocks
  for select to authenticated using (user_id = auth.uid());
revoke all on public.catalogue_unlocks from anon, authenticated;
grant select on public.catalogue_unlocks to authenticated;

comment on table public.catalogue_unlocks is
  'Catalogue access, one row per (user, topic), permanent. Written only by unlock_catalogue_kit (and service-role grants/purchases). Only source=allowance counts toward the weekly cap. first_kit_id records the kit current at unlock time; access always resolves to the CURRENT kit.';

create table if not exists public.catalogue_events (
  id         bigint generated always as identity primary key,
  user_id    uuid references public.profiles(id) on delete set null,
  topic_id   uuid references public.topics(id) on delete set null,
  event      text not null check (event ~ '^[a-z][a-z_]{1,39}$'),
  meta       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists catalogue_events_event_time on public.catalogue_events (event, created_at);
create index if not exists catalogue_events_user_time  on public.catalogue_events (user_id, created_at);

alter table public.catalogue_events enable row level security;
revoke all on public.catalogue_events from anon, authenticated;

comment on table public.catalogue_events is
  'Append-only catalogue funnel events (unlock, weekly_limit, download, open, assign, upgrade_click). Server-side writes only; no client policy.';

-- ════════════════════════════════════════════════════════════════════════════
-- 5. The entitlement
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.catalogue_weekly_cap(tier text)
returns integer
language sql
immutable
set search_path = public
as $$
  -- NULL = unlimited. An unknown tier gets the free allowance, never unlimited.
  select case coalesce(tier, 'trial')
    when 'staff'            then null
    when 'school'           then null
    when 'school_trial'     then null
    when 'pro_plus'         then 10
    when 'homeschool'       then 10
    when 'pro'              then 5
    when 'family'           then 5
    when 'school_suspended' then 0
    else 1   -- trial, promo, school_expired, anything new
  end
$$;

create or replace function public.catalogue_week_start(ts timestamptz default now())
returns date
language sql
stable
set search_path = public
as $$
  select date_trunc('week', ts at time zone 'UTC')::date   -- ISO week: Monday
$$;

-- Why may this user not use the catalogue at all? NULL = eligible.
create or replace function public.catalogue_ineligible_reason(uid uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when uid is null then 'not_signed_in'
    when not exists (select 1 from profiles p where p.id = uid) then 'not_signed_in'
    when exists (select 1 from profiles p where p.id = uid and p.suspended_at is not null) then 'suspended'
    when exists (select 1 from profiles p where p.id = uid and p.role = 'student') then 'forbidden_role'
    when plan_tier(uid) = 'school_suspended' then 'suspended'
  end
$$;

create or replace function public.catalogue_has_access(p_topic uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select catalogue_ineligible_reason(auth.uid()) is null
     and exists (select 1 from catalogue_unlocks u where u.user_id = auth.uid() and u.topic_id = p_topic)
     and exists (select 1 from catalogue_current_kits() c where c.topic_id = p_topic)
$$;

comment on function public.catalogue_has_access(uuid) is
  'THE access check for the caller: eligible role/account, an unlock row, and the topic still in the catalogue (a withdrawn topic is withdrawn for everyone). Unlimited tiers get their row automatically on first open.';

create or replace function public.unlock_catalogue_kit(p_topic uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  me     uuid := auth.uid();
  reason text;
  kit    uuid;
  tier   text;
  cap    int;
  wk     date;
  used   int;
  resets timestamptz;
begin
  if me is null then
    raise exception 'not signed in' using errcode = 'insufficient_privilege';
  end if;

  reason := catalogue_ineligible_reason(me);
  if reason is not null then
    return jsonb_build_object('status', reason);
  end if;

  select c.topic_kit_id into kit
  from catalogue_current_kits() c
  where c.topic_id = p_topic
  order by (c.language = 'en') desc, c.language
  limit 1;
  if kit is null then
    return jsonb_build_object('status', 'not_available');
  end if;

  -- Serialise this user's unlocks, INCLUDING the first one (no rows to lock).
  perform pg_advisory_xact_lock(hashtextextended('catalogue_unlock:' || me::text, 0));

  tier   := plan_tier(me);
  cap    := catalogue_weekly_cap(tier);
  wk     := catalogue_week_start(now());
  resets := (wk + 7)::timestamp at time zone 'UTC';
  select count(*)::int into used
    from catalogue_unlocks u
   where u.user_id = me and u.source = 'allowance' and u.week_start = wk;

  if exists (select 1 from catalogue_unlocks u where u.user_id = me and u.topic_id = p_topic) then
    insert into catalogue_events (user_id, topic_id, event) values (me, p_topic, 'open');
    return jsonb_build_object('status', 'already', 'tier', tier, 'cap', cap, 'used', used, 'resets_at', resets);
  end if;

  if cap is not null and used >= cap then
    insert into catalogue_events (user_id, topic_id, event, meta)
    values (me, p_topic, 'weekly_limit', jsonb_build_object('tier', tier, 'cap', cap));
    return jsonb_build_object('status', 'weekly_limit', 'tier', tier, 'cap', cap, 'used', used, 'resets_at', resets);
  end if;

  insert into catalogue_unlocks (user_id, topic_id, first_kit_id, source, week_start)
  values (me, p_topic, kit, case when cap is null then 'unlimited' else 'allowance' end, wk);

  insert into catalogue_events (user_id, topic_id, event, meta)
  values (me, p_topic, 'unlock', jsonb_build_object('tier', tier, 'kit', kit));

  return jsonb_build_object(
    'status', 'unlocked', 'tier', tier, 'cap', cap,
    'used', case when cap is null then used else used + 1 end,
    'resets_at', resets);
end
$$;

comment on function public.unlock_catalogue_kit(uuid) is
  'Unlock a catalogue topic for the caller. Returns {status: unlocked|already|weekly_limit|not_available|forbidden_role|suspended|not_signed_in, tier, cap (null=unlimited), used, resets_at}. Never touches generations or credits.';

create or replace function public.my_catalogue_allowance()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me   uuid := auth.uid();
  tier text;
  cap  int;
  wk   date := catalogue_week_start(now());
  used int;
begin
  if me is null then
    return jsonb_build_object('eligible', false, 'reason', 'not_signed_in');
  end if;
  tier := plan_tier(me);
  cap  := catalogue_weekly_cap(tier);
  select count(*)::int into used
    from catalogue_unlocks u
   where u.user_id = me and u.source = 'allowance' and u.week_start = wk;
  return jsonb_build_object(
    'eligible',  catalogue_ineligible_reason(me) is null,
    'reason',    catalogue_ineligible_reason(me),
    'tier',      tier,
    'cap',       cap,
    'used',      used,
    'resets_at', (wk + 7)::timestamp at time zone 'UTC');
end
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 6. Grants — explicit, because new functions default to EXECUTE for PUBLIC
-- ════════════════════════════════════════════════════════════════════════════

revoke all on function public.catalogue_slugify(text)               from public, anon, authenticated;
revoke all on function public.topics_slug_maintain()                from public, anon, authenticated;
revoke all on function public.catalogue_current_kits()              from public, anon, authenticated;
revoke all on function public.catalogue_ineligible_reason(uuid)     from public, anon, authenticated;
revoke all on function public.catalogue_weekly_cap(text)            from public, anon;
revoke all on function public.catalogue_week_start(timestamptz)     from public, anon;
revoke all on function public.public_catalogue()                    from public;
revoke all on function public.public_catalogue_redirects()          from public;
revoke all on function public.catalogue_has_access(uuid)            from public, anon;
revoke all on function public.unlock_catalogue_kit(uuid)            from public, anon;
revoke all on function public.my_catalogue_allowance()              from public, anon;

grant execute on function public.public_catalogue()                 to anon, authenticated, service_role;
grant execute on function public.public_catalogue_redirects()       to anon, authenticated, service_role;
grant execute on function public.catalogue_weekly_cap(text)         to authenticated, service_role;
grant execute on function public.catalogue_week_start(timestamptz)  to authenticated, service_role;
grant execute on function public.catalogue_has_access(uuid)         to authenticated, service_role;
grant execute on function public.unlock_catalogue_kit(uuid)         to authenticated;
grant execute on function public.my_catalogue_allowance()           to authenticated;
grant execute on function public.catalogue_current_kits()           to service_role;
grant execute on function public.catalogue_ineligible_reason(uuid)  to service_role;
grant all on public.catalogue_unlocks, public.catalogue_events, public.topic_slug_redirects to service_role;
