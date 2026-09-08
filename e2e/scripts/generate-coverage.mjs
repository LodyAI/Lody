import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadJourneyRegistry, renderCoverage } from './journey-registry.mjs';

const e2eRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const coveragePath = resolve(e2eRoot, 'COVERAGE.md');
const mode = process.argv[2] ?? '--check';
if (!['--check', '--write'].includes(mode) || process.argv.length > 3) {
  throw new Error('Usage: node scripts/generate-coverage.mjs [--check|--write]');
}

const expected = renderCoverage(loadJourneyRegistry());
if (mode === '--write') {
  writeFileSync(coveragePath, expected, 'utf8');
  console.log('Updated COVERAGE.md from journeys/registry.json.');
} else {
  const actual = readFileSync(coveragePath, 'utf8');
  if (actual !== expected) {
    console.error('COVERAGE.md is stale. Run `pnpm --filter @lody/e2e journey:coverage`.');
    process.exitCode = 1;
  } else {
    console.log('COVERAGE.md matches journeys/registry.json.');
  }
}
