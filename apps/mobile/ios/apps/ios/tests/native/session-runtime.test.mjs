import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { LoroDoc, LoroMap, LoroList, LoroText } from 'loro-crdt/base64';
import { Flock } from '@loro-dev/flock-wasm/base64';
import { openTestSession, loadRuntime, frame } from '../helpers.mjs';

test('an existing legacy Loro history opens while session metadata is unavailable', async () => {
  const resolveTarget = () => undefined;
  resolveTarget.isCurrent = () => true;
  resolveTarget.legacyFallbackAllowed = () => true;
  const fixture = await openTestSession({
    resolveTarget,
    seedServer(doc) {
      doc.getList('history').push({
        id: 'legacy',
        role: 'user',
        timestamp: '2026-01-01',
        items: [{ type: 'text', text: 'Earlier' }],
      });
      doc.commit();
    },
  });
  try {
    assert.equal(fixture.events.at(-1).entries[0].id, 'legacy');
    assert.equal(
      fixture.runtime.canUseLegacyHistory(fixture.server, false),
      false,
    );
    fixture.server.getMap('roostHistoryCursor').set('cursor', 'retired');
    fixture.server.commit();
    assert.equal(
      fixture.runtime.canUseLegacyHistory(fixture.server, true),
      false,
    );
  } finally {
    fixture.close();
  }
});

test('control stream catchup happens before choosing a legacy history backend', async () => {
  let caughtUp = false;
  const reads = [];
  const resolveTarget = () =>
    caughtUp
      ? {
          backend: 'roost',
          machineId: 'm1',
          incremental: true,
          watch: true,
          acceptsInput: true,
          dispatchesInput: true,
        }
      : undefined;
  resolveTarget.isCurrent = () => true;
  resolveTarget.legacyFallbackAllowed = () => true;
  const fixture = await openTestSession({
    resolveTarget,
    seedServer(doc) {
      doc.getList('history').push({
        id: 'stale',
        role: 'user',
        timestamp: '2026-01-01',
        items: [],
      });
      doc.commit();
    },
    catchupServer(doc) {
      doc.getMap('roostHistoryCursor').set('cursor', 'retired');
      doc.commit();
      caughtUp = true;
    },
    async onRpc(request, runtime, signal) {
      if (request.method === 'session/history-watch')
        return new Promise((_resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => reject(new Error('cancelled')),
            { once: true },
          ),
        );
      const params = await runtime.openPayload(request.params);
      reads.push(params.query.kind);
      return {
        result: await runtime.sealPayload('s1', {
          type: 'session/history-read_response',
          sessionId: 's1',
          success: true,
          historyRevision: 1,
          historyCount: 0,
          result: {
            checkpoint: 'c1',
            startPosition: 0,
            totalCount: 0,
            rows: [],
            hasMoreOlder: false,
            cursor: null,
          },
          pageTurns: [],
        }),
      };
    },
  });
  try {
    assert.deepEqual(fixture.events.at(-1).entries, []);
    assert.equal(reads.includes('readLatestPage'), true);
  } finally {
    fixture.close();
  }
});

test('Roost sessions read, observe and send through the owning machine', async () => {
  const turn = (text) => ({
    id: 'old',
    role: 'assistant',
    timestamp: '2026-01-01',
    finished: true,
    items: [{ type: 'text', text }],
  });
  const requests = [];
  let wakeWatch;
  let receiptAtAcceptance;
  let accepted;
  const acceptance = new Promise((resolve) => {
    accepted = resolve;
  });
  let changed;
  const change = new Promise((resolve) => {
    changed = resolve;
  });
  const fixture = await openTestSession({
    onEvent(event) {
      if (
        event.session &&
        JSON.parse(event.session).entries?.[0]?.items?.[0]?.text === 'after'
      )
        changed();
    },
    target: {
      backend: 'roost',
      machineId: 'm1',
      acceptsInput: true,
      dispatchesInput: true,
    },
    async onRpc(request, runtime, signal) {
      const params = await runtime.openPayload(request.params);
      requests.push({ method: request.method, params });
      let response;
      if (request.method === 'session/history-watch') {
        response = await new Promise((resolve, reject) => {
          wakeWatch = resolve;
          signal.addEventListener(
            'abort',
            () => reject(new Error('cancelled')),
            { once: true },
          );
        });
      } else if (request.method === 'session/history-read') {
        response = {
          type: 'session/history-read_response',
          sessionId: 's1',
          success: true,
          historyRevision: 1,
          historyCount: 1,
          result: {
            checkpoint: 'c1',
            startPosition: 0,
            totalCount: 1,
            rows: [{ position: 0, state: 'ready', turnId: 'old' }],
            hasMoreOlder: false,
            cursor: null,
          },
          pageTurns: [turn('before')],
        };
      } else {
        receiptAtAcceptance =
          fixture.server.toJSON().humanInputReceipts?.[params.payload.entry.id];
        accepted();
        response = {
          type: 'session/history-write_response',
          sessionId: 's1',
          success: true,
          operation: params.operation,
          result: {
            status: 'accepted',
            turnId: params.payload.entry.id,
            active: true,
          },
        };
      }
      return { result: await runtime.sealPayload('s1', response) };
    },
  });
  try {
    assert.equal(fixture.events.at(-1).entries[0].items[0].text, 'before');
    const result = await fixture.runtime.sendTurn({
      sessionId: 's1',
      machineId: 'm1',
      userId: 'u1',
      cliType: 'builtin',
      agentType: 'codex',
      text: 'Continue',
    });
    assert.equal(result.state, 'uploaded');
    await acceptance;
    const write = requests.find(
      (item) => item.method === 'session/history-write',
    );
    assert.equal(write.params.operation, 'accept_input_and_dispatch');
    assert.deepEqual(receiptAtAcceptance, { userId: 'u1' });
    assert.deepEqual(write.params.payload.entry.author, {
      v: 1,
      kind: 'human',
      userId: 'u1',
    });
    const invalid = await fixture.runtime.sendTurn({
      sessionId: 's1',
      machineId: 'm1',
      userId: 'u1',
      cliType: 'builtin',
      agentType: 'codex',
      text: '',
      attachmentBlocks: [
        {
          type: 'image',
          imageId: 'image',
          mimeType: 'image/invalid',
          sizeBytes: 1,
        },
      ],
    });
    assert.equal(invalid.state, 'not_sent');
    assert.equal(
      requests.filter((item) => item.method === 'session/history-write').length,
      1,
    );
    assert.equal(
      Object.keys(fixture.server.toJSON().humanInputReceipts).length,
      1,
    );
    assert.deepEqual(fixture.server.toJSON().history ?? [], []);
    wakeWatch({
      type: 'session/history-read_response',
      sessionId: 's1',
      success: true,
      historyRevision: 2,
      historyCount: 1,
      result: {
        state: 'ready',
        checkpoint: 'c2',
        ids: ['old'],
        bodies: { changed: [turn('after')], suffix: [] },
      },
    });
    await change;
    assert.equal(fixture.events.at(-1).entries[0].items[0].text, 'after');
  } finally {
    fixture.close();
  }
});

for (const [indexedDBAvailable, incremental] of [
  [true, false],
  [false, false],
  [false, true],
])
  test(
    `Roost refreshes after a control update with cache ${indexedDBAvailable} and incremental ${incremental}`,
    { timeout: 5000 },
    async () => {
      let revision = 1;
      let finish;
      const updated = new Promise((resolve) => {
        finish = resolve;
      });
      const requests = [];
      const fixture = await openTestSession({
        indexedDBAvailable,
        target: {
          backend: 'roost',
          machineId: 'm1',
          incremental,
          watch: false,
          acceptsInput: true,
          dispatchesInput: true,
        },
        onEvent(event) {
          if (!event.session) return;
          const value = JSON.parse(event.session);
          if (value.entries?.[0]?.items?.[0]?.text === 'after') finish();
        },
        async onRpc(request, runtime) {
          const params = await runtime.openPayload(request.params);
          requests.push(params.query.kind);
          return {
            result: await runtime.sealPayload('s1', {
              type: 'session/history-read_response',
              sessionId: 's1',
              success: true,
              historyRevision: revision,
              historyCount: 1,
              result: {
                checkpoint: `c${revision}`,
                startPosition: 0,
                totalCount: 1,
                rows: [{ position: 0, state: 'ready', turnId: 'turn' }],
                hasMoreOlder: false,
                cursor: null,
              },
              pageTurns: [
                {
                  id: 'turn',
                  role: 'assistant',
                  timestamp: '2026-01-01',
                  finished: true,
                  items: [
                    { type: 'text', text: revision === 1 ? 'before' : 'after' },
                  ],
                },
              ],
            }),
          };
        },
      });
      try {
        revision = 2;
        fixture.server.getMap('session').set('historyHint', 2);
        fixture.server.commit();
        await fixture.pushUpdate();
        await updated;
        assert.equal(requests.includes('watchChanges'), false);
      } finally {
        fixture.close();
      }
    },
  );

test('Roost retries the failed receipt upload before handing the same input to its owner', async () => {
  const writes = [];
  let failed, handedOff, canRetry;
  const retryable = new Promise((resolve) => {
    canRetry = resolve;
  });
  let rejectReceipt = true;
  const handoff = new Promise((resolve) => {
    handedOff = resolve;
  });
  const failure = new Promise((resolve) => {
    failed = resolve;
  });
  const fixture = await openTestSession({
    target: {
      backend: 'roost',
      machineId: 'm1',
      acceptsInput: true,
      dispatchesInput: true,
    },
    onEvent(event) {
      if (!event.session) return;
      if (
        JSON.parse(event.session).pendingRoostInputs?.some(
          (input) => input.inputRetryable,
        )
      )
        canRetry();
    },
    failAppend: (url) => {
      if (rejectReceipt && url.includes(':s:s1')) {
        failed();
        return true;
      }
      return false;
    },
    async onRpc(request, runtime, signal) {
      if (request.method === 'session/history-watch')
        return new Promise((_resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => reject(new Error('cancelled')),
            { once: true },
          ),
        );
      const params = await runtime.openPayload(request.params);
      if (request.method === 'session/history-write') {
        writes.push({
          id: params.payload.entry.id,
          receipt:
            fixture.server.toJSON().humanInputReceipts?.[
              params.payload.entry.id
            ],
        });
        handedOff();
        return {
          result: await runtime.sealPayload('s1', {
            type: 'session/history-write_response',
            sessionId: 's1',
            success: true,
            operation: params.operation,
            result: {
              status: 'accepted',
              turnId: params.payload.entry.id,
              active: true,
            },
          }),
        };
      }
      return {
        result: await runtime.sealPayload('s1', {
          type: 'session/history-read_response',
          sessionId: 's1',
          success: true,
          historyRevision: 1,
          historyCount: 0,
          result:
            params.query.kind === 'inputAcceptance'
              ? { status: 'unobserved' }
              : {
                  checkpoint: 'c1',
                  startPosition: 0,
                  totalCount: 0,
                  rows: [],
                  hasMoreOlder: false,
                  cursor: null,
                },
          pageTurns: [],
        }),
      };
    },
  });
  try {
    const result = await fixture.runtime.sendTurn({
      sessionId: 's1',
      machineId: 'm1',
      userId: 'u1',
      cliType: 'builtin',
      agentType: 'codex',
      text: 'Continue',
    });
    assert.equal(result.state, 'uploaded');
    await failure;
    assert.equal(writes.length, 0);
    assert.deepEqual(fixture.server.toJSON().humanInputReceipts ?? {}, {});
    rejectReceipt = false;
    await retryable;
    await assert.rejects(
      fixture.runtime.actOnPendingInput('other-session', result.id, 'retry'),
      /session_not_ready/,
    );
    await fixture.runtime.actOnPendingInput('s1', result.id, 'retry');
    await handoff;
    assert.deepEqual(writes, [{ id: result.id, receipt: { userId: 'u1' } }]);
  } finally {
    fixture.close();
  }
});

test(
  'Roost can cancel a saved input while its reopened session is still syncing',
  { timeout: 5000 },
  async () => {
    let handoffStarted, bootstrapStarted;
    const handoff = new Promise((resolve) => {
      handoffStarted = resolve;
    });
    const bootstrap = new Promise((resolve) => {
      bootstrapStarted = resolve;
    });
    const fixture = await openTestSession({
      target: {
        backend: 'roost',
        machineId: 'm1',
        acceptsInput: true,
        dispatchesInput: true,
      },
      async onRpc(request, runtime, signal) {
        if (request.method === 'session/history-watch')
          return new Promise((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            }),
          );
        if (request.method === 'session/history-write') {
          handoffStarted();
          throw new Error('lost_ack');
        }
        return {
          result: await runtime.sealPayload('s1', {
            type: 'session/history-read_response',
            sessionId: 's1',
            success: true,
            historyRevision: 1,
            historyCount: 0,
            result: {
              checkpoint: 'c1',
              startPosition: 0,
              totalCount: 0,
              rows: [],
              hasMoreOlder: false,
              cursor: null,
            },
            pageTurns: [],
          }),
        };
      },
    });
    try {
      const send = await fixture.runtime.sendTurn({
        sessionId: 's1',
        machineId: 'm1',
        userId: 'u1',
        cliType: 'builtin',
        agentType: 'codex',
        text: 'Cancel this input',
      });
      await handoff;
      fixture.runtime.stopSessions();
      globalThis.__sessionClient.prototype.bootstrap = async ({ signal }) => {
        bootstrapStarted();
        return new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          }),
        );
      };
      fixture.runtime.resumeAcceptedInputs();
      await bootstrap;
      await fixture.runtime.actOnPendingInput('s1', send.id, 'forget');
      await assert.rejects(
        fixture.runtime.actOnPendingInput('s1', send.id, 'forget'),
        /session_not_ready/,
      );
      assert.deepEqual(fixture.runtime.reservedSessionIds(), []);
    } finally {
      fixture.close();
    }
  },
);

for (const steerResult of [
  { applied: true },
  { applied: false, disposition: 'no-active-turn' },
  { inactive: true },
]) {
  test(
    `Roost guide follows the owner ${Object.keys(steerResult).join('-')} path`,
    { timeout: 5000 },
    async () => {
      const calls = [];
      let acceptedEntry;
      let finish;
      const completed = new Promise((resolve) => {
        finish = resolve;
      });
      const fixture = await openTestSession({
        target: {
          backend: 'roost',
          machineId: 'm1',
          acceptsInput: true,
          dispatchesInput: false,
        },
        markDispatch: async (...args) => {
          calls.push({ kind: 'activate', args });
          finish();
        },
        async onRpc(request, runtime, signal) {
          if (request.method === 'session/history-watch')
            return new Promise((_resolve, reject) =>
              signal.addEventListener(
                'abort',
                () => reject(new Error('cancelled')),
                { once: true },
              ),
            );
          if (request.method === 'session/steer') {
            calls.push({ kind: 'steer', params: request.params });
            return { result: steerResult };
          }
          const params = await runtime.openPayload(request.params);
          if (request.method === 'session/history-read')
            return {
              result: await runtime.sealPayload('s1', {
                type: 'session/history-read_response',
                sessionId: 's1',
                success: true,
                historyRevision: 1,
                historyCount: 1,
                result:
                  params.query.kind === 'readTurn' &&
                  params.query.turnId !== 'running'
                    ? { state: 'ready', turn: acceptedEntry }
                    : {
                        checkpoint: 'c1',
                        startPosition: 0,
                        totalCount: 1,
                        rows: [
                          { position: 0, state: 'ready', turnId: 'running' },
                        ],
                        hasMoreOlder: false,
                        cursor: null,
                      },
                pageTurns: [
                  {
                    id: 'running',
                    role: 'assistant',
                    timestamp: '2026-01-01',
                    finished: false,
                    items: [],
                  },
                ],
              }),
            };
          if (params.operation === 'accept_input')
            acceptedEntry = params.payload.entry;
          calls.push({
            kind: params.operation,
            payload: params.payload,
            receipt:
              fixture.server.toJSON().humanInputReceipts?.[
                params.payload.entry?.id
              ],
          });
          if (params.operation === 'apply_action' && steerResult.applied)
            finish();
          return {
            result: await runtime.sealPayload('s1', {
              type: 'session/history-write_response',
              sessionId: 's1',
              success: true,
              operation: params.operation,
              result:
                params.operation === 'accept_input'
                  ? {
                      status: 'accepted',
                      turnId: params.payload.entry.id,
                      active: !steerResult.inactive,
                    }
                  : { matched: true },
            }),
          };
        },
      });
      try {
        const sent = await fixture.runtime.sendTurn({
          sessionId: 's1',
          machineId: 'm1',
          userId: 'u1',
          cliType: 'builtin',
          agentType: 'codex',
          text: 'Guide',
          guide: true,
        });
        if (steerResult.inactive) {
          assert.equal(sent.state, 'uploaded');
          return;
        }
        assert.equal(sent.state, 'uploaded');
        assert.equal(sent.awaitingGuide, true);
        await completed;
        assert.deepEqual(
          calls.map((call) => call.kind),
          steerResult.applied
            ? ['accept_input', 'steer', 'apply_action']
            : ['accept_input', 'steer', 'apply_action', 'activate'],
        );
        assert.deepEqual(calls[0].receipt, { userId: 'u1' });
        assert.equal(calls[0].payload.entry.status, 'pending_apply');
        assert.equal(calls[1].params.expectedTurnId, 'running');
        assert.deepEqual(calls[2].payload.action, {
          kind: 'user-status',
          turnId: sent.id,
          status: steerResult.applied ? 'processing' : 'pending',
          ...(steerResult.applied ? { deliveredSteer: true } : {}),
          onlyPendingApply: true,
        });
      } finally {
        fixture.close();
      }
    },
  );
}

test(
  'an uncertain Roost guide stays in history without promotion or replay',
  { timeout: 5000 },
  async () => {
    const calls = [];
    let acceptedEntry;
    let finish;
    const completed = new Promise((resolve) => {
      finish = resolve;
    });
    const fixture = await openTestSession({
      target: {
        backend: 'roost',
        machineId: 'm1',
        acceptsInput: true,
        dispatchesInput: true,
      },
      onEvent: (event) => {
        if (event.backgroundWork?.id === 'guide-work')
          finish(event.backgroundWork);
      },
      markDispatch: async () => {
        calls.push('activate');
      },
      async onRpc(request, runtime, signal) {
        if (request.method === 'session/history-watch')
          return new Promise((_resolve, reject) =>
            signal.addEventListener(
              'abort',
              () => reject(new Error('cancelled')),
              { once: true },
            ),
          );
        if (request.method === 'session/steer') {
          calls.push('steer');
          return { error: { code: 'timeout' } };
        }
        const params = await runtime.openPayload(request.params);
        if (request.method === 'session/history-read')
          return {
            result: await runtime.sealPayload('s1', {
              type: 'session/history-read_response',
              sessionId: 's1',
              success: true,
              historyRevision: 1,
              historyCount: 1,
              result:
                params.query.kind === 'readTurn' &&
                params.query.turnId !== 'running'
                  ? { state: 'ready', turn: acceptedEntry }
                  : {
                      checkpoint: 'c1',
                      startPosition: 0,
                      totalCount: 1,
                      rows: [
                        { position: 0, state: 'ready', turnId: 'running' },
                      ],
                      hasMoreOlder: false,
                      cursor: null,
                    },
              pageTurns: [
                {
                  id: 'running',
                  role: 'assistant',
                  timestamp: '2026-01-01',
                  finished: false,
                  items: [],
                },
              ],
            }),
          };
        if (params.operation === 'accept_input')
          acceptedEntry = params.payload.entry;
        calls.push(params.operation);
        return {
          result: await runtime.sealPayload('s1', {
            type: 'session/history-write_response',
            sessionId: 's1',
            success: true,
            operation: params.operation,
            result: {
              status: 'accepted',
              turnId: params.payload.entry.id,
              active: true,
            },
          }),
        };
      },
    });
    try {
      const sent = await fixture.runtime.sendTurn({
        sessionId: 's1',
        machineId: 'm1',
        userId: 'u1',
        cliType: 'builtin',
        agentType: 'codex',
        text: 'Guide',
        guide: true,
        backgroundTaskId: 'guide-work',
      });
      assert.equal(sent.state, 'uploaded');
      assert.equal((await completed).state, 'waiting');
      assert.deepEqual(calls, ['accept_input', 'steer']);
    } finally {
      fixture.close();
    }
  },
);

test('Roost permission decisions use the owner, and a lost send acknowledgement stays unknown', async () => {
  const requests = [];
  let handedOff;
  const handoff = new Promise((resolve) => {
    handedOff = resolve;
  });
  const fixture = await openTestSession({
    target: {
      backend: 'roost',
      machineId: 'm1',
      acceptsInput: true,
      dispatchesInput: true,
    },
    async onRpc(request, runtime, signal) {
      const params = await runtime.openPayload(request.params);
      requests.push({ method: request.method, params });
      if (request.method === 'session/history-watch')
        return new Promise((_resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => reject(new Error('cancelled')),
            { once: true },
          ),
        );
      if (params.operation === 'accept_input_and_dispatch') {
        handedOff();
        throw new Error('lost_ack');
      }
      const response =
        request.method === 'session/history-read'
          ? {
              type: 'session/history-read_response',
              sessionId: 's1',
              success: true,
              historyRevision: 1,
              historyCount: 1,
              result: {
                checkpoint: 'c1',
                startPosition: 0,
                totalCount: 1,
                rows: [{ position: 0, state: 'ready', turnId: 'assistant' }],
                hasMoreOlder: false,
                cursor: null,
              },
              pageTurns: [
                {
                  id: 'assistant',
                  role: 'assistant',
                  timestamp: '2026-01-01',
                  finished: true,
                  items: [
                    {
                      type: 'tool_call',
                      toolCallId: 'tool',
                      permissionRequest: {
                        requestId: 'request',
                        options: [{ optionId: 'yes', kind: 'allow_once' }],
                      },
                    },
                  ],
                },
              ],
            }
          : {
              type: 'session/history-write_response',
              sessionId: 's1',
              success: true,
              operation: params.operation,
              result: true,
            };
      return { result: await runtime.sealPayload('s1', response) };
    },
  });
  try {
    assert.deepEqual(
      await fixture.runtime.respondPermission({
        sessionId: 's1',
        entryId: 'assistant',
        itemId: 'tool',
        requestId: 'request',
        optionId: 'yes',
      }),
      { state: 'accepted' },
    );
    const permission = requests.find(
      (item) => item.params.operation === 'respond_permission',
    );
    assert.deepEqual(permission.params.payload, {
      requestId: 'request',
      outcome: { outcome: 'selected', optionId: 'yes' },
      options: { turnId: 'assistant' },
    });
    const result = await fixture.runtime.sendTurn({
      sessionId: 's1',
      machineId: 'm1',
      userId: 'u1',
      cliType: 'builtin',
      agentType: 'codex',
      text: 'Continue',
    });
    assert.equal(result.state, 'uploaded');
    await handoff;
    assert.equal(
      requests.filter(
        (item) => item.params.operation === 'accept_input_and_dispatch',
      ).length,
      1,
    );
    assert.deepEqual(fixture.server.toJSON().history ?? [], []);
  } finally {
    fixture.close();
  }
});

test('Roost exports the full history before paging and leaves the shared queue on the control document', async () => {
  const requests = [];
  const dispatches = [];
  const first = {
    id: 'first',
    role: 'user',
    timestamp: '2026-01-01',
    finished: true,
    items: [],
  };
  const running = {
    id: 'running',
    role: 'assistant',
    timestamp: '2026-01-02',
    finished: false,
    items: [{ type: 'text', text: 'Still running' }],
  };
  const fixture = await openTestSession({
    target: {
      backend: 'roost',
      machineId: 'm1',
      acceptsInput: true,
      dispatchesInput: true,
    },
    markDispatch: async (...args) => dispatches.push(args),
    async onRpc(request, runtime, signal) {
      const params = await runtime.openPayload(request.params);
      requests.push({ method: request.method, params });
      if (request.method === 'session/history-watch')
        return new Promise((_resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => reject(new Error('cancelled')),
            { once: true },
          ),
        );
      const latest = params.query.kind === 'readLatestPage';
      const position = latest ? 1 : 0;
      const turn = latest ? running : first;
      return {
        result: await runtime.sealPayload('s1', {
          type: 'session/history-read_response',
          sessionId: 's1',
          success: true,
          historyRevision: 1,
          historyCount: 2,
          result:
            params.query.kind === 'readAll'
              ? [first, running]
              : params.query.kind === 'readRange'
                ? [first, running]
                    .slice(params.query.from, params.query.to)
                    .map((turn) => ({ state: 'ready', turn }))
                : {
                    checkpoint: 'c1',
                    startPosition: position,
                    totalCount: 2,
                    rows: [{ position, state: 'ready', turnId: turn.id }],
                    hasMoreOlder: latest,
                    cursor: latest ? 'older' : null,
                  },
          pageTurns: [turn],
        }),
      };
    },
  });
  try {
    assert.deepEqual(
      fixture.events.at(-1).entries.map((entry) => entry.id),
      ['running'],
    );
    assert.equal(fixture.events.at(-1).historyHasMore, true);
    assert.deepEqual(await fixture.runtime.readyHistory('s1'), [
      first,
      running,
    ]);
    const itemId = fixture.events.at(-1).entries[0].items[0].itemId;
    assert.equal(
      requests.some((item) => item.params.query?.kind === 'readOlderPage'),
      false,
    );
    const updated = fixture.nextEmit();
    await fixture.runtime.loadOlderSession('s1');
    const page = await updated;
    assert.deepEqual(
      page.entries.map((entry) => entry.id),
      ['first', 'running'],
    );
    assert.equal(page.entries[1].items[0].itemId, itemId);
    const sent = await fixture.runtime.sendTurn({
      sessionId: 's1',
      machineId: 'm1',
      userId: 'u1',
      cliType: 'builtin',
      agentType: 'codex',
      text: 'Queue',
    });
    assert.equal(sent.state, 'queued');
    assert.equal(fixture.server.toJSON().mq[0].userTurnId, sent.id);
    assert.deepEqual(fixture.server.toJSON().history ?? [], []);
    assert.deepEqual(dispatches, [['s1', sent.id, true]]);
    assert.equal(
      requests.some((item) => item.method === 'session/history-write'),
      false,
    );
  } finally {
    fixture.close();
  }
});

for (const invalidPatch of [false, true]) {
  test(
    `upstream Roost reader ${invalidPatch ? 'repairs an invalid patch at the owner checkpoint' : 'applies a Unicode patch at its base checkpoint'}`,
    { timeout: 5000 },
    async () => {
      const reads = [];
      let watchReady, resolveWatch;
      const watching = new Promise((resolve) => {
        watchReady = resolve;
      });
      const turn = (text) => ({
        id: 'turn',
        role: 'assistant',
        timestamp: '2026-01-01',
        items: [{ type: 'text', text }],
      });
      const fixture = await openTestSession({
        target: {
          backend: 'roost',
          machineId: 'm1',
          acceptsInput: true,
          dispatchesInput: true,
          patches: true,
        },
        async onRpc(request, runtime, signal) {
          const params = await runtime.openPayload(request.params);
          const query = params.query;
          reads.push(query);
          if (request.method === 'session/history-watch') {
            const response = await new Promise((resolve, reject) => {
              resolveWatch = resolve;
              watchReady();
              signal.addEventListener(
                'abort',
                () => reject(new Error('cancelled')),
                { once: true },
              );
            });
            return { result: await runtime.sealPayload('s1', response) };
          }
          const response =
            query.kind === 'readTurn'
              ? {
                  historyRevision: 2,
                  historyCount: 1,
                  result: { state: 'ready', turn: turn('ACB') },
                }
              : {
                  historyRevision: 1,
                  historyCount: 1,
                  result: {
                    checkpoint: 'c1',
                    startPosition: 0,
                    totalCount: 1,
                    rows: [{ position: 0, state: 'ready', turnId: 'turn' }],
                    hasMoreOlder: false,
                    cursor: null,
                  },
                  pageTurns: [turn('A😀B')],
                };
          return {
            result: await runtime.sealPayload('s1', {
              type: 'session/history-read_response',
              sessionId: 's1',
              success: true,
              ...response,
            }),
          };
        },
      });
      try {
        await watching;
        const updated = fixture.nextEmit();
        resolveWatch({
          type: 'session/history-read_response',
          sessionId: 's1',
          success: true,
          historyRevision: 2,
          historyCount: 1,
          result: {
            state: 'ready',
            checkpoint: 'c2',
            ids: ['turn'],
            bodies: { changed: [], suffix: [] },
            patches: {
              baseCheckpoint: 'c1',
              turns: [
                {
                  turnId: 'turn',
                  operations: [
                    {
                      kind: 'spliceText',
                      path: [
                        { key: 'items' },
                        { index: invalidPatch ? 9 : 0 },
                        { key: 'text' },
                      ],
                      index: 1,
                      delete: 1,
                      text: 'C',
                    },
                  ],
                },
              ],
            },
          },
        });
        const event = await updated;
        assert.equal(event.entries[0].items[0].text, 'ACB');
        assert.equal(
          reads.find((query) => query.kind === 'watchChanges').withPatches,
          true,
        );
        const repair = reads.find((query) => query.kind === 'readTurn');
        if (invalidPatch) assert.equal(repair.atCheckpoint, 'c2');
        else assert.equal(repair, undefined);
      } finally {
        fixture.close();
      }
    },
  );
}

test(
  'Roost reads the latest page first and uses the complete directory for send state',
  { timeout: 5000 },
  async () => {
    const requests = [];
    let handedOff;
    const handoff = new Promise((resolve) => {
      handedOff = resolve;
    });
    let allowDirectory;
    let directoryRequested;
    const directoryReady = new Promise((resolve) => {
      directoryRequested = resolve;
    });
    const directoryGate = new Promise((resolve) => {
      allowDirectory = resolve;
    });
    const turns = Array.from({ length: 80 }, (_, index) => ({
      id: `turn-${index}`,
      role: index < 40 ? 'user' : 'assistant',
      timestamp: '2026-01-01',
      finished: true,
      ...(index === 39 ? { inputConfig: { modelId: 'earlier-model' } } : {}),
      items: [],
    }));
    const fixture = await openTestSession({
      target: {
        backend: 'roost',
        machineId: 'm1',
        acceptsInput: true,
        dispatchesInput: true,
      },
      async onRpc(request, runtime, signal) {
        const params = await runtime.openPayload(request.params);
        requests.push({ method: request.method, params });
        if (request.method === 'session/history-watch')
          return new Promise((_resolve, reject) =>
            signal.addEventListener(
              'abort',
              () => reject(new Error('cancelled')),
              { once: true },
            ),
          );
        let result, pageTurns;
        if (params.operation) {
          handedOff();
          result = {
            status: 'accepted',
            turnId: params.payload.entry.id,
            active: true,
          };
        } else if (params.query.kind === 'count') result = turns.length;
        else if (params.query.kind === 'readDirectory') {
          directoryRequested();
          await directoryGate;
          result = turns
            .slice(params.query.from, params.query.to)
            .map((turn, offset) => ({
              position: params.query.from + offset,
              state: 'ready',
              turnId: turn.id,
              scalars: {
                id: turn.id,
                role: turn.role,
                timestamp: turn.timestamp,
                finished: true,
              },
              inputConfig: turn.inputConfig,
            }));
        } else {
          pageTurns = turns.slice(40);
          result = {
            checkpoint: 'c1',
            startPosition: 40,
            totalCount: 80,
            rows: pageTurns.map((turn, index) => ({
              position: index + 40,
              state: 'ready',
              turnId: turn.id,
            })),
            hasMoreOlder: true,
            cursor: 'older',
          };
        }
        return {
          result: await runtime.sealPayload('s1', {
            type: params.operation
              ? 'session/history-write_response'
              : 'session/history-read_response',
            sessionId: 's1',
            success: true,
            historyRevision: 1,
            historyCount: turns.length,
            ...(params.operation ? { operation: params.operation } : {}),
            result,
            ...(pageTurns ? { pageTurns } : {}),
          }),
        };
      },
    });
    try {
      assert.equal(fixture.events.at(-1).entries.length, 40);
      assert.equal(fixture.events.at(-1).billableTurnCount, undefined);
      await directoryReady;
      const args = {
        sessionId: 's1',
        machineId: 'm1',
        userId: 'u1',
        cliType: 'builtin',
        agentType: 'codex',
        text: 'Continue',
      };
      assert.equal(
        (await fixture.runtime.sendTurn(args)).reason,
        'session_not_ready',
      );
      const updated = fixture.nextEmit(
        (event) => event.billableTurnCount !== undefined,
      );
      allowDirectory();
      const event = await updated;
      assert.equal(event.billableTurnCount, 40);
      assert.equal(event.composer.modelId, 'earlier-model');
      assert.equal((await fixture.runtime.sendTurn(args)).state, 'uploaded');
      await handoff;
      const write = requests.find(
        (request) => request.params.operation === 'accept_input_and_dispatch',
      );
      assert.equal(
        write.params.payload.entry.inputConfig.modelId,
        'earlier-model',
      );
      assert.equal(
        requests.some(
          (request) =>
            request.params.query?.kind === 'readOlderPage' ||
            request.params.query?.kind === 'readAll',
        ),
        false,
      );
    } finally {
      allowDirectory();
      fixture.close();
    }
  },
);

for (const accepted of [true, false, 'inactive', 'storage-failed']) {
  test(
    `Roost queued guide handles owner acceptance ${accepted}`,
    { timeout: 5000 },
    async () => {
      const calls = [];
      let acceptedEntry, acceptedWrite, applied;
      const acceptance = new Promise((resolve) => {
        acceptedWrite = resolve;
      });
      const application = new Promise((resolve) => {
        applied = resolve;
      });
      const fixture = await openTestSession({
        target: {
          backend: 'roost',
          machineId: 'm1',
          acceptsInput: true,
          dispatchesInput: true,
        },
        async onRpc(request, runtime, signal) {
          if (request.method === 'session/history-watch')
            return new Promise((_resolve, reject) =>
              signal.addEventListener(
                'abort',
                () => reject(new Error('cancelled')),
                { once: true },
              ),
            );
          if (request.method === 'session/steer') {
            calls.push({ kind: 'steer', queue: fixture.server.toJSON().mq });
            return { result: { applied: true } };
          }
          const params = await runtime.openPayload(request.params);
          if (params.operation)
            calls.push({
              kind: params.operation,
              queue: fixture.server.toJSON().mq,
              entry: params.payload.entry,
            });
          if (params.operation === 'accept_input') {
            acceptedEntry = params.payload.entry;
            acceptedWrite();
            if (accepted === false) throw new Error('lost_ack');
          }
          if (params.operation === 'apply_action') applied();
          let result;
          if (params.query?.kind === 'inputAcceptance')
            result = { status: 'unobserved' };
          else if (params.operation === 'accept_input')
            result = {
              status: 'accepted',
              turnId: params.payload.entry.id,
              active: accepted !== 'inactive',
            };
          else if (params.operation === 'apply_action')
            result = { matched: true };
          else if (
            params.query?.kind === 'readTurn' &&
            params.query.turnId !== 'running'
          )
            result = { state: 'ready', turn: acceptedEntry };
          else
            result = {
              checkpoint: 'c1',
              startPosition: 0,
              totalCount: 1,
              rows: [{ position: 0, state: 'ready', turnId: 'running' }],
              hasMoreOlder: false,
              cursor: null,
            };
          return {
            result: await runtime.sealPayload('s1', {
              type: params.operation
                ? 'session/history-write_response'
                : 'session/history-read_response',
              sessionId: 's1',
              success: true,
              historyRevision: 1,
              historyCount: 1,
              ...(params.operation ? { operation: params.operation } : {}),
              result,
              ...(!params.operation && params.query?.kind !== 'inputAcceptance'
                ? {
                    pageTurns: [
                      {
                        id: 'running',
                        role: 'assistant',
                        timestamp: '2026-01-01',
                        finished: false,
                        items: [],
                      },
                    ],
                  }
                : {}),
            }),
          };
        },
      });
      try {
        const sent = await fixture.runtime.sendTurn({
          sessionId: 's1',
          machineId: 'm1',
          userId: 'u1',
          cliType: 'builtin',
          agentType: 'codex',
          text: 'Queued',
        });
        assert.equal(sent.state, 'queued');
        if (accepted === 'storage-failed') {
          const { IDBObjectStore } = await import('fake-indexeddb');
          const add = IDBObjectStore.prototype.add;
          IDBObjectStore.prototype.add = function (...args) {
            if (this.name === 'inputs')
              throw new DOMException(
                'Input storage unavailable',
                'QuotaExceededError',
              );
            return add.apply(this, args);
          };
          try {
            await assert.rejects(
              fixture.runtime.controlTurn({
                action: 'steer',
                sessionId: 's1',
                machineId: 'm1',
                turnId: 'running',
                messageId: sent.id,
              }),
              /input_storage_unavailable/,
            );
            assert.equal(fixture.server.toJSON().mq[0].userTurnId, sent.id);
            assert.deepEqual(calls, []);
          } finally {
            IDBObjectStore.prototype.add = add;
          }
          return;
        }
        const control = fixture.runtime.controlTurn({
          action: 'steer',
          sessionId: 's1',
          machineId: 'm1',
          turnId: 'running',
          messageId: sent.id,
        });
        assert.equal((await control).state, 'not_applied');
        await acceptance;
        assert.equal(calls[0].kind, 'accept_input');
        assert.equal(calls[0].entry.status, 'pending_apply');
        if (accepted === true) {
          await application;
          assert.deepEqual(
            calls.map((call) => call.kind),
            ['accept_input', 'steer', 'apply_action'],
          );
        } else {
          assert.deepEqual(
            calls.map((call) => call.kind),
            ['accept_input'],
          );
        }
        assert.deepEqual(fixture.server.toJSON().mq, []);
      } finally {
        fixture.close();
      }
    },
  );
}

test('Roost input is refused before writes when the owner lacks dispatch capability', async () => {
  const requests = [];
  let current = true;
  const fixture = await openTestSession({
    target: {
      backend: 'roost',
      machineId: 'm1',
      acceptsInput: true,
      dispatchesInput: false,
      isCurrent: () => current,
    },
    async onRpc(request, runtime, signal) {
      requests.push(request.method);
      if (request.method === 'session/history-watch')
        return new Promise((_resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => reject(new Error('cancelled')),
            { once: true },
          ),
        );
      return {
        result: await runtime.sealPayload('s1', {
          type: 'session/history-read_response',
          sessionId: 's1',
          success: true,
          historyRevision: 1,
          historyCount: 0,
          result: {
            checkpoint: 'c1',
            startPosition: 0,
            totalCount: 0,
            rows: [],
            hasMoreOlder: false,
            cursor: null,
          },
          pageTurns: [],
        }),
      };
    },
  });
  try {
    const result = await fixture.runtime.sendTurn({
      sessionId: 's1',
      machineId: 'm1',
      userId: 'u1',
      cliType: 'builtin',
      agentType: 'codex',
      text: 'Blocked',
    });
    assert.equal(result.state, 'not_sent');
    assert.equal(result.reason, 'roost_input_unsupported');
    assert.equal(requests.includes('session/history-write'), false);
    assert.deepEqual(fixture.server.toJSON().history ?? [], []);
    current = false;
    assert.equal(fixture.runtime.docSnapshot(), undefined);
    assert.equal(fixture.runtime.sessionHistory('s1'), undefined);
    assert.equal(
      (
        await fixture.runtime.sendTurn({
          sessionId: 's1',
          machineId: 'm1',
          userId: 'u1',
          cliType: 'builtin',
          agentType: 'codex',
          text: 'Blocked',
        })
      ).reason,
      'workspace_changed',
    );
  } finally {
    fixture.close();
  }
});

for (const observed of [true, false]) {
  test(`Roost resolves a lost acknowledgement by querying the immutable receipt: ${observed ? 'accepted' : 'unobserved'}`, async () => {
    const calls = [];
    let firstWrite, secondWrite;
    const firstHandoff = new Promise((resolve) => {
      firstWrite = resolve;
    });
    const recoveredHandoff = new Promise((resolve) => {
      secondWrite = resolve;
    });
    const fixture = await openTestSession({
      target: {
        backend: 'roost',
        machineId: 'm1',
        acceptsInput: true,
        dispatchesInput: true,
      },
      async onRpc(request, runtime, signal) {
        const params = await runtime.openPayload(request.params);
        calls.push({ method: request.method, params });
        if (request.method === 'session/history-watch')
          return new Promise((_resolve, reject) =>
            signal.addEventListener(
              'abort',
              () => reject(new Error('cancelled')),
              { once: true },
            ),
          );
        if (request.method === 'session/history-write') {
          if (
            calls.filter((call) => call.method === 'session/history-write')
              .length === 1
          )
            firstWrite();
          else secondWrite();
          throw new Error('lost_ack');
        }
        const response =
          params.query.kind === 'inputAcceptance'
            ? {
                type: 'session/history-read_response',
                sessionId: 's1',
                success: true,
                historyRevision: 1,
                historyCount: 0,
                result: observed
                  ? {
                      status: 'accepted',
                      turnId: params.query.entry.id,
                      active: true,
                    }
                  : { status: 'unobserved' },
              }
            : {
                type: 'session/history-read_response',
                sessionId: 's1',
                success: true,
                historyRevision: 1,
                historyCount: 0,
                result: {
                  checkpoint: 'c1',
                  startPosition: 0,
                  totalCount: 0,
                  rows: [],
                  hasMoreOlder: false,
                  cursor: null,
                },
                pageTurns: [],
              };
        return { result: await runtime.sealPayload('s1', response) };
      },
    });
    try {
      const result = await fixture.runtime.sendTurn({
        sessionId: 's1',
        machineId: 'm1',
        userId: 'u1',
        cliType: 'builtin',
        agentType: 'codex',
        text: 'Continue',
      });
      assert.equal(result.state, 'uploaded');
      await firstHandoff;
      fixture.runtime.resumeAcceptedInputs();
      await recoveredHandoff;
      const writes = calls.filter(
        (call) => call.method === 'session/history-write',
      );
      const lookup = calls.find(
        (call) => call.params.query?.kind === 'inputAcceptance',
      );
      assert.deepEqual(
        lookup.params.query.entry,
        writes[0].params.payload.entry,
      );
      assert.deepEqual(
        writes[1].params.payload.entry,
        writes[0].params.payload.entry,
      );
    } finally {
      fixture.close();
    }
  });
}

test('continuing a Role session preserves its frozen identity through dispatch and queue', async () => {
  const calls = [];
  const fixture = await openTestSession({
    onRpc: (request) => {
      calls.push(request);
      return { result: { accepted: true } };
    },
  });
  const previous = {
    cliType: 'builtin',
    agentType: 'codex',
    modelId: 'frozen-model',
    modeId: 'plan',
    configOptionValues: { effort: 'high', fast: false },
    agentRoleId: 'role-coder',
    agentRoleRevision: 7,
    mcpServerIds: ['workspace-files'],
  };
  try {
    fixture.server.getList('history').push({
      id: 'previous',
      role: 'user',
      status: 'handled',
      finished: true,
      inputConfig: previous,
      items: [],
    });
    fixture.server.commit();
    await fixture.pushUpdate();
    const args = {
      sessionId: 's1',
      machineId: 'm1',
      userId: 'u1',
      cliType: 'builtin',
      agentType: 'codex',
      text: 'Continue the review',
    };
    assert.equal((await fixture.runtime.sendTurn(args)).state, 'accepted');
    const input = calls[0].params.inputConfig;
    for (const key of Object.keys(previous))
      assert.deepEqual(input[key], previous[key]);
    assert.deepEqual(fixture.server.toJSON().history.at(-1).inputConfig, input);
    assert.equal(
      (await fixture.runtime.sendTurn({ ...args, queue: true })).state,
      'queued',
    );
    const queued = fixture.server.toJSON().mq[0].acpSessionConfig;
    for (const key of Object.keys(previous))
      assert.deepEqual(queued[key], previous[key]);
    for (const override of [
      { modelId: 'different-model' },
      { modelId: null },
      { modeId: 'code' },
      { reasoningEffort: 'low' },
      { configOptionValues: { fast: true } },
    ]) {
      assert.equal(
        (await fixture.runtime.sendTurn({ ...args, ...override, queue: true }))
          .state,
        'queued',
      );
      const changed = fixture.server.toJSON().mq.at(-1).acpSessionConfig;
      assert.equal(
        changed.agentRoleId,
        null,
        'Overrides explicitly detach the frozen Role',
      );
      assert.equal(changed.agentRoleRevision, undefined);
    }
    assert.equal(
      (
        await fixture.runtime.sendTurn({
          ...args,
          queue: true,
          modelId: previous.modelId,
          configOptionValues: { fast: false, effort: 'high' },
        })
      ).state,
      'queued',
    );
    assert.equal(
      fixture.server.toJSON().mq.at(-1).acpSessionConfig.agentRoleId,
      previous.agentRoleId,
      'Restored composer values do not detach an unchanged Role',
    );
  } finally {
    fixture.close();
  }
});

test('independent configuration reaches durable history before RPC, inherits on later turns and rejects malformed overrides', async () => {
  const calls = [];
  const fixture = await openTestSession({
    onRpc: (request) => {
      calls.push(request);
      const persisted = fixture.server
        .toJSON()
        .history.find((entry) => entry.id === request.params.userTurnId);
      assert.deepEqual(
        persisted.inputConfig.configOptionValues,
        request.params.inputConfig.configOptionValues,
      );
      return { result: { accepted: true } };
    },
  });
  const args = {
    sessionId: 's1',
    machineId: 'm1',
    userId: 'u1',
    cliType: 'builtin',
    agentType: 'grok',
    text: 'Synthetic configuration check',
  };
  try {
    for (const configOptionValues of [
      null,
      [],
      { fast: 1 },
      { permission_mode: {} },
      { secret_token: 'synthetic' },
    ]) {
      assert.equal(
        (await fixture.runtime.sendTurn({ ...args, configOptionValues })).state,
        'not_sent',
      );
    }
    assert.equal(
      fixture.appends.length,
      0,
      'invalid configuration cannot write or dispatch',
    );
    const configOptionValues = {
      permission_mode: 'always-approve',
      fast: false,
      collaboration_mode: 'plan',
      agent_preset: 'coder',
    };
    assert.equal(
      (
        await fixture.runtime.sendTurn({
          ...args,
          configOptionValues,
          reasoningEffort: 'high',
          reasoningEffortConfigId: 'effort',
        })
      ).state,
      'accepted',
    );
    assert.deepEqual(calls[0].params.inputConfig.configOptionValues, {
      ...configOptionValues,
      effort: 'high',
    });
    assert.deepEqual(
      fixture.runtime.projectSession(fixture.server, 'live').composer
        .configOptionValues,
      configOptionValues,
      'Reopened composer restores permission and other agent choices, including explicit Fast off',
    );
    assert.equal((await fixture.runtime.sendTurn(args)).state, 'queued');
    assert.deepEqual(
      fixture.server.toJSON().mq[0].acpSessionConfig.configOptionValues,
      calls[0].params.inputConfig.configOptionValues,
    );
    assert.equal(
      (
        await fixture.runtime.sendTurn({
          ...args,
          configOptionValues: { permission_mode: 'ask' },
        })
      ).state,
      'queued',
    );
    assert.equal(
      fixture.server.toJSON().mq[1].acpSessionConfig.configOptionValues
        .permission_mode,
      'ask',
    );
    assert.equal(
      fixture.server.toJSON().mq[1].acpSessionConfig.configOptionValues.fast,
      false,
    );
  } finally {
    fixture.close();
  }
});

test('reply metadata preserves each recorded model and updates when it arrives after completion', async () => {
  const { projectSession } = await loadProject();
  const doc = new LoroDoc();
  const history = doc.getList('history');
  history.push({
    id: 'old',
    role: 'assistant',
    finished: true,
    modelInfo: { modelId: 'old-model', name: 'Old Model' },
    items: [{ type: 'text', text: 'Earlier answer' }],
  });
  history.push({
    id: 'input',
    role: 'user',
    finished: true,
    inputConfig: { modelId: 'selected-model' },
    items: [],
  });
  const reply = history.pushContainer(new LoroMap());
  reply.set('id', 'reply');
  reply.set('role', 'assistant');
  reply.set('finished', true);
  reply.set('items', [{ type: 'text', text: 'Answer' }]);
  doc.commit();
  const before = projectSession(doc, 'live');
  assert.equal(before.entries[0].modelInfo.name, 'Old Model');
  assert.equal(
    before.entries[2].modelInfo,
    undefined,
    'Never infer history metadata from the current composer',
  );
  reply.set('modelInfo', {
    modelId: 'actual-model',
    name: ' Actual Model ',
    _meta: { lodyThoughtLevel: ' High ', unrelated: 'not for display' },
  });
  doc.commit();
  const after = projectSession(doc, 'live');
  assert.equal(after.entries[0].modelInfo.name, 'Old Model');
  assert.deepEqual(after.entries[2].modelInfo, {
    modelId: 'actual-model',
    name: 'Actual Model',
    thoughtLevel: 'High',
  });
  assert.ok(after.entries[2].rev > before.entries[2].rev);
  const usage = {
    inputTokens: 1234,
    outputTokens: 6640,
    reasoningOutputTokens: 2000,
    cacheReadInputTokens: 120000,
    cacheCreationInputTokens: 4096,
  };
  reply.set('tokenUsage', usage);
  reply.set('inputConfig', {
    modeId: 'plan',
    configOptionValues: {
      fast: false,
      effort: 'high',
      secret_token: 'hidden',
      invalid: {},
    },
  });
  doc.commit();
  const late = projectSession(doc, 'live').entries[2];
  assert.deepEqual(late.tokenUsage, usage);
  assert.deepEqual(late.inputConfig, {
    modeId: 'plan',
    configOptionValues: { fast: false, effort: 'high' },
  });
  assert.ok(
    late.rev > after.entries[2].rev,
    'Late usage invalidates the rendered entry',
  );
  assert.equal(projectSession(doc, 'live').entries[0].tokenUsage, undefined);
  for (const invalid of [
    { ...usage, inputTokens: -1 },
    { ...usage, outputTokens: '20' },
    { inputTokens: 20 },
  ]) {
    reply.set('tokenUsage', invalid);
    doc.commit();
    assert.equal(projectSession(doc, 'live').entries[2].tokenUsage, undefined);
  }
  reply.set('modelInfo', {
    modelId: 'id-only',
    name: 42,
    _meta: { lodyThoughtLevel: {} },
  });
  doc.commit();
  const sanitized = projectSession(doc, 'live').entries[2].modelInfo;
  assert.equal(sanitized.modelId, 'id-only');
  assert.equal(sanitized.name, undefined);
  assert.equal(sanitized.thoughtLevel, undefined);
});

test('system notice identity survives projection updates without changing the completed reply', async () => {
  const { projectSession } = await loadRuntime();
  const doc = new LoroDoc();
  doc.getList('history').push({
    id: 'done',
    role: 'assistant',
    finished: true,
    items: [{ type: 'text', text: 'done' }],
  });
  const notice = doc.getList('history').pushContainer(new LoroMap());
  notice.set('id', 'notice');
  notice.set('role', 'system');
  const item = notice
    .setContainer('items', new LoroList())
    .pushContainer(new LoroMap());
  item.set('type', 'system_notice');
  item.set('name', 'agent_warning');
  doc.commit();
  const before = projectSession(doc, 'live');
  assert.equal(before.entries[0].finished, true);
  assert.equal(before.entries[1].items[0].name, 'agent_warning');
  item.set('name', 'chat_failed');
  doc.commit();
  const after = projectSession(doc, 'live');
  assert.equal(after.entries[1].items[0].name, 'chat_failed');
  assert.ok(after.entries[1].rev > before.entries[1].rev);
  assert.equal(after.entries[0].finished, true);
});

test('send persists user before dispatch; duplicate incremental imports preserve one ordered streaming reply', async () => {
  const server = new LoroDoc();
  let sessionRead,
    rpc,
    appends = 0,
    acknowledged = true,
    loseAppendAck = false;
  const frame = (bytes) => {
    const result = new Uint8Array(bytes.length + 4);
    new DataView(result.buffer).setUint32(0, bytes.length, false);
    result.set(bytes, 4);
    return result;
  };
  const ok = (result) => ({ ok: true, result });
  const live = (payload, offset = '2') =>
    ok({ nextOffset: offset, upToDate: true, closed: false, payload });
  globalThis.__sessionClient = class {
    constructor({ url }) {
      this.url = decodeURIComponent(url);
    }
    async bootstrap() {
      return ok({
        snapshotOffset: '1',
        nextOffset: '1',
        upToDate: true,
        snapshot: { body: server.export({ mode: 'snapshot' }) },
        updates: [],
      });
    }
    readOnce() {
      if (this.url.includes(':rpc:res:'))
        return Promise.resolve(
          live({
            body: new TextEncoder().encode(
              JSON.stringify([
                { id: rpc.id, result: { accepted: acknowledged } },
              ]),
            ),
          }),
        );
      return new Promise((resolve) => {
        sessionRead = resolve;
      });
    }
    async create() {
      return ok({});
    }
    async append({ part }) {
      if (this.url.includes(':rpc:req:')) {
        rpc = JSON.parse(part.body);
        assert.equal(server.toJSON().history[0].id, rpc.params.userTurnId);
      } else {
        appends++;
        assert.equal(
          new DataView(part.body.buffer, part.body.byteOffset).getUint32(
            0,
            false,
          ),
          part.body.length - 4,
        );
        server.import(part.body.subarray(4));
      }
      if (loseAppendAck && !this.url.includes(':rpc:req:'))
        return { ok: false, result: { code: 'timeout' } };
      return ok({ nextOffset: '2' });
    }
  };
  const bundle = await build({
    entryPoints: ['packages/cloud-runtime/src/runtime/session.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    plugins: [
      {
        name: 'stream',
        setup(b) {
          b.onResolve({ filter: /^@loro-dev\/streams-client$/ }, () => ({
            path: 'mock',
            namespace: 'test',
          }));
          b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
            contents: 'export const StreamsClient=globalThis.__sessionClient',
          }));
        },
      },
    ],
  });
  const runtime = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
  );
  const events = [];
  const background = [];
  let resolveLive;
  const nextLive = () =>
    new Promise((resolve) => {
      resolveLive = resolve;
    });
  const initial = nextLive();
  await runtime.openSession(
    's1',
    'w1',
    async () => ({
      token: 'synthetic',
      gatewayBaseUrl: 'https://example.invalid',
    }),
    (e) => {
      if (e.backgroundWork) background.push(e.backgroundWork);
      if (!e.session) return;
      const value = JSON.parse(e.session);
      events.push(value);
      if (value.status === 'live') resolveLive?.(value);
    },
    async (sessionId, turnId) => {
      assert.equal(sessionId, 's1');
      assert.equal(server.toJSON().history[0].id, turnId);
    },
  );
  await initial;
  const attachments = [
    {
      type: 'image',
      imageId: 'img1',
      mimeType: 'image/png',
      sizeBytes: 12,
      fileName: '照片.png',
    },
    {
      type: 'file',
      fileId: 'file1',
      fileName: 'note.txt',
      mimeType: 'text/plain',
      sizeBytes: 3,
      sha256: 'abc',
      textPreview: true,
      transport: 'r2',
      uploadedAt: 1,
    },
  ];
  const invalid = await runtime.sendTurn({
    sessionId: 's1',
    text: '',
    attachmentBlocks: [{ type: 'image', uri: 'file:///private/test' }],
  });
  assert.equal(invalid.state, 'not_sent');
  assert.equal(appends, 0);
  const turn = {
    id: '2B066292-A94B-4383-B3C5-A0A7522F31CD',
    sessionId: 's1',
    machineId: 'm1',
    userId: 'u1',
    text: 'POC hello',
    backgroundTaskId: 'background-test',
    attachmentBlocks: attachments,
    cliType: 'builtin',
    agentType: 'codex',
    modelId: 'gpt-test',
    reasoningEffort: 'high',
    reasoningEffortConfigId: 'effort',
  };
  assert.equal(
    (await runtime.sendTurn({ ...turn, id: 'not-a-uuid' })).state,
    'not_sent',
  );
  assert.equal(appends, 0);
  const sending = runtime.sendTurn(turn);
  assert.equal(
    (await runtime.sendTurn(turn)).reason,
    'turn_already_exists',
    'an in-flight duplicate must not be treated as safe to retry',
  );
  const result = await sending;
  assert.equal(result.state, 'accepted');
  assert.equal(result.id, turn.id);
  assert.equal(rpc.params.userTurnId, turn.id);
  const firstRPC = rpc;
  const repeatedTurn = await runtime.sendTurn(turn);
  assert.equal(repeatedTurn.state, 'unknown');
  assert.equal(repeatedTurn.reason, 'turn_already_exists');
  assert.equal(rpc, firstRPC, 'duplicate identity must not dispatch again');
  assert.equal(background.at(-1).state, 'sent'); // Machine ACK is not completion.
  assert.equal(background.at(-1).id, 'background-test');
  assert.equal(appends, 1);
  const user = server.toJSON().history[0];
  assert.equal(user.items[0].text, 'POC hello');
  assert.deepEqual(user.items.slice(1), attachments);
  assert.deepEqual(
    rpc.params.inputConfig.inputBlocks,
    user.inputConfig.inputBlocks,
  );
  assert.deepEqual(user.inputConfig.inputBlocks.slice(1), attachments);
  assert.equal(rpc.params.inputConfig.modelId, 'gpt-test');
  assert.deepEqual(rpc.params.inputConfig.configOptionValues, {
    effort: 'high',
  });
  const projection = runtime.projectSession(server, 'live');
  assert.deepEqual(projection.composer, {
    modelId: 'gpt-test',
    effort: 'high',
  });
  const projectedImage = projection.entries[0].items[1];
  assert.equal(projectedImage.type, 'image');
  assert.equal(projectedImage.image.id, 'img1');
  assert.equal(projectedImage.image.fileName, '照片.png');
  assert.equal(projectedImage.text, undefined);
  const projectedFile = projection.entries[0].items[2];
  assert.equal(projectedFile.type, 'file');
  assert.equal(projectedFile.file.id, attachments[1].fileId);
  assert.equal(projectedFile.file.fileName, attachments[1].fileName);
  assert.equal(
    projectedFile.text,
    undefined,
    'Filenames must not be appended to the message text',
  );

  assert.deepEqual(user.inputConfig.mcpServerIds, []);
  const version = server.version();
  const entry = server.getList('history').pushContainer(new LoroMap());
  entry.set('id', 'reply');
  entry.set('userTurnId', 'another-turn');
  const item = entry
    .setContainer('items', new LoroList())
    .pushContainer(new LoroMap());
  item.set('type', 'text');
  item.setContainer('text', new LoroText()).insert(0, 'stream');
  entry.set('role', 'assistant');
  entry.set('finished', true);
  server.commit();
  const update = server.export({ mode: 'update', from: version });
  const firstReply = nextLive();
  sessionRead(live({ body: frame(update) }));
  assert.equal((await firstReply).entries[1].items[0].text, 'stream');
  assert.equal(background.at(-1).state, 'sent'); // Another turn's completion cannot end this task.
  const correlatedVersion = server.version();
  entry.set('userTurnId', result.id);
  entry.set('finished', false);
  server.commit();
  const correlated = nextLive();
  sessionRead(
    live(
      {
        body: frame(server.export({ mode: 'update', from: correlatedVersion })),
      },
      '2a',
    ),
  );
  await correlated;
  assert.equal(background.at(-1).state, 'receiving');
  const v2 = server.version();
  entry.get('items').get(0).get('text').insert(6, ' complete');
  entry.set('finished', true);
  server.commit();
  const fullUpdate = server.export({ mode: 'update', from: v2 });
  const finalReply = nextLive();
  sessionRead(live({ body: frame(fullUpdate) }, '3'));
  const final = await finalReply;
  assert.equal(background.at(-1).state, 'completed');
  assert.equal(final.entries.length, 2);
  assert.equal(final.entries[1].items[0].text, 'stream complete');
  assert.equal(final.entries[1].finished, true);
  const duplicate = nextLive();
  sessionRead(live({ body: frame(fullUpdate) }, '4'));
  assert.equal((await duplicate).entries.length, 2);
  const misordered = new LoroDoc();
  const assistant = misordered.getList('history').pushContainer(new LoroMap());
  assistant.set('id', 'a');
  assistant.set('role', 'assistant');
  assistant.set('userTurnId', 'u');
  const parent = misordered.getList('history').pushContainer(new LoroMap());
  parent.set('id', 'u');
  parent.set('role', 'user');
  assert.deepEqual(
    runtime.projectSession(misordered, 'live').entries.map((e) => e.id),
    ['u', 'a'],
  );
  const oldRead = sessionRead;
  runtime.stopSessions();
  oldRead(live({ body: frame(update) }, '5'));
  assert.equal(
    (await runtime.sendTurn({ sessionId: 's1', text: 'no' })).state,
    'not_sent',
  );
  assert.equal(appends, 1);
  const reopen = nextLive();
  await runtime.openSession(
    's1',
    'w1',
    async () => ({
      token: 'synthetic',
      gatewayBaseUrl: 'https://example.invalid',
    }),
    (e) => {
      const value = JSON.parse(e.session);
      if (value.status === 'live') resolveLive?.(value);
    },
    async () => {},
  );
  await reopen;
  loseAppendAck = true;
  const uncertain = await runtime.sendTurn({
    sessionId: 's1',
    machineId: 'm1',
    userId: 'u1',
    text: '',
    attachmentBlocks: attachments,
    cliType: 'builtin',
    agentType: 'codex',
  });
  assert.equal(uncertain.state, 'unknown');
  assert.deepEqual(server.toJSON().history.at(-1).items, attachments);
  assert.equal(
    server.toJSON().history.filter((e) => e.id === uncertain.id).length,
    1,
  );
  assert.equal(appends, 2);
  assert.equal(
    (await runtime.sendTurn({ ...turn, id: uncertain.id })).reason,
    'turn_already_exists',
  );
  assert.equal(appends, 2, 'ambiguous append must not be replayed');
  runtime.stopSessions();
  delete globalThis.__sessionClient;
});

async function loadProject() {
  const bundle = await build({
    entryPoints: [
      new URL(
        '../../../../packages/cloud-runtime/src/runtime/project.ts',
        import.meta.url,
      ).pathname,
    ],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    external: ['loro-crdt/base64'],
  });
  return import(
    'data:text/javascript;base64,' +
      Buffer.from(bundle.outputFiles[0].text).toString('base64')
  );
}

test('projection carries stable item ids, tool summaries, and diff counts', async () => {
  const mod = await loadProject();

  const doc = new LoroDoc();
  const entry = doc.getList('history').pushContainer(new LoroMap());
  entry.set('id', 'e1');
  entry.set('role', 'assistant');
  entry.set('finished', false);
  const items = entry.setContainer('items', new LoroList());

  const prose = items.pushContainer(new LoroMap());
  prose.set('type', 'text');
  prose.setContainer('text', new LoroText()).insert(0, '看了一眼 auth.ts');

  const call = items.pushContainer(new LoroMap());
  call.set('type', 'tool_call');
  call.set('toolCallId', 'tc_1');
  call.set('kind', 'edit');
  call.set('title', 'Edit src/auth.ts');
  call.set('status', 'completed');
  call.set('content', [
    {
      type: 'diff',
      path: 'src/auth.ts',
      oldText: 'a\nb\nc\n',
      newText: 'a\nB\nc\nd\n',
    },
  ]);
  doc.commit();

  const first = mod.projectSession(doc, 'live');
  assert.equal(first.v, 1);
  assert.equal(first.entries.length, 1);

  const [textItem, toolItem] = first.entries[0].items;
  assert.equal(textItem.type, 'text');
  assert.equal(textItem.text, '看了一眼 auth.ts');
  assert.match(textItem.itemId, /^\d+:\d+$/);

  assert.equal(toolItem.itemId, 'tc_1');
  assert.equal(toolItem.kind, 'edit');
  assert.equal(toolItem.path, 'src/auth.ts');
  assert.equal(toolItem.added, 2);
  assert.equal(toolItem.removed, 1);
  assert.equal(toolItem.hasDetail, true);
  assert.equal(toolItem.permission, undefined);

  const idBefore = textItem.itemId;
  prose.get('text').insert(11, '，超时来自 fetch');
  doc.commit();
  const second = mod.projectSession(doc, 'live');
  assert.equal(second.entries[0].items[0].itemId, idBefore);
  assert.ok(second.entries[0].items[0].rev > textItem.rev);
  assert.equal(second.entries[0].items[1].rev, toolItem.rev);
  assert.ok(second.revision > first.revision);
});

test('projection keeps subagent task identity and live fields', async () => {
  const { projectSession } = await loadProject();
  const doc = new LoroDoc();
  const entry = doc.getList('history').pushContainer(new LoroMap());
  entry.set('id', 'e-task');
  entry.set('role', 'assistant');
  const task = entry
    .setContainer('items', new LoroList())
    .pushContainer(new LoroMap());
  task.set('type', 'subagent_task');
  task.set('taskId', 't1');
  task.set('status', 'in_progress');
  task.set('actor', 'Explore');
  task.set('description', 'Find overlay chrome');
  task.set('lastToolName', 'Read');
  task.set('summary', 'Still looking');
  task.set('error', 'none');
  task.set('isBackgrounded', true);
  task.set('skipTranscript', false);
  doc.commit();
  const item = projectSession(doc, 'live').entries[0].items[0];
  assert.equal(item.type, 'subagent_task');
  assert.equal(item.taskId, 't1');
  assert.equal(item.status, 'in_progress');
  assert.equal(item.actor, 'Explore');
  assert.equal(item.description, 'Find overlay chrome');
  assert.equal(item.lastToolName, 'Read');
  assert.equal(item.summary, 'Still looking');
  assert.equal(item.error, 'none');
  assert.equal(item.isBackgrounded, true);
  assert.equal(item.skipTranscript, false);
});

test('subtask run projection and tool details survive live updates and cache restoration', async () => {
  const fixture = await openTestSession();
  try {
    const run = {
      sessionId: 'child',
      snapshot: { state: 'running' },
      items: [
        { type: 'thought', text: 'Trace the composer' },
        {
          type: 'tool_call',
          toolCallId: 'read',
          kind: 'read',
          title: 'Read composer',
          status: 'completed',
          content: [{ type: 'output', output: 'first' }],
        },
        {
          type: 'plan',
          entries: [{ content: 'Move task chip', status: 'in_progress' }],
        },
        { type: 'text', text: 'Found the chip row' },
        { type: 'subagent_task', taskId: 'ignored' },
      ],
    };
    const entry = fixture.server
      .getList('history')
      .pushContainer(new LoroMap());
    entry.set('id', 'reply');
    entry.set('role', 'assistant');
    const task = entry
      .setContainer('items', new LoroList())
      .pushContainer(new LoroMap());
    task.set('type', 'subagent_task');
    task.set('taskId', 'task');
    task.set('status', 'in_progress');
    task.set('run', run);
    fixture.server.commit();
    await fixture.pushUpdate();
    const before = fixture.runtime.projectSession(fixture.server, 'live')
      .entries[0].items[0];
    assert.deepEqual(
      before.run.items.map((item) => item.type),
      ['thought', 'tool_call', 'plan', 'text'],
    );
    assert.equal(before.run.items[0].text, 'Trace the composer');
    const tool = before.run.items[1];
    assert.equal(tool.hasDetail, true);
    const detail = await fixture.runtime.itemDetail({
      sessionId: 's1',
      entryId: 'reply',
      itemId: tool.itemId,
    });
    assert.equal(detail.blocks[0].output, 'first');
    run.items[1].content[0].output = 'updated';
    run.snapshot.state = 'completed';
    task.set('run', run);
    fixture.server.commit();
    await fixture.pushUpdate();
    const after = fixture.runtime.projectSession(fixture.server, 'live')
      .entries[0].items[0];
    assert.equal(after.run.items[1].itemId, tool.itemId);
    assert.ok(after.run.items[1].rev > tool.rev);
    assert.ok(after.rev > before.rev);
    assert.equal(
      (
        await fixture.runtime.itemDetail({
          sessionId: 's1',
          entryId: 'reply',
          itemId: tool.itemId,
        })
      ).blocks[0].output,
      'updated',
    );
    const restored = new LoroDoc();
    restored.import(fixture.server.export({ mode: 'snapshot' }));
    assert.equal(
      fixture.runtime.projectSession(restored, 'live').entries[0].items[0].run
        .state,
      'completed',
    );
    await assert.rejects(
      fixture.runtime.itemDetail({
        sessionId: 's1',
        entryId: 'reply',
        itemId: JSON.stringify(['missing', 'read']),
      }),
      /item_not_found/,
    );
  } finally {
    fixture.close();
  }
});

test('MCP image groups survive projection, cache updates and history bootstrap', async () => {
  const { projectSession } = await loadProject();
  const doc = new LoroDoc();
  const entry = doc.getList('history').pushContainer(new LoroMap());
  entry.set('id', 'upload');
  entry.set('role', 'assistant');
  const group = entry
    .setContainer('items', new LoroList())
    .pushContainer(new LoroMap());
  group.set('type', 'image_group');
  const photo = {
    imageId: 'photo',
    fileName: 'photo.png',
    storageSessionId: 'source',
    width: 600,
    height: 400,
  };
  group.set('images', [photo]);
  doc.commit();
  const first = projectSession(doc, 'live').entries[0].items[0];
  assert.deepEqual(first.images, [
    {
      id: 'photo',
      fileName: 'photo.png',
      storageSessionId: 'source',
      width: 600,
      height: 400,
    },
  ]);
  group.set('images', [
    photo,
    { ...photo, imageId: 'second' },
    null,
    { imageId: '' },
  ]);
  doc.commit();
  const second = projectSession(doc, 'live').entries[0].items[0];
  assert.equal(second.itemId, first.itemId);
  assert.ok(second.rev > first.rev);
  assert.deepEqual(
    second.images.map((image) => image.id),
    ['photo', 'second'],
  );
  const restored = new LoroDoc();
  restored.import(doc.export({ mode: 'snapshot' }));
  assert.deepEqual(
    projectSession(restored, 'live').entries[0].items[0].images,
    second.images,
  );
});

test('MCP files retain their download target and update when local upload completes', async () => {
  const { projectSession } = await loadProject();
  const doc = new LoroDoc();
  const entry = doc.getList('history').pushContainer(new LoroMap());
  entry.set('id', 'files');
  entry.set('role', 'assistant');
  const file = entry
    .setContainer('items', new LoroList())
    .pushContainer(new LoroMap());
  for (const [key, value] of Object.entries({
    type: 'file',
    fileId: 'clip',
    fileName: 'clip.mp4',
    storageSessionId: 'source',
    transport: 'local',
    sizeBytes: 1024,
  }))
    file.set(key, value);
  doc.commit();
  const first = projectSession(doc, 'live').entries[0].items[0];
  assert.equal(first.file.transport, 'local');
  file.set('transport', 'r2');
  doc.commit();
  const uploaded = projectSession(doc, 'live').entries[0].items[0];
  assert.equal(uploaded.itemId, first.itemId);
  assert.ok(uploaded.rev > first.rev);
  assert.deepEqual(uploaded.file, {
    id: 'clip',
    fileName: 'clip.mp4',
    storageSessionId: 'source',
    transport: 'r2',
    sizeBytes: 1024,
  });
  const restored = new LoroDoc();
  restored.import(doc.export({ mode: 'snapshot' }));
  assert.deepEqual(
    projectSession(restored, 'live').entries[0].items[0].file,
    uploaded.file,
  );
});

test('unchanged entries keep their summary objects; prose is coalesced, status is not', async () => {
  const { projectSession } = await loadProject();
  const doc = new LoroDoc();
  const first = doc.getList('history').pushContainer(new LoroMap());
  first.set('id', 'e1');
  first.set('role', 'user');
  const second = doc.getList('history').pushContainer(new LoroMap());
  second.set('id', 'e2');
  second.set('role', 'assistant');
  const items = second.setContainer('items', new LoroList());
  const prose = items.pushContainer(new LoroMap());
  prose.set('type', 'text');
  prose.setContainer('text', new LoroText()).insert(0, 'hi');
  doc.commit();

  const a = projectSession(doc, 'live');
  prose.get('text').insert(2, ' there');
  doc.commit();
  const b = projectSession(doc, 'live');

  assert.equal(a.entries[0].rev, b.entries[0].rev);
  assert.ok(b.entries[1].rev > a.entries[1].rev);
});

test('itemDetail 按需取回 blocks，超限分页，缺失明确报错', async () => {
  const { runtime, server, pushUpdate, close } = await openTestSession();
  const entry = server.getList('history').pushContainer(new LoroMap());
  entry.set('id', 'e9');
  entry.set('role', 'assistant');
  const items = entry.setContainer('items', new LoroList());
  const call = items.pushContainer(new LoroMap());
  call.set('type', 'tool_call');
  call.set('toolCallId', 'tc_9');
  call.set('kind', 'execute');
  call.set('status', 'completed');
  call.set('content', [
    { type: 'terminal_command', command: 'pnpm', args: ['test'], cwd: '/w' },
    { type: 'terminal_output', output: 'ok\n', stream: 'combined' },
  ]);
  server.commit();
  await pushUpdate();

  const detail = await runtime.itemDetail({
    sessionId: 's1',
    entryId: 'e9',
    itemId: 'tc_9',
  });
  assert.equal(detail.itemId, 'tc_9');
  assert.equal(detail.blocks.length, 2);
  assert.equal(detail.blocks[0].command, 'pnpm');
  assert.equal(detail.truncated, false);
  assert.equal(detail.nextCursor, undefined);
  assert.ok(detail.rev > 0);

  call.set('content', [
    { type: 'terminal_output', output: 'x'.repeat(400 * 1024) },
    { type: 'terminal_output', output: 'y'.repeat(400 * 1024) },
  ]);
  server.commit();
  await pushUpdate();

  const page1 = await runtime.itemDetail({
    sessionId: 's1',
    entryId: 'e9',
    itemId: 'tc_9',
  });
  assert.equal(page1.truncated, true);
  assert.equal(page1.blocks.length, 1);
  assert.ok(page1.nextCursor);

  const page2 = await runtime.itemDetail({
    sessionId: 's1',
    entryId: 'e9',
    itemId: 'tc_9',
    cursor: page1.nextCursor,
  });
  assert.equal(page2.blocks.length, 1);
  assert.equal(page2.truncated, false);

  await assert.rejects(
    runtime.itemDetail({ sessionId: 's1', entryId: 'e9', itemId: 'nope' }),
    /item_not_found/,
  );

  await assert.rejects(
    runtime.itemDetail({ sessionId: 'other', entryId: 'e9', itemId: 'tc_9' }),
    /session_not_ready/,
  );
  close();
});

test('tool calls whose toolCallId is a LoroText still resolve for detail and permission answers', async () => {
  const { runtime, server, pushUpdate, close } = await openTestSession();
  const entry = server.getList('history').pushContainer(new LoroMap());
  entry.set('id', 'e10');
  entry.set('role', 'assistant');
  const items = entry.setContainer('items', new LoroList());
  const call = items.pushContainer(new LoroMap());
  call.setContainer('type', new LoroText()).insert(0, 'tool_call');
  call.setContainer('toolCallId', new LoroText()).insert(0, 'exec-text');
  call.set('kind', 'execute');
  call.set('status', 'pending');
  call.set('content', [
    { type: 'terminal_command', command: 'pnpm', args: [], cwd: '/w' },
  ]);
  call.set('permissionRequest', {
    requestId: 'req-1',
    options: [{ optionId: 'allow_once', name: 'Yes', kind: 'allow_once' }],
  });
  server.commit();
  await pushUpdate();

  const detail = await runtime.itemDetail({
    sessionId: 's1',
    entryId: 'e10',
    itemId: 'exec-text',
  });
  assert.equal(detail.blocks.length, 1);
  assert.equal(detail.options.length, 1);

  const answer = await runtime.respondPermission({
    sessionId: 's1',
    entryId: 'e10',
    itemId: 'exec-text',
    requestId: 'req-1',
    optionId: 'allow_once',
  });
  assert.equal(answer.state, 'accepted');
  close();
});

test(
  'background Sessions keep syncing, visits promote LRU, eviction aborts reads and preserves the final cache',
  { timeout: 15000 },
  async (t) => {
    const servers = new Map();
    const clients = [];
    const events = [];
    const waiters = [];
    const ok = (result) => ({ ok: true, result });
    const until = (predicate) =>
      new Promise((resolve) => waiters.push({ predicate, resolve }));
    const emit = (event) => {
      if (!event.session) return;
      const value = { ...event, data: JSON.parse(event.session) };
      events.push(value);
      for (const waiter of [...waiters]) {
        if (waiter.predicate(value)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(value);
        }
      }
    };
    globalThis.__sessionClient = class {
      constructor({ url }) {
        this.id = decodeURIComponent(url).split(':s:')[1];
        clients.push(this);
      }
      async bootstrap({ signal }) {
        this.signal = signal;
        const server = servers.get(this.id) ?? new LoroDoc();
        if (!server.getList('history').length) {
          const entry = server.getList('history').pushContainer(new LoroMap());
          entry.set('id', 'same-entry');
          entry.set('role', 'assistant');
          entry.set('finished', this.id.startsWith('idle-'));
          const item = entry
            .setContainer('items', new LoroList())
            .pushContainer(new LoroMap());
          item.set('type', 'tool_call');
          item.set('toolCallId', 'same-tool');
        }
        servers.set(this.id, server);
        this.version = server.version();
        return ok({
          snapshotOffset: '1',
          nextOffset: '1',
          upToDate: true,
          snapshot: { body: server.export({ mode: 'snapshot' }) },
          updates: [],
        });
      }
      readOnce(request) {
        this.request = request;
        return new Promise((resolve, reject) => {
          this.resolve = resolve;
          request.signal.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          );
        });
      }
      push(text) {
        const server = servers.get(this.id);
        let entry = server.getList('history').get(0);
        if (!entry) {
          entry = server.getList('history').pushContainer(new LoroMap());
          // Deliberately collide across Sessions to exercise projection isolation.
          entry.set('id', 'same-entry');
          entry.set('role', 'assistant');
          const item = entry
            .setContainer('items', new LoroList())
            .pushContainer(new LoroMap());
          item.set('type', 'tool_call');
          item.set('toolCallId', 'same-tool');
        }
        entry.set('finished', false);
        entry.get('items').get(0).set('title', text);
        server.commit();
        const body = frame(
          server.export({ mode: 'update', from: this.version }),
        );
        this.version = server.version();
        this.resolve(
          ok({
            nextOffset: String(Number(this.request.offset) + 1),
            upToDate: true,
            closed: false,
            payload: { body },
          }),
        );
      }
    };
    const runtime = await loadRuntime();
    t.after(() => {
      runtime.stopSessions();
      delete globalThis.__sessionClient;
    });
    const open = async (id, workspace = 'w1') => {
      const ready = until(
        (e) =>
          e.sessionId === id &&
          e.type === 'session' &&
          e.data.status === 'live',
      );
      await runtime.openSession(
        id,
        workspace,
        async () => ({
          token: 'synthetic',
          gatewayBaseUrl: 'https://x.invalid',
        }),
        emit,
        async () => {},
      );
      return ready;
    };
    const client = (id) => clients.findLast((c) => c.id === id);
    await open('a');
    await open('b');
    await open('c');
    runtime.closeSession();
    for (const id of ['idle-one', 'idle-two', 'idle-three']) await open(id);
    assert.ok(
      ['a', 'b', 'c'].every((id) => !client(id).signal.aborted),
      'idle visits must not evict working sessions',
    );
    assert.ok(
      client('idle-one').signal.aborted && client('idle-two').signal.aborted,
      'idle sessions must not remain in the background LRU',
    );
    runtime.closeSession();
    assert.equal(client('idle-three').signal.aborted, true);
    await open('d');
    assert.equal(clients.filter((c) => !c.signal.aborted).length, 4);
    const background = until(
      (e) =>
        e.sessionId === 'a' &&
        e.type === 'sessionCache' &&
        e.data.entries.length,
    );
    client('a').push('changed while away');
    const cached = await background;
    assert.equal(cached.synced, true);
    assert.equal(cached.data.entries[0].items[0].title, 'changed while away');
    assert.equal(
      events.filter((e) => e.sessionId === 'a' && e.type === 'session').length,
      2,
    );

    await open('e');
    assert.equal(
      client('a').signal.aborted,
      true,
      'updates must not promote a',
    );
    const bCount = clients.filter((c) => c.id === 'b').length;
    await open('b');
    assert.equal(
      clients.filter((c) => c.id === 'b').length,
      bCount,
      'retained replica needs no bootstrap',
    );
    await open('f');
    assert.equal(client('c').signal.aborted, true, 'visiting b protects it');
    assert.equal(client('b').signal.aborted, false);

    const bUpdate = until(
      (e) =>
        e.sessionId === 'b' &&
        e.type === 'sessionCache' &&
        e.data.entries.length,
    );
    client('b').push('b version one');
    const before = await bUpdate;
    const fUpdate = until((e) => e.sessionId === 'f' && e.data.entries.length);
    client('f').push('different session');
    await fUpdate;
    const reopened = await open('b');
    assert.equal(reopened.data.entries[0].items[0].title, 'b version one');
    assert.equal(
      reopened.data.entries[0].items[0].rev,
      before.data.entries[0].items[0].rev,
    );
    assert.equal(
      (
        await runtime.itemDetail({
          sessionId: 'b',
          entryId: 'same-entry',
          itemId: 'same-tool',
        })
      ).rev,
      before.data.entries[0].items[0].rev,
    );

    runtime.closeSession();
    assert.equal(
      clients.filter((c) => !c.signal.aborted).length,
      3,
      'no foreground means only three subscriptions',
    );
    assert.equal(
      (await runtime.sendTurn({ sessionId: 'b', text: 'hidden' })).state,
      'not_sent',
    );
    const afterClose = until(
      (e) =>
        e.sessionId === 'b' &&
        e.type === 'sessionCache' &&
        e.data.entries[0]?.items[0]?.title === 'after close',
    );
    client('b').push('after close');
    await afterClose;
    const count = clients.length;
    assert.equal(
      (await open('b')).data.entries[0].items[0].title,
      'after close',
    );
    assert.equal(clients.length, count);

    // Queue an update on the oldest Session and evict before its cache timer fires.
    client('e').push('last before eviction');
    await new Promise((resolve) => setImmediate(resolve));
    await open('g');
    await open('h');
    assert.equal(client('e').signal.aborted, true);
    assert.ok(
      events.some(
        (e) =>
          e.sessionId === 'e' &&
          e.type === 'sessionCache' &&
          e.data.entries[0]?.items[0]?.title === 'last before eviction',
      ),
    );
    const oldClients = [...clients];
    await open('b', 'other-workspace');
    assert.ok(oldClients.every((c) => c.signal.aborted));
    await open('idle-start', 'other-workspace');
    const started = until(
      (e) =>
        e.sessionId === 'idle-start' && e.data.entries[0]?.finished === false,
    );
    client('idle-start').push('actually working now');
    await started;
    runtime.closeSession();
    assert.equal(
      client('idle-start').signal.aborted,
      false,
      'an idle foreground session enters the LRU once it starts working',
    );
    runtime.stopSessions();
    assert.ok(clients.every((c) => c.signal.aborted));
  },
);

test('closeSession does not abort an in-flight send or block a later send on the retained replica', async () => {
  let releaseExpand;
  const fixture = await openTestSession({
    onRpc: () => ({ result: { accepted: true } }),
  });
  const args = {
    sessionId: 's1',
    machineId: 'm1',
    userId: 'u1',
    cliType: 'builtin',
    agentType: 'grok',
    text: 'keep sending',
  };
  try {
    const sending = fixture.runtime.sendTurn(args, async (text) => {
      await new Promise((resolve) => {
        releaseExpand = resolve;
      });
      return text;
    });
    fixture.runtime.closeSession();
    releaseExpand();
    assert.equal((await sending).state, 'accepted');
    assert.equal(
      (await fixture.runtime.sendTurn({ ...args, text: 'second' })).state,
      'queued',
    );
  } finally {
    fixture.close();
  }
});

test(
  'ensureSession reserves a replica so visit-order LRU cannot evict it until release',
  { timeout: 15000 },
  async (t) => {
    const servers = new Map();
    const clients = [];
    const events = [];
    const waiters = [];
    const ok = (result) => ({ ok: true, result });
    const until = (predicate) =>
      new Promise((resolve) => waiters.push({ predicate, resolve }));
    const emit = (event) => {
      if (!event.session) return;
      const value = { ...event, data: JSON.parse(event.session) };
      events.push(value);
      for (const waiter of [...waiters]) {
        if (waiter.predicate(value)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(value);
        }
      }
    };
    const grant = async () => ({
      token: 'synthetic',
      gatewayBaseUrl: 'https://x.invalid',
    });
    globalThis.__sessionClient = class {
      constructor({ url }) {
        this.id = decodeURIComponent(url).split(':s:')[1];
        clients.push(this);
      }
      async bootstrap({ signal }) {
        this.signal = signal;
        const server = servers.get(this.id) ?? new LoroDoc();
        if (!server.getList('history').length)
          server.getList('history').push({
            id: 'working',
            role: 'assistant',
            finished: false,
            items: [],
          });
        servers.set(this.id, server);
        this.version = server.version();
        return ok({
          snapshotOffset: '1',
          nextOffset: '1',
          upToDate: true,
          snapshot: { body: server.export({ mode: 'snapshot' }) },
          updates: [],
        });
      }
      readOnce(request) {
        this.request = request;
        return new Promise((resolve, reject) => {
          this.resolve = resolve;
          request.signal.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          );
        });
      }
    };
    const runtime = await loadRuntime();
    t.after(() => {
      runtime.stopSessions();
      delete globalThis.__sessionClient;
    });
    const live = (id) =>
      until((e) => e.sessionId === id && e.data.status === 'live');
    const open = async (id) => {
      const ready = live(id);
      await runtime.openSession(id, 'w1', grant, emit, async () => {});
      return ready;
    };
    const ensure = async (id) => {
      const ready = live(id);
      await runtime.ensureSession(id, 'w1', grant, emit, async () => {});
      return ready;
    };
    const client = (id) => clients.findLast((c) => c.id === id);

    await ensure('held');
    assert.equal(
      events.filter((e) => e.sessionId === 'held' && e.type === 'session')
        .length,
      0,
      'ensure must not steal the foreground pointer',
    );
    const heldCount = clients.filter((c) => c.id === 'held').length;
    await ensure('held');
    assert.equal(
      clients.filter((c) => c.id === 'held').length,
      heldCount,
      'ensure of a live replica must not bootstrap again',
    );

    await open('b');
    await open('c');
    await open('d');
    await open('e');
    assert.equal(client('held').signal.aborted, false);
    assert.equal(
      clients.filter((c) => !c.signal.aborted).length,
      5,
      'one reserved replica sits outside the three background LRU slots',
    );

    runtime.releaseReserve('held');
    await open('f');
    await open('g');
    await open('h');
    await open('i');
    assert.equal(
      client('held').signal.aborted,
      true,
      'a graduated replica returns to visit-order eviction',
    );
  },
);

test(
  'eviction during authorization cannot start a late bootstrap',
  { timeout: 5000 },
  async (t) => {
    const bootstraps = [];
    globalThis.__sessionClient = class {
      constructor({ url }) {
        this.url = url;
      }
      async bootstrap() {
        bootstraps.push(this.url);
        return { ok: false, result: { code: 'synthetic_offline' } };
      }
    };
    const runtime = await loadRuntime();
    t.after(() => {
      runtime.stopSessions();
      delete globalThis.__sessionClient;
    });
    let authorize;
    const grant = new Promise((resolve) => {
      authorize = resolve;
    });
    const events = [];
    for (const id of ['late-a', 'late-b', 'late-c', 'late-d', 'late-e'])
      await runtime.openSession(
        id,
        'w1',
        () => grant,
        (e) => events.push(e),
        async () => {},
      );
    authorize({ token: 'synthetic', gatewayBaseUrl: 'https://x.invalid' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(bootstraps.length, 1);
    assert.ok(
      bootstraps.every((url) => !decodeURIComponent(url).endsWith(':late-a')),
    );
    assert.ok(
      events
        .filter((e) => e.sessionId === 'late-a')
        .filter((e) => e.session)
        .every((e) => JSON.parse(e.session).status === 'syncing'),
    );
    const before = bootstraps.length;
    await runtime.openSession(
      'late-e',
      'w1',
      () => grant,
      () => {},
      async () => {},
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      bootstraps.length,
      before,
      'opening a reconnecting Session reuses its automatic retry',
    );
  },
);

test(
  'session bootstrap and stream reads recover without another watch or writes',
  { timeout: 8000 },
  async (t) => {
    let bootstraps = 0;
    const reads = [];
    const events = [];
    const history = new LoroDoc();
    let recovered;
    const recovery = new Promise((resolve) => {
      recovered = resolve;
    });
    globalThis.__sessionClient = class {
      async bootstrap() {
        if (++bootstraps === 1) throw new Error('network unavailable');
        return {
          ok: true,
          result: {
            snapshotOffset: '7',
            snapshot: { body: history.export({ mode: 'snapshot' }) },
            updates: [],
            nextOffset: '7',
            cursor: 'cursor-7',
            upToDate: true,
          },
        };
      }
      async readOnce(request) {
        reads.push({ offset: request.offset, cursor: request.cursor });
        if (reads.length === 1)
          return { ok: false, result: { code: 'network_error' } };
        if (reads.length === 2)
          return {
            ok: true,
            result: {
              nextOffset: '8',
              cursor: 'cursor-8',
              upToDate: true,
              closed: false,
            },
          };
        recovered();
        return new Promise((resolve, reject) => {
          request.signal.addEventListener(
            'abort',
            () => reject(request.signal.reason),
            { once: true },
          );
        });
      }
      append() {
        assert.fail('read recovery must never append');
      }
    };
    const runtime = await loadRuntime();
    runtime.appendUserTurn(
      history,
      'saved-turn',
      'Existing message',
      'u1',
      {},
      '2026-09-11T00:00:00Z',
    );
    t.after(() => {
      runtime.stopSessions();
      delete globalThis.__sessionClient;
    });
    await runtime.openSession(
      'recovery',
      'w1',
      async () => ({
        token: 'synthetic',
        gatewayBaseUrl: 'https://x.invalid',
      }),
      (event) => events.push(JSON.parse(event.session)),
      async () => {
        assert.fail('read recovery must never dispatch');
      },
    );
    await recovery;
    assert.equal(bootstraps, 2);
    assert.deepEqual(reads, [
      { offset: '7', cursor: 'cursor-7' },
      { offset: '7', cursor: 'cursor-7' },
      { offset: '8', cursor: 'cursor-8' },
    ]);
    assert.equal(events.at(-1).status, 'live');
    const firstLive = events.find((event) => event.status === 'live');
    assert.equal(firstLive.entries.length, 1);
    assert.deepEqual(events.at(-1).entries, firstLive.entries);
    assert.ok(events.every((event) => event.status !== 'offline'));
  },
);

test('busy turns use the OSS FIFO queue, durable before watermark; lost ACK is never replayed', async () => {
  let fail = false;
  const watermarks = [];
  const fixture = await openTestSession({
    failAppend: () => fail,
    markDispatch: async (sessionId, turnId, queued) => {
      assert.equal(queued, true);
      assert.ok(
        fixture.server.toJSON().mq.some((item) => item.userTurnId === turnId),
      );
      watermarks.push(turnId);
    },
  });
  try {
    const args = {
      sessionId: 's1',
      machineId: 'm1',
      userId: 'u1',
      text: 'next',
      cliType: 'builtin',
      agentType: 'codex',
      modelId: 'picked',
    };
    // Catalog busy can arrive before the first assistant history entry.
    assert.equal(
      (await fixture.runtime.sendTurn({ ...args, queue: true })).state,
      'queued',
    );
    assert.equal((fixture.server.toJSON().history ?? []).length, 0);
    fixture.server.getMovableList('mq').delete(0, 1);
    watermarks.length = 0;
    fixture.server
      .getList('history')
      .push({ id: 'running', role: 'assistant', finished: false, items: [] });
    fixture.server.commit();
    await fixture.pushUpdate();
    const first = await fixture.runtime.sendTurn(args);
    const image = {
      type: 'image',
      imageId: 'queued-image',
      mimeType: 'image/png',
      sizeBytes: 12,
    };
    const second = await fixture.runtime.sendTurn({
      ...args,
      text: 'then',
      attachmentBlocks: [image],
    });
    assert.equal(first.state, 'queued');
    assert.equal(second.state, 'queued');
    assert.deepEqual(
      fixture.server.toJSON().mq.map((item) => item.userTurnId),
      [first.id, second.id],
    );
    assert.deepEqual(watermarks, [first.id, second.id]);
    assert.deepEqual(
      fixture.server.toJSON().mq[1].acpSessionConfig.inputBlocks,
      [{ type: 'text', text: 'then' }, image],
    );
    assert.equal(
      fixture.server.toJSON().history.length,
      1,
      'queue must not create a dispatchable user history entry',
    );
    assert.equal(
      fixture.server.toJSON().mq[0].acpSessionConfig.modelId,
      'picked',
    );
    assert.ok(
      fixture.appends.every((url) => !url.includes(':rpc:')),
      'queue must not call dispatch-turn',
    );
    const projected = fixture.runtime.projectSession(fixture.server, 'live');
    assert.deepEqual(
      projected.entries.slice(1).map((entry) => entry.status),
      ['queued', 'queued'],
    );
    assert.equal(projected.entries[1].items[0].text, 'next');
    assert.equal(
      (await fixture.runtime.sendTurn({ ...args, id: first.id })).state,
      'unknown',
    );
    fail = true;
    const lost = await fixture.runtime.sendTurn(args);
    assert.equal(lost.state, 'unknown');
    const count = fixture.appends.length;
    assert.equal(
      (await fixture.runtime.sendTurn({ ...args, id: lost.id })).state,
      'unknown',
    );
    assert.equal(fixture.appends.length, count);
    assert.equal(watermarks.length, 2);
  } finally {
    fixture.close();
  }
});

test('guide writes a steer history turn instead of the FIFO queue and retains its Role', async () => {
  const requests = [];
  const fixture = await openTestSession({
    onRpc: (request) => {
      requests.push(request);
      const raw = fixture.server.toJSON();
      const entry = raw.history.find(
        (item) => item.id === request.params.userTurnId,
      );
      assert.equal(
        entry.status,
        'pending_apply',
        'guide intent must be durable before RPC',
      );
      assert.equal((raw.mq ?? []).length, 0);
      return { result: { applied: true } };
    },
  });
  try {
    fixture.server.getList('history').push({
      id: 'role-input',
      role: 'user',
      finished: true,
      status: 'handled',
      items: [],
      inputConfig: {
        cliType: 'builtin',
        agentType: 'codex',
        agentRoleId: 'role-coder',
        agentRoleRevision: 3,
      },
    });
    fixture.server.getList('history').push({
      id: 'running',
      role: 'assistant',
      finished: false,
      items: [],
    });
    fixture.server.commit();
    await fixture.pushUpdate();
    const result = await fixture.runtime.sendTurn({
      sessionId: 's1',
      machineId: 'm1',
      userId: 'u1',
      text: 'steer now',
      cliType: 'builtin',
      agentType: 'codex',
      guide: true,
    });
    assert.equal(result.state, 'uploaded');
    await new Promise((resolve) => setImmediate(resolve));
    const raw = fixture.server.toJSON();
    assert.equal((raw.mq ?? []).length, 0);
    const entry = raw.history.find((item) => item.id === result.id);
    assert.equal(entry.role, 'user');
    assert.equal(entry.status, 'processing');
    assert.equal(entry.inputConfig?._lodyDeliveryKind, 'steer');
    const projected = fixture.runtime
      .projectSession(fixture.server, 'live')
      .entries.find((item) => item.id === result.id);
    assert.equal(projected.status, 'processing');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'session/steer');
    assert.equal(requests[0].params.expectedTurnId, 'running');
    assert.equal(requests[0].params.userTurnId, result.id);
    assert.equal(requests[0].params.inputConfig.agentRoleId, 'role-coder');
    assert.equal(requests[0].params.inputConfig.agentRoleRevision, 3);
    assert.equal(entry.inputConfig.agentRoleId, 'role-coder');
  } finally {
    fixture.close();
  }
});

test('foreground sends retain their replica through page changes and only released reserves enter the LRU', async () => {
  const fixture = await openTestSession({
    onRpc: () => ({ result: { accepted: true } }),
  });
  const grant = async () => ({
    token: 'synthetic',
    gatewayBaseUrl: 'https://x.invalid',
  });
  try {
    let resume;
    const send = fixture.runtime.sendTurn(
      {
        sessionId: 's1',
        machineId: 'm1',
        userId: 'u1',
        text: 'expanded',
        cliType: 'builtin',
        agentType: 'codex',
      },
      () =>
        new Promise((resolve) => {
          resume = resolve;
        }),
    );
    fixture.runtime.closeSession();
    for (let i = 0; i < 6; i++)
      await fixture.runtime.openSession(
        `visit-${i}`,
        'w1',
        grant,
        () => {},
        async () => {},
      );
    assert.ok(fixture.runtime.retainedSessionIds().includes('s1'));
    resume('expanded');
    assert.equal((await send).state, 'accepted');
    fixture.runtime.releaseReserve('s1');
    assert.ok(
      fixture.runtime.retainedSessionIds().includes('s1'),
      'a submitted turn stays subscribed before its first assistant event',
    );
    for (let i = 6; i < 10; i++) {
      await fixture.runtime.openSession(
        `visit-${i}`,
        'w1',
        grant,
        () => {},
        async () => {},
      );
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(!fixture.runtime.retainedSessionIds().includes('s1'));
  } finally {
    fixture.close();
  }
});

test('completed background work retires its idle replica without reporting a failure', async () => {
  const fixture = await openTestSession({
    onRpc: () => ({ result: { accepted: true } }),
  });
  try {
    const sent = await fixture.runtime.sendTurn({
      sessionId: 's1',
      machineId: 'm1',
      userId: 'u1',
      text: 'finish offscreen',
      cliType: 'builtin',
      agentType: 'codex',
      backgroundTaskId: 'completion',
    });
    assert.equal(sent.state, 'accepted');
    fixture.runtime.releaseReserve('s1');
    fixture.runtime.closeSession();
    fixture.server.getList('history').push({
      id: 'reply',
      role: 'assistant',
      userTurnId: sent.id,
      finished: true,
      items: [],
    });
    await fixture.pushUpdate();
    assert.deepEqual(fixture.background.at(-1), {
      id: 'completion',
      state: 'completed',
    });
    assert.deepEqual(fixture.runtime.retainedSessionIds(), []);
  } finally {
    fixture.close();
  }
});

test('restoring ordinary background visits does not reserve them', async () => {
  const fixture = await openTestSession();
  const grant = async () => ({
    token: 'synthetic',
    gatewayBaseUrl: 'https://x.invalid',
  });
  try {
    fixture.runtime.stopSessions();
    for (const id of ['old-a', 'old-b', 'old-c'])
      await fixture.runtime.openSession(
        id,
        'w1',
        grant,
        () => {},
        async () => {},
        false,
      );
    for (let i = 0; i < 6; i++)
      await fixture.runtime.openSession(
        `new-${i}`,
        'w1',
        grant,
        () => {},
        async () => {},
      );
    assert.ok(
      fixture.runtime.retainedSessionIds().every((id) => id.startsWith('new-')),
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fixture.runtime.retainedSessionIds().length, 1);
    assert.equal(fixture.runtime.reservedSessionIds().length, 0);
  } finally {
    fixture.close();
  }
});

test('guide rechecks the target after preparation and dispatches normally if it ended', async () => {
  const requests = [];
  const fixture = await openTestSession({
    onRpc: (request) => {
      requests.push(request);
      return { result: { accepted: true } };
    },
  });
  try {
    fixture.server
      .getList('history')
      .push({ id: 'running', role: 'assistant', finished: false, items: [] });
    fixture.server.commit();
    await fixture.pushUpdate();
    const result = await fixture.runtime.sendTurn(
      {
        sessionId: 's1',
        machineId: 'm1',
        userId: 'u1',
        text: 'follow-up',
        cliType: 'builtin',
        agentType: 'codex',
        guide: true,
      },
      async (text) => {
        fixture.server.getList('history').delete(0, 1);
        fixture.server.getList('history').push({
          id: 'running',
          role: 'assistant',
          finished: true,
          items: [],
        });
        fixture.server.commit();
        await fixture.pushUpdate();
        fixture.runtime.closeSession();
        return text;
      },
    );
    assert.equal(result.state, 'accepted');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'session/dispatch-turn');
    assert.equal(
      fixture.server.toJSON().history.find((entry) => entry.id === result.id)
        .status,
      'pending',
    );
  } finally {
    fixture.close();
  }
});

test('guide continues offscreen and an uncertain or rejected steer never masquerades as an accepted send or replays', async () => {
  for (const outcome of ['applied', 'no-active-turn', 'lost-ack']) {
    let requests = 0;
    const fixture = await openTestSession({
      onRpc: () => {
        requests++;
        if (outcome === 'lost-ack') throw new Error('reply_stream_lost');
        return {
          result: { applied: outcome === 'applied', disposition: outcome },
        };
      },
    });
    try {
      fixture.server
        .getList('history')
        .push({ id: 'running', role: 'assistant', finished: false, items: [] });
      fixture.server.commit();
      await fixture.pushUpdate();
      const args = {
        sessionId: 's1',
        machineId: 'm1',
        userId: 'u1',
        text: 'guide',
        cliType: 'builtin',
        agentType: 'codex',
        guide: true,
      };
      fixture.runtime.closeSession();
      const result = await fixture.runtime.sendTurn(args);
      assert.equal(result.state, 'uploaded');
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(requests, 1);
      const appends = fixture.appends.length;
      assert.equal(
        (await fixture.runtime.sendTurn({ ...args, id: result.id })).state,
        'unknown',
      );
      assert.equal(fixture.appends.length, appends);
    } finally {
      fixture.close();
    }
  }
});

test('chat failures retain raw diagnostics and update when only metadata changes', async () => {
  const { projectSession } = await loadRuntime();
  const doc = new LoroDoc();
  const entry = doc.getList('history').pushContainer(new LoroMap());
  entry.set('id', 'failure');
  entry.set('role', 'system');
  const item = entry
    .setContainer('items', new LoroList())
    .pushContainer(new LoroMap());
  item.set('type', 'system_notice');
  item.set('name', 'chat_failed');
  item.set('meta', { reason: 'acp_unknown_error', message: 'raw\nerror' });
  doc.commit();
  const before = projectSession(doc, 'live');
  assert.equal(before.entries[0].items[0].meta.message, 'raw\nerror');
  item.set('meta', {
    reason: 'future_reason',
    code: 'future_code',
    message: 'updated',
  });
  doc.commit();
  const after = projectSession(doc, 'live');
  assert.deepEqual(after.entries[0].items[0].meta, {
    reason: 'future_reason',
    code: 'future_code',
    message: 'updated',
  });
  assert.ok(after.entries[0].rev > before.entries[0].rev);
  assert.ok(after.entries[0].items[0].rev > before.entries[0].items[0].rev);
  item.set('meta', { message: 42 });
  doc.commit();
  assert.equal(
    projectSession(doc, 'live').entries[0].items[0].meta.message,
    undefined,
  );
});

test('multiple durable guides await independent receipts without locking the session or replaying', async () => {
  const receipts = new Map();
  const fixture = await openTestSession({
    onRpc: (request) =>
      new Promise((resolve) =>
        receipts.set(request.params.userTurnId, resolve),
      ),
  });
  try {
    fixture.server
      .getList('history')
      .push({ id: 'running', role: 'assistant', finished: false, items: [] });
    fixture.server.commit();
    await fixture.pushUpdate();
    const args = {
      sessionId: 's1',
      machineId: 'm1',
      userId: 'u1',
      text: 'guide',
      cliType: 'builtin',
      agentType: 'codex',
      guide: true,
    };
    const first = await fixture.runtime.sendTurn(args);
    const second = await fixture.runtime.sendTurn(args);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(first.state, 'uploaded');
    assert.equal(second.state, 'uploaded');
    assert.notEqual(first.id, second.id);
    assert.equal(receipts.size, 2);
    assert.equal(
      fixture.server
        .toJSON()
        .history.filter((entry) => entry.status === 'pending_apply').length,
      2,
    );
    receipts.get(second.id)({ result: { applied: true } });
    receipts.get(first.id)({ error: { message: 'lost_ack' } });
    await new Promise((resolve) => setImmediate(resolve));
    const history = fixture.server.toJSON().history;
    assert.equal(
      history.find((entry) => entry.id === second.id).status,
      'processing',
    );
    assert.equal(
      history.find((entry) => entry.id === first.id).status,
      'pending_apply',
    );
    assert.equal(
      (await fixture.runtime.sendTurn({ ...args, id: first.id })).state,
      'unknown',
    );
    const third = await fixture.runtime.sendTurn(args);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(third.state, 'uploaded');
    assert.equal(receipts.size, 3);
    receipts.get(third.id)({ result: { applied: true } });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    fixture.close();
  }
});

test('proposed documents preserve identity across streaming, completion and clearing', async () => {
  const { projectSession } = await loadProject();
  const doc = new LoroDoc();
  const entry = doc.getList('history').pushContainer(new LoroMap());
  entry.set('id', 'plan');
  entry.set('role', 'assistant');
  const items = entry.setContainer('items', new LoroList());
  const plan = items.pushContainer(new LoroMap());
  for (const [key, value] of Object.entries({
    type: 'proposed_plan',
    markdown: '# Plan',
    turnId: 'turn',
    status: 'delta',
    isLatest: true,
  }))
    plan.set(key, value);
  doc.commit();
  const first = projectSession(doc, 'live').entries[0].items[0];
  assert.equal(first.markdown, '# Plan');
  plan.set('markdown', '# Plan\n\nComplete body');
  plan.set('status', 'completed');
  doc.commit();
  const complete = projectSession(doc, 'live').entries[0].items[0];
  assert.equal(complete.itemId, first.itemId);
  assert.notEqual(complete.rev, first.rev);
  assert.equal(complete.markdown, '# Plan\n\nComplete body');
  assert.equal(complete.status, 'completed');
  plan.set('isLatest', false);
  doc.commit();
  const historical = projectSession(doc, 'live').entries[0].items[0];
  assert.equal(historical.isLatest, false);
  assert.notEqual(historical.rev, complete.rev);
  plan.set('status', 'cleared');
  doc.commit();
  assert.equal(
    projectSession(doc, 'live').entries[0].items[0].status,
    'cleared',
  );
});

test('operation receipts project creation progress, replies, problems and uncertain batches without duplicate successes', async () => {
  const { projectSession } = await loadProject();
  const doc = new LoroDoc();
  const entry = doc.getList('history').pushContainer(new LoroMap());
  entry.set('id', 'operations');
  entry.set('role', 'system');
  const items = entry.setContainer('items', new LoroList());
  const target = { sessionId: 'child', userTurnId: 'user-turn' };
  const succeeded = {
    status: 'succeeded',
    target,
    assistantTurnId: 'answer',
    output: {
      text: '# Reply\n\nFull result',
      truncated: true,
      omittedBytes: 20,
    },
  };
  const receipt = {
    type: 'operation_completion',
    deliveryId: 'receipt',
    operationId: 'op_create',
    operationKind: 'session_create',
    progressMessageId: 'progress',
    completion: { type: 'result', value: { items: [succeeded] } },
  };
  function add(value) {
    const item = items.pushContainer(new LoroMap());
    for (const [key, field] of Object.entries(value)) item.set(key, field);
    return item;
  }
  const progress = add({
    type: 'operation_progress',
    operationId: 'op_create',
    operationKind: 'session_create',
    items: [{ target, label: 'Worker', status: 'running' }],
  });
  add(receipt);
  add({
    ...receipt,
    deliveryId: 'reply',
    operationKind: 'session_chat',
    completion: { type: 'result', value: { items: [succeeded] } },
  });
  add({
    ...receipt,
    deliveryId: 'mixed',
    completion: {
      type: 'result',
      value: {
        items: [
          succeeded,
          {
            status: 'failed',
            target,
            error: {
              code: 'failed',
              message: 'Command rejected',
              retryable: false,
            },
          },
          { status: 'cancelled', label: 'Unstarted' },
        ],
      },
    },
  });
  add({
    type: 'operation_completion_batch',
    batchId: '00000000-0000-4000-8000-000000000001',
    memberCount: 1,
    members: [receipt],
    deliveryStatus: 'settled',
  });
  add({
    type: 'operation_completion_batch',
    batchId: '00000000-0000-4000-8000-000000000002',
    memberCount: 2,
    members: [receipt],
    deliveryStatus: 'unknown',
  });
  add({
    ...receipt,
    deliveryId: 'error',
    completion: {
      type: 'error',
      error: {
        code: 'offline',
        message: 'Machine unavailable',
        retryable: true,
      },
    },
  });
  add({
    ...receipt,
    deliveryId: 'cancel',
    completion: {
      type: 'cancelled',
      partial: { items: [{ status: 'cancelled', target }] },
    },
  });
  doc.commit();
  const before = doc.toJSON();
  const projected = projectSession(doc, 'live').entries[0].items;
  assert.equal(projected[0].operation.cards[0].sessionId, 'child');
  assert.equal(projected[0].operation.cards[0].status, 'running');
  assert.deepEqual(projected[1].operation, { cards: [], notices: [] });
  assert.equal(projected[2].operation.cards[0].kind, 'reply');
  assert.equal(projected[2].operation.cards[0].replyTruncated, true);
  assert.equal(projected[2].operation.cards[0].reply, '# Reply\n\nFull result');
  assert.equal(projected[3].operation.cards.length, 1);
  assert.equal(projected[3].operation.cards[0].detail, 'Command rejected');
  assert.deepEqual(
    projected[3].operation.notices.map((n) => n.kind),
    ['partial', 'cancelled'],
  );
  assert.deepEqual(projected[4].operation, { cards: [], notices: [] });
  assert.equal(projected[5].operation.notices[0].kind, 'batchUnknown');
  assert.equal(projected[5].operation.notices[0].count, 2);
  assert.equal(projected[6].operation.notices[0].detail, 'Machine unavailable');
  assert.equal(projected[7].operation.cards[0].status, 'cancelled');
  assert.deepEqual(
    doc.toJSON().history,
    before.history,
    'Presentation must not alter durable receipts',
  );
  progress.set('items', [{ target, label: 'Worker', status: 'succeeded' }]);
  doc.commit();
  const updated = projectSession(doc, 'live').entries[0].items[0];
  assert.equal(updated.operation.cards[0].status, 'succeeded');
  assert.ok(updated.rev > projected[0].rev);
  const restored = new LoroDoc();
  restored.import(doc.export({ mode: 'snapshot' }));
  assert.deepEqual(
    projectSession(restored, 'live').entries[0].items.map((i) => i.operation),
    projectSession(doc, 'live').entries[0].items.map((i) => i.operation),
  );
});

test(
  'Roost resumes the original durable input only on the original backend',
  { timeout: 5000 },
  async () => {
    const { IDBFactory } = await import('fake-indexeddb');
    const indexedDBFactory = new IDBFactory();
    const writes = [];
    let phase = 'first';
    let firstWrite, recoveredWrite, projected;
    const pendingProjection = new Promise((resolve) => {
      projected = resolve;
    });
    const firstHandoff = new Promise((resolve) => {
      firstWrite = resolve;
    });
    const recovered = new Promise((resolve) => {
      recoveredWrite = resolve;
    });
    const options = {
      indexedDBFactory,
      onEvent(event) {
        if (!event.session) return;
        const pending = JSON.parse(event.session).pendingRoostInputs?.find(
          (item) => item.inputState === 'unknown',
        );
        if (pending) projected(pending);
      },
      target: {
        backend: 'roost',
        machineId: 'm1',
        acceptsInput: true,
        dispatchesInput: true,
      },
      async onRpc(request, runtime, signal) {
        if (request.method === 'session/history-watch')
          return new Promise((_resolve, reject) =>
            signal.addEventListener(
              'abort',
              () => reject(new Error('cancelled')),
              { once: true },
            ),
          );
        const params = await runtime.openPayload(request.params);
        if (params.operation === 'accept_input_and_dispatch') {
          writes.push(structuredClone(params.payload.entry));
          if (phase === 'first') {
            firstWrite();
            throw new Error('lost_ack');
          }
          recoveredWrite();
        }
        const result = params.operation
          ? {
              status: 'accepted',
              turnId: params.payload.entry.id,
              active: false,
            }
          : params.query.kind === 'inputAcceptance'
            ? { status: 'unobserved' }
            : {
                checkpoint: 'c1',
                startPosition: 0,
                totalCount: 0,
                rows: [],
                hasMoreOlder: false,
                cursor: null,
              };
        return {
          result: await runtime.sealPayload('s1', {
            type: params.operation
              ? 'session/history-write_response'
              : 'session/history-read_response',
            sessionId: 's1',
            success: true,
            historyRevision: 1,
            historyCount: 0,
            ...(params.operation
              ? { operation: params.operation }
              : { pageTurns: [] }),
            result,
          }),
        };
      },
    };
    const first = await openTestSession(options);
    const send = await first.runtime.sendTurn({
      sessionId: 's1',
      machineId: 'm1',
      userId: 'u1',
      cliType: 'builtin',
      agentType: 'codex',
      text: 'Preserve this input',
    });
    assert.equal(send.state, 'uploaded');
    await firstHandoff;
    const pending = await pendingProjection;
    assert.equal(pending.id, send.id);
    assert.equal(pending.items[0].text, 'Preserve this input');
    assert.ok(pending.items[0].itemId);
    first.runtime.stopSessions();
    await first.runtime.stopAcceptedInputs();
    first.close();
    const otherBackend = await openTestSession({
      ...options,
      storageSuffix: '-test-backend',
    });
    try {
      await assert.rejects(
        otherBackend.runtime.actOnPendingInput('s1', send.id, 'retry'),
        /session_not_ready/,
      );
      assert.equal(writes.length, 1);
    } finally {
      otherBackend.runtime.stopSessions();
      await otherBackend.runtime.stopAcceptedInputs();
      otherBackend.close();
    }
    phase = 'restart';
    const second = await openTestSession(options);
    try {
      await recovered;
      assert.equal(writes.length, 2);
      assert.deepEqual(writes[1], writes[0]);
      assert.equal(writes[1].id, send.id);
    } finally {
      second.runtime.stopSessions();
      await second.runtime.stopAcceptedInputs();
      second.close();
    }
  },
);

for (const lifecycle of ['archive', 'delete']) {
  test(
    `${lifecycle} cancels a durable Roost input`,
    { timeout: 6000 },
    async () => {
      const flock = new Flock('archive-test');
      flock.set(['e', 'session-s1'], true);
      flock.set(['m', 'session-s1'], {
        id: 's1',
        machineId: 'm1',
        historyBackend: 'roost',
        status: { type: 'completed' },
      });
      flock.commit();
      let firstFailure, secondHandoff;
      const failure = new Promise((resolve) => {
        firstFailure = resolve;
      });
      const retried = new Promise((resolve) => {
        secondHandoff = resolve;
      });
      const writes = [];
      const fixture = await openTestSession({
        resolveTarget: () => ({
          backend: 'roost',
          machineId: 'm1',
          acceptsInput: true,
          dispatchesInput: true,
          isArchived: flock.get(['m', 'session-s1', 'isArchived']) === true,
        }),
        onEvent(event) {
          if (
            event.session &&
            JSON.parse(event.session).pendingRoostInputs?.some(
              (input) => input.inputRetryable,
            )
          )
            firstFailure();
        },
        async onRpc(request, runtime) {
          const params = await runtime.openPayload(request.params);
          if (request.method === 'session/history-write') {
            writes.push(params.payload.entry.id);
            if (writes.length === 1)
              throw new Error(
                'synthetic lost acknowledgment before the owner accepted',
              );
            secondHandoff();
            return {
              result: await runtime.sealPayload('s1', {
                type: 'session/history-write_response',
                sessionId: 's1',
                success: true,
                operation: params.operation,
                result: {
                  status: 'accepted',
                  turnId: params.payload.entry.id,
                  active: true,
                },
              }),
            };
          }
          return {
            result: await runtime.sealPayload('s1', {
              type: 'session/history-read_response',
              sessionId: 's1',
              success: true,
              historyRevision: 1,
              historyCount: 0,
              result:
                params.query.kind === 'inputAcceptance'
                  ? { status: 'unobserved' }
                  : {
                      checkpoint: 'c1',
                      startPosition: 0,
                      totalCount: 0,
                      rows: [],
                      hasMoreOlder: false,
                      cursor: null,
                    },
              pageTurns: [],
            }),
          };
        },
      });
      const handlers = new Map();
      fixture.runtime.registerSessions({
        state: {
          workspace: 'w1',
          userId: 'u1',
          unhealthy: new Set(),
          catalogs: new Map(),
          machineReplicas: new Map(),
          metaReplica: {
            flock,
            client: { append: async () => ({ ok: true }) },
          },
        },
        getGrant: async () => {
          throw new Error('unexpected_grant');
        },
        publish() {},
        channel: { handle: (name, handler) => handlers.set(name, handler) },
      });
      const archive = (archived) =>
        handlers.get('archiveSession')({
          workspaceId: 'w1',
          sessionId: 's1',
          archived,
        });
      try {
        const sent = await fixture.runtime.sendTurn({
          sessionId: 's1',
          machineId: 'm1',
          userId: 'u1',
          cliType: 'builtin',
          agentType: 'codex',
          text: 'Synthetic pending input',
        });
        assert.equal(sent.state, 'uploaded');
        await failure;
        if (lifecycle === 'delete') {
          await handlers.get('deleteSession')({
            workspaceId: 'w1',
            sessionId: 's1',
            sessionIds: ['s1'],
          });
          assert.equal(flock.get(['e', 'session-s1']), false);
          await assert.rejects(
            fixture.runtime.actOnPendingInput('s1', sent.id, 'retry'),
            /session_not_ready/,
          );
          assert.deepEqual(writes, [sent.id]);
          return;
        }
        await archive(true);
        assert.equal(flock.get(['m', 'session-s1', 'isArchived']), true);
        await assert.rejects(
          fixture.runtime.actOnPendingInput('s1', sent.id, 'retry'),
          /session_not_ready/,
        );
        await archive(false);
        assert.equal(flock.get(['m', 'session-s1', 'isArchived']), false);
        fixture.runtime.resumeAcceptedInputs();
        const next = await fixture.runtime.sendTurn({
          sessionId: 's1',
          machineId: 'm1',
          userId: 'u1',
          cliType: 'builtin',
          agentType: 'codex',
          text: 'New input',
        });
        assert.equal(next.state, 'uploaded');
        await retried;
        assert.deepEqual(writes, [sent.id, next.id]);
      } finally {
        fixture.close();
      }
    },
  );
}
