import { describe, expect, it, vi } from 'vitest';
import { EphemeralStore } from 'loro-crdt';
import { readPromptSuggestion, type WorkspaceId } from '@lody/shared';

const harness = vi.hoisted(() => ({
  transports: [] as Array<{
    updates: Uint8Array[];
    receive: (updates: Uint8Array[]) => void;
  }>,
}));
vi.mock('@loro-dev/streams-crdt/loro', async (original) => ({
  ...(await original<typeof import('@loro-dev/streams-crdt/loro')>()),
  EphemeralStreamCrdt: class {
    private unsubscribe: (() => void) | null = null;
    private readonly updates: Uint8Array[] = [];
    constructor(
      private readonly options: {
        adaptor: {
          applyRemoteUpdates: (updates: Uint8Array[]) => void;
          subscribeLocalUpdates: (listener: (update: Uint8Array) => void) => () => void;
        };
      }
    ) {
      harness.transports.push({
        updates: this.updates,
        receive: options.adaptor.applyRemoteUpdates,
      });
    }
    async join(options: { onStatusChange: (status: string) => void }) {
      this.unsubscribe = this.options.adaptor.subscribeLocalUpdates((update) =>
        this.updates.push(update)
      );
      options.onStatusChange('joined');
      return { ok: true, value: { unsubscribe: () => this.unsubscribe?.() } };
    }
    async disposeLegacy() {
      this.unsubscribe?.();
    }
  },
}));
import { CliPromptSuggestions } from './prompt-suggestions';

describe('workspace suggestion publisher', () => {
  it('reconciles offline values on attachment and keeps remote text out of the local snapshot', async () => {
    const publisher = new CliPromptSuggestions(
      'workspace' as WorkspaceId,
      { warn: () => {} } as never
    );
    const remote = new EphemeralStore(86_400_000);
    const decode = new EphemeralStore(86_400_000);
    try {
      publisher.state.publish('local', {
        sessionId: 'session',
        result: { type: 'completed', text: 'offline hint' },
      });
      publisher.attachStreams({ streamsBaseUrl: 'https://example.test', auth: async () => 'test' });
      const transport = harness.transports.at(-1)!;
      for (const update of transport.updates) decode.apply(update);
      expect(readPromptSuggestion(decode.getAllStates(), 'local', 'session')).toBe('offline hint');
      remote.set('remote:other', {
        machineId: 'remote',
        sessionId: 'other',
        result: { type: 'completed', text: 'foreign' },
      });
      transport.receive([remote.encodeAll()]);
      expect(
        readPromptSuggestion(publisher.state.store.getAllStates(), 'remote', 'other')
      ).toBeNull();
      await publisher.detachStreams();
      publisher.state.publish('local', {
        sessionId: 'session',
        result: { type: 'completed', text: 'later' },
      });
      decode.apply(publisher.state.encode());
      expect(readPromptSuggestion(decode.getAllStates(), 'local', 'session')).toBe('later');
    } finally {
      await publisher.stop();
      remote.destroy();
      decode.destroy();
    }
  });
});
