/**
 * Compile a surface source into a program, and hold one program's runtime
 * state. `compileSurface` is pure; `createSurface` installs `{@state}`
 * declarations into a `SurfaceState` and hands the renderer a scope of
 * current values plus setters.
 */
import { Parser } from 'acorn';
import { splitDirectives } from './directives.js';
import { diagnosticOf, type GenuiDiagnostic } from './errors.js';
import { evaluate, type AstNode } from './evaluate.js';
import { parseView, type UiNode } from './jsx.js';
import { parseStateDirective, SurfaceState, type StateDeclaration } from './state.js';

export interface SurfaceProgram {
  readonly declarations: StateDeclaration[];
  readonly view: UiNode;
  readonly diagnostics: GenuiDiagnostic[];
}

export function compileSurface(source: string): SurfaceProgram {
  const { view, directives } = splitDirectives(source);
  const diagnostics: GenuiDiagnostic[] = [];
  const declarations: StateDeclaration[] = [];
  for (const directive of directives) {
    if (directive.name !== 'state') {
      diagnostics.push({ phase: 'directives', message: `unknown directive '@${directive.name}'` });
      continue;
    }
    try {
      declarations.push(
        ...parseStateDirective(directive.code, (src) =>
          Parser.parse(src, { ecmaVersion: 'latest' })
        )
      );
    } catch (error) {
      diagnostics.push({ ...diagnosticOf(error, 'state'), offset: directive.offset });
    }
  }
  let tree: UiNode;
  try {
    tree = parseView(view);
  } catch (error) {
    diagnostics.push(diagnosticOf(error, 'jsx'));
    tree = { kind: 'text', parts: [] };
  }
  return { declarations, view: tree, diagnostics };
}

export interface Surface {
  readonly id: string;
  readonly program: SurfaceProgram;
  readonly state: SurfaceState;
  readonly diagnostics: GenuiDiagnostic[];
}

/**
 * A host may pass a long-lived `state` store: re-declared slots keep committed
 * values across program revisions, which is the Revision contract.
 */
export function createSurface(
  id: string,
  program: SurfaceProgram,
  options: { maxSteps?: number; state?: SurfaceState } = {}
): Surface {
  const state = options.state ?? new SurfaceState(id);
  const diagnostics = [...program.diagnostics];
  const scope: Record<string, unknown> = {};
  for (const declaration of program.declarations) {
    if (Object.hasOwn(scope, declaration.name)) {
      diagnostics.push({ phase: 'state', message: `duplicate state '${declaration.name}'` });
      continue;
    }
    try {
      const initial = evaluate(declaration.init, scope, { maxSteps: options.maxSteps });
      state.declare(declaration.name, initial);
      scope[declaration.name] = state.get(declaration.name);
      scope[declaration.setter] = state.makeSetter(declaration.name);
    } catch (error) {
      diagnostics.push(diagnosticOf(error, 'state'));
    }
  }
  return { id, program, state, diagnostics };
}

/**
 * The scope expressions evaluate against: committed state values plus their
 * declared setters. Rebuilt per render so expressions see the latest values.
 */
export function surfaceScope(
  surface: Surface,
  globals?: Record<string, unknown>
): Record<string, unknown> {
  const scope: Record<string, unknown> = { ...globals };
  for (const declaration of surface.program.declarations) {
    if (!(declaration.name in scope)) scope[declaration.name] = surface.state.get(declaration.name);
    if (!(declaration.setter in scope))
      scope[declaration.setter] = surface.state.makeSetter(declaration.name);
  }
  return scope;
}

/** Evaluate one `UiValue` prop against the current scope; errors surface as diagnostics. */
export function evalValue(
  value: import('./jsx.js').UiValue,
  scope: Record<string, unknown>
): unknown {
  if (value.kind === 'literal') return value.value;
  return evaluate(value.node as AstNode, scope);
}
