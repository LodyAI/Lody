import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(repoRoot, 'scripts/fixtures/plugin-sdk');

function verifyTsconfig(configFileName, minFiles) {
  const configPath = path.join(fixtureDir, configFileName);
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(configFile.error, undefined, `Failed to read ${configFileName}`);

  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, fixtureDir);
  assert.deepEqual(parsed.errors, [], `Unexpected ${configFileName} parse errors`);
  assert.ok(
    parsed.fileNames.length >= minFiles,
    `Expected at least ${minFiles} files in ${configFileName}, got ${parsed.fileNames.length}`
  );

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
    assert.fail(`Plugin SDK typecheck failed (${configFileName}):\n${formatted}`);
  }
}

test('plugin SDK browser-pure client contracts and dogfood UI examples typecheck cleanly', () => {
  verifyTsconfig('tsconfig.json', 8);
});

test('plugin SDK Node machine contracts and durable dataDir examples typecheck without DOM globals', () => {
  verifyTsconfig('tsconfig.machine.json', 7);
});
