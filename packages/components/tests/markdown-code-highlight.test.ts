import { describe, expect, it, vi } from 'vitest';

vi.mock('@/atoms', () => ({ extendedCodeLanguagesEnabledAtom: {} }));

import { resolveMarkdownCodeLanguage } from '../src/components/ai-gui/markdown-code-highlight';

describe('resolveMarkdownCodeLanguage', () => {
  it('keeps optional grammars and dialect aliases behind the extension setting', () => {
    expect(resolveMarkdownCodeLanguage('coq', false)).toBeNull();
    expect(resolveMarkdownCodeLanguage('rocq', false)).toBeNull();
    expect(resolveMarkdownCodeLanguage('coq', true)).toBe('coq');
    expect(resolveMarkdownCodeLanguage('rocq', true)).toBe('coq');
    expect(resolveMarkdownCodeLanguage('mysql', false)).toBeNull();
    expect(resolveMarkdownCodeLanguage('mysql', true)).toBe('sql');
    expect(resolveMarkdownCodeLanguage('postgresql', false)).toBeNull();
    expect(resolveMarkdownCodeLanguage('postgresql', true)).toBe('sql');
  });

  it('keeps core grammars available without the extension setting', () => {
    expect(resolveMarkdownCodeLanguage('typescript', false)).toBe('typescript');
    expect(resolveMarkdownCodeLanguage('sql', false)).toBe('sql');
  });
});
