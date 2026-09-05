import { mkdirSync } from 'node:fs';
import 'tsx';

const acceptanceRound = process.env.LODY_ACCEPTANCE_ROUND_ID?.trim();
const artifactRoot = acceptanceRound ? `artifacts/acceptance/${acceptanceRound}` : 'artifacts';
mkdirSync(artifactRoot, { recursive: true });

/** @type {import('@cucumber/cucumber').IConfiguration} */
export default {
  paths: ['src/features/**/*.feature'],
  import: ['src/steps/**/*.ts', 'src/support/world.ts', 'src/support/hooks.ts'],
  format: [
    'progress-bar',
    `html:${artifactRoot}/cucumber-report.html`,
    `junit:${artifactRoot}/cucumber-junit.xml`,
    `message:${artifactRoot}/cucumber-messages.ndjson`,
  ],
  formatOptions: { snippetInterface: 'async-await' },
  parallel: 0,
  publishQuiet: true,
  retry: 0,
};
