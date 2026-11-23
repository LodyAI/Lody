import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Alert } from '@lody/ui/alert';
import { AlertDialog } from '@lody/components/ui/dialog';
import {
  MobileSettingsRow,
  MobileSettingsSection,
} from '@lody/components/components/mobile/mobile-settings-row';
import type { MobileRecoveryConfig } from './recovery-context';
import type { MobileRecovery, MobileRecoverySummary, MobileSecurityEvent } from '../e2ee/recovery';
import { mobileRecoveryCopy } from './recovery-copy';

type FileAction =
  | { kind: 'list' | 'refresh' }
  | { kind: 'add'; label: string }
  | { kind: 'remove'; entryId: string };

/** Account-scoped panel. It never keeps a recovery file or an unlocked session in React state. */
export function MobileRecoverySettings({
  service,
  run,
  defaultLabel,
}: {
  service: MobileRecovery;
  run: MobileRecoveryConfig['run'];
  defaultLabel: MobileRecoveryConfig['defaultLabel'];
}) {
  const { t, i18n } = useTranslation();
  const tr = (key: keyof typeof mobileRecoveryCopy.en, values = {}) =>
    t(key, { defaultValue: mobileRecoveryCopy.en[key], ...values });
  const [summary, setSummary] = useState<MobileRecoverySummary>();
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<'added' | 'removed'>();
  const [refresh, setRefresh] = useState<'needed' | 'failed'>();
  const [events, setEvents] = useState<readonly MobileSecurityEvent[]>([]);
  const [naming, setNaming] = useState<string>();
  const [removing, setRemoving] = useState<{ entryId: string; label: string }>();
  const fileInput = useRef<HTMLInputElement>(null);
  const fileAction = useRef<FileAction>({ kind: 'list' });
  const busyRef = useRef(false);
  const live = useRef(true);
  const currentService = useRef(service);
  currentService.current = service;
  const refreshEvents = useCallback(async () => {
    try {
      const next = await run(service.events());
      if (live.current && currentService.current === service) {
        setEvents(next);
      }
    } catch {
      if (live.current && currentService.current === service) setEvents([]);
    }
  }, [run, service]);
  useEffect(() => {
    live.current = true;
    void run(service.available()).then(
      (value) => {
        if (live.current && currentService.current === service) setAvailable(value);
      },
      () => undefined
    );
    void refreshEvents();
    return () => {
      live.current = false;
    };
  }, [service, run, refreshEvents]);
  const perform = async (
    work: (completed: () => boolean) => Promise<MobileRecoverySummary | undefined>,
    action?: 'add' | 'remove' | 'refresh'
  ) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    if (action === 'add' || action === 'remove') setNotice(undefined);
    let completed = false;
    try {
      const result = await work(() => {
        completed = true;
        if (!live.current || currentService.current !== service) return false;
        // A confirmed mutation stands even if its separate list refresh fails.
        setNotice(action === 'add' ? 'added' : 'removed');
        setSummary(undefined);
        setRefresh('needed');
        return true;
      });
      if (live.current && currentService.current === service && result) {
        setSummary(result);
        setRefresh(undefined);
      }
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : '';
      if (
        live.current &&
        currentService.current === service &&
        code !== 'e2ee_recovery_cancelled'
      ) {
        if (completed || action === 'refresh') setRefresh('failed');
        else setError(action === 'remove' ? 'remove' : code);
      }
    } finally {
      busyRef.current = false;
      if (live.current && currentService.current === service) setBusy(false);
    }
  };
  const chooseFile = (action: FileAction) => {
    if (busyRef.current) return;
    fileAction.current = action;
    fileInput.current?.click();
  };
  return (
    <>
      <MobileSettingsSection
        title={tr('mobileRecovery.title')}
        description={t('e2ee.recovery.explanation')}
      >
        <div className="flex flex-wrap gap-2 p-4">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => chooseFile({ kind: refresh ? 'refresh' : 'list' })}
          >
            {tr('mobileRecovery.openFile')}
          </Button>
          {available && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void perform(() => run(service.list('passkey')), refresh ? 'refresh' : undefined)
              }
            >
              {tr('mobileRecovery.openPasskey')}
            </Button>
          )}
          {available && (
            <Button
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const label = await defaultLabel().catch(() => 'Lody mobile');
                  if (live.current && currentService.current === service) setNaming(label);
                  return undefined;
                })
              }
            >
              {t('e2ee.recovery.passkeyAdd')}
            </Button>
          )}
        </div>
        <input
          ref={fileInput}
          type="file"
          hidden
          aria-label={tr('mobileRecovery.openFile')}
          onChange={(event) => {
            const selected = event.target.files?.[0];
            event.target.value = '';
            if (!selected) return;
            const action = fileAction.current;
            void perform(
              async (completed) => {
                if (selected.size < 1 || selected.size > 4096)
                  throw new Error('e2ee_recovery_invalid-input');
                const file = new Uint8Array(await selected.arrayBuffer());
                try {
                  if (!live.current) return undefined;
                  if (action.kind === 'add' || action.kind === 'remove') {
                    if (action.kind === 'add') await run(service.add(file, action.label));
                    else await run(service.remove({ file }, action.entryId));
                    if (!completed()) return undefined;
                  }
                  return await run(service.list({ file }));
                } finally {
                  file.fill(0);
                }
              },
              action.kind === 'list' ? undefined : action.kind
            );
          }}
        />
        {summary && (
          <>
            <div className="px-4 pb-3" role="status">
              {tr('mobileRecovery.opened', { count: summary.workspaces })}
            </div>
            {summary.passkeys.length === 0 ? (
              <p className="px-4 pb-4">{t('e2ee.recovery.passkeyNone')}</p>
            ) : (
              summary.passkeys.map((row) => (
                <MobileSettingsRow
                  key={row.entryId}
                  label={<span style={{ overflowWrap: 'anywhere' }}>{row.label}</span>}
                  hasDivider
                >
                  <Button variant="secondary" disabled={busy} onClick={() => setRemoving(row)}>
                    {t('e2ee.recovery.passkeyRemove')}
                  </Button>
                </MobileSettingsRow>
              ))
            )}
          </>
        )}
        {notice && (
          <p className="p-4" role="status">
            {t(notice === 'added' ? 'e2ee.recovery.passkeyAdded' : 'e2ee.recovery.passkeyRemoved')}
          </p>
        )}
        {refresh && (
          <div className="p-4" role={refresh === 'failed' ? 'alert' : 'status'}>
            <p>
              {tr(
                refresh === 'failed'
                  ? 'mobileRecovery.refreshFailed'
                  : 'mobileRecovery.refreshNeeded'
              )}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => chooseFile({ kind: 'refresh' })}
              >
                {tr('mobileRecovery.refreshFile')}
              </Button>
              {available && (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void perform(() => run(service.list('passkey')), 'refresh')}
                >
                  {tr('mobileRecovery.refreshPasskey')}
                </Button>
              )}
            </div>
          </div>
        )}
        {error && (
          <Alert.Root>
            <Alert.Description>
              {error === 'remove'
                ? tr('mobileRecovery.removeFailed')
                : t(
                    error === 'e2ee_recovery_prf-unavailable'
                      ? 'e2ee.recovery.passkeyUnsupported'
                      : error === 'e2ee_recovery_authentication' ||
                          error === 'e2ee_recovery_invalid-input'
                        ? 'e2ee.recovery.wrongFile'
                        : error === 'e2ee_recovery_replacing'
                          ? 'e2ee.recovery.replacingElsewhere'
                          : 'e2ee.recovery.failed'
                  )}
            </Alert.Description>
          </Alert.Root>
        )}
      </MobileSettingsSection>
      {events.length > 0 && (
        <MobileSettingsSection title={t('e2ee.recovery.securityEvents')}>
          {events.map((event, index) => (
            <MobileSettingsRow
              key={`${event.kind}:${event.occurredAt}:${index}`}
              hasDivider={index > 0}
              label={t(
                event.kind === 'personal_device_recovered'
                  ? 'e2ee.recovery.eventRecovered'
                  : event.kind === 'vault_replacement_finished'
                    ? 'e2ee.recovery.eventReplaced'
                    : 'e2ee.recovery.eventReplacing',
                { time: new Date(event.occurredAt).toLocaleString(i18n.language.replace('_', '-')) }
              )}
            />
          ))}
        </MobileSettingsSection>
      )}
      <AlertDialog.Root
        open={naming !== undefined}
        onOpenChange={(open) => {
          if (!open) setNaming(undefined);
        }}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>{t('e2ee.recovery.passkeyNameTitle')}</AlertDialog.Title>
            <AlertDialog.Description>{t('e2ee.recovery.passkeyNameHelp')}</AlertDialog.Description>
          </AlertDialog.Header>
          <Input
            aria-label={t('e2ee.recovery.passkeyNameTitle')}
            value={naming ?? ''}
            maxLength={64}
            onChange={(event) => setNaming(event.target.value)}
          />
          <AlertDialog.Footer>
            <AlertDialog.Cancel>{t('common.cancel')}</AlertDialog.Cancel>
            <Button
              disabled={busy || !naming?.trim()}
              onClick={() => {
                const label = naming ?? '';
                setNaming(undefined);
                chooseFile({ kind: 'add', label });
              }}
            >
              {t('e2ee.recovery.passkeyAdd')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
      <AlertDialog.Root
        open={removing !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemoving(undefined);
        }}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>
              {t('e2ee.recovery.passkeyRemoveTitle', { name: removing?.label ?? '' })}
            </AlertDialog.Title>
            <AlertDialog.Description>
              {t('e2ee.recovery.passkeyRemoveBody')}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel disabled={busy}>{t('common.cancel')}</AlertDialog.Cancel>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                const row = removing;
                setRemoving(undefined);
                if (row) chooseFile({ kind: 'remove', entryId: row.entryId });
              }}
            >
              {tr('mobileRecovery.removeFile')}
            </Button>
            {available && (
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  const row = removing;
                  setRemoving(undefined);
                  if (row)
                    void perform(async (completed) => {
                      await run(service.remove('passkey', row.entryId));
                      completed();
                      return undefined;
                    }, 'remove');
                }}
              >
                {tr('mobileRecovery.removePasskey')}
              </Button>
            )}
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </>
  );
}
