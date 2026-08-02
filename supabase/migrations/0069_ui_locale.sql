-- 0069 — profiles.ui_locale: the language the PORTAL ITSELF is shown in.
--
-- Distinct from the two content languages we already store: books.language
-- (0056) is what a LESSON is generated in, diary_translations (0066) is a
-- translated MESSAGE. This one is the app's own chrome — nav, buttons, empty
-- states — so a parent who receives Jawi worksheets can also read the app in
-- Jawi. The ten codes are deliberately the same ten lesson languages
-- (src/i18n/locales.ts mirrors src/utils/narration.ts LANGUAGES), so there is
-- no "supported for lessons but not for buttons" gap to explain.
--
-- This column is only the DURABLE preference. The request-time source of truth
-- is the sc_locale cookie (src/i18n/resolve.ts); the column is what carries the
-- choice to a new browser or device. NULL = never chosen, and the app then
-- negotiates the browser's Accept-Language before falling back to English —
-- which is exactly today's behaviour, so nothing changes until someone picks.
--
-- Idempotent: safe to re-run.

alter table profiles add column if not exists ui_locale text;

-- A whitelist, not free text: the dictionary loader maps this code straight to
-- an import, so an unknown value would be a 500 on every page the user opens.
-- Keep in step with src/i18n/locales.ts (and with narration.ts, which it
-- mirrors). Every existing row is NULL, so the constraint validates instantly.
alter table profiles drop constraint if exists profiles_ui_locale_chk;
alter table profiles add constraint profiles_ui_locale_chk
  check (ui_locale is null or ui_locale in ('en', 'ms', 'ar', 'fr', 'es', 'pt', 'te', 'mr', 'hi', 'ms-arab'));

-- 0010 revoked blanket UPDATE on profiles and re-granted only safe columns.
-- A language preference is benign per-user UI state — same class as
-- notifications_seen_at (0055) and getting_started_dismissed_at (0064) — so the
-- owner may set it straight from their own session; the profiles_update_self
-- row policy still confines the write to their own row, and the CHECK above
-- confines the value. Without this grant the language picker is
-- permission-denied forever.
grant update (ui_locale) on public.profiles to authenticated;
