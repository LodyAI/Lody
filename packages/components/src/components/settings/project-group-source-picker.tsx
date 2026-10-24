import { useMemo, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { Folder, FolderGit2, Github, Plus } from 'lucide-react';
import type { MachineId } from '@lody/shared';
import {
  applySourceSelection,
  getProjectGroupLocalMachineId,
  getProjectMemberSourceKey,
  type ProjectGroupFormValue,
  type ProjectGroupMemberDraft,
} from '@/lib/project-group-form';
import {
  groupProjectMemberSourceOptions,
  type ProjectMemberSourceFilter,
  type ProjectMemberSourceGroup,
  type ProjectMemberSourceOption,
} from '@/lib/project-member-sources';
import { Combobox } from '@lody/ui/combobox';
import { Toggle } from '@lody/ui/toggle';
import { ToggleGroup } from '@lody/ui/toggle-group';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { settingsCatalog as catalog } from './surface';

const ALL = 'all';
const REPOSITORIES = 'repositories';
const MAX_NAMED_MACHINES = 3;

const styles = stylex.create({
  // The list is the trigger's width, like every list in @lody/ui. Its popup
  // only sets a minimum, so whatever sits in it must not ask for more: a
  // machine name in the filter row or a long note would otherwise widen the
  // popup past the trigger. Inline-size containment keeps each of these from
  // contributing its natural width; they wrap or truncate inside the list.
  fitList: { contain: 'inline-size' },
  face: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1.5],
    color: colors.secondaryLabel,
  },
  filters: { paddingBottom: space[1.5] },
  hint: {
    paddingInline: space[2],
    paddingBottom: space[1.5],
    fontSize: text.footnoteSize,
    color: colors.secondaryLabel,
  },
  // Says once why a group's rows are limited, under its label.
  note: {
    paddingInline: space[2],
    paddingBottom: space[1],
    fontSize: text.footnoteSize,
    color: colors.tertiaryLabel,
  },
  option: { display: 'flex', alignItems: 'center', gap: space[2], minWidth: 0, width: '100%' },
  label: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  detail: {
    flexShrink: 0,
    maxWidth: '55%',
    marginInlineStart: 'auto',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.footnoteSize,
    color: colors.tertiaryLabel,
  },
});

export type ProjectGroupSourcePickerProps = {
  value: ProjectGroupFormValue;
  onChange: (value: ProjectGroupFormValue) => void;
  sources: readonly ProjectMemberSourceOption[];
  labelOf: (member: ProjectGroupMemberDraft) => string;
  /** The machine this device runs, named "This machine". */
  currentMachineId: MachineId | null;
};

/**
 * The one multi-select that adds and removes a group's repositories.
 *
 * A repository is one row however many machines hold it; folders that exist on
 * one machine only are listed apart, because choosing one decides where the
 * group's conversations run. A filter row narrows the list to one machine.
 */
export function ProjectGroupSourcePicker({
  value,
  onChange,
  sources,
  labelOf,
  currentMachineId,
}: ProjectGroupSourcePickerProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [filterValue, setFilterValue] = useState<string>(ALL);

  const selectedKeys = useMemo(
    () => new Set(value.members.map((member) => getProjectMemberSourceKey(member.source))),
    [value.members]
  );
  const selectedSources = useMemo(
    () => sources.filter((option) => selectedKeys.has(option.key)),
    [selectedKeys, sources]
  );
  const { machineName, machinesOf } = useProjectMemberSourceNames(sources, currentMachineId);

  const filter: ProjectMemberSourceFilter =
    filterValue === ALL
      ? { kind: 'all' }
      : filterValue === REPOSITORIES
        ? { kind: 'repositories' }
        : { kind: 'machine', machineId: filterValue as MachineId };
  const boundMachineId = getProjectGroupLocalMachineId(value);
  const layout = groupProjectMemberSourceOptions({
    options: sources,
    selectedKeys,
    query,
    filter,
    currentMachineId,
    boundMachineId,
  });

  const groupLabel = (group: ProjectMemberSourceGroup) =>
    group.kind === 'repositories'
      ? t('settings.projectGroups.picker.repositories')
      : group.kind === 'here'
        ? t('settings.projectGroups.picker.here')
        : group.kind === 'machine'
          ? t('settings.projectGroups.picker.machineFolders')
          : currentMachineId
            ? t('settings.projectGroups.picker.elsewhere')
            : t('settings.projectGroups.picker.folders');
  const groupNote = (group: ProjectMemberSourceGroup) =>
    group.kind === 'repositories'
      ? null
      : group.blockedBy
        ? group.blockedBy === currentMachineId
          ? t('settings.projectGroups.picker.blockedHere')
          : t('settings.projectGroups.picker.blocked', { machine: machineName(group.blockedBy) })
        : boundMachineId
          ? null
          : t('settings.projectGroups.picker.binds');
  const optionDetail = (option: ProjectMemberSourceOption, group: ProjectMemberSourceGroup) =>
    option.kind === 'directory'
      ? group.kind === 'here'
        ? null
        : machineName(option.copies[0]!.machineId)
      : machinesOf(option);

  return (
    <Combobox.Root
      multiple
      items={layout.groups}
      value={selectedSources}
      inputValue={query}
      onInputValueChange={setQuery}
      itemToStringLabel={(option: ProjectMemberSourceOption) => option.label}
      isItemEqualToValue={(left: ProjectMemberSourceOption, right: ProjectMemberSourceOption) =>
        left.key === right.key
      }
      onValueChange={(next: ProjectMemberSourceOption[]) =>
        onChange(applySourceSelection(value, selectedSources, next, labelOf))
      }
    >
      <Combobox.Button size="small" aria-label={t('settings.projectGroups.form.add')}>
        {/* The face always reads as the action; the ticks inside say what is
            already in the group. */}
        {() => (
          <span {...stylex.props(styles.face)}>
            <Plus aria-hidden="true" {...stylex.props(catalog.icon)} />
            {t('settings.projectGroups.form.add')}
          </span>
        )}
      </Combobox.Button>
      <Combobox.Content
        search={
          <div>
            <Combobox.Search
              aria-label={t('settings.projectGroups.form.search')}
              placeholder={t('settings.projectGroups.form.search')}
            />
            {layout.machineIds.length > 1 ? (
              <div {...stylex.props(styles.fitList, styles.filters)}>
                <ToggleGroup
                  size="mini"
                  shape="pill"
                  wrap
                  aria-label={t('settings.projectGroups.picker.filter')}
                  value={[filterValue]}
                  onValueChange={(next) => setFilterValue(next[0] ?? ALL)}
                >
                  <Toggle value={ALL}>{t('settings.projectGroups.picker.all')}</Toggle>
                  <Toggle value={REPOSITORIES}>
                    {t('settings.projectGroups.picker.repositoriesFilter')}
                  </Toggle>
                  {layout.machineIds.map((machineId) => (
                    <Toggle key={machineId} value={machineId}>
                      {machineName(machineId)}
                    </Toggle>
                  ))}
                </ToggleGroup>
              </div>
            ) : null}
            {layout.hiddenRepositoryCount > 0 ? (
              <div {...stylex.props(styles.fitList, styles.hint)}>
                {t('settings.projectGroups.picker.hiddenRepositories', {
                  count: layout.hiddenRepositoryCount,
                })}
              </div>
            ) : null}
          </div>
        }
        empty={<Combobox.Empty>{t('settings.projectGroups.form.noSources')}</Combobox.Empty>}
      >
        {(group: ProjectMemberSourceGroup) => {
          const note = groupNote(group);
          return (
            <Combobox.Group key={group.key} items={group.items}>
              <Combobox.GroupLabel>{groupLabel(group)}</Combobox.GroupLabel>
              {note ? <div {...stylex.props(styles.fitList, styles.note)}>{note}</div> : null}
              {group.items.map((option) => {
                const Icon =
                  option.kind === 'directory'
                    ? Folder
                    : option.copies.length > 0
                      ? FolderGit2
                      : Github;
                const detail = optionDetail(option, group);
                return (
                  <Combobox.Item
                    key={option.key}
                    value={option}
                    disabled={layout.disabledKeys.has(option.key)}
                  >
                    <span {...stylex.props(styles.fitList, styles.option)}>
                      <Icon aria-hidden="true" {...stylex.props(catalog.icon)} />
                      <span {...stylex.props(styles.label)}>{option.label}</span>
                      {detail ? (
                        <span {...stylex.props(styles.detail)} title={detail}>
                          {detail}
                        </span>
                      ) : null}
                    </span>
                  </Combobox.Item>
                );
              })}
            </Combobox.Group>
          );
        }}
      </Combobox.Content>
    </Combobox.Root>
  );
}

/**
 * How the editor names machines and where a repository can run: this
 * machine is "This machine" and comes first, a repository lists the machines
 * holding a copy (a few by name, then a count), and one only on GitHub says so.
 */
export function useProjectMemberSourceNames(
  sources: readonly ProjectMemberSourceOption[],
  currentMachineId: MachineId | null
) {
  const { t } = useTranslation();
  const machineNames = useMemo(() => {
    const names = new Map<MachineId, string>();
    for (const option of sources) {
      for (const copy of option.copies) names.set(copy.machineId, copy.machineName);
    }
    return names;
  }, [sources]);
  const machineName = (machineId: MachineId) =>
    machineId === currentMachineId
      ? t('settings.projectGroups.picker.thisMachine')
      : (machineNames.get(machineId) ?? machineId);
  const machinesOf = (option: Pick<ProjectMemberSourceOption, 'copies'>) => {
    if (option.copies.length === 0) return t('settings.projectGroups.picker.githubOnly');
    const names = [...option.copies]
      .sort((left, right) =>
        left.machineId === currentMachineId ? -1 : right.machineId === currentMachineId ? 1 : 0
      )
      .map((copy) => machineName(copy.machineId));
    const shown = names.slice(0, MAX_NAMED_MACHINES).join(' · ');
    return names.length > MAX_NAMED_MACHINES
      ? t('settings.projectGroups.picker.moreMachines', {
          machines: shown,
          count: names.length - MAX_NAMED_MACHINES,
        })
      : shown;
  };
  return { machineName, machinesOf };
}
