/**
 * A confined evaluator for the JavaScript expression subset a Generative UI
 * surface may run: literals, templates, arithmetic, conditionals, arrow
 * functions, calls and member access over state and host capabilities.
 *
 * There is no global object, no module system and no ambient API: every name
 * resolves against an explicit scope, and the only functions a program can
 * call are host-provided ones and arrows it defined itself. Evaluation is
 * synchronous, single-stepped and budgeted, so a hostile or broken program
 * fails with a diagnostic instead of hanging the renderer.
 */
import { GenuiError } from './errors.js';

/** Loose ESTree node; field access goes through the `field()` helper. */
export interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

function field<T>(node: AstNode, key: string): T {
  return node[key] as T;
}

export class EvalAbort extends GenuiError {
  constructor(message: string, node?: AstNode) {
    super('eval', node ? `${message} (${node.type})` : message, node?.start);
  }
}

/** Returned by arrow/function expressions; call through `callValue`. */
interface InterpretedFunction {
  readonly kind: 'genui-fn';
  readonly params: AstNode[];
  readonly body: AstNode;
  readonly env: Env;
  readonly budget: Budget;
}

export function isInterpretedFunction(value: unknown): value is InterpretedFunction {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as InterpretedFunction).kind === 'genui-fn'
  );
}

/** Property names that must never be read or written through member access. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

class Budget {
  private remaining: number;
  private depth = 0;
  constructor(
    steps: number,
    private readonly maxDepth: number
  ) {
    this.remaining = steps;
  }
  step(node: AstNode) {
    this.remaining -= 1;
    if (this.remaining <= 0) {
      throw new EvalAbort('evaluation budget exceeded', node);
    }
  }
  enter(node: AstNode) {
    this.depth += 1;
    if (this.depth > this.maxDepth) {
      throw new EvalAbort('call depth exceeded', node);
    }
  }
  leave() {
    this.depth -= 1;
  }
}

class Env {
  private readonly vars = new Map<string, { value: unknown; mutable: boolean }>();
  constructor(private readonly parent: Env | undefined = undefined) {}

  declare(name: string, value: unknown, mutable: boolean) {
    this.vars.set(name, { value, mutable });
  }
  has(name: string): boolean {
    return this.vars.has(name) || this.parent?.has(name) === true;
  }
  get(name: string, node?: AstNode): unknown {
    const local = this.vars.get(name);
    if (local !== undefined) return local.value;
    if (this.parent) return this.parent.get(name, node);
    throw new EvalAbort(`unknown name '${name}'`, node);
  }
  assign(name: string, value: unknown, node: AstNode) {
    const local = this.vars.get(name);
    if (local !== undefined) {
      if (!local.mutable) throw new EvalAbort(`cannot reassign '${name}'`, node);
      local.value = value;
      return;
    }
    if (this.parent) {
      this.parent.assign(name, value, node);
      return;
    }
    throw new EvalAbort(`cannot assign to unknown name '${name}'`, node);
  }
}

class ReturnSignal {
  constructor(readonly value: unknown) {}
}
class BreakSignal {}
class ContinueSignal {}

export interface EvaluateOptions {
  /** Node-visit cap per evaluation; default 20_000. */
  maxSteps?: number;
  /** Nested call depth cap; default 64. */
  maxDepth?: number;
  /** Extra names visible to the program beyond `scope` (e.g. `lody` capabilities). */
  globals?: Record<string, unknown>;
}

/** The safe global surface: pure, ambient values only. */
const SAFE_GLOBALS: Record<string, unknown> = Object.freeze({
  Math,
  JSON,
  Number,
  String,
  Boolean,
  Array,
  Object: Object.freeze({
    keys: Object.keys,
    values: Object.values,
    entries: Object.entries,
    assign: Object.assign,
    fromEntries: Object.fromEntries,
    is: Object.is,
  }),
  isNaN,
  isFinite,
  parseFloat,
  parseInt,
  undefined,
  NaN,
  Infinity,
});

/**
 * Evaluate an already-parsed expression node against `scope`.
 * `scope` entries are read-only to the program; mutation belongs to Actions.
 */
export function evaluate(
  node: AstNode,
  scope: Record<string, unknown>,
  options: EvaluateOptions = {}
): unknown {
  const budget = new Budget(options.maxSteps ?? 20_000, options.maxDepth ?? 64);
  const env = new Env();
  for (const [name, value] of Object.entries({ ...SAFE_GLOBALS, ...options.globals })) {
    env.declare(name, value, false);
  }
  for (const [name, value] of Object.entries(scope)) {
    env.declare(name, value, false);
  }
  return evalNode(node, env, budget);
}

/** Invoke a value produced by `evaluate` (a host function or an interpreted arrow). */
export function callValue(fn: unknown, thisArg: unknown, args: unknown[]): unknown {
  if (isInterpretedFunction(fn)) {
    return callInterpreted(fn, args);
  }
  if (typeof fn === 'function') {
    return (fn as (...a: unknown[]) => unknown).apply(thisArg, args);
  }
  throw new GenuiError('eval', 'attempted to call a non-function value');
}

function callInterpreted(fn: InterpretedFunction, args: unknown[]): unknown {
  const frame: AstNode = { type: 'CallFrame', start: 0, end: 0 };
  fn.budget.enter(frame);
  try {
    const env = new Env(fn.env);
    bindParams(fn.params, args, env, fn.budget);
    if (fn.body.type === 'BlockStatement') {
      try {
        runBlock(fn.body, env, fn.budget);
      } catch (signal) {
        if (signal instanceof ReturnSignal) return signal.value;
        throw signal;
      }
      return undefined;
    }
    return evalNode(fn.body, env, fn.budget);
  } finally {
    fn.budget.leave();
  }
}

function bindParams(params: AstNode[], args: unknown[], env: Env, budget: Budget) {
  let index = 0;
  for (const param of params) {
    if (param.type === 'RestElement') {
      const argument = field<AstNode>(param, 'argument');
      env.declare(field<string>(argument, 'name'), args.slice(index), false);
      index = args.length;
      continue;
    }
    bindPattern(param, args[index], env, undefined, budget);
    index += 1;
  }
}

/**
 * Bind a destructuring pattern. With `declared` omitted the names land in
 * `env` as immutable bindings (function parameters); with a map the names are
 * collected so the caller can declare them with the statement's mutability.
 */
function bindPattern(
  pattern: AstNode,
  value: unknown,
  env: Env,
  declared: Map<string, unknown> | undefined,
  budget: Budget
) {
  const put = (name: string, v: unknown) => {
    if (declared) declared.set(name, v);
    else env.declare(name, v, false);
  };
  switch (pattern.type) {
    case 'Identifier':
      put(field<string>(pattern, 'name'), value);
      return;
    case 'AssignmentPattern': {
      const next =
        value === undefined ? evalNode(field<AstNode>(pattern, 'right'), env, budget) : value;
      bindPattern(field<AstNode>(pattern, 'left'), next, env, declared, budget);
      return;
    }
    case 'RestElement':
      bindPattern(field<AstNode>(pattern, 'argument'), value, env, declared, budget);
      return;
    case 'ArrayPattern': {
      const items = Array.isArray(value) ? value : [];
      field<(AstNode | null)[]>(pattern, 'elements').forEach((element, i) => {
        if (element) bindPattern(element, items[i], env, declared, budget);
      });
      return;
    }
    case 'ObjectPattern': {
      const source: Record<string, unknown> =
        typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
      for (const prop of field<AstNode[]>(pattern, 'properties')) {
        if (prop.type === 'RestElement') continue;
        bindPattern(field<AstNode>(prop, 'value'), source[patternKey(prop)], env, declared, budget);
      }
      return;
    }
    default:
      throw new EvalAbort(`unsupported binding pattern '${pattern.type}'`, pattern);
  }
}

function patternKey(prop: AstNode): string {
  const key = field<AstNode>(prop, 'key');
  if (key.type === 'Identifier') return field<string>(key, 'name');
  if (key.type === 'Literal') return String(field(key, 'value'));
  throw new EvalAbort('expected a static key', key);
}

/** Evaluate a node inside an existing environment (statements + expressions). */
function evalNode(node: AstNode, env: Env, budget: Budget): unknown {
  budget.step(node);
  switch (node.type) {
    case 'Literal':
      return field(node, 'value');
    case 'TemplateLiteral': {
      let out = '';
      const quasis = field<AstNode[]>(node, 'quasis');
      const exprs = field<AstNode[]>(node, 'expressions');
      quasis.forEach((quasi, i) => {
        const cooked = field<{ cooked?: string; raw: string }>(quasi, 'value');
        out += cooked.cooked ?? cooked.raw;
        if (i < exprs.length) out += String(evalNode(exprs[i], env, budget) ?? '');
      });
      return out;
    }
    case 'Identifier':
      return env.get(field<string>(node, 'name'), node);
    case 'ParenthesizedExpression':
      return evalNode(field<AstNode>(node, 'expression'), env, budget);
    case 'UnaryExpression':
      return evalUnary(node, evalNode(field<AstNode>(node, 'argument'), env, budget));
    case 'BinaryExpression':
      return evalBinary(node, env, budget);
    case 'LogicalExpression':
      return evalLogical(node, env, budget);
    case 'ConditionalExpression':
      return evalNode(field<AstNode>(node, 'test'), env, budget)
        ? evalNode(field<AstNode>(node, 'consequent'), env, budget)
        : evalNode(field<AstNode>(node, 'alternate'), env, budget);
    case 'ArrayExpression': {
      const out: unknown[] = [];
      for (const element of field<(AstNode | null)[]>(node, 'elements')) {
        if (!element) {
          out.push(undefined);
        } else if (element.type === 'SpreadElement') {
          const spread = evalNode(field<AstNode>(element, 'argument'), env, budget);
          if (!isIterable(spread)) throw new EvalAbort('spread value is not iterable', element);
          out.push(...(spread as unknown[]));
        } else {
          out.push(evalNode(element, env, budget));
        }
      }
      return out;
    }
    case 'ObjectExpression': {
      const out: Record<string, unknown> = {};
      for (const prop of field<AstNode[]>(node, 'properties')) {
        if (prop.type === 'SpreadElement') {
          const spread = evalNode(field<AstNode>(prop, 'argument'), env, budget);
          if (typeof spread === 'object' && spread !== null) Object.assign(out, spread);
          continue;
        }
        const computed = field<boolean>(prop, 'computed') === true;
        const keyNode = field<AstNode>(prop, 'key');
        const key = computed
          ? String(evalNode(keyNode, env, budget))
          : keyNode.type === 'Identifier'
            ? field<string>(keyNode, 'name')
            : String(field(keyNode, 'value'));
        if (FORBIDDEN_KEYS.has(key)) throw new EvalAbort(`cannot set '${key}'`, prop);
        out[key] = evalNode(field<AstNode>(prop, 'value'), env, budget);
      }
      return out;
    }
    case 'MemberExpression':
      return evalMember(node, env, budget).value;
    case 'CallExpression':
      return evalCall(node, env, budget);
    case 'ChainExpression':
      return evalNode(field<AstNode>(node, 'expression'), env, budget);
    case 'SequenceExpression': {
      let result: unknown;
      for (const expr of field<AstNode[]>(node, 'expressions')) {
        result = evalNode(expr, env, budget);
      }
      return result;
    }
    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
      return makeFunction(node, env, budget);
    case 'AssignmentExpression':
      return evalAssignment(node, env, budget);
    case 'UpdateExpression':
      return evalUpdate(node, env);
    case 'ThisExpression':
      return undefined;
    default:
      throw new EvalAbort(`unsupported expression '${node.type}'`, node);
  }
}

function makeFunction(node: AstNode, env: Env, budget: Budget): InterpretedFunction {
  if (field<boolean>(node, 'async')) throw new EvalAbort('async functions are not supported', node);
  if (field<boolean>(node, 'generator'))
    throw new EvalAbort('generator functions are not supported', node);
  return {
    kind: 'genui-fn',
    params: field<AstNode[]>(node, 'params'),
    body: field<AstNode>(node, 'body'),
    env,
    budget,
  };
}

function evalUnary(node: AstNode, value: unknown): unknown {
  switch (field<string>(node, 'operator')) {
    case '!':
      return !value;
    case '-':
      return -(value as number);
    case '+':
      return +(value as number);
    case '~':
      return ~(value as number);
    case 'typeof':
      return typeof value;
    case 'void':
      return undefined;
    default:
      throw new EvalAbort(`unsupported unary '${field<string>(node, 'operator')}'`, node);
  }
}

function evalBinary(node: AstNode, env: Env, budget: Budget): unknown {
  const op = field<string>(node, 'operator');
  const left = evalNode(field<AstNode>(node, 'left'), env, budget);
  const right = evalNode(field<AstNode>(node, 'right'), env, budget);
  switch (op) {
    case '+':
      return (left as number) + (right as number);
    case '-':
      return (left as number) - (right as number);
    case '*':
      return (left as number) * (right as number);
    case '/':
      return (left as number) / (right as number);
    case '%':
      return (left as number) % (right as number);
    case '**':
      return (left as number) ** (right as number);
    case '==':
      // eslint-disable-next-line eqeqeq -- the DSL exposes JS equality semantics to authors.
      return left == right;
    case '!=':
      // eslint-disable-next-line eqeqeq
      return left != right;
    case '===':
      return left === right;
    case '!==':
      return left !== right;
    case '<':
      return (left as number) < (right as number);
    case '<=':
      return (left as number) <= (right as number);
    case '>':
      return (left as number) > (right as number);
    case '>=':
      return (left as number) >= (right as number);
    case '&':
      return (left as number) & (right as number);
    case '|':
      return (left as number) | (right as number);
    case '^':
      return (left as number) ^ (right as number);
    case '<<':
      return (left as number) << (right as number);
    case '>>':
      return (left as number) >> (right as number);
    case '>>>':
      return (left as number) >>> (right as number);
    case 'in':
      if (typeof right !== 'object' || right === null)
        throw new EvalAbort("'in' right side must be an object", node);
      return String(left) in right;
    case 'instanceof':
      throw new EvalAbort("'instanceof' is not supported", node);
    default:
      throw new EvalAbort(`unsupported operator '${op}'`, node);
  }
}

function evalLogical(node: AstNode, env: Env, budget: Budget): unknown {
  const left = evalNode(field<AstNode>(node, 'left'), env, budget);
  switch (field<string>(node, 'operator')) {
    case '&&':
      return left ? evalNode(field<AstNode>(node, 'right'), env, budget) : left;
    case '||':
      return left ? left : evalNode(field<AstNode>(node, 'right'), env, budget);
    case '??':
      return left ?? evalNode(field<AstNode>(node, 'right'), env, budget);
    default:
      throw new EvalAbort('unsupported logical operator', node);
  }
}

function memberKey(node: AstNode, env: Env, budget: Budget): string {
  const computed = field<boolean>(node, 'computed') === true;
  const prop = field<AstNode>(node, 'property');
  const key = computed
    ? evalNode(prop, env, budget)
    : prop.type === 'Identifier'
      ? field<string>(prop, 'name')
      : String(field(prop, 'value'));
  const name = String(key);
  if (FORBIDDEN_KEYS.has(name)) {
    throw new EvalAbort(`cannot access '${name}'`, node);
  }
  return name;
}

function evalMember(node: AstNode, env: Env, budget: Budget): { value: unknown; thisArg: unknown } {
  const obj = evalNode(field<AstNode>(node, 'object'), env, budget);
  const optional = field<boolean>(node, 'optional') === true;
  if (obj == null) {
    if (optional) return { value: undefined, thisArg: undefined };
    throw new EvalAbort('cannot read property of null or undefined', node);
  }
  const key = memberKey(node, env, budget);
  return {
    value: (obj as Record<string, unknown>)[key],
    thisArg: obj,
  };
}

const ARRAY_CALLBACK_METHODS = new Set([
  'map',
  'filter',
  'forEach',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'every',
  'some',
  'flatMap',
  'sort',
  'reduce',
  'reduceRight',
]);

function evalCall(node: AstNode, env: Env, budget: Budget): unknown {
  const calleeNode = field<AstNode>(node, 'callee');
  let fn: unknown;
  let thisArg: unknown;
  if (calleeNode.type === 'MemberExpression') {
    const obj = evalNode(field<AstNode>(calleeNode, 'object'), env, budget);
    const optional =
      field<boolean>(calleeNode, 'optional') === true || field<boolean>(node, 'optional') === true;
    if (obj == null) {
      if (optional) return undefined;
      throw new EvalAbort('cannot call a member of null or undefined', node);
    }
    const key = memberKey(calleeNode, env, budget);
    thisArg = obj;
    fn = (obj as Record<string, unknown>)[key];
    if (fn == null && optional) return undefined;
    if (Array.isArray(obj) && ARRAY_CALLBACK_METHODS.has(key)) {
      return runArrayMethod(obj, key, node, env, budget);
    }
  } else {
    fn = evalNode(calleeNode, env, budget);
    if (fn == null && field<boolean>(node, 'optional') === true) return undefined;
  }
  if (fn == null) {
    throw new EvalAbort('called value is not a function', calleeNode);
  }
  const args: unknown[] = [];
  for (const arg of field<AstNode[]>(node, 'arguments')) {
    if (arg.type === 'SpreadElement') {
      const spread = evalNode(field<AstNode>(arg, 'argument'), env, budget);
      if (!isIterable(spread)) throw new EvalAbort('spread argument is not iterable', arg);
      args.push(...(spread as unknown[]));
    } else {
      args.push(evalNode(arg, env, budget));
    }
  }
  return callValue(fn, thisArg, args);
}

/**
 * Native array methods cannot call an InterpretedFunction, so the common
 * callback-taking methods run here instead. The callback receives the same
 * `(element, index, array)` shape native callers pass.
 */

function runArrayMethod(
  arr: unknown[],
  name: string,
  node: AstNode,
  env: Env,
  budget: Budget
): unknown {
  const args = (field<AstNode[]>(node, 'arguments') ?? []).map((arg) => evalNode(arg, env, budget));
  const callback = args[0];
  if (!isInterpretedFunction(callback) && name !== 'sort') {
    const builtin = (arr as never as Record<string, (...a: unknown[]) => unknown>)[name];
    return builtin.apply(arr, args);
  }
  const each = (...cbArgs: unknown[]) => callValue(callback, undefined, cbArgs);
  switch (name) {
    case 'map':
      return arr.map((el, i) => each(el, i, arr));
    case 'filter':
      return arr.filter((el, i) => each(el, i, arr));
    case 'forEach':
      arr.forEach((el, i) => each(el, i, arr));
      return undefined;
    case 'find':
      return arr.find((el, i) => each(el, i, arr));
    case 'findIndex':
      return arr.findIndex((el, i) => each(el, i, arr));
    case 'findLast':
      return arr.findLast((el: unknown, i: number) => each(el, i, arr));
    case 'findLastIndex':
      return arr.findLastIndex((el: unknown, i: number) => each(el, i, arr));
    case 'every':
      return arr.every((el, i) => each(el, i, arr));
    case 'some':
      return arr.some((el, i) => each(el, i, arr));
    case 'flatMap':
      return arr.flatMap((el, i) => each(el, i, arr) as unknown);
    case 'sort':
      return [...arr].sort((a, b) => each(a, b) as number);
    case 'reduce':
    case 'reduceRight': {
      const hasInit = args.length > 1;
      const source = name === 'reduce' ? arr : [...arr].reverse();
      let acc = hasInit ? args[1] : source[0];
      const start = hasInit ? 0 : 1;
      for (let i = start; i < source.length; i += 1) {
        acc = each(acc, source[i], i, arr);
      }
      if (!hasInit && source.length === 0) {
        throw new EvalAbort('reduce of empty array with no initial value', node);
      }
      return acc;
    }
    default:
      throw new EvalAbort(`unsupported array method '${name}'`, node);
  }
}

function evalAssignment(node: AstNode, env: Env, budget: Budget): unknown {
  const left = field<AstNode>(node, 'left');
  const operator = field<string>(node, 'operator');
  if (left.type !== 'Identifier') {
    throw new EvalAbort('only local variable assignment is supported', left);
  }
  const name = field<string>(left, 'name');
  const right = evalNode(field<AstNode>(node, 'right'), env, budget);
  const next = operator === '=' ? right : applyCompound(operator, env.get(name, node), right, node);
  env.assign(name, next, node);
  return next;
}

function applyCompound(operator: string, left: unknown, right: unknown, node: AstNode): unknown {
  switch (operator) {
    case '+=':
      return (left as number) + (right as number);
    case '-=':
      return (left as number) - (right as number);
    case '*=':
      return (left as number) * (right as number);
    case '/=':
      return (left as number) / (right as number);
    case '%=':
      return (left as number) % (right as number);
    case '??=':
      return left ?? right;
    case '&&=':
      return left && right;
    case '||=':
      return left || right;
    default:
      throw new EvalAbort(`unsupported assignment '${operator}'`, node);
  }
}

function evalUpdate(node: AstNode, env: Env): unknown {
  const argument = field<AstNode>(node, 'argument');
  if (argument.type !== 'Identifier') {
    throw new EvalAbort('only local variable update is supported', argument);
  }
  const name = field<string>(argument, 'name');
  const current = env.get(name, node) as number;
  const delta = field<string>(node, 'operator') === '++' ? 1 : -1;
  env.assign(name, current + delta, node);
  return field<boolean>(node, 'prefix') ? current + delta : current;
}

function runBlock(node: AstNode, env: Env, budget: Budget): void {
  for (const statement of field<AstNode[]>(node, 'body')) {
    runStatement(statement, env, budget);
  }
}

function runStatement(node: AstNode, env: Env, budget: Budget): void {
  budget.step(node);
  switch (node.type) {
    case 'ExpressionStatement':
      evalNode(field<AstNode>(node, 'expression'), env, budget);
      return;
    case 'VariableDeclaration': {
      const mutable = field<string>(node, 'kind') !== 'const';
      for (const declaration of field<AstNode[]>(node, 'declarations')) {
        const init = field<AstNode | null>(declaration, 'init');
        const declared = new Map<string, unknown>();
        bindPattern(
          field<AstNode>(declaration, 'id'),
          init ? evalNode(init, env, budget) : undefined,
          env,
          declared,
          budget
        );
        for (const [name, value] of declared) env.declare(name, value, mutable);
      }
      return;
    }
    case 'ReturnStatement': {
      const arg = field<AstNode | null>(node, 'argument');
      throw new ReturnSignal(arg ? evalNode(arg, env, budget) : undefined);
    }
    case 'IfStatement':
      if (evalNode(field<AstNode>(node, 'test'), env, budget)) {
        runStatement(field<AstNode>(node, 'consequent'), env, budget);
      } else {
        const alternate = field<AstNode | null>(node, 'alternate');
        if (alternate) runStatement(alternate, env, budget);
      }
      return;
    case 'BlockStatement':
      runBlock(node, new Env(env), budget);
      return;
    case 'ForStatement': {
      const loop = new Env(env);
      const init = field<AstNode | null>(node, 'init');
      if (init) {
        if (init.type === 'VariableDeclaration') runStatement(init, loop, budget);
        else evalNode(init, loop, budget);
      }
      for (;;) {
        const test = field<AstNode | null>(node, 'test');
        if (test && !evalNode(test, loop, budget)) break;
        try {
          runStatement(field<AstNode>(node, 'body'), loop, budget);
        } catch (signal) {
          if (signal instanceof BreakSignal) break;
          if (!(signal instanceof ContinueSignal)) throw signal;
        }
        const update = field<AstNode | null>(node, 'update');
        if (update) evalNode(update, loop, budget);
      }
      return;
    }
    case 'ForOfStatement': {
      const iterable = evalNode(field<AstNode>(node, 'right'), env, budget);
      if (!isIterable(iterable))
        throw new EvalAbort('for..of value is not iterable', field<AstNode>(node, 'right'));
      const loop = new Env(env);
      for (const item of iterable as Iterable<unknown>) {
        budget.step(node);
        const left = field<AstNode>(node, 'left');
        const iteration = new Env(loop);
        if (left.type === 'VariableDeclaration') {
          const declaration = field<AstNode[]>(left, 'declarations')[0];
          const declared = new Map<string, unknown>();
          bindPattern(field<AstNode>(declaration, 'id'), item, iteration, declared, budget);
          const mutable = field<string>(left, 'kind') !== 'const';
          for (const [name, value] of declared) iteration.declare(name, value, mutable);
        } else {
          bindPattern(left, item, iteration, undefined, budget);
        }
        try {
          runStatement(field<AstNode>(node, 'body'), iteration, budget);
        } catch (signal) {
          if (signal instanceof BreakSignal) break;
          if (!(signal instanceof ContinueSignal)) throw signal;
        }
      }
      return;
    }
    case 'WhileStatement':
    case 'DoWhileStatement': {
      const isDo = node.type === 'DoWhileStatement';
      for (;;) {
        if (!isDo && !evalNode(field<AstNode>(node, 'test'), env, budget)) break;
        try {
          runStatement(field<AstNode>(node, 'body'), env, budget);
        } catch (signal) {
          if (signal instanceof BreakSignal) break;
          if (!(signal instanceof ContinueSignal)) throw signal;
        }
        if (isDo && !evalNode(field<AstNode>(node, 'test'), env, budget)) break;
      }
      return;
    }
    case 'BreakStatement':
      throw new BreakSignal();
    case 'ContinueStatement':
      throw new ContinueSignal();
    case 'ThrowStatement':
      throw new GenuiError(
        'eval',
        `thrown value: ${String(evalNode(field<AstNode>(node, 'argument'), env, budget))}`
      );
    case 'EmptyStatement':
      return;
    default:
      throw new EvalAbort(`unsupported statement '${node.type}'`, node);
  }
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<symbol, unknown>)[Symbol.iterator] === 'function'
  );
}
