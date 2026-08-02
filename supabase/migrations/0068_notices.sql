-- 0068 — School notices: the announcement layer, built ON the calendar.
--
-- A notice IS a school_events row (0043), never a new table — that way it
-- inherits the audience RLS, the parent resolution (parents carry no school_id;
-- they belong through parent_links) and the ICS feed for free. The composer
-- offers two audiences only: 'school' (Everyone — staff, students, parents) and
-- 'staff' (staff only); 'leadership'/'class' stay for ordinary calendar use.
-- A notice is marked EXPLICITLY (is_notice, below) rather than inferred from
-- its audience, so nothing that is already on the calendar becomes an
-- announcement by surprise.
-- The notice columns add a link, a TWO-CLOCK countdown (action_by first, then
-- starts_at once the deadline passes — either may stand alone), an explicit
-- self-expiring banner pin, an importance mark, and a revocation only the
-- principal may set. notice_acks is the signature sheet: ONE row per PERSON,
-- not per child — a notice is about the school, so a parent of three signs
-- once. profiles.notices_seen_at is the bell-style watermark (0055/0064).
--
-- Gated in the app by FEATURE_NOTICES on top of the calendar gate.
--
-- ORDERING — 0052 (coordinator-scope hardening) also defines
-- calendar_events_for(uuid) and is ALREADY APPLIED in production, so 0068 must
-- be applied AFTER it. Re-running 0052 on top of 0068 would restore the
-- pre-notice resolver: revoked notices would come back to life in every
-- subscribed Google/Outlook/Apple calendar and pure-deadline notices would drop
-- out of the feed. If 0052 ever has to be re-run, re-run 0068 after it.
--
-- Run as ONE execution. Idempotent: safe to re-run.

-- ── Notice columns ────────────────────────────────────────────────────────────
alter table public.school_events
  -- What makes a row a NOTICE rather than an ordinary calendar entry. The
  -- composer sets it; EVERY reader surface (utils/notices.ts, the featured
  -- banner, the Next-10 card, the notification bell, the diary fan-in and the
  -- admin review block) filters on it.
  --
  -- WHY IT IS EXPLICIT AND NOT INFERRED FROM audience: production already holds
  -- 8 school_events rows, and 6 of them carry audience 'school' or 'staff'.
  -- Inferring "notice = school|staff audience" would have promoted all 6 onto
  -- the banner, the Next-10 card and the bell the moment this shipped — and the
  -- 2 'staff' ones would have started DEMANDING an acknowledgment from every
  -- member of staff for an event nobody ever published as a notice (staff
  -- notices always seek a signature). Defaulting false leaves those rows, and
  -- every ordinary calendar row written after this, behaving exactly as today.
  add column if not exists is_notice boolean not null default false,
  -- What the notice points at (a form, a payment page, a PDF). http(s) ONLY:
  -- the banner renders this as an <a href>, so a javascript:/data: URL pasted
  -- into the composer would be stored XSS. A belt to the app's own escaping.
  -- An UNUSED link must be written as NULL, never "" — '' fails this check.
  add column if not exists link_url   text
    check (link_url is null or link_url ~* '^https?://'),
  add column if not exists link_label text
    check (link_label is null or char_length(link_label) <= 60),
  -- Clock one: what the reader must DO, and by when ("Register by"). Fully
  -- independent of starts_at — a notice may be a deadline with no event.
  add column if not exists action_by    timestamptz,
  add column if not exists action_label text
    check (action_label is null or char_length(action_label) <= 40),
  -- Banner pin — EXPLICIT and self-expiring; nothing is ever auto-featured.
  -- The "max 3" is a display rule (the banner takes the 3 soonest-expiring live
  -- pins), deliberately not a constraint: over-pinning should quietly show the
  -- top three, not fail a principal's compose at 7am.
  add column if not exists featured_until timestamptz,
  -- Revocation. School_admin only (se_revoke_admin_only); the row SURVIVES for
  -- audit while every reader-facing path filters status = 'published'.
  add column if not exists status text not null default 'published'
    check (status in ('published', 'revoked')),
  add column if not exists revoked_by uuid references public.profiles(id) on delete set null,
  add column if not exists revoked_at timestamptz,
  -- 'important' is what makes an Everyone notice seek acknowledgment. Staff
  -- notices always seek it, whatever this says (the rule lives in the app —
  -- an ack is never REQUIRED by the database, only invited).
  add column if not exists importance text not null default 'normal'
    check (importance in ('normal', 'important'));

-- A pure deadline ("School fees due 15 August") is a notice with an action_by
-- and NO event date, so starts_at gives up its NOT NULL. Every row must still
-- carry at least one date — the countdown, the day buckets and the Upcoming
-- list have nothing to sort on otherwise.
alter table public.school_events alter column starts_at drop not null;
alter table public.school_events drop constraint if exists school_events_has_a_date;
alter table public.school_events add constraint school_events_has_a_date
  check (starts_at is not null or action_by is not null);

create index if not exists school_events_featured_idx
  on public.school_events (school_id, featured_until) where featured_until is not null;
create index if not exists school_events_action_idx
  on public.school_events (school_id, action_by) where action_by is not null;
-- is_notice is now a predicate on EVERY notice read (banner, card, bell, review
-- block), and notices are the small minority of a school's calendar — a partial
-- index keeps those reads off the calendar's own (school_id, starts_at) index.
create index if not exists school_events_notice_idx
  on public.school_events (school_id, starts_at) where is_notice;

-- Who pulled it and when, stamped by the database rather than trusted from the
-- client — the app writes status alone. Un-revoking clears the stamp so a
-- second withdrawal can't wear the first one's date. SECURITY DEFINER for the
-- same reason as 0066's ack invalidator: this must hold for every writer.
create or replace function public.school_event_stamp_revocation() returns trigger
  language plpgsql security definer set search_path = public as
$$ begin
  if new.status = 'revoked' then
    if old.status is distinct from 'revoked' then
      new.revoked_at := now();
      new.revoked_by := coalesce(auth.uid(), new.revoked_by);
    end if;
  else
    new.revoked_at := null;
    new.revoked_by := null;
  end if;
  return new;
end $$;
drop trigger if exists school_events_stamp_revocation on public.school_events;
create trigger school_events_stamp_revocation before update on public.school_events
  for each row execute function public.school_event_stamp_revocation();

-- ── Acknowledgments ───────────────────────────────────────────────────────────
-- "I have read this." One per (notice × person) — NOT per child like the diary
-- (0066): a diary note is about one family's child, a notice is about the
-- school, so a parent with three children signs once. Insert-only: a receipt,
-- never a toggle. The composite PK doubles as the event_id index.
create table if not exists public.notice_acks (
  event_id uuid not null references public.school_events(id) on delete cascade,
  user_id  uuid not null references public.profiles(id) on delete cascade,
  acked_at timestamptz not null default now(),
  primary key (event_id, user_id)
);
-- "Which of these have I signed?" reads the other way round from the PK.
create index if not exists notice_acks_user_idx on public.notice_acks (user_id);

-- An ack is a receipt for SPECIFIC TEXT: "I read THIS." The composer's edit
-- path exists so a principal can fix a typo, but if what the notice actually
-- SAYS changes — its title, its body, the deadline it counts down to or the
-- event date it moves to — the signatures already collected no longer attest to
-- it, so they are cleared and everyone is asked again. Without this, "Optional
-- PD session, Wednesday" can be edited into "Mandatory Saturday duty" while
-- keeping all 14 signatures, and the review block would show a staff meeting
-- nobody actually agreed to as read-and-signed.
--
-- 0066's diary_ack_invalidate shape exactly, including SECURITY DEFINER: no ack
-- DELETE policy exists (and shouldn't) — a receipt is never hand-removable,
-- only invalidated by the edit itself. Deliberately OUT of the WHEN list:
-- status, importance, audience and featured_until change WHO is asked or how
-- loudly, not what was said.
create or replace function public.notice_ack_invalidate() returns trigger
  language plpgsql security definer set search_path = public as
$$ begin
  delete from notice_acks where event_id = old.id;
  return null;
end $$;
drop trigger if exists school_events_invalidate_acks on public.school_events;
create trigger school_events_invalidate_acks after update on public.school_events
  for each row
  when (old.title       is distinct from new.title
     or old.description is distinct from new.description
     or old.action_by   is distinct from new.action_by
     or old.starts_at   is distinct from new.starts_at)
  execute function public.notice_ack_invalidate();

-- ── Watermark (0055/0064 pattern) ─────────────────────────────────────────────
-- "What have I already seen" — anything published since counts as unread on the
-- bell. No backfill: NULL just means "never opened notices".
alter table public.profiles add column if not exists notices_seen_at timestamptz;

-- 0010 closed profile self-escalation with COLUMN-level grants; expose exactly
-- this one benign column on the user's own row (profiles_update_self applies).
grant update (notices_seen_at) on public.profiles to authenticated;

-- ── Affiliation hardening (0043 helpers, tightened) ───────────────────────────
-- A parent_links row is either SCHOOL-issued (invite accept, seed) or SELF-made
-- (/api/children — a parent registering their own child at home). Only the
-- first is an affiliation with the school; the second is a private family link
-- that happens to point at a student account.
--
-- WHY IT MATTERS: school features are paid for BY THE SCHOOL. Nothing stops a
-- self-created child's profile from later acquiring a school_id (a school
-- claims the account, an admin fixes a mis-keyed row, a seed reuses a uid) —
-- and the moment it does, the unhardened helper below would hand that parent
-- the school's calendar, its notices and its schools row, without the school
-- ever having invited them. Requiring source = 'school' means the school
-- itself is always the one that opened the door. Zero behaviour change today:
-- self-made children carry school_id = null (children/route.ts sets it), so
-- they never matched these helpers anyway.
create or replace function parent_of_school(sid uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select exists (select 1 from parent_links pl join profiles ch on ch.id = pl.child_id
                  where pl.parent_id = auth.uid() and pl.source = 'school' and ch.school_id = sid); $$;

create or replace function parent_of_class(cid uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select exists (select 1 from parent_links pl join enrollments e on e.student_id = pl.child_id
                  where pl.parent_id = auth.uid() and pl.source = 'school' and e.class_id = cid); $$;

-- ── Notice helpers (SECURITY DEFINER — 0008 doctrine, no RLS recursion) ───────
-- The full se_read rule keyed by event id, so notice_acks can inherit
-- visibility without restating the audience branches. status is part of it: a
-- revoked notice is un-signable, not merely hidden. Mirrors se_read (minus its
-- leadership-audit branch) — this is now the THIRD copy of the audience rule
-- alongside se_read and calendar_events_for; keep all three in step.
create or replace function public.school_event_readable(eid uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select exists (
     select 1 from school_events ev
     where ev.id = eid
       and ev.status = 'published'
       and case ev.audience
         when 'leadership' then leader_of_school(ev.school_id)
         when 'staff'      then adult_of_school(ev.school_id)
         when 'school'     then member_of_school(ev.school_id) or parent_of_school(ev.school_id)
         else ev.class_id is not null and (
           owns_class(ev.class_id) or enrolled_in_class(ev.class_id)
           or leader_of_school(ev.school_id) or parent_of_class(ev.class_id)
         )
       end
   ) $$;

-- The school side of a notice: whoever published it — for as long as they still
-- belong to its school — plus the leadership of the school it belongs to
-- (0066's oversight shape). They are the ones who need "read by 14 of 18
-- staff", so they see the whole signature sheet; nobody else sees any signature
-- but their own.
--
-- The author branch carries its tenant bound EXPLICITLY (join profiles me on
-- me.school_id = ev.school_id), mirroring how 0052 hardened the coordinates_*
-- helpers and leader_of_school. A bare created_by = auth.uid() has no school in
-- it at all: a coordinator who moves on — invite-accept rewrites
-- profiles.school_id and 0052's trigger drops their coordinator_scope rows, so
-- every other leadership check goes dark — would keep SELECT on their former
-- school's entire notice_acks sheet, name by name, for every notice they ever
-- published. 0052 exists to kill exactly that retention. leader_of_school is
-- already bound this way, so only this branch needed it.
create or replace function public.school_event_oversight(eid uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select exists (select 1 from school_events ev
                  where ev.id = eid
                    and ((ev.created_by = auth.uid()
                          and exists (select 1 from profiles me
                                      where me.id = auth.uid() and me.school_id = ev.school_id))
                         or leader_of_school(ev.school_id))); $$;

-- ── RLS: school_events ────────────────────────────────────────────────────────
-- Read, with revocation folded in FRONT of 0043's audience case: a revoked
-- notice leaves the banner, the dashboards and the diary fan-in for everyone
-- but leadership, who keep reading it for audit. (Leadership surfaces that show
-- LIVE notices must still filter status themselves — RLS deliberately does not
-- hide the evidence from the people responsible for it.)
drop policy if exists se_read on school_events;
create policy se_read on school_events for select using (
  (status = 'published' or leader_of_school(school_id))
  and case audience
    when 'leadership' then leader_of_school(school_id)
    when 'staff'      then adult_of_school(school_id)
    when 'school'     then member_of_school(school_id) or parent_of_school(school_id)
    else class_id is not null and (
      owns_class(class_id) or enrolled_in_class(class_id)
      or leader_of_school(school_id) or parent_of_class(class_id)
    )
  end
);

-- Coordinators had NO write path at all (0043 gave writes to school_admin and
-- class-owning teachers only), yet they are the ones who actually run "Year 4
-- swimming starts Monday". They publish school-wide and staff-wide notices in
-- their own school — nothing class-targeted (that stays the teacher's), nothing
-- leadership-only, and never a revocation.
--
-- Scoped to rows they created: a coordinator publishing alongside the principal
-- must not be able to edit or delete the principal's fee notice. THE COMPOSER
-- MUST SET created_by = the caller on insert (the 0043 event editor already
-- does) or this policy refuses the row. leader_of_school also matches the
-- school_admin, which is harmless — se_admin_write already grants them more.
drop policy if exists se_coordinator_write on school_events;
create policy se_coordinator_write on school_events for all
  using (source = 'native' and audience in ('school', 'staff')
         and school_id = current_school_id() and leader_of_school(school_id)
         and created_by = auth.uid())
  with check (source = 'native' and audience in ('school', 'staff')
              and school_id = current_school_id() and leader_of_school(school_id)
              and created_by = auth.uid()
              and class_id is null and status = 'published');

-- 0043's teacher policy, unchanged except that a teacher cannot revoke (their
-- own class events included) — withdrawal is a principal's act by design.
drop policy if exists se_teacher_write on school_events;
create policy se_teacher_write on school_events for all
  using (source = 'native' and audience = 'class' and class_id is not null and owns_class(class_id))
  with check (source = 'native' and audience = 'class' and class_id is not null
              and owns_class(class_id) and school_id = current_school_id()
              and class_in_school(class_id, school_id) and status = 'published');

-- Belt to the two with-checks above: RESTRICTIVE, so it ANDs with every
-- permissive write policy present or future. Revocation belongs to the
-- school_admin in BOTH directions — the WITH CHECK stops anyone else landing a
-- row in the revoked state, and the USING stops them touching a row that is
-- already there. Without the USING half, the author of a withdrawn notice could
-- simply update status back to 'published' (their own write policy's check
-- passes) and un-revoke the principal's decision. FOR UPDATE only: a
-- RESTRICTIVE FOR ALL would also apply to SELECT and blind leadership to the
-- very rows they keep for audit.
drop policy if exists se_revoke_admin_only on school_events;
create policy se_revoke_admin_only on school_events as restrictive for update
  using (status = 'published'
         or (current_role_val() = 'school_admin' and school_id = current_school_id()))
  with check (status = 'published'
              or (current_role_val() = 'school_admin' and school_id = current_school_id()));

-- Revoked means WITHDRAWN, not erased (0015's removed-row freeze, same shape):
-- the row is the audit trail of what the school said and when it took it back,
-- so it cannot be deleted while it wears the marker. A genuine mistake is still
-- cleanable — un-revoke first (the review block's Restore action), then delete.
--
-- The delete freeze is only safe because withdrawal is NOT a one-way door, so
-- the un-revoke was traced against every policy on this table: school_admin,
-- own school, native row, status 'revoked' → 'published'.
--   * permissive UPDATE — se_admin_write (0043) passes both halves (its USING
--     says nothing about status, and a notice carries no class_id).
--   * se_revoke_admin_only (restrictive) — USING is evaluated on the OLD row
--     (status 'revoked', so the first branch is false and the school_admin
--     branch carries it) and WITH CHECK on the NEW one (status 'published', so
--     the first branch carries it). BOTH halves pass; this was the half worth
--     checking, because the row crosses the fence in the "wrong" direction.
--     It is also the ONLY thing that keeps a coordinator or teacher out of the
--     restore: their own WITH CHECK is happy with a published row, so it is this
--     policy's USING half, on the OLD revoked row, that refuses them. The hand
--     that withdraws is the only one that can put it back — by design.
--   * school_events_not_suspended (restrictive, below) — passes while the
--     admin is not suspended.
--   * se_read still returns the row (its leader_of_school branch keeps revoked
--     rows visible to leadership), so a returning-representation update has
--     something to hand back.
-- The stamp trigger clears revoked_at/revoked_by on the way through, so a later
-- second withdrawal can never wear the first one's date.
drop policy if exists se_revoked_nodelete on school_events;
create policy se_revoked_nodelete on school_events as restrictive for delete
  using (status = 'published');

-- ── RLS: notice_acks ──────────────────────────────────────────────────────────
alter table public.notice_acks enable row level security;

-- Sign for yourself, on a NOTICE you can actually read. The is_notice term is
-- belt to the route's brace: an ordinary calendar event never asks for a
-- signature, so it must never be able to collect one — otherwise a stray ack
-- would sit against a row no reader surface will ever show, and the school's
-- "read by N of M" arithmetic would count a receipt nobody was asked for.
drop policy if exists na_insert on public.notice_acks;
create policy na_insert on public.notice_acks for insert
  with check (user_id = auth.uid()
              and school_event_readable(event_id)
              and exists (select 1 from school_events ev
                          where ev.id = event_id and ev.is_notice));

-- Your own receipts, plus the school's chase list for leadership. A staff-room
-- notice's signature sheet is not staff-room business.
drop policy if exists na_read on public.notice_acks;
create policy na_read on public.notice_acks for select
  using (user_id = auth.uid() or school_event_oversight(event_id));

-- No update/delete policy — a receipt is not retractable. RLS already denies
-- both by default; dropping the grants too (0067's doctrine) means a future
-- permissive policy can't reopen it by accident. service_role is unaffected.
revoke update, delete on public.notice_acks from anon, authenticated;

-- ── Suspension (0015 idiom) ───────────────────────────────────────────────────
-- 0015 asked that new user-data tables join its list. notice_acks is new here;
-- school_events was left off when 0043 wrote it, and notices are what turn that
-- omission into a hole worth closing. Suspension is enforced at the auth layer
-- against NEW logins, but an access token already in a suspended principal's
-- browser stays live for about an hour — long enough to publish one more
-- school-wide notice that reaches every parent, every student and every
-- subscribed calendar, which is the loudest thing this product can do.
--
-- This WIDENS behaviour beyond notices: a suspended account also loses the
-- ordinary school calendar, read and write. That is correct — an account that
-- may not open its books, its classes or the diary (0015, 0066) has no business
-- writing the school's calendar either.
--
-- RESTRICTIVE FOR ALL with only USING: the USING expression doubles as the
-- WITH CHECK, so inserts are covered too. The ICS feed is unaffected — it runs
-- through calendar_events_for under the service role, which bypasses RLS.
do $$
declare t text;
begin
  foreach t in array array['school_events', 'notice_acks']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_not_suspended', t);
    execute format(
      'create policy %I on public.%I as restrictive for all using (not current_user_suspended())',
      t || '_not_suspended', t);
  end loop;
end $$;

-- ── Feed resolver (0043, hardened by 0052 — now revocation-aware) ─────────────
-- The ICS feed is the one read path that does NOT go through se_read, so a
-- revoked notice would otherwise keep living in every Google/Outlook/Apple
-- calendar that ever subscribed. Three changes from 0052: status = 'published',
-- the parent branches require a SCHOOL-issued link (mirroring parent_of_school
-- above), and the date window keys off coalesce(starts_at, action_by) so a
-- PURE-DEADLINE notice ("consent forms due Friday" — no event, just a due
-- date) still reaches subscribed calendars. The feed route pairs with this by
-- mapping DTSTART to `starts_at ?? action_by`; the has_a_date constraint
-- guarantees the coalesce can never be null.
create or replace function calendar_events_for(uid uuid)
returns setof school_events
language sql
stable
security definer
set search_path = public
as $$
  select ev.* from school_events ev
  where ev.status = 'published'
    and coalesce(ev.starts_at, ev.action_by) > now() - interval '60 days'
    and coalesce(ev.starts_at, ev.action_by) < now() + interval '400 days'
    and (
      (ev.audience = 'leadership' and (
         exists (select 1 from profiles p where p.id = uid and p.school_id = ev.school_id and p.role = 'school_admin')
         or exists (select 1 from coordinator_scope cs
                    join profiles cp on cp.id = cs.coordinator_id and cp.school_id = cs.school_id
                    where cs.coordinator_id = uid and cs.school_id = ev.school_id)))
      or (ev.audience = 'staff' and
         exists (select 1 from profiles p where p.id = uid and p.school_id = ev.school_id and p.role <> 'student'))
      or (ev.audience = 'school' and (
         exists (select 1 from profiles p where p.id = uid and p.school_id = ev.school_id)
         or exists (select 1 from parent_links pl join profiles ch on ch.id = pl.child_id
                    where pl.parent_id = uid and pl.source = 'school' and ch.school_id = ev.school_id)))
      or (ev.audience = 'class' and ev.class_id is not null and (
         exists (select 1 from classes c where c.id = ev.class_id and c.teacher_id = uid)
         or exists (select 1 from enrollments e where e.class_id = ev.class_id and e.student_id = uid)
         or exists (select 1 from profiles p where p.id = uid and p.school_id = ev.school_id and p.role = 'school_admin')
         or exists (select 1 from coordinator_scope cs
                    join profiles cp on cp.id = cs.coordinator_id and cp.school_id = cs.school_id
                    where cs.coordinator_id = uid and cs.school_id = ev.school_id)
         or exists (select 1 from parent_links pl join enrollments e on e.student_id = pl.child_id
                    where pl.parent_id = uid and pl.source = 'school' and e.class_id = ev.class_id)))
    )
  order by ev.starts_at;
$$;

-- ── EXECUTE lockdown (0044 doctrine) ──────────────────────────────────────────
-- Postgres grants EXECUTE on every new function to PUBLIC implicitly, and anon
-- INHERITS it — every helper here would be callable through PostgREST
-- (/rest/v1/rpc) by anyone holding the public anon key. These are RLS policy
-- helpers, so `authenticated` genuinely needs EXECUTE (policy expressions run
-- with the caller's privileges); nothing else does. service_role is NOT
-- re-granted: it bypasses RLS, so it never evaluates them. The 0043 pair rides
-- along — replaced here, and never locked down when they were first written.
do $$
declare f text;
begin
  foreach f in array array[
    'school_event_stamp_revocation()',
    'notice_ack_invalidate()',
    'school_event_readable(uuid)',
    'school_event_oversight(uuid)',
    'parent_of_school(uuid)',
    'parent_of_class(uuid)']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- calendar_events_for is the exception: it takes an arbitrary uid and is called
-- ONLY by the feed route's service-role client after resolving a token, so no
-- session role gets EXECUTE at all (0043's note — PUBLIC must be in the list).
revoke execute on function public.calendar_events_for(uuid) from public, anon, authenticated;
