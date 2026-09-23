import { describe, expect, it } from 'vitest';
import {
  buildAppSessionUrl,
  getAppSessionUrlOrigins,
  isPlainLinkPasteShortcut,
  parseAppSessionUrl,
} from '../src/lib/session-app-url';

describe('parseAppSessionUrl', () => {
  const allowedOrigins = ['https://lody.ai', 'http://localhost:5173'];

  it('accepts a session URL on an allowed app origin', () => {
    expect(
      parseAppSessionUrl('https://lody.ai/acme/sessions/ses_abc123', { allowedOrigins })
    ).toEqual({
      url: 'https://lody.ai/acme/sessions/ses_abc123',
      workspaceSlug: 'acme',
      sessionId: 'ses_abc123',
    });
  });

  it('keeps search and hash on the normalized url', () => {
    expect(
      parseAppSessionUrl('http://localhost:5173/acme/sessions/ses_1?tab=session:ses_1#top', {
        allowedOrigins,
      })
    ).toEqual({
      url: 'http://localhost:5173/acme/sessions/ses_1?tab=session:ses_1#top',
      workspaceSlug: 'acme',
      sessionId: 'ses_1',
    });
  });

  it('rejects a foreign host even when the path looks like a session', () => {
    expect(
      parseAppSessionUrl('https://evil.example/acme/sessions/ses_abc123', { allowedOrigins })
    ).toBeNull();
  });

  it('rejects text that is not a lone URL', () => {
    expect(
      parseAppSessionUrl('see https://lody.ai/acme/sessions/ses_abc123 please', {
        allowedOrigins,
      })
    ).toBeNull();
  });

  it('rejects non-session app paths', () => {
    expect(parseAppSessionUrl('https://lody.ai/acme/settings', { allowedOrigins })).toBeNull();
  });
});

describe('isPlainLinkPasteShortcut', () => {
  it('detects Cmd/Ctrl+Shift+V', () => {
    expect(isPlainLinkPasteShortcut({ shiftKey: true, metaKey: true, ctrlKey: false })).toBe(true);
    expect(isPlainLinkPasteShortcut({ shiftKey: true, metaKey: false, ctrlKey: true })).toBe(true);
    expect(isPlainLinkPasteShortcut({ shiftKey: false, metaKey: true, ctrlKey: false })).toBe(
      false
    );
  });
});

describe('getAppSessionUrlOrigins / buildAppSessionUrl', () => {
  it('dedupes page and share origins', () => {
    expect(
      getAppSessionUrlOrigins({
        pageOrigin: 'http://localhost:5173/',
        shareOrigin: 'http://localhost:5173',
      })
    ).toEqual(['http://localhost:5173']);
  });

  it('builds a share URL for a workspace session', () => {
    expect(buildAppSessionUrl('acme', 'ses_1')).toMatch(/\/acme\/sessions\/ses_1$/);
  });
});
