import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowUpRight,
  Check,
  ChevronsUpDown,
  CircleSlash2,
  FolderKanban,
  FolderOpen,
  FolderPlus,
  Github,
  LockKeyhole,
  Monitor,
  Search,
  X,
} from 'lucide-react';
import type { LocalProjectId, MachineId } from '@lody/shared';

import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from '@/ui/drawer';
import { Input } from '@lody/ui/input';
import { useKeyboardAwareSheet } from '@/hooks/use-keyboard-aware-scroll-into-view';
import * as stylex from '@stylexjs/stylex';
import { themeColors } from '../../style/theme-colors.stylex';
import { sheetSurface } from './sheet-surface';
import { control } from '@lody/ui/tokens/scales.stylex';
import type { UnifiedProjectSelection } from '@/components/chat/unified-project-selector';
import { filterMobileProjectOptions } from './mobile-new-chat-project-options';

export type MobileProjectMachine = {
  id: MachineId;
  name: string;
  online: boolean;
  disabledReason?: string;
};

export type MobileProjectFolder = {
  machineId: MachineId;
  localProjectId: LocalProjectId;
  name: string;
  rootPath: string;
  lastUsedAt?: number;
};

export type MobileProjectRepo = {
  fullName: string;
  description?: string;
  lastUsedAt?: number;
};

export type MobileProjectGroup = {
  projectId: string;
  name: string;
  memberCount: number;
  availability?: string;
  disabledReason?: string;
  lastUsedAt?: number;
};

export type MobileNewChatProjectSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  machines: ReadonlyArray<MobileProjectMachine>;
  selectedMachineId: MachineId | null;
  onMachineChange: (machineId: MachineId) => void;
  localProjects: ReadonlyArray<MobileProjectFolder>;
  repositories: ReadonlyArray<MobileProjectRepo>;
  groups?: ReadonlyArray<MobileProjectGroup>;
  selection: UnifiedProjectSelection;
  onSelect: (selection: UnifiedProjectSelection) => void;
  onAddLocalProject: () => void;
  onConnectGitHub: () => void;
  /** A Role can pin execution to one machine; other machines stay listed but
      disabled with this reason. */
  lockedMachineId?: MachineId | null;
  lockedMachineReason?: string;
};

type RailRowProps = {
  icon: ReactNode;
  title: string;
  description?: string;
  selected?: boolean;
  disabled?: boolean;
  onClick?: () => void;
};

function RailRow({ icon, title, description, selected, disabled, onClick }: RailRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      {...stylex.props(styles.row, selected && styles.selectedRow, disabled && styles.disabledRow)}
    >
      <span {...stylex.props(styles.rowIcon)}>{icon}</span>
      <span {...stylex.props(styles.rowText)}>
        <span {...stylex.props(styles.rowTitle)}>{title}</span>
        {description ? <span {...stylex.props(styles.rowDescription)}>{description}</span> : null}
      </span>
      {selected ? <Check {...stylex.props(styles.rowCheck)} aria-hidden="true" /> : null}
    </button>
  );
}

function GroupTitle({ children }: { children: ReactNode }) {
  return <div {...stylex.props(styles.groupTitle)}>{children}</div>;
}

/**
 * The mobile project picker.
 *
 * Local folders live on machines, so the sheet owns BOTH the machine choice and
 * a single search across local folders and GitHub repositories. Results are
 * grouped, never split behind a type switch: one query filters both sources.
 * Selecting closes the sheet and leaves draft / run-config state untouched.
 */
export function MobileNewChatProjectSheet({
  open,
  onOpenChange,
  machines,
  selectedMachineId,
  onMachineChange,
  localProjects,
  repositories,
  groups = [],
  selection,
  onSelect,
  onAddLocalProject,
  onConnectGitHub,
  lockedMachineId = null,
  lockedMachineReason,
}: MobileNewChatProjectSheetProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [machineOpen, setMachineOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const keyboard = useKeyboardAwareSheet({ chromeHeight: '12rem', bodyPadding: '8px' });

  useEffect(() => {
    if (!open) {
      setQuery('');
      setMachineOpen(false);
      return undefined;
    }
    /* Nested inside the new-chat drawer, its focus trap can win the mount
       focus. Focus on the next frame so the search keyboard is the one the
       user gets when the project sheet opens. */
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [open]);

  const selectedMachine = machines.find((machine) => machine.id === selectedMachineId) ?? null;
  const machineName = selectedMachine?.name ?? t('chat.projectPicker.noMachine', 'No machine');

  const filtered = useMemo(
    () =>
      filterMobileProjectOptions({
        folders: localProjects,
        repositories,
        groups,
        machineId: selectedMachineId,
        query,
      }),
    [groups, localProjects, query, repositories, selectedMachineId]
  );

  const close = () => onOpenChange(false);

  const selectMachine = (machine: MobileProjectMachine) => {
    if (machine.disabledReason || (lockedMachineId !== null && machine.id !== lockedMachineId))
      return;
    setMachineOpen(false);
    if (machine.id === selectedMachineId) return;
    onMachineChange(machine.id);
    if (selection.kind === 'local' && selection.machineId !== machine.id) {
      onSelect({ kind: 'none' });
    }
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange} repositionInputs={false}>
      <DrawerContent xstyle={[styles.sheet, keyboard.contentXstyle]}>
        <DrawerTitle xstyle={sheetSurface.srOnly}>
          {t('chat.projectPicker.title', 'Project')}
        </DrawerTitle>
        <DrawerDescription xstyle={sheetSurface.srOnly}>
          {t('chat.projectPicker.description', 'Choose a local folder or GitHub repository')}
        </DrawerDescription>

        <header {...stylex.props(styles.header)}>
          <h2 {...stylex.props(styles.title)}>{t('chat.projectPicker.title', 'Project')}</h2>
          <button
            type="button"
            aria-label={t('common.close', 'Close')}
            onClick={close}
            {...stylex.props(styles.closeButton)}
          >
            <X {...stylex.props(styles.glyph)} aria-hidden="true" />
          </button>
        </header>

        <div {...stylex.props(styles.inset)}>
          <button
            type="button"
            onClick={() => {
              onSelect({ kind: 'none' });
              close();
            }}
            {...stylex.props(styles.clearRow)}
          >
            <CircleSlash2 {...stylex.props(styles.hintGlyph)} aria-hidden="true" />
            <span {...stylex.props(styles.grow)}>
              {t('chat.projectPicker.clear', "Don't work in a project")}
            </span>
            {selection.kind === 'none' ? (
              <Check {...stylex.props(styles.checkGlyph)} aria-hidden="true" />
            ) : null}
          </button>

          <div {...stylex.props(styles.machineCard)}>
            <button
              type="button"
              aria-expanded={machineOpen}
              onClick={() => setMachineOpen((prev) => !prev)}
              {...stylex.props(styles.machineTrigger)}
            >
              <span {...stylex.props(styles.machineLabel)}>
                {t('chat.mobileNewChat.machineLabel', 'Machine')}
              </span>
              <Monitor {...stylex.props(styles.machineGlyph)} aria-hidden="true" />
              <span {...stylex.props(styles.truncateGrow)}>{machineName}</span>
              {lockedMachineId ? (
                <LockKeyhole
                  {...stylex.props(styles.lockedGlyph)}
                  aria-label={lockedMachineReason ?? t('chat.mobileNewChat.roleMachineLocked')}
                />
              ) : null}
              <ChevronsUpDown {...stylex.props(styles.hintGlyph)} aria-hidden="true" />
            </button>
            {machineOpen ? (
              <div {...stylex.props(styles.machineList)}>
                {machines.map((machine) => {
                  const locked = lockedMachineId !== null && machine.id !== lockedMachineId;
                  const disabledReason =
                    machine.disabledReason ??
                    (locked
                      ? (lockedMachineReason ?? t('chat.mobileNewChat.roleMachineLocked'))
                      : undefined);
                  const selected = machine.id === selectedMachineId;
                  return (
                    <button
                      key={machine.id}
                      type="button"
                      disabled={Boolean(disabledReason)}
                      onClick={() => selectMachine(machine)}
                      aria-pressed={selected}
                      {...stylex.props(
                        styles.machineRow,
                        selected && styles.selectedRow,
                        Boolean(disabledReason) && styles.disabledRow
                      )}
                    >
                      <Monitor {...stylex.props(styles.hintGlyph)} aria-hidden="true" />
                      <span {...stylex.props(styles.truncateGrow)}>{machine.name}</span>
                      {disabledReason ? (
                        <span {...stylex.props(styles.disabledReason)}>{disabledReason}</span>
                      ) : selected ? (
                        <Check {...stylex.props(styles.checkGlyph)} aria-hidden="true" />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>

          <div {...stylex.props(styles.searchWrap)}>
            <Input
              ref={searchRef}
              autoFocus
              leading={<Search {...stylex.props(styles.searchGlyph)} aria-hidden="true" />}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t(
                'chat.projectPicker.mobileSearchPlaceholder',
                'Search local folders and GitHub repos'
              )}
              aria-label={t('chat.projectPicker.searchPlaceholder', 'Search projects')}
              controlHeight="36px"
            />
          </div>
        </div>

        <div
          ref={keyboard.scrollRef}
          data-vaul-no-drag=""
          {...stylex.props(styles.body)}
          style={keyboard.scrollStyle}
        >
          {filtered.groups.length > 0 ? (
            <div>
              <GroupTitle>{t('chat.projectPicker.groups', 'Projects')}</GroupTitle>
              {filtered.groups.map((group) => (
                <RailRow
                  key={group.projectId}
                  icon={<FolderKanban {...stylex.props(styles.glyph)} aria-hidden="true" />}
                  title={group.name}
                  description={
                    group.disabledReason ??
                    [
                      group.availability,
                      t('chat.projectGroup.repoCount', '{{count}} repos', {
                        count: group.memberCount,
                      }),
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  }
                  disabled={Boolean(group.disabledReason)}
                  selected={selection.kind === 'group' && selection.projectId === group.projectId}
                  onClick={() => {
                    onSelect({ kind: 'group', projectId: group.projectId });
                    close();
                  }}
                />
              ))}
            </div>
          ) : null}

          {filtered.folders.length > 0 ? (
            <div>
              <GroupTitle>
                {t('chat.projectPicker.localOn', 'Local on {{machine}}', { machine: machineName })}
              </GroupTitle>
              {filtered.folders.map((folder) => (
                <RailRow
                  key={`${folder.machineId}:${folder.localProjectId}`}
                  icon={<FolderOpen {...stylex.props(styles.glyph)} aria-hidden="true" />}
                  title={folder.name}
                  description={folder.rootPath}
                  selected={
                    selection.kind === 'local' &&
                    selection.machineId === folder.machineId &&
                    selection.localProjectId === folder.localProjectId
                  }
                  onClick={() => {
                    onSelect({
                      kind: 'local',
                      machineId: folder.machineId,
                      localProjectId: folder.localProjectId,
                    });
                    close();
                  }}
                />
              ))}
            </div>
          ) : null}

          {filtered.repositories.length > 0 ? (
            <div>
              <GroupTitle>{t('chat.contextSwitch.github', 'GitHub')}</GroupTitle>
              {filtered.repositories.map((repo) => (
                <RailRow
                  key={repo.fullName}
                  icon={<Github {...stylex.props(styles.glyph)} aria-hidden="true" />}
                  title={repo.fullName}
                  description={repo.description}
                  selected={selection.kind === 'github' && selection.repoFullName === repo.fullName}
                  onClick={() => {
                    onSelect({ kind: 'github', repoFullName: repo.fullName });
                    close();
                  }}
                />
              ))}
            </div>
          ) : null}

          {filtered.folders.length === 0 &&
          filtered.repositories.length === 0 &&
          filtered.groups.length === 0 ? (
            <div {...stylex.props(styles.empty)}>
              {t('chat.projectPicker.emptyText', 'No projects found')}
            </div>
          ) : null}
        </div>

        <div {...stylex.props(styles.footer)}>
          <button
            type="button"
            onClick={() => {
              close();
              onAddLocalProject();
            }}
            {...stylex.props(styles.footerAction)}
          >
            <FolderPlus {...stylex.props(styles.searchGlyph)} aria-hidden="true" />
            <span>{t('chat.contextSwitch.addProject', 'Add a folder')}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              close();
              onConnectGitHub();
            }}
            {...stylex.props(styles.footerAction)}
          >
            <ArrowUpRight {...stylex.props(styles.searchGlyph)} aria-hidden="true" />
            <span>{t('repos.connectMore', 'Connect more GitHub projects')}</span>
          </button>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

const styles = stylex.create({
  row: {
    display: 'flex',
    width: '100%',
    minWidth: 0,
    alignItems: 'flex-start',
    gap: '12px',
    borderRadius: 'var(--radius-lg)',
    paddingInline: '8px',
    paddingBlock: '10px',
    textAlign: 'left',
    transitionProperty:
      'color,background-color,border-color,outline-color,text-decoration-color,fill,stroke',
    transitionDuration: '150ms',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
    backgroundColor: {
      default: 'transparent',
      ':active': `color-mix(in oklab,${themeColors.muted} 70%,transparent)`,
      '@media (hover:hover)': {
        ':hover': `color-mix(in oklab,${themeColors.muted} 50%,transparent)`,
      },
    },
  },
  selectedRow: {
    backgroundColor: {
      default: `color-mix(in oklab,${themeColors.muted} 60%,transparent)`,
      ':active': `color-mix(in oklab,${themeColors.muted} 70%,transparent)`,
      '@media (hover:hover)': {
        ':hover': `color-mix(in oklab,${themeColors.muted} 50%,transparent)`,
      },
    },
  },
  disabledRow: { cursor: 'not-allowed', opacity: control.disabledOpacity },
  rowIcon: {
    marginTop: '2px',
    display: 'flex',
    height: '20px',
    width: '20px',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    color: `color-mix(in oklab,${themeColors.foreground} 75%,transparent)`,
  },
  rowText: { display: 'flex', minWidth: 0, flex: '1 1 0%', flexDirection: 'column', gap: '2px' },
  rowTitle: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '15px',
    lineHeight: '20px',
    color: themeColors.foreground,
  },
  rowDescription: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '12px',
    lineHeight: '16px',
    color: themeColors.mutedForeground,
  },
  rowCheck: {
    marginTop: '2px',
    width: '16px',
    height: '16px',
    flexShrink: 0,
    color: themeColors.primary,
  },
  groupTitle: {
    paddingInline: '8px',
    paddingBottom: '4px',
    paddingTop: '12px',
    fontSize: '10px',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: themeColors.mutedForeground,
  },
  sheet: {
    height: 'calc(90dvh - var(--native-keyboard-height,0px))',
    maxHeight: 'calc(90dvh - var(--native-keyboard-height,0px))',
    borderTopLeftRadius: 'var(--radius-2xl)',
    borderTopRightRadius: 'var(--radius-2xl)',
    borderColor: `color-mix(in oklab,${themeColors.border} 60%,transparent)`,
  },
  header: {
    position: 'relative',
    display: 'flex',
    height: '48px',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingInline: '48px',
  },
  title: { userSelect: 'none', fontSize: '17px', fontWeight: 600, lineHeight: '24px' },
  closeButton: {
    position: 'absolute',
    right: '12px',
    top: '6px',
    display: 'flex',
    height: '32px',
    width: '32px',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '9999px',
    backgroundColor: {
      default: `color-mix(in oklab,${themeColors.muted} 60%,transparent)`,
      '@media (hover:hover)': { ':hover': themeColors.muted },
    },
    color: `color-mix(in oklab,${themeColors.foreground} 75%,transparent)`,
    transitionProperty:
      'color,background-color,border-color,outline-color,text-decoration-color,fill,stroke',
    transitionDuration: '150ms',
  },
  glyph: { width: '16px', height: '16px' },
  inset: { flexShrink: 0, paddingInline: '16px' },
  hintGlyph: { width: '16px', height: '16px', flexShrink: 0, color: themeColors.mutedForeground },
  grow: { flex: '1 1 0%' },
  checkGlyph: { width: '16px', height: '16px', flexShrink: 0, color: themeColors.primary },
  machineCard: {
    overflow: 'hidden',
    borderRadius: 'var(--radius-xl)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: `color-mix(in oklab,${themeColors.border} 60%,transparent)`,
    backgroundColor: themeColors.card,
  },
  machineTrigger: {
    display: 'flex',
    height: '44px',
    width: '100%',
    alignItems: 'center',
    gap: '10px',
    paddingInline: '12px',
    textAlign: 'left',
    fontSize: '14px',
    lineHeight: '20px',
  },
  machineLabel: {
    width: '56px',
    flexShrink: 0,
    fontSize: '12px',
    lineHeight: '16px',
    fontWeight: 600,
    color: themeColors.mutedForeground,
  },
  machineGlyph: {
    width: '16px',
    height: '16px',
    flexShrink: 0,
    color: `color-mix(in oklab,${themeColors.foreground} 70%,transparent)`,
  },
  truncateGrow: {
    minWidth: 0,
    flex: '1 1 0%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  lockedGlyph: { width: '14px', height: '14px', flexShrink: 0, color: themeColors.mutedForeground },
  machineList: {
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: `color-mix(in oklab,${themeColors.border} 60%,transparent)`,
    padding: '4px',
  },
  disabledReason: { flexShrink: 0, fontSize: '10px', color: themeColors.mutedForeground },
  searchWrap: { paddingTop: '10px' },
  searchGlyph: { width: '16px', height: '16px', color: themeColors.mutedForeground },
  body: {
    minHeight: 0,
    flex: '1 1 0%',
    overflowY: 'auto',
    paddingInline: '16px',
    paddingBottom: '8px',
  },
  empty: {
    paddingInline: '8px',
    paddingBlock: '40px',
    textAlign: 'center',
    fontSize: '14px',
    lineHeight: '20px',
    color: themeColors.mutedForeground,
  },
  footer: {
    flexShrink: 0,
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: `color-mix(in oklab,${themeColors.border} 60%,transparent)`,
    paddingInline: '12px',
    paddingBlock: '6px',
  },
  clearRow: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    gap: '12px',
    borderRadius: 'var(--radius-lg)',
    paddingInline: '8px',
    paddingBlock: '10px',
    textAlign: 'left',
    fontSize: '15px',
    transitionProperty:
      'color,background-color,border-color,outline-color,text-decoration-color,fill,stroke',
    transitionDuration: '150ms',
    backgroundColor: {
      default: 'transparent',
      ':active': `color-mix(in oklab,${themeColors.muted} 70%,transparent)`,
      '@media (hover:hover)': {
        ':hover': `color-mix(in oklab,${themeColors.muted} 50%,transparent)`,
      },
    },
  },
  machineRow: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    gap: '10px',
    borderRadius: 'var(--radius-lg)',
    paddingInline: '10px',
    paddingBlock: '8px',
    textAlign: 'left',
    fontSize: '14px',
    lineHeight: '20px',
    backgroundColor: {
      default: 'transparent',
      ':active': `color-mix(in oklab,${themeColors.muted} 70%,transparent)`,
      '@media (hover:hover)': {
        ':hover': `color-mix(in oklab,${themeColors.muted} 50%,transparent)`,
      },
    },
  },
  footerAction: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    gap: '10px',
    borderRadius: 'var(--radius-lg)',
    paddingInline: '8px',
    paddingBlock: '10px',
    textAlign: 'left',
    fontSize: '14px',
    lineHeight: '20px',
    backgroundColor: {
      default: 'transparent',
      ':active': `color-mix(in oklab,${themeColors.muted} 70%,transparent)`,
      '@media (hover:hover)': {
        ':hover': `color-mix(in oklab,${themeColors.muted} 50%,transparent)`,
      },
    },
  },
});
