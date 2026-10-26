import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  ChevronRight,
  Folder,
  FolderGit2,
  FolderSearch,
  Github,
  Laptop,
  Search,
  X,
} from 'lucide-react';
import type { MachineId } from '@lody/shared';
import {
  addProjectGroupMember,
  getProjectGroupLocalMachineId,
  getProjectMemberSourceKey,
  removeProjectGroupMember,
  retainProjectGroupScope,
  suggestProjectGroupName,
  type ProjectGroupFormValidation,
  type ProjectGroupFormValue,
  type ProjectGroupMemberDraft,
  type ProjectGroupMemberError,
  type ProjectGroupScope,
} from '@/lib/project-group-form';
import type { ProjectMemberSourceOption } from '@/lib/project-member-sources';
import { withClassName } from '@/lib/stylex';
import { Badge } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { Checkbox } from '@lody/ui/checkbox';
import { Dialog } from '@lody/ui/dialog';
import { Input } from '@lody/ui/input';
import { Spinner } from '@lody/ui/spinner';
import { Tabs } from '@lody/ui/tabs';
import { Textarea } from '@lody/ui/textarea';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, duration, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { settingsRecordsCard } from './compact-layout';
import { FormMessage, Section } from './form-primitives';
import { settingsCatalog as catalog, settingsSurface as surface } from './surface';

/** A long GitHub list is searched, not scrolled: past this, rows wait for a query. */
const MAX_LISTED_REPOSITORIES = 60;

export type ProjectCreateWizardStep = 'kind' | 'machine' | 'sources' | 'details';

export type ProjectCreateWizardMachine = { id: MachineId; name: string; online: boolean };

export type ProjectCreateWizardProps = {
  value: ProjectGroupFormValue;
  onChange: (value: ProjectGroupFormValue) => void;
  sources: readonly ProjectMemberSourceOption[];
  /** Every machine whose folders the user may put in a project. */
  machines: readonly ProjectCreateWizardMachine[];
  currentMachineId: MachineId | null;
  labelOf: (member: ProjectGroupMemberDraft) => string;
  detailOf: (member: ProjectGroupMemberDraft) => string | undefined;
  validation: ProjectGroupFormValidation;
  /** A machine whose folders can be browsed directly, without adding them first. */
  canBrowseFolders?: (machineId: MachineId) => boolean;
  onBrowseFolders?: (machineId: MachineId) => void;
  submitting?: boolean;
  error?: string;
  /** Stories start part-way through; the product starts from the draft. */
  initialStep?: ProjectCreateWizardStep;
  onSubmit: () => void;
  onCancel: () => void;
};

const styles = stylex.create({
  progress: { display: 'flex', gap: space[1], paddingTop: space[2] },
  progressStep: {
    flexGrow: 1,
    height: '3px',
    borderRadius: radius.full,
    backgroundColor: colors.separator,
    transitionProperty: 'background-color',
    transitionDuration: duration.regular,
  },
  progressStepDone: { backgroundColor: colors.accent },
  choices: { display: 'flex', flexDirection: 'column', gap: space[2] },
  choice: {
    display: 'flex',
    alignItems: 'center',
    gap: space[3],
    width: '100%',
    margin: 0,
    paddingBlock: space[3],
    paddingInline: space[3],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: colors.separator,
    borderRadius: radius.large,
    cornerShape: corner.shape,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    color: colors.label,
    fontFamily: 'inherit',
    textAlign: 'start',
    cursor: { default: 'pointer', ':disabled': 'default' },
    opacity: { default: 1, ':disabled': 0.5 },
    outlineStyle: 'none',
    boxShadow: {
      default: null,
      ':focus-visible': `0 0 0 2px ${colors.accent}`,
    },
    transitionProperty: 'background-color',
    transitionDuration: duration.fast,
  },
  choiceSelected: {
    borderColor: colors.accent,
    backgroundColor: `color-mix(in oklab, transparent, ${colors.accent} 6%)`,
  },
  choiceIcon: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    width: '36px',
    height: '36px',
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    backgroundColor: `color-mix(in oklab, transparent, ${colors.label} 6%)`,
    color: colors.secondaryLabel,
  },
  choiceBody: { display: 'flex', flexDirection: 'column', flexGrow: 1, gap: '3px', minWidth: 0 },
  choiceTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    fontSize: text.subheadlineSize,
    fontWeight: 500,
    color: colors.label,
  },
  choiceText: { fontSize: text.footnoteSize, lineHeight: 1.45, color: colors.secondaryLabel },
  choiceChevron: { flexShrink: 0, width: '16px', height: '16px', color: colors.tertiaryLabel },
  dot: { flexShrink: 0, width: '6px', height: '6px', borderRadius: radius.full },
  dotOnline: { backgroundColor: colors.success },
  dotOffline: { backgroundColor: colors.tertiaryLabel },
  toolbar: { display: 'flex', alignItems: 'center', gap: space[2], minWidth: 0 },
  grow: { flexGrow: 1, minWidth: 0 },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minWidth: 0,
    paddingBlock: space[2],
    paddingInline: space[3],
    cursor: 'pointer',
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
  },
  rowStatic: { cursor: 'default', backgroundColor: 'transparent' },
  rowBody: { display: 'flex', flexDirection: 'column', flexGrow: 1, gap: '1px', minWidth: 0 },
  rowName: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.subheadlineSize,
    color: colors.label,
  },
  rowDetail: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.footnoteSize,
    color: colors.tertiaryLabel,
  },
  empty: {
    paddingBlock: space[6],
    paddingInline: space[4],
    textAlign: 'center',
    fontSize: text.footnoteSize,
    lineHeight: 1.5,
    color: colors.secondaryLabel,
  },
  note: { margin: 0, fontSize: text.footnoteSize, lineHeight: 1.45, color: colors.secondaryLabel },
  where: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    paddingBlock: space[2],
    paddingInline: space[3],
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    backgroundColor: `color-mix(in oklab, transparent, ${colors.label} 4%)`,
    fontSize: text.footnoteSize,
    lineHeight: 1.45,
    color: colors.secondaryLabel,
  },
  footerCount: {
    alignSelf: 'center',
    marginInlineEnd: 'auto',
    fontSize: text.footnoteSize,
    color: colors.secondaryLabel,
  },
  errors: { margin: 0, paddingInlineStart: space[4], listStyleType: 'disc' },
});

/** One row of a picking list: a folder, a local copy of a repository, or a GitHub repository. */
type PickRow = {
  key: string;
  label: string;
  detail?: string;
  icon: 'folder' | 'repository' | 'github';
  selected: boolean;
  toggle: () => void;
};

function initialStepOf(value: ProjectGroupFormValue): {
  step: ProjectCreateWizardStep;
  scope: ProjectGroupScope | null;
} {
  if (value.members.length === 0) return { step: 'kind', scope: null };
  const machineId =
    getProjectGroupLocalMachineId(value) ??
    value.members.find((member) => member.directory)?.directory?.machineId;
  return {
    step: 'sources',
    scope: machineId ? { kind: 'machine', machineId } : { kind: 'github' },
  };
}

/**
 * Creating a project, one question at a time: what it holds (folders on a
 * machine, or GitHub only), which machine, which folders and repositories,
 * then its name and instructions. Answering moves on; Back revisits a
 * question, and an answer that changes drops what no longer fits.
 *
 * Presentational, like `ProjectGroupForm`: the dialog passes sources and
 * detection in and owns saving and the folder browser.
 */
export function ProjectCreateWizard({
  value,
  onChange,
  sources,
  machines,
  currentMachineId,
  labelOf,
  detailOf,
  validation,
  canBrowseFolders = () => false,
  onBrowseFolders,
  submitting = false,
  error,
  initialStep,
  onSubmit,
  onCancel,
}: ProjectCreateWizardProps) {
  const { t } = useTranslation();
  const [{ step, scope }, setState] = useState(() => {
    const initial = initialStepOf(value);
    return initialStep ? { ...initial, step: initialStep } : initial;
  });
  const go = (next: ProjectCreateWizardStep, nextScope: ProjectGroupScope | null = scope) =>
    setState({ step: next, scope: nextScope });

  const machineId = scope?.kind === 'machine' ? scope.machineId : null;
  const machine = machines.find((candidate) => candidate.id === machineId);
  const machineLabel = (id: MachineId, name?: string) =>
    id === currentMachineId
      ? t('settings.projectGroups.picker.thisMachine')
      : (name ?? machines.find((candidate) => candidate.id === id)?.name ?? id);

  const chooseScope = (next: ProjectGroupScope) => {
    const retained = retainProjectGroupScope(value, next, labelOf);
    if (retained !== value) onChange(retained);
    go('sources', next);
  };

  const steps: ProjectCreateWizardStep[] =
    scope?.kind === 'github'
      ? ['kind', 'sources', 'details']
      : ['kind', 'machine', 'sources', 'details'];
  const stepIndex = steps.indexOf(step);
  const back = () => {
    if (step === 'machine') go('kind');
    else if (step === 'sources') go(scope?.kind === 'machine' ? 'machine' : 'kind');
    else if (step === 'details') go('sources');
  };
  const next = () => {
    const named = suggestProjectGroupName(value, labelOf);
    if (named !== value.name) onChange({ ...value, name: named });
    go('details');
  };

  const heading = {
    kind: t('settings.projectGroups.wizard.kind.title'),
    machine: t('settings.projectGroups.wizard.machine.title'),
    sources:
      scope?.kind === 'machine'
        ? t('settings.projectGroups.wizard.sources.localTitle')
        : t('settings.projectGroups.wizard.sources.githubTitle'),
    details: t('settings.projectGroups.wizard.details.title'),
  }[step];
  const description = {
    kind: t('settings.projectGroups.wizard.kind.description'),
    machine: t('settings.projectGroups.wizard.machine.description'),
    sources:
      scope?.kind === 'machine'
        ? t('settings.projectGroups.wizard.sources.localDescription', {
            machine: machineLabel(scope.machineId, machine?.name),
          })
        : t('settings.projectGroups.wizard.sources.githubDescription'),
    details: t('settings.projectGroups.wizard.details.description'),
  }[step];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (step === 'details') onSubmit();
  };

  return (
    <form {...stylex.props(catalog.editorForm)} onSubmit={submit} inert={submitting || undefined}>
      <Dialog.Header>
        <Dialog.Title>{heading}</Dialog.Title>
        <Dialog.Description>{description}</Dialog.Description>
        <div
          {...stylex.props(styles.progress)}
          role="progressbar"
          aria-label={t('settings.projectGroups.wizard.progress', {
            step: stepIndex + 1,
            count: steps.length,
          })}
          aria-valuemin={1}
          aria-valuemax={steps.length}
          aria-valuenow={stepIndex + 1}
        >
          {steps.map((candidate, index) => (
            <span
              key={candidate}
              {...stylex.props(styles.progressStep, index <= stepIndex && styles.progressStepDone)}
            />
          ))}
        </div>
      </Dialog.Header>

      <div {...withClassName(stylex.props(catalog.editorBody), 'scrollbar-pro')}>
        {step === 'kind' ? (
          <KindStep
            scope={scope}
            hasMachines={machines.length > 0}
            onLocal={() => go('machine', scope?.kind === 'machine' ? scope : null)}
            onGithub={() => chooseScope({ kind: 'github' })}
          />
        ) : step === 'machine' ? (
          <MachineStep
            machines={machines}
            sources={sources}
            selected={machineId}
            currentMachineId={currentMachineId}
            onChoose={(id) => chooseScope({ kind: 'machine', machineId: id })}
          />
        ) : step === 'sources' && scope ? (
          <SourcesStep
            value={value}
            onChange={onChange}
            sources={sources}
            scope={scope}
            machineLabel={machineLabel(machineId ?? ('' as MachineId), machine?.name)}
            labelOf={labelOf}
            canBrowse={machineId ? canBrowseFolders(machineId) : false}
            onBrowse={machineId && onBrowseFolders ? () => onBrowseFolders(machineId) : undefined}
          />
        ) : step === 'details' ? (
          <DetailsStep
            value={value}
            onChange={onChange}
            scope={scope}
            machineLabel={machineId ? machineLabel(machineId, machine?.name) : ''}
            labelOf={labelOf}
            detailOf={detailOf}
            validation={validation}
          />
        ) : null}
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
      </div>

      <Dialog.Footer>
        {step === 'sources' ? (
          <span {...stylex.props(styles.footerCount)} aria-live="polite">
            {t('settings.projectGroups.wizard.selectedCount', { count: value.members.length })}
          </span>
        ) : null}
        {step === 'kind' ? (
          <Button type="button" variant="secondary" disabled={submitting} onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        ) : (
          <Button type="button" variant="secondary" disabled={submitting} onClick={back}>
            <ArrowLeft size={14} aria-hidden="true" />
            {t('settings.projectGroups.wizard.back')}
          </Button>
        )}
        {step === 'sources' ? (
          <Button type="button" disabled={value.members.length === 0} onClick={next}>
            {t('settings.projectGroups.wizard.next')}
          </Button>
        ) : step === 'details' ? (
          <Button type="submit" disabled={submitting || !validation.valid}>
            {submitting ? <Spinner size="small" aria-hidden="true" /> : null}
            {t('settings.projectGroups.form.create')}
          </Button>
        ) : null}
      </Dialog.Footer>
    </form>
  );
}

function Choice({
  icon,
  title,
  badge,
  children,
  selected,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  title: ReactNode;
  badge?: ReactNode;
  children?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={selected || undefined}
      onClick={onClick}
      {...stylex.props(styles.choice, selected && styles.choiceSelected)}
    >
      <span {...stylex.props(styles.choiceIcon)}>{icon}</span>
      <span {...stylex.props(styles.choiceBody)}>
        <span {...stylex.props(styles.choiceTitle)}>
          {title}
          {badge}
        </span>
        {children ? <span {...stylex.props(styles.choiceText)}>{children}</span> : null}
      </span>
      <ChevronRight aria-hidden="true" {...stylex.props(styles.choiceChevron)} />
    </button>
  );
}

function KindStep({
  scope,
  hasMachines,
  onLocal,
  onGithub,
}: {
  scope: ProjectGroupScope | null;
  hasMachines: boolean;
  onLocal: () => void;
  onGithub: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div {...stylex.props(styles.choices)}>
      <Choice
        icon={<Laptop size={18} aria-hidden="true" />}
        title={t('settings.projectGroups.wizard.kind.local')}
        selected={scope?.kind === 'machine'}
        disabled={!hasMachines}
        onClick={onLocal}
      >
        {hasMachines
          ? t('settings.projectGroups.wizard.kind.localHint')
          : t('settings.projectGroups.wizard.kind.noMachines')}
      </Choice>
      <Choice
        icon={<Github size={18} aria-hidden="true" />}
        title={t('settings.projectGroups.wizard.kind.github')}
        selected={scope?.kind === 'github'}
        onClick={onGithub}
      >
        {t('settings.projectGroups.wizard.kind.githubHint')}
      </Choice>
    </div>
  );
}

function MachineStep({
  machines,
  sources,
  selected,
  currentMachineId,
  onChoose,
}: {
  machines: readonly ProjectCreateWizardMachine[];
  sources: readonly ProjectMemberSourceOption[];
  selected: MachineId | null;
  currentMachineId: MachineId | null;
  onChoose: (machineId: MachineId) => void;
}) {
  const { t } = useTranslation();
  const counts = useMemo(() => {
    const byMachine = new Map<MachineId, number>();
    for (const option of sources) {
      for (const copy of option.copies) {
        byMachine.set(copy.machineId, (byMachine.get(copy.machineId) ?? 0) + 1);
      }
    }
    return byMachine;
  }, [sources]);
  const ordered = [...machines].sort((left, right) =>
    left.id === currentMachineId
      ? -1
      : right.id === currentMachineId
        ? 1
        : Number(right.online) - Number(left.online) || left.name.localeCompare(right.name)
  );
  return (
    <div {...stylex.props(styles.choices)}>
      {ordered.map((machine) => (
        <Choice
          key={machine.id}
          icon={<Laptop size={18} aria-hidden="true" />}
          title={machine.name}
          badge={
            machine.id === currentMachineId ? (
              <Badge>{t('settings.projectGroups.picker.thisMachine')}</Badge>
            ) : null
          }
          selected={selected === machine.id}
          onClick={() => onChoose(machine.id)}
        >
          <span {...stylex.props(styles.toolbar)}>
            <span
              aria-hidden="true"
              {...stylex.props(styles.dot, machine.online ? styles.dotOnline : styles.dotOffline)}
            />
            {machine.online
              ? t('settings.projectGroups.wizard.machine.online')
              : t('settings.projectGroups.wizard.machine.offline')}
            {' · '}
            {t('settings.projectGroups.wizard.machine.folders', {
              count: counts.get(machine.id) ?? 0,
            })}
          </span>
        </Choice>
      ))}
    </div>
  );
}

function SourcesStep({
  value,
  onChange,
  sources,
  scope,
  machineLabel,
  labelOf,
  canBrowse,
  onBrowse,
}: {
  value: ProjectGroupFormValue;
  onChange: (value: ProjectGroupFormValue) => void;
  sources: readonly ProjectMemberSourceOption[];
  scope: ProjectGroupScope;
  machineLabel: string;
  labelOf: (member: ProjectGroupMemberDraft) => string;
  canBrowse: boolean;
  onBrowse?: () => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'folders' | 'github'>(
    scope.kind === 'machine' ? 'folders' : 'github'
  );
  const [query, setQuery] = useState('');

  const selectedKeys = new Set(
    value.members.map((member) => getProjectMemberSourceKey(member.source))
  );
  const toggleOption = (option: ProjectMemberSourceOption) => () => {
    const member = value.members.find(
      (candidate) => getProjectMemberSourceKey(candidate.source) === option.key
    );
    onChange(
      member
        ? removeProjectGroupMember(value, member.id, labelOf)
        : addProjectGroupMember(value, option.source, option.label)
    );
  };

  const folderRows: PickRow[] = [];
  if (scope.kind === 'machine') {
    const listed = new Set<string>();
    for (const option of sources) {
      const copy = option.copies.find((candidate) => candidate.machineId === scope.machineId);
      if (!copy) continue;
      listed.add(option.key);
      folderRows.push({
        key: option.key,
        label:
          option.kind === 'repository'
            ? (option.label.split('/').pop() ?? option.label)
            : option.label,
        detail:
          option.kind === 'repository'
            ? [option.label, copy.rootPath].filter(Boolean).join(' · ')
            : copy.rootPath,
        icon: option.kind === 'repository' ? 'repository' : 'folder',
        selected: selectedKeys.has(option.key),
        toggle: toggleOption(option),
      });
    }
    // A folder picked from the browser is not a listed project yet; it is
    // shown, ticked, until saving registers it.
    for (const member of value.members) {
      const key = getProjectMemberSourceKey(member.source);
      if (!member.directory || member.directory.machineId !== scope.machineId || listed.has(key))
        continue;
      folderRows.unshift({
        key,
        label: labelOf(member),
        detail: member.directory.rootPath,
        icon: member.source.kind === 'github' ? 'repository' : 'folder',
        selected: true,
        toggle: () => onChange(removeProjectGroupMember(value, member.id, labelOf)),
      });
    }
  }
  // With a machine chosen, a repository it holds a copy of is one of its
  // folders; the GitHub tab lists the rest, so nothing is listed twice.
  const folderKeys = new Set(folderRows.map((row) => row.key));
  const repositoryRows: PickRow[] = sources
    .filter((option) => option.kind === 'repository' && !folderKeys.has(option.key))
    .map((option) => ({
      key: option.key,
      label: option.label,
      detail: option.description,
      icon: 'github' as const,
      selected: selectedKeys.has(option.key),
      toggle: toggleOption(option),
    }));

  const needle = query.trim().toLowerCase();
  const matches = (row: PickRow) =>
    !needle ||
    row.label.toLowerCase().includes(needle) ||
    (row.detail?.toLowerCase().includes(needle) ?? false);
  const shownFolders = folderRows.filter(matches);
  const matchingRepositories = repositoryRows.filter(matches);
  // Selected repositories always stay in view; the rest are capped.
  const shownRepositories = [
    ...matchingRepositories.filter((row) => row.selected),
    ...matchingRepositories.filter((row) => !row.selected),
  ].slice(0, Math.max(MAX_LISTED_REPOSITORIES, selectedKeys.size));
  const hiddenRepositories = matchingRepositories.length - shownRepositories.length;

  const search = (
    <div {...stylex.props(styles.toolbar)}>
      <span {...stylex.props(styles.grow)}>
        <Input
          size="small"
          leading={<Search size={14} aria-hidden="true" />}
          aria-label={t('settings.projectGroups.wizard.sources.search')}
          placeholder={t('settings.projectGroups.wizard.sources.search')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </span>
      {scope.kind === 'machine' && tab === 'folders' && onBrowse ? (
        <Button
          type="button"
          variant="secondary"
          size="small"
          disabled={!canBrowse}
          title={
            canBrowse ? undefined : t('settings.projectGroups.wizard.sources.browseUnavailable')
          }
          onClick={onBrowse}
        >
          <FolderSearch size={14} aria-hidden="true" />
          {t('settings.projectGroups.wizard.sources.browse')}
        </Button>
      ) : null}
    </div>
  );

  const folderList = (
    <PickList
      rows={shownFolders}
      empty={
        needle
          ? t('settings.projectGroups.form.noSources')
          : canBrowse
            ? t('settings.projectGroups.wizard.sources.noFoldersBrowse', { machine: machineLabel })
            : t('settings.projectGroups.wizard.sources.noFolders', { machine: machineLabel })
      }
    />
  );
  const repositoryList = (
    <>
      <PickList
        rows={shownRepositories}
        empty={
          needle
            ? t('settings.projectGroups.form.noSources')
            : t('settings.projectGroups.wizard.sources.noRepositories')
        }
      />
      {hiddenRepositories > 0 ? (
        <p {...stylex.props(styles.note)}>
          {t('settings.projectGroups.picker.hiddenRepositories', { count: hiddenRepositories })}
        </p>
      ) : null}
    </>
  );

  if (scope.kind === 'github') {
    return (
      <>
        {search}
        {repositoryList}
      </>
    );
  }
  const folderSelected = folderRows.filter((row) => row.selected).length;
  const githubSelected = value.members.length - folderSelected;
  return (
    <Tabs.Root value={tab} onValueChange={(next) => setTab(next as 'folders' | 'github')}>
      <Tabs.List size="small" stretch>
        <Tabs.Tab value="folders">
          {t('settings.projectGroups.wizard.sources.foldersTab', { machine: machineLabel })}
          {folderSelected > 0 ? <Badge>{folderSelected}</Badge> : null}
        </Tabs.Tab>
        <Tabs.Tab value="github">
          {t('settings.projectGroups.wizard.sources.githubTab')}
          {githubSelected > 0 ? <Badge>{githubSelected}</Badge> : null}
        </Tabs.Tab>
      </Tabs.List>
      {search}
      <Tabs.Panel value="folders">
        <div {...stylex.props(styles.choices)}>
          {folderList}
          <p {...stylex.props(styles.note)}>
            {t('settings.projectGroups.wizard.sources.foldersNote')}
          </p>
        </div>
      </Tabs.Panel>
      <Tabs.Panel value="github">
        <div {...stylex.props(styles.choices)}>
          {repositoryList}
          <p {...stylex.props(styles.note)}>
            {t('settings.projectGroups.wizard.sources.githubNote')}
          </p>
        </div>
      </Tabs.Panel>
    </Tabs.Root>
  );
}

function RowIcon({ icon }: { icon: PickRow['icon'] }) {
  const Icon = icon === 'folder' ? Folder : icon === 'repository' ? FolderGit2 : Github;
  return <Icon aria-hidden="true" {...stylex.props(catalog.icon)} />;
}

function PickList({ rows, empty }: { rows: readonly PickRow[]; empty: string }) {
  if (rows.length === 0)
    return (
      <div {...stylex.props(settingsRecordsCard)}>
        <div {...stylex.props(styles.empty)}>{empty}</div>
      </div>
    );
  return (
    <div {...stylex.props(settingsRecordsCard)}>
      {rows.map((row, index) => (
        <label
          key={row.key}
          {...stylex.props(surface.line, index > 0 && surface.lineRuled, styles.row)}
        >
          <Checkbox checked={row.selected} onCheckedChange={row.toggle} aria-label={row.label} />
          <RowIcon icon={row.icon} />
          <span {...stylex.props(styles.rowBody)}>
            <span {...stylex.props(styles.rowName)}>{row.label}</span>
            {row.detail ? (
              <span {...stylex.props(styles.rowDetail)} title={row.detail}>
                {row.detail}
              </span>
            ) : null}
          </span>
        </label>
      ))}
    </div>
  );
}

function DetailsStep({
  value,
  onChange,
  scope,
  machineLabel,
  labelOf,
  detailOf,
  validation,
}: {
  value: ProjectGroupFormValue;
  onChange: (value: ProjectGroupFormValue) => void;
  scope: ProjectGroupScope | null;
  machineLabel: string;
  labelOf: (member: ProjectGroupMemberDraft) => string;
  detailOf: (member: ProjectGroupMemberDraft) => string | undefined;
  validation: ProjectGroupFormValidation;
}) {
  const { t } = useTranslation();
  const bound = getProjectGroupLocalMachineId(value) !== null;
  const errorText = (code: ProjectGroupMemberError) =>
    t(`settings.projectGroups.memberErrors.${code}`);
  return (
    <>
      <Section title={t('settings.projectGroups.form.name')}>
        <Input
          autoFocus
          autoComplete="off"
          aria-label={t('settings.projectGroups.form.name')}
          placeholder={t('settings.projectGroups.wizard.details.namePlaceholder')}
          aria-invalid={validation.errors.includes('name_required') || undefined}
          value={value.name}
          onChange={(event) => onChange({ ...value, name: event.target.value })}
        />
      </Section>

      <Section
        title={t('settings.projectGroups.wizard.details.members', { count: value.members.length })}
      >
        <div {...stylex.props(settingsRecordsCard)}>
          {value.members.map((member, index) => {
            const code = validation.memberErrors.get(member.id);
            return (
              <div
                key={member.id}
                {...stylex.props(
                  surface.line,
                  index > 0 && surface.lineRuled,
                  styles.row,
                  styles.rowStatic
                )}
              >
                <RowIcon
                  icon={
                    member.source.kind === 'local'
                      ? 'folder'
                      : member.source.preferLocal && scope?.kind === 'machine'
                        ? 'repository'
                        : 'github'
                  }
                />
                <span {...stylex.props(styles.rowBody)}>
                  <span {...stylex.props(styles.rowName)}>{labelOf(member)}</span>
                  <span {...stylex.props(styles.rowDetail)} title={detailOf(member)}>
                    {code ? errorText(code) : (detailOf(member) ?? '')}
                  </span>
                </span>
                <Badge tone={code ? 'danger' : 'neutral'}>
                  {member.source.kind === 'local'
                    ? t('settings.projectGroups.wizard.details.inPlace')
                    : member.directory || (member.source.preferLocal && scope?.kind === 'machine')
                      ? t('settings.projectGroups.wizard.details.localCopy')
                      : t('settings.projectGroups.wizard.details.worktree')}
                </Badge>
                <Button
                  type="button"
                  variant="ghost"
                  size="small"
                  icon
                  aria-label={t('settings.projectGroups.wizard.details.remove', {
                    name: labelOf(member),
                  })}
                  onClick={() => onChange(removeProjectGroupMember(value, member.id, labelOf))}
                >
                  <X {...stylex.props(catalog.icon)} />
                </Button>
              </div>
            );
          })}
        </div>
        <div {...stylex.props(styles.where)}>
          {bound ? (
            <Laptop size={14} aria-hidden="true" />
          ) : (
            <Github size={14} aria-hidden="true" />
          )}
          <span>
            {bound
              ? t('settings.projectGroups.wizard.details.runsOn', { machine: machineLabel })
              : t('settings.projectGroups.wizard.details.runsAnywhere')}
          </span>
        </div>
        {validation.memberErrors.size > 0 ? (
          <FormMessage tone="error">
            <ul {...stylex.props(styles.errors)}>
              {value.members.flatMap((member) => {
                const code = validation.memberErrors.get(member.id);
                return code
                  ? [
                      <li key={member.id}>
                        {t('settings.projectGroups.memberErrorLine', {
                          name: labelOf(member),
                          reason: errorText(code),
                        })}
                      </li>,
                    ]
                  : [];
              })}
            </ul>
          </FormMessage>
        ) : null}
      </Section>

      <Section
        title={t('settings.projectGroups.wizard.details.instructions')}
        hint={t('settings.projectGroups.form.instructionsHint')}
      >
        <Textarea
          rows={4}
          resize="none"
          aria-label={t('settings.projectGroups.form.instructions')}
          placeholder={t('settings.projectGroups.form.instructionsPlaceholder')}
          value={value.instructions}
          onChange={(event) => onChange({ ...value, instructions: event.target.value })}
        />
      </Section>
    </>
  );
}
