import './posthog-browser.fixture';
import posthog from 'posthog-js';
import { createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { createStore, Provider } from 'jotai';
import { lodyControlConnectionStateAtom } from '../src/atoms/control-connection';
import { useWorkspaceSyncStuckReport } from '../src/hooks/use-workspace-sync-stuck-report';

Object.assign(window, {
  stuckPostHog: posthog,
  createWorkspaceSyncStuckProbe() {
    const store = createStore();
    store.set(lodyControlConnectionStateAtom, 'online');
    const root = createRoot(document.querySelector('main')!);
    function Probe({ stage, onCommitted }: { stage: string | null; onCommitted: () => void }) {
      useWorkspaceSyncStuckReport({
        targetSlug: 'STUCK_SLUG_SECRET',
        workspaceId: 'STUCK_WORKSPACE_SECRET',
        organizationsReady: true,
        docMetaScanErrorType: 'STUCK_PROVIDER_BODY_SECRET',
        scope: stage
          ? {
              status: 'switching',
              targetSlug: 'STUCK_SLUG_SECRET',
              blocker: stage as never,
            }
          : null,
      });
      useEffect(onCommitted, [onCommitted]);
      return null;
    }
    return {
      client: posthog,
      render(stage: string | null) {
        return new Promise<void>((onCommitted) => {
          flushSync(() =>
            root.render(
              createElement(Provider, { store }, createElement(Probe, { stage, onCommitted }))
            )
          );
        });
      },
      connection(state: 'online' | 'reconnecting') {
        flushSync(() => store.set(lodyControlConnectionStateAtom, state));
      },
      close() {
        flushSync(() => root.unmount());
      },
    };
  },
});
