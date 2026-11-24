// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { it, expect } from 'vitest';
import {
  createTranscriptSurfaces,
  TranscriptMarkdown,
  TranscriptTool,
} from '../src/plugins/transcript-surfaces';
it('keeps the selected block and its local input alive through 20 transcript deltas and fence closure', () => {
  const scope = new AbortController();
  const container = document.createElement('div');
  const root = createRoot(container);
  const session = { workspaceId: 'w', machineId: 'm', sessionId: 's' };
  const { messages } = createTranscriptSurfaces(
    { workspaceId: 'w', dev: { machineId: 'm' }, pluginId: 'reports', digest: 'v1' } as Parameters<
      typeof createTranscriptSurfaces
    >[0],
    scope.signal,
    { useLody: () => ({ drafts: {} }) } as Parameters<typeof createTranscriptSurfaces>[2]
  );
  messages.renderBlock({
    id: 'report',
    languages: ['report'],
    Component: ({ blockId, streaming, code }) => {
      const [expanded, set] = useState(false);
      return (
        <button data-report="" onClick={() => set(true)}>
          {[blockId, streaming, expanded, code.trim()].join('|')}
        </button>
      );
    },
  });
  const draw = (i: number, closed = false) =>
    act(() =>
      root.render(
        <TranscriptMarkdown
          target={{ session: session as never }}
          turnId="turn"
          ordinal={0}
          streaming={!closed}
          text={'```report\n' + 'x'.repeat(i) + (closed ? '\n```' : '')}
          render={(s) => s}
        />
      )
    );
  try {
    draw(0);
    const button = container.querySelector<HTMLButtonElement>('[data-report]')!;
    act(() => button.click());
    for (let i = 1; i <= 20; i++) {
      draw(i);
      expect(button.textContent).toBe(`turn:block:0|true|true|${'x'.repeat(i)}`);
    }
    draw(20, true);
    expect(container.querySelector('[data-report]')).toBe(button);
    expect(button.textContent).toContain('|false|true|');
    act(() => container.querySelector('button')!.click());
    expect(container.querySelector('pre')?.textContent).toBe(
      '```report\n' + 'x'.repeat(20) + '\n```'
    );
  } finally {
    act(() => root.unmount());
    scope.abort();
  }
});
it('restores the native tool row when a winning matcher crashes and reveals the next renderer after disposal', () => {
  const rootNode = document.createElement('div'),
    root = createRoot(rootNode),
    high = new AbortController(),
    low = new AbortController();
  const session = {
    workspaceId: 'w',
    machineId: 'm',
    sessionId: 's',
  } as import('@lody/plugin-sdk').SessionRef;
  const call = {
    toolName: 'shell',
    toolCallId: '1',
    acpKind: 'execute',
    command: 'node --test',
    status: 'completed',
    title: 'test',
    locations: [],
  } as const;
  const register = (id: string, scope: AbortController) =>
    createTranscriptSurfaces(
      { workspaceId: 'w', dev: { machineId: 'm' }, pluginId: id, digest: 'v1' } as Parameters<
        typeof createTranscriptSurfaces
      >[0],
      scope.signal,
      { useLody: () => ({ drafts: {} }) } as Parameters<typeof createTranscriptSurfaces>[2]
    ).tools;
  register('tests', low).matchRender({
    id: 'shell',
    match: { acpKinds: ['execute'], commandPattern: '(vitest|node --test)' },
    Component: () => <span>Test summary</span>,
  });
  register('broken', high).matchRender({
    id: 'shell',
    priority: 1,
    match: { toolNames: ['shell'] },
    Component: () => {
      throw Error('synthetic renderer failure');
    },
  });
  try {
    act(() =>
      root.render(
        <TranscriptTool target={{ session }} call={call} raw={<pre>native details</pre>} />
      )
    );
    expect(rootNode.querySelector('pre')?.textContent).toBe('native details');
    act(() => high.abort());
    expect(rootNode.textContent).toContain('Test summary');
    act(() => rootNode.querySelector('button')!.click());
    expect(rootNode.querySelector('pre')?.textContent).toBe('native details');
  } finally {
    act(() => root.unmount());
    low.abort();
    high.abort();
  }
});

it('keeps raw identity isolated, secrets absent and selection stable across unrelated updates', async () => {
  const { snapshotBindings } = await import('../src/plugins/raw-snapshots');
  const scope = new AbortController();
  let update = () => {},
    reads = 0;
  const raw = {
    createdByPluginId: 'owner',
    businessKey: 'job',
    title: 'a',
    nested: {
      authorization: 'private',
      client_secret: 'private',
      businessKey: 'fake',
      createdByPluginId: 'foreign',
    },
  };
  const source = {
    identity: () => [raw],
    async open(_target: unknown, notify: () => void) {
      update = notify;
      return {
        identity: [raw],
        read() {
          reads++;
          return raw;
        },
      };
    },
  };
  const bindings = snapshotBindings(
    'w',
    'foreign',
    scope.signal,
    () => source,
    () => () => {}
  );
  const target = {
    kind: 'session-meta',
    session: { workspaceId: 'w', machineId: 'm', sessionId: 's' },
  } as import('@lody/plugin-sdk').UnstableSnapshotTarget;
  expect(reads).toBe(0);
  const snap = await bindings.unstable.readSnapshot(target);
  expect(snap.doc).not.toHaveProperty('businessKey');
  expect(snap.doc.nested).toBeUndefined();
  expect(Object.isFrozen(snap.doc.nested)).toBe(true);
  raw.title = 'b';
  expect(snap.doc.title).toBe('a');
  const el = document.createElement('div'),
    root = createRoot(el);
  let renders = 0;
  function Consumer() {
    const q = bindings.useUnstableLodySnapshot(target, (s) => s.doc.title);
    renders++;
    return <>{q.status === 'ready' ? String(q.data) : q.status}</>;
  }
  await act(async () => root.render(<Consumer />));
  expect(el.textContent).toBe('b');
  const previous = renders;
  await act(async () => {
    raw.nested.authorization = 'rotated';
    update();
  });
  expect(renders).toBe(previous);
  await act(async () => {
    raw.title = 'c';
    update();
  });
  expect(el.textContent).toBe('c');
  act(() => root.unmount());
  const count = reads;
  update();
  expect(reads).toBe(count);
  scope.abort();
  await expect(bindings.unstable.readSnapshot(target)).rejects.toThrow();
});
