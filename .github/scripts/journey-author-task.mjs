import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  loadJourneyRegistry,
  selectJourneyCandidate,
} from '../../e2e/scripts/journey-registry.mjs';

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error(`Expected --name value arguments; received ${name ?? '<end>'}`);
    }
    values.set(name.slice(2), value);
  }
  return values;
}

function required(args, name, maximum = 500) {
  const value = args.get(name);
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new Error(`--${name} must be a non-empty string no longer than ${maximum} characters`);
  }
  return value;
}

function clampBudget(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 15 || parsed > 120) {
    throw new Error('budget-minutes must be an integer from 15 through 120');
  }
  return parsed;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function createJourneyAuthorTask(input) {
  const excluded = new Set(input.excludedCandidateIds);
  const selectionRegistry = {
    ...input.registry,
    journeys: input.registry.journeys.map((journey) =>
      excluded.has(journey.id)
        ? { ...journey, blockedReason: 'An active claim or Draft PR already owns this candidate.' }
        : journey
    ),
  };
  const selection = selectJourneyCandidate(selectionRegistry, input.signals);
  let selected = selection.selected;
  if (input.requestedCandidateId !== 'next') {
    selected =
      selection.ranked.find((candidate) => candidate.id === input.requestedCandidateId) ?? null;
    if (!selected) {
      throw new Error(
        `Requested candidate ${input.requestedCandidateId} is not an eligible backlog row`
      );
    }
  }

  const issuedAt = new Date(input.now).toISOString();
  if (!Number.isFinite(Date.parse(issuedAt))) throw new Error('now must be a valid ISO date');
  const common = {
    schemaVersion: 1,
    kind: 'lody-e2e-journey-author-task',
    repository: input.repository,
    baseRef: input.baseRef,
    baseSha: input.baseSha,
    runId: input.runId,
    trigger: input.trigger,
    issuedAt,
    selection: {
      considered: selection.considered,
      ranked: selection.ranked,
      skippedBlocked: selection.skippedBlocked,
      skippedDuplicates: selection.skippedDuplicates,
    },
  };
  if (!selected) {
    const task = { ...common, disposition: 'queue-empty' };
    return { ...task, digest: digest(task) };
  }

  const journey = input.registry.journeys.find((candidate) => candidate.id === selected.id);
  const expiresAt = new Date(input.now + input.budgetMinutes * 60_000).toISOString();
  const task = {
    ...common,
    disposition: 'claimed',
    candidate: {
      ...journey,
      score: selected.score,
      scoreBreakdown: selected.breakdown,
      changedPathMatch: selected.changedPathMatch,
      escapedDefectMatch: selected.escapedDefectMatch,
      scoutSignalMatch: selected.scoutSignalMatch,
    },
    claim: {
      leaseId: `${selected.id}-${input.runId}`,
      issuedAt,
      expiresAt,
      budgetMinutes: input.budgetMinutes,
    },
    successContract: {
      unit: 'one registry candidate',
      completion:
        'One deterministic Electron scenario closes every checkpoint and cleanup obligation, then passes three focused rounds and the full suite.',
      notCompletion:
        'Added file count, added scenario count, elapsed effort, or a weakened assertion never constitutes success.',
    },
    authorInstructions: [
      `Implement exactly one user journey with stable id @${selected.id}.`,
      'Read and follow e2e/journeys/AUTHORING.md before editing.',
      'Launch the built OSS Electron app with its bundled CLI; simulate only an uncontrollable external agent/provider wire.',
      'Reuse the existing harness, synthetic fixtures, Page Objects, and thin Cucumber steps.',
      'Do not change workflows, package manifests, lockfiles, suite policy scripts, or unrelated product behavior.',
      'Write only the Feature, step, Page Object, fixture, and three index paths allowed by e2e/journeys/AUTHORING.md.',
      'Do not edit the registry or generated coverage; trusted packaging owns that transition.',
      'Do not commit, push, create a PR, use network services, or read credentials.',
      `For a ready result, name one unique quoted expectation to replace with ${JSON.stringify(`__LODY_COUNTERFACTUAL_${selected.id.replaceAll('-', '_')}__`)} during independent validation.`,
      'Do not run generated test code. After human review, the local maintainer validator owns build, counterfactual, focused, and full validation.',
      'If the boundary cannot be deterministic inside the lease, return a blocked classification; never use sleeps, retries, or live services.',
    ],
  };
  return { ...task, digest: digest(task) };
}

async function readStringArray(path) {
  if (!path) return [];
  const value = JSON.parse(await readFile(resolve(path), 'utf8'));
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${path} must contain a JSON string array`);
  }
  return value;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const registry = loadJourneyRegistry(resolve(required(args, 'registry', 2_000)));
  const now = args.has('now') ? Date.parse(args.get('now')) : Date.now();
  const task = createJourneyAuthorTask({
    registry,
    excludedCandidateIds: await readStringArray(args.get('excluded')),
    requestedCandidateId: args.get('candidate') ?? 'next',
    budgetMinutes: clampBudget(args.get('budget-minutes') ?? '90'),
    repository: required(args, 'repository', 200),
    baseRef: required(args, 'base-ref', 200),
    baseSha: required(args, 'base-sha', 64),
    runId: required(args, 'run-id', 80),
    trigger: required(args, 'trigger', 40),
    now,
    signals: {
      changedFiles: await readStringArray(args.get('changed-files')),
      escapedDefectIds: await readStringArray(args.get('escaped-defects')),
      scoutJourneys: await readStringArray(args.get('scout-journeys')),
    },
  });
  const outputPath = resolve(required(args, 'output', 2_000));
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(task, null, 2)}\n`, 'utf8');
  process.stdout.write(`${task.disposition === 'claimed' ? task.candidate.id : 'queue-empty'}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  await main();
}
