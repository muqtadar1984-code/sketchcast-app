// SK's chat maths (student Board phase 3, 2026-10-31): the small LaTeX subset
// SK's lessons write (learn-teach.ts TEACH_MATH_RULE) → a node tree the chat
// renders as plain React elements (sk-rich-text.tsx), plus a plain-text and a
// spoken form for the bubble and the read-aloud.
//
// WHY NOT KaTeX: the app has no maths renderer today, the lessons use a
// school-level subset (fractions, powers, roots, a dozen symbols), and a
// 300 KB library + its fonts for one chat window is not "lightweight". The
// subset is rendered with Unicode and inline CSS (a fraction is a two-row
// inline-flex box), which works on any phone with no font download. Anything
// outside the subset degrades to readable text, never to an error.
//
// PURE: no DOM, no React.

export type TexNode =
  | { t: "sym"; v: string; italic?: boolean }
  | { t: "text"; v: string }
  | { t: "group"; body: TexNode[] }
  | { t: "frac"; num: TexNode[]; den: TexNode[] }
  | { t: "sqrt"; body: TexNode[]; index?: TexNode[] }
  | { t: "sup"; body: TexNode[] }
  | { t: "sub"; body: TexNode[] };

/** Command → the symbol it draws. */
const SYMBOLS: Record<string, string> = {
  times: "×",
  div: "÷",
  pm: "±",
  mp: "∓",
  cdot: "·",
  le: "≤",
  leq: "≤",
  ge: "≥",
  geq: "≥",
  ne: "≠",
  neq: "≠",
  approx: "≈",
  equiv: "≡",
  sim: "∼",
  propto: "∝",
  pi: "π",
  degree: "°",
  circ: "°",
  infty: "∞",
  to: "→",
  rightarrow: "→",
  leftarrow: "←",
  Rightarrow: "⇒",
  Leftrightarrow: "⇔",
  implies: "⇒",
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  Delta: "Δ",
  epsilon: "ε",
  theta: "θ",
  lambda: "λ",
  mu: "μ",
  rho: "ρ",
  sigma: "σ",
  Sigma: "Σ",
  tau: "τ",
  phi: "φ",
  omega: "ω",
  Omega: "Ω",
  angle: "∠",
  triangle: "△",
  perp: "⊥",
  parallel: "∥",
  therefore: "∴",
  because: "∵",
  ldots: "…",
  dots: "…",
  cdots: "⋯",
  lt: "<",
  gt: ">",
  in: "∈",
  cup: "∪",
  cap: "∩",
  sum: "Σ",
  "%": "%",
  "$": "$",
  "{": "{",
  "}": "}",
  "&": "&",
  "#": "#",
  "_": "_",
  ",": " ",
  ";": " ",
  ":": " ",
  " ": " ",
  quad: " ",
  qquad: "  ",
  "!": "",
};

/** Commands that wrap one argument and draw it as is. */
const WRAPS = new Set(["mathbf", "boldsymbol", "mathit", "overline", "underline", "vec", "hat", "bar", "displaystyle", "textstyle", "mathbb", "mathcal"]);
/** Commands whose argument is TEXT (not maths). */
const TEXTS = new Set(["text", "textrm", "mathrm", "textbf", "textit", "mbox", "operatorname"]);
/** Function names drawn upright. */
const FUNCS = new Set(["sin", "cos", "tan", "log", "ln", "exp", "min", "max", "lim"]);

const MAX_SRC = 600;
const MAX_DEPTH = 12;

class Parser {
  i = 0;
  constructor(private readonly s: string) {}

  /** A run of nodes up to `stop` (consumed) or the end. */
  seq(stop: "}" | "]" | null, depth: number): TexNode[] {
    const out: TexNode[] = [];
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (stop && c === stop) {
        this.i++;
        return out;
      }
      if (c === "}" || (c === "]" && stop !== null)) {
        this.i++;
        continue;
      }
      const n = this.atom(depth);
      if (n) out.push(n);
    }
    return out;
  }

  /** One argument: a {group}, a command, or one character. */
  arg(depth: number): TexNode[] {
    while (this.s[this.i] === " ") this.i++;
    if (this.i >= this.s.length) return [];
    if (this.s[this.i] === "{") {
      this.i++;
      return depth > MAX_DEPTH ? this.skipGroup() : this.seq("}", depth + 1);
    }
    const n = this.atom(depth);
    return n ? [n] : [];
  }

  /** A raw {…} as text (for \text{}), braces balanced. */
  rawGroup(): string {
    while (this.s[this.i] === " ") this.i++;
    if (this.s[this.i] !== "{") return "";
    let level = 0;
    const start = this.i + 1;
    for (; this.i < this.s.length; this.i++) {
      if (this.s[this.i] === "{") level++;
      else if (this.s[this.i] === "}") {
        level--;
        if (level === 0) {
          const v = this.s.slice(start, this.i);
          this.i++;
          return v.replace(/\\([{}%$&#_ ])/g, "$1");
        }
      }
    }
    return this.s.slice(start);
  }

  skipGroup(): TexNode[] {
    return [{ t: "text", v: this.rawGroup() }];
  }

  atom(depth: number): TexNode | null {
    const c = this.s[this.i];
    if (c === "{") {
      this.i++;
      const body = depth > MAX_DEPTH ? this.skipGroup() : this.seq("}", depth + 1);
      return { t: "group", body };
    }
    if (c === "^" || c === "_") {
      this.i++;
      const body = this.arg(depth + 1);
      return { t: c === "^" ? "sup" : "sub", body };
    }
    if (c === "\\") return this.command(depth);
    this.i++;
    if (/\s/.test(c)) return null;
    if (c === "-") return { t: "sym", v: "−" };
    if (c === "*") return { t: "sym", v: "×" };
    if (c === "'") return { t: "sym", v: "′" };
    return { t: "sym", v: c, ...(/\p{L}/u.test(c) ? { italic: true } : {}) };
  }

  command(depth: number): TexNode | null {
    this.i++; // the backslash
    const m = /^[A-Za-z]+/.exec(this.s.slice(this.i));
    const name = m ? m[0] : this.s[this.i] ?? "";
    this.i += name.length || 1;
    if (name === "\\") return { t: "sym", v: " " };
    if (name === "frac" || name === "dfrac" || name === "tfrac") {
      const num = this.arg(depth + 1);
      const den = this.arg(depth + 1);
      return { t: "frac", num, den };
    }
    if (name === "sqrt") {
      let index: TexNode[] | undefined;
      if (this.s[this.i] === "[") {
        this.i++;
        index = this.seq("]", depth + 1);
      }
      return { t: "sqrt", body: this.arg(depth + 1), ...(index?.length ? { index } : {}) };
    }
    if (TEXTS.has(name)) return { t: "text", v: this.rawGroup() };
    if (WRAPS.has(name)) return { t: "group", body: this.arg(depth + 1) };
    if (name === "left" || name === "right") {
      // The delimiter that follows is an ordinary symbol; "\left." draws nothing.
      if (this.s[this.i] === ".") this.i++;
      return null;
    }
    if (FUNCS.has(name)) return { t: "text", v: name };
    if (name in SYMBOLS) return SYMBOLS[name] ? { t: "sym", v: SYMBOLS[name] } : null;
    // Outside the subset: its name, readable, never an error.
    return { t: "text", v: name };
  }
}

/** The subset → nodes. Never throws; overlong input is cut. */
export function parseTex(src: string): TexNode[] {
  try {
    return new Parser((src ?? "").slice(0, MAX_SRC)).seq(null, 0);
  } catch {
    return [{ t: "text", v: src ?? "" }];
  }
}

// ── plain text and speech ───────────────────────────────────────────────────

const SUP: Record<string, string> = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "−": "⁻", "-": "⁻", n: "ⁿ", "(": "⁽", ")": "⁾" };
const SUB: Record<string, string> = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉", "+": "₊", "−": "₋", "-": "₋" };

const mapAll = (s: string, table: Record<string, string>): string | null => {
  let out = "";
  for (const ch of s) {
    const m = table[ch];
    if (m === undefined) return null;
    out += m;
  }
  return out;
};

/** One "simple" token needs no brackets around it in a/b. */
const simple = (s: string) => /^[\p{L}\p{N}.]+$/u.test(s);

/** Nodes → readable plain text ("¾" stays "3/4", "x²", "√(x+1)"). */
export function texPlain(nodes: TexNode[]): string {
  let out = "";
  for (const n of nodes) {
    switch (n.t) {
      case "sym":
        out += n.v;
        break;
      case "text":
        out += n.v;
        break;
      case "group":
        out += texPlain(n.body);
        break;
      case "frac": {
        const a = texPlain(n.num);
        const b = texPlain(n.den);
        out += `${simple(a) ? a : `(${a})`}/${simple(b) ? b : `(${b})`}`;
        break;
      }
      case "sqrt": {
        const b = texPlain(n.body);
        out += `${n.index ? texPlain(n.index) : ""}√${simple(b) ? b : `(${b})`}`;
        break;
      }
      case "sup": {
        const b = texPlain(n.body);
        out += mapAll(b, SUP) ?? `^(${b})`;
        break;
      }
      case "sub": {
        const b = texPlain(n.body);
        out += mapAll(b, SUB) ?? `_${b}`;
        break;
      }
    }
  }
  return out;
}

/** English words for the symbols a voice would otherwise skip or misread. */
const SPOKEN_EN: Record<string, string> = {
  "×": " times ",
  "·": " times ",
  "÷": " divided by ",
  "=": " equals ",
  "+": " plus ",
  "−": " minus ",
  "±": " plus or minus ",
  "≤": " is less than or equal to ",
  "≥": " is greater than or equal to ",
  "≠": " is not equal to ",
  "≈": " is about ",
  "<": " is less than ",
  ">": " is greater than ",
  "π": " pi ",
  "°": " degrees ",
  "→": " gives ",
  "⇒": " so ",
  "%": " percent",
};

/** Nodes → words to read aloud. English gets words ("3 over 4", "x squared");
 *  every other language gets the plain form, whose symbols its own voice reads. */
export function texSpoken(nodes: TexNode[], lang: string | null | undefined): string {
  if (lang && !/^en\b/i.test(lang)) return texPlain(nodes);
  const say = (ns: TexNode[]): string => {
    let out = "";
    for (const n of ns) {
      switch (n.t) {
        case "sym":
          out += SPOKEN_EN[n.v] ?? n.v;
          break;
        case "text":
          out += ` ${n.v} `;
          break;
        case "group":
          out += say(n.body);
          break;
        case "frac":
          out += ` ${say(n.num).trim()} over ${say(n.den).trim()} `;
          break;
        case "sqrt":
          out += ` the square root of ${say(n.body).trim()} `;
          break;
        case "sup": {
          const b = say(n.body).trim();
          out += b === "2" ? " squared " : b === "3" ? " cubed " : ` to the power of ${b} `;
          break;
        }
        case "sub":
          out += ` ${say(n.body).trim()} `;
          break;
      }
    }
    return out;
  };
  return say(nodes).replace(/\s+/g, " ").trim();
}
