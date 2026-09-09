import type { Meta, StoryObj } from '@storybook/react';
import { MarkdownRenderer } from '@/components/ai-gui/markdown-renderer';
import { TerminalComponent } from '@/components/ai-gui/terminal-component';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select';
import { Button } from '@lody/ui/button';
import { Input } from '@/ui/input';
import { DiffViewer } from '@/ui/diff-viewer/diff-viewer';
import { File as FileViewer, type FileProps } from '@pierre/diffs/react';
import {
  useActiveVSCodeThemeId,
  useActiveVSCodeDiffThemeName,
  useResolvedTheme,
  useTheme,
} from '@/theme-provider';

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

const fileViewerFile: FileProps<undefined>['file'] = {
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

function VSCodeThemeProbe() {
  const { theme, setTheme } = useTheme();
  const resolvedTheme = useResolvedTheme();
  const activeDiffThemeName = useActiveVSCodeDiffThemeName();
  const activeVSCodeThemeId = useActiveVSCodeThemeId();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card px-6 py-4">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-base font-semibold">VSCode theme probe</h1>
            <p className="text-xs text-muted-foreground">
              Active mode: {resolvedTheme}; active theme: {activeVSCodeThemeId ?? 'Lody default'}
            </p>
          </div>
          <div>
            <Select value={theme} onValueChange={(value) => setTheme(value as typeof theme)}>
              <SelectTrigger className="w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="light">Light shell</SelectItem>
                <SelectItem value="dark">Dark shell</SelectItem>
                <SelectItem value="system">System shell</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-4 p-6 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="space-y-3 border border-border bg-card p-3 text-sm">
          <div className="rounded-md bg-muted px-3 py-2 font-medium">Sidebar surface</div>
          <div className="px-3 py-2 text-muted-foreground">Explorer</div>
          <div className="px-3 py-2 text-muted-foreground">Source Control</div>
          <div className="px-3 py-2 text-primary">Theme workstream</div>
        </aside>

        <div className="space-y-4">
          <section className="space-y-3 border border-border bg-background p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button>Primary action</Button>
              <Button variant="secondary">Outline action</Button>
              <Button variant="secondary">Secondary action</Button>
            </div>
            <Input placeholder="Focus border / input background" />
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="rounded-md bg-code-added px-2 py-1 text-foreground">added</span>
              <span className="rounded-md bg-code-removed px-2 py-1 text-foreground">removed</span>
              <span className="rounded-md bg-muted px-2 py-1 text-muted-foreground">muted</span>
            </div>
          </section>

          <section className="border border-border bg-card p-4">
            <MarkdownRenderer text={markdownSample} size="sm" />
          </section>

          <TerminalComponent
            title="Theme ANSI probe"
            command="printf ANSI && printf truecolor"
            output={terminalOutput}
            tailLines={20}
          />

          <section className="border border-border bg-card p-4">
            <div className="mb-3 text-xs font-medium uppercase text-muted-foreground">
              Full-file viewer path
            </div>
            <FileViewer
              file={fileViewerFile}
              options={{ disableFileHeader: true, theme: activeDiffThemeName }}
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
