-- 0032 — Reset persistent boards so the richer cell diagrams take effect.
--
-- The board's scene graph BAKES each placed object's parts (geometry) at place
-- time (SceneGraph.fromJSON restores nodes verbatim), so a board saved before the
-- library was upgraded still renders the old, plain shapes. The detailed cell
-- objects (organic membrane, mitochondria with cristae, ER, Golgi, ribosomes,
-- chloroplasts with grana, etc.) only appear once each object is re-placed from
-- the current library — i.e. on a fresh board.
--
-- Reset each board to empty (turn 0) so the next question rebuilds it with the
-- upgraded objects. Boards are ephemeral teaching surfaces, so this is
-- non-destructive: the student simply asks again. The TAL cache is NOT cleared —
-- replaying a cached program re-instantiates objects from the current library, so
-- cached turns already produce the new geometry.
--
-- (Longer term, restore could re-derive base part geometry from the library so
-- object upgrades propagate without a reset; deferred — it's subtle for
-- dynamic-part objects like the sorting array.)
--
-- Idempotent; safe to run once.

begin;

truncate table public.tutor_board_event;

update public.tutor_board
set scene_graph = '{"scene":"board","nodes":[]}'::jsonb,
    board_hash  = '',
    turn        = 0,
    event_seq   = 0,
    updated_at  = now();

commit;
