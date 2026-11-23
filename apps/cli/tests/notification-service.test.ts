import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificationService } from '../src/lib/notifications/notification-service';
import type { Logger } from '../src/utils/logger';
const createSilentLogger = (): Logger => ({
  info() {},
  warn() {},
  error() {},
  success() {},
  debug() {},
  trace() {},
  setLevel() {},
  child: createSilentLogger,
  close: async () => {},
});
import type { SessionId, WorkspaceId } from '@lody/shared';

const input = {
  sessionId: 'session-1' as SessionId,
  occurrenceId: 'turn-1',
  workspaceId: 'workspace-1' as WorkspaceId,
  workspaceSlug: 'workspace',
  userId: 'user-1',
  sessionTitle: 'Private title',
};
function setup(rejectSend = false) {
  const submitted: Array<{ path: string; args: Record<string, unknown>[] }> = [];
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    submitted.push(request);
    if (rejectSend) throw new Error('uncertain');
    return new Response(JSON.stringify({ status: 'success', value: null }), { status: 200 });
  });
  return {
    submitted,
    service: new NotificationService({
      convexUrl: 'https://example.convex.cloud',
      cliToken: 'synthetic-token',
      logger: createSilentLogger(),
    }),
  };
}
afterEach(() => vi.unstubAllGlobals());
describe('notification transport', () => {
  it('represents failure on modern servers and never retries an uncertain send via legacy', async () => {
    const { service, submitted } = setup(true);
    await service.notifySessionCompleted({ ...input, outcome: 'failed' });
    expect(submitted.map((r) => r.args[0]?.outcome)).toEqual(['failed']);
    expect(submitted[0]?.path).toBe('notifications:notifySessionCompleted');
    expect(submitted[0]?.args[0]).not.toHaveProperty('sessionTitle');
  });
  it('attempts each new outcome after an earlier transport failure without probing capabilities', async () => {
    const { service, submitted } = setup(true);
    for (const outcome of ['succeeded', 'failed', 'unknown'] as const)
      await service.notifySessionCompleted({ ...input, outcome });
    expect(submitted.map((r) => r.args[0]?.outcome)).toEqual(['succeeded', 'failed', 'unknown']);
    expect(submitted.every((r) => r.path === 'notifications:notifySessionCompleted')).toBe(true);
    expect(submitted.every((r) => !('sessionTitle' in r.args[0]!))).toBe(true);
  });
  it('carries bounded display context for both result and request notifications', async () => {
    const { service, submitted } = setup();
    const presentation = {
      kind: 'schedule' as const,
      conversationTitle: 'Dependency review',
      scheduleName: 'Daily check',
      projectName: 'lody',
      pullRequestNumber: 1555,
    };
    await service.notifySessionCompleted({ ...input, presentation, outcome: 'failed' });
    await service.notifyPermissionRequested({
      ...input,
      presentation,
      requestId: 'request',
      toolCallId: 'tool',
      toolTitle: '/private/path',
      toolKind: 'execute',
    });
    expect(submitted.map((r) => r.args[0]?.presentation)).toEqual([presentation, presentation]);
    expect(JSON.stringify(submitted)).not.toContain('/private/path');
  });
  it('sends generic versioned permission alerts without private titles', async () => {
    const { service, submitted } = setup();
    await service.notifyPermissionRequested({
      ...input,
      requestId: 'request-1',
      toolCallId: 'tool-1',
      toolTitle: 'Read',
      toolKind: 'read',
    });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.args[0]).toMatchObject({
      deliveryVersion: 1,
      requestId: 'request-1',
      toolCallId: 'tool-1',
    });
    expect(submitted[0]?.args[0]).not.toHaveProperty('sessionTitle');
    expect(submitted[0]?.args[0]).not.toHaveProperty('toolTitle');
  });
});
