import * as stylex from '@stylexjs/stylex';
import { canUseWASM } from '@pierre/diffs';
import type { Meta, StoryObj } from '@storybook/react';
import { MarkdownRenderer } from '@/components/ai-gui/markdown-renderer';
import { TerminalComponent } from '@/components/ai-gui/terminal-component';
import { Select } from '@lody/ui/select';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { DiffViewer } from '@/ui/diff-viewer/diff-viewer';
import { File as FileViewer, type FileProps } from '@pierre/diffs/react';
import {
  useActiveVSCodeThemeId,
  useActiveVSCodeDiffThemeName,
  useResolvedTheme,
  useTheme,
} from '@/theme-provider';
const probeFrameStyles = stylex.create({
  grid: {
    marginInline: 'auto',
    display: 'grid',
    maxWidth: '72rem',
    gap: 'calc(var(--spacing) * 4)',
    padding: 'calc(var(--spacing) * 6)',
    gridTemplateColumns: { default: null, '@media (width >= 64rem)': '240px minmax(0,1fr)' },
  },
  sidebar: {
    borderStyle: 'solid',
    borderWidth: '1px',
    borderColor: 'hsl(var(--border) / 1)',
    backgroundColor: 'hsl(var(--card) / 1)',
    padding: 'calc(var(--spacing) * 3)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
  },
  controls: {
    borderStyle: 'solid',
    borderWidth: '1px',
    borderColor: 'hsl(var(--border) / 1)',
    backgroundColor: 'hsl(var(--background) / 1)',
    padding: 'calc(var(--spacing) * 4)',
  },
  paragraphSpace: {
    marginBlockStart: 'calc(var(--spacing) * 0)',
    marginBlockEnd: 'calc(var(--spacing) * 3)',
  },
  sectionSpace: {
    marginBlockStart: 'calc(var(--spacing) * 0)',
    marginBlockEnd: 'calc(var(--spacing) * 4)',
  },
});
const storyLayoutStyles = stylex.create({
  canvas: {
    borderBottomStyle: 'solid',
    borderBottomWidth: '1px',
    borderColor: 'hsl(var(--border) / 1)',
    backgroundColor: 'hsl(var(--card) / 1)',
    paddingInline: 'calc(var(--spacing) * 6)',
    paddingBlock: 'calc(var(--spacing) * 4)',
  },
  caption: {
    fontSize: 'var(--text-base)',
    lineHeight: 'var(--text-base--line-height)',
    fontWeight: 'var(--font-weight-semibold)',
  },
  caption2: {
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  canvas2: {
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'hsl(var(--muted) / 1)',
    paddingInline: 'calc(var(--spacing) * 3)',
    paddingBlock: 'calc(var(--spacing) * 2)',
    fontWeight: 'var(--font-weight-medium)',
  },
  row: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 'calc(var(--spacing) * 2)',
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
  },
  canvas3: {
    borderStyle: 'solid',
    borderWidth: '1px',
    borderColor: 'hsl(var(--border) / 1)',
    backgroundColor: 'hsl(var(--card) / 1)',
    padding: 'calc(var(--spacing) * 4)',
  },
  caption3: {
    marginBottom: 'calc(var(--spacing) * 3)',
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
    fontWeight: 'var(--font-weight-medium)',
    color: 'hsl(var(--muted-foreground) / 1)',
    textTransform: 'uppercase',
  },
});

const storyOverrides = stylex.create({ select: { width: '150px' } });

const storyLayout = stylex.create({
  frame: {
    'min-height': '100vh',
    'background-color': 'hsl(var(--background) / 1)',
    color: 'hsl(var(--foreground) / 1)',
  },
  row: {
    'margin-inline': 'auto',
    display: 'flex',
    'max-width': '72rem',
    'flex-wrap': 'wrap',
    'align-items': 'center',
    'justify-content': 'space-between',
    gap: 'calc(var(--spacing) * 3)',
  },
  canvas: {
    'padding-inline': 'calc(var(--spacing) * 3)',
    'padding-block': 'calc(var(--spacing) * 2)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  canvas2: {
    'padding-inline': 'calc(var(--spacing) * 3)',
    'padding-block': 'calc(var(--spacing) * 2)',
    color: 'hsl(var(--primary))',
  },
  row2: {
    display: 'flex',
    'flex-wrap': 'wrap',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
  },
  canvas3: {
    'border-radius': 'var(--radius-md)',
    'background-color': 'hsl(var(--code-added) / 1)',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'padding-block': 'calc(var(--spacing) * 1)',
    color: 'hsl(var(--foreground) / 1)',
  },
  canvas4: {
    'border-radius': 'var(--radius-md)',
    'background-color': 'hsl(var(--code-removed) / 1)',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'padding-block': 'calc(var(--spacing) * 1)',
    color: 'hsl(var(--foreground) / 1)',
  },
  canvas5: {
    'border-radius': 'var(--radius-md)',
    'background-color': 'hsl(var(--muted) / 1)',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'padding-block': 'calc(var(--spacing) * 1)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
});

const meta = {
  title: 'Theme/VSCodeThemeProbe',
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const markdownSample = [
  'Markdown code path:',
  '```ts',
  'const greet = (name: string) => {',
  '  return `Hello, ${name}`;',
  '};',
  '```',
].join('\n');

const terminalOutput = [
  '\u001b[30mansiBlack\u001b[0m \u001b[90mansiBrightBlack\u001b[0m',
  '\u001b[31mansiRed\u001b[0m \u001b[91mansiBrightRed\u001b[0m',
  '\u001b[32mansiGreen\u001b[0m \u001b[92mansiBrightGreen\u001b[0m',
  '\u001b[33mansiYellow\u001b[0m \u001b[93mansiBrightYellow\u001b[0m',
  '\u001b[34mansiBlue\u001b[0m \u001b[94mansiBrightBlue\u001b[0m',
  '\u001b[35mansiMagenta\u001b[0m \u001b[95mansiBrightMagenta\u001b[0m',
  '\u001b[36mansiCyan\u001b[0m \u001b[96mansiBrightCyan\u001b[0m',
  '\u001b[37mansiWhite\u001b[0m \u001b[97mansiBrightWhite\u001b[0m',
  '\u001b[38;2;255;128;0mtruecolor orange stays raw\u001b[0m',
].join('\n');

const oldDiffText = [
  'export const status = {',
  "  label: 'Draft',",
  "  highlight: 'muted',",
  '};',
].join('\n');

const newDiffText = [
  'export const status = {',
  "  label: 'Ready',",
  "  highlight: 'primary',",
  "  reviewedAt: '2026-04-09',",
  '};',
].join('\n');

const fileViewerFile: FileProps<undefined, undefined>['file'] = {
  name: 'theme-probe.ts',
  lang: 'ts' as never,
  contents: [
    'export function resolveTone(status: "ok" | "error") {',
    '  if (status === "error") {',
    '    return { label: "Needs attention", tone: "danger" };',
    '  }',
    '  return { label: "Ready", tone: "success" };',
    '}',
  ].join('\n'),
};

const SHELL_THEMES = [
  { value: 'light', label: 'Light shell' },
  { value: 'dark', label: 'Dark shell' },
  { value: 'system', label: 'System shell' },
];

function VSCodeThemeProbe() {
  const { theme, setTheme } = useTheme();
  const resolvedTheme = useResolvedTheme();
  const activeDiffThemeName = useActiveVSCodeDiffThemeName();
  const activeVSCodeThemeId = useActiveVSCodeThemeId();

  return (
    <div {...stylex.props(storyLayout.frame)}>
      <header {...stylex.props(storyLayoutStyles.canvas)}>
        <div {...stylex.props(storyLayout.row)}>
          <div>
            <h1 {...stylex.props(storyLayoutStyles.caption)}>VSCode theme probe</h1>
            <p {...stylex.props(storyLayoutStyles.caption2)}>
              Active mode: {resolvedTheme}; active theme: {activeVSCodeThemeId ?? 'Lody default'}
            </p>
          </div>
          <div>
            <Select.Root
              items={SHELL_THEMES}
              value={theme}
              onValueChange={(value) => setTheme(value as typeof theme)}
            >
              <Select.Trigger xstyle={storyOverrides.select}>
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                {SHELL_THEMES.map((option) => (
                  <Select.Item key={option.value} value={option.value}>
                    {option.label}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </div>
        </div>
      </header>

      <main {...stylex.props(probeFrameStyles.grid)}>
        <aside {...stylex.props(probeFrameStyles.sidebar)}>
          <div {...stylex.props(storyLayoutStyles.canvas2, probeFrameStyles.paragraphSpace)}>
            Sidebar surface
          </div>
          <div {...stylex.props(storyLayout.canvas, probeFrameStyles.paragraphSpace)}>Explorer</div>
          <div {...stylex.props(storyLayout.canvas, probeFrameStyles.paragraphSpace)}>
            Source Control
          </div>
          <div {...stylex.props(storyLayout.canvas2)}>Theme workstream</div>
        </aside>

        <div>
          <section {...stylex.props(probeFrameStyles.controls, probeFrameStyles.sectionSpace)}>
            <div {...stylex.props(storyLayout.row2, probeFrameStyles.paragraphSpace)}>
              <Button>Primary action</Button>
              <Button variant="secondary">Outline action</Button>
              <Button variant="secondary">Secondary action</Button>
            </div>
            <Input
              xstyle={probeFrameStyles.paragraphSpace}
              placeholder="Focus border / input background"
            />
            <div {...stylex.props(storyLayoutStyles.row)}>
              <span {...stylex.props(storyLayout.canvas3)}>added</span>
              <span {...stylex.props(storyLayout.canvas4)}>removed</span>
              <span {...stylex.props(storyLayout.canvas5)}>muted</span>
            </div>
          </section>

          <section {...stylex.props(storyLayoutStyles.canvas3, probeFrameStyles.sectionSpace)}>
            <MarkdownRenderer text={markdownSample} size="sm" />
          </section>

          <TerminalComponent
            xstyle={probeFrameStyles.sectionSpace}
            title="Theme ANSI probe"
            command="printf ANSI && printf truecolor"
            output={terminalOutput}
            tailLines={20}
          />

          <section {...stylex.props(storyLayoutStyles.canvas3, probeFrameStyles.sectionSpace)}>
            <div {...stylex.props(storyLayoutStyles.caption3)}>Full-file viewer path</div>
            <FileViewer
              file={fileViewerFile}
              options={{
                disableFileHeader: true,
                preferredHighlighter: canUseWASM() ? 'highlights' : 'shiki-js',
                theme: activeDiffThemeName,
              }}
            />
          </section>

          <DiffViewer
            path="packages/components/src/theme-probe.ts"
            oldText={oldDiffText}
            newText={newDiffText}
            showHeader
          />
        </div>
      </main>
    </div>
  );
}

export const Probe: Story = {
  render: () => <VSCodeThemeProbe />,
};

export const LightBaseline: Story = {
  globals: {
    theme: 'light',
  },
  render: () => <VSCodeThemeProbe />,
};

export const DarkBaseline: Story = {
  globals: {
    theme: 'dark',
  },
  render: () => <VSCodeThemeProbe />,
};
