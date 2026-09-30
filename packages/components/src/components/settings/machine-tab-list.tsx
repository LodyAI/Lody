import { useCallback, useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, ListFilter, LockKeyhole, Users } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { type MachineId, type MachineViewMeta } from '@lody/shared';
import type { MachineSettingsFilter } from '@/atoms/settings-machine-tab';
import type { MachineVisibilityAccess } from '@/hooks/use-visible-machine-metas';
import { Button } from '@lody/ui/button';
import { Menu } from '@/ui/menu';
import { Tooltip } from '@lody/ui/tooltip';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, focus, radius, space } from '@lody/ui/tokens/scales.stylex';
import { UserAvatar } from '@/components/user-avatar';
import { FocusScope, useListKeyboardNavigation } from '@/ui/focus-scope';
import { settingsSurface as surface } from './surface';
import { settingsType as type } from './type.stylex';

export type MachineTabListVariant = 'compact' | 'detailed';

export type MachineTabItem = {
  machine: MachineViewMeta;
  isOwn: boolean;
  isOnline: boolean;
  sharedWithTeam: boolean;
};

export type MachineTabOwner = {
  id: string;
  name: string;
  image?: string | null;
  email?: string | null;
};

export type MachineTabListProps = {
  items: MachineTabItem[];
  selectedMachineId: MachineId | null;
  onSelect: (machineId: MachineId) => void;
  filter: MachineSettingsFilter;
  onFilterChange: (next: MachineSettingsFilter) => void;
  totalBeforeFilter: number;
  variant?: MachineTabListVariant;
  showFilter?: boolean;
  /** Workspace Machines are all shared, so show ownership instead of redundant access state. */
  showOwner?: boolean;
  ownerByUserId?: ReadonlyMap<string, MachineTabOwner>;
};

export function MachineTabList({
  items,
  selectedMachineId,
  onSelect,
  filter,
  onFilterChange,
  totalBeforeFilter,
  variant = 'compact',
  showFilter = true,
  showOwner = false,
  ownerByUserId,
}: MachineTabListProps) {
  const { t } = useTranslation();
  const scopeId = useId();
  const handleItemFocus = useCallback(
    (item: HTMLElement) => {
      const machineId = item.dataset.settingsMachineId?.trim();
      if (machineId) onSelect(machineId as MachineId);
    },
    [onSelect]
  );
  useListKeyboardNavigation({ onItemFocus: handleItemFocus, scopeId });
  const hiddenByFilter = Math.max(0, totalBeforeFilter - items.length);

  return (
    <Tooltip.Provider delay={250}>
      <FocusScope id={scopeId} {...stylex.props(styles.scope)}>
        <div {...stylex.props(styles.header)}>
          <p {...stylex.props(styles.title)}>{t('workspace.machines.title', 'Machines')}</p>
          {showFilter ? (
            <MachineListFilterButton filter={filter} onFilterChange={onFilterChange} />
          ) : null}
        </div>

        <div {...stylex.props(styles.scroller)}>
          {/* The detailed list is a list of records: one card of ruled rows. The
              compact one is a sidebar list, rows with no edge of their own. */}
          {variant === 'detailed' ? (
            items.length > 0 ? (
              <ul {...stylex.props(styles.list, surface.card)}>
                {items.map((item, index) => (
                  <DetailedMachineTab
                    key={item.machine.id}
                    item={item}
                    ruled={index > 0}
                    isSelected={item.machine.id === selectedMachineId}
                    onSelect={() => onSelect(item.machine.id)}
                    showOwner={showOwner}
                    ownerByUserId={ownerByUserId}
                  />
                ))}
              </ul>
            ) : null
          ) : (
            <ul {...stylex.props(styles.list, styles.sidebarList)}>
              {items.map((item) => (
                <MachineTab
                  key={item.machine.id}
                  item={item}
                  isSelected={item.machine.id === selectedMachineId}
                  onSelect={() => onSelect(item.machine.id)}
                  showOwner={showOwner}
                  ownerByUserId={ownerByUserId}
                />
              ))}
            </ul>
          )}
          {items.length === 0 && (
            <div {...stylex.props(styles.empty)}>
              {totalBeforeFilter === 0
                ? t('workspace.machines.empty', 'No machines connected')
                : t(
                    'settings.agent.machineTabs.filter.noMatch',
                    'No machines match these filters.'
                  )}
              {hiddenByFilter > 0 && (
                <div {...stylex.props(styles.emptyAction)}>
                  <Button
                    variant="link"
                    size="small"
                    onClick={() => onFilterChange({ onlineOnly: false, mineOnly: false })}
                  >
                    {t('settings.agent.machineTabs.filter.reset', 'Clear filter')}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </FocusScope>
    </Tooltip.Provider>
  );
}

export function MachineListFilterButton({
  filter,
  onFilterChange,
}: {
  filter: MachineSettingsFilter;
  onFilterChange: (next: MachineSettingsFilter) => void;
}) {
  const { t } = useTranslation();
  const isFilterActive = filter.onlineOnly || filter.mineOnly;

  return (
    <Menu.Root>
      <Menu.Trigger
        render={
          <Button
            variant={isFilterActive ? 'secondary' : 'ghost'}
            size="small"
            icon
            aria-label={t('settings.agent.machineTabs.filter.label', 'Filter machines')}
          >
            <ListFilter {...stylex.props(styles.glyph)} />
          </Button>
        }
      />
      <Menu.Content align="end">
        <Menu.GroupLabel>
          {t('settings.agent.machineTabs.filter.label', 'Filter machines')}
        </Menu.GroupLabel>
        <Menu.Separator />
        <FilterItem
          label={t('settings.agent.machineTabs.filter.online', 'Online')}
          checked={filter.onlineOnly}
          onSelect={() => onFilterChange({ ...filter, onlineOnly: !filter.onlineOnly })}
        />
        <FilterItem
          label={t('settings.agent.machineTabs.filter.mine', 'My machines')}
          checked={filter.mineOnly}
          onSelect={() => onFilterChange({ ...filter, mineOnly: !filter.mineOnly })}
        />
      </Menu.Content>
    </Menu.Root>
  );
}

function MachineTab({
  item,
  isSelected,
  onSelect,
  showOwner,
  ownerByUserId,
}: {
  item: MachineTabItem;
  isSelected: boolean;
  onSelect: () => void;
  showOwner: boolean;
  ownerByUserId?: ReadonlyMap<string, MachineTabOwner>;
}) {
  const { t } = useTranslation();
  return (
    <li {...stylex.props(styles.item)}>
      <button
        type="button"
        aria-current={isSelected ? 'true' : undefined}
        data-id={`machine:${item.machine.id}`}
        data-scope-item="row"
        data-settings-machine-id={item.machine.id}
        onClick={onSelect}
        aria-pressed={isSelected}
        {...stylex.props(surface.listRow, isSelected && surface.listRowSelected)}
      >
        <span
          aria-hidden
          {...stylex.props(styles.dot, item.isOnline && styles.dotOnline)}
          title={
            item.isOnline
              ? t('workspace.machines.online', 'Online')
              : t('workspace.machines.offline', 'Offline')
          }
        />
        <span {...stylex.props(surface.listRowLabel)}>{item.machine.name || item.machine.id}</span>
        {showOwner ? (
          <MachineOwnerAvatar item={item} ownerByUserId={ownerByUserId} />
        ) : (
          <MachineAccessStatus sharedWithTeam={item.sharedWithTeam} />
        )}
      </button>
    </li>
  );
}

function DetailedMachineTab({
  item,
  ruled,
  isSelected,
  onSelect,
  showOwner,
  ownerByUserId,
}: {
  item: MachineTabItem;
  /** Every row but the first is ruled from the one above. */
  ruled: boolean;
  isSelected: boolean;
  onSelect: () => void;
  showOwner: boolean;
  ownerByUserId?: ReadonlyMap<string, MachineTabOwner>;
}) {
  const { t } = useTranslation();
  const onlineText = item.isOnline
    ? t('workspace.machines.online', 'Online')
    : t('workspace.machines.offline', 'Offline');
  const version = item.machine.cliVersion ? `v${item.machine.cliVersion}` : null;
  const os = item.machine.os || null;
  return (
    <li {...stylex.props(styles.item, ruled && surface.lineRuled)}>
      <button
        type="button"
        aria-current={isSelected ? 'true' : undefined}
        data-id={`machine:${item.machine.id}`}
        data-scope-item="row"
        data-settings-machine-id={item.machine.id}
        onClick={onSelect}
        aria-pressed={isSelected}
        {...stylex.props(styles.detailedRow, isSelected && styles.detailedRowSelected)}
      >
        <span aria-hidden {...stylex.props(styles.dot, item.isOnline && styles.dotOnline)} />
        <div {...stylex.props(styles.detailedText)}>
          <div {...stylex.props(styles.detailedNameLine)}>
            <span {...stylex.props(styles.truncate, styles.detailedName)}>
              {item.machine.name || item.machine.id}
            </span>
            {showOwner ? (
              <MachineOwnerAvatar item={item} ownerByUserId={ownerByUserId} />
            ) : (
              <MachineAccessStatus sharedWithTeam={item.sharedWithTeam} />
            )}
          </div>
          <div {...stylex.props(styles.detailedMeta)}>
            <span {...stylex.props(item.isOnline && styles.online)}>{onlineText}</span>
            {os && (
              <>
                <span aria-hidden>·</span>
                <span {...stylex.props(styles.truncate)}>{os}</span>
              </>
            )}
            {version && (
              <>
                <span aria-hidden>·</span>
                <span {...stylex.props(styles.mono)}>{version}</span>
              </>
            )}
          </div>
        </div>
        <ChevronRight aria-hidden {...stylex.props(styles.chevron)} />
      </button>
    </li>
  );
}

function MachineOwnerAvatar({
  item,
  ownerByUserId,
}: {
  item: MachineTabItem;
  ownerByUserId?: ReadonlyMap<string, MachineTabOwner>;
}) {
  const { t } = useTranslation();
  const ownerUserId = item.machine.ownerUserId ?? null;
  const owner = ownerUserId ? ownerByUserId?.get(ownerUserId) : undefined;
  const ownerName = owner?.name || owner?.email || ownerUserId || t('common.unknown', 'Unknown');

  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <span
            aria-label={t('workspace.machines.ownerTooltip', {
              owner: ownerName,
              defaultValue: 'Machine owner: {{owner}}',
            })}
            {...stylex.props(styles.avatar)}
          >
            <UserAvatar
              user={owner ?? (ownerUserId ? { id: ownerUserId, name: ownerName } : null)}
              size="small"
              showIcon={!ownerUserId}
            />
          </span>
        }
      />
      <Tooltip.Content side="right">
        {t('workspace.machines.ownerTooltip', {
          owner: ownerName,
          defaultValue: 'Machine owner: {{owner}}',
        })}
      </Tooltip.Content>
    </Tooltip.Root>
  );
}

function MachineAccessStatus({ sharedWithTeam }: { sharedWithTeam: boolean }) {
  const { t } = useTranslation();
  const Icon = sharedWithTeam ? Users : LockKeyhole;
  const label = sharedWithTeam
    ? t('workspace.machines.shared', 'Shared')
    : t('workspace.machines.private', 'Private');
  const description = sharedWithTeam
    ? t(
        'workspace.machines.sharedTooltip',
        'Workspace members can access this machine. Only the machine owner can change sharing.'
      )
    : t(
        'workspace.machines.privateTooltip',
        'Only the machine owner can access this machine. It is not available to other workspace members.'
      );

  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <span aria-label={`${label}. ${description}`} {...stylex.props(styles.access)}>
            <Icon strokeWidth={1.75} aria-hidden="true" {...stylex.props(styles.accessIcon)} />
            <span>{label}</span>
          </span>
        }
      />
      <Tooltip.Content side="right">
        <p {...stylex.props(styles.tooltipTitle)}>{label}</p>
        <p {...stylex.props(styles.tooltipHint)}>{description}</p>
      </Tooltip.Content>
    </Tooltip.Root>
  );
}

function FilterItem({
  label,
  checked,
  onSelect,
}: {
  label: string;
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <Menu.CheckboxItem checked={checked} closeOnClick={false} onCheckedChange={() => onSelect()}>
      {label}
    </Menu.CheckboxItem>
  );
}

const styles = stylex.create({
  scope: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    width: '100%',
    minWidth: 0,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
    paddingInline: space[2],
    paddingBottom: space[2],
  },
  title: {
    minWidth: 0,
    margin: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: type.caption,
    fontWeight: 400,
    color: colors.secondaryLabel,
  },
  scroller: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minHeight: 0,
    minWidth: 0,
    overflowY: 'auto',
    paddingInlineEnd: space[1],
  },
  list: { minWidth: 0, margin: 0, padding: 0, listStyle: 'none' },
  sidebarList: { display: 'flex', flexDirection: 'column', gap: '2px' },
  item: { minWidth: 0 },
  empty: {
    paddingInline: space[2],
    paddingBlock: space[4],
    textAlign: 'center',
    fontSize: type.caption,
    color: colors.secondaryLabel,
  },
  emptyAction: { marginTop: space[2] },
  glyph: { width: '100%', height: '100%' },
  dot: {
    flexShrink: 0,
    width: '8px',
    height: '8px',
    borderRadius: radius.full,
    cornerShape: corner.round,
    backgroundColor: colors.tertiaryLabel,
  },
  dotOnline: {
    backgroundColor: colors.success,
    boxShadow: `0 0 0 3px color-mix(in oklab, ${colors.success} 20%, transparent)`,
  },
  /** A row of the detailed list: the whole line opens the machine. */
  detailedRow: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: space[3],
    width: '100%',
    minWidth: 0,
    margin: 0,
    paddingInline: space[4],
    paddingBlock: space[3],
    borderWidth: 0,
    backgroundColor: {
      default: 'transparent',
      ':hover': `color-mix(in oklab, ${colors.elevatedBackground}, ${colors.label} 4%)`,
    },
    color: colors.label,
    fontFamily: 'inherit',
    fontSize: '1em',
    textAlign: 'start',
    cursor: 'pointer',
    outlineStyle: 'none',
    boxShadow: {
      default: 'none',
      ':focus-visible': `inset 0 0 0 ${focus.ringWidth} ${colors.accent}`,
    },
  },
  detailedRowSelected: {
    backgroundColor: { default: colors.selectedFill, ':hover': colors.selectedFill },
  },
  detailedText: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[1],
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
  },
  detailedNameLine: { display: 'flex', alignItems: 'center', gap: space[2], minWidth: 0 },
  detailedName: { minWidth: 0, fontSize: type.caption, fontWeight: 400 },
  detailedMeta: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: space[2],
    rowGap: '2px',
    minWidth: 0,
    fontSize: '11px',
    color: colors.secondaryLabel,
  },
  online: { color: colors.success },
  mono: { fontFamily: 'var(--font-mono, ui-monospace, monospace)' },
  truncate: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  chevron: { flexShrink: 0, width: '16px', height: '16px', color: colors.tertiaryLabel },
  avatar: { display: 'inline-flex', flexShrink: 0, cursor: 'default' },
  access: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: space[1],
    fontSize: '10px',
    color: colors.secondaryLabel,
  },
  accessIcon: { width: '12px', height: '12px' },
  tooltipTitle: { margin: 0 },
  tooltipHint: { margin: 0, marginTop: '2px', opacity: 0.7 },
});

export function buildMachineTabItems(params: {
  machines: Map<MachineId, MachineViewMeta>;
  accessByMachineId: Map<MachineId, MachineVisibilityAccess>;
  onlineMachineIds: ReadonlySet<MachineId>;
  isOwnMachine: (machine: MachineViewMeta) => boolean;
  filter: MachineSettingsFilter;
}): { items: MachineTabItem[]; totalBeforeFilter: number } {
  const { machines, accessByMachineId, onlineMachineIds, isOwnMachine, filter } = params;
  const all: MachineTabItem[] = [];
  for (const machine of machines.values()) {
    const isOwn = isOwnMachine(machine);
    const isOnline = onlineMachineIds.has(machine.id);
    const sharedWithTeam = accessByMachineId.get(machine.id)?.sharedWithTeam ?? false;
    all.push({ machine, isOwn, isOnline, sharedWithTeam });
  }

  const filtered = all.filter((item) => {
    if (filter.onlineOnly && !item.isOnline) return false;
    if (filter.mineOnly && !item.isOwn) return false;
    return true;
  });

  filtered.sort((a, b) => {
    if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
    return a.machine.name.localeCompare(b.machine.name);
  });

  return { items: filtered, totalBeforeFilter: all.length };
}

export function useMachineTabItems(params: {
  machines: Map<MachineId, MachineViewMeta>;
  accessByMachineId: Map<MachineId, MachineVisibilityAccess>;
  onlineMachineIds: ReadonlySet<MachineId>;
  isOwnMachine: (machine: MachineViewMeta) => boolean;
  filter: MachineSettingsFilter;
}) {
  return useMemo(() => buildMachineTabItems(params), [params]);
}
