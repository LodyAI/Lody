import * as stylex from '@stylexjs/stylex';
import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { clsx } from 'clsx';
import {
  WindowDragStrip,
  WINDOW_DRAG_REGION_HEIGHT_CLASS,
  WINDOW_DRAG_EXEMPT_CLASS,
  useWindowDragRegionClass,
  useWindowsCaptionPadClass,
  useWindowsCaptionRowPadClass,
  useMacTrafficLightRowPadClass,
} from '@/ui/window-drag-region';

const storyOverrides = stylex.create({
  strip: {
    zIndex: 30,
    height: 'calc(var(--spacing) * 8)',
    insetInline: 'calc(var(--spacing) * 4)',
  },
  bottom: { top: '820px' },
});

function Rows({ toggle }: { toggle: () => void }) {
  const header = useWindowDragRegionClass();
  const right = useWindowsCaptionPadClass();
  const windows = useWindowsCaptionRowPadClass();
  const windowsBorder = useWindowsCaptionRowPadClass({ bottomBorder: true });
  const mac = useMacTrafficLightRowPadClass();
  const macBorder = useMacTrafficLightRowPadClass({ bottomBorder: true });
  const frame = useMacTrafficLightRowPadClass({ insideWorkspaceFrame: true });
  const frameBorder = useMacTrafficLightRowPadClass({
    insideWorkspaceFrame: true,
    bottomBorder: true,
  });
  const [clicks, setClicks] = useState(0);
  return (
    <main
      data-window-fixture="ready"
      style={
        {
          '--window-caption-inset-right': '120px',
          display: 'grid',
          gap: 16,
          padding: 16,
        } as React.CSSProperties
      }
    >
      <p>Synthetic Electron IPC data; browser geometry only.</p>
      <div
        data-drag-header
        className={clsx(header, WINDOW_DRAG_REGION_HEIGHT_CLASS, right, windows, mac)}
        style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid currentColor' }}
      >
        Header{' '}
        <button
          data-exempt
          className={WINDOW_DRAG_EXEMPT_CLASS}
          onClick={() => setClicks((x) => x + 1)}
        >
          No-drag action
        </button>
        <output data-clicks>{clicks}</output>
      </div>
      {[windowsBorder, macBorder, frame, frameBorder].map((value, i) => (
        <div
          key={i}
          data-pad-row={i}
          className={clsx(WINDOW_DRAG_REGION_HEIGHT_CLASS, value)}
          style={{
            display: 'flex',
            alignItems: 'center',
            borderBottom: i % 2 ? undefined : '1px solid currentColor',
          }}
        >
          Alignment row {i}
        </div>
      ))}
      <section
        data-strip-host
        style={{ position: 'relative', height: 70, background: 'hsl(var(--muted))' }}
      >
        <WindowDragStrip />
        <span>Absolute strip</span>
      </section>
      <section
        data-caller-host
        style={{ position: 'relative', height: 70, background: 'hsl(var(--muted))' }}
      >
        <WindowDragStrip xstyle={storyOverrides.strip} />
        <span>Public caller classes</span>
      </section>
      <WindowDragStrip position="fixed" xstyle={storyOverrides.bottom} />
      <button data-fullscreen className={WINDOW_DRAG_EXEMPT_CLASS} onClick={toggle}>
        Toggle synthetic fullscreen push
      </button>
    </main>
  );
}
function Harness({ os }: { os: 'win32' | 'darwin' | 'web' }) {
  const [ready, setReady] = useState(false);
  const [toggle, setToggle] = useState<() => void>(() => () => {});
  useEffect(() => {
    const electron = window.__LODY_ELECTRON__,
      platform = window.__LODY_PLATFORM__,
      ipc = window.ipc;
    const listeners = new Set<(value: unknown) => void>();
    let fullscreen = false;
    window.__LODY_ELECTRON__ = os !== 'web' ? true : undefined;
    window.__LODY_PLATFORM__ = {
      os: os === 'web' ? 'linux' : os,
      homeDir: '/synthetic/window-fixture',
    };
    window.ipc = {
      invoke: async (channel) => {
        if (channel === 'app.getFullscreen') return fullscreen;
        if (channel === 'app.setNativeTheme' || channel === 'app.setStartupThemeSource')
          return undefined;
        throw new Error(`Unexpected synthetic window IPC: ${channel}`);
      },
      on: (channel, listener) => {
        if (channel === 'app.fullscreen') listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      send: (channel) => {
        throw new Error(`Unexpected synthetic window send: ${channel}`);
      },
    };
    setToggle(() => () => {
      fullscreen = !fullscreen;
      for (const listener of listeners) listener(fullscreen);
    });
    setReady(true);
    return () => {
      listeners.clear();
      window.__LODY_ELECTRON__ = electron;
      window.__LODY_PLATFORM__ = platform;
      window.ipc = ipc;
    };
  }, [os]);
  return ready ? <Rows toggle={toggle} /> : null;
}
const meta = {
  title: 'UI/WindowDragRegionMigration',
  component: Harness,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Harness>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Windows: Story = { args: { os: 'win32' } };
export const Mac: Story = { args: { os: 'darwin' } };
export const Browser: Story = { args: { os: 'web' } };
