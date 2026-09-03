// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionFilePayload } from '@lody/shared';
import { Dialog, DialogContentWithoutClose } from '../src/ui/dialog';
import {
  SessionFilePreviewPanel,
  SessionFilePreviewDialog,
} from '../src/components/ai-gui/session-file-preview-dialog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const createTestFile = (overrides: Partial<SessionFilePayload> = {}): SessionFilePayload => ({
  type: 'file',
  fileId: 'file-html-1',
  fileName: 'report.html',
  mimeType: 'text/html',
  sizeBytes: 1024,
  sha256: 'a'.repeat(64),
  textPreview: true,
  transport: 'r2',
  uploadedAt: 1700000000000,
  ...overrides,
});

describe('SessionFilePreviewPanel & SessionFilePreviewDialog', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) await act(async () => void root?.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
    vi.restoreAllMocks();
  });

  it('renders download and copy buttons, and clicking download calls onDownload', async () => {
    const onDownload = vi.fn();
    const testFile = createTestFile();

    await act(async () => {
      root?.render(
        createElement(
          Dialog,
          { open: true },
          createElement(
            DialogContentWithoutClose,
            null,
            createElement(SessionFilePreviewPanel, {
              file: testFile,
              status: { kind: 'loaded', text: '<h1>Hello</h1>', truncated: false },
              onDownload,
            })
          )
        )
      );
    });

    const downloadButton = document.body.querySelector('button[aria-label="Download"]');
    expect(downloadButton).toBeTruthy();

    const copyButton = document.body.querySelector('button[aria-label="Copy"]');
    expect(copyButton).toBeTruthy();

    // Live preview button should not be present when onOpenLivePreview is omitted
    const livePreviewButton = document.body.querySelector('button[aria-label="Open live preview"]');
    expect(livePreviewButton).toBeNull();

    await act(async () => {
      downloadButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onDownload).toHaveBeenCalledWith(testFile);
  });

  it('renders live preview button when onOpenLivePreview is provided and calls it on click', async () => {
    const onDownload = vi.fn();
    const onOpenLivePreview = vi.fn();
    const testFile = createTestFile({ sourcePath: 'demo.html' });

    await act(async () => {
      root?.render(
        createElement(
          Dialog,
          { open: true },
          createElement(
            DialogContentWithoutClose,
            null,
            createElement(SessionFilePreviewPanel, {
              file: testFile,
              status: { kind: 'loaded', text: '<h1>Hello</h1>', truncated: false },
              onDownload,
              onOpenLivePreview,
            })
          )
        )
      );
    });

    const livePreviewButton = document.body.querySelector('button[aria-label="Open live preview"]');
    expect(livePreviewButton).toBeTruthy();

    await act(async () => {
      livePreviewButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onOpenLivePreview).toHaveBeenCalledWith(testFile);
  });

  it('closes dialog and calls onOpenLivePreview when live preview is triggered in SessionFilePreviewDialog', async () => {
    const onDownload = vi.fn();
    const onOpenLivePreview = vi.fn();
    const onOpenChange = vi.fn();
    const testFile = createTestFile({ sourcePath: 'demo.html' });

    await act(async () => {
      root?.render(
        createElement(SessionFilePreviewDialog, {
          open: true,
          onOpenChange,
          file: testFile,
          status: { kind: 'loaded', text: '<h1>Hello</h1>', truncated: false },
          onDownload,
          onOpenLivePreview,
        })
      );
    });

    const livePreviewButton = document.body.querySelector('button[aria-label="Open live preview"]');
    expect(livePreviewButton).toBeTruthy();

    await act(async () => {
      livePreviewButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onOpenLivePreview).toHaveBeenCalledWith(testFile);
  });
});
