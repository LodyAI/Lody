import {
  type KeyboardEvent,
  type ReactElement,
  type RefObject,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Check, Search, X } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { text } from '@lody/ui/tokens/scales.stylex';
import { Button } from '@lody/ui/button';
import { Popover } from '@lody/ui/popover';
import { UserAvatar } from '@/components/user-avatar';
import { filterFuzzyOptions } from '@/lib/fuzzy-option-filter';
import { menuStyles } from '@/ui/menu-styles';
import { themeColors } from '../style/theme-colors.stylex';
import { themeRadius, themeSpace } from '../style/theme-scale.stylex';
import { filterOptionStyles, filterOptionTypography } from './sidebar-filter-option-styles';

/** A workspace member the Owner filter can choose. */
export type SidebarFilterMember = {
  userId: string;
  name: string;
  image?: string | null;
  isCurrentUser?: boolean;
};

export type OwnerFilterLabels = {
  owner: string;
  is: string;
  isAnyOf: string;
  searchPlaceholder: string;
  empty: string;
  clear: string;
  you: string;
};

export const defaultOwnerFilterLabels: OwnerFilterLabels = {
  owner: 'Owner',
  is: 'is',
  isAnyOf: 'is any of',
  searchPlaceholder: 'Search people…',
  empty: 'No matching people',
  clear: 'Clear owner filter',
  you: 'You',
};

/** Names shown before the rest fold into "+N". */
const SUMMARY_NAME_LIMIT = 2;

const styles = stylex.create({
  panel: { display: 'flex', flexDirection: 'column', width: 240 },
  /** Eight rows, then the list scrolls under the fixed search field. */
  list: {
    display: 'flex',
    flexDirection: 'column',
    maxHeight: `calc(${themeSpace[7]} * 8)`,
    overflowX: 'hidden',
    overflowY: 'auto',
  },
  empty: {
    paddingInline: themeSpace[2],
    paddingBlock: themeSpace[1.5],
    color: themeColors.mutedForeground,
  },
  you: { flexShrink: 0, color: themeColors.mutedForeground },
  bar: {
    display: 'flex',
    alignItems: 'center',
    minWidth: 0,
    gap: themeSpace[1],
    marginInline: themeSpace[2],
    marginBottom: themeSpace[1],
    paddingInlineStart: themeSpace[2],
    borderRadius: themeRadius.md,
    backgroundColor: 'hsl(var(--foreground) / 0.05)',
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: themeColors.sidebarForegroundMuted,
  },
  barTerm: { flexShrink: 0, whiteSpace: 'nowrap' },
  barNames: {
    minWidth: 0,
    flexShrink: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: themeColors.sidebarForeground,
  },
  barExtra: { flexShrink: 0, color: themeColors.sidebarForegroundMuted },
  /** Layout only: the names give way before the remove button does. */
  barValue: {
    display: 'inline-flex',
    minWidth: 0,
    maxWidth: '100%',
    flexShrink: 1,
    overflow: 'hidden',
    gap: themeSpace[1],
  },
  barClear: { flexShrink: 0 },
  barSpacer: { flexGrow: 1 },
});

/** The chosen people in the list's own order, as names plus how many were folded away. */
export function summarizeOwners(
  members: readonly SidebarFilterMember[],
  selectedMemberIds: readonly string[]
): { names: string[]; extra: number; all: string[] } {
  const byId = new Map(members.map((member) => [member.userId, member.name]));
  const all = selectedMemberIds.map((id) => byId.get(id) ?? id);
  return {
    names: all.slice(0, SUMMARY_NAME_LIMIT),
    extra: Math.max(0, all.length - SUMMARY_NAME_LIMIT),
    all,
  };
}

/**
 * You first, then whoever was chosen when the list opened, then everyone else
 * by name. The order is fixed while the list is open so a row never moves out
 * from under the pointer that just ticked it.
 */
function orderOwners(
  members: readonly SidebarFilterMember[],
  chosenAtOpen: readonly string[]
): SidebarFilterMember[] {
  const chosen = new Set(chosenAtOpen);
  const rank = (member: SidebarFilterMember) =>
    member.isCurrentUser ? 0 : chosen.has(member.userId) ? 1 : 2;
  return [...members].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

function OwnerOption({
  member,
  checked,
  youLabel,
  onToggle,
}: {
  member: SidebarFilterMember;
  checked: boolean;
  youLabel: string;
  onToggle: (userId: string) => void;
}) {
  const optionProps = stylex.props(filterOptionStyles.option, filterOptionTypography.option);
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      data-sidebar-owner-option={member.userId}
      className={optionProps.className}
      onClick={() => onToggle(member.userId)}
    >
      <UserAvatar
        user={{ id: member.userId, name: member.name, image: member.image }}
        size="mini"
      />
      <span {...stylex.props(filterOptionStyles.optionLabel)}>{member.name}</span>
      {member.isCurrentUser ? <span {...stylex.props(styles.you)}>{youLabel}</span> : null}
      {checked ? (
        <Check {...stylex.props(filterOptionStyles.optionIcon)} aria-hidden="true" />
      ) : (
        <span {...stylex.props(filterOptionStyles.optionSpacer)} aria-hidden="true" />
      )}
    </button>
  );
}

type OwnerFilterPanelProps = {
  members: readonly SidebarFilterMember[];
  /** Who is chosen; for My Tasks, pass only the current user. */
  selectedMemberIds: readonly string[];
  onToggleMember: (userId: string) => void;
  labels: OwnerFilterLabels;
  inputRef: RefObject<HTMLInputElement | null>;
};

function OwnerFilterPanel({
  members,
  selectedMemberIds,
  onToggleMember,
  labels,
  inputRef,
}: OwnerFilterPanelProps) {
  const [query, setQuery] = useState('');
  const [chosenAtOpen] = useState(() => selectedMemberIds);
  const listRef = useRef<HTMLDivElement | null>(null);
  const ordered = useMemo(() => orderOwners(members, chosenAtOpen), [members, chosenAtOpen]);
  const filtered = useMemo(
    () => filterFuzzyOptions(ordered, query, (member) => ({ primary: member.name })),
    [ordered, query]
  );
  const options = () => [
    ...(listRef.current?.querySelectorAll<HTMLElement>('[data-sidebar-owner-option]') ?? []),
  ];

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const top = filtered[0];
      if (top) onToggleMember(top.userId);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      options()[0]?.focus();
    }
  };
  const handleListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = options();
    const index = rows.indexOf(event.target as HTMLElement);
    if (index < 0) return;
    event.preventDefault();
    if (event.key === 'ArrowUp' && index === 0) inputRef.current?.focus();
    else
      rows[event.key === 'ArrowDown' ? Math.min(index + 1, rows.length - 1) : index - 1]?.focus();
  };

  const selected = new Set(selectedMemberIds);
  return (
    <div {...stylex.props(styles.panel)}>
      <label {...stylex.props(menuStyles.searchShell)}>
        <Search {...stylex.props(menuStyles.searchGlyph)} strokeWidth={1.75} aria-hidden="true" />
        <input
          ref={inputRef}
          data-sidebar-owner-search=""
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleSearchKeyDown}
          placeholder={labels.searchPlaceholder}
          aria-label={labels.searchPlaceholder}
          autoComplete="off"
          spellCheck={false}
          {...stylex.props(menuStyles.searchInput)}
        />
      </label>
      <div
        ref={listRef}
        role="group"
        aria-label={labels.owner}
        onKeyDown={handleListKeyDown}
        className={`${stylex.props(styles.list).className ?? ''} scroll-pro scrollbar-pro`}
      >
        {filtered.length === 0 ? (
          <div {...stylex.props(styles.empty, filterOptionTypography.option)}>{labels.empty}</div>
        ) : (
          filtered.map((member) => (
            <OwnerOption
              key={member.userId}
              member={member}
              checked={selected.has(member.userId)}
              youLabel={labels.you}
              onToggle={onToggleMember}
            />
          ))
        )}
      </div>
    </div>
  );
}

export type OwnerFilterPopoverProps = Omit<OwnerFilterPanelProps, 'inputRef' | 'labels'> & {
  labels?: Partial<OwnerFilterLabels>;
  /** The element that opens the list, passed through Base UI's `render`. */
  trigger: ReactElement;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Open as a submenu does, on hover, as well as on press. */
  openOnHover?: boolean;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
};

/** The searchable people list, Linear's Assignee submenu: typing narrows, Enter ticks the top match. */
export function OwnerFilterPopover({
  trigger,
  open,
  onOpenChange,
  openOnHover = false,
  side = 'right',
  align = 'start',
  labels,
  ...panel
}: OwnerFilterPopoverProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const merged = { ...defaultOwnerFilterLabels, ...labels };
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger openOnHover={openOnHover} delay={100} render={trigger} />
      <Popover.Content
        side={side}
        align={align}
        sideOffset={6}
        padding="none"
        gap="none"
        initialFocus={inputRef}
        xstyle={ownerPopoverStyles.content}
      >
        <OwnerFilterPanel {...panel} labels={merged} inputRef={inputRef} />
      </Popover.Content>
    </Popover.Root>
  );
}

const ownerPopoverStyles = stylex.create({
  content: { padding: 'calc(var(--spacing) * 1)' },
});

export type SidebarOwnerFilterBarProps = {
  members: readonly SidebarFilterMember[];
  selectedMemberIds: readonly string[];
  onToggleMember: (userId: string) => void;
  onClear: () => void;
  labels?: Partial<OwnerFilterLabels>;
  /** Controlled so a keyboard shortcut can open the list from outside. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/**
 * The applied filter as Linear writes it — "Owner is Alice" or "Owner is any
 * of Alice, Bob +3" — kept above the list while it narrows. The names reopen
 * the people list; the cross returns to All Tasks.
 */
export function SidebarOwnerFilterBar({
  members,
  selectedMemberIds,
  onToggleMember,
  onClear,
  labels,
  open: controlledOpen,
  onOpenChange,
}: SidebarOwnerFilterBarProps) {
  const merged = { ...defaultOwnerFilterLabels, ...labels };
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  if (selectedMemberIds.length === 0) return null;
  const summary = summarizeOwners(members, selectedMemberIds);
  return (
    <div data-sidebar-owner-filter-bar="" {...stylex.props(styles.bar)}>
      <span {...stylex.props(styles.barTerm)}>{merged.owner}</span>
      <span {...stylex.props(styles.barTerm)}>
        {selectedMemberIds.length > 1 ? merged.isAnyOf : merged.is}
      </span>
      <OwnerFilterPopover
        members={members}
        selectedMemberIds={selectedMemberIds}
        onToggleMember={onToggleMember}
        labels={labels}
        open={open}
        onOpenChange={setOpen}
        side="right"
        align="start"
        trigger={
          <Button
            type="button"
            variant="ghost"
            size="mini"
            title={summary.all.join(', ')}
            xstyle={styles.barValue}
          >
            <span {...stylex.props(styles.barNames)}>{summary.names.join(', ')}</span>
            {summary.extra > 0 ? (
              <span {...stylex.props(styles.barExtra)}>+{summary.extra}</span>
            ) : null}
          </Button>
        }
      />
      <span {...stylex.props(styles.barSpacer)} />
      <Button
        type="button"
        variant="ghost"
        size="mini"
        icon
        aria-label={merged.clear}
        onClick={onClear}
        xstyle={styles.barClear}
      >
        <X {...stylex.props(filterOptionStyles.optionIcon)} strokeWidth={1.75} aria-hidden="true" />
      </Button>
    </div>
  );
}
