import { NextResponse } from "next/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { isLibraryMemberRequest } from "@/utils/library-access";
import { boardEditPatch, canApproveBoard, isBoardAction, type Board } from "@/utils/catalogue/pinterest";
import { audit, bad, conflict, dbError, notFound, readJson, uuid } from "../../lib";

export const runtime = "nodejs";

// Pinterest boards (migration 0154). Admins only (`publish`). A board is
// planned until an admin approves it; the worker then creates it on
// Pinterest (job pin_boards) and records its id. Once approved a board's name
// is Pinterest's to show, so only planned boards are edited here.
//
//   edit     {boardId, name?, description?}   planned only
//   approve  {boardId}                        planned → approved

type Body = { action?: unknown; boardId?: unknown; name?: unknown; description?: unknown };

export async function POST(request: Request) {
  const m = await isLibraryMemberRequest("publish");
  if (!m) return notFound();
  const body = await readJson<Body>(request);
  if (!body) return bad("Invalid JSON.");
  if (!isBoardAction(body.action)) return bad("Unknown action.");
  const boardId = uuid(body.boardId);
  if (!boardId) return bad("boardId must be one board id.");
  const admin = createAdminClient();

  const got = await admin.from("pinterest_boards").select("id, language, board_key, name, description, status").eq("id", boardId).maybeSingle();
  if (got.error) {
    if (got.error.code === "42P01" || got.error.code === "PGRST205") return conflict("The Pinterest engine needs migration 0154 — apply it first.");
    return dbError(got.error);
  }
  if (!got.data) return notFound();
  const board = got.data as Pick<Board, "id" | "language" | "board_key" | "name" | "description" | "status">;
  const now = new Date().toISOString();

  const write = async (patch: Record<string, unknown>) => {
    const up = await admin
      .from("pinterest_boards")
      .update({ ...patch, updated_at: now })
      .eq("id", boardId)
      .eq("status", "planned")
      .select("id, status, name, description")
      .maybeSingle();
    if (up.error) return { error: dbError(up.error) };
    if (!up.data) return { error: conflict("This board changed a moment ago — reload and look again.") };
    return { row: up.data };
  };

  if (body.action === "edit") {
    const e = boardEditPatch(board, { name: body.name, description: body.description });
    if (!e.ok) return conflict(e.why);
    const r = await write(e.patch);
    if (r.error) return r.error;
    await audit(admin, m.id, "pin_board_edit", "pinterest_board", boardId, {
      language: board.language, board_key: board.board_key,
      before: { name: board.name, description: board.description }, after: e.patch,
    });
    return NextResponse.json({ ok: true, action: body.action, board: r.row });
  }

  const can = canApproveBoard(board);
  if (!can.ok) return conflict(can.why);
  const r = await write({ status: "approved", approved_by: m.id, approved_at: now });
  if (r.error) return r.error;
  await audit(admin, m.id, "pin_board_approve", "pinterest_board", boardId, { language: board.language, board_key: board.board_key, name: board.name });
  return NextResponse.json({ ok: true, action: body.action, board: r.row });
}
