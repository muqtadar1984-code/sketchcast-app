// @sketchcast/ere — the Educational Rendering Engine. One versioned package
// imported by both the live web app and the standalone canvas. Platform-blind:
// the host injects grounding, tutor turns, and persistence.

// TAL — the contract (the seam)
export * from "./tal/types";
export { validateTal, baseId } from "./tal/validate";
export type { ValidationError, ValidationResult, SceneReader, LibraryReader } from "./tal/validate";

// Scene graph + event model
export * from "./scene/types";
export { SceneGraph } from "./scene/graph";
export type { Instantiator, SceneGraphSnapshot } from "./scene/graph";
export { EventLog } from "./scene/events";
export type { BoardEvent, BoardEventType, BoardActor } from "./scene/events";
export { resolveWorldPos, nodeWorldCenter, geometryCentroid } from "./scene/layout";

// Knowledge objects + library
export * from "./ko/types";
export { Library } from "./ko/library";
export { PRIMITIVES } from "./ko/primitives";

// Interpreter + scheduler
export { BoardSession } from "./interpreter/interpreter";
export type { TurnResult } from "./interpreter/interpreter";
export { schedule, StubNarrator, nominalDuration } from "./interpreter/schedule";
export type { Narrator, ScheduledAction } from "./interpreter/schedule";

// Renderer
export { renderSvg } from "./renderer/svg";
export type { RenderOpts } from "./renderer/svg";
export { SvgBoardHost } from "./renderer/host";
export type { Renderer, DrawOpts, FocusOpts, HighlightStyle, RemoveStyle } from "./renderer/types";

// Starter library (3 anchor subjects)
export { starterLibrary, STARTER_OBJECTS, BIOLOGY, PHYSICS, ALGORITHMS } from "./library/index";

// Gateway (tutor → TAL)
export { generateTal, buildTalPrompt, extractJson } from "./gateway/gateway";
export type { CompleteFn, Grounding, GatewayResult } from "./gateway/gateway";

export const ERE_VERSION = "0.2.0";
