import type { E2eeMachineSharingChange, E2eeMachineSharingView } from '@lody/platform';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { Collapsible } from '@lody/ui/collapsible';
import { Switch } from '@lody/ui/switch';
import { Badge } from '@lody/ui/badge';
import { Alert } from '@lody/ui/alert';
import { Spinner } from '@lody/ui/spinner';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { ChevronDown } from 'lucide-react';
import { CompactSection, CompactRow } from '../compact-layout';

const MONO = 'var(--font-mono, ui-monospace, monospace)';

export type SharingProject = { id: string; name: string; rootPath?: string };
export type SharingIssue =
  | 'pending'
  | 'conflict'
  | 'retry'
  | 'removed'
  | 'generation'
  | 'notOwned'
  | 'notShared'
  | 'unavailable'
  | 'unsupported';
export const sharingIssue = (cause: unknown): SharingIssue => {
  const message = cause instanceof Error ? cause.message : '';
  if (/e2ee_machine_not_owned|e2ee_machine-not-owned/.test(message)) return 'notOwned';
  if (/e2ee_machine_not_shared|e2ee_machine-not-shared/.test(message)) return 'notShared';
  if (message === 'e2ee_machine_sharing_unsupported') return 'unsupported';
  if (/sharing_conflict/.test(message)) return 'conflict';
  return 'retry';
};
const styles = stylex.create({
  details: {
    margin: 0,
    display: 'grid',
    gridTemplateColumns: 'auto 1fr',
    columnGap: space[3],
    rowGap: space[1],
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
  },
  detailValue: { margin: 0 },
  root: { display: 'flex', flexDirection: 'column', gap: space[3] },
  notice: {
    padding: space[4],
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
    fontSize: text.subheadlineSize,
  },
  actions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space[2] },
  key: {
    fontFamily: MONO,
    color: colors.secondaryLabel,
    overflowWrap: 'anywhere',
    fontSize: text.footnoteSize,
  },
  quiet: { color: colors.secondaryLabel, margin: 0, fontSize: text.footnoteSize },
});

/** Pure settings surface. All authority and originals remain with the native host. */
export function MachineSharingPanel({
  view,
  projects,
  busy,
  loading,
  issue,
  retryable,
  pendingChange,
  onChange,
  onResign,
  onRefresh,
  onRetry,
}: {
  view?: E2eeMachineSharingView;
  projects: readonly SharingProject[];
  busy?: boolean;
  loading?: boolean;
  issue?: SharingIssue;
  retryable?: boolean;
  pendingChange?: E2eeMachineSharingChange;
  onChange: (change: E2eeMachineSharingChange) => void;
  onResign: () => void;
  onRefresh: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const unavailable =
    !view ||
    view.unavailable ||
    issue === 'unavailable' ||
    issue === 'unsupported' ||
    issue === 'retry' ||
    issue === 'notOwned' ||
    issue === 'notShared';
  const pending = !!view?.pendingRequest || (!!retryable && issue !== 'conflict');
  const effective = !pending && !unavailable && !view.removed && view.sharedWithTeam;
  const disabled =
    busy ||
    loading ||
    unavailable ||
    !view?.canManage ||
    view?.removed ||
    !!view?.pendingRequest ||
    retryable ||
    (!!issue && issue !== 'generation');
  const pendingChangeShown = pendingChange ?? view?.pendingRequest?.change;
  const shownIssue = issue ?? (view?.removed ? 'removed' : undefined);
  const rows = [...projects];
  for (const id of view?.projects ?? [])
    if (!rows.some((row) => row.id === id)) rows.push({ id, name: id });
  const status =
    loading && !view
      ? 'loading'
      : unavailable
        ? 'unavailable'
        : pending
          ? 'pending'
          : effective
            ? 'shared'
            : 'private';
  return (
    <div {...stylex.props(styles.root)} aria-busy={!!busy || !!loading}>
      <CompactSection title={t('e2ee.machineSharing.title')}>
        <CompactRow
          label={t('e2ee.machineSharing.team')}
          helper={t('e2ee.machineSharing.audience')}
        >
          <Badge>{t(`e2ee.machineSharing.state.${status}`)}</Badge>
          {view?.canManage ? (
            <Switch
              checked={effective}
              disabled={!!disabled}
              data-testid="machine-sharing-toggle"
              aria-label={t('e2ee.machineSharing.team')}
              onCheckedChange={(checked) => onChange({ kind: 'machine', sharedWithTeam: checked })}
            />
          ) : null}
          {busy || loading ? <Spinner size="small" /> : null}
        </CompactRow>
        {rows.map((project) => {
          const stored = view?.projects.includes(project.id) ?? false;
          return (
            <CompactRow key={project.id} label={project.name} helper={project.rootPath}>
              {view?.canManage ? (
                <Switch
                  checked={stored}
                  disabled={!!disabled}
                  aria-label={t('e2ee.machineSharing.projectToggle', { name: project.name })}
                  onCheckedChange={(checked) =>
                    onChange({
                      kind: 'project',
                      localProjectId: project.id,
                      sharedWithTeam: checked,
                    })
                  }
                />
              ) : (
                <Badge>
                  {t(
                    `e2ee.machineSharing.state.${unavailable ? 'unavailable' : effective && stored ? 'shared' : 'private'}`
                  )}
                </Badge>
              )}
            </CompactRow>
          );
        })}
        <div {...stylex.props(styles.notice)}>
          {rows.length === 0 ? (
            <p {...stylex.props(styles.quiet)}>{t('e2ee.machineSharing.noProjects')}</p>
          ) : null}
          {!effective && view?.projects.length ? (
            <p {...stylex.props(styles.quiet)}>{t('e2ee.machineSharing.retainedProjects')}</p>
          ) : null}
          <p {...stylex.props(styles.quiet)}>{t('e2ee.machineSharing.runningTasks')}</p>
          {view && !view.canManage ? <p>{t('e2ee.machineSharing.notOwned')}</p> : null}
          {view && !view.canManage && view.deniedReason === 'e2ee_machine_not_shared' ? (
            <p>{t('e2ee.machineSharing.notShared')}</p>
          ) : null}
          {view?.needsResign ? (
            <Alert.Root>
              <Alert.Title>{t('e2ee.machineSharing.state.needsResign')}</Alert.Title>
              <Alert.Description>{t('e2ee.machineSharing.resignHint')}</Alert.Description>
            </Alert.Root>
          ) : null}
          {pendingChangeShown ? (
            <p>
              {t(
                pendingChangeShown.kind === 'machine'
                  ? 'e2ee.machineSharing.pendingMachine'
                  : pendingChangeShown.kind === 'session'
                    ? 'e2ee.machineSharing.pendingSession'
                    : 'e2ee.machineSharing.pendingProject',
                {
                  action: t(
                    (
                      pendingChangeShown.kind === 'session'
                        ? pendingChangeShown.level === 'read'
                        : pendingChangeShown.sharedWithTeam
                    )
                      ? 'e2ee.machineSharing.enable'
                      : 'e2ee.machineSharing.disable'
                  ),
                  name:
                    pendingChangeShown.kind === 'project'
                      ? (rows.find((project) => project.id === pendingChangeShown.localProjectId)
                          ?.name ?? pendingChangeShown.localProjectId)
                      : pendingChangeShown.kind === 'session'
                        ? pendingChangeShown.sessionId
                        : undefined,
                }
              )}
            </p>
          ) : null}
          {shownIssue ? (
            <div role="status">
              <Alert.Root>
                <Alert.Description>
                  {t(`e2ee.machineSharing.issue.${shownIssue}`)}
                </Alert.Description>
              </Alert.Root>
            </div>
          ) : null}
          {/* Version and signer help diagnose a sync problem; the switches are the page. */}
          <Collapsible.Root>
            <Collapsible.Trigger render={<Button variant="ghost" size="small" />}>
              {t('e2ee.machineSharing.details')}
              <ChevronDown size={14} aria-hidden="true" />
            </Collapsible.Trigger>
            <Collapsible.Panel keepMounted>
              <dl {...stylex.props(styles.details)}>
                <dt>
                  {t(pending ? 'e2ee.machineSharing.lastVersion' : 'e2ee.machineSharing.version')}
                </dt>
                <dd {...stylex.props(styles.detailValue)}>
                  {view?.head ? `v${view.head.revision}` : t('e2ee.machineSharing.noVersion')}
                </dd>
                <dt>{t('e2ee.machineSharing.signer')}</dt>
                <dd
                  title={view?.signer ?? undefined}
                  {...stylex.props(styles.detailValue, view?.signer ? styles.key : undefined)}
                >
                  {view?.signer
                    ? `${view.signer.slice(0, 12)}…${view.signer.slice(-8)}`
                    : t('e2ee.machineSharing.noSigner')}
                </dd>
              </dl>
            </Collapsible.Panel>
          </Collapsible.Root>
          <div {...stylex.props(styles.actions)}>
            <Button variant="secondary" size="small" onClick={onRefresh} disabled={busy || loading}>
              {t('e2ee.machineSharing.refresh')}
            </Button>
            {retryable && view?.canManage ? (
              <Button size="small" onClick={onRetry} disabled={busy || loading}>
                {t('e2ee.machineSharing.retry')}
              </Button>
            ) : null}
            {view?.needsResign && view.canManage && !retryable ? (
              <Button
                size="small"
                disabled={busy || loading || view.removed || view.unavailable || !!issue}
                onClick={onResign}
              >
                {t('e2ee.machineSharing.resign')}
              </Button>
            ) : null}
          </div>
        </div>
      </CompactSection>
    </div>
  );
}
