import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { CloudOff, Folder, Plus, Settings } from 'lucide-react';
import { Button } from '@lody/ui/button';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/ui/command';
import { Dialog } from '@/ui/dialog';
import { SessionFileQuickOpen } from '@/components/sessions/session-file-quick-open';
import { themeColors } from '../style/theme-colors.stylex';
import { themeSpace, themeFontSize, themeLineHeight } from '../style/theme-scale.stylex';

const styles = stylex.create({
  canvas: {
    minHeight: '100dvh',
    padding: themeSpace[4],
    backgroundColor: themeColors.background,
    color: themeColors.foreground,
  },
  frame: { width: 'min(480px, 100%)', height: 360 },
  result: {
    display: 'block',
    marginTop: themeSpace[3],
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
  },
  svgCaller: { width: 24, height: 24 },
});

function Items({ onSelect }: { onSelect: (value: string) => void }) {
  return (
    <>
      <CommandGroup heading="Navigation">
        <CommandItem value="new-session" onSelect={onSelect}>
          <Plus />
          New session<CommandShortcut>⌘N</CommandShortcut>
        </CommandItem>
        <CommandItem value="open-workspace" keywords={['project']} onSelect={onSelect}>
          <Folder className="h-6 w-6" />
          Open workspace<CommandShortcut>⌘O</CommandShortcut>
        </CommandItem>
        <CommandItem value="sync-unavailable" disabled onSelect={onSelect}>
          <CloudOff size={20} />
          Sync unavailable
        </CommandItem>
      </CommandGroup>
      <CommandSeparator />
      <CommandGroup heading="Preferences">
        <CommandItem value="settings" onSelect={onSelect}>
          <Settings {...stylex.props(styles.svgCaller)} />
          Settings
        </CommandItem>
        <CommandItem value="small-icon" onSelect={onSelect}>
          <Plus className="size-3" />
          Small icon
        </CommandItem>
      </CommandGroup>
    </>
  );
}

function InlineFixture({
  disabled = false,
  overflow = false,
  caller = false,
}: {
  disabled?: boolean;
  overflow?: boolean;
  caller?: boolean;
}) {
  const [selected, setSelected] = useState('none');
  return (
    <div {...stylex.props(styles.canvas)}>
      <div {...stylex.props(styles.frame)}>
        <Command loop className={caller ? 'rounded-none' : undefined}>
          <CommandInput
            aria-label="Search commands"
            placeholder="Search commands…"
            disabled={disabled}
            className={caller ? 'h-12 px-2' : undefined}
          />
          <CommandList
            containerClassName={caller ? 'max-h-[240px]' : undefined}
            viewportClassName={caller ? 'max-h-[240px]' : undefined}
          >
            <CommandEmpty {...(caller ? { className: 'py-2 text-center text-xs' } : {})}>
              No matching commands.
            </CommandEmpty>
            {overflow ? (
              <CommandGroup heading="Files">
                {Array.from({ length: 36 }, (_, index) => (
                  <CommandItem
                    key={index}
                    value={`file-${String(index).padStart(2, '0')}`}
                    onSelect={setSelected}
                  >
                    <Folder />
                    {`File ${String(index).padStart(2, '0')}: ${index === 2 ? 'A long command label with several words that reaches the narrow viewport boundary' : 'src/commands/example.ts'}`}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : (
              <Items onSelect={setSelected} />
            )}
            {caller ? (
              <CommandGroup heading="Caller overrides" className="p-0">
                <CommandItem value="override" className="py-2" onSelect={setSelected}>
                  <Plus />
                  Caller row
                </CommandItem>
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </div>
      <output aria-label="Selected command" {...stylex.props(styles.result)}>
        {selected}
      </output>
    </div>
  );
}

function DialogFixture() {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState('none');
  return (
    <div {...stylex.props(styles.canvas)}>
      <Button onClick={() => setOpen(true)}>Open command dialog</Button>
      <output aria-label="Selected command" {...stylex.props(styles.result)}>
        {selected}
      </output>
      <CommandDialog open={open} onOpenChange={setOpen}>
        <Dialog.Title className="sr-only">Command migration</Dialog.Title>
        <Dialog.Description className="sr-only">Choose a command.</Dialog.Description>
        <CommandInput aria-label="Search commands" placeholder="Search commands…" />
        <CommandList>
          <CommandEmpty>No matching commands.</CommandEmpty>
          <Items onSelect={setSelected} />
        </CommandList>
      </CommandDialog>
    </div>
  );
}

const paths = [
  'README.md',
  'src/main.tsx',
  'src/ui/command.tsx',
  'src/components/a-very-long-nested-directory/a-very-long-file-name.tsx',
];
const manyPaths = Array.from(
  { length: 80 },
  (_, index) => `src/files/file-${String(index).padStart(3, '0')}.tsx`
);
function QuickOpenFixture({
  virtualized = false,
  pending = false,
}: {
  virtualized?: boolean;
  pending?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const [selected, setSelected] = useState('none');
  return (
    <div {...stylex.props(styles.canvas)}>
      <Button onClick={() => setOpen(true)}>Open file picker</Button>
      <output aria-label="Opened file" {...stylex.props(styles.result)}>
        {selected}
      </output>
      <SessionFileQuickOpen
        open={open}
        onOpenChange={setOpen}
        fallbackPaths={virtualized ? manyPaths : paths}
        providerPending={pending}
        providerMessage={pending ? 'Waiting for file index…' : undefined}
        onOpenFile={setSelected}
      />
    </div>
  );
}

const meta = { title: 'UI/CommandMigration', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Inline: Story = { render: () => <InlineFixture /> };
export const InputDisabled: Story = { render: () => <InlineFixture disabled /> };
export const Overflow: Story = { render: () => <InlineFixture overflow /> };
export const CallerOverrides: Story = { render: () => <InlineFixture caller /> };
export const InDialog: Story = { render: () => <DialogFixture /> };
export const QuickOpen: Story = { render: () => <QuickOpenFixture /> };
export const QuickOpenVirtualized: Story = { render: () => <QuickOpenFixture virtualized /> };
export const QuickOpenPending: Story = { render: () => <QuickOpenFixture pending /> };
