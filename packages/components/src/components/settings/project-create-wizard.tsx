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
import type { MachineId, ProjectMemberSource } from '@lody/shared';
import {
  addProjectGroupMember,
  getProjectGroupLocalMachineId,
  getProjectMemberSourceKey,
  removeProjectGroupMember,
  retainProjectGroupScope,
  bindProjectGroupToMachine,
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
import { colors, shadow, sheen } from '@lody/ui/tokens/colors.stylex';
import { corner, duration, ease, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { settingsRecordsCard } from './compact-layout';
import { FormMessage, Section } from './form-primitives';
import { settingsCatalog as catalog, settingsSurface as surface } from './surface';

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
  /** Editing marks the project's current answers and saves rather than creates. */
  mode?: 'create' | 'edit';
  onSubmit: () => void;
  /**
   * A new project of one folder or repository is not a project of several:
   * the dialog makes that one an ordinary project instead, with no name step.
   */
  onFinishSingle?: (value: ProjectGroupFormValue) => void;
  /** Other projects' names, normalized; a project's name must be its own. */
  takenNames?: ReadonlySet<string>;
  onCancel: () => void;
};

const styles = stylex.create({
  // Progress is a value, so it sits in the recessed well every value holder
  // takes, filled with ink the way a checked box is.
  progressRow: { display: 'flex', alignItems: 'center', gap: space[3], paddingTop: space[3] },
  progressTrack: {
    flexGrow: 1,
    height: '6px',
    overflow: 'hidden',
    borderRadius: radius.full,
    backgroundColor: colors.wellBackground,
    boxShadow: shadow.inset,
  },
  progressFill: (fraction: number) => ({ width: `${fraction * 100}%` }),
  progressInk: {
    height: '100%',
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    backgroundImage: sheen.ink,
    boxShadow: shadow.inkEdge,
    transitionProperty: 'width',
    transitionDuration: duration.regular,
    transitionTimingFunction: ease.standard,
  },
  progressText: {
    flexShrink: 0,
    fontSize: text.footnoteSize,
    color: colors.secondaryLabel,
    fontVariantNumeric: 'tabular-nums',
  },
  choices: { display: 'flex', flexDirection: 'column', gap: space[2] },
  stack: { display: 'flex', flexDirection: 'column', gap: space[2] },
  // An answer is a raised card that goes down when pressed, the way a
  // secondary button does: lit from above, a contact shadow, no outline.
  choice: {
    display: 'flex',
    alignItems: 'center',
    gap: space[3],
    width: '100%',
    margin: 0,
    paddingBlock: space[3],
    paddingInline: space[3],
    borderWidth: 0,
    borderStyle: 'none',
    borderRadius: radius.large,
    cornerShape: corner.shape,
    backgroundColor: {
      default: colors.raisedBackground,
      ':hover': `color-mix(in oklab, ${colors.raisedBackground}, ${colors.label} 3%)`,
    },
    backgroundImage: { default: sheen.raised, ':active': 'none' },
    boxShadow: {
      default: shadow.raised,
      ':focus-visible': `0 0 0 2px ${colors.accent}, ${shadow.raised}`,
      ':active': shadow.inset,
    },
    transform: { default: null, ':active': 'translateY(1px)' },
    color: colors.label,
    fontFamily: 'inherit',
    textAlign: 'start',
    cursor: { default: 'pointer', ':disabled': 'default' },
    opacity: { default: 1, ':disabled': 0.5 },
    outlineStyle: 'none',
    transitionProperty: 'background-color, box-shadow, transform',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  choiceSelected: {
    boxShadow: {
      default: `0 0 0 1.5px ${colors.accent}, ${shadow.raised}`,
      ':active': shadow.inset,
    },
  },
  // The glyph stands on its own small raised tile, a step off the card.
  choiceIcon: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    width: '38px',
    height: '38px',
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    backgroundColor: colors.background,
    backgroundImage: sheen.raised,
    boxShadow: shadow.raised,
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
  footerCount: {
    alignSelf: 'center',
    marginInlineEnd: 'auto',
    fontSize: text.footnoteSize,
    color: colors.secondaryLabel,
  },
  errors: { margin: 0, paddingInlineStart: space[4], listStyleType: 'disc' },
  // A records card clips its rows (`overflow: hidden`), so in the scrolling
  // column it would shrink to fit and hide the rest instead of scrolling.
  fullHeight: { flexShrink: 0 },
});

/** One row of a picking list: a folder, a local copy of a repository, or a GitHub repository. */
type PickRow = {
  key: string;
  label: string;
  detail?: string;
  icon: 'folder' | 'repository' | 'github';
  /** Part of the project before this edit. */
  previous?: boolean;
  selected: boolean;
  toggle: () => void;
};

const sourceKey = getProjectMemberSourceKey;
const keyOf = (member: ProjectGroupMemberDraft) => sourceKey(member.source);

type MemberUsage = 'inPlace' | 'localCopy' | 'worktree';

/** How a member is used: in place, a machine's copy, or a fresh clone. */
const usageOf = (member: ProjectGroupMemberDraft): MemberUsage =>
  member.source.kind === 'local' ? 'inPlace' : member.source.preferLocal ? 'localCopy' : 'worktree';

/**
 * The scope a draft already implies. A folder decides it; a repository that
 * uses a local copy names the machine holding one, this machine first. A
 * draft of plain clones runs anywhere.
 */
function scopeOf(
  value: ProjectGroupFormValue,
  sources: readonly ProjectMemberSourceOption[],
  currentMachineId: MachineId | null
): ProjectGroupScope | null {
  if (value.members.length === 0) return null;
  const machineId =
    getProjectGroupLocalMachineId(value) ??
    value.members.find((member) => member.directory)?.directory?.machineId;
  if (machineId) return { kind: 'machine', machineId };
  const copyKeys = new Set(
    value.members.filter((member) => usageOf(member) === 'localCopy').map(keyOf)
  );
  const copies = sources.filter((option) => copyKeys.has(option.key)).flatMap((o) => o.copies);
  const copy = copies.find((candidate) => candidate.machineId === currentMachineId) ?? copies[0];
  return copy ? { kind: 'machine', machineId: copy.machineId } : { kind: 'github' };
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
  mode = 'create',
  onSubmit,
  onFinishSingle,
  takenNames,
  onCancel,
}: ProjectCreateWizardProps) {
  const { t } = useTranslation();
  // A new draft that already has members (a seed) opens on them; an edit walks
  // the questions again from the start, its earlier answers marked.
  const [previous] = useState(() =>
    mode === 'edit'
      ? {
          scope: scopeOf(value, sources, currentMachineId),
          usage: new Map<string, MemberUsage>(
            value.members.map((member) => [keyOf(member), usageOf(member)])
          ),
        }
      : null
  );
  const [{ step, scope }, setState] = useState(() => {
    const initialScope = scopeOf(value, sources, currentMachineId);
    const defaultStep: ProjectCreateWizardStep =
      mode === 'create' && initialScope ? 'sources' : 'kind';
    return { step: initialStep ?? defaultStep, scope: initialScope };
  });
  // Repositories ticked in both tabs: one member, cloned from GitHub. The
  // folder tick is remembered so either tab can be unticked on its own.
  const [alsoFolder, setAlsoFolder] = useState<ReadonlySet<string>>(() => new Set());
  const go = (next: ProjectCreateWizardStep, nextScope: ProjectGroupScope | null = scope) =>
    setState({ step: next, scope: nextScope });

  const machineId = scope?.kind === 'machine' ? scope.machineId : null;
  const machineLabel = (id: MachineId | null) =>
    !id
      ? ''
      : id === currentMachineId
        ? t('settings.projectGroups.picker.thisMachine')
        : (machines.find((candidate) => candidate.id === id)?.name ?? id);

  // Folders from the chosen machine bind the project to it.
  const fitScope = (draft: ProjectGroupFormValue, target: ProjectGroupScope) => {
    const retained = retainProjectGroupScope(draft, target, labelOf);
    if (target.kind !== 'machine') return retained;
    return bindProjectGroupToMachine(
      retained,
      target.machineId,
      (repoFullName) =>
        sources
          .find((option) => option.key === `github:${repoFullName.toLowerCase()}`)
          ?.copies.find((copy) => copy.machineId === target.machineId)?.localProjectId
    );
  };
  const chooseScope = (next: ProjectGroupScope) => {
    const retained = fitScope(value, next);
    if (retained !== value) onChange(retained);
    setAlsoFolder(new Set());
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
  // Creating with one item finishes here: it stays an ordinary project.
  const single = mode === 'create' && value.members.length === 1 && onFinishSingle !== undefined;
  const finishSingle = () => onFinishSingle?.(scope ? fitScope(value, scope) : value);
  const next = () => {
    let draft = scope ? fitScope(value, scope) : value;
    const named = suggestProjectGroupName(draft, labelOf, takenNames);
    if (named !== draft.name) draft = { ...draft, name: named };
    if (draft !== value) onChange(draft);
    go('details');
  };

  // Clones whose folder on this machine is ticked as well.
  const doubled = value.members.filter(
    (member) =>
      usageOf(member) === 'worktree' &&
      sources
        .find((option) => option.key === keyOf(member))
        ?.copies.some(
          (copy) =>
            copy.machineId === machineId &&
            alsoFolder.has(
              getProjectMemberSourceKey({
                kind: 'local',
                machineId: copy.machineId,
                localProjectId: copy.localProjectId,
              })
            )
        )
  );
  const doubleNotice =
    doubled.length > 0 ? (
      <FormMessage tone="warning">
        {t('settings.projectGroups.wizard.sources.bothSelected', {
          names: doubled.map(labelOf).join('、'),
          machine: machineLabel(machineId),
          count: doubled.length,
        })}
      </FormMessage>
    ) : null;

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
            machine: machineLabel(scope.machineId),
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
        <div {...stylex.props(styles.progressRow)}>
          <div
            {...stylex.props(styles.progressTrack)}
            role="progressbar"
            aria-label={t('settings.projectGroups.wizard.progress', {
              step: stepIndex + 1,
              count: steps.length,
            })}
            aria-valuemin={1}
            aria-valuemax={steps.length}
            aria-valuenow={stepIndex + 1}
          >
            <div
              {...stylex.props(
                styles.progressInk,
                styles.progressFill((stepIndex + 1) / steps.length)
              )}
            />
          </div>
          <span {...stylex.props(styles.progressText)} aria-hidden="true">
            {t('settings.projectGroups.wizard.progress', {
              step: stepIndex + 1,
              count: steps.length,
            })}
          </span>
        </div>
      </Dialog.Header>

      <div {...withClassName(stylex.props(catalog.editorBody), 'scrollbar-pro')}>
        {step === 'kind' ? (
          <KindStep
            scope={scope}
            previous={previous?.scope?.kind ?? null}
            hasMachines={machines.length > 0}
            onLocal={() => go('machine', scope?.kind === 'machine' ? scope : null)}
            onGithub={() => chooseScope({ kind: 'github' })}
          />
        ) : step === 'machine' ? (
          <MachineStep
            machines={machines}
            sources={sources}
            selected={machineId}
            previous={previous?.scope?.kind === 'machine' ? previous.scope.machineId : null}
            currentMachineId={currentMachineId}
            onChoose={(id) => chooseScope({ kind: 'machine', machineId: id })}
          />
        ) : step === 'sources' && scope ? (
          <SourcesStep
            value={value}
            onChange={onChange}
            sources={sources}
            scope={scope}
            alsoFolder={alsoFolder}
            onAlsoFolderChange={setAlsoFolder}
            previousUsage={previous?.usage}
            machineLabel={machineLabel(machineId)}
            labelOf={labelOf}
            notice={doubleNotice}
            canBrowse={machineId ? canBrowseFolders(machineId) : false}
            onBrowse={machineId && onBrowseFolders ? () => onBrowseFolders(machineId) : undefined}
          />
        ) : step === 'details' ? (
          <DetailsStep
            value={value}
            onChange={onChange}
            onRemoved={(key) => {
              if (!alsoFolder.has(key)) return;
              const remaining = new Set(alsoFolder);
              remaining.delete(key);
              setAlsoFolder(remaining);
            }}
            labelOf={labelOf}
            detailOf={detailOf}
            validation={validation}
            notice={doubleNotice}
          />
        ) : null}
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
      </div>

      <Dialog.Footer>
        {step === 'sources' ? (
          <span {...stylex.props(styles.footerCount)} aria-live="polite">
            {single
              ? t('settings.projectGroups.wizard.singleHint')
              : t('settings.projectGroups.wizard.selectedCount', { count: value.members.length })}
          </span>
        ) : null}
        {/* Keys keep each button its own element. A reused one turns from
            "Next" into the submit button inside the click that advanced, and
            the browser then submits the form: the project would be created
            without its last step. */}
        {step === 'kind' ? (
          <Button
            key="cancel"
            type="button"
            variant="secondary"
            disabled={submitting}
            onClick={onCancel}
          >
            {t('common.cancel')}
          </Button>
        ) : (
          <Button key="back" type="button" variant="secondary" disabled={submitting} onClick={back}>
            <ArrowLeft size={14} aria-hidden="true" />
            {t('settings.projectGroups.wizard.back')}
          </Button>
        )}
        {step === 'sources' && single ? (
          <Button key="finish" type="button" disabled={submitting} onClick={finishSingle}>
            {submitting ? <Spinner size="small" aria-hidden="true" /> : null}
            {t('settings.projectGroups.wizard.finish')}
          </Button>
        ) : step === 'sources' ? (
          <Button key="next" type="button" disabled={value.members.length === 0} onClick={next}>
            {t('settings.projectGroups.wizard.next')}
          </Button>
        ) : step === 'details' ? (
          <Button key="create" type="submit" disabled={submitting || !validation.valid}>
            {submitting ? <Spinner size="small" aria-hidden="true" /> : null}
            {mode === 'edit' ? t('common.save') : t('settings.projectGroups.form.create')}
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
  previous,
  hasMachines,
  onLocal,
  onGithub,
}: {
  scope: ProjectGroupScope | null;
  previous: ProjectGroupScope['kind'] | null;
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
        badge={previous === 'machine' ? <PreviousBadge /> : null}
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
        badge={previous === 'github' ? <PreviousBadge /> : null}
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
  previous,
  currentMachineId,
  onChoose,
}: {
  machines: readonly ProjectCreateWizardMachine[];
  sources: readonly ProjectMemberSourceOption[];
  selected: MachineId | null;
  previous: MachineId | null;
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
            <>
              {machine.id === currentMachineId ? (
                <Badge>{t('settings.projectGroups.picker.thisMachine')}</Badge>
              ) : null}
              {machine.id === previous ? <PreviousBadge /> : null}
            </>
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
  alsoFolder,
  onAlsoFolderChange,
  previousUsage,
  machineLabel,
  labelOf,
  notice,
  canBrowse,
  onBrowse,
}: {
  value: ProjectGroupFormValue;
  onChange: (value: ProjectGroupFormValue) => void;
  sources: readonly ProjectMemberSourceOption[];
  scope: ProjectGroupScope;
  alsoFolder: ReadonlySet<string>;
  onAlsoFolderChange: (next: ReadonlySet<string>) => void;
  /** An edited project's members as saved, keyed by source: how each was used. */
  previousUsage?: ReadonlyMap<string, MemberUsage>;
  machineLabel: string;
  labelOf: (member: ProjectGroupMemberDraft) => string;
  notice: ReactNode;
  canBrowse: boolean;
  onBrowse?: () => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'folders' | 'github'>(
    scope.kind === 'machine' ? 'folders' : 'github'
  );
  const [query, setQuery] = useState('');

  const members = new Map(value.members.map((member) => [keyOf(member), member]));
  const withKey = (key: string, add: boolean) => {
    const next = new Set(alsoFolder);
    if (add) next.add(key);
    else next.delete(key);
    onAlsoFolderChange(next);
  };
  const plain = (repoFullName: string): ProjectMemberSource => ({ kind: 'github', repoFullName });
  /** Replace one member with another source: GitHub and its folder are one repository. */
  const swap = (
    from: ProjectGroupMemberDraft,
    source: ProjectMemberSource,
    label: string
  ): ProjectGroupFormValue =>
    addProjectGroupMember(removeProjectGroupMember(value, from.id, labelOf), source, label);

  // Folders on the chosen machine, including its copies of GitHub repositories.
  // A folder joins as that machine's folder even with a GitHub remote, so the
  // project runs on that machine only; the GitHub tab is for clones.
  const folderRows: PickRow[] = [];
  // Each repository's folder on this machine. A folder picked from the browser
  // has no listed row to return to, so it carries no source.
  const folderOfRepo = new Map<
    string,
    { key: string; source?: ProjectMemberSource; label: string }
  >();
  if (scope.kind === 'machine') {
    const addFolderRow = (input: {
      folderKey: string;
      repoKey?: string;
      source: ProjectMemberSource;
      label: string;
      detail?: string;
      icon: PickRow['icon'];
      previous: boolean;
    }) => {
      const folder = members.get(input.folderKey);
      const repo = input.repoKey ? members.get(input.repoKey) : undefined;
      // A copy-preferring repository member from before is this folder.
      const legacy =
        repo && repo.source.kind === 'github' && repo.source.preferLocal ? repo : undefined;
      const both = alsoFolder.has(input.folderKey) && repo !== undefined;
      const selected = Boolean(folder || legacy || both);
      if (input.repoKey)
        folderOfRepo.set(input.repoKey, {
          key: input.folderKey,
          source: input.source,
          label: input.label,
        });
      folderRows.push({
        key: input.folderKey,
        label: input.label,
        detail: input.detail,
        icon: input.icon,
        previous: input.previous,
        selected,
        toggle: () => {
          if (both) withKey(input.folderKey, false);
          else if (folder) onChange(removeProjectGroupMember(value, folder.id, labelOf));
          else if (legacy) onChange(removeProjectGroupMember(value, legacy.id, labelOf));
          // Already ticked as a GitHub repository, which wins: only noted.
          else if (repo) withKey(input.folderKey, true);
          else onChange(addProjectGroupMember(value, input.source, input.label));
        },
      });
    };
    for (const option of sources) {
      const copy = option.copies.find((candidate) => candidate.machineId === scope.machineId);
      if (!copy) continue;
      const source: ProjectMemberSource =
        option.kind === 'repository'
          ? { kind: 'local', machineId: copy.machineId, localProjectId: copy.localProjectId }
          : option.source;
      const folderKey = getProjectMemberSourceKey(source);
      const name =
        option.kind === 'repository'
          ? (option.label.split('/').pop() ?? option.label)
          : option.label;
      addFolderRow({
        folderKey,
        ...(option.kind === 'repository' ? { repoKey: option.key } : {}),
        source,
        label: name,
        detail:
          option.kind === 'repository'
            ? [option.label, copy.rootPath].filter(Boolean).join(' · ')
            : copy.rootPath,
        icon: option.kind === 'repository' ? 'repository' : 'folder',
        previous:
          previousUsage?.has(folderKey) === true ||
          (option.kind === 'repository' && previousUsage?.get(option.key) === 'localCopy'),
      });
    }
    // A folder picked from the browser is not a listed project yet; it is
    // shown, ticked, until saving registers it.
    const listed = new Set(folderRows.map((row) => row.key));
    for (const member of value.members) {
      const key = keyOf(member);
      if (!member.directory || member.directory.machineId !== scope.machineId || listed.has(key))
        continue;
      const remote = member.directory.inspection.repoFullName;
      folderRows.unshift({
        key,
        label: labelOf(member),
        detail: member.directory.rootPath,
        icon: remote ? 'repository' : 'folder',
        selected: true,
        toggle: () => onChange(removeProjectGroupMember(value, member.id, labelOf)),
      });
      if (remote)
        folderOfRepo.set(`github:${remote.toLowerCase()}`, { key, label: labelOf(member) });
    }
  }

  // Every repository GitHub integration can clone, plus a member already cloned
  // from one it no longer lists, so it can still be unticked. Ticking one whose
  // folder is ticked too is allowed and only noted: GitHub wins.
  const repositoryRows: PickRow[] = sources
    .filter(
      (option) =>
        option.kind === 'repository' &&
        (option.onGithub === true || members.get(option.key)?.source.kind === 'github')
    )
    .map((option) => {
      const member = members.get(option.key);
      const folderOf = folderOfRepo.get(option.key);
      const folder = folderOf ? members.get(folderOf.key) : undefined;
      // A legacy copy-preferring member on this machine is shown as the folder.
      const selected =
        member !== undefined &&
        member.source.kind === 'github' &&
        !(member.source.preferLocal && folderOf);
      return {
        key: option.key,
        label: option.label,
        detail: option.description,
        icon: 'github' as const,
        previous: previousUsage?.get(option.key) === 'worktree',
        selected,
        toggle: () => {
          if (selected && member) {
            // Still ticked as a folder: it goes back to being that folder.
            if (folderOf?.source && alsoFolder.has(folderOf.key)) {
              onChange(swap(member, folderOf.source, folderOf.label));
              withKey(folderOf.key, false);
            } else onChange(removeProjectGroupMember(value, member.id, labelOf));
          } else if (folder && folderOf) {
            // Ticked as a folder too: GitHub wins, so it becomes a clone.
            onChange(swap(folder, plain(option.label), option.label));
            if (folderOf.source) withKey(folderOf.key, true);
          } else if (member) {
            // A copy-preferring member shown as the folder: the same, GitHub wins.
            onChange(swap(member, plain(option.label), option.label));
            if (folderOf?.source) withKey(folderOf.key, true);
          } else onChange(addProjectGroupMember(value, plain(option.label), option.label));
        },
      };
    });

  const needle = query.trim().toLowerCase();
  const matches = (row: PickRow) =>
    !needle ||
    row.label.toLowerCase().includes(needle) ||
    (row.detail?.toLowerCase().includes(needle) ?? false);
  const shownFolders = folderRows.filter(matches);
  const shownRepositories = repositoryRows.filter(matches);

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

  const repositoryList = (
    <PickList
      rows={shownRepositories}
      empty={
        needle
          ? t('settings.projectGroups.form.noSources')
          : t('settings.projectGroups.wizard.sources.noRepositories')
      }
    />
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
  const githubSelected = repositoryRows.filter((row) => row.selected).length;
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
      {notice}
      <Tabs.Panel value="folders">
        <div {...stylex.props(styles.stack)}>
          <PickList
            rows={shownFolders}
            empty={
              needle
                ? t('settings.projectGroups.form.noSources')
                : canBrowse
                  ? t('settings.projectGroups.wizard.sources.noFoldersBrowse', {
                      machine: machineLabel,
                    })
                  : t('settings.projectGroups.wizard.sources.noFolders', { machine: machineLabel })
            }
          />
          <p {...stylex.props(styles.note)}>
            {t('settings.projectGroups.wizard.sources.foldersNote')}
          </p>
        </div>
      </Tabs.Panel>
      <Tabs.Panel value="github">
        <div {...stylex.props(styles.stack)}>
          {repositoryList}
          <p {...stylex.props(styles.note)}>
            {t('settings.projectGroups.wizard.sources.githubNote')}
          </p>
        </div>
      </Tabs.Panel>
    </Tabs.Root>
  );
}

/** Marks an answer the project had before this edit. */
function PreviousBadge() {
  const { t } = useTranslation();
  return <Badge>{t('settings.projectGroups.wizard.previous')}</Badge>;
}

function RowIcon({ icon }: { icon: PickRow['icon'] }) {
  const Icon = icon === 'folder' ? Folder : icon === 'repository' ? FolderGit2 : Github;
  return <Icon aria-hidden="true" {...stylex.props(catalog.icon)} />;
}

function PickList({ rows, empty }: { rows: readonly PickRow[]; empty: string }) {
  if (rows.length === 0)
    return (
      <div {...stylex.props(settingsRecordsCard, styles.fullHeight)}>
        <div {...stylex.props(styles.empty)}>{empty}</div>
      </div>
    );
  return (
    <div {...stylex.props(settingsRecordsCard, styles.fullHeight)}>
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
          {row.previous ? <PreviousBadge /> : null}
        </label>
      ))}
    </div>
  );
}

function DetailsStep({
  value,
  onChange,
  onRemoved,
  labelOf,
  detailOf,
  validation,
  notice,
}: {
  value: ProjectGroupFormValue;
  onChange: (value: ProjectGroupFormValue) => void;
  onRemoved: (key: string) => void;
  labelOf: (member: ProjectGroupMemberDraft) => string;
  detailOf: (member: ProjectGroupMemberDraft) => string | undefined;
  validation: ProjectGroupFormValidation;
  notice: ReactNode;
}) {
  const { t } = useTranslation();
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
          aria-invalid={
            validation.errors.includes('name_required') ||
            validation.errors.includes('name_taken') ||
            undefined
          }
          value={value.name}
          onChange={(event) => onChange({ ...value, name: event.target.value })}
        />
        {validation.errors.includes('name_taken') ? (
          <FormMessage tone="error">
            {t('settings.projectGroups.wizard.details.nameTaken')}
          </FormMessage>
        ) : null}
      </Section>

      <Section
        title={t('settings.projectGroups.wizard.details.members', { count: value.members.length })}
      >
        <div {...stylex.props(settingsRecordsCard, styles.fullHeight)}>
          {value.members.map((member, index) => {
            const code = validation.memberErrors.get(member.id);
            const usage = usageOf(member);
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
                    usage === 'inPlace' ? 'folder' : usage === 'localCopy' ? 'repository' : 'github'
                  }
                />
                <span {...stylex.props(styles.rowBody)}>
                  <span {...stylex.props(styles.rowName)}>{labelOf(member)}</span>
                  <span {...stylex.props(styles.rowDetail)} title={detailOf(member)}>
                    {code ? errorText(code) : (detailOf(member) ?? '')}
                  </span>
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="small"
                  icon
                  aria-label={t('settings.projectGroups.wizard.details.remove', {
                    name: labelOf(member),
                  })}
                  onClick={() => {
                    onChange(removeProjectGroupMember(value, member.id, labelOf));
                    onRemoved(keyOf(member));
                  }}
                >
                  <X {...stylex.props(catalog.icon)} />
                </Button>
              </div>
            );
          })}
        </div>
        {notice}
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
