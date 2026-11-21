import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { Spinner } from '@lody/ui/spinner';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { AlertDialog } from '@/ui/dialog';
import { getIpcServices } from '@/lib/electron-ipc-client';
import { useOrganization } from '@/hooks/useOrganization';
import { CompactRow, CompactSection } from './compact-layout';
import { SettingsPageLead } from './settings-page-header';
import { settingsSurface } from './surface';
import {
  BUNDLE_KINDS,
  type BundleKind,
  type WorkspaceBundleExportSummary,
  type WorkspaceBundleImportOutcome,
  type WorkspaceBundlePlan,
} from '@lody/shared/workspace-bundle-control';

/** Settings > Data: workspace bundle export and import (desktop, owners and admins). */
export type WorkspaceBundleApi = {
  exportWorkspace(input: {
    workspaceId: string;
    workspaceName: string;
  }): Promise<
    | { status: 'canceled' }
    | { status: 'done'; summary: WorkspaceBundleExportSummary }
    | { status: 'error'; message: string }
  >;
  chooseImportFile(): Promise<
    | { status: 'canceled' }
    | { status: 'chosen'; token: string; fileName: string }
    | { status: 'error'; message: string }
  >;
  previewImport(input: {
    workspaceId: string;
    token: string;
  }): Promise<
    { status: 'planned'; plan: WorkspaceBundlePlan } | { status: 'error'; message: string }
  >;
  importWorkspace(input: {
    workspaceId: string;
    token: string;
  }): Promise<
    { status: 'done'; outcome: WorkspaceBundleImportOutcome } | { status: 'error'; message: string }
  >;
};

export type KindSummary = {
  kind: BundleKind;
  new: number;
  updated: number;
  unchanged: number;
  skipped: number;
};
export type ImportPlanSummary = {
  kinds: KindSummary[];
  skipped: Array<{ kind: BundleKind; label: string | null; reason: string; detail: string | null }>;
  gaps: number;
};

/** What a dry run says the import would do, in the terms people use. */
function summarizeImportPlan(plan: WorkspaceBundlePlan): ImportPlanSummary {
  const kinds = new Map<BundleKind, KindSummary>();
  const skipped: ImportPlanSummary['skipped'] = [];
  for (const room of plan.rooms) {
    if (room.action === 'skip')
      skipped.push({
        kind: room.kind,
        label: room.label || null,
        reason: room.reason ?? '',
        detail: room.detail ?? null,
      });
    // Supporting rooms (indexes, Meta) are not items a person counts unless skipped.
    if (!room.counted && room.action !== 'skip') continue;
    const entry = kinds.get(room.kind) ?? {
      kind: room.kind,
      new: 0,
      updated: 0,
      unchanged: 0,
      skipped: 0,
    };
    if (room.action === 'skip') entry.skipped += 1;
    else if (room.state === 'new') entry.new += 1;
    else if (room.state === 'unchanged') entry.unchanged += 1;
    else entry.updated += 1;
    kinds.set(room.kind, entry);
  }
  return {
    kinds: BUNDLE_KINDS.flatMap((kind) => {
      const entry = kinds.get(kind);
      return entry ? [entry] : [];
    }),
    skipped,
    gaps: plan.gaps.length,
  };
}

const SKIP_REASON_KEYS: Record<string, string> = {
  'unrelated-same-id': 'settings.workspaceData.skipReasons.unrelatedSameId',
  'deleted-in-target': 'settings.workspaceData.skipReasons.deletedInTarget',
  'machine-room': 'settings.workspaceData.skipReasons.machineRoom',
  'roost-exists': 'settings.workspaceData.skipReasons.roostExists',
  unauthorized: 'settings.workspaceData.skipReasons.unauthorized',
};

const styles = stylex.create({
  result: { fontSize: text.footnoteSize, color: colors.secondaryLabel, overflowWrap: 'anywhere' },
  error: { fontSize: text.footnoteSize, color: colors.destructive, overflowWrap: 'anywhere' },
  review: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[4],
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    maxHeight: 'min(360px, 50dvh)',
    overflowY: 'auto',
  },
  group: { display: 'flex', flexDirection: 'column', gap: space[1] },
  heading: { fontWeight: 600, color: colors.label },
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: space[4],
    minWidth: 0,
  },
  name: {
    color: colors.label,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  value: { color: colors.secondaryLabel, flexShrink: 0, textAlign: 'end' },
  note: { color: colors.secondaryLabel },
});

type Busy = 'export' | 'choose' | 'import' | null;
type Review = { token: string; fileName: string; summary: ImportPlanSummary };

export function WorkspaceDataSettingContent({
  workspaceId,
  workspaceName,
  canManage,
  api,
}: {
  workspaceId: string;
  workspaceName: string;
  canManage: boolean;
  api: WorkspaceBundleApi;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [exported, setExported] = useState<{ file: string; rooms: number; gaps: number } | null>(
    null
  );
  const [review, setReview] = useState<Review | null>(null);
  const [imported, setImported] = useState<{
    imported: number;
    skipped: number;
    uploadPending: number;
  } | null>(null);

  const describeError = (message: string) =>
    message === 'local_agent_unavailable'
      ? t('settings.workspaceData.errors.localAgentUnavailable')
      : message === 'import_file_expired'
        ? t('settings.workspaceData.errors.importFileExpired')
        : message;

  const describeCounts = (entry: KindSummary) =>
    entry.kind === 'catalog'
      ? t(
          entry.skipped
            ? 'settings.workspaceData.review.catalogSkipped'
            : entry.new
              ? 'settings.workspaceData.review.catalogNew'
              : entry.updated
                ? 'settings.workspaceData.review.catalogUpdated'
                : 'settings.workspaceData.review.catalogUnchanged'
        )
      : (
          [
            ['new', entry.new],
            ['updated', entry.updated],
            ['unchanged', entry.unchanged],
            ['skippedCount', entry.skipped],
          ] as const
        )
          .filter(([, count]) => count > 0)
          .map(([key, count]) => t(`settings.workspaceData.review.${key}`, { count }))
          .join(' · ');

  const run = async (kind: Exclude<Busy, null>, work: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const onExport = () =>
    run('export', async () => {
      const result = await api.exportWorkspace({ workspaceId, workspaceName });
      if (result.status === 'error') setError(describeError(result.message));
      if (result.status !== 'done') return;
      setExported({
        file: result.summary.file,
        rooms: result.summary.rooms,
        gaps: result.summary.gaps.length,
      });
    });

  const onChoose = () =>
    run('choose', async () => {
      setImported(null);
      const chosen = await api.chooseImportFile();
      if (chosen.status === 'error') setError(describeError(chosen.message));
      if (chosen.status !== 'chosen') return;
      const preview = await api.previewImport({ workspaceId, token: chosen.token });
      if (preview.status === 'error') {
        setError(describeError(preview.message));
        return;
      }
      setReview({
        token: chosen.token,
        fileName: chosen.fileName,
        summary: summarizeImportPlan(preview.plan),
      });
    });

  const onConfirm = () => {
    if (!review) return;
    void run('import', async () => {
      const result = await api.importWorkspace({ workspaceId, token: review.token });
      setReview(null);
      if (result.status === 'error') {
        setError(describeError(result.message));
        return;
      }
      const { result: counts, uploadPending } = result.outcome;
      setImported({
        imported: counts?.imported ?? 0,
        skipped: counts?.skipped ?? 0,
        uploadPending: uploadPending.length,
      });
    });
  };

  return (
    <div {...stylex.props(settingsSurface.container)}>
      <SettingsPageLead>{t('settings.workspaceData.lead')}</SettingsPageLead>
      {!canManage ? (
        <p data-testid="workspace-bundle-members-note" {...stylex.props(styles.result)}>
          {t('settings.workspaceData.ownersOnly')}
        </p>
      ) : (
        <CompactSection title={t('settings.workspaceData.title')}>
          <CompactRow
            label={t('settings.workspaceData.export.label')}
            helper={t('settings.workspaceData.export.helper')}
            info={t('settings.workspaceData.export.contents')}
          >
            <Button
              variant="secondary"
              size="small"
              data-testid="workspace-bundle-export"
              disabled={busy !== null}
              onClick={() => void onExport()}
            >
              {busy === 'export' ? <Spinner size="small" /> : null}
              {t('settings.workspaceData.export.button')}
            </Button>
          </CompactRow>
          <CompactRow
            label={t('settings.workspaceData.import.label')}
            helper={t('settings.workspaceData.import.helper')}
            info={t('settings.workspaceData.import.info')}
          >
            <Button
              variant="secondary"
              size="small"
              data-testid="workspace-bundle-choose"
              disabled={busy !== null}
              onClick={() => void onChoose()}
            >
              {busy === 'choose' || busy === 'import' ? <Spinner size="small" /> : null}
              {t('settings.workspaceData.import.button')}
            </Button>
          </CompactRow>
        </CompactSection>
      )}
      {exported ? (
        <p data-testid="workspace-bundle-export-result" {...stylex.props(styles.result)}>
          {t('settings.workspaceData.export.done', {
            file: exported.file,
            rooms: exported.rooms,
            gaps: exported.gaps,
          })}
        </p>
      ) : null}
      {imported ? (
        <p data-testid="workspace-bundle-import-result" {...stylex.props(styles.result)}>
          {t('settings.workspaceData.import.done', imported)}
        </p>
      ) : null}
      {error ? (
        <p data-testid="workspace-bundle-error" role="alert" {...stylex.props(styles.error)}>
          {error}
        </p>
      ) : null}
      <AlertDialog.Root
        open={review !== null}
        onOpenChange={(open) => {
          if (!open && busy !== 'import') setReview(null);
        }}
      >
        {review ? (
          <AlertDialog.Content>
            <AlertDialog.Header>
              <AlertDialog.Title>
                {t('settings.workspaceData.review.title', { file: review.fileName })}
              </AlertDialog.Title>
              <AlertDialog.Description>
                {t('settings.workspaceData.review.description')}
              </AlertDialog.Description>
            </AlertDialog.Header>
            <div data-testid="workspace-bundle-review" {...stylex.props(styles.review)}>
              <div {...stylex.props(styles.group)}>
                <span {...stylex.props(styles.heading)}>
                  {t('settings.workspaceData.review.changes')}
                </span>
                {review.summary.kinds.map((entry) => (
                  <div key={entry.kind} {...stylex.props(styles.row)}>
                    <span {...stylex.props(styles.name)}>
                      {t(`settings.workspaceData.kinds.${entry.kind}`)}
                    </span>
                    <span {...stylex.props(styles.value)}>{describeCounts(entry)}</span>
                  </div>
                ))}
              </div>
              {review.summary.skipped.length > 0 ? (
                <div {...stylex.props(styles.group)}>
                  <span {...stylex.props(styles.heading)}>
                    {t('settings.workspaceData.review.skipped', {
                      count: review.summary.skipped.length,
                    })}
                  </span>
                  {review.summary.skipped.map((item, index) => (
                    <div key={index} {...stylex.props(styles.row)}>
                      <span {...stylex.props(styles.name)}>
                        {item.label ?? t(`settings.workspaceData.unnamed.${item.kind}`)}
                      </span>
                      <span {...stylex.props(styles.value)}>
                        {item.reason === 'unauthorized' && item.detail
                          ? t('settings.workspaceData.skipReasons.unauthorized')
                          : SKIP_REASON_KEYS[item.reason]
                            ? t(SKIP_REASON_KEYS[item.reason]!)
                            : item.reason}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
              {review.summary.gaps > 0 ? (
                <span {...stylex.props(styles.note)}>
                  {t('settings.workspaceData.review.gaps', { count: review.summary.gaps })}
                </span>
              ) : null}
            </div>
            <AlertDialog.Footer>
              <AlertDialog.Cancel
                data-testid="workspace-bundle-cancel"
                disabled={busy === 'import'}
              >
                {t('common.cancel')}
              </AlertDialog.Cancel>
              <Button
                data-testid="workspace-bundle-confirm"
                disabled={busy === 'import'}
                onClick={onConfirm}
              >
                {busy === 'import' ? <Spinner size="small" /> : null}
                {t('settings.workspaceData.review.confirm')}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Content>
        ) : null}
      </AlertDialog.Root>
    </div>
  );
}

/** Desktop entry: the main-process bundle service and the active workspace. */
export function WorkspaceDataSetting() {
  const { activeOrganization, role } = useOrganization();
  const api = getIpcServices()?.workspaceBundle;
  if (!api || !activeOrganization) return null;
  return (
    <WorkspaceDataSettingContent
      workspaceId={activeOrganization.id}
      workspaceName={activeOrganization.name}
      canManage={role === 'owner' || role === 'admin'}
      api={api}
    />
  );
}
