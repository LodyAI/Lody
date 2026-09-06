import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { __test__ } from './index';

describe('cli tool detection helpers', () => {
  it('selectWindowsWhereCandidate prefers .cmd over .ps1', () => {
    const picked = __test__.selectWindowsWhereCandidate([
      'C:\\Users\\Z\\AppData\\Local\\fnm_multishells\\x\\codex.ps1',
      'C:\\Users\\Z\\AppData\\Local\\fnm_multishells\\x\\codex.cmd',
    ]);
    expect(picked).toMatch(/codex\.cmd$/i);
  });

  it('honors CODEX_HOME when computing the Codex auth path', () => {
    const originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = '/tmp/custom-codex';
    try {
      expect(__test__.getCodexCredentialsPath('/tmp/home')).toBe(
        path.join('/tmp/custom-codex', 'auth.json')
      );
    } finally {
      if (originalCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = originalCodexHome;
      }
    }
  });
});
