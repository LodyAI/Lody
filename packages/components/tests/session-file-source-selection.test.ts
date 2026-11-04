import { describe, expect, it } from 'vitest';
import { chooseSessionFileSurfaceSource } from '../src/lib/session-file-source-selection';

describe('chooseSessionFileSurfaceSource', () => {
  it('keeps Code Collab as the primary source when its provider is ready', () => {
    expect(
      chooseSessionFileSurfaceSource({
        hasFileProvider: true,
        fileProviderPending: false,
        hasLocalFileSource: true,
        allowLocalFileSource: true,
      })
    ).toBe('provider');
  });

  it('waits for Code Collab instead of racing a local fallback', () => {
    expect(
      chooseSessionFileSurfaceSource({
        hasFileProvider: false,
        fileProviderPending: true,
        hasLocalFileSource: true,
        allowLocalFileSource: true,
      })
    ).toBe('provider-pending');
  });

  it('uses an allowed worktree fallback after Code Collab stops pending', () => {
    expect(
      chooseSessionFileSurfaceSource({
        hasFileProvider: false,
        fileProviderPending: false,
        hasLocalFileSource: true,
        allowLocalFileSource: true,
      })
    ).toBe('local');
  });
});
