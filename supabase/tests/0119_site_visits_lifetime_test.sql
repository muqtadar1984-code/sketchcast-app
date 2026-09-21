-- Exercises 0119 on a scratch database: lifetime = live rows + archive,
-- and pruning moves whole days into the archive without changing the total.
begin;
delete from public.site_visits; delete from public.site_visits_archive;

insert into public.site_visits (at, host, path, visitor) values
  (now() - interval '500 days', 'sketchcast.app', '/', 'a'),
  (now() - interval '500 days', 'sketchcast.app', '/pricing', 'a'),
  (now() - interval '500 days', 'sketchcast.app', '/', 'b'),
  (now() - interval '2 days',   'sketchcast.app', '/', 'c'),
  (now(),                       'sketchcast.app', '/', 'd'),
  (now(),                       'app.sketchcast.app', '/dashboard', 'e');

do $$
declare r record;
begin
  select * into r from public.site_visits_lifetime(array['sketchcast.app','www.sketchcast.app']);
  if r.visits <> 5 or r.visitors <> 4 then raise exception 'before prune: % visits, % visitors', r.visits, r.visitors; end if;
  if r.first_day <> (now() at time zone 'UTC')::date - 500 then raise exception 'first_day %', r.first_day; end if;

  if public.prune_site_visits(400) <> 3 then raise exception 'prune should delete 3 rows'; end if;
  if (select count(*) from public.site_visits_archive) <> 1 then raise exception 'one archive row expected'; end if;
  if (select visits from public.site_visits_archive) <> 3 or (select visitors from public.site_visits_archive) <> 2 then
    raise exception 'archive row wrong';
  end if;

  select * into r from public.site_visits_lifetime(array['sketchcast.app','www.sketchcast.app']);
  if r.visits <> 5 or r.visitors <> 4 then raise exception 'after prune: % visits, % visitors', r.visits, r.visitors; end if;
  if r.first_day <> (now() at time zone 'UTC')::date - 500 then raise exception 'first_day after prune %', r.first_day; end if;

  -- Pruning again archives nothing new and the total holds.
  if public.prune_site_visits(400) <> 0 then raise exception 'second prune should be a no-op'; end if;
  select * into r from public.site_visits_lifetime(null);
  if r.visits <> 6 then raise exception 'all hosts: % visits', r.visits; end if;
  raise notice 'ok';
end $$;
rollback;
