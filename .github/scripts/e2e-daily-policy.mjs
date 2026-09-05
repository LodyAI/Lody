#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ACTIONS_BOT_LOGIN = 'github-actions[bot]';

export function isActionsBot(record) {
  return record?.user?.login === ACTIONS_BOT_LOGIN && record.user.type === 'Bot';
}

export function findOwnedDailyFailureIssue(issues, marker) {
  return issues
    .filter(
      (issue) =>
        !issue.pull_request && isActionsBot(issue) && String(issue.body ?? '').includes(marker)
    )
    .sort((left, right) => left.number - right.number)[0];
}

export function hasCompleteOwnedComment(comments, marker, expectedVideos) {
  if (!Number.isInteger(expectedVideos) || expectedVideos < 0 || expectedVideos > 1) {
    throw new Error('expectedVideos must be zero or one');
  }
  return comments.some((comment) => {
    const body = String(comment?.body ?? '');
    if (!isActionsBot(comment) || !body.includes(marker)) return false;
    const uploadedVideos =
      body.match(/https:\/\/github\.com\/user-attachments\/assets\//gu)?.length ?? 0;
    return uploadedVideos >= expectedVideos;
  });
}

export function findDailyEvidenceArtifact(artifacts, runId) {
  const supported = new Map([
    [`desktop-e2e-daily-full-${runId}`, 'full'],
    [`desktop-e2e-daily-smoke-${runId}`, 'smoke'],
    [`desktop-e2e-daily-${runId}`, 'unknown'],
  ]);
  const matches = artifacts.filter(
    (artifact) => !artifact.expired && supported.has(String(artifact.name ?? ''))
  );
  if (matches.length !== 1) return undefined;
  return {
    artifact: matches[0],
    suite: supported.get(matches[0].name),
  };
}

export function findPrEvidenceArtifact(artifacts, runId) {
  const supported = new Map([
    [`desktop-e2e-full-${runId}`, 'full'],
    [`desktop-e2e-smoke-${runId}`, 'smoke'],
  ]);
  const matches = artifacts.filter(
    (artifact) => !artifact.expired && supported.has(String(artifact.name ?? ''))
  );
  if (matches.length !== 1) return undefined;
  return {
    artifact: matches[0],
    suite: supported.get(matches[0].name),
  };
}

export function canCloseDailyFailureIssue(conclusion, suite) {
  return conclusion === 'success' && suite === 'full';
}

function parseCliArgs(argv) {
  if (argv[0] !== 'comment-complete') throw new Error('Expected comment-complete command');
  const values = new Map();
  for (let index = 1; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || !value) throw new Error(`Invalid argument: ${name ?? ''}`);
    values.set(name.slice(2), value);
    index += 1;
  }
  for (const required of ['comments', 'marker', 'expected']) {
    if (!values.has(required)) throw new Error(`--${required} is required`);
  }
  return Object.fromEntries(values);
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const pages = JSON.parse(await readFile(resolve(options.comments), 'utf8'));
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
    throw new Error('Comments must be a JSON array of API pages');
  }
  const expectedVideos = Number.parseInt(options.expected, 10);
  process.stdout.write(
    `${hasCompleteOwnedComment(pages.flat(), options.marker, expectedVideos)}\n`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
