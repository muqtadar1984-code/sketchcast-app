-- SketchCast AI — school branding + book cover thumbnails
-- ----------------------------------------------------------------------------
-- branding: a teacher uploads the school's .docx + .pptx (stored in the
-- `uploads` bucket under {uid}/branding/…). The worker opens those as templates
-- so every generated document, the editable deck, and the narrated video slides
-- carry the school's format/theme (colours + logo derived from the .pptx).
-- books.cover_path: thumbnail rendered from the PDF's first page by index_book.
-- Safe to run on the existing database.
-- ----------------------------------------------------------------------------

create table if not exists branding (
  owner_id   uuid primary key references profiles(id) on delete cascade,
  school_id  uuid references schools(id) on delete set null,
  docx_path  text,
  pptx_path  text,
  updated_at timestamptz not null default now()
);

alter table branding enable row level security;
drop policy if exists branding_owner_all on branding;
create policy branding_owner_all on branding for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

alter table books add column if not exists cover_path text;
