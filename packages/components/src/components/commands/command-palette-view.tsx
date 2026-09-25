import { Command as CommandIcon, MessagesSquare, SearchX } from 'lucide-react';
import { CommandDialog, CommandInput, CommandItem, CommandList } from '@/ui/command';
import { Kbd as KeyHint } from '@lody/ui/kbd';
import { Kbd } from './kbd';

export type PaletteResult = {
  kind: 'command' | 'session';
  /** cmdk item value — must be unique + stable. */
  key: string;
  title: string;
  subtitle: string | null;
  /** Command keybinding (registry syntax) to show on the right, if any. */
  shortcut: string | null;
  /** Right-aligned trailing text (e.g. a session's compact last-activity time). */
  trailing?: string | null;
  run: () => void;
};

export type CommandPaletteLabels = {
  placeholder: string;
  empty: string;
  navigate: string;
  select: string;
  close: string;
};

export type CommandPaletteViewProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQueryChange: (query: string) => void;
  results: PaletteResult[];
  labels: CommandPaletteLabels;
};

/**
 * Presentational shell for the ⌘K palette — a flat, relevance-ordered result list with
 * per-item type badges and a key-hint footer. Pure (no atoms/router), so it renders in
 * Storybook with mock results; the container (`command-palette.tsx`) wires the data.
 */
export function CommandPaletteView({
  open,
  onOpenChange,
  query,
  onQueryChange,
  results,
  labels,
}: CommandPaletteViewProps) {
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} shouldFilter={false}>
      <CommandInput placeholder={labels.placeholder} value={query} onValueChange={onQueryChange} />
      {/* Fill the fixed dialog height and scroll inside — `max-h-none` drops the shared
          CommandList cap, `flex-1 min-h-0` claims the space between input + footer so the
          panel size never tracks the result count. Empty state is a flex-1 sibling (not inside
          the scroll area) so it reliably centers without depending on ScrollArea's height chain. */}
      {results.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2.5 px-4 text-center">
          <SearchX className="size-6 text-muted-foreground/40" strokeWidth={1.5} />
          <p className="text-sm text-muted-foreground">{labels.empty}</p>
        </div>
      ) : (
        <CommandList
          className="px-0 py-1.5"
          containerClassName="max-h-none min-h-0 flex-1"
          viewportClassName="max-h-none h-full"
        >
          {results.map((result) => (
            <ResultRow key={result.key} result={result} />
          ))}
        </CommandList>
      )}

      <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border/60 px-3 py-2 text-[11px] text-muted-foreground">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <KeyHint>↑</KeyHint>
            <KeyHint>↓</KeyHint>
            {labels.navigate}
          </span>
          <span className="flex items-center gap-1">
            <KeyHint>↵</KeyHint>
            {labels.select}
          </span>
        </div>
        <span className="flex items-center gap-1">
          <KeyHint>esc</KeyHint>
          {labels.close}
        </span>
      </footer>
    </CommandDialog>
  );
}

function ResultRow({ result }: { result: PaletteResult }) {
  const isSession = result.kind === 'session';
  return (
    <CommandItem
      value={result.key}
      onSelect={result.run}
      className="mx-2 my-px gap-2.5 rounded-md px-2.5 py-1.5"
    >
      <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-foreground/[0.05] text-muted-foreground">
        {isSession ? (
          <MessagesSquare className="size-3" strokeWidth={1.75} />
        ) : (
          <CommandIcon className="size-3" strokeWidth={1.75} />
        )}
      </span>

      {/* Single line: the title fills and truncates; the project/repo (and local-project
          branch) plus the last-activity time sit on the right. */}
      <span className="min-w-0 flex-1 truncate text-sm font-normal text-foreground">
        {result.title}
      </span>

      {result.shortcut ? (
        <div className="flex shrink-0 items-center">
          <Kbd binding={result.shortcut} />
        </div>
      ) : result.subtitle || result.trailing ? (
        <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          {result.subtitle && <span className="max-w-[16rem] truncate">{result.subtitle}</span>}
          {result.trailing && (
            <span className="shrink-0 tabular-nums text-muted-foreground/70">
              {result.trailing}
            </span>
          )}
        </div>
      ) : null}
    </CommandItem>
  );
}
