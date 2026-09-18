import { describe, expect, it } from 'vitest';
import {
  parseMarkdownCodeBlockLabel,
  parseMarkdownCodeBlockPath,
  parseMarkdownCodeHighlightLanguage,
} from '../src/components/ai-gui/markdown-code-block';

describe('parseMarkdownCodeBlockPath', () => {
  it('reads named path attributes', () => {
    expect(parseMarkdownCodeBlockPath('title="src/app.ts"')).toBe('src/app.ts');
    expect(parseMarkdownCodeBlockPath("filename='pkg/mod.rs'")).toBe('pkg/mod.rs');
    expect(parseMarkdownCodeBlockPath('path=lib/foo.py')).toBe('lib/foo.py');
  });

  it('reads a path-like token after the language', () => {
    expect(parseMarkdownCodeBlockPath('src/components/button.tsx')).toBe(
      'src/components/button.tsx'
    );
    expect(parseMarkdownCodeBlockPath('highlight=sql schema.sql')).toBe('schema.sql');
  });

  it('ignores highlight and line-number meta', () => {
    expect(parseMarkdownCodeBlockPath('highlight=sql startLine=3')).toBeNull();
  });
});

describe('parseMarkdownCodeBlockLabel', () => {
  it('prefers a path over the language id', () => {
    expect(parseMarkdownCodeBlockLabel('ts', 'src/app.ts')).toBe('src/app.ts');
    expect(parseMarkdownCodeBlockLabel('python', undefined)).toBe('python');
  });
});

describe('parseMarkdownCodeHighlightLanguage', () => {
  it('uses highlight= when the fence was remapped to text', () => {
    expect(parseMarkdownCodeHighlightLanguage('text', 'highlight=sql')).toBe('sql');
  });

  it('falls back to the fence language', () => {
    expect(parseMarkdownCodeHighlightLanguage('tsx', undefined)).toBe('tsx');
  });
});
