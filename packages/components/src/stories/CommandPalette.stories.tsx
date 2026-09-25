import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';

import { COMMAND_ICONS } from '@/components/commands/command-icons';
import {
  CommandPaletteView,
  type CommandPaletteLabels,
  type CommandPaletteViewProps,
  type PaletteResult,
} from '@/components/commands/command-palette-view';

const LABELS: CommandPaletteLabels = {
  placeholder: 'Search commands and chats...',
  empty: 'No results found.',
  navigate: 'Navigate',
  select: 'Select',
  close: 'Close',
};

const noop = () => {};

const COMMAND_FIXTURES: PaletteResult[] = [
  { kind: 'command', key: 'c1', title: 'New Chat', subtitle: null, shortcut: 'Mod+n', run: noop },
  {
    kind: 'command',
    key: 'c2',
    title: 'Toggle Sidebar',
    subtitle: null,
    shortcut: 'Mod+b',
    run: noop,
  },
  {
    kind: 'command',
    key: 'c3',
    title: 'Open Command Palette',
    subtitle: null,
    shortcut: 'Mod+k',
    run: noop,
  },
  {
    kind: 'command',
    key: 'c4',
    title: 'Switch to Next Tab',
    subtitle: null,
    shortcut: 'Mod+ArrowRight',
    run: noop,
  },
  {
    kind: 'command',
    key: 'c5',
    title: 'Copy Current Branch',
    subtitle: null,
    shortcut: 'Alt+Shift+b',
    run: noop,
  },
];

/* What the container hands over with no query: each command's glyph, grouped under its category. */
const COMMAND_META: Record<string, [string, string]> = {
  c1: ['session.new', 'Session'],
  c2: ['sidebar.toggle', 'View'],
  c3: ['palette.toggle', 'Navigation'],
  c4: ['session.nextTab', 'Session'],
  c5: ['session.copyCurrentBranch', 'Session'],
  c6: ['session.toggleCurrentPinned', 'Session'],
  c7: ['layout.toggleZenMode', 'View'],
  c8: ['workspace.openSettings', 'Workspace'],
  c9: ['app.cycleTheme', 'View'],
};
const GROUP_ORDER = ['Navigation', 'Session', 'View', 'Workspace'];

const COMMAND_RESULTS: PaletteResult[] = (
  [
    ...COMMAND_FIXTURES,
    {
      kind: 'command',
      key: 'c6',
      title: 'Pin Current Session',
      subtitle: null,
      shortcut: 'Mod+Shift+p',
      run: noop,
    },
    {
      kind: 'command',
      key: 'c7',
      title: 'Toggle Zen Mode',
      subtitle: null,
      shortcut: 'Mod+.',
      run: noop,
    },
    {
      kind: 'command',
      key: 'c8',
      title: 'Open Settings',
      subtitle: null,
      shortcut: 'Mod+,',
      run: noop,
    },
    { kind: 'command', key: 'c9', title: 'Cycle Theme', subtitle: null, shortcut: null, run: noop },
  ] satisfies PaletteResult[]
)
  .map((result): PaletteResult => {
    const [id, group] = COMMAND_META[result.key] ?? [];
    return { ...result, icon: id ? COMMAND_ICONS[id] : undefined, group };
  })
  .sort((a, b) => GROUP_ORDER.indexOf(a.group ?? '') - GROUP_ORDER.indexOf(b.group ?? ''));

const MIXED_RESULTS: PaletteResult[] = [
  {
    kind: 'command',
    key: 'c1',
    title: 'New Chat',
    subtitle: null,
    shortcut: 'Mod+n',
    icon: COMMAND_ICONS['session.new'],
    run: noop,
  },
  {
    kind: 'session',
    key: 's1',
    title: 'Fix cross-platform hotkey library',
    subtitle: 'loro-dev/lody',
    shortcut: null,
    trailing: '5m',
    run: noop,
  },
  {
    kind: 'session',
    key: 's2',
    title: 'Command palette redesign',
    subtitle: 'loro-dev/lody',
    shortcut: null,
    trailing: '2h',
    run: noop,
  },
  {
    kind: 'session',
    key: 's3',
    title: 'Untitled session',
    subtitle: 'my-local-project · main',
    shortcut: null,
    trailing: '3d',
    run: noop,
  },
];

function Harness(props: CommandPaletteViewProps) {
  const [query, setQuery] = useState(props.query);
  return <CommandPaletteView {...props} query={query} onQueryChange={setQuery} />;
}

const meta = {
  title: 'Components/CommandPalette',
  component: CommandPaletteView,
  parameters: { layout: 'fullscreen' },
  render: (args) => <Harness {...args} />,
} satisfies Meta<typeof CommandPaletteView>;

export default meta;
type Story = StoryObj<typeof meta>;

const baseArgs = {
  open: true as const,
  onOpenChange: noop,
  onQueryChange: noop,
  labels: LABELS,
};

/** Default view: no query, commands grouped under their category. */
export const Commands: Story = {
  args: { ...baseArgs, query: '', results: COMMAND_RESULTS },
};

/** Searching: commands + chats interleaved by relevance, with type badges. */
export const WithConversations: Story = {
  args: { ...baseArgs, query: 'co', results: MIXED_RESULTS },
};

/** No matches. */
export const Empty: Story = {
  args: { ...baseArgs, query: 'zzzzz', results: [] },
};
