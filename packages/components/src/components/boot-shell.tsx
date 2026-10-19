import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { BOOT_SHELL_CSS, BOOT_SHELL_MARK_SIZE } from '@/lib/boot-shell';
import { BOOT_SHELL_MARK_DATA_URL } from '@/lib/boot-shell-mark';
import { DocumentStyle } from './document-style';
import {
  BOOT_SHELL_SIDEBAR_WIDTH,
  resolveBootShellLayout,
  type BootShellLayout,
} from '@/lib/boot-shell-script';

type Presentation = {
  status?: ReactNode;
  sidebar?: boolean;
  path?: string;
  layout?: BootShellLayout;
};
type Register = (id: string, presentation: Presentation | null) => void;
const BootPresentationContext = createContext<Register | null>(null);

/**
 * A stable visual surface across redirect, authentication and lazy-code gates.
 * Only committed BootShell instances own it. Router pending state bridges the
 * outgoing gate's Suspense cleanup until the destination can commit. Recovery
 * and settled destinations release it without waiting for motion. The dormant
 * surface is inert, hidden and has no live region.
 */
export function BootShellProvider({
  children,
  path = '/',
  sidebar = true,
  sidebarWidth,
  mobile = false,
  pending = false,
}: {
  children: ReactNode;
  path?: string;
  sidebar?: boolean;
  sidebarWidth?: number;
  mobile?: boolean;
  pending?: boolean;
}) {
  const [state, setState] = useState<{
    presentations: ReadonlyMap<string, Presentation>;
    last: Presentation | undefined;
  }>(() => ({ presentations: new Map(), last: undefined }));
  const register = useCallback<Register>((id, presentation) => {
    setState((previous) => {
      const next = new Map(previous.presentations);
      next.delete(id);
      if (presentation !== null) next.set(id, presentation);
      return { presentations: next, last: presentation ?? previous.last };
    });
  }, []);
  // The most recently committed owner wins; cleanup can only remove its own id.
  const owner = Array.from(state.presentations.values()).at(-1);
  // Suspense cleans up layout effects while hiding an outgoing route. Keep its
  // last committed presentation only until that navigation settles, never on
  // ordinary later navigations that have no boot gate of their own.
  const current = owner ?? (pending ? state.last : undefined);
  useLayoutEffect(() => {
    if (!pending && !owner && state.last) {
      setState((previous) => ({ ...previous, last: undefined }));
    }
  }, [pending, owner, state.last]);
  const layout = current?.layout ?? resolveBootShellLayout(current?.path ?? path);
  return (
    <BootPresentationContext.Provider value={register}>
      {children}
      <BootShellFrame
        active={current !== undefined}
        layout={layout}
        sidebar={layout === 'workspace' && (current?.sidebar ?? sidebar) && !mobile}
        sidebarWidth={sidebarWidth}
        mobile={mobile}
        status={current?.status}
      />
    </BootPresentationContext.Provider>
  );
}

/** Gate declaration, with a standalone first-frame equivalent for isolated callers. */
export function BootShell({ status, sidebar, path, layout }: Presentation) {
  const register = useContext(BootPresentationContext);
  const id = useId();
  const presentation = useMemo(
    () => ({ status, sidebar, path, layout }),
    [status, sidebar, path, layout]
  );
  useLayoutEffect(() => {
    if (!register) return undefined;
    register(id, presentation);
    return () => register(id, null);
  }, [id, presentation, register]);
  if (register) return null;
  return (
    <BootShellFrame
      status={status}
      sidebar={sidebar}
      layout={layout ?? (path ? resolveBootShellLayout(path) : undefined)}
    />
  );
}

function BootShellFrame({
  status,
  sidebar,
  layout,
  sidebarWidth,
  mobile,
  active = true,
}: Presentation & {
  layout?: BootShellLayout;
  sidebarWidth?: number;
  mobile?: boolean;
  active?: boolean;
}) {
  const [elapsedMs] = useState(() =>
    typeof performance === 'undefined' ? 0 : Math.round(performance.now())
  );
  const widths = BOOT_SHELL_SIDEBAR_WIDTH;
  const width =
    typeof sidebarWidth === 'number'
      ? sidebarWidth > 0 && Number.isFinite(sidebarWidth)
        ? Math.min(widths.max, Math.max(widths.min, sidebarWidth))
        : widths.default
      : undefined;
  return (
    <>
      <DocumentStyle name="lody-boot-shell" css={BOOT_SHELL_CSS} />
      <div
        className="lody-boot-shell"
        data-lody-boot-shell={active ? '' : undefined}
        data-active={active}
        data-layout={layout}
        data-mobile={mobile}
        data-sidebar={sidebar === undefined ? undefined : sidebar ? 'shown' : 'hidden'}
        aria-busy={active || undefined}
        aria-hidden={!active || undefined}
        inert={!active}
        style={
          {
            '--lody-boot-elapsed': `${elapsedMs}ms`,
            '--lody-boot-sidebar-width': width ? `${width}px` : undefined,
          } as CSSProperties
        }
      >
        <div className="lody-boot-shell__sidebar" />
        <div className="lody-boot-shell__main lody-workspace-card">
          <BootLoadingMark active={active} status={status} elapsedMs={elapsedMs} />
        </div>
      </div>
    </>
  );
}

/** The same loading mark and status continue inside an already-mounted pane. */
export function BootLoadingIndicator(props: {
  status?: ReactNode;
  active?: boolean;
  elapsedMs?: number;
}) {
  return (
    <>
      <DocumentStyle name="lody-boot-shell" css={BOOT_SHELL_CSS} />
      <BootLoadingMark {...props} />
    </>
  );
}

function BootLoadingMark({
  status,
  active = true,
  elapsedMs,
}: {
  status?: ReactNode;
  active?: boolean;
  elapsedMs?: number;
}) {
  const [createdAt] = useState(() =>
    typeof performance === 'undefined' ? 0 : Math.round(performance.now())
  );
  const style =
    elapsedMs === undefined
      ? ({ '--lody-boot-elapsed': `${createdAt}ms` } as CSSProperties)
      : undefined;
  return (
    <>
      <img
        className="lody-boot-shell__mark"
        src={BOOT_SHELL_MARK_DATA_URL}
        alt=""
        width={BOOT_SHELL_MARK_SIZE}
        height={BOOT_SHELL_MARK_SIZE}
        decoding="sync"
        style={style}
      />
      {active && status ? (
        <div className="lody-boot-shell__status" role="status" aria-live="polite" style={style}>
          {status}
        </div>
      ) : null}
    </>
  );
}
