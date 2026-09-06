import { readFileSync } from 'node:fs';
import { loadJourneyRegistry, selectJourneyCandidate } from './journey-registry.mjs';

function parseArguments(argv) {
  const options = { changedFiles: [], escapedDefectIds: [], scoutJourneys: [], json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') continue;
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    if (argument === '--changed-files') {
      const path = argv[index + 1];
      if (!path) throw new Error('--changed-files requires a newline-delimited file path');
      options.changedFiles = readFileSync(path, 'utf8')
        .split(/\r?\n/gu)
        .map((entry) => entry.trim())
        .filter(Boolean);
      index += 1;
      continue;
    }
    if (argument === '--escaped-defects') {
      const path = argv[index + 1];
      if (!path) throw new Error('--escaped-defects requires a newline-delimited journey id file');
      options.escapedDefectIds = readFileSync(path, 'utf8')
        .split(/\r?\n/gu)
        .map((entry) => entry.trim())
        .filter(Boolean);
      index += 1;
      continue;
    }
    if (argument === '--scout-summary') {
      const path = argv[index + 1];
      if (!path) throw new Error('--scout-summary requires a Scout summary.json path');
      const summary = JSON.parse(readFileSync(path, 'utf8'));
      if (summary?.schemaVersion !== 1 || !Array.isArray(summary.suspectedTrends)) {
        throw new Error('--scout-summary must use the Scout summary schema version 1');
      }
      options.scoutJourneys = [
        ...new Set(
          summary.suspectedTrends
            .map((trend) => trend?.journey)
            .filter((journey) => typeof journey === 'string' && journey !== '')
        ),
      ].sort();
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
const result = selectJourneyCandidate(loadJourneyRegistry(), options);
const report = {
  schemaVersion: 1,
  inputs: {
    changedFiles: options.changedFiles,
    escapedDefectIds: options.escapedDefectIds,
    scoutJourneys: options.scoutJourneys,
  },
  ...result,
};
if (options.json) {
  console.log(JSON.stringify(report, null, 2));
} else if (result.selected) {
  console.log(`Selected: ${result.selected.id} - ${result.selected.title}`);
  console.log(`Owner: ${result.selected.owner}`);
  console.log(`Score: ${result.selected.score}`);
  console.log(`Fingerprint: ${result.selected.fingerprint}`);
  console.log('Score breakdown:');
  for (const [signal, score] of Object.entries(result.selected.breakdown)) {
    console.log(`- ${signal}: ${score}`);
  }
  for (const blocked of result.skippedBlocked) {
    console.log(`Skipped blocked: ${blocked.id} - ${blocked.reason}`);
  }
} else {
  console.log('No eligible journey candidate.');
}
