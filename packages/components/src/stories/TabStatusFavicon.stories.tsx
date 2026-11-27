import type { Meta, StoryObj } from '@storybook/react';
import { useEffect } from 'react';
import { useTheme } from '@/theme-provider';
import faviconIdleRaw from './assets/favicon.svg?raw';
import faviconUnreadRaw from './assets/favicon-unread.svg?raw';

type WebTabStatus = 'idle' | 'unread';

const VARIANTS: { status: WebTabStatus; svg: string; label: string; description: string }[] = [
  {
    status: 'idle',
    svg: faviconIdleRaw,
    label: 'Idle',
    description: 'Default lody mark. Used for working / waiting too — silent on the favicon.',
  },
  {
    status: 'unread',
    svg: faviconUnreadRaw,
    label: 'Unread',
    description: 'New assistant message you haven’t read yet — the only loud state on web.',
  },
];

const TAB_TITLES: Record<WebTabStatus, string> = {
  idle: 'Refactor billing webhook',
  unread: 'Investigate flaky e2e test',
};

const SIZES = [16, 24, 48] as const;

const meta: Meta = {
  title: 'Hooks/useTabStatus (Favicon)',
  parameters: {
    layout: 'fullscreen',
  },
};

export default meta;
type Story = StoryObj;

function ThemedShowcase({ mode }: { mode: 'light' | 'dark' }) {
  const { setTheme } = useTheme();
  useEffect(() => {
    setTheme(mode);
  }, [mode, setTheme]);

  const isDark = mode === 'dark';
  const bg = isDark ? '#09090b' : '#f5f7fb';
  const surface = isDark ? '#18181b' : '#ffffff';
  const border = isDark ? '#27272a' : '#e4e4e7';
  const text = isDark ? '#fafafa' : '#18181b';
  const muted = isDark ? '#a1a1aa' : '#71717a';

  return (
    <div
      style={{
        background: bg,
        color: text,
        minHeight: '100vh',
        padding: '40px 32px',
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
      }}
    >
      <div style={{ maxWidth: 960, margin: '0 auto' }}>
        <header style={{ marginBottom: 32 }}>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>Tab status favicon</h1>
          <p style={{ fontSize: 13, color: muted, marginTop: 6, marginBottom: 0 }}>
            <code style={{ fontSize: 12 }}>useTabStatus(status)</code> swaps the document favicon so
            users can spot unread sessions from the browser tab strip. Web only distinguishes{' '}
            <strong>idle</strong> vs <strong>unread</strong>; <code>working</code> and{' '}
            <code>waiting</code> are silent here and surface on the Electron dock badge instead.
          </p>
        </header>

        <section style={{ marginBottom: 40 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: muted, margin: '0 0 12px' }}>
            Browser tab preview
          </h2>
          <div
            style={{
              display: 'flex',
              gap: 4,
              padding: '8px 8px 0',
              background: isDark ? '#0b0b0f' : '#e9ecf2',
              borderRadius: '12px 12px 0 0',
              borderBottom: `1px solid ${border}`,
            }}
          >
            {VARIANTS.map((v) => (
              <BrowserTab
                key={v.status}
                svg={v.svg}
                title={TAB_TITLES[v.status]}
                active={v.status === 'unread'}
                surface={surface}
                border={border}
                text={text}
                muted={muted}
                isDark={isDark}
                mode={mode}
              />
            ))}
          </div>
          <div
            style={{
              background: surface,
              border: `1px solid ${border}`,
              borderTop: 'none',
              borderRadius: '0 0 12px 12px',
              padding: '24px 16px',
              fontSize: 12,
              color: muted,
            }}
          >
            Active tab: <strong style={{ color: text }}>{TAB_TITLES.unread}</strong>
          </div>
        </section>

        <section style={{ marginBottom: 40 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: muted, margin: '0 0 12px' }}>
            All variants
          </h2>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 12,
            }}
          >
            {VARIANTS.map((v) => (
              <article
                key={v.status}
                style={{
                  background: surface,
                  border: `1px solid ${border}`,
                  borderRadius: 12,
                  padding: 16,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <FaviconImg svg={v.svg} size={32} mode={mode} />
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{v.label}</span>
                    <code style={{ fontSize: 11, color: muted }}>status="{v.status}"</code>
                  </div>
                </div>
                <p style={{ fontSize: 12, color: muted, margin: 0, lineHeight: 1.5 }}>
                  {v.description}
                </p>
              </article>
            ))}
          </div>
        </section>

        <section>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: muted, margin: '0 0 12px' }}>
            Crispness across favicon sizes
          </h2>
          <div
            style={{
              background: surface,
              border: `1px solid ${border}`,
              borderRadius: 12,
              padding: 20,
              overflow: 'auto',
            }}
          >
            <table
              style={{
                borderCollapse: 'collapse',
                width: '100%',
                fontSize: 12,
              }}
            >
              <thead>
                <tr style={{ color: muted, textAlign: 'left' }}>
                  <th style={{ padding: '6px 8px', fontWeight: 500 }}>Status</th>
                  {SIZES.map((s) => (
                    <th
                      key={s}
                      style={{ padding: '6px 8px', fontWeight: 500 }}
                    >{`${s}\u00d7${s}`}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {VARIANTS.map((v) => (
                  <tr key={v.status} style={{ borderTop: `1px solid ${border}` }}>
                    <td style={{ padding: '12px 8px', fontWeight: 500 }}>{v.label}</td>
                    {SIZES.map((s) => (
                      <td key={s} style={{ padding: '12px 8px' }}>
                        <FaviconImg svg={v.svg} size={s} mode={mode} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}

function BrowserTab({
  svg,
  title,
  active,
  surface,
  border,
  text,
  muted,
  isDark,
  mode,
}: {
  svg: string;
  title: string;
  active: boolean;
  surface: string;
  border: string;
  text: string;
  muted: string;
  isDark: boolean;
  mode: 'light' | 'dark';
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 14px 9px',
        background: active ? surface : isDark ? '#1a1a1f' : '#f4f5f9',
        border: active ? `1px solid ${border}` : '1px solid transparent',
        borderBottom: active ? `1px solid ${surface}` : `1px solid ${border}`,
        borderTopLeftRadius: 8,
        borderTopRightRadius: 8,
        marginBottom: -1,
        minWidth: 180,
        maxWidth: 220,
        position: 'relative',
        zIndex: active ? 2 : 1,
      }}
    >
      <FaviconImg svg={svg} size={16} mode={mode} />
      <span
        style={{
          fontSize: 12,
          color: active ? text : muted,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          flex: 1,
        }}
      >
        {title}
      </span>
    </div>
  );
}

function recolorSvg(svg: string, mode: 'light' | 'dark'): string {
  // The on-disk favicons use a `prefers-color-scheme: dark` media query to
  // swap body/halo fills. Storybook's theme toggle doesn't propagate to the
  // OS color-scheme, so for previewing dark mode we have to flip the fills
  // ourselves; otherwise the navy lody mark disappears against the dark bg.
  if (mode === 'light') return svg;
  return svg
    .replace('.lody { fill: #0F1A26; }', '.lody { fill: #FFFFFF; }')
    .replace('.halo { fill: #f5f7fb; }', '.halo { fill: #09090b; }');
}

function FaviconImg({ svg, size, mode }: { svg: string; size: number; mode: 'light' | 'dark' }) {
  const sized = svg.replace(/width="\d+"\s+height="\d+"/, `width="${size}" height="${size}"`);
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-flex',
        width: size,
        height: size,
        flexShrink: 0,
      }}
      dangerouslySetInnerHTML={{ __html: recolorSvg(sized, mode) }}
    />
  );
}

export const Light: Story = {
  render: () => <ThemedShowcase mode="light" />,
  globals: { theme: 'light' },
};

export const Dark: Story = {
  render: () => <ThemedShowcase mode="dark" />,
  globals: { theme: 'dark' },
};
