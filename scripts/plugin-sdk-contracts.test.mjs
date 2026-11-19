import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(repoRoot, 'scripts/fixtures/plugin-sdk/tsconfig.json');

test('plugin SDK contracts, dogfood examples, and negative @ts-expect-error bounds typecheck cleanly', () => {
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(configFile.error, undefined, 'Failed to read plugin-sdk tsconfig.json');

  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath));
  assert.deepEqual(parsed.errors, [], 'Unexpected tsconfig parse errors');
  assert.ok(parsed.fileNames.length >= 10, 'Expected SDK declarations, examples, and contracts');

  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);

  if (diagnostics.length > 0) {
    const formatted = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => repoRoot,
      getNewLine: () => '\n',
    });
    assert.fail(`Plugin SDK typecheck failed:\n${formatted}`);
  }
});
