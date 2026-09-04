import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

import {
  journeyFingerprint,
  renderCoverage,
  validateRegistry,
} from '../../e2e/scripts/journey-registry.mjs';

const MAX_FILES = 24;
const MAX_FILE_BYTES = 300_000;
const MAX_TOTAL_BYTES = 1_500_000;
const INDEX_FILES = new Set([
  'e2e/src/features/README.md',
  'e2e/src/steps/README.md',
  'e2e/src/support/README.md',
]);
const ALLOWED_PATTERNS = [
  /^e2e\/src\/features\/.+\.feature$/u,
  /^e2e\/src\/steps\/.+\.steps\.ts$/u,
  /^e2e\/src\/support\/pages\/.+\.ts$/u,
  /^e2e\/src\/support\/fixtures\/.+\.(?:ts|mjs|json|txt)$/u,
];
const FORBIDDEN_SUFFIXES = ['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || argv[index + 1] === undefined) {
      throw new Error('Expected --name value arguments');
    }
    values.set(argv[index].slice(2), argv[index + 1]);
  }
  return values;
}

export function matchesAllowedPath(path) {
  if (path.startsWith('/') || path.includes('..') || path.includes('\\') || path.includes('\0'))
    return false;
  if (path.startsWith('.github/') || FORBIDDEN_SUFFIXES.some((suffix) => path.endsWith(suffix)))
    return false;
  return INDEX_FILES.has(path) || ALLOWED_PATTERNS.some((pattern) => pattern.test(path));
}

function validateTask(task) {
  if (task?.schemaVersion !== 1 || task.kind !== 'lody-e2e-journey-author-task') {
    throw new Error('Invalid journey author task schema');
  }
  const unsigned = { ...task };
  delete unsigned.digest;
  if (task.digest !== sha256(JSON.stringify(unsigned))) throw new Error('Task digest mismatch');
  if (task.disposition !== 'claimed') throw new Error('Only claimed tasks can produce candidates');
  if (!/^LODY-[A-Z0-9-]+-\d{3}$/.test(task.candidate?.id ?? ''))
    throw new Error('Invalid candidate id');
  if (!/^[a-f0-9]{40}$/.test(task.baseSha)) throw new Error('Invalid base SHA');
  if (!Array.isArray(task.candidate.ownerPaths))
    throw new Error('Candidate ownerPaths are missing');
}

function validateReadyCandidate(task, candidate, { allowGenerated = false } = {}) {
  if (
    candidate?.schemaVersion !== 1 ||
    candidate.kind !== 'lody-e2e-journey-candidate' ||
    candidate.status !== 'ready'
  ) {
    throw new Error('Candidate is not ready');
  }
  const unsigned = { ...candidate };
  delete unsigned.digest;
  if (candidate.digest !== sha256(JSON.stringify(unsigned)))
    throw new Error('Candidate digest mismatch');
  if (
    candidate.taskDigest !== task.digest ||
    candidate.candidateId !== task.candidate.id ||
    candidate.fingerprint !== task.candidate.fingerprint ||
    candidate.baseSha !== task.baseSha ||
    candidate.leaseId !== task.claim.leaseId
  ) {
    throw new Error('Candidate does not match its task');
  }
  if (
    !Array.isArray(candidate.files) ||
    candidate.files.length === 0 ||
    candidate.files.length > MAX_FILES
  ) {
    throw new Error('Candidate files are missing or exceed the file limit');
  }
  const seen = new Set();
  let totalBytes = 0;
  for (const file of candidate.files) {
    const generated = file.path === 'e2e/COVERAGE.md' || file.path === 'e2e/journeys/registry.json';
    if ((!allowGenerated || !generated) && !matchesAllowedPath(file.path))
      throw new Error(`Candidate path is outside scope: ${file.path}`);
    if (seen.has(file.path)) throw new Error(`Candidate path is duplicated: ${file.path}`);
    seen.add(file.path);
    const content = Buffer.from(file.content, 'utf8');
    totalBytes += content.length;
    if (
      content.includes(0) ||
      content.length > MAX_FILE_BYTES ||
      totalBytes > MAX_TOTAL_BYTES ||
      content.length !== file.bytes ||
      sha256(content) !== file.sha256
    ) {
      throw new Error(`Candidate file digest or size is invalid: ${file.path}`);
    }
  }
}

function blockedCandidate(task, code, summary) {
  const allowedClasses = new Set(['product-defect', 'test-capability', 'infra']);
  const failureClass = allowedClasses.has(code) ? code : 'test-capability';
  const detail = allowedClasses.has(code) ? summary : `${code}: ${summary}`;
  const core = {
    schemaVersion: 1,
    kind: 'lody-e2e-journey-candidate',
    status: 'blocked',
    taskDigest: task.digest,
    candidateId: task.candidate.id,
    fingerprint: task.candidate.fingerprint,
    baseSha: task.baseSha,
    leaseId: task.claim.leaseId,
    classification: { code: failureClass, summary: String(detail).slice(0, 2_000) },
    files: [],
  };
  return { ...core, digest: sha256(JSON.stringify(core)) };
}

function parseAuthorResult(finalMessage, task) {
  let result;
  try {
    result = JSON.parse(finalMessage);
  } catch {
    return {
      status: 'blocked',
      failureClass: 'infra',
      summary: 'The author did not return valid structured output.',
    };
  }
  if (result?.status === 'blocked') {
    const allowedClasses = new Set(['product-defect', 'test-capability', 'infra']);
    return {
      status: 'blocked',
      failureClass: allowedClasses.has(result.failureClass) ? result.failureClass : 'infra',
      summary:
        typeof result.summary === 'string' && result.summary.trim()
          ? result.summary.slice(0, 2_000)
          : 'The author blocked the candidate without a summary.',
    };
  }
  if (result?.status !== 'ready' || result.failureClass !== 'none') {
    return {
      status: 'blocked',
      failureClass: 'infra',
      summary: 'The author result has an unsupported status or failure class.',
    };
  }
  const ablation = result.ablation;
  const sentinel = `__LODY_COUNTERFACTUAL_${task.candidate.id.replaceAll('-', '_')}__`;
  if (
    typeof ablation?.path !== 'string' ||
    typeof ablation.search !== 'string' ||
    typeof ablation.replacement !== 'string' ||
    typeof ablation.expectedFailure !== 'string' ||
    ablation.search.includes('\n') ||
    ablation.replacement !== JSON.stringify(sentinel) ||
    ablation.expectedFailure !== sentinel
  ) {
    return {
      status: 'blocked',
      failureClass: 'test-capability',
      summary: 'The author did not provide a bounded counterfactual assertion replacement.',
    };
  }
  return {
    status: 'ready',
    failureClass: 'none',
    summary: typeof result.summary === 'string' ? result.summary.slice(0, 2_000) : '',
    ablation,
  };
}

export async function packageCandidate({ root, task, finalMessage = '' }) {
  validateTask(task);
  const authorResult = parseAuthorResult(finalMessage, task);
  if (authorResult.status === 'blocked') {
    return blockedCandidate(task, authorResult.failureClass, authorResult.summary);
  }
  const status = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: root,
    encoding: 'utf8',
  });
  const entries = status.split('\0').filter(Boolean);
  if (entries.length === 0)
    return blockedCandidate(
      task,
      'no_changes',
      finalMessage || 'The author produced no file changes.'
    );

  const paths = [];
  for (const entry of entries) {
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code.includes('D') || code.includes('R') || code.includes('C') || path.includes(' -> ')) {
      return blockedCandidate(
        task,
        'unsupported_change',
        `Deletion, rename, or copy is not allowed: ${path}`
      );
    }
    if (!matchesAllowedPath(path)) {
      return blockedCandidate(
        task,
        'path_outside_candidate_scope',
        `Candidate changed a path outside its registry scope: ${path}`
      );
    }
    paths.push(path);
  }
  const uniquePaths = [...new Set(paths)].sort();
  if (uniquePaths.length > MAX_FILES - 2) {
    return blockedCandidate(
      task,
      'candidate_too_large',
      `Candidate changed ${uniquePaths.length} files; author limit is ${MAX_FILES - 2}.`
    );
  }

  if (!uniquePaths.includes(authorResult.ablation.path)) {
    return blockedCandidate(
      task,
      'test-capability',
      'The counterfactual must target a file changed by this one-journey candidate.'
    );
  }

  const addedFeatureLines = [];
  for (const path of uniquePaths.filter((candidatePath) => candidatePath.endsWith('.feature'))) {
    let tracked = true;
    try {
      execFileSync('git', ['ls-files', '--error-unmatch', '--', path], {
        cwd: root,
        stdio: 'ignore',
      });
    } catch {
      tracked = false;
    }
    if (tracked) {
      const diff = execFileSync('git', ['diff', '--no-ext-diff', '--unified=0', '--', path], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 1_000_000,
      });
      addedFeatureLines.push(
        ...diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      );
    } else {
      const content = await readFile(resolve(root, path), 'utf8');
      addedFeatureLines.push(...content.split('\n').map((line) => `+${line}`));
    }
  }
  const addedScenarioLines = addedFeatureLines.filter((line) =>
    /^\+\s*(?:Scenario|场景):/u.test(line)
  );
  const addedIdLines = addedFeatureLines.filter((line) => line.includes(`@${task.candidate.id}`));
  if (addedScenarioLines.length !== 1 || addedIdLines.length !== 1) {
    return blockedCandidate(
      task,
      'not_one_journey',
      `Expected one added scenario and one @${task.candidate.id} tag; found ${addedScenarioLines.length} scenarios and ${addedIdLines.length} tags.`
    );
  }

  const files = [];
  let totalBytes = 0;
  for (const path of uniquePaths) {
    const absolute = resolve(root, path);
    const relativePath = relative(root, absolute);
    if (relativePath.startsWith(`..${sep}`) || relativePath === '..') {
      return blockedCandidate(task, 'path_escape', `Candidate path escapes the workspace: ${path}`);
    }
    const stat = await lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return blockedCandidate(
        task,
        'unsupported_file_type',
        `Candidate path is not a regular file: ${path}`
      );
    }
    const content = await readFile(absolute);
    if (content.includes(0) || content.length > MAX_FILE_BYTES) {
      return blockedCandidate(
        task,
        'unsupported_file_content',
        `Candidate file is binary or too large: ${path}`
      );
    }
    totalBytes += content.length;
    if (totalBytes > MAX_TOTAL_BYTES) {
      return blockedCandidate(
        task,
        'candidate_too_large',
        `Candidate content exceeds ${MAX_TOTAL_BYTES} bytes.`
      );
    }
    files.push({
      path,
      bytes: content.length,
      sha256: sha256(content),
      content: content.toString('utf8'),
    });
  }

  const ablationFile = files.find((file) => file.path === authorResult.ablation.path);
  if (
    !/^e2e\/src\/(?:steps\/.+\.steps\.ts|support\/pages\/.+\.ts)$/u.test(authorResult.ablation.path)
  ) {
    return blockedCandidate(
      task,
      'test-capability',
      'The counterfactual must target an assertion in a changed step or Page Object.'
    );
  }
  if (files.some((file) => file.content.includes(authorResult.ablation.expectedFailure))) {
    return blockedCandidate(
      task,
      'test-capability',
      'Candidate source must not contain the validator-only counterfactual sentinel.'
    );
  }
  const occurrenceCount = ablationFile?.content.split(authorResult.ablation.search).length - 1;
  if (occurrenceCount !== 1) {
    return blockedCandidate(
      task,
      'test-capability',
      `The counterfactual search must occur exactly once in ${authorResult.ablation.path}.`
    );
  }

  const core = {
    schemaVersion: 1,
    kind: 'lody-e2e-journey-candidate',
    status: 'ready',
    taskDigest: task.digest,
    candidateId: task.candidate.id,
    fingerprint: task.candidate.fingerprint,
    baseSha: task.baseSha,
    leaseId: task.claim.leaseId,
    title: task.candidate.title,
    ablation: authorResult.ablation,
    files,
  };
  return { ...core, digest: sha256(JSON.stringify(core)) };
}

export async function validateAndApplyCandidate({ root, task, candidate }) {
  validateTask(task);
  validateReadyCandidate(task, candidate);
  for (const file of candidate.files) {
    const content = Buffer.from(file.content, 'utf8');
    const absolute = resolve(root, file.path);
    if (!absolute.startsWith(`${resolve(root)}${sep}`))
      throw new Error(`Candidate path escapes workspace: ${file.path}`);
    try {
      const existing = await lstat(absolute);
      if (existing.isSymbolicLink() || (!existing.isFile() && !existing.isDirectory())) {
        throw new Error(`Candidate target is not a regular path: ${file.path}`);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, { mode: 0o644 });
  }
}

function withDigest(candidate, files) {
  const core = { ...candidate, files };
  delete core.digest;
  return { ...core, digest: sha256(JSON.stringify(core)) };
}

export async function promoteCandidate({ root, task, candidate }) {
  validateTask(task);
  validateReadyCandidate(task, candidate);
  const featureFiles = candidate.files.filter(
    (file) => file.path.endsWith('.feature') && file.content.includes(`@${task.candidate.id}`)
  );
  if (featureFiles.length !== 1) {
    throw new Error(`Expected exactly one feature file for ${task.candidate.id}`);
  }
  const registryPath = resolve(root, 'e2e/journeys/registry.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  const row = registry.journeys?.find((journey) => journey.id === task.candidate.id);
  if (
    row?.state !== 'backlog' ||
    row.fingerprint !== task.candidate.fingerprint ||
    journeyFingerprint(row) !== task.candidate.fingerprint
  ) {
    throw new Error(`Registry row ${task.candidate.id} no longer matches the claimed backlog`);
  }
  row.state = 'active';
  row.feature = featureFiles[0].path.slice('e2e/'.length);
  row.blockedReason = null;
  const failures = validateRegistry(registry);
  if (failures.length > 0) {
    throw new Error(`Promoted registry is invalid:\n- ${failures.join('\n- ')}`);
  }
  const registryContent = `${JSON.stringify(registry, null, 2)}\n`;
  const coverageContent = renderCoverage(registry);
  await writeFile(registryPath, registryContent, 'utf8');
  await writeFile(resolve(root, 'e2e/COVERAGE.md'), coverageContent, 'utf8');

  const generatedFiles = [
    ['e2e/COVERAGE.md', coverageContent],
    ['e2e/journeys/registry.json', registryContent],
  ].map(([path, content]) => ({
    path,
    bytes: Buffer.byteLength(content),
    sha256: sha256(content),
    content,
  }));
  const promoted = withDigest(
    candidate,
    [...candidate.files, ...generatedFiles].sort((a, b) => a.path.localeCompare(b.path))
  );
  validateReadyCandidate(task, promoted, { allowGenerated: true });
  return promoted;
}

export async function applyAblation({ root, task, candidate }) {
  validateTask(task);
  validateReadyCandidate(task, candidate, { allowGenerated: true });
  const file = candidate.files.find((entry) => entry.path === candidate.ablation?.path);
  if (!file) throw new Error('Ablation path is not part of the candidate');
  const occurrenceCount = file.content.split(candidate.ablation.search).length - 1;
  if (occurrenceCount !== 1) throw new Error('Ablation search is not unique');
  const content = file.content.replace(candidate.ablation.search, candidate.ablation.replacement);
  await writeFile(resolve(root, file.path), content, 'utf8');
}

export async function restoreAblation({ root, task, candidate }) {
  validateTask(task);
  validateReadyCandidate(task, candidate, { allowGenerated: true });
  const file = candidate.files.find((entry) => entry.path === candidate.ablation?.path);
  if (!file) throw new Error('Ablation path is not part of the candidate');
  await writeFile(resolve(root, file.path), file.content, 'utf8');
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const root = resolve(args.get('root') ?? process.cwd());
  const task = JSON.parse(await readFile(resolve(args.get('task')), 'utf8'));
  if (command === 'package') {
    const finalMessage = args.get('final-message')
      ? await readFile(resolve(args.get('final-message')), 'utf8')
      : '';
    const candidate = await packageCandidate({ root, task, finalMessage });
    await writeFile(resolve(args.get('output')), `${JSON.stringify(candidate, null, 2)}\n`, 'utf8');
    process.stdout.write(`${candidate.status}\n`);
    return;
  }
  if (command === 'block') {
    const candidate = blockedCandidate(
      task,
      args.get('code') ?? 'author_failed',
      args.get('summary') ?? 'The author did not complete the candidate.'
    );
    await writeFile(resolve(args.get('output')), `${JSON.stringify(candidate, null, 2)}\n`, 'utf8');
    return;
  }
  if (command === 'apply') {
    const candidate = JSON.parse(await readFile(resolve(args.get('candidate')), 'utf8'));
    await validateAndApplyCandidate({ root, task, candidate });
    return;
  }
  if (command === 'promote') {
    const candidate = JSON.parse(await readFile(resolve(args.get('candidate')), 'utf8'));
    const promoted = await promoteCandidate({ root, task, candidate });
    await writeFile(resolve(args.get('output')), `${JSON.stringify(promoted, null, 2)}\n`, 'utf8');
    return;
  }
  if (command === 'ablate' || command === 'restore') {
    const candidate = JSON.parse(await readFile(resolve(args.get('candidate')), 'utf8'));
    await (command === 'ablate' ? applyAblation : restoreAblation)({ root, task, candidate });
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  await main();
}
