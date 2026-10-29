-- 0170: SK S3 slice A — the book product -> chapter -> kit map, and the
-- article-objective key on attempts and mastery
-- (SK S3 Design 2026-10-29, decisions 1-3; Final Plan §6 S3).
--
-- sk_product_kits   which approved catalogue kits (presentation generations)
--                   teach which chapter of a book product. Read by the student
--                   tutor (/sk) ONLY, through src/sk/product-kits.ts.
--
-- ACCESS: RLS on, NO policies, no grants to anon/authenticated (the 0163
-- pattern). The app reads it with the service-role client AFTER its own
-- product entitlement check (src/sk/entitlement.ts: book grant, school licence,
-- staff). There is no SQL helper for that entitlement (checked on production
-- 2026-10-29: book_access_grants has only a read-own policy, and the licence
-- and staff paths live in the app), and re-implementing it in a policy would
-- be a second copy that can drift. A book grant opens the mapped kits ONLY
-- inside /sk; the Library and catalogue unlock logic is unchanged.
--
-- objective_key     "<topic_articles.id>:<objective_ref>" (src/sk/objective-key.ts),
--                   the mastery key for kit items (design decision 3), next to
--                   the existing teaching_objective_id. Nullable; nothing writes
--                   it until slice C.
--
-- Seed: the nine approved English Biology kits for
-- cells-structure-function-organisation (chapters 3, 7 and 10 have no kit).
-- Inserted by SELECT from generations so a database without those rows
-- (branch, local) seeds nothing instead of failing; on conflict do nothing.
--
-- Run as ONE execution. Idempotent.
begin;

create table if not exists public.sk_product_kits (
  product_id    uuid        not null references public.sk_book_products(id) on delete cascade,
  chapter_ref   text        not null,
  sort          int         not null default 0,
  generation_id uuid        not null references public.generations(id) on delete cascade,
  label         text,
  created_at    timestamptz not null default now(),
  primary key (product_id, chapter_ref, generation_id)
);
create index if not exists sk_product_kits_generation_idx on public.sk_product_kits (generation_id);

comment on table public.sk_product_kits is
  'SK S3: book product -> chapter -> kit (presentation generation). Service-role only; the app checks product entitlement first. A book grant opens these kits inside /sk only.';

alter table public.sk_product_kits enable row level security;
revoke all on public.sk_product_kits from anon, authenticated;

insert into public.sk_product_kits (product_id, chapter_ref, sort, generation_id, label)
select p.id, v.chapter_ref, v.sort, g.id, v.label
from (values
  ('1', 0, 'e064cda5-775d-4b30-a77e-1180123da6a8'::uuid, 'Cells'),
  ('2', 0, 'ae8fc240-4391-4bee-80eb-2c0ce9b572ac'::uuid, 'Using a Microscope and Calculating Magnification'),
  ('4', 0, 'eef426bd-523b-4fed-827c-95421263d89a'::uuid, 'Plant and Animal Cells Compared'),
  ('5', 0, '4885bc51-0e65-4252-bb41-88df6bcc28bc'::uuid, 'Specialised Cells and Tissues'),
  ('6', 0, '3f63956e-9615-4fc2-b1da-b18ae24afb3c'::uuid, 'Diffusion in Living Cells'),
  ('8', 0, 'cbad6d74-7433-46ad-baed-12724c7e59cf'::uuid, 'Blood and Its Components'),
  ('8', 1, '4246bd3e-48e0-407e-adce-872ab84239bc'::uuid, 'The Human Respiratory System'),
  ('8', 2, '4160b18e-2c3c-4ed6-b4dd-dce706eb0805'::uuid, 'Transport in Plants'),
  ('9', 0, '38cf173c-13ac-4860-86df-ce4256c93925'::uuid, 'Inheritance and Variation')
) as v(chapter_ref, sort, generation_id, label)
join public.sk_book_products p on p.slug = 'cells-structure-function-organisation'
join public.generations g on g.id = v.generation_id and g.kind = 'presentation' and g.status = 'done' and g.withdrawn_at is null
on conflict do nothing;

alter table public.mastery_state add column if not exists objective_key text;
alter table public.item_attempts add column if not exists objective_key text;

create index if not exists mastery_state_student_objective_key_idx
  on public.mastery_state (student_id, objective_key)
  where objective_key is not null;
create index if not exists item_attempts_student_objective_key_idx
  on public.item_attempts (student_id, objective_key, at)
  where objective_key is not null;

comment on column public.mastery_state.objective_key is
  'SK S3: "<topic_articles.id>:<objective_ref>" for kit items (article objective); null for book-path rows keyed on teaching_objective_id.';
comment on column public.item_attempts.objective_key is
  'SK S3: "<topic_articles.id>:<objective_ref>" of the attempted kit item; null when unmapped.';

commit;
