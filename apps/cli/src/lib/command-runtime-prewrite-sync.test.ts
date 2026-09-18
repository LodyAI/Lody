import { expect, it, vi } from 'vitest';
import { syncWorkspaceMetaForRead, WorkspaceSyncUnavailableError } from './command-runtime';

it('does not suggest --offline when a prewrite metadata sync fails', async () => {
  const syncError = new Error('metadata unavailable');
  const manager = {
    syncMetaOrThrow: vi.fn(async () => {
      throw syncError;
    }),
  };

  const error = await syncWorkspaceMetaForRead(manager, 'session.restore:session-1:prewrite').catch(
    (caught: unknown) => caught
  );

  expect(error).toBeInstanceOf(WorkspaceSyncUnavailableError);
  expect(error).toMatchObject({ cause: syncError });
  expect(error).toHaveProperty('message', expect.stringContaining('no changes were written'));
  expect(error).toHaveProperty('message', expect.not.stringContaining('--offline'));
  expect(manager.syncMetaOrThrow).toHaveBeenCalledWith({
    reason: 'session.restore:session-1:prewrite',
  });
});
