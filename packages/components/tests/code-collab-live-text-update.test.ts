import { describe, expect, it } from 'vitest';
import { decideCodeCollabLiveTextUpdate } from '../src/lib/code-collab-live-text-update';

describe('code collab live text update decisions', () => {
  it('ignores a stale live update that matches a recent local edit', () => {
    expect(
      decideCodeCollabLiveTextUpdate({
        incomingText: 'local text that already went out',
        currentEditorText: 'newer local text',
        isRecentLocalEcho: true,
      })
    ).toEqual({ kind: 'ignore-local-echo', text: 'local text that already went out' });
  });

  it('applies a real external update as provider-authoritative text', () => {
    expect(
      decideCodeCollabLiveTextUpdate({
        incomingText: 'remote text',
        currentEditorText: 'local dirty text',
        isRecentLocalEcho: false,
      })
    ).toEqual({ kind: 'external', text: 'remote text' });
  });
});
