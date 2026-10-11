import { describe, expect, it } from 'vitest';
import {
  getSessionFileLanguageId,
  getSessionFileMonacoLanguageId,
  isSessionFileShikiLanguage,
} from '../src/lib/session-file-language';

describe('getSessionFileMonacoLanguageId', () => {
  it('keeps optional grammars as plaintext until the extension pack is enabled', () => {
    expect(getSessionFileMonacoLanguageId('src/main.dart')).toBe('plaintext');
    expect(getSessionFileMonacoLanguageId('src/main.dart', true)).toBe('dart');
    expect(getSessionFileMonacoLanguageId('infra/main.hcl')).toBe('plaintext');
    expect(getSessionFileMonacoLanguageId('infra/main.hcl', true)).toBe('hcl');
    expect(getSessionFileMonacoLanguageId('queries/report.mysql')).toBe('plaintext');
    expect(getSessionFileMonacoLanguageId('queries/report.mysql', true)).toBe('sql');
    expect(getSessionFileMonacoLanguageId('proofs/intro.v')).toBe('plaintext');
    expect(getSessionFileLanguageId('proofs/intro.v')).toBe('plaintext');
    expect(getSessionFileLanguageId('proofs/intro.v', true)).toBe('coq');
    expect(getSessionFileMonacoLanguageId('proofs/intro.v', true)).toBe('plaintext');
    expect(getSessionFileLanguageId('proofs/intro.lean', true)).toBe('lean');
    expect(isSessionFileShikiLanguage('coq')).toBe(true);
    expect(isSessionFileShikiLanguage('v')).toBe(false);
  });

  it('keeps core grammars available by default', () => {
    expect(getSessionFileMonacoLanguageId('src/main.ts')).toBe('typescript');
    expect(getSessionFileMonacoLanguageId('styles/app.css')).toBe('css');
    expect(getSessionFileMonacoLanguageId('README.md')).toBe('markdown');
  });
});
