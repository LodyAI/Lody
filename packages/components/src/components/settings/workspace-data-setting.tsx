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

/**
 * Settings > Data: export the whole workspace to a bundle file, or merge one in
 * (specs/workspace-export-import.md). Desktop only: main shows the file dialogs and
 * the local agent does the work. Owners and admins only.
 */
export type WorkspaceBundleApi = {
  exportWorkspace(input: {
    workspaceId: string;
    workspaceName: string;
  }): Promise<
    | { status: 'canceled' }
    | { status: 'done'; summary: unknown }
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
  }): Promise<{ status: 'planned'; plan: unknown } | { status: 'error'; message: string }>;
  importWorkspace(input: {
    workspaceId: string;
    token: string;
  }): Promise<{ status: 'done'; outcome: unknown } | { status: 'error'; message: string }>;
};

type Record_ = Record<string, unknown>;
const asRecord = (value: unknown): Record_ =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record_) : {};
const asNumber = (value: unknown): number => (typeof value === 'number' ? value : 0);

export type ImportPlanSummary = {
  newRooms: number;
  updatedRooms: number;
  unchangedRooms: number;
  metadata: { added: number; updated: number; deleted: number };
  skipped: Array<{ id: string; reason: string; detail: string | null }>;
  gaps: number;
};

/** What a dry run says the import would do, read defensively from the daemon's plan. */
export function summarizeImportPlan(plan: unknown): ImportPlanSummary {
  const rooms = Array.isArray(asRecord(plan).rooms)
    ? (asRecord(plan).rooms as unknown[]).map(asRecord)
    : [];
  const bodies = rooms.filter((room) => room.model !== 'meta' && room.action === 'merge');
  const count = (state: string) => bodies.filter((room) => room.state === state).length;
  const metaRows = asRecord(rooms.find((room) => room.model === 'meta')?.rows);
  const gaps = asRecord(plan).gaps;
  return {
    newRooms: count('new'),
    updatedRooms: count('merge'),
    unchangedRooms: count('unchanged'),
    metadata: {
      added: asNumber(metaRows.added),
      updated: asNumber(metaRows.updated),
      deleted: asNumber(metaRows.deleted),
    },
    skipped: rooms
      .filter((room) => room.action === 'skip')
      .map((room) => ({
        id: String(room.id ?? ''),
        reason: String(room.reason ?? ''),
        detail: typeof room.detail === 'string' ? room.detail : null,
      })),
    gaps: Array.isArray(gaps) ? gaps.length : 0,
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
  list: {
    margin: 0,
    paddingInlineStart: space[4],
    display: 'flex',
    flexDirection: 'column',
    gap: space[1],
  },
  review: { display: 'flex', flexDirection: 'column', gap: space[2], fontSize: text.footnoteSize },
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
      const summary = asRecord(result.summary);
      setExported({
        file: String(summary.file ?? ''),
        rooms: asNumber(summary.rooms),
        gaps: Array.isArray(summary.gaps) ? summary.gaps.length : 0,
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
      const outcome = asRecord(result.outcome);
      const counts = asRecord(outcome.result);
      setImported({
        imported: asNumber(counts.imported),
        skipped: asNumber(counts.skipped),
        uploadPending: Array.isArray(outcome.uploadPending) ? outcome.uploadPending.length : 0,
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
              <AlertDialog.Title>{t('settings.workspaceData.review.title')}</AlertDialog.Title>
              <AlertDialog.Description>
                {t('settings.workspaceData.review.description', { file: review.fileName })}
              </AlertDialog.Description>
            </AlertDialog.Header>
            <div data-testid="workspace-bundle-review" {...stylex.props(styles.review)}>
              <span>{review.fileName}</span>
              <span>
                {t('settings.workspaceData.review.rooms', {
                  newRooms: review.summary.newRooms,
                  updatedRooms: review.summary.updatedRooms,
                  unchangedRooms: review.summary.unchangedRooms,
                })}
              </span>
              <span>{t('settings.workspaceData.review.metadata', review.summary.metadata)}</span>
              {review.summary.gaps > 0 ? (
                <span>
                  {t('settings.workspaceData.review.gaps', { count: review.summary.gaps })}
                </span>
              ) : null}
              {review.summary.skipped.length > 0 ? (
                <>
                  <span>{t('settings.workspaceData.review.skipped')}</span>
                  <ul {...stylex.props(styles.list)}>
                    {review.summary.skipped.map((room) => (
                      <li key={room.id}>
                        {room.id}
                        {' — '}
                        {SKIP_REASON_KEYS[room.reason]
                          ? t(SKIP_REASON_KEYS[room.reason]!)
                          : room.reason}
                        {room.detail ? ` (${room.detail})` : ''}
                      </li>
                    ))}
                  </ul>
                </>
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
