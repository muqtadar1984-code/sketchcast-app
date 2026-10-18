-- Rollback for 0143_delete_translation_kit: the function only; nothing else changed.
drop function if exists public.delete_translation_kit(uuid, uuid);
