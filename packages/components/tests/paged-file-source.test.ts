import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_TEXT_PAGE_BYTES } from '@lody/shared/local-file-preview';
import { createLocalPagedFileSource } from '../src/lib/paged-file-source';

afterEach(() => vi.unstubAllGlobals());

describe('local paged text', () => {
  it.each(['中', '😀', 'é'])(
    'preserves %s across every byte boundary without duplication',
    async (character) => {
      for (let overlap = 1; overlap < new TextEncoder().encode(character).length; overlap++) {
        const text = 'a'.repeat(LOCAL_TEXT_PAGE_BYTES - overlap) + character + 'end';
        const bytes = new TextEncoder().encode(text);
        vi.stubGlobal('fetch', async (_url: string, options: RequestInit) => {
          const range = new Headers(options.headers).get('Range')!.match(/bytes=(\d+)-(\d+)/)!;
          return new Response(bytes.slice(Number(range[1]), Number(range[2]) + 1), { status: 206 });
        });
        const source = createLocalPagedFileSource('lody-resource://file/test', bytes.length);
        const signal = new AbortController().signal;
        expect((await source.readPage(0, signal)) + (await source.readPage(1, signal))).toBe(text);
      }
    }
  );

  it('refuses stale resources and invalid pages', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 409 }));
    const source = createLocalPagedFileSource('lody-resource://file/test', 100);
    await expect(source.readPage(0, new AbortController().signal)).rejects.toThrow('File changed');
    await expect(source.readPage(1, new AbortController().signal)).rejects.toThrow('Invalid page');
  });
});
