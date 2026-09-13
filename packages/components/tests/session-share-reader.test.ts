import { describe, expect, it, vi } from 'vitest';
import { openStaticShare, prepareSharePackage } from '@lody/shared/session-sharing';
import { buildChatStreamItems } from '../src/components/ai-gui/build-chat-stream-items';
import type { SessionId } from '@lody/shared';
import {
  createSessionShareReader,
  type SessionShareReaderSnapshot,
} from '../src/lib/session-share-reader';
import { resolveSessionShareTab, resolveSharePanes } from '../src/lib/session-share-navigation';

async function fixture() {
  const prepared = await prepareSharePackage({
    rootSourceId: 'source',
    capturedAt: '2026-09-12T00:00:00.000Z',
    conversations: [
      {
        sourceId: 'source',
        title: 'Main',
        history: [
          {
            id: 'm1',
            role: 'assistant',
            timestamp: '2026-09-12T00:00:00.000Z',
            finished: true,
            items: [{ type: 'text', text: 'Published answer' }],
          },
        ],
      },
      { sourceId: 'tab', title: 'Tab', parentSourceId: 'source', history: [] },
      { sourceId: 'opened', title: 'Opened', openedBySourceId: 'tab', history: [] },
      {
        sourceId: 'side',
        title: 'Side',
        parentSourceId: 'source',
        childSessionPlacement: 'side-panel',
        history: [],
      },
    ],
    readAttachment: async () => {
      throw new Error('Unexpected source read');
    },
  });
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith('/api/shares/share'))
      return Response.json({ shareId: 'share', deploymentId: 'v1', manifest: prepared.manifest });
    const id = url.split('/').at(-1)!;
    expect(url).toBe(`https://api.example.test/api/shares/share/deployments/v1/objects/${id}`);
    const bytes = prepared.objects.get(id);
    return bytes ? new Response(bytes.slice().buffer) : new Response(null, { status: 404 });
  });
  const share = await openStaticShare({
    origin: 'https://api.example.test',
    shareId: 'share',
    secret: 'a'.repeat(64),
    fetch: fetcher,
  });
  return { share, fetcher, prepared };
}

describe('anonymous static conversation reader', () => {
  it('reads once, renders stored history and never subscribes on repeated start', async () => {
    const { share, fetcher } = await fixture();
    const changed = vi.fn<(value: SessionShareReaderSnapshot) => void>();
    const reader = createSessionShareReader({ share, conversationId: 'c1', onChange: changed });
    await reader.start();
    await reader.start();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(changed.mock.calls.map(([value]) => value.status)).toEqual(['loading', 'ready']);
    const history = changed.mock.calls[1]![0].history;
    expect(history[0]?.items?.[0]).toMatchObject({ type: 'text', text: 'Published answer' });
    expect(buildChatStreamItems(history, 'c1' as SessionId).items.length).toBeGreaterThan(0);
    reader.close();
  });

  it('does not publish a late result after disposal', async () => {
    const { share } = await fixture();
    let release!: (value: Awaited<ReturnType<typeof share.readHistory>>) => void;
    let signal: AbortSignal | undefined;
    const pending = new Promise<Awaited<ReturnType<typeof share.readHistory>>>((resolve) => {
      release = resolve;
    });
    const changed = vi.fn();
    const reader = createSessionShareReader({
      share: {
        ...share,
        readHistory: async (_id, nextSignal) => {
          signal = nextSignal;
          return pending;
        },
      },
      conversationId: 'c1',
      onChange: changed,
    });
    const started = reader.start();
    reader.close();
    expect(signal?.aborted).toBe(true);
    release([]);
    await started;
    expect(changed.mock.calls).toEqual([[{ status: 'loading', history: [] }]]);
  });

  it('fails closed without retaining old history or exposing diagnostics', async () => {
    const { share } = await fixture();
    const changed = vi.fn();
    const reader = createSessionShareReader({
      share: {
        ...share,
        readHistory: async () => {
          throw new Error('synthetic private diagnostic');
        },
      },
      conversationId: 'c1',
      onChange: changed,
    });
    await reader.start();
    expect(changed.mock.calls).toEqual([
      [{ status: 'loading', history: [] }],
      [{ status: 'unavailable', history: [] }],
    ]);
  });

  it('resolves only manifest identities and keeps every published child reachable', async () => {
    const { share } = await fixture();
    const manifest = share.manifest;
    expect(resolveSessionShareTab(manifest, '?tab=source')).toBe('c1');
    expect(resolveSessionShareTab(manifest, '?tab=c2')).toBe('c2');
    const tab = resolveSharePanes(manifest, 'c2');
    expect(tab.root.id).toBe('c1');
    expect(tab.main.id).toBe('c2');
    // c4 is a side-panel child in the app. The reader has no right pane, so it
    // is a Tab here rather than content the reader silently drops.
    expect(tab.tabs.map((entry) => entry.id)).toEqual(['c1', 'c2', 'c4']);
    const side = resolveSharePanes(manifest, 'c4');
    expect(side.root.id).toBe('c1');
    expect(side.main.id).toBe('c4');
    expect(side.tabs.map((entry) => entry.id)).toEqual(['c1', 'c2', 'c4']);
    const opened = resolveSharePanes(manifest, 'c3');
    expect(opened.root.id).toBe('c3');
    expect(opened.main.openedByConversationId).toBe('c2');
    expect(opened.tabs.map((entry) => entry.id)).toEqual(['c3']);
  });
});
