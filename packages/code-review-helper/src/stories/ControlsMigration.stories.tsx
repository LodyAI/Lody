import type { Meta, StoryObj } from '@storybook/react';
import { useState, type CSSProperties } from 'react';
import { Check, Square } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '../ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';

const meta = {
  title: 'Code Review Helper/ControlsMigration',
  parameters: { layout: 'fullscreen', controls: { disable: true } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const triggerStyle = { padding: 12, border: '1px solid hsl(var(--border))', borderRadius: 4 };
const scoped = {
  '--spacing': '5px',
  '--radius': '10px',
  '--popover': '222 24% 18%',
  '--foreground': '36 90% 82%',
  '--border': '185 58% 52%',
  '--muted-foreground': '218 24% 72%',
} as CSSProperties;

function Menu({ caller = false }: { caller?: boolean }) {
  const [selection, setSelection] = useState('None');
  return (
    <main
      className="crh-shell dark"
      data-controls-migration="menu"
      style={{
        minHeight: '100vh',
        padding: 32,
        background: 'hsl(var(--background))',
        color: 'hsl(var(--foreground))',
      }}
    >
      <DropdownMenu>
        <DropdownMenuTrigger data-menu-trigger style={triggerStyle}>
          Group actions
        </DropdownMenuTrigger>
        <DropdownMenuContent
          data-owned-menu
          align="start"
          style={caller ? scoped : undefined}
          className={caller ? 'min-w-56 rounded-none border-4 p-3 text-info' : undefined}
        >
          <DropdownMenuLabel
            data-owned-label
            className={caller ? 'px-4 py-3 text-[14px] normal-case text-info' : undefined}
          >
            This group
          </DropdownMenuLabel>
          <DropdownMenuItem
            data-owned-item="first"
            className={caller ? 'gap-4 rounded-none px-4 py-3 text-[15px] text-info' : undefined}
            onSelect={() => setSelection('Viewed')}
          >
            <Check />
            Mark all files viewed
          </DropdownMenuItem>
          <DropdownMenuItem data-owned-item="disabled" disabled>
            <Square />
            Disabled action
          </DropdownMenuItem>
          <DropdownMenuSeparator
            data-owned-separator
            className={caller ? 'mx-2 my-3 h-0.5 bg-info' : undefined}
          />
          <DropdownMenuItem data-owned-item="last" onSelect={() => setSelection('Expanded')}>
            Expand all files
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <p data-selection>Selected: {selection}</p>
    </main>
  );
}

function Hint({
  side = 'top',
  caller = false,
}: {
  side?: 'top' | 'right' | 'bottom' | 'left';
  caller?: boolean;
}) {
  return (
    <main
      className="crh-shell dark"
      data-controls-migration="tooltip"
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: 'hsl(var(--background))',
        color: 'hsl(var(--foreground))',
      }}
    >
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger data-tooltip-trigger style={triggerStyle}>
            Line note
          </TooltipTrigger>
          <TooltipContent
            data-owned-tooltip
            side={side}
            align="center"
            style={caller ? scoped : undefined}
            className={
              caller ? 'w-72 max-w-[18rem] rounded-none border-4 p-0 text-info' : 'px-3 py-2'
            }
          >
            Synthetic local line note.
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </main>
  );
}

export const MenuDefault: Story = { render: () => <Menu /> };
export const MenuCaller: Story = { render: () => <Menu caller /> };
export const TooltipTop: Story = { render: () => <Hint /> };
export const TooltipRight: Story = { render: () => <Hint side="right" /> };
export const TooltipBottom: Story = { render: () => <Hint side="bottom" /> };
export const TooltipLeft: Story = { render: () => <Hint side="left" /> };
export const TooltipCaller: Story = { render: () => <Hint caller /> };

export const MenuSlot: Story = {
  render: () => (
    <main
      className="crh-shell dark"
      data-controls-migration="menu-slot"
      style={{
        minHeight: '100vh',
        padding: 32,
        background: 'hsl(var(--background))',
        color: 'hsl(var(--foreground))',
      }}
    >
      <DropdownMenu>
        <DropdownMenuTrigger data-menu-trigger style={triggerStyle}>
          Slot actions
        </DropdownMenuTrigger>
        <DropdownMenuContent asChild data-owned-menu align="start">
          <article className="z-10 min-w-24 rounded-none p-0" data-slot-child="content">
            <DropdownMenuLabel asChild data-owned-label>
              <span className="px-0 py-0" data-slot-child="label">
                This group
              </span>
            </DropdownMenuLabel>
            <DropdownMenuItem asChild data-owned-item="first">
              <a className="block gap-1 px-0 py-0" href="#slot-first" data-slot-child="item">
                <Check />
                First action
              </a>
            </DropdownMenuItem>
            <DropdownMenuSeparator asChild data-owned-separator>
              <hr className="my-0 h-2" data-slot-child="separator" />
            </DropdownMenuSeparator>
            <DropdownMenuItem data-owned-item="last">Last action</DropdownMenuItem>
          </article>
        </DropdownMenuContent>
      </DropdownMenu>
    </main>
  ),
};

export const TooltipSlot: Story = {
  render: () => (
    <main
      className="crh-shell dark"
      data-controls-migration="tooltip-slot"
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: 'hsl(var(--background))',
        color: 'hsl(var(--foreground))',
      }}
    >
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger data-tooltip-trigger style={triggerStyle}>
            Slot note
          </TooltipTrigger>
          <TooltipContent asChild data-owned-tooltip side="top">
            <article className="z-10 rounded-none border-0" data-slot-child="tooltip">
              Synthetic slot note.
            </article>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </main>
  ),
};
