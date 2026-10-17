import { useId, useMemo, type FormEvent, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  Folder,
  GitBranch,
  Github,
  MoreHorizontal,
  Plus,
  Sparkles,
} from 'lucide-react';
import type { ProjectMemberId } from '@lody/shared';
import type { ProjectMemberSourceOption } from '@/hooks/use-project-member-sources';
import {
  applySourceSelection,
  getProjectGroupLocalMachineId,
  getProjectMemberSourceKey,
  removeProjectGroupMember,
  updateProjectGroupMemberPlacement,
  type ProjectGroupFormValidation,
  type ProjectGroupFormValue,
  type ProjectGroupMemberDraft,
  type ProjectGroupMemberError,
} from '@/lib/project-group-form';
import { withClassName } from '@/lib/stylex';
import { Button } from '@lody/ui/button';
import { Combobox } from '@lody/ui/combobox';
import { Dialog } from '@lody/ui/dialog';
import { Input } from '@lody/ui/input';
import { Menu } from '@lody/ui/menu';
import { Spinner } from '@lody/ui/spinner';
import { Textarea } from '@lody/ui/textarea';
import { Tooltip } from '@lody/ui/tooltip';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { FormMessage, Section } from './form-primitives';
import { settingsRecordsCard } from './compact-layout';
import { settingsCatalog as catalog, settingsSurface as surface } from './surface';

const styles = stylex.create({
  member: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minWidth: 0,
    paddingBlock: space[1.5],
    paddingInline: space[3],
  },
  // Submodules sit under their parent the way they will sit on disk, one step
  // further in per level: the list is the layout of the conversation's
  // directory, not a list beside it.
  memberIndent: (depth: number) => ({ paddingInlineStart: `${12 + depth * 20}px` }),
  memberName: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.subheadlineSize,
    color: colors.label,
  },
  memberDetail: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.footnoteSize,
    color: colors.secondaryLabel,
  },
  memberDetailPath: {
    color: colors.tertiaryLabel,
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  },
  memberBody: {
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    flexBasis: 0,
    gap: '2px',
    minWidth: 0,
  },
  memberPath: { flexShrink: 0, width: '200px' },
  // A picker row: the source mark, its name, then its machine or description.
  option: { display: 'flex', alignItems: 'center', gap: space[2], minWidth: 0 },
  optionDetail: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.footnoteSize,
    color: colors.secondaryLabel,
  },
  // One fixed slot for the member's state, so rows never change height or
  // shift sideways as detection settles.
  state: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '16px',
    height: '16px',
    color: colors.tertiaryLabel,
  },
  stateWarning: { color: colors.warning },
  stateError: { color: colors.destructive },
  addRow: { minWidth: 0 },
  addFace: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1.5],
    color: colors.secondaryLabel,
  },
  errors: { margin: 0, paddingInlineStart: space[4], listStyleType: 'disc' },
});

export type ProjectGroupMemberStatus = 'pending' | 'unavailable' | undefined;

export type ProjectGroupFormProps = {
  value: ProjectGroupFormValue;
  onChange: (value: ProjectGroupFormValue) => void;
  /** Everything that may be added; already-added sources are filtered out here. */
  sources: readonly ProjectMemberSourceOption[];
  /** Names a member, including one whose project is no longer listed. */
  labelOf: (member: ProjectGroupMemberDraft) => string;
  detailOf: (member: ProjectGroupMemberDraft) => string | undefined;
  statusOf: (memberId: ProjectMemberId) => ProjectGroupMemberStatus;
  validation: ProjectGroupFormValidation;
  /** A non-owner sees the group as it is and cannot change it. */
  readOnly?: boolean;
  submitting?: boolean;
  error?: string;
  isEditing?: boolean;
  onSubmit: () => void;
  onCancel: () => void;
};

/** Members in the order their directories nest: each parent, then its submodules. */
function orderAsTree(members: readonly ProjectGroupMemberDraft[]) {
  const children = new Map<ProjectMemberId, ProjectGroupMemberDraft[]>();
  const roots: ProjectGroupMemberDraft[] = [];
  const ids = new Set(members.map((member) => member.id));
  for (const member of members) {
    const placement = member.placement;
    if (placement.kind === 'submodule' && ids.has(placement.parent)) {
      const list = children.get(placement.parent) ?? [];
      list.push(member);
      children.set(placement.parent, list);
    } else roots.push(member);
  }
  const ordered: { member: ProjectGroupMemberDraft; depth: number; prefix: string }[] = [];
  const seen = new Set<ProjectMemberId>();
  const visit = (member: ProjectGroupMemberDraft, depth: number, prefix: string) => {
    if (seen.has(member.id)) return;
    seen.add(member.id);
    ordered.push({ member, depth, prefix });
    const own =
      member.placement.kind === 'root'
        ? member.placement.dir
        : `${prefix}${member.placement.path}`.replace(/^\//, '');
    for (const child of children.get(member.id) ?? []) visit(child, depth + 1, `${own}/`);
  };
  for (const member of roots) visit(member, 0, '');
  // A cycle leaves members unvisited; show them flat so nothing disappears.
  for (const member of members) visit(member, 0, '');
  return ordered;
}

/**
 * The Project group editor body.
 *
 * Presentational: the dialog that owns the catalog passes sources, labels and
 * detection state in, so this renders the same in Storybook as in Settings.
 */
export function ProjectGroupForm({
  value,
  onChange,
  sources,
  labelOf,
  detailOf,
  statusOf,
  validation,
  readOnly = false,
  submitting = false,
  error,
  isEditing = false,
  onSubmit,
  onCancel,
}: ProjectGroupFormProps) {
  const { t } = useTranslation();
  const fieldId = useId();
  const rows = useMemo(() => orderAsTree(value.members), [value.members]);
  const addedKeys = useMemo(
    () => new Set(value.members.map((member) => getProjectMemberSourceKey(member.source))),
    [value.members]
  );
  // Local projects on another machine cannot join: a conversation runs on one
  // machine. They stay listed, disabled, saying why — unless already a member,
  // so an old mixed group can still be fixed by unticking.
  const lockedMachineId = getProjectGroupLocalMachineId(value);
  const lockedMachineName = lockedMachineId
    ? sources.find(
        (option) => option.source.kind === 'local' && option.source.machineId === lockedMachineId
      )?.detail
    : undefined;
  const isOtherMachine = (option: ProjectMemberSourceOption) =>
    option.source.kind === 'local' &&
    lockedMachineId !== null &&
    option.source.machineId !== lockedMachineId &&
    !addedKeys.has(option.key);
  const selectedSources = useMemo(
    () => sources.filter((option) => addedKeys.has(option.key)),
    [addedKeys, sources]
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };

  const errorText = (code: ProjectGroupMemberError) =>
    t(`settings.projectGroups.memberErrors.${code}`);

  return (
    <form {...stylex.props(catalog.editorForm)} onSubmit={submit}>
      <div {...withClassName(stylex.props(catalog.editorBody), 'scrollbar-pro')}>
        <div {...stylex.props(catalog.stack)}>
          <Input
            id={`${fieldId}-name`}
            autoComplete="off"
            aria-label={t('settings.projectGroups.form.name')}
            placeholder={t('settings.projectGroups.form.name')}
            aria-invalid={validation.errors.includes('name_required') || undefined}
            value={value.name}
            disabled={readOnly}
            onChange={(event) => onChange({ ...value, name: event.target.value })}
          />
        </div>

        <Section
          title={t('settings.projectGroups.form.members')}
          hint={t('settings.projectGroups.form.membersHint')}
        >
          {/* The picker sits above the members, so ticking a project grows the
              list below it and never moves the control being used. */}
          {readOnly ? null : (
            <div {...stylex.props(styles.addRow)}>
              {/* One multi-select over every project: ticked rows are members,
                  ticking adds, unticking removes, and the list stays open so
                  several repositories go in at once. */}
              <Combobox.Root
                multiple
                items={sources}
                value={selectedSources}
                itemToStringLabel={(option: ProjectMemberSourceOption) => option.label}
                isItemEqualToValue={(
                  left: ProjectMemberSourceOption,
                  right: ProjectMemberSourceOption
                ) => left.key === right.key}
                onValueChange={(next: ProjectMemberSourceOption[]) =>
                  onChange(applySourceSelection(value, selectedSources, next, labelOf))
                }
              >
                <Combobox.Button size="small" aria-label={t('settings.projectGroups.form.add')}>
                  {/* The face always reads as the action; the ticks inside say
                      what is already in the group. */}
                  {() => (
                    <span {...stylex.props(styles.addFace)}>
                      <Plus aria-hidden="true" {...stylex.props(catalog.icon)} />
                      {t('settings.projectGroups.form.add')}
                    </span>
                  )}
                </Combobox.Button>
                <Combobox.Content
                  search={
                    <Combobox.Search
                      aria-label={t('settings.projectGroups.form.search')}
                      placeholder={t('settings.projectGroups.form.search')}
                    />
                  }
                  empty={
                    <Combobox.Empty>{t('settings.projectGroups.form.noSources')}</Combobox.Empty>
                  }
                >
                  {(option: ProjectMemberSourceOption) => (
                    <Combobox.Item
                      key={option.key}
                      value={option}
                      disabled={isOtherMachine(option)}
                    >
                      <span {...stylex.props(styles.option)}>
                        <SourceIcon kind={option.source.kind} />
                        <span {...stylex.props(catalog.truncate)}>{option.label}</span>
                        {isOtherMachine(option) ? (
                          <span {...stylex.props(styles.optionDetail)}>
                            {t('settings.projectGroups.form.otherMachine', {
                              machine: option.detail ?? '',
                              current: lockedMachineName ?? '',
                            })}
                          </span>
                        ) : option.detail ? (
                          <span {...stylex.props(styles.optionDetail)}>{option.detail}</span>
                        ) : null}
                      </span>
                    </Combobox.Item>
                  )}
                </Combobox.Content>
              </Combobox.Root>
            </div>
          )}
          {rows.length > 0 ? (
            <div {...stylex.props(settingsRecordsCard)}>
              {rows.map(({ member, depth, prefix }, index) => (
                <div
                  key={member.id}
                  {...stylex.props(surface.line, index > 0 && surface.lineRuled)}
                >
                  <MemberRow
                    member={member}
                    depth={depth}
                    prefix={prefix}
                    label={labelOf(member)}
                    detail={detailOf(member)}
                    status={statusOf(member.id)}
                    memberError={validation.memberErrors.get(member.id)}
                    parentLabel={(() => {
                      const placement = member.placement;
                      if (placement.kind !== 'submodule') return undefined;
                      const parent = value.members.find((m) => m.id === placement.parent);
                      return parent ? labelOf(parent) : undefined;
                    })()}
                    parents={value.members.filter(
                      (candidate) =>
                        candidate.id !== member.id && candidate.placement.kind === 'root'
                    )}
                    labelOf={labelOf}
                    readOnly={readOnly}
                    onPlacement={(placement) =>
                      onChange(updateProjectGroupMemberPlacement(value, member.id, placement))
                    }
                    onRemove={() => onChange(removeProjectGroupMember(value, member.id, labelOf))}
                  />
                </div>
              ))}
            </div>
          ) : null}
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
          title={t('settings.projectGroups.form.instructions')}
          hint={t('settings.projectGroups.form.instructionsHint')}
        >
          <Textarea
            id={`${fieldId}-instructions`}
            rows={5}
            resize="none"
            aria-label={t('settings.projectGroups.form.instructions')}
            placeholder={t('settings.projectGroups.form.instructionsPlaceholder')}
            value={value.instructions}
            disabled={readOnly}
            onChange={(event) => onChange({ ...value, instructions: event.target.value })}
          />
        </Section>

        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
      </div>

      <Dialog.Footer>
        <Button type="button" variant="secondary" disabled={submitting} onClick={onCancel}>
          {readOnly ? t('common.close') : t('common.cancel')}
        </Button>
        {readOnly ? null : (
          <Button type="submit" disabled={submitting || !validation.valid}>
            {submitting ? <Spinner size="small" aria-hidden="true" /> : null}
            {isEditing ? t('common.save') : t('settings.projectGroups.form.create')}
          </Button>
        )}
      </Dialog.Footer>
    </form>
  );
}

function SourceIcon({ kind }: { kind: 'github' | 'local' }) {
  const Icon = kind === 'github' ? Github : Folder;
  return <Icon aria-hidden="true" {...stylex.props(catalog.icon)} />;
}

function MemberRow({
  member,
  depth,
  prefix,
  label,
  detail,
  status,
  memberError,
  parentLabel,
  parents,
  labelOf,
  readOnly,
  onPlacement,
  onRemove,
}: {
  parentLabel?: string;
  member: ProjectGroupMemberDraft;
  depth: number;
  /** The parent's path; the description line shows where a submodule sits. */
  prefix: string;
  label: string;
  detail?: string;
  status: ProjectGroupMemberStatus;
  memberError?: ProjectGroupMemberError;
  parents: readonly ProjectGroupMemberDraft[];
  labelOf: (member: ProjectGroupMemberDraft) => string;
  readOnly: boolean;
  onPlacement: (placement: ProjectGroupMemberDraft['placement']) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const placement = member.placement;
  const pathValue = placement.kind === 'root' ? placement.dir : placement.path;
  const pathLabel =
    placement.kind === 'root'
      ? t('settings.projectGroups.form.dir')
      : t('settings.projectGroups.form.submodulePath');

  return (
    <div {...stylex.props(styles.member, styles.memberIndent(depth))}>
      {placement.kind === 'submodule' ? (
        <GitBranch aria-hidden="true" {...stylex.props(catalog.icon)} />
      ) : (
        <SourceIcon kind={member.source.kind} />
      )}
      <span {...stylex.props(styles.memberBody)}>
        <span {...stylex.props(styles.memberName)}>{label}</span>
        <span {...stylex.props(styles.memberDetail)}>
          {placement.kind === 'submodule' ? (
            <>
              {t('settings.projectGroups.form.submoduleOf', { parent: parentLabel ?? '' })}
              {' · '}
              <span {...stylex.props(styles.memberDetailPath)}>{prefix}</span>
            </>
          ) : (
            (detail ?? t(`settings.projectGroups.source.${member.source.kind}`))
          )}
        </span>
      </span>
      <span {...stylex.props(styles.memberPath)}>
        <Input
          size="small"
          aria-label={pathLabel}
          aria-invalid={memberError ? true : undefined}
          disabled={readOnly}
          title={`${prefix}${pathValue}`}
          value={pathValue}
          onChange={(event) => {
            const next = event.target.value;
            onPlacement(
              placement.kind === 'root'
                ? { kind: 'root', dir: next }
                : { kind: 'submodule', parent: placement.parent, path: next }
            );
          }}
        />
      </span>
      <MemberState
        status={status}
        detected={member.placementOrigin === 'detected'}
        error={memberError}
      />
      {readOnly ? null : (
        <Menu.Root>
          <Menu.Trigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="small"
                icon
                aria-label={t('settings.projectGroups.form.memberMenu', { name: label })}
              />
            }
          >
            <MoreHorizontal {...stylex.props(catalog.icon)} />
          </Menu.Trigger>
          <Menu.Content align="end">
            {placement.kind === 'submodule' ? (
              <Menu.Item
                onClick={() =>
                  onPlacement({ kind: 'root', dir: placement.path.split('/').pop() || 'repo' })
                }
              >
                {t('settings.projectGroups.form.makeTopLevel')}
              </Menu.Item>
            ) : null}
            {parents.length > 0 ? (
              <Menu.Submenu>
                <Menu.SubmenuTrigger>
                  {t('settings.projectGroups.form.makeSubmodule')}
                </Menu.SubmenuTrigger>
                <Menu.Content>
                  {parents.map((parent) => (
                    <Menu.Item
                      key={parent.id}
                      onClick={() =>
                        onPlacement({
                          kind: 'submodule',
                          parent: parent.id,
                          path: placement.kind === 'root' ? placement.dir : placement.path,
                        })
                      }
                    >
                      {labelOf(parent)}
                    </Menu.Item>
                  ))}
                </Menu.Content>
              </Menu.Submenu>
            ) : null}
            <Menu.Separator />
            <Menu.Item tone="destructive" onClick={onRemove}>
              {t('common.remove')}
            </Menu.Item>
          </Menu.Content>
        </Menu.Root>
      )}
    </div>
  );
}

/** The member's one state mark; its reason lives in the tooltip, not in the row. */
function MemberState({
  status,
  detected,
  error,
}: {
  status: ProjectGroupMemberStatus;
  detected: boolean;
  error?: ProjectGroupMemberError;
}) {
  const { t } = useTranslation();
  let mark: { node: ReactNode; reason: string } | null = null;
  if (error) {
    mark = {
      node: <AlertTriangle aria-hidden="true" {...stylex.props(catalog.icon, styles.stateError)} />,
      reason: t(`settings.projectGroups.memberErrors.${error}`),
    };
  } else if (status === 'pending') {
    mark = {
      node: <Spinner size="small" aria-hidden="true" />,
      reason: t('settings.projectGroups.detection.pending'),
    };
  } else if (status === 'unavailable') {
    mark = {
      node: (
        <AlertTriangle aria-hidden="true" {...stylex.props(catalog.icon, styles.stateWarning)} />
      ),
      reason: t('settings.projectGroups.detection.unavailable'),
    };
  } else if (detected) {
    mark = {
      node: <Sparkles aria-hidden="true" {...stylex.props(catalog.icon)} />,
      reason: t('settings.projectGroups.detection.detected'),
    };
  }
  if (!mark) return <span {...stylex.props(styles.state)} />;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={<span role="img" aria-label={mark.reason} {...stylex.props(styles.state)} />}
      >
        {mark.node}
      </Tooltip.Trigger>
      <Tooltip.Content>{mark.reason}</Tooltip.Content>
    </Tooltip.Root>
  );
}
