// The constrained SymPy math tool, exposed to the model as function-calling
// tools. The model returns a STRUCTURED call; we forward it to the Python math
// service which validates and computes — no model-generated code ever executes.
// If the service is unreachable or can't solve, the tool result says so and the
// prompt contract makes the model fall back to a conceptual explanation.

import type { ToolCall, ToolDef } from "./provider";

const expr = { type: "string", description: "A plain math expression, e.g. 'x**2 - 5*x + 6 = 0'. Use ** for powers." };

export const MATH_TOOLS: ToolDef[] = [
  { name: "solve", description: "Solve one equation for a variable.", parameters: { type: "object", properties: { expr, var: { type: "string", description: "Variable to solve for (optional if only one)." } }, required: ["expr"] } },
  { name: "solve_system", description: "Solve a system of equations.", parameters: { type: "object", properties: { exprs: { type: "array", items: expr }, vars: { type: "array", items: { type: "string" } } }, required: ["exprs"] } },
  { name: "simplify", description: "Simplify an expression.", parameters: { type: "object", properties: { expr }, required: ["expr"] } },
  { name: "factor", description: "Factor an expression.", parameters: { type: "object", properties: { expr }, required: ["expr"] } },
  { name: "expand", description: "Expand an expression.", parameters: { type: "object", properties: { expr }, required: ["expr"] } },
  { name: "differentiate", description: "Differentiate an expression.", parameters: { type: "object", properties: { expr, var: { type: "string" }, order: { type: "integer" } }, required: ["expr"] } },
  { name: "integrate", description: "Integrate an expression (optionally definite).", parameters: { type: "object", properties: { expr, var: { type: "string" }, from: { type: "string" }, to: { type: "string" } }, required: ["expr"] } },
  { name: "evaluate", description: "Numerically evaluate an expression.", parameters: { type: "object", properties: { expr, precision: { type: "integer" } }, required: ["expr"] } },
  { name: "substitute", description: "Substitute values into an expression and simplify.", parameters: { type: "object", properties: { expr, values: { type: "object", description: "Map of symbol → value." } }, required: ["expr", "values"] } },
  { name: "physics_eval", description: "Evaluate a physics formula with units (e.g. F = m*a with m='1500 kg', a='2 m/s**2').", parameters: { type: "object", properties: { expr, values: { type: "object", description: "Map of symbol → 'value with unit' or number." }, target_unit: { type: "string" } }, required: ["expr", "values"] } },
];

export function mathToolsAvailable(): boolean {
  return !!process.env.MATH_SVC_URL && !!process.env.MATH_SVC_TOKEN;
}

const CANNOT = JSON.stringify({ ok: false, error: "could not compute this one" });

/** Build the POST body for the math service from a structured tool call. Pure +
 * exported so the app↔service contract is unit-tested (schema drift here silently
 * gives a child a wrong answer). The one shape that needs remapping: the model
 * emits definite-integral bounds as FLAT `from`/`to` (simpler for it to fill),
 * but `op_integrate` reads ONLY a nested `definite: {from, to}` object — send it
 * flat and the service ignores the bounds and returns the INDEFINITE
 * antiderivative as {ok:true}, i.e. the wrong answer for "area under a curve". */
export function toMathRequestBody(call: ToolCall): Record<string, unknown> {
  const args = (call.args ?? {}) as Record<string, unknown>;
  if (call.name === "integrate" && (args.from !== undefined || args.to !== undefined)) {
    const { from, to, ...rest } = args;
    return { op: call.name, ...rest, definite: { from, to } };
  }
  return { op: call.name, ...args };
}

/** Forward a structured tool call to the math service. Always resolves to a JSON
 * string result for the model; never throws (a math hiccup must not kill the
 * teaching turn — the model explains conceptually instead). */
export async function runMathTool(call: ToolCall): Promise<string> {
  const url = process.env.MATH_SVC_URL;
  const token = process.env.MATH_SVC_TOKEN;
  if (!url || !token) return CANNOT;
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/math`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-math-token": token },
      body: JSON.stringify(toMathRequestBody(call)),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return CANNOT;
    const data = (await res.json()) as object;
    return JSON.stringify(data).slice(0, 4000);
  } catch {
    return CANNOT;
  }
}
