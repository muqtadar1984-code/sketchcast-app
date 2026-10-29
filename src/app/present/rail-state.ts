// The collapsible unit rail (Board UX 2026-10-28, founder: "full-screen video
// hides the left column"). When the stage is `full` the rail is unreachable
// until she taps to freeze; a persistent handle on the left edge now opens the
// same rail as an overlay over the stage, and picking anything from it closes
// it again — she asked for a thing, not for a panel.
//
// PURE: the open/closed state and the four things that change it. The Board
// (present-client) owns the state; the SK bridge's `rail` port and BoardSession
// both go through this reducer so the two can never disagree about what a
// "pick" does.

export type RailState = { open: boolean };
export type RailAction = "open" | "close" | "toggle" | "pick";

export const RAIL_CLOSED: RailState = { open: false };

export function railReduce(state: RailState, action: RailAction): RailState {
  switch (action) {
    case "open":
      return state.open ? state : { open: true };
    case "close":
    case "pick":
      // A pick — a unit, a doc, the video — is what she opened the rail for;
      // the overlay has done its job and gets out of the stage's way.
      return state.open ? { open: false } : state;
    case "toggle":
      return { open: !state.open };
    default:
      return state;
  }
}
