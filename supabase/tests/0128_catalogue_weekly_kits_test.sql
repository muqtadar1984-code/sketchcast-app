-- SketchCast AI — catalogue Phase A verification for 0128
-- ============================================================================
-- Run AFTER applying 0128_catalogue_weekly_kits.sql. Proves, in order:
--   1. the weekly cap for every plan_tier value, and the Monday-UTC week;
--   2. the visibility rule: approved kit + approved bank + THAT kit's video
--      public; retired / bank none / private / unapproved hidden; a topic
--      being regenerated stays visible; newest public kit wins; an older
--      kit's public video never surfaces a newer unpublished kit;
--   3. unlocks per tier, incl. school/school_trial/staff unlimited and the
--      expired school falling back to the free 1 a week;
--   4. re-unlock is free; students, suspended accounts and hidden topics are
--      refused; a downgrade keeps old unlocks; a weekly reset frees the cap;
--   5. access resolves to the CURRENT kit while the unlock row keeps the kit
--      it was made on, and a withdrawn topic is withdrawn for everyone;
--   6. public_catalogue() is anon-safe (no paths, ids, stems, answers) and
--      the grants are exactly as designed; RLS shows a user only their rows;
--   7. slugs: backfilled, unique, filled on insert, redirect on rename;
--   8. NOTHING was written to generations, jobs or credit_ledger.
-- Concurrency (two sessions racing) cannot be shown inside one transaction:
-- see 0128_catalogue_concurrency.mjs.
-- Every check RAISEs on failure; a clean run prints PASS lines and
-- "ALL 0128 CHECKS PASSED", then ROLLS BACK (nothing persists).
-- ============================================================================
begin;

create or replace function _expect_eq(actual anyelement, expected anyelement, msg text) returns void
  language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'FAIL (got %, wanted %): %', actual, expected, msg;
  end if;
  raise notice 'PASS (= %): %', expected, msg;
end $$;

create or replace function _as(u uuid) returns void
  language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', coalesce(u::text, ''), true);
end $$;

create or replace function _status(u uuid, t uuid) returns text
  language plpgsql as $$
begin
  perform _as(u);
  return unlock_catalogue_kit(t) ->> 'status';
end $$;

-- A catalogue topic with one kit + one publication. Returns the topic id.
create or replace function _mk_topic(k text, bank text, kit_status text, privacy text,
                                     topic_status text default 'video_approved',
                                     reviewed timestamptz default now() - interval '1 day')
returns uuid language plpgsql as $$
declare t uuid; a uuid; kit uuid;
begin
  insert into topics (canonical_key, title, subject, summary, status, bank_maturity)
  values ('zz-0128-' || k, 'ZZ 0128 ' || k, 'Science', 'Test topic ' || k, topic_status, bank)
  returning id into t;
  insert into topic_articles (topic_id, version, language, title, status, objectives, glossary,
                              sections, worked_examples, misconceptions)
  values (t, 1, 'en', 'ZZ 0128 ' || k, 'approved', '["obj 1"]', '[{"term":"cell"}]',
          '[{"heading":"Intro","body":"text"}]',
          '[{"q":"ex1"},{"q":"ex2"},{"q":"ex3"}]', '["m1"]')
  returning id into a;
  insert into topic_kits (topic_id, article_id, language, status, reviewed_at, doc_generation_ids)
  values (t, a, 'en', kit_status, reviewed, '{}'::jsonb)
  returning id into kit;
  insert into topic_publications (topic_kit_id, part, channel_language, youtube_video_id, privacy)
  values (kit, 1, 'en', 'yt_' || k, privacy);
  return t;
end $$;

create temp table _ids (name text primary key, id uuid) on commit drop;

do $$
declare
  T   uuid := '33333333-0128-0000-0000-000000000001'; -- free (trial) teacher
  P   uuid := '33333333-0128-0000-0000-000000000002'; -- teacher pro
  PP  uuid := '33333333-0128-0000-0000-000000000003'; -- teacher pro+
  F   uuid := '33333333-0128-0000-0000-000000000004'; -- home basic (family)
  H   uuid := '33333333-0128-0000-0000-000000000005'; -- homeschool
  S   uuid := '33333333-0128-0000-0000-000000000006'; -- paid school member (coordinator)
  ST  uuid := '33333333-0128-0000-0000-000000000007'; -- school-trial teacher
  STU uuid := '33333333-0128-0000-0000-000000000008'; -- student
  PAR uuid := '33333333-0128-0000-0000-000000000009'; -- parent, free
  ADM uuid := '33333333-0128-0000-0000-00000000000a'; -- staff
  SUS uuid := '33333333-0128-0000-0000-00000000000b'; -- member of a suspended school
  SA  uuid := '33333333-0128-0000-0000-00000000000c'; -- school admin, paid school
  sch_paid  uuid := '44444444-0128-0000-0000-000000000001';
  sch_trial uuid := '44444444-0128-0000-0000-000000000002';
  sch_susp  uuid := '44444444-0128-0000-0000-000000000003';
  v   uuid[] := '{}';
  t1  uuid; hb uuid; hp uuid; hr uuid; hn uuid; vg uuid; vv uuid;
  k_old uuid; k_new uuid; a_vv uuid;
  i int;
  r jsonb;
  gen_before bigint; jobs_before bigint; ledger_before bigint;
begin
  select count(*) into gen_before from generations;
  select count(*) into jobs_before from jobs;
  select count(*) into ledger_before from credit_ledger;

  -- ── fixtures ─────────────────────────────────────────────────────────────
  insert into auth.users (instance_id, id, aud, role, email, created_at, updated_at)
  select '00000000-0000-0000-0000-000000000000', u, 'authenticated', 'authenticated',
         u::text || '@catalogue0128.example.com', now(), now()
  from unnest(array[T, P, PP, F, H, S, ST, STU, PAR, ADM, SUS, SA]) as u
  on conflict (id) do nothing;

  insert into schools (id, name, slug, status, trial_ends_at) values
    (sch_paid,  'ZZ Paid',  'zz-0128-paid',  'active',    null),
    (sch_trial, 'ZZ Trial', 'zz-0128-trial', 'active',    now() + interval '10 days'),
    (sch_susp,  'ZZ Susp',  'zz-0128-susp',  'suspended', null);

  insert into profiles (id, role, school_id) values
    (T, 'teacher', null), (P, 'teacher', null), (PP, 'teacher', null),
    (F, 'parent', null), (H, 'parent', null), (S, 'coordinator', sch_paid),
    (ST, 'teacher', sch_trial), (STU, 'student', null), (PAR, 'parent', null),
    (ADM, 'teacher', null), (SUS, 'teacher', sch_susp), (SA, 'school_admin', sch_paid)
  on conflict (id) do update set role = excluded.role, school_id = excluded.school_id,
    max_books = null, max_chapters = null, suspended_at = null;

  insert into entitlements (user_id, school_id, active, plan_key, status) values
    (P,  null,     true, 'teacher_pro_monthly',      'active'),
    (PP, null,     true, 'teacher_pro_plus_monthly', 'active'),
    (F,  null,     true, 'family_monthly',           'active'),
    (H,  null,     true, 'homeschool_monthly',       'active'),
    (SA, sch_paid, true, 'school_annual',            'active');
  insert into platform_admins (user_id) values (ADM);

  -- ── 1. caps and the week ────────────────────────────────────────────────
  perform _expect_eq(plan_tier(T),   'trial',            'fixture tier: trial');
  perform _expect_eq(plan_tier(P),   'pro',              'fixture tier: pro');
  perform _expect_eq(plan_tier(PP),  'pro_plus',         'fixture tier: pro_plus');
  perform _expect_eq(plan_tier(F),   'family',           'fixture tier: family (Home Basic)');
  perform _expect_eq(plan_tier(H),   'homeschool',       'fixture tier: homeschool');
  perform _expect_eq(plan_tier(S),   'school',           'fixture tier: school (coordinator)');
  perform _expect_eq(plan_tier(SA),  'school',           'fixture tier: school (school admin)');
  perform _expect_eq(plan_tier(ST),  'school_trial',     'fixture tier: school_trial');
  perform _expect_eq(plan_tier(ADM), 'staff',            'fixture tier: staff');
  perform _expect_eq(plan_tier(SUS), 'school_suspended', 'fixture tier: school_suspended');

  perform _expect_eq(catalogue_weekly_cap('trial'),            1,     'cap trial = 1');
  perform _expect_eq(catalogue_weekly_cap('promo'),            1,     'cap promo (ended) = 1');
  perform _expect_eq(catalogue_weekly_cap('school_expired'),   1,     'cap school_expired = the free 1 (F1 refinement)');
  perform _expect_eq(catalogue_weekly_cap('pro'),              5,     'cap Teacher Pro = 5');
  perform _expect_eq(catalogue_weekly_cap('family'),           5,     'cap Home Basic = 5');
  perform _expect_eq(catalogue_weekly_cap('pro_plus'),         10,    'cap Teacher Pro+ = 10');
  perform _expect_eq(catalogue_weekly_cap('homeschool'),       10,    'cap Homeschool = 10');
  perform _expect_eq(catalogue_weekly_cap('school'),           null::int, 'cap school = unlimited');
  perform _expect_eq(catalogue_weekly_cap('school_trial'),     null::int, 'cap school_trial = unlimited (F1)');
  perform _expect_eq(catalogue_weekly_cap('staff'),            null::int, 'cap staff = unlimited');
  perform _expect_eq(catalogue_weekly_cap('school_suspended'), 0,     'cap school_suspended = 0');
  perform _expect_eq(catalogue_weekly_cap('some_new_tier'),    1,     'unknown tier = free allowance, never unlimited');
  perform _expect_eq(catalogue_weekly_cap(null),               1,     'null tier = free allowance');

  perform _expect_eq(catalogue_week_start('2026-10-19 00:00:00+00'), date '2026-10-19', 'Monday 00:00 UTC starts a week');
  perform _expect_eq(catalogue_week_start('2026-10-18 23:59:59+00'), date '2026-10-12', 'Sunday 23:59 UTC is the previous week');
  perform _expect_eq(catalogue_week_start('2026-10-19 07:00:00+08'), date '2026-10-12', 'week is UTC, not local (Mon 07:00 +08 = Sun UTC)');

  -- ── 2. visibility ───────────────────────────────────────────────────────
  for i in 1..12 loop
    v := v || _mk_topic('v' || i, 'good', 'approved', 'public');
  end loop;
  hb := _mk_topic('hb', 'none',  'approved',  'public');
  hp := _mk_topic('hp', 'good',  'approved',  'private');
  hr := _mk_topic('hr', 'good',  'approved',  'public', 'retired');
  hn := _mk_topic('hn', 'good',  'in_review', 'public');
  vg := _mk_topic('vg', 'strong','approved',  'public', 'generating');
  t1 := v[1];

  perform _expect_eq((select count(*) from catalogue_current_kits() c where c.topic_id = any(v)), 12::bigint,
                     '12 approved/public/banked topics are visible');
  perform _expect_eq(exists (select 1 from catalogue_current_kits() where topic_id = hb), false, 'bank none: hidden');
  perform _expect_eq(exists (select 1 from catalogue_current_kits() where topic_id = hp), false, 'video private: hidden');
  perform _expect_eq(exists (select 1 from catalogue_current_kits() where topic_id = hr), false, 'retired topic: hidden');
  perform _expect_eq(exists (select 1 from catalogue_current_kits() where topic_id = hn), false, 'kit not approved (in_review) though video public: hidden');
  perform _expect_eq(exists (select 1 from catalogue_current_kits() where topic_id = vg), true,  'topic regenerating (status generating) keeps its published kit visible');

  -- Versioning: old kit public; newer kit approved but its video private.
  vv := _mk_topic('vv', 'good', 'approved', 'public', 'video_approved', now() - interval '3 days');
  select id into k_old from topic_kits where topic_id = vv;
  select id into a_vv from topic_articles where topic_id = vv;
  insert into topic_kits (topic_id, article_id, language, status, reviewed_at, doc_generation_ids)
  values (vv, a_vv, 'en', 'approved', now() - interval '1 hour', '{}') returning id into k_new;
  insert into topic_publications (topic_kit_id, part, channel_language, youtube_video_id, privacy)
  values (k_new, 1, 'en', 'yt_vv_new', 'private');
  perform _expect_eq((select topic_kit_id from catalogue_current_kits() where topic_id = vv), k_old,
                     'newer approved kit NOT public: the older public kit stays current');
  insert into _ids values ('vv', vv), ('k_old', k_old), ('k_new', k_new), ('t1', t1), ('hp', hp), ('vg', vg);
  for i in 1..12 loop insert into _ids values ('v' || i, v[i]); end loop;

  -- ── 3 + 4. unlocks ──────────────────────────────────────────────────────
  -- Free teacher: 1 a week.
  perform _as(T);
  r := unlock_catalogue_kit(t1);
  perform _expect_eq(r ->> 'status', 'unlocked', 'trial: first unlock of the week');
  perform _expect_eq((r ->> 'used')::int, 1,        'trial: used = 1');
  perform _expect_eq((r ->> 'cap')::int,  1,        'trial: cap = 1');
  perform _expect_eq(_status(T, t1), 'already',     'trial: re-opening an unlocked topic is free');
  perform _expect_eq((select count(*) from catalogue_unlocks where user_id = T), 1::bigint, 'trial: still one unlock row');
  perform _expect_eq(_status(T, v[2]), 'weekly_limit', 'trial: second topic this week refused');
  perform _expect_eq(_status(T, hp),   'not_available', 'hidden topic cannot be unlocked');

  -- Parent on the free tier: same 1 a week (parents are eligible).
  perform _expect_eq(_status(PAR, v[3]), 'unlocked',     'free parent: 1 a week');
  perform _expect_eq(_status(PAR, v[4]), 'weekly_limit', 'free parent: second refused');

  -- Teacher Pro: 5. Home Basic: 5.
  for i in 1..5 loop
    perform _expect_eq(_status(P, v[i]), 'unlocked', format('pro: unlock %s of 5', i));
  end loop;
  perform _expect_eq(_status(P, v[6]), 'weekly_limit', 'pro: 6th refused');
  for i in 1..5 loop perform _status(F, v[i]); end loop;
  perform _expect_eq(_status(F, v[6]), 'weekly_limit', 'Home Basic: 6th refused');

  -- Pro+: 10. Homeschool: 10.
  for i in 1..10 loop
    perform _expect_eq(_status(PP, v[i]), 'unlocked', format('pro+: unlock %s of 10', i));
  end loop;
  perform _expect_eq(_status(PP, v[11]), 'weekly_limit', 'pro+: 11th refused');
  for i in 1..10 loop perform _status(H, v[i]); end loop;
  perform _expect_eq(_status(H, v[11]), 'weekly_limit', 'homeschool: 11th refused');

  -- Unlimited: school coordinator, school admin, school trial, staff.
  for i in 1..12 loop
    perform _expect_eq(_status(S, v[i]), 'unlocked', format('school coordinator: unlock %s (unlimited)', i));
  end loop;
  for i in 1..12 loop perform _status(SA, v[i]); perform _status(ST, v[i]); perform _status(ADM, v[i]); end loop;
  perform _expect_eq((select count(*) from catalogue_unlocks where user_id = SA  and source = 'unlimited'), 12::bigint, 'school admin: 12 unlimited unlocks');
  perform _expect_eq((select count(*) from catalogue_unlocks where user_id = ST  and source = 'unlimited'), 12::bigint, 'school trial: 12 unlimited unlocks');
  perform _expect_eq((select count(*) from catalogue_unlocks where user_id = ADM and source = 'unlimited'), 12::bigint, 'staff: 12 unlimited unlocks');
  perform _expect_eq((select count(*) from catalogue_unlocks where user_id = S and source = 'allowance'), 0::bigint,
                     'unlimited unlocks never count as allowance');

  -- Refusals.
  perform _expect_eq(_status(STU, t1), 'forbidden_role', 'student cannot unlock');
  perform _expect_eq(_status(SUS, t1), 'suspended',      'suspended school member cannot unlock');
  update profiles set suspended_at = now() where id = PAR;
  perform _expect_eq(_status(PAR, v[3]), 'suspended',    'suspended account: refused even for its own topic');
  update profiles set suspended_at = null where id = PAR;

  -- School trial EXPIRES: unlimited ends, the free 1 a week applies, old unlocks stay.
  update schools set trial_ends_at = now() - interval '1 minute' where id = sch_trial;
  perform _expect_eq(plan_tier(ST), 'school_expired', 'trial school expired');
  perform _as(ST);
  perform _expect_eq(catalogue_has_access(v[5]), true, 'expired school: topics unlocked during the trial stay accessible');
  perform _expect_eq(_status(ST, hb), 'not_available', 'expired school: hidden still hidden');
  -- ST already holds all 12 visible fixtures; make a 13th and 14th to spend the free one.
  insert into _ids values ('x13', _mk_topic('x13', 'good', 'approved', 'public')),
                          ('x14', _mk_topic('x14', 'good', 'approved', 'public'));
  perform _expect_eq(_status(ST, (select id from _ids where name = 'x13')), 'unlocked',
                     'expired school: teacher still gets the personal free 1 a week');
  perform _expect_eq(_status(ST, (select id from _ids where name = 'x14')), 'weekly_limit',
                     'expired school: and only 1');

  -- Downgrade: Pro loses the plan; the 5 unlocks stay; this week is spent.
  update entitlements set active = false where user_id = P;
  perform _expect_eq(plan_tier(P), 'trial', 'pro downgraded to trial');
  perform _as(P);
  perform _expect_eq(catalogue_has_access(v[1]), true, 'downgrade: earlier unlocks remain');
  perform _expect_eq(_status(P, v[7]), 'weekly_limit', 'downgrade: 5 used >= free cap 1 this week');

  -- Weekly reset: last week's unlocks stay; the cap frees up.
  update catalogue_unlocks set week_start = week_start - 7 where user_id in (T, P);
  perform _expect_eq(_status(T, v[2]), 'unlocked', 'new week: free teacher unlocks again');
  perform _as(T);
  perform _expect_eq(catalogue_has_access(t1), true, 'new week: last week''s unlock still accessible');
  perform _expect_eq(_status(T, v[3]), 'weekly_limit', 'new week: still 1 a week');
  perform _expect_eq(_status(P, v[7]), 'unlocked', 'new week: downgraded pro gets the free 1');

  -- my_catalogue_allowance
  perform _as(PP);
  r := my_catalogue_allowance();
  perform _expect_eq((r ->> 'used')::int, 10, 'allowance: pro+ used 10');
  perform _expect_eq((r ->> 'cap')::int, 10,  'allowance: pro+ cap 10');
  perform _expect_eq((r ->> 'eligible')::boolean, true, 'allowance: pro+ eligible');
  perform _as(S);
  perform _expect_eq(my_catalogue_allowance() -> 'cap', 'null'::jsonb, 'allowance: school cap null (unlimited)');
  perform _as(STU);
  perform _expect_eq(my_catalogue_allowance() ->> 'reason', 'forbidden_role', 'allowance: student ineligible');

  -- ── 5. access + version resolution ──────────────────────────────────────
  perform _as(STU);
  perform _expect_eq(catalogue_has_access(t1), false, 'student: no access');
  perform _as(T);
  perform _expect_eq(catalogue_has_access(v[4]), false, 'no unlock row: no access');

  -- The free parent's unlock of vv happens on the OLD kit.
  perform _expect_eq(_status(ADM, vv), 'unlocked', 'staff unlocks the versioned topic');
  perform _expect_eq((select first_kit_id from catalogue_unlocks where user_id = ADM and topic_id = vv), k_old,
                     'unlock row records the kit current at unlock time');
  -- Publish the newer kit: access resolves to it; the unlock row is unchanged.
  update topic_publications set privacy = 'public' where topic_kit_id = k_new;
  perform _expect_eq((select topic_kit_id from catalogue_current_kits() where topic_id = vv), k_new,
                     'newer kit now public: catalogue resolves to the NEWER kit');
  perform _expect_eq((select first_kit_id from catalogue_unlocks where user_id = ADM and topic_id = vv), k_old,
                     'the unlock row still records the original kit (no rewrite)');
  perform _as(ADM);
  perform _expect_eq(catalogue_has_access(vv), true, 'access carries over to the newer kit without a new unlock');
  perform _expect_eq(_status(ADM, vv), 'already', 'and opening it costs nothing');
  -- The newer kit's video is superseded/withdrawn: back to the older public kit.
  update topic_publications set privacy = 'private' where topic_kit_id = k_new;
  perform _expect_eq((select topic_kit_id from catalogue_current_kits() where topic_id = vv), k_old,
                     'newer video withdrawn: the older public kit is current again');

  -- Withdrawal suppresses access for everyone, immediately; republish restores it.
  update topic_publications set privacy = 'private' where topic_kit_id = (select id from topic_kits where topic_id = t1);
  perform _as(S);
  perform _expect_eq(catalogue_has_access(t1), false, 'withdrawn topic: access suspended even for unlimited');
  perform _as(T);
  perform _expect_eq(catalogue_has_access(t1), false, 'withdrawn topic: access suspended for the unlocker');
  update topic_publications set privacy = 'public' where topic_kit_id = (select id from topic_kits where topic_id = t1);
  perform _expect_eq(catalogue_has_access(t1), true, 'republished: access returns without a new unlock');

  -- ── 6. public projection ────────────────────────────────────────────────
  r := (select to_jsonb(pc) from public_catalogue() pc where pc.slug = 'zz-0128-v1');
  perform _expect_eq(r is not null, true, 'public_catalogue returns a visible fixture by slug');
  perform _expect_eq(jsonb_array_length(r -> 'worked_examples'), 2, 'only two worked examples are public');
  perform _expect_eq(r -> 'videos' -> 0 ->> 'youtube_video_id', 'yt_v1', 'video id exposed');
  perform _expect_eq((r ->> 'question_count')::int, 0, 'question_count counts approved items (none yet)');
  perform _expect_eq(r::text ~* '(storage_path|generation_id|"stem"|"answer"|questions_json|canonical_key|topic_kit_id)', false,
                     'no paths, ids, stems, answers or internal keys in the public row');
  perform _expect_eq((select count(*) from public_catalogue() pc where pc.slug in ('zz-0128-hb','zz-0128-hp','zz-0128-hr','zz-0128-hn')),
                     0::bigint, 'hidden fixtures absent from the public projection');

  -- bank_maturity is DERIVED (topic_questions_maturity trigger: approved English
  -- items; basic >= 10). 12 items, 10 approved -> 'basic' -> still visible.
  insert into topic_questions (topic_id, article_id, language, item_type, answer_mode, difficulty,
                               cognitive_level, stem, answer, content_hash, status)
  select t1, a.id, 'en', 'mcq', 'objective', 2, 'recall', 'Q' || g, '{"k":"a"}', 'h0128' || g,
         case when g <= 10 then 'approved' else 'draft' end
  from topic_articles a, generate_series(1, 12) g where a.topic_id = t1;
  perform _expect_eq((select bank_maturity from topics where id = t1), 'basic', 'derived maturity: 10 approved = basic');
  perform _expect_eq((select question_count from public_catalogue() where slug = 'zz-0128-v1'), 10,
                     'question_count = approved items only (10 of 12)');
  -- The bank losing approval hides the topic for everyone, at once (D6).
  update topic_questions set status = 'retired' where topic_id = t1 and content_hash = 'h01281';
  perform _expect_eq((select bank_maturity from topics where id = t1), 'none', 'derived maturity: 9 approved = none');
  perform _expect_eq(exists (select 1 from public_catalogue() where slug = 'zz-0128-v1'), false,
                     'bank below basic: topic leaves the public catalogue');
  perform _as(T);
  perform _expect_eq(catalogue_has_access(t1), false, 'bank below basic: access suspended for the unlocker too');
  update topic_questions set status = 'approved' where topic_id = t1 and content_hash = 'h01281';
  perform _expect_eq(catalogue_has_access(t1), true, 'bank back to basic: access returns');

  -- ── 7. slugs ────────────────────────────────────────────────────────────
  perform _expect_eq((select count(*) from topics where slug is null), 0::bigint, 'every topic has a slug');
  perform _expect_eq((select count(*) - count(distinct slug) from topics), 0::bigint, 'slugs are unique');
  perform _expect_eq((select count(*) from topics where slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$'), 0::bigint, 'slugs are url-safe');
  insert into topics (canonical_key, title, subject) values ('zz-0128-dup', 'ZZ 0128 v1', 'Science');
  perform _expect_eq((select slug from topics where canonical_key = 'zz-0128-dup'), 'zz-0128-v1-2',
                     'a new topic with a taken title gets a suffixed slug');
  update topics set slug = 'zz-0128-renamed' where id = t1;
  perform _expect_eq((select topic_id from topic_slug_redirects where old_slug = 'zz-0128-v1'), t1,
                     'rename records the old slug');
  perform _expect_eq((select slug from public_catalogue_redirects() where old_slug = 'zz-0128-v1'), 'zz-0128-renamed',
                     'public redirect maps old -> new');

  -- ── 8. the other ledger is untouched ────────────────────────────────────
  perform _expect_eq((select count(*) from generations), gen_before,    'no generations row was written');
  perform _expect_eq((select count(*) from jobs), jobs_before,          'no job was enqueued');
  perform _expect_eq((select count(*) from credit_ledger), ledger_before, 'no credit was charged');
  perform _expect_eq((select count(*) from catalogue_events where event = 'weekly_limit'
                       and user_id = any(array[T, P, PP, F, H, PAR, ST])) > 0, true, 'weekly_limit events recorded');
  perform _expect_eq((select count(*) from catalogue_events where event = 'unlock' and user_id = T), 2::bigint,
                     'unlock events recorded (2 for the free teacher)');
end $$;

-- ── 6b. grants and RLS, as the real roles ────────────────────────────────
do $$
begin
  perform _expect_eq(has_function_privilege('anon', 'public.public_catalogue()', 'execute'),            true,  'anon may read public_catalogue');
  perform _expect_eq(has_function_privilege('anon', 'public.public_catalogue_redirects()', 'execute'),  true,  'anon may read redirects');
  perform _expect_eq(has_function_privilege('anon', 'public.unlock_catalogue_kit(uuid)', 'execute'),    false, 'anon may NOT unlock');
  perform _expect_eq(has_function_privilege('anon', 'public.catalogue_has_access(uuid)', 'execute'),    false, 'anon may NOT check access');
  perform _expect_eq(has_function_privilege('anon', 'public.catalogue_current_kits()', 'execute'),      false, 'anon may NOT read internal kit ids');
  perform _expect_eq(has_function_privilege('authenticated', 'public.catalogue_current_kits()', 'execute'), false, 'users may NOT read internal kit ids');
  perform _expect_eq(has_function_privilege('authenticated', 'public.catalogue_ineligible_reason(uuid)', 'execute'), false, 'users may NOT probe other users');
  perform _expect_eq(has_function_privilege('authenticated', 'public.unlock_catalogue_kit(uuid)', 'execute'), true, 'users may unlock');
  perform _expect_eq(has_table_privilege('authenticated', 'public.catalogue_unlocks', 'insert'), false, 'users may NOT insert unlocks directly');
  perform _expect_eq(has_table_privilege('authenticated', 'public.catalogue_unlocks', 'update'), false, 'users may NOT edit unlocks');
  perform _expect_eq(has_table_privilege('authenticated', 'public.catalogue_events', 'select'),  false, 'users may NOT read events');
  perform _expect_eq(has_table_privilege('anon', 'public.catalogue_unlocks', 'select'),          false, 'anon may NOT read unlocks');
end $$;

select _as('33333333-0128-0000-0000-000000000001');   -- the free teacher
set local role authenticated;
do $$
begin
  perform _expect_eq((select count(*) from catalogue_unlocks), 2::bigint,
                     'RLS: the free teacher sees exactly their own 2 unlock rows');
  perform _expect_eq((select count(*) from catalogue_unlocks where user_id <> auth.uid()), 0::bigint,
                     'RLS: no other user''s rows are visible');
end $$;
reset role;

do $$ begin raise notice 'ALL 0128 CHECKS PASSED'; end $$;
rollback;
