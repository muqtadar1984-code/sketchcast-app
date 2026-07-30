-- 0066 — Class diary: the daily teacher↔home communication book.
--
-- A note targets EXACTLY ONE of a class (class-wide) or a student (personal) —
-- the 0018 shares XOR idiom. Teachers write to classes they own or students
-- they teach; parents write per-student notes about their own children only.
-- Students REPLY (never author notes) and never see parents_only rows; parents
-- ACK a note per child (the "signed the diary" receipt). Leadership
-- (school_admin + coordinator, via the 0009/0052 helpers) reads everything in
-- scope but can write NOTHING — no insert path exists for them by design.
-- diary_translations is a service-role-only cache (0039 idiom) the translate
-- API fills; profiles.diary_seen_at is the bell-style watermark (0055/0064).
--
-- PRIVACY ON A CLASS-WIDE NOTE — the audience is many families, so two things
-- are scoped down from "everyone who can read the note":
--   * acks (who signed) are visible to the signing parent and the school side
--     (author/teacher/leadership) only — never to the other families.
--   * replies carry student_id: a family's reply is visible to that family and
--     the school side; NULL means a teacher/author broadcast and stays
--     class-visible. Personal notes ignore it — their audience is one family.
-- Suspended accounts are cut off by the 0015 RESTRICTIVE idiom, and every
-- helper below has its implicit PUBLIC execute revoked (0044 doctrine).
--
-- Gated in the app by FEATURE_DIARY. Idempotent: safe to re-run.

-- ── Tables ────────────────────────────────────────────────────────────────────
create table if not exists public.diary_notes (
  id           uuid primary key default gen_random_uuid(),
  author_id    uuid not null references public.profiles(id) on delete cascade,
  class_id     uuid references public.classes(id) on delete cascade,
  student_id   uuid references public.profiles(id) on delete cascade,
  note_type    text not null default 'general'
               check (note_type in ('homework', 'reminder', 'praise', 'concern', 'health', 'general')),
  body         text not null check (char_length(body) between 1 and 4000),
  parents_only boolean not null default false,   -- hidden from the student, visible to parents/teachers
  entry_date   date not null default current_date,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (num_nonnulls(class_id, student_id) = 1)  -- class-wide XOR personal (0018)
);
create index if not exists diary_notes_class_date_idx   on public.diary_notes (class_id, entry_date);
create index if not exists diary_notes_student_date_idx on public.diary_notes (student_id, entry_date);

create table if not exists public.diary_replies (
  id         uuid primary key default gen_random_uuid(),
  note_id    uuid not null references public.diary_notes(id) on delete cascade,
  author_id  uuid not null references public.profiles(id) on delete cascade,
  -- Which child this reply is ABOUT, on a class-wide note — the API sets it to
  -- the replying family's child so "Aisha's rash is better" doesn't broadcast
  -- to thirty households. NULL = a teacher/author broadcast (class-visible).
  -- Ignored on personal notes, whose audience is already one family. See
  -- diary_reply_visible() / dr_read.
  student_id uuid references public.profiles(id) on delete cascade,
  body       text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists diary_replies_note_idx on public.diary_replies (note_id);
-- For databases where 0066 already ran before student_id existed.
alter table public.diary_replies
  add column if not exists student_id uuid references public.profiles(id) on delete cascade;

-- One ack per (note × parent × child) — a parent with two children in the same
-- class signs once per child. The composite PK doubles as the note_id index.
create table if not exists public.diary_acks (
  note_id    uuid not null references public.diary_notes(id) on delete cascade,
  parent_id  uuid not null references public.profiles(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  acked_at   timestamptz not null default now(),
  primary key (note_id, parent_id, student_id)
);

-- Translation cache: one row per (note-or-reply × language), written only by
-- the translate API's admin client after an RLS-scoped visibility check.
-- target_id is polymorphic (note OR reply) so it carries no FK — the cleanup
-- trigger below keeps it from accumulating orphans.
create table if not exists public.diary_translations (
  id          uuid primary key default gen_random_uuid(),
  target_kind text not null check (target_kind in ('note', 'reply')),
  target_id   uuid not null,
  lang        text not null,
  body        text not null,
  created_at  timestamptz not null default now(),
  unique (target_kind, target_id, lang)
);

-- ── Watermark (0055/0064 pattern) ─────────────────────────────────────────────
-- "What have I already seen" — anything newer than this counts as unread. No
-- backfill: NULL just means "never opened the diary", same as the bell.
alter table public.profiles add column if not exists diary_seen_at timestamptz;

-- 0010 closed profile self-escalation with COLUMN-level grants; expose exactly
-- this one benign column on the user's own row (profiles_update_self applies).
grant update (diary_seen_at) on public.profiles to authenticated;

-- ── Housekeeping triggers ─────────────────────────────────────────────────────
drop trigger if exists diary_notes_touch on public.diary_notes;
create trigger diary_notes_touch before update on public.diary_notes
  for each row execute function public.touch_updated_at();

-- An ack is a RECEIPT: "I, this parent, read THIS text." dn_author_update lets
-- an author fix a typo, but if they change what was actually said — the body,
-- the note_type (a 'reminder' quietly becoming a 'concern'), or the
-- parents_only audience — the existing signatures no longer attest to it, so
-- they are cleared and the parents are asked to sign again. SECURITY DEFINER
-- because no ack DELETE policy exists (and shouldn't): a parent's receipt is
-- never hand-removable, only invalidated by the edit itself.
create or replace function public.diary_ack_invalidate() returns trigger
  language plpgsql security definer set search_path = public as
$$ begin
  delete from diary_acks where note_id = old.id;
  return null;
end $$;
drop trigger if exists diary_notes_invalidate_acks on public.diary_notes;
create trigger diary_notes_invalidate_acks after update on public.diary_notes
  for each row
  when (old.body         is distinct from new.body
     or old.note_type    is distinct from new.note_type
     or old.parents_only is distinct from new.parents_only)
  execute function public.diary_ack_invalidate();

-- Deleting a note (or a reply — the cascade fires row triggers too) drops its
-- cached translations, since the polymorphic target_id can't hold an FK.
create or replace function public.diary_drop_translations() returns trigger
  language plpgsql security definer set search_path = public as
$$ begin
  delete from diary_translations
  where target_kind = case tg_table_name when 'diary_notes' then 'note' else 'reply' end
    and target_id = old.id;
  return old;
end $$;
drop trigger if exists diary_notes_drop_translations on public.diary_notes;
create trigger diary_notes_drop_translations after delete on public.diary_notes
  for each row execute function public.diary_drop_translations();
drop trigger if exists diary_replies_drop_translations on public.diary_replies;
create trigger diary_replies_drop_translations after delete on public.diary_replies
  for each row execute function public.diary_drop_translations();

-- ── Visibility helpers (SECURITY DEFINER — 0008 doctrine, no RLS recursion) ───
-- Each takes the note's (class_id, student_id) target pair; exactly one is set.

-- Teacher side: owns the target class, or teaches the target student.
create or replace function public.diary_teacher_of(cls uuid, stu uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select (cls is not null and owns_class(cls))
       or (stu is not null and teaches_student(stu)) $$;

-- Parent side: their own child, or a class one of their children is in (0018).
create or replace function public.diary_parent_of_target(cls uuid, stu uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select (stu is not null and is_parent_of(stu))
       or (cls is not null and parent_child_in_class(cls)) $$;

-- Student side: the note is about me, or about a class I'm enrolled in.
create or replace function public.diary_student_target(cls uuid, stu uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select (stu is not null and stu = auth.uid())
       or (cls is not null and enrolled_in_class(cls)) $$;

-- Leadership side (READ-ONLY — never referenced by any write policy):
-- school_admin via the 0009/0018 school checks, coordinator via 0009's
-- scope helpers (hardened in 0052 — same signatures).
create or replace function public.diary_leader_of(cls uuid, stu uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select (cls is not null and (admin_school_class(cls) or coordinates_class(cls)))
       or (stu is not null and (admin_school_student(stu) or coordinates_student(stu))) $$;

-- Full read rule for a note — everything dn_read grants, keyed by note id, so
-- replies/acks can inherit visibility without re-stating the branches.
create or replace function public.diary_note_readable(nid uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select exists (
     select 1 from diary_notes n
     where n.id = nid
       and (n.author_id = auth.uid()
            or diary_teacher_of(n.class_id, n.student_id)
            or diary_parent_of_target(n.class_id, n.student_id)
            or (diary_student_target(n.class_id, n.student_id) and not n.parents_only)
            or diary_leader_of(n.class_id, n.student_id))
   ) $$;

-- Participant rule = readable MINUS leadership. Powers the reply/ack write
-- checks, so a principal/coordinator can read the diary but never write into
-- it. A student caller only ever matches the student branch (they can't own
-- classes or hold parent_links — 0018's sanity trigger), so parents_only
-- notes are un-reply-able for them by construction.
create or replace function public.diary_note_participant(nid uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select exists (
     select 1 from diary_notes n
     where n.id = nid
       and (n.author_id = auth.uid()
            or diary_teacher_of(n.class_id, n.student_id)
            or diary_parent_of_target(n.class_id, n.student_id)
            or (diary_student_target(n.class_id, n.student_id) and not n.parents_only))
   ) $$;

-- School side of a note = its author + the teacher(s) over its target +
-- leadership. These see the WHOLE audience: every signature, every family's
-- reply. Everyone else sees only their own family's slice. (Read-only for
-- leadership — this helper is never used in a write check on its own.)
create or replace function public.diary_note_oversight(nid uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select exists (
     select 1 from diary_notes n
     where n.id = nid
       and (n.author_id = auth.uid()
            or diary_teacher_of(n.class_id, n.student_id)
            or diary_leader_of(n.class_id, n.student_id))
   ) $$;

-- Does the note concern THIS student? (directly, or via their class) — the
-- ack write check, as a helper rather than a raw cross-table subquery (0008).
-- Gated on diary_note_readable so it can't be used as a bare "is student S in
-- class C?" enrollment oracle by a caller who can't see the note at all (its
-- EXECUTE is also locked to authenticated at the foot of this file, 0044).
create or replace function public.diary_note_targets_student(nid uuid, stu uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select diary_note_readable(nid) and exists (
     select 1 from diary_notes n
     where n.id = nid
       and (n.student_id = stu
            or (n.class_id is not null and exists (
                  select 1 from enrollments e
                  where e.class_id = n.class_id and e.student_id = stu)))
   ) $$;

-- Reply visibility, keyed by the reply's (note_id, student_id).
--   * school side (author/teacher/leadership) → the whole thread;
--   * personal note → today's rule, the audience is already one family;
--   * class-wide note → the reply's own family only, unless student_id is NULL
--     (a teacher/author broadcast), which the whole class audience reads.
-- The reply's own author is allowed separately in dr_read, so a reply is never
-- invisible to the person who wrote it.
create or replace function public.diary_reply_visible(nid uuid, sid uuid) returns boolean
  language sql stable security definer set search_path = public as
$$ select exists (
     select 1 from diary_notes n
     where n.id = nid
       and (
         n.author_id = auth.uid()
         or diary_teacher_of(n.class_id, n.student_id)
         or diary_leader_of(n.class_id, n.student_id)
         or (n.student_id is not null
             and (diary_parent_of_target(n.class_id, n.student_id)
                  or (diary_student_target(n.class_id, n.student_id) and not n.parents_only)))
         or (n.class_id is not null
             and (sid is null or is_parent_of(sid) or sid = auth.uid())
             and (diary_parent_of_target(n.class_id, n.student_id)
                  or (diary_student_target(n.class_id, n.student_id) and not n.parents_only)))
       )
   ) $$;

-- ── RLS ───────────────────────────────────────────────────────────────────────
alter table public.diary_notes        enable row level security;
alter table public.diary_replies      enable row level security;
alter table public.diary_acks         enable row level security;
alter table public.diary_translations enable row level security;

-- translations: no policies → service-role only (0039 idiom).
revoke all on public.diary_translations from anon, authenticated;

-- notes: teachers author into their own classes / students they teach; parents
-- author per-student notes about their own children ONLY (never class-wide).
-- No leadership branch — leadership is read-only everywhere in the diary.
drop policy if exists dn_insert on public.diary_notes;
create policy dn_insert on public.diary_notes for insert
  with check (author_id = auth.uid()
              and (diary_teacher_of(class_id, student_id)
                   or (student_id is not null and is_parent_of(student_id))));

drop policy if exists dn_read on public.diary_notes;
create policy dn_read on public.diary_notes for select
  using (author_id = auth.uid()
         or diary_teacher_of(class_id, student_id)
         or diary_parent_of_target(class_id, student_id)
         or (diary_student_target(class_id, student_id) and not parents_only)
         or diary_leader_of(class_id, student_id));

-- Authors edit/delete their own notes. The update WITH CHECK re-asserts the
-- insert-shape authority so an author can't RETARGET a note at a class or
-- student they have no standing over (which would inject it into that
-- audience's diary).
drop policy if exists dn_author_update on public.diary_notes;
create policy dn_author_update on public.diary_notes for update
  using (author_id = auth.uid())
  with check (author_id = auth.uid()
              and (diary_teacher_of(class_id, student_id)
                   or (student_id is not null and is_parent_of(student_id))));
drop policy if exists dn_author_delete on public.diary_notes;
create policy dn_author_delete on public.diary_notes for delete
  using (author_id = auth.uid());

-- replies: any PARTICIPANT on the note may reply (leadership excluded by the
-- helper). student_id, when set, must be a child the writer speaks for AND be
-- in the note's audience — so a parent can't file their reply into ANOTHER
-- family's thread. The school side may set it to any student the note covers
-- (replying to one family under a class-wide note); anyone may leave it NULL,
-- which on a class-wide note means "say this to the whole class".
drop policy if exists dr_insert on public.diary_replies;
create policy dr_insert on public.diary_replies for insert
  with check (author_id = auth.uid()
              and diary_note_participant(note_id)
              and (student_id is null
                   or (diary_note_targets_student(note_id, student_id)
                       and (is_parent_of(student_id)
                            or student_id = auth.uid()
                            or diary_note_oversight(note_id)))));

-- Read: the school side sees the thread; a family sees the broadcast replies
-- plus their own child's; every author always sees what they wrote.
drop policy if exists dr_read on public.diary_replies;
create policy dr_read on public.diary_replies for select
  using (author_id = auth.uid() or diary_reply_visible(note_id, student_id));

-- Authors may retract their own reply (no edit path — a thread is a record).
drop policy if exists dr_author_delete on public.diary_replies;
create policy dr_author_delete on public.diary_replies for delete
  using (author_id = auth.uid());

-- acks: a parent signs a note they can read, for THEIR child, and only when
-- the note actually concerns that child. Insert-only — a receipt, not a toggle.
drop policy if exists da_insert on public.diary_acks;
create policy da_insert on public.diary_acks for insert
  with check (parent_id = auth.uid()
              and is_parent_of(student_id)
              and diary_note_readable(note_id)
              and diary_note_targets_student(note_id, student_id));

-- Read: WHO SIGNED is not class business. A parent sees their own receipts;
-- the school side (author/teacher/leadership) sees the signature sheet it has
-- to chase. Readable-but-unrelated families and students see nothing — under a
-- class-wide note the old diary_note_readable rule showed every household
-- which of the others had signed.
drop policy if exists da_read on public.diary_acks;
create policy da_read on public.diary_acks for select
  using (parent_id = auth.uid() or diary_note_oversight(note_id));

-- ── Suspension (0015 idiom) ───────────────────────────────────────────────────
-- 0015 asked that new user-data tables be added to its list; the diary is the
-- most sensitive of them (health notes, safeguarding concerns), so a suspended
-- account loses read AND write immediately, even on a still-live access token.
-- RESTRICTIVE FOR ALL with only USING: the USING expression doubles as the
-- WITH CHECK, so inserts are covered too. diary_translations needs no policy —
-- it has none at all and its grants are revoked (service-role only).
do $$
declare t text;
begin
  foreach t in array array['diary_notes','diary_replies','diary_acks']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_not_suspended', t);
    execute format(
      'create policy %I on public.%I as restrictive for all using (not current_user_suspended())',
      t || '_not_suspended', t);
  end loop;
end $$;

-- ── EXECUTE lockdown (0044 doctrine) ──────────────────────────────────────────
-- Postgres grants EXECUTE on every new function to PUBLIC implicitly, which
-- anon inherits — every helper above would be callable through PostgREST
-- (/rest/v1/rpc) by anyone holding the public anon key. These are RLS policy
-- helpers, so `authenticated` genuinely needs EXECUTE (policy expressions run
-- with the caller's privileges); nothing else does. service_role is NOT
-- re-granted, unlike 0044's RPCs: it bypasses RLS, so it never evaluates them.
-- The two trigger functions ride along in the same list — granting them is
-- harmless (called directly they raise "can only be called as a trigger") and
-- it keeps trigger execution from ever depending on an ACL.
do $$
declare f text;
begin
  foreach f in array array[
    'diary_drop_translations()',
    'diary_ack_invalidate()',
    'diary_teacher_of(uuid, uuid)',
    'diary_parent_of_target(uuid, uuid)',
    'diary_student_target(uuid, uuid)',
    'diary_leader_of(uuid, uuid)',
    'diary_note_readable(uuid)',
    'diary_note_participant(uuid)',
    'diary_note_oversight(uuid)',
    'diary_note_targets_student(uuid, uuid)',
    'diary_reply_visible(uuid, uuid)']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
