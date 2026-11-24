/**
 * Renders a committed ```genui fence as a live surface. The surface's state
 * survives remounts under `surfaceId` (or the fence's code): virtualized rows
 * that scroll away and back keep the user's in-progress input, matching the
 * host-owned state the runtime promises.
 *
 * Evaluation is per-render over a versioned state store: every committed
 * write bumps the version, `useSyncExternalStore` re-renders, and every
 * expression re-evaluates against the latest scope — no dependency tracking.
 */
import stylex from '@stylexjs/stylex';
import {
  callValue,
  compileSurface,
  compileSurfacePartial,
  createSurface,
  evaluate,
  isInterpretedFunction,
  SurfaceState,
  surfaceScope,
  type GenuiDiagnostic,
  type Surface,
  type UiNode,
  type UiValue,
} from '@lody/genui';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { Fragment, useMemo, useReducer, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { GENU_CATALOG } from './genui-catalog.js';

const surfaces = new Map<string, SurfaceState>();

function stateFor(key: string): SurfaceState {
  let state = surfaces.get(key);
  if (!state) {
    state = new SurfaceState(key);
    surfaces.set(key, state);
  }
  return state;
}

const styles = stylex.create({
  surface: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    marginBlock: space[2],
  },
  error: {
    color: colors.destructive,
    backgroundColor: colors.wellBackground,
    borderRadius: radius.medium,
    padding: space[2],
    fontSize: '0.85em',
    lineHeight: text.subheadlineLeading,
  },
  unknownTag: {
    color: colors.tertiaryLabel,
    fontStyle: 'italic',
  },
  pending: {
    color: colors.tertiaryLabel,
    fontFamily: 'monospace',
    fontSize: '0.75em',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    opacity: 0.6,
  },
});

function GenuiErrorView({ diagnostics }: { diagnostics: GenuiDiagnostic[] }) {
  const { t } = useTranslation();
  return (
    <div {...stylex.props(styles.error)} role="alert">
      {t('sessions.genui.error', 'This block could not be rendered.')}
      {diagnostics.map((diagnostic, index) => (
        <div key={index}>
          {diagnostic.phase}: {diagnostic.message}
        </div>
      ))}
    </div>
  );
}

interface RenderContext {
  scope: Record<string, unknown>;
  diagnostics: GenuiDiagnostic[];
  /** Event-time failures: the render that produced this callback has settled. */
  report: (diagnostic: GenuiDiagnostic) => void;
}

function evalUiValue(value: UiValue, ctx: RenderContext): unknown {
  if (value.kind === 'literal') return value.value;
  try {
    return evaluate(value.node, ctx.scope);
  } catch (error) {
    ctx.diagnostics.push({
      phase: 'eval',
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function renderUiNode(node: UiNode, ctx: RenderContext, key: number): ReactNode {
  if (node.kind === 'text') {
    return node.parts
      .map((part) => (typeof part === 'string' ? part : evalUiValue(part, ctx)))
      .map((part) => (part === undefined || part === null ? '' : String(part)))
      .join('');
  }
  const renderer = GENU_CATALOG[node.tag];
  if (node.tag === '#fragment') {
    return node.children.map((child, index) => (
      <Fragment key={index}>{renderUiNode(child, ctx, index)}</Fragment>
    ));
  }
  if (!renderer) {
    ctx.diagnostics.push({ phase: 'catalog', message: `unknown component '${node.tag}'` });
    return (
      <span key={key} {...stylex.props(styles.unknownTag)}>
        {`<${node.tag}>`}
        {node.children.map((child, index) => (
          <Fragment key={index}>{renderUiNode(child, ctx, index)}</Fragment>
        ))}
      </span>
    );
  }
  const props: Record<string, unknown> = {};
  for (const prop of node.props) {
    const value = evalUiValue(prop.value, ctx);
    if (prop.spread) {
      if (typeof value === 'object' && value !== null) Object.assign(props, value);
      continue;
    }
    props[prop.name] = isInterpretedFunction(value)
      ? (...args: unknown[]) => {
          try {
            return callValue(value, undefined, args);
          } catch (error) {
            ctx.report({
              phase: 'eval',
              message: error instanceof Error ? error.message : String(error),
            });
            return undefined;
          }
        }
      : value;
  }
  const children = node.children.map((child, index) => (
    <Fragment key={index}>{renderUiNode(child, ctx, index)}</Fragment>
  ));
  return renderer({ ...props, children });
}

export interface GenuiSurfaceProps {
  /** The fence body. */
  code: string;
  /** Stable identity for host-owned state, e.g. `${messageId}:${index}`. */
  surfaceId?: string;
  /** Host capabilities exposed under the `lody` namespace. */
  capabilities?: Record<string, unknown>;
  /**
   * The fence is still being written: tolerate a truncated tail and mount
   * elements as their open tags commit instead of waiting for the fence.
   */
  streaming?: boolean;
  /**
   * Rendered instead of the diagnostics panel when the surface cannot mount,
   * e.g. the fenced code block it came from. When set, diagnostics never
   * reach the reader: they describe the author's mistake, not content.
   */
  fallback?: ReactNode;
}

export function GenuiSurface({
  code,
  surfaceId,
  capabilities,
  streaming,
  fallback,
}: GenuiSurfaceProps) {
  const key = surfaceId ?? `code:${code}`;
  const program = useMemo(
    () => (streaming ? compileSurfacePartial(code) : compileSurface(code)),
    [code, streaming]
  );
  const surface: Surface = useMemo(
    () => createSurface(key, program, { state: stateFor(key) }),
    [key, program]
  );
  useSyncExternalStore(surface.state.subscribe.bind(surface.state), () => surface.state.version);
  const eventDiagnostics = useRef<GenuiDiagnostic[]>([]);
  const [, reportEvent] = useReducer((n: number) => n + 1, 0);
  const lastKey = useRef(key);
  if (lastKey.current !== key) {
    lastKey.current = key;
    eventDiagnostics.current = [];
  }
  const scope = surfaceScope(surface, { lody: capabilities ?? {} });
  const ctx: RenderContext = {
    scope,
    diagnostics: [],
    report: (diagnostic) => {
      eventDiagnostics.current.push(diagnostic);
      reportEvent();
    },
  };
  const body = renderUiNode(surface.program.view, ctx, 0);
  const diagnostics = [...surface.diagnostics, ...ctx.diagnostics, ...eventDiagnostics.current];
  const pending =
    'pending' in program && typeof program.pending === 'string' ? program.pending : '';
  const empty =
    (surface.program.view.kind === 'text' && (surface.program.view.parts?.length ?? 0) === 0) ||
    (surface.program.view.kind === 'element' && surface.program.view.children.length === 0);
  const fatal = empty && !streaming;
  return (
    <div {...stylex.props(styles.surface)}>
      {fatal ? (fallback ?? <GenuiErrorView diagnostics={diagnostics} />) : body}
      {pending !== '' ? <div {...stylex.props(styles.pending)}>{pending}</div> : null}
      {!fatal && fallback === undefined && diagnostics.length > 0 ? (
        <GenuiErrorView diagnostics={diagnostics.slice(0, 3)} />
      ) : null}
    </div>
  );
}
