/**
 * Host-owned interaction state for one surface. The model's program declares
 * slots through `{@state const [value, setValue] = useState(init)}`; the store
 * owns the values, the host owns the lifecycle, and writes bump a version the
 * renderer subscribes to. Setters accept a literal or an updater arrow, so
 * `setValue(v => v + 1)` reads the committed value, never a stale closure.
 */
import { callValue, isInterpretedFunction } from './evaluate.js';
import { GenuiError } from './errors.js';

export interface StateDeclaration {
  /** The binding name expressions read (`value`). */
  readonly name: string;
  /** The setter name expressions call (`setValue`). */
  readonly setter: string;
  /** Parsed initializer expression. */
  readonly init: import('./evaluate.js').AstNode;
}

export class SurfaceState {
  private readonly slots = new Map<string, unknown>();
  private readonly listeners = new Set<() => void>();
  private changeVersion = 0;

  constructor(private readonly surfaceId: string) {}

  get version() {
    return this.changeVersion;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Declare a slot once; a re-declare keeps the committed value (Revision semantics). */
  declare(name: string, initial: unknown) {
    if (!this.slots.has(name)) this.slots.set(name, initial);
  }

  get(name: string): unknown {
    return this.slots.get(name);
  }

  keys(): string[] {
    return [...this.slots.keys()];
  }

  snapshot(): Record<string, unknown> {
    return Object.fromEntries(this.slots);
  }

  set(name: string, next: unknown | ((current: unknown) => unknown)) {
    if (!this.slots.has(name)) {
      throw new GenuiError('state', `unknown state '${name}' for ${this.surfaceId}`);
    }
    const current = this.slots.get(name);
    const value = typeof next === 'function' ? (next as (c: unknown) => unknown)(current) : next;
    this.slots.set(name, value);
    this.changeVersion += 1;
    for (const listener of this.listeners) listener();
  }

  /** Build the setter a `{@state}` declaration installs in the program scope. */
  makeSetter(name: string): (next: unknown) => void {
    return (next: unknown) => {
      this.set(
        name,
        isInterpretedFunction(next)
          ? (current: unknown) => callValue(next, undefined, [current])
          : next
      );
    };
  }
}

/**
 * Parse one `{@state ...}` directive body: comma-separated `useState` const
 * declarations. Anything else is rejected — state is declared, not computed.
 */
export function parseStateDirective(
  code: string,
  parser: (src: string) => unknown
): StateDeclaration[] {
  const program = parser(code) as { body: AstNodeLike[] };
  const declarations: StateDeclaration[] = [];
  for (const statement of program.body) {
    if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const') {
      throw new GenuiError('state', '{@state} accepts only `const [x, setX] = useState(init)`');
    }
    for (const declaration of statement.declarations as AstNodeLike[]) {
      declarations.push(parseStateDeclarator(declaration));
    }
  }
  return declarations;
}

interface AstNodeLike {
  type: string;
  [key: string]: unknown;
}

function parseStateDeclarator(declaration: AstNodeLike): StateDeclaration {
  const id = declaration.id as AstNodeLike;
  const init = declaration.init as AstNodeLike | null;
  const isUseState =
    init?.type === 'CallExpression' &&
    (init.callee as AstNodeLike).type === 'Identifier' &&
    (init.callee as AstNodeLike).name === 'useState';
  if (id.type !== 'ArrayPattern' || !isUseState) {
    throw new GenuiError('state', 'state must be declared as `const [x, setX] = useState(init)`');
  }
  const [nameEl, setterEl] = id.elements as (AstNodeLike | null)[];
  if (nameEl?.type !== 'Identifier' || setterEl?.type !== 'Identifier') {
    throw new GenuiError('state', 'useState must destructure `[name, setName]`');
  }
  const args = init.arguments as AstNodeLike[];
  return {
    name: nameEl.name as string,
    setter: setterEl.name as string,
    init: (args[0] ?? { type: 'Literal', value: undefined, start: 0, end: 0 }) as never,
  };
}
