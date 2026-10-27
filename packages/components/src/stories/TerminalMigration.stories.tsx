import type { Meta, StoryObj } from '@storybook/react';
import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import * as stylex from '@stylexjs/stylex';
import { TERMINAL_MAX_PER_SESSION } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { TerminalDock } from '@/components/terminal/terminal-dock';
import { terminalControllerAtom } from '@/components/terminal/terminal-controller';
import type {
  TerminalChannel,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalSnapshot,
  TerminalTitleEvent,
} from '@/components/terminal/terminal-channel';
import { themeColors } from '../style/theme-colors.stylex';
import { themeSpace } from '../style/theme-scale.stylex';

type Mode = 'rows' | 'limit' | 'load-error' | 'open-error' | 'loading' | 'unavailable';

const styles = stylex.create({
  canvas: {
    display: 'flex',
    height: '100vh',
    minHeight: 0,
    flexDirection: 'column',
    backgroundColor: themeColors.background,
    color: themeColors.foreground,
  },
  controls: { display: 'flex', flexWrap: 'wrap', gap: themeSpace[2], padding: themeSpace[3] },
  content: { minHeight: 0, flex: '1 1 0%', overflow: 'hidden', padding: themeSpace[3] },
});

/** Synthetic transport only; the dock and xterm renderer are production components. */
class FixtureChannel implements TerminalChannel {
  private sequence = 0;
  private readonly terminals = new Map<string, TerminalSnapshot>();
  private readonly data = new Set<(event: TerminalDataEvent) => void>();
  private readonly exits = new Set<(event: TerminalExitEvent) => void>();
  private readonly titles = new Set<(event: TerminalTitleEvent) => void>();
  private finishList: ((terminals: TerminalSnapshot[]) => void) | undefined;
  private readonly pendingList = new Promise<TerminalSnapshot[]>((resolve) => {
    this.finishList = resolve;
  });

  constructor(private readonly mode: Mode) {
    const count = mode === 'limit' ? TERMINAL_MAX_PER_SESSION : 4;
    const names = [
      'shell',
      'pnpm --filter @lody/components test --watch very-long-terminal-title',
      '终端 — build output',
      '',
    ];
    for (let index = 0; index < count; index += 1) {
      const terminalId = `migration-${mode}-${++this.sequence}`;
      this.terminals.set(terminalId, { terminalId, title: names[index] ?? `shell ${index + 1}` });
    }
  }

  list(): Promise<TerminalSnapshot[]> {
    if (this.mode === 'loading') return this.pendingList;
    if (this.mode === 'load-error') return Promise.reject(new Error('daemon_unavailable'));
    return Promise.resolve([...this.terminals.values()]);
  }

  open(): Promise<{ terminalId: string }> {
    if (this.mode === 'open-error') return Promise.reject(new Error('workdir_unavailable'));
    const terminalId = `migration-${this.mode}-${++this.sequence}`;
    this.terminals.set(terminalId, { terminalId, title: 'shell' });
    return Promise.resolve({ terminalId });
  }

  attach(terminalId: string): void {
    queueMicrotask(() => {
      for (const handler of this.data) {
        handler({
          type: 'data',
          terminalId,
          data: '\x1b[32mSynthetic local shell\x1b[0m\r\nMigration fixture: production xterm renderer\r\n$ ',
        });
      }
    });
  }

  input(terminalId: string, data: string): void {
    for (const handler of this.data) handler({ type: 'data', terminalId, data });
  }

  resize(): void {}
  readClipboardText(): string {
    return '';
  }
  writeClipboardText(): void {}

  close(terminalId: string): void {
    if (!this.terminals.delete(terminalId)) return;
    for (const handler of this.exits) handler({ type: 'exit', terminalId, exitCode: 0 });
  }

  closeSession(): void {
    for (const terminalId of [...this.terminals.keys()]) this.close(terminalId);
  }

  resolveEmptyList(): void {
    this.finishList?.([]);
  }

  onData(handler: (event: TerminalDataEvent) => void) {
    this.data.add(handler);
    return () => this.data.delete(handler);
  }
  onExit(handler: (event: TerminalExitEvent) => void) {
    this.exits.add(handler);
    return () => this.exits.delete(handler);
  }
  onTitle(handler: (event: TerminalTitleEvent) => void) {
    this.titles.add(handler);
    return () => this.titles.delete(handler);
  }
}

function Fixture({ mode }: { mode: Mode }) {
  const channel = useMemo(() => new FixtureChannel(mode), [mode]);
  const controller = useAtomValue(terminalControllerAtom);
  return (
    <div {...stylex.props(styles.canvas)}>
      <div {...stylex.props(styles.controls)}>
        <Button onClick={() => controller?.toggleOpen()}>Toggle terminal dock</Button>
        <Button onClick={() => controller?.openNewTerminal()}>Create terminal</Button>
        {mode === 'loading' ? (
          <Button onClick={() => channel.resolveEmptyList()}>Resolve empty terminal list</Button>
        ) : null}
      </div>
      <main {...stylex.props(styles.content)}>Terminal dock migration: {mode}</main>
      <TerminalDock
        channel={channel}
        sessionId={`terminal-migration-${mode}`}
        defaultView="terminal"
        canCreateTerminal={mode !== 'unavailable'}
      />
    </div>
  );
}

const meta = { title: 'Terminal/Migration', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const RowStates: Story = { render: () => <Fixture mode="rows" /> };
export const LimitReached: Story = { render: () => <Fixture mode="limit" /> };
export const LoadError: Story = { render: () => <Fixture mode="load-error" /> };
export const OpenError: Story = { render: () => <Fixture mode="open-error" /> };
export const Loading: Story = { render: () => <Fixture mode="loading" /> };
export const CreateDisabled: Story = { render: () => <Fixture mode="unavailable" /> };
