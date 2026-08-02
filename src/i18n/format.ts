// Filling the placeholders in a message.
//
// Message values interpolate with SINGLE braces — "Part {n} of {total}" (the
// convention dictionaries.ts documents): the braces are part of the string in
// every language, so a translator moves them around the sentence and never
// renames them. This is the one function that fills them in, so "{n}" means the
// same thing in ten files.
//
// PURE — no next/* and no `server-only` import — because formatting happens on
// BOTH sides of the boundary: a server component formats the header, a client
// component formats a countdown that has to change after hydration.
//
// An unknown placeholder is left standing rather than blanked: a stray "{n}" on
// screen is a bug report someone can act on, an empty gap is a mystery.

export function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in vars ? String(vars[key]) : whole));
}
