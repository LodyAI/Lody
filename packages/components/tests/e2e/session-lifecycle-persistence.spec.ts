import { expect, test } from '@playwright/test';

test('durably admits lifecycle records across connections, failures, and reload', async ({
  page,
}) => {
  await page.goto(
    '/iframe.html?id=infrastructure-sessionlifecyclepersistence--browser-harness&viewMode=story'
  );
  await expect(page.getByTestId('session-lifecycle-persistence-ready')).toBeVisible();
  const testWorkspaceId = `playwright-${Date.now()}`;

  const first = await page.evaluate(async (evaluatedWorkspaceId) => {
    const harness = (
      window as typeof window & {
        __lodySessionLifecyclePersistence: {
          createStore: typeof import('../../src/lib/session-lifecycle-persistence').createIndexedDbSessionLifecycleAdmissionStore;
        };
      }
    ).__lodySessionLifecyclePersistence;
    const before = await harness.createStore({
      workspaceId: evaluatedWorkspaceId,
      faults: {
        beforeWrite: () => {
          throw new Error('before write');
        },
      },
    });
    const makeDraft = (operationId: string) => ({
      operationId,
      subjectId: 'root',
      targetIds: ['root', 'child'],
      state: 'archived' as const,
    });
    let beforeError = '';
    try {
      await before.admit(makeDraft('before'), 'browser-a', '0');
    } catch (error) {
      beforeError = error instanceof Error ? error.message : String(error);
    }
    const missingBefore = (await before.get('before')) === undefined;
    await before.close?.();

    const after = await harness.createStore({
      workspaceId: evaluatedWorkspaceId,
      faults: {
        afterCommit: () => {
          throw new Error('after commit');
        },
      },
    });
    let afterError = '';
    try {
      await after.admit(makeDraft('after'), 'browser-a', '0');
    } catch (error) {
      afterError = error instanceof Error ? error.message : String(error);
    }
    const durableAfter = await after.get('after');
    await after.close?.();
    return { beforeError, missingBefore, afterError, durableAfter };
  }, testWorkspaceId);

  expect(first).toMatchObject({
    beforeError: 'before write',
    missingBefore: true,
    afterError: 'after commit',
    durableAfter: {
      published: false,
      operation: { operationId: 'after', order: { counter: '1', actorId: 'browser-a' } },
    },
  });

  await page.reload();
  await expect(page.getByTestId('session-lifecycle-persistence-ready')).toBeVisible();
  const recovered = await page.evaluate(async (evaluatedWorkspaceId) => {
    const harness = (
      window as typeof window & {
        __lodySessionLifecyclePersistence: {
          createStore: typeof import('../../src/lib/session-lifecycle-persistence').createIndexedDbSessionLifecycleAdmissionStore;
          getDatabaseName: typeof import('../../src/lib/session-lifecycle-persistence').getSessionLifecycleIndexedDbName;
        };
      }
    ).__lodySessionLifecyclePersistence;
    const primaryStore = await harness.createStore({ workspaceId: evaluatedWorkspaceId });
    const secondaryStore = await harness.createStore({ workspaceId: evaluatedWorkspaceId });
    const makeDraft = (operationId: string) => ({
      operationId,
      subjectId: 'root',
      targetIds: ['root', 'child'],
      state: 'active' as const,
    });
    const [one, two] = await Promise.all([
      primaryStore.admit(makeDraft('one'), 'browser-a', '40'),
      secondaryStore.admit(makeDraft('two'), 'browser-b', '40'),
    ]);
    await primaryStore.markPublished('one');
    const rows = await secondaryStore.list();
    await primaryStore.close?.();
    await secondaryStore.close?.();
    const dbName = harness.getDatabaseName(evaluatedWorkspaceId);
    const deleted = new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(dbName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    await deleted;
    return { counters: [one.operation.order.counter, two.operation.order.counter], rows };
  }, testWorkspaceId);

  expect(new Set(recovered.counters)).toEqual(new Set(['41', '42']));
  expect(recovered.rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ operation: expect.objectContaining({ operationId: 'after' }) }),
      expect.objectContaining({
        operation: expect.objectContaining({ operationId: 'one' }),
        published: true,
      }),
      expect.objectContaining({
        operation: expect.objectContaining({ operationId: 'two' }),
        published: false,
      }),
    ])
  );
});
