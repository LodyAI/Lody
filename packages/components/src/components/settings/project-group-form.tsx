import { useId, useMemo, type FormEvent, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  Folder,
  FolderPlus,
  FolderGit2,
  GitBranch,
  Github,
  MoreHorizontal,
  Sparkles,
} from 'lucide-react';
import type { MachineId, ProjectMemberId } from '@lody/shared';
import type { ProjectMemberSourceOption } from '@/lib/project-member-sources';
import {
  removeProjectGroupMember,
  updateProjectGroupMemberPlacement,
  type ProjectGroupFormValidation,
  type ProjectGroupFormValue,
  type ProjectGroupMemberDraft,
  type ProjectGroupMemberError,
} from '@/lib/project-group-form';
import { withClassName } from '@/lib/stylex';
import { Button } from '@lody/ui/button';
import { Dialog } from '@lody/ui/dialog';
import { Input } from '@lody/ui/input';
import { Menu } from '@lody/ui/menu';
import { Spinner } from '@lody/ui/spinner';
import { Textarea } from '@lody/ui/textarea';
import { Tooltip } from '@lody/ui/tooltip';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { FormMessage, Section } from './form-primitives';
import { ProjectGroupSourcePicker } from './project-group-source-picker';
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
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
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
  stateError: { color: colors.destructive },
  addRow: { minWidth: 0, display: 'flex', gap: space[2], flexWrap: 'wrap', alignItems: 'center' },
  errors: { margin: 0, paddingInlineStart: space[4], listStyleType: 'disc' },
});

// A repository whose submodules could not be read is shown as having none:
// most repositories have none, so a warning there was noise.
export type ProjectGroupMemberStatus = 'pending' | undefined;

export type ProjectGroupFormProps = {
  value: ProjectGroupFormValue;
  onChange: (value: ProjectGroupFormValue) => void;
  /** Everything that may be added, one row per repository; ticked rows are members. */
  sources: readonly ProjectMemberSourceOption[];
  /** Names a member, including one whose project is no longer listed. */
  labelOf: (member: ProjectGroupMemberDraft) => string;
  detailOf: (member: ProjectGroupMemberDraft) => string | undefined;
  statusOf: (memberId: ProjectMemberId) => ProjectGroupMemberStatus;
  /**
   * A local directory without Git: it is used in place, with no branch, backup
   * or PR, so it can neither be a submodule nor hold one.
   */
  isNonGit?: (memberId: ProjectMemberId) => boolean;
  validation: ProjectGroupFormValidation;
  /** The machine this device runs, so the picker can call it "This machine". */
  currentMachineId?: MachineId | null;
  /** A non-owner sees the group as it is and cannot change it. */
  readOnly?: boolean;
  submitting?: boolean;
  error?: string;
  isEditing?: boolean;
  onSelectFolders?: () => void;
  selectFoldersDisabled?: boolean;
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
  isNonGit = () => false,
  onSelectFolders,
  selectFoldersDisabled,
  validation,
  currentMachineId = null,
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
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };

  const errorText = (code: ProjectGroupMemberError) =>
    t(`settings.projectGroups.memberErrors.${code}`);

  return (
    <form {...stylex.props(catalog.editorForm)} onSubmit={submit} inert={submitting || undefined}>
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
          hint={
            onSelectFolders
              ? t('settings.projectGroups.folderSemantics')
              : t('settings.projectGroups.form.membersHint')
          }
        >
          {/* The picker sits above the members, so ticking a project grows the
              list below it and never moves the control being used. */}
          {readOnly ? null : (
            <div {...stylex.props(styles.addRow)}>
              {onSelectFolders ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="small"
                  disabled={submitting || selectFoldersDisabled}
                  title={
                    selectFoldersDisabled
                      ? t('settings.projectGroups.folderUpdateRequired')
                      : undefined
                  }
                  onClick={onSelectFolders}
                >
                  <FolderPlus size={14} />
                  {t('settings.projectGroups.selectFolders')}
                </Button>
              ) : null}
              <ProjectGroupSourcePicker
                value={value}
                onChange={onChange}
                sources={sources}
                labelOf={labelOf}
                currentMachineId={currentMachineId}
              />
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
                    nonGit={isNonGit(member.id)}
                    parents={
                      isNonGit(member.id)
                        ? []
                        : value.members.filter(
                            (candidate) =>
                              candidate.id !== member.id &&
                              candidate.placement.kind === 'root' &&
                              !isNonGit(candidate.id)
                          )
                    }
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

/** A repository with local copies, a GitHub-only repository, or a folder on one machine. */
function SourceIcon({ source }: { source: ProjectGroupMemberDraft['source'] }) {
  const Icon = source.kind === 'local' ? Folder : source.preferLocal ? FolderGit2 : Github;
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
  nonGit,
  parents,
  labelOf,
  readOnly,
  onPlacement,
  onRemove,
}: {
  parentLabel?: string;
  nonGit: boolean;
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
        <SourceIcon source={member.source} />
      )}
      <span {...stylex.props(styles.memberBody)}>
        <span {...stylex.props(styles.memberName)}>{label}</span>
        <span {...stylex.props(styles.memberDetail)} title={detail}>
          {placement.kind === 'submodule' ? (
            <>
              {t('settings.projectGroups.form.submoduleOf', { parent: parentLabel ?? '' })}
              {' · '}
              <span {...stylex.props(styles.memberDetailPath)}>{prefix}</span>
            </>
          ) : nonGit ? (
            // Said where the member is listed: it is edited in place, unlike
            // every repository beside it.
            t('settings.projectGroups.form.nonGitDetail', { detail: detail ?? '' })
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
