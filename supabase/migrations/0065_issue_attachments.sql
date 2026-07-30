-- 0065 — Issue attachments: screenshots on "Report a problem".
--
-- Adults may attach up to 3 screenshots to an issue report. The paths land on
-- the platform_issues row; the files land in a private 'issue-attachments'
-- bucket under a folder named by the reporter's uid (0006's submissions
-- pattern). Students stay data-minimized — the API strips attachments
-- server-side. No staff storage policy: the console reads via the service
-- role and mints signed URLs (submission-url doctrine). Additive + inert
-- until the app release ships. One execution. Idempotent.

alter table public.platform_issues add column if not exists
  attachment_paths text[]
  check (attachment_paths is null or array_length(attachment_paths, 1) <= 3);

-- 5 MB screenshot uploads; the reporter manages files under a folder named by
-- their uid. allowed_mime_types is enforced by storage at upload, so a
-- reporter cannot register e.g. a text/html object that the console would
-- later sign and a staff click would execute (adversarial-review finding).
-- The conflict branch re-asserts EVERY safety property, so a hand-created
-- public bucket cannot survive the migration.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('issue-attachments', 'issue-attachments', false, 5242880,
          array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do update
    set public = excluded.public,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists issue_attachments_rw on storage.objects;
create policy issue_attachments_rw on storage.objects for all
  using (bucket_id = 'issue-attachments' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'issue-attachments' and (storage.foldername(name))[1] = auth.uid()::text);
