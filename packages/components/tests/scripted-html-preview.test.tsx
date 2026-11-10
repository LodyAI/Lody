// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { STATIC_HTML_PREVIEW_DOCUMENT_MARKER } from '@lody/shared';

import { ScriptedHtmlPreview } from '../src/components/sessions/scripted-html-preview';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('ScriptedHtmlPreview', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it('runs source scripts in an opaque-origin sandbox under the owned policy', () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(ScriptedHtmlPreview, {
          text: '<h1>Report</h1><button onclick="this.textContent=1">Run</button><script>window.ran = true</script>',
        })
      );
    });

    const iframe = container.querySelector('iframe');
    expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe?.hasAttribute('credentialless')).toBe(true);
    expect(iframe?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(iframe?.getAttribute('allow')).toContain("camera 'none'");
    const srcdoc = iframe?.getAttribute('srcdoc') ?? '';
    expect(srcdoc).toContain(STATIC_HTML_PREVIEW_DOCUMENT_MARKER);
    expect(srcdoc).toContain("connect-src 'none'");
    expect(srcdoc).toContain('<script>window.ran = true</script>');
    expect(srcdoc).toContain('onclick="this.textContent=1"');
  });
});
