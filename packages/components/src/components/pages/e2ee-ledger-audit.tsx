import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { ledgerStateDigest } from '@lody/e2ee-core/protocol';
import { Result } from 'effect';
import type { PlatformE2eeWorkspaces } from '@lody/platform';
import { auditLedgerHistory } from '@/lib/e2ee-ledger-audit';
import { bytesToHex, type VerifiedLedgerHistory } from '@/lib/e2ee-ledger-history';

export function E2eeLedgerAudit({
  workspaceId,
  history,
  read,
}: {
  workspaceId: string;
  history: VerifiedLedgerHistory;
  read: PlatformE2eeWorkspaces['history'];
}) {
  const { t } = useTranslation();
  const active = useRef<AbortController | null>(null);
  const [state, setState] = useState<{
    phase: 'idle' | 'running' | 'done' | 'error';
    count: number;
    total: number;
  }>({ phase: 'idle', count: 0, total: 0 });
  useEffect(() => () => active.current?.abort(), []);
  const audit = async () => {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    const total = history.view.length;
    setState({ phase: 'running', count: 0, total });
    try {
      await auditLedgerHistory({
        workspaceId,
        genesisHash: bytesToHex(history.view.genesis.toBytes()),
        expected: {
          length: total,
          headHash: bytesToHex(history.view.head.toBytes()),
          stateDigest: bytesToHex(Result.getOrThrow(ledgerStateDigest(history.view)).toBytes()),
        },
        read,
        signal: controller.signal,
        progress: (count) => {
          if (!controller.signal.aborted) setState({ phase: 'running', count, total });
        },
      });
      if (!controller.signal.aborted) setState({ phase: 'done', count: total, total });
    } catch {
      if (!controller.signal.aborted) setState((previous) => ({ ...previous, phase: 'error' }));
    } finally {
      if (active.current === controller) active.current = null;
    }
  };
  return (
    <div>
      <Button variant="secondary" disabled={state.phase === 'running'} onClick={() => void audit()}>
        {t('e2ee.audit.start')}
      </Button>
      {state.phase === 'running' && (
        <Button
          variant="ghost"
          onClick={() => {
            active.current?.abort();
            active.current = null;
            setState({ phase: 'idle', count: 0, total: 0 });
          }}
        >
          {t('common.cancel')}
        </Button>
      )}
      {state.phase !== 'idle' && (
        <p role={state.phase === 'error' ? 'alert' : 'status'}>
          {t(`e2ee.audit.${state.phase}`, { count: state.count, total: state.total })}
        </p>
      )}
    </div>
  );
}
