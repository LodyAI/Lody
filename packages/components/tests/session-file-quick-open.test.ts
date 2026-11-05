import { describe, expect, it, vi } from 'vitest';
import { loadSessionFileQuickOpenItems } from '../src/components/sessions/session-file-quick-open';
import { createFakeSessionFileProvider } from '../src/lib/session-file-provider';
import { createSessionFileProviderFromSource } from '../src/lib/session-file-provider-selection';

describe('session file quick open helpers', () => {
  it('uses provider search results instead of fallback paths when a provider is ready', async () => {
    const provider = createFakeSessionFileProvider({
      files: [
        {
          fileId: 'provider-file',
          path: 'src/provider-only.ts',
          kind: 'text',
          sourceState: 'live-collaborative',
        },
      ],
    });
    const searchFiles = vi.spyOn(provider, 'searchFiles');

    await expect(
      loadSessionFileQuickOpenItems({
        provider,
        fallbackPaths: ['src/fallback-only.ts'],
        query: '',
      })
    ).resolves.toEqual([{ fileId: 'provider-file', path: 'src/provider-only.ts' }]);

    expect(searchFiles).toHaveBeenCalledWith('');
  });

  it('surfaces an unavailable provider message instead of falling back silently', async () => {
    const provider = createSessionFileProviderFromSource({
      kind: 'none',
      message: 'Host start failed.',
    });

    await expect(
      loadSessionFileQuickOpenItems({
        provider,
        fallbackPaths: ['src/fallback-only.ts'],
        query: '',
      })
    ).rejects.toThrow('Host start failed.');
  });
});
