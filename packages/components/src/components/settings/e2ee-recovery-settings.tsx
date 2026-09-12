import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCloudMutation, useCloudQuery } from '@lody/platform/react';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { getIpcServices, type IpcServices } from '@/lib/electron-ipc-client';
import { isElectronRenderer } from '@/lib/electron';
import { useAppCapability } from '@/lib/app-platform';
import { Button } from '@/ui/button';
import { CompactRow, CompactSection } from './compact-layout';

type Draft = NonNullable<Awaited<ReturnType<IpcServices['auth']['exportRecoveryBackup']>>>;

export function E2eeRecoverySettings({ accountId }: { accountId: string }) {
  const cloud = useAppCapability('cloudAccount');
  if (!cloud || !isElectronRenderer()) return null;
  return <AvailableRecovery key={accountId} accountId={accountId} />;
}

function AvailableRecovery({ accountId }: { accountId: string }) {
  const available = useCloudQuery(cloudOperations.e2eeRecovery.availability, {});
  return available?.enabled ? (
    <div className="space-y-4">
      <RecoveryFlow accountId={accountId} />
      <RestoreFlow accountId={accountId} />
    </div>
  ) : null;
}

function RestoreFlow({ accountId }: { accountId: string }) {
  const { t } = useTranslation();
  const [backupId, setBackupId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [restored, setRestored] = useState(false);
  const mounted = useRef(false);
  const running = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const backup = useCloudQuery(cloudOperations.e2eeRecovery.get, backupId ? { backupId } : 'skip');
  const matches = Boolean(backup && backup.accountId === accountId && backup.backupId === backupId);
  async function run(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setFailed(false);
    try {
      await action();
    } catch {
      if (mounted.current) setFailed(true);
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function select() {
    const ipc = getIpcServices();
    if (!ipc) throw new Error('recovery-unavailable');
    const result = await ipc.auth.selectRecoveryBackup();
    if (!mounted.current || !result) return;
    if (result.accountId !== accountId) throw new Error('recovery-account-mismatch');
    setBackupId(result.backupId);
  }
  async function restore() {
    if (!backup || !matches) throw new Error('recovery-readback-mismatch');
    const ipc = getIpcServices();
    if (!ipc) throw new Error('recovery-unavailable');
    const result = await ipc.auth.restoreRecoveryBackup({
      ...backup,
      ciphertext: new Uint8Array(backup.ciphertext),
    });
    if (!mounted.current || !result) return;
    if (result.accountId !== accountId || result.fingerprint !== backup.identity)
      throw new Error('recovery-verification-mismatch');
    setRestored(true);
  }
  return (
    <CompactSection title={t('e2ee.restore.title')} description={t('e2ee.restore.description')}>
      <CompactRow label={t('e2ee.restore.file')} helper={t('e2ee.restore.fileHint')}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || restored}
          onClick={() => void run(select)}
        >
          {t('e2ee.restore.select')}
        </Button>
      </CompactRow>
      {backupId ? (
        <CompactRow label={t('e2ee.restore.confirm')} helper={t('e2ee.restore.confirmHint')}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || !matches || restored}
            onClick={() => void run(restore)}
          >
            {t('e2ee.restore.action')}
          </Button>
        </CompactRow>
      ) : null}
      {backupId && backup === null ? (
        <p className="px-3 py-2 text-sm" role="status">
          {t('e2ee.restore.missing')}
        </p>
      ) : null}
      {busy ? (
        <p className="px-3 py-2 text-sm" role="status">
          {t('e2ee.recovery.working')}
        </p>
      ) : null}
      {failed ? (
        <p className="px-3 py-2 text-sm text-destructive" role="alert">
          {t('e2ee.restore.error')}
        </p>
      ) : null}
      {restored ? (
        <p className="px-3 py-2 text-sm" role="status">
          {t('e2ee.restore.done')}
        </p>
      ) : null}
    </CompactSection>
  );
}

function RecoveryFlow({ accountId }: { accountId: string }) {
  const { t } = useTranslation();
  const put = useCloudMutation(cloudOperations.e2eeRecovery.put);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [verified, setVerified] = useState(false);
  const [storedApart, setStoredApart] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const mounted = useRef(false);
  const running = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const remote = useCloudQuery(
    cloudOperations.e2eeRecovery.get,
    draft ? { backupId: draft.backupId, revision: draft.revision } : 'skip'
  );
  const matches = Boolean(
    draft &&
    remote &&
    remote.accountId === accountId &&
    remote.backupId === draft.backupId &&
    remote.identity === draft.identity &&
    remote.revision === draft.revision &&
    remote.ciphertext.byteLength === draft.ciphertext.length &&
    new Uint8Array(remote.ciphertext).every((byte, i) => byte === draft.ciphertext[i])
  );
  function assertCurrent() {
    if (!mounted.current) throw new Error('recovery-view-closed');
  }
  async function run(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(false);
    try {
      await action();
    } catch {
      if (mounted.current) setError(true);
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function upload(value: Draft) {
    assertCurrent();
    if (value.accountId !== accountId) throw new Error('recovery-account-mismatch');
    await put({ ...value, ciphertext: new Uint8Array(value.ciphertext).buffer });
    assertCurrent();
  }
  async function start() {
    const ipc = getIpcServices();
    if (!ipc) throw new Error('recovery-unavailable');
    // This deliberately does not create an identity when it is absent or locked.
    const value = await ipc.auth.exportRecoveryBackup(0);
    assertCurrent();
    if (!value) return;
    if (value.accountId !== accountId) throw new Error('recovery-account-mismatch');
    setDraft(value);
    await upload(value);
  }
  async function verify() {
    if (!draft || !remote || !matches) throw new Error('recovery-readback-mismatch');
    const result = await getIpcServices()?.auth.verifyRecoveryBackup(
      draft.revision,
      new Uint8Array(remote.ciphertext)
    );
    assertCurrent();
    if (!result) return;
    if (
      result.backupId !== draft.backupId ||
      result.identity !== draft.identity ||
      result.revision !== draft.revision
    )
      throw new Error('recovery-verification-mismatch');
    setVerified(true);
  }
  const buttonClass =
    'rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring';
  return (
    <CompactSection title={t('e2ee.recovery.title')} description={t('e2ee.recovery.description')}>
      <CompactRow label={t('e2ee.recovery.save')} helper={t('e2ee.recovery.saveHint')}>
        <button
          type="button"
          className={buttonClass}
          disabled={busy || draft !== null}
          onClick={() => void run(start)}
        >
          {t('e2ee.recovery.export')}
        </button>
        {draft && !matches ? (
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={() => void run(() => upload(draft))}
          >
            {t('e2ee.recovery.retryUpload')}
          </button>
        ) : null}
      </CompactRow>
      {draft ? (
        <CompactRow
          label={t('e2ee.recovery.verify')}
          helper={t(matches ? 'e2ee.recovery.readBack' : 'e2ee.recovery.waiting')}
        >
          <button
            type="button"
            className={buttonClass}
            disabled={busy || !matches || verified}
            onClick={() => void run(verify)}
          >
            {t('e2ee.recovery.choose')}
          </button>
        </CompactRow>
      ) : null}
      {verified && matches ? (
        <div className="space-y-2 px-3 py-2">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={storedApart}
              disabled={confirmed}
              onChange={(event) => setStoredApart(event.target.checked)}
            />
            {t('e2ee.recovery.separate')}
          </label>
          <button
            type="button"
            className={buttonClass}
            disabled={!storedApart || confirmed}
            onClick={() => setConfirmed(true)}
          >
            {t('e2ee.recovery.confirm')}
          </button>
          {confirmed ? <p role="status">{t('e2ee.recovery.confirmed')}</p> : null}
        </div>
      ) : null}
      {busy ? (
        <p className="px-3 py-2 text-sm" role="status">
          {t('e2ee.recovery.working')}
        </p>
      ) : null}
      {error ? (
        <p className="px-3 py-2 text-sm text-destructive" role="alert">
          {t('e2ee.recovery.error')}
        </p>
      ) : null}
      <p className="px-3 py-2 text-xs text-muted-foreground">{t('e2ee.recovery.optional')}</p>
    </CompactSection>
  );
}
