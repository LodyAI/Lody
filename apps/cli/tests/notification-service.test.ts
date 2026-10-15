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
function setup(modern: boolean, rejectSend = false) {
  const submitted: Array<{ path: string; args: Record<string, unknown>[] }> = [];
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    if (request.path === 'notifications:getCapabilities') {
      return new Response(
        JSON.stringify(
          modern
            ? { status: 'success', value: { terminalOutcomes: 1 } }
            : { status: 'error', errorMessage: 'Could not find public function' }
        ),
        { status: modern ? 200 : 400 }
      );
    }
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
describe('notification protocol compatibility', () => {
  it('represents failure on modern servers and never retries an uncertain send via legacy', async () => {
    const { service, submitted } = setup(true, true);
    await service.notifySessionCompleted({ ...input, outcome: 'failed' });
    expect(submitted.map((r) => r.args[0]?.outcome)).toEqual(['failed']);
    expect(submitted[0]?.path).toBe('notifications:notifySessionCompleted');
    expect(submitted[0]?.args[0]).not.toHaveProperty('sessionTitle');
  });
  it('uses the original argument shape for success on old servers and never calls failure completed', async () => {
    const { service, submitted } = setup(false);
    await service.notifySessionCompleted({ ...input, outcome: 'succeeded' });
    await service.notifySessionCompleted({ ...input, outcome: 'failed' });
    await service.notifySessionCompleted({ ...input, outcome: 'unknown' });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.args[0]).toMatchObject({ occurrenceId: 'turn-1', userId: 'user-1' });
    expect(submitted[0]?.args[0]).not.toHaveProperty('outcome');
  });
  it.each([true, false])(
    'negotiates permission delivery without changing old call shapes (%s)',
    async (modern) => {
      const { service, submitted } = setup(modern);
      await service.notifyPermissionRequested({
        ...input,
        requestId: 'request-1',
        toolCallId: 'tool-1',
        toolTitle: 'Read',
        toolKind: 'read',
      });
      expect(submitted[0]?.args[0]?.deliveryVersion).toBe(modern ? 1 : undefined);
      expect(submitted[0]?.args[0]?.sessionTitle).toBe(modern ? undefined : 'Private title');
      expect(submitted[0]?.args[0]?.toolTitle).toBe(modern ? undefined : 'Read');
      expect(submitted[0]?.args[0]).toMatchObject({ requestId: 'request-1', toolCallId: 'tool-1' });
    }
  );
});
