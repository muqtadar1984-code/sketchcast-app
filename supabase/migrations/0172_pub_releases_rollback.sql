-- Rollback for 0172_pub_releases.sql. Drops the releases record; the files under books/<slug>/editions/ stay in S3.
drop function if exists public.pub_release_publish(jsonb);
drop trigger if exists pub_releases_guard on public.pub_releases;
drop table if exists public.pub_releases;
drop function if exists public.pub_releases_guard();
