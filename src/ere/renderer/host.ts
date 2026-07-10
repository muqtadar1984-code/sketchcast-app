// A minimal DOM host: drives the pure SVG renderer from a BoardSession. The
// live web panel (Phase 1) and the standalone canvas app (Phase 2) both wrap
// THIS — one engine, one renderer, many shells. Headless environments never
// import it; tests exercise renderSvg directly.

import type { BoardSession } from "../interpreter/interpreter";
import { renderSvg, type RenderOpts } from "./svg";

export class SvgBoardHost {
  private container: { innerHTML: string } | null = null;
  private raf: ((cb: () => void) => void) | null = null;

  constructor(private readonly session: BoardSession) {}

  mount(container: { innerHTML: string }): void {
    this.container = container;
    this.render();
  }

  /** Re-render the current board (final state; CSS handles draw-on animation). */
  render(opts: RenderOpts = {}): void {
    if (!this.container) return;
    this.container.innerHTML = renderSvg(this.session.graph, this.session.library, {
      animate: true,
      events: this.session.log.all(),
      ...opts,
    });
  }

  /** Run a TAL turn and repaint. Returns the turn result (errors or schedule). */
  async runTurn(program: unknown): Promise<ReturnType<BoardSession["runTurn"]> extends Promise<infer R> ? R : never> {
    const result = await this.session.runTurn(program);
    this.render();
    return result;
  }
}
