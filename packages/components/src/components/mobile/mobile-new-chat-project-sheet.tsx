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
import { cn } from '@/lib/utils';
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
      className={cn(
        'flex w-full min-w-0 items-start gap-3 rounded-lg px-2 py-2.5 text-left transition-colors',
        'active:bg-muted/70 hover:bg-muted/50',
        disabled && 'cursor-not-allowed opacity-50',
        selected && 'bg-muted/60'
      )}
    >
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-foreground/75">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[15px] leading-5 text-foreground">{title}</span>
        {description ? (
          <span className="truncate text-xs leading-4 text-muted-foreground">{description}</span>
        ) : null}
      </span>
      {selected ? (
        <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
      ) : null}
    </button>
  );
}

function GroupTitle({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
      {children}
    </div>
  );
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
      <DrawerContent
        className={cn(
          'h-[calc(90dvh-var(--native-keyboard-height,0px))]! max-h-[calc(90dvh-var(--native-keyboard-height,0px))]! rounded-t-2xl border-border/60',
          keyboard.contentClassName
        )}
      >
        <DrawerTitle className="sr-only">{t('chat.projectPicker.title', 'Project')}</DrawerTitle>
        <DrawerDescription className="sr-only">
          {t('chat.projectPicker.description', 'Choose a local folder or GitHub repository')}
        </DrawerDescription>

        <header className="relative flex h-12 shrink-0 items-center justify-center px-12">
          <h2 className="select-none text-[17px] font-semibold leading-6">
            {t('chat.projectPicker.title', 'Project')}
          </h2>
          <button
            type="button"
            aria-label={t('common.close', 'Close')}
            onClick={close}
            className="absolute right-3 top-1.5 flex h-8 w-8 items-center justify-center rounded-full bg-muted/60 text-foreground/75 transition-colors hover:bg-muted"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <div className="shrink-0 px-4">
          <button
            type="button"
            onClick={() => {
              onSelect({ kind: 'none' });
              close();
            }}
            className={cn(
              'flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left text-[15px]',
              'transition-colors hover:bg-muted/50 active:bg-muted/70'
            )}
          >
            <CircleSlash2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="flex-1">
              {t('chat.projectPicker.clear', "Don't work in a project")}
            </span>
            {selection.kind === 'none' ? (
              <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            ) : null}
          </button>

          <div className="overflow-hidden rounded-xl border border-border/60 bg-card">
            <button
              type="button"
              aria-expanded={machineOpen}
              onClick={() => setMachineOpen((prev) => !prev)}
              className="flex h-11 w-full items-center gap-2.5 px-3 text-left text-sm"
            >
              <span className="w-14 shrink-0 text-xs font-semibold text-muted-foreground">
                {t('chat.mobileNewChat.machineLabel', 'Machine')}
              </span>
              <Monitor className="h-4 w-4 shrink-0 text-foreground/70" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{machineName}</span>
              {lockedMachineId ? (
                <LockKeyhole
                  className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                  aria-label={lockedMachineReason ?? t('chat.mobileNewChat.roleMachineLocked')}
                />
              ) : null}
              <ChevronsUpDown
                className="h-4 w-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            </button>
            {machineOpen ? (
              <div className="border-t border-border/60 p-1">
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
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm',
                        selected && 'bg-muted/60',
                        disabledReason && 'cursor-not-allowed opacity-50',
                        !disabledReason && 'hover:bg-muted/50 active:bg-muted/70'
                      )}
                    >
                      <Monitor
                        className="h-4 w-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate">{machine.name}</span>
                      {disabledReason ? (
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {disabledReason}
                        </span>
                      ) : selected ? (
                        <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>

          <div className="pt-2.5">
            <Input
              ref={searchRef}
              autoFocus
              leading={<Search className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t(
                'chat.projectPicker.mobileSearchPlaceholder',
                'Search local folders and GitHub repos'
              )}
              aria-label={t('chat.projectPicker.searchPlaceholder', 'Search projects')}
              className="h-9"
            />
          </div>
        </div>

        <div
          ref={keyboard.scrollRef}
          data-vaul-no-drag=""
          className="min-h-0 flex-1 overflow-y-auto px-4 pb-2"
          style={keyboard.scrollStyle}
        >
          {filtered.groups.length > 0 ? (
            <div>
              <GroupTitle>{t('chat.projectPicker.groups', 'Projects')}</GroupTitle>
              {filtered.groups.map((group) => (
                <RailRow
                  key={group.projectId}
                  icon={<FolderKanban className="h-4 w-4" aria-hidden="true" />}
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
                  icon={<FolderOpen className="h-4 w-4" aria-hidden="true" />}
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
                  icon={<Github className="h-4 w-4" aria-hidden="true" />}
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
            <div className="px-2 py-10 text-center text-sm text-muted-foreground">
              {t('chat.projectPicker.emptyText', 'No projects found')}
            </div>
          ) : null}
        </div>

        <div className="shrink-0 border-t border-border/60 px-3 py-1.5">
          <button
            type="button"
            onClick={() => {
              close();
              onAddLocalProject();
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2.5 text-left text-sm hover:bg-muted/50 active:bg-muted/70"
          >
            <FolderPlus className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <span>{t('chat.contextSwitch.addProject', 'Add a folder')}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              close();
              onConnectGitHub();
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2.5 text-left text-sm hover:bg-muted/50 active:bg-muted/70"
          >
            <ArrowUpRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <span>{t('repos.connectMore', 'Connect more GitHub projects')}</span>
          </button>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
