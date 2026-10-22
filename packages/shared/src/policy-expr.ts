// Safe, side-effect-free expression evaluator for policy conditions (PRD 7.5
// ABAC extension). Grammar is an expr-lang-style subset:
//   - literals: 'string' / "string", numbers, true / false / null
//   - dotted identifier paths (model, agent.id, tenant.plan, usage.inputTokens)
//     resolved against the caller-supplied context with `?.` semantics —
//     unknown identifiers and missing segments evaluate to undefined, never throw
//   - operators: == != < <= > >= && || ! + - * / % and parentheses
//   - built-ins: startsWith(a,b) endsWith(a,b) contains(a,b) matches(a,regex)
//     len(a) lower(a) upper(a); an invalid regex makes matches() false. Both
//     call styles work: startsWith(model, 'gpt') and model.startsWith('gpt')
//     (method style is sugar — the receiver path becomes the first argument)
// There is deliberately no assignment, no ternary, no property access beyond
// plain data paths, no globals and no eval/Function — the evaluation context
// is the pure object the caller passes in.

export type PolicyExprValue = boolean | number | string;

export class PolicyExprError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyExprError";
  }
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenType = "num" | "str" | "ident" | "op" | "lparen" | "rparen" | "comma" | "dot" | "end";

interface Token {
  type: TokenType;
  value?: string;
  pos: number;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const at = (j: number): string => src[j] ?? "";
  while (i < src.length) {
    const c = at(i);
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(at(i + 1)))) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(at(j))) j++;
      if (at(j) === "e" || at(j) === "E") {
        let k = j + 1;
        if (at(k) === "+" || at(k) === "-") k++;
        if (/[0-9]/.test(at(k))) {
          j = k;
          while (j < src.length && /[0-9]/.test(at(j))) j++;
        }
      }
      const raw = src.slice(i, j);
      if (!Number.isFinite(Number(raw))) throw new PolicyExprError(`invalid number "${raw}" (pos ${i})`);
      tokens.push({ type: "num", value: raw, pos: i });
      i = j;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let out = "";
      while (j < src.length && at(j) !== c) {
        if (at(j) === "\\") {
          const esc = at(j + 1);
          out += esc === "n" ? "\n" : esc === "t" ? "\t" : esc === "r" ? "\r" : esc;
          j += 2;
        } else {
          out += at(j);
          j++;
        }
      }
      if (j >= src.length) throw new PolicyExprError("unterminated string literal");
      tokens.push({ type: "str", value: out, pos: i });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(at(j))) j++;
      tokens.push({ type: "ident", value: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (c === "(") {
      tokens.push({ type: "lparen", pos: i });
      i++;
      continue;
    }
    if (c === ")") {
      tokens.push({ type: "rparen", pos: i });
      i++;
      continue;
    }
    if (c === ",") {
      tokens.push({ type: "comma", pos: i });
      i++;
      continue;
    }
    if (c === ".") {
      tokens.push({ type: "dot", pos: i });
      i++;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "==" || two === "!=" || two === "<=" || two === ">=" || two === "&&" || two === "||") {
      tokens.push({ type: "op", value: two, pos: i });
      i += 2;
      continue;
    }
    if (c === "<" || c === ">" || c === "+" || c === "-" || c === "*" || c === "/" || c === "%" || c === "!") {
      tokens.push({ type: "op", value: c, pos: i });
      i++;
      continue;
    }
    throw new PolicyExprError(`unexpected character "${c}" (pos ${i})`);
  }
  tokens.push({ type: "end", pos: src.length });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (recursive descent)
// ---------------------------------------------------------------------------

type Node =
  | { k: "lit"; v: unknown }
  | { k: "path"; names: string[] }
  | { k: "call"; name: string; args: Node[] }
  | { k: "un"; op: string; e: Node }
  | { k: "bin"; op: string; l: Node; r: Node };

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    // Tokenize() always appends an "end" token, so this is defined in practice.
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const t = this.peek();
    this.pos += 1;
    return t;
  }

  private expect(type: TokenType, what: string): Token {
    const t = this.next();
    if (t.type !== type) throw new PolicyExprError(`expected ${what} but found "${t.value ?? t.type}" (pos ${t.pos})`);
    return t;
  }

  parseExpression(): Node {
    const node = this.parseOr();
    const tail = this.peek();
    if (tail.type !== "end") {
      throw new PolicyExprError(`unexpected token "${tail.value ?? tail.type}" (pos ${tail.pos})`);
    }
    return node;
  }

  // || (lowest)
  private parseOr(): Node {
    let left = this.parseAnd();
    while (this.peek().type === "op" && this.peek().value === "||") {
      this.next();
      left = { k: "bin", op: "||", l: left, r: this.parseAnd() };
    }
    return left;
  }

  // &&
  private parseAnd(): Node {
    let left = this.parseEquality();
    while (this.peek().type === "op" && this.peek().value === "&&") {
      this.next();
      left = { k: "bin", op: "&&", l: left, r: this.parseEquality() };
    }
    return left;
  }

  // == !=
  private parseEquality(): Node {
    let left = this.parseRelational();
    while (this.peek().type === "op" && (this.peek().value === "==" || this.peek().value === "!=")) {
      const op = this.next().value as string;
      left = { k: "bin", op, l: left, r: this.parseRelational() };
    }
    return left;
  }

  // < <= > >=
  private parseRelational(): Node {
    let left = this.parseAdditive();
    while (
      this.peek().type === "op" &&
      ["<", "<=", ">", ">="].includes(this.peek().value as string)
    ) {
      const op = this.next().value as string;
      left = { k: "bin", op, l: left, r: this.parseAdditive() };
    }
    return left;
  }

  // + -
  private parseAdditive(): Node {
    let left = this.parseMultiplicative();
    while (this.peek().type === "op" && (this.peek().value === "+" || this.peek().value === "-")) {
      const op = this.next().value as string;
      left = { k: "bin", op, l: left, r: this.parseMultiplicative() };
    }
    return left;
  }

  // * / %
  private parseMultiplicative(): Node {
    let left = this.parseUnary();
    while (
      this.peek().type === "op" &&
      ["*", "/", "%"].includes(this.peek().value as string)
    ) {
      const op = this.next().value as string;
      left = { k: "bin", op, l: left, r: this.parseUnary() };
    }
    return left;
  }

  // ! - (unary, right-associative)
  private parseUnary(): Node {
    const t = this.peek();
    if (t.type === "op" && (t.value === "!" || t.value === "-")) {
      this.next();
      return { k: "un", op: t.value as string, e: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Node {
    const t = this.next();
    if (t.type === "num") return { k: "lit", v: Number(t.value) };
    if (t.type === "str") return { k: "lit", v: t.value as string };
    if (t.type === "lparen") {
      const inner = this.parseOr();
      this.expect("rparen", "')'");
      return inner;
    }
    if (t.type === "ident") {
      const word = t.value as string;
      if (word === "true") return { k: "lit", v: true };
      if (word === "false") return { k: "lit", v: false };
      if (word === "null") return { k: "lit", v: null };
      // Dotted identifier path (model, agent.id, usage.inputTokens, ...).
      const names = [word];
      while (this.peek().type === "dot") {
        this.next();
        names.push(this.expect("ident", "an identifier after '.'").value as string);
      }
      if (this.peek().type === "lparen") {
        // Built-in call. Method style (`model.startsWith('gpt')`) is sugar:
        // the last path segment is the function and the leading path becomes
        // the first argument — `startsWith(model, 'gpt')`.
        this.next();
        const args: Node[] = [];
        if (this.peek().type !== "rparen") {
          args.push(this.parseOr());
          while (this.peek().type === "comma") {
            this.next();
            args.push(this.parseOr());
          }
        }
        this.expect("rparen", "')'");
        const fnName = names[names.length - 1] as string;
        const receiver = names.slice(0, -1);
        return {
          k: "call",
          name: fnName,
          args: [...(receiver.length > 0 ? [{ k: "path", names: receiver } as Node] : []), ...args],
        };
      }
      return { k: "path", names };
    }
    throw new PolicyExprError(`unexpected token "${t.value ?? t.type}" (pos ${t.pos})`);
  }
}

// ---------------------------------------------------------------------------
// Evaluator — pure data access against the caller-supplied context only.
// ---------------------------------------------------------------------------

function resolvePath(ctx: Record<string, unknown>, names: string[]): unknown {
  let cur: unknown = ctx;
  for (const name of names) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    const next = (cur as Record<string, unknown>)[name];
    cur = typeof next === "function" ? undefined : next; // never surface callables
  }
  return cur;
}

export function truthy(v: unknown): boolean {
  if (v === undefined || v === null || v === false || v === 0 || v === "") return false;
  if (typeof v === "number" && Number.isNaN(v)) return false;
  return true;
}

function toNumber(v: unknown): number {
  if (v === undefined || v === null) return NaN;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") return v === "" ? 0 : Number(v);
  return NaN;
}

function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || a === null || b === undefined || b === null) {
    return (a === undefined || a === null) && (b === undefined || b === null); // null == undefined
  }
  if (typeof a === "number" && typeof b === "string") return a === toNumber(b);
  if (typeof a === "string" && typeof b === "number") return toNumber(a) === b;
  if (typeof a === "boolean" && typeof b === "number") return toNumber(a) === b;
  if (typeof a === "number" && typeof b === "boolean") return a === toNumber(b);
  return false;
}

function compare(l: unknown, r: unknown): number {
  const ln = toNumber(l);
  const rn = toNumber(r);
  if (!Number.isNaN(ln) && !Number.isNaN(rn)) return ln === rn ? 0 : ln < rn ? -1 : 1;
  if (typeof l === "string" && typeof r === "string") return l === r ? 0 : l < r ? -1 : 1;
  return NaN; // undefined and mixed-type comparisons are simply false
}

const BUILTINS: Record<string, (args: unknown[]) => unknown> = {
  startsWith: ([a, b]) => (a === undefined || a === null ? false : String(a).startsWith(b === undefined || b === null ? "" : String(b))),
  endsWith: ([a, b]) => (a === undefined || a === null ? false : String(a).endsWith(b === undefined || b === null ? "" : String(b))),
  contains: ([a, b]) => {
    if (a === undefined || a === null) return false;
    if (Array.isArray(a)) return a.includes(b);
    return String(a).includes(b === undefined || b === null ? "" : String(b));
  },
  matches: ([a, pattern]) => {
    if (a === undefined || a === null || typeof pattern !== "string") return false;
    try {
      return new RegExp(pattern).test(String(a));
    } catch {
      return false; // invalid regex => no match, never throws
    }
  },
  len: ([a]) => {
    if (a === undefined || a === null) return 0;
    if (typeof a === "string") return a.length;
    if (Array.isArray(a)) return a.length;
    if (typeof a === "object") return Object.keys(a).length;
    return 0;
  },
  lower: ([a]) => (a === undefined || a === null ? "" : String(a).toLowerCase()),
  upper: ([a]) => (a === undefined || a === null ? "" : String(a).toUpperCase()),
};

function evalNode(node: Node, ctx: Record<string, unknown>): unknown {
  switch (node.k) {
    case "lit":
      return node.v;
    case "path":
      return resolvePath(ctx, node.names);
    case "call": {
      const fn = BUILTINS[node.name];
      if (!fn) throw new PolicyExprError(`unknown function "${node.name}"`);
      return fn(node.args.map((a) => evalNode(a, ctx)));
    }
    case "un": {
      const v = evalNode(node.e, ctx);
      if (node.op === "!") return !truthy(v);
      return -toNumber(v);
    }
    case "bin": {
      if (node.op === "&&") {
        const l = evalNode(node.l, ctx);
        return truthy(l) ? evalNode(node.r, ctx) : l;
      }
      if (node.op === "||") {
        const l = evalNode(node.l, ctx);
        return truthy(l) ? l : evalNode(node.r, ctx);
      }
      const l = evalNode(node.l, ctx);
      const r = evalNode(node.r, ctx);
      switch (node.op) {
        case "==":
          return looseEquals(l, r);
        case "!=":
          return !looseEquals(l, r);
        case "<":
          return compare(l, r) < 0;
        case "<=":
          return compare(l, r) <= 0;
        case ">":
          return compare(l, r) > 0;
        case ">=":
          return compare(l, r) >= 0;
        case "+":
          if (typeof l === "string" || typeof r === "string") return String(l) + String(r);
          return toNumber(l) + toNumber(r);
        case "-":
          return toNumber(l) - toNumber(r);
        case "*":
          return toNumber(l) * toNumber(r);
        case "/":
          return toNumber(l) / toNumber(r);
        case "%":
          return toNumber(l) % toNumber(r);
        default:
          throw new PolicyExprError(`unsupported operator "${node.op}"`);
      }
    }
  }
}

/**
 * Evaluate a conditions expression against a pure data context. Throws
 * PolicyExprError on syntax/unknown-function errors; callers that need a
 * non-throwing channel should use evaluateConditions().
 */
export function evaluateExpression(src: string, ctx: Record<string, unknown>): PolicyExprValue {
  const ast = new Parser(tokenize(src)).parseExpression();
  const v = evalNode(ast, ctx);
  if (typeof v === "boolean" || typeof v === "number" || typeof v === "string") return v;
  return truthy(v); // undefined / null / objects / arrays collapse to boolean
}

export interface ConditionsResult {
  result: "pass" | "fail" | "skip";
  error?: string;
}

/**
 * Evaluate a policy `conditions` JSON document of the shape `{ expr: string }`.
 * Empty / null / missing `expr` => "skip" (the rule matches on its tuple alone).
 * A false result or an evaluation error => "fail" (the rule does not hit);
 * the error text is returned for audit detail. This function never throws.
 */
export function evaluateConditions(conditions: unknown, ctx: Record<string, unknown>): ConditionsResult {
  try {
    if (conditions === null || conditions === undefined) return { result: "skip" };
    if (typeof conditions !== "object" || Array.isArray(conditions)) return { result: "skip" };
    const expr = (conditions as Record<string, unknown>).expr;
    if (typeof expr !== "string" || expr.trim() === "") return { result: "skip" };
    return { result: truthy(evaluateExpression(expr, ctx)) ? "pass" : "fail" };
  } catch (e) {
    return { result: "fail", error: e instanceof Error ? e.message : String(e) };
  }
}
