/**
 * Shared MessageHandler test harness.
 *
 * Several suites drive `MessageHandler` against a real `LoroRepo` +
 * `SessionDocument` with a fake SessionManager, and each had grown its own copy
 * of the same silent logger, repo setup, and teardown. `createMessageHandlerHarness`
 * returns the untyped handler so each suite can cast it to whatever private
 * surface it exercises.
 */
import { vi } from 'vitest';
import { LoroRepo } from 'loro-repo';

import type { SessionId, WorkspaceId } from '@lody/shared';

import { MessageHandler } from '../src/lib/message-handler';
import { SessionDocument } from '../src/lib/loro/doc';
import type { LoroDocumentManager } from '../src/lib/loro/doc';
import type { SessionManager } from '../src/session/session-manager';
import type { Logger } from '../src/utils/logger';
import { createTestCloudPort } from './test-cloud-port';

export const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  setLevel: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

/**
 * loro-repo resolves create()/destroy() on the real clock (native async), not the
 * timers vitest fakes, so repo teardown has to run on real timers.
 */
export const destroyRepoOnRealTimers = async (repo: LoroRepo): Promise<void> => {
  if (vi.isFakeTimers()) {
    vi.useRealTimers();
  }
  await repo.destroy();
};

export type SessionManagerLifecycleListeners = {
  error?: (event: { sessionId: SessionId; error: Error; session: unknown }) => void;
  exit?: (event: { sessionId: SessionId; exitCode: number; session: unknown }) => void;
  terminated?: (event: { sessionId: SessionId; exitCode?: number; session: unknown }) => void;
};

export const createMessageHandlerHarness = async (sessionId: SessionId) => {
  const fakeTimersActive = vi.isFakeTimers();
  if (fakeTimersActive) {
    vi.useRealTimers();
  }
  const repo = await LoroRepo.create({});
  const doc = new SessionDocument(repo, sessionId);
  await doc.initOffline();
  if (fakeTimersActive) {
    vi.useFakeTimers();
  }

  const workspaceDocument = {
    isTransportConnected: vi.fn(() => true),
    markMachineFlockDocDirty: vi.fn(),
    registerMachine: vi.fn(),
    repo: {
      watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
      getDocMeta: vi.fn(async () => ({
        meta: { needToArchiveSessions: {}, needToDeleteSessions: {} },
      })),
    },
    getOrCreateSessionDoc: vi.fn(async () => doc),
  };

  const listeners: SessionManagerLifecycleListeners = {};
  const sessionManager = {
    on: vi.fn((event: string, listener: unknown) => {
      if (event === 'error' || event === 'exit' || event === 'terminated') {
        (listeners as Record<string, unknown>)[event] = listener;
      }
    }),
    setRequestPermissionHandler: vi.fn(),
    getSession: vi.fn(() => null),
    cleanUp: vi.fn(async () => {}),
  };

  const handler = new MessageHandler(
    sessionManager as unknown as SessionManager,
    workspaceDocument as unknown as LoroDocumentManager,
    createSilentLogger(),
    {
      token: 't',
      workspaceId: 'ws-1' as WorkspaceId,
      userId: 'u-1',
      machineId: 'm-1',
      machineName: 'machine',
      cliVersion: '0.0.0',
      cloudPort: createTestCloudPort(),
    }
  );

  return { repo, doc, handler, listeners, workspaceDocument, sessionManager };
};
