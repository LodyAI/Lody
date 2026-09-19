import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { quoteCommandArgument } from './command-line.js';

// Minimal oracle mirroring `parseCustomAcpCommandLine` from @lody/shared
// (not importable from this package): outside quotes `\` escapes the next
// character; inside double quotes only `\"` and `\\` are escapes; single
// quotes take everything literally. The emitted command line must survive
// this tokenization unchanged.
function tokenizePosix(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let hasCurrent = false;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const char of input) {
    if (escaped) {
      if (quote === '"' && char !== '"' && char !== '\\') current += '\\';
      current += char;
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      hasCurrent = true;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasCurrent = true;
      continue;
    }
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      if (hasCurrent || current.length > 0) {
        tokens.push(current);
        current = '';
        hasCurrent = false;
      }
      continue;
    }
    current += char;
    hasCurrent = true;
  }
  if (quote !== null || escaped) throw new Error(`Unbalanced command line: ${input}`);
  if (hasCurrent || current.length > 0) tokens.push(current);
  return tokens;
}

void describe('quoteCommandArgument', () => {
  void it('leaves plain POSIX paths unquoted', () => {
    assert.equal(quoteCommandArgument('/tmp/lody-e2e-x/agent.mjs'), '/tmp/lody-e2e-x/agent.mjs');
    assert.equal(quoteCommandArgument('/usr/bin/node'), '/usr/bin/node');
  });

  void it('quotes Windows paths so backslashes survive POSIX tokenization', () => {
    assert.equal(
      quoteCommandArgument('D:\\a\\Lody\\script.mjs'),
      '"D:\\\\a\\\\Lody\\\\script.mjs"'
    );
  });

  void it('quotes values containing spaces', () => {
    assert.equal(
      quoteCommandArgument('C:\\Program Files\\nodejs\\node.exe'),
      '"C:\\\\Program Files\\\\nodejs\\\\node.exe"'
    );
  });

  void it('round-trips a Windows argv through POSIX tokenization', () => {
    const argv = [
      'C:\\hostedtoolcache\\windows\\node\\22.22.0\\x64\\node.exe',
      'D:\\a\\Lody\\Lody\\e2e\\src\\support\\fixtures\\scripted-acp.mjs',
      'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\lody-e2e-AbC123\\acp-events.jsonl',
    ];
    const line = argv.map(quoteCommandArgument).join(' ');
    assert.deepEqual(tokenizePosix(line), argv);
  });

  void it('round-trips a POSIX argv unchanged', () => {
    const argv = ['/usr/local/bin/node', '/tmp/lody-e2e-x/script.mjs', '/tmp/e2e/log file.jsonl'];
    const line = argv.map(quoteCommandArgument).join(' ');
    assert.deepEqual(tokenizePosix(line), argv);
  });
});
