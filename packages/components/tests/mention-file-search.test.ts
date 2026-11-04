import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useMentionFileSearch } from '../src/components/mentions/file-search/use-file-search';
// @vitest-environment jsdom
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  buildMentionFileIndex,
  getSuggestions,
} from '../src/components/mentions/file-search/engine';

import {
  createFileSearchClient,
  type FileSearchRequest,
  type FileSearchResponse,
  type FileSearchWorker,
} from '../src/components/mentions/file-search/client';

class ControlledWorker {
  onmessage: FileSearchWorker['onmessage'] = null;
  onerror: FileSearchWorker['onerror'] = null;
  onmessageerror: FileSearchWorker['onmessageerror'] = null;
  messages: FileSearchRequest[] = [];
  terminated = false;
  postMessage(message: FileSearchRequest) {
    this.messages.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  deliver(data: FileSearchResponse) {
    this.onmessage?.call(this as unknown as Worker, { data } as MessageEvent<FileSearchResponse>);
  }
}

describe('file search ranking', () => {
  it('merges lazy directories without losing navigation tokens', () => {
    const index = buildMentionFileIndex({
      paths: ['src/index.ts'],
      lazyDirectories: [{ path: '/vendor/' }, { path: 'src' }, { path: 'vendor' }, { path: '/' }],
    })!;
    expect(getSuggestions(index, '').map((item) => item.token)).toEqual(['src/', 'vendor/']);
    expect(getSuggestions(index, 'vend')[0]).toEqual({
      kind: 'dir',
      path: 'vendor',
      token: 'vendor/',
    });
  });
});

describe('file search client', () => {
  it('coalesces queued queries and never publishes an obsolete running query', () => {
    const worker = new ControlledWorker();
    const visible: string[] = [];
    const client = createFileSearchClient(
      worker,
      { paths: ['a.ts'] },
      (term) => visible.push(term),
      () => {
        throw new Error('unexpected failure');
      }
    );
    client.query('a');
    client.query('ab');
    worker.deliver({ type: 'ready' });
    const running = worker.messages.at(-1) as Extract<FileSearchRequest, { type: 'query' }>;
    expect(running.term).toBe('ab');
    client.query('abc');
    client.query('abcd');
    worker.deliver({ type: 'result', id: running.id, term: running.term, items: [] });
    expect(visible).toEqual([]);
    const latest = worker.messages.at(-1) as typeof running;
    expect(latest.term).toBe('abcd');
    worker.deliver({ type: 'result', id: latest.id, term: latest.term, items: [] });
    expect(visible).toEqual(['abcd']);
    client.dispose();
    worker.deliver({ type: 'result', id: latest.id, term: 'late', items: [] });
    expect(visible).toEqual(['abcd']);
    expect(worker.terminated).toBe(true);
  });
});

describe('file search React boundary', () => {
  it('hides stale rows on query/project changes and terminates on close, failure and unmount', async () => {
    const workers: ControlledWorker[] = [];
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'Worker',
      class extends ControlledWorker {
        constructor() {
          super();
          workers.push(this);
        }
      }
    );
    const host = document.createElement('div');
    const root = createRoot(host);
    let state: ReturnType<typeof useMentionFileSearch>;
    function Harness({ entry, term }: { entry: { paths: string[] }; term: string | null }) {
      state = useMentionFileSearch(entry, term);
      return React.createElement(
        'div',
        null,
        state.status + ':' + state.items.map((item) => item.token).join(',')
      );
    }
    const entry = { paths: ['alpha.ts', 'beta.ts'] };
    const render = async (source: typeof entry, term: string | null) => {
      await act(async () => root.render(React.createElement(Harness, { entry: source, term })));
    };
    const finish = async (worker: ControlledWorker, source: typeof entry) => {
      const request = worker.messages.at(-1) as Extract<FileSearchRequest, { type: 'query' }>;
      await act(async () =>
        worker.deliver({
          type: 'result',
          id: request.id,
          term: request.term,
          items: getSuggestions(buildMentionFileIndex(source)!, request.term),
        })
      );
    };
    try {
      await render(entry, 'alpha');
      await act(async () => workers[0].deliver({ type: 'ready' }));
      await finish(workers[0], entry);
      expect(host.textContent).toBe('ready:alpha.ts');
      await render(entry, 'beta');
      expect(host.textContent).toBe('loading:');
      await finish(workers[0], entry);
      expect(host.textContent).toBe('ready:beta.ts');
      const next = { paths: ['beta-new.ts'] };
      await render(next, 'beta');
      expect(workers[0].terminated).toBe(true);
      expect(host.textContent).toBe('loading:');
      await act(async () => workers[1].deliver({ type: 'ready' }));
      await finish(workers[1], next);
      expect(host.textContent).toBe('ready:beta-new.ts');
      await render(next, null);
      expect(workers[1].terminated).toBe(true);
      expect(host.textContent).toBe('ready:');
      await render(next, 'beta');
      await act(async () => workers[2].deliver({ type: 'error' }));
      expect(host.textContent).toBe('error:');
      expect(workers[2].terminated).toBe(true);
      await render(next, null);
      await render(next, 'beta');
      await act(async () => workers[3].deliver({ type: 'ready' }));
      await finish(workers[3], next);
      expect(host.textContent).toBe('ready:beta-new.ts');
    } finally {
      await act(async () => root.unmount());
      expect(workers.at(-1)?.terminated).toBe(true);
      vi.unstubAllGlobals();
    }
  });
});
