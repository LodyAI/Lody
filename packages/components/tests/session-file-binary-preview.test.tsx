// @vitest-environment jsdom

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}));

import { SessionFileBinaryPreview } from '../src/components/sessions/session-file-binary-preview';

describe('SessionFileBinaryPreview', () => {
  it('opens PDFs in the paged document viewer', () => {
    const markup = renderToStaticMarkup(
      createElement(SessionFileBinaryPreview, {
        path: '/workspace/Report.PDF',
        bytes: Uint8Array.of(1),
      })
    );

    expect(markup).toContain('aria-label="PDF viewer"');
    expect(markup).toContain('aria-label="Previous page"');
    expect(markup).toContain('aria-label="Zoom in"');
    expect(markup).toContain('aria-label="Find in document"');
    expect(markup).not.toContain('This binary file cannot be previewed.');
  });

  it('keeps other binary files on the existing notice path', () => {
    const markup = renderToStaticMarkup(
      createElement(SessionFileBinaryPreview, {
        path: '/workspace/archive.zip',
        url: 'lody-resource://file/archive',
      })
    );

    expect(markup).toContain('This binary file cannot be previewed.');
  });
});
