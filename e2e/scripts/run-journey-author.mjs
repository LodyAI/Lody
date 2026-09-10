import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createJourneyAuthorTask } from '../../.github/scripts/journey-author-task.mjs';
import {
  applyAblation,
  packageCandidate,
  promoteCandidate,
  restoreAblation,
  validateAndApplyCandidate,
} from '../../.github/scripts/journey-author-package.mjs';
import { loadJourneyRegistry } from './journey-registry.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = resolve(scriptDirectory, '..', '..');
const valueOptions = new Set([
  'artifact-dir',
  'budget-minutes',
  'candidate',
  'changed-files',
  'escaped-defects',
  'excluded',
  'model',
  'scout-journeys',
]);
const booleanOptions = new Set(['help', 'prepare-only']);

export function parseLocalAuthorOptions(argv) {
  const options = {
    candidate: 'next',
    budgetMinutes: 90,
    model: 'gpt-5.6-sol',
    prepareOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') continue;
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const name = token.slice(2);
    if (booleanOptions.has(name)) {
      if (name === 'help') options.help = true;
      if (name === 'prepare-only') options.prepareOnly = true;
      continue;
    }
    if (!valueOptions.has(name)) throw new Error(`Unknown option: --${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    index += 1;
    if (name === 'budget-minutes') {
      const minutes = Number.parseInt(value, 10);
      if (!Number.isInteger(minutes) || minutes < 15 || minutes > 120) {
        throw new Error('--budget-minutes must be an integer from 15 through 120');
      }
      options.budgetMinutes = minutes;
    } else {
      const key = name.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
      options[key] = value;
    }
  }
  return options;
}

export function buildCodexEnvironment(environment = process.env) {
  const allowed = [
    'CODEX_HOME',
    'HOME',
    'LANG',
    'LC_ALL',
    'LOGNAME',
    'PATH',
    'SHELL',
    'SSL_CERT_DIR',
    'SSL_CERT_FILE',
    'TERM',
    'TMPDIR',
    'USER',
  ];
  return Object.fromEntries(
    allowed
      .filter((name) => typeof environment[name] === 'string')
      .map((name) => [name, environment[name]])
  );
}

export function buildValidationEnvironment(home, environment = process.env) {
  const allowed = ['LANG', 'LC_ALL', 'PATH', 'SHELL', 'SSL_CERT_DIR', 'SSL_CERT_FILE', 'TERM'];
  return {
    ...Object.fromEntries(
      allowed
        .filter((name) => typeof environment[name] === 'string')
        .map((name) => [name, environment[name]])
    ),
    CI: '1',
    HOME: home,
    TMPDIR: resolve(home, 'tmp'),
  };
}

export function buildCodexExecArgs({ model, root, schemaPath, outputPath }) {
  return [
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--sandbox',
    'workspace-write',
    '--model',
    model,
    '--config',
    'model_reasoning_effort="high"',
    '--config',
    'sandbox_workspace_write.network_access=false',
    '--config',
    'shell_environment_policy.include_only=["PATH"]',
    '--config',
    'shell_environment_policy.ignore_default_excludes=false',
    '--output-schema',
    schemaPath,
    '--output-last-message',
    outputPath,
    '--cd',
    root,
    '-',
  ];
}

export function validationCommandPlan(candidateId) {
  if (!/^LODY-[A-Z0-9-]+-\d{3}$/u.test(candidateId)) throw new Error('Invalid candidate id');
  const focused = [1, 2, 3].map((round) => ({
    name: `focused-${round}`,
    command: 'pnpm',
    args: [
      '--filter',
      '@lody/e2e',
      'exec',
      'cucumber-js',
      '--config',
      'cucumber.mjs',
      '--tags',
      `@${candidateId}`,
    ],
    round,
  }));
  return [
    {
      name: 'submodules',
      command: 'git',
      args: ['submodule', 'update', '--init', '--recursive'],
    },
    { name: 'install', command: 'pnpm', args: ['install', '--frozen-lockfile'] },
    { name: 'contract', command: 'pnpm', args: ['--filter', '@lody/e2e', 'check'] },
    { name: 'build', command: 'pnpm', args: ['--dir', 'apps/electron', 'build'] },
    ...focused,
    { name: 'full', command: 'pnpm', args: ['--filter', '@lody/e2e', 'full'] },
    { name: 'diff-check', command: 'git', args: ['diff', '--check'] },
  ];
}

function runCapture(command, args, { cwd, environment = process.env, timeout } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    encoding: 'utf8',
    maxBuffer: 10_000_000,
    timeout,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`);
  }
  return result.stdout.trim();
}

async function runLogged(command, args, { cwd, environment = process.env, logPath, timeout }) {
  await mkdir(dirname(logPath), { recursive: true });
  const output = createWriteStream(logPath, { flags: 'w', mode: 0o600 });
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    let timedOut = false;
    const append = (chunk, target) => {
      target.write(chunk);
      output.write(chunk);
      tail = `${tail}${chunk.toString('utf8')}`.slice(-100_000);
    };
    child.stdout.on('data', (chunk) => append(chunk, process.stdout));
    child.stderr.on('data', (chunk) => append(chunk, process.stderr));
    child.on('error', (error) => {
      output.end();
      rejectPromise(error);
    });
    let forceTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    }, timeout);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      output.end();
      resolvePromise({ code, signal, tail, timedOut });
    });
  });
}

function assertSuccess(result, stage) {
  if (result.code !== 0 || result.timedOut) {
    throw new Error(`${stage} failed${result.timedOut ? ' after reaching its time limit' : ''}`);
  }
}

function parseRepository(remote) {
  const match = remote.match(/(?:github\.com[/:])([^/]+\/[^/.]+)(?:\.git)?$/u);
  return match?.[1] ?? 'LodyAI/Lody';
}

async function readStringList(path) {
  if (!path) return [];
  const body = await readFile(resolve(path), 'utf8');
  if (body.trim().startsWith('[')) {
    const parsed = JSON.parse(body);
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
      throw new Error(`${path} must contain a JSON string array or one value per line`);
    }
    return [...new Set(parsed)].sort();
  }
  return [
    ...new Set(
      body
        .split(/\r?\n/u)
        .map((entry) => entry.trim())
        .filter(Boolean)
    ),
  ].sort();
}

function recentChangedFiles(root) {
  const body = runCapture('git', ['log', '--format=', '--name-only', '-n', '20', 'HEAD'], {
    cwd: root,
  });
  return [
    ...new Set(
      body
        .split(/\r?\n/u)
        .map((entry) => entry.trim())
        .filter(Boolean)
    ),
  ].sort();
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function assertCandidatePathSet(status, expectedPaths) {
  const actualPaths = status
    .split('\0')
    .filter(Boolean)
    .map((entry) => entry.slice(3))
    .sort();
  const expected = [...expectedPaths].sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expected)) {
    throw new Error(
      `Validated worktree paths differ from the candidate: expected ${expected.join(', ')}, found ${actualPaths.join(', ')}`
    );
  }
}

async function verifyCandidateFiles(root, candidate) {
  const status = runCapture('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: root,
  });
  assertCandidatePathSet(
    status,
    candidate.files.map((file) => file.path)
  );
  for (const file of candidate.files) {
    const body = await readFile(resolve(root, file.path));
    if (body.length !== file.bytes || sha256(body) !== file.sha256) {
      throw new Error(`Validated file no longer matches its candidate digest: ${file.path}`);
    }
  }
}

async function createTask(root, options, runId) {
  const registry = loadJourneyRegistry(resolve(root, 'e2e/journeys/registry.json'));
  const baseSha = runCapture('git', ['rev-parse', 'HEAD'], { cwd: root });
  const remote = runCapture('git', ['remote', 'get-url', 'origin'], { cwd: root });
  return createJourneyAuthorTask({
    registry,
    excludedCandidateIds: await readStringList(options.excluded),
    requestedCandidateId: options.candidate,
    budgetMinutes: options.budgetMinutes,
    repository: parseRepository(remote),
    baseRef: runCapture('git', ['branch', '--show-current'], { cwd: root }) || 'HEAD',
    baseSha,
    runId,
    trigger: 'local-maintainer',
    now: Date.now(),
    signals: {
      changedFiles: options.changedFiles
        ? await readStringList(options.changedFiles)
        : recentChangedFiles(root),
      escapedDefectIds: await readStringList(options.escapedDefects),
      scoutJourneys: await readStringList(options.scoutJourneys),
    },
  });
}

async function assertToolchain(root) {
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
    throw new Error(`Node.js 22 or newer is required; found ${process.versions.node}`);
  }
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const expectedPnpm = /^pnpm@([^+]+)(?:\+|$)/u.exec(manifest.packageManager)?.[1];
  const actualPnpm = runCapture('pnpm', ['--version'], { cwd: root });
  if (!expectedPnpm || actualPnpm !== expectedPnpm) {
    throw new Error(`pnpm ${expectedPnpm ?? '<missing pin>'} is required; found ${actualPnpm}`);
  }
}

async function acquireLock(root, runId) {
  const gitPath = runCapture('git', ['rev-parse', '--git-path', 'lody-journey-author.lock'], {
    cwd: root,
  });
  const lockPath = resolve(root, gitPath);
  await mkdir(dirname(lockPath), { recursive: true });
  let handle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`Another local journey author owns ${lockPath}`, { cause: error });
    }
    throw error;
  }
  await handle.writeFile(`${JSON.stringify({ runId, pid: process.pid })}\n`);
  await handle.close();
  return async () =>
    await unlink(lockPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
}

function assertControlledArtifactPath(root, artifactRoot) {
  const controlledRoot = resolve(root, 'e2e/artifacts/journey-author');
  const controlledRelative = relative(controlledRoot, artifactRoot);
  if (
    controlledRelative === '' ||
    controlledRelative === '..' ||
    controlledRelative.startsWith(`..${sep}`) ||
    controlledRelative.includes(sep)
  ) {
    throw new Error('Artifacts must be a direct child of e2e/artifacts/journey-author');
  }
  return controlledRoot;
}

async function assertArtifactDirectoriesAreReal(root, artifactRoot) {
  for (const path of [
    resolve(root, 'e2e/artifacts'),
    resolve(root, 'e2e/artifacts/journey-author'),
    artifactRoot,
  ]) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      throw new Error(`Journey artifact directory must not be a symbolic link: ${path}`);
    }
  }
}

export async function createArtifactRoot(root, requestedPath, runId) {
  const artifactsRoot = resolve(root, 'e2e/artifacts');
  const artifactRoot = requestedPath
    ? resolve(requestedPath)
    : resolve(artifactsRoot, 'journey-author', runId);
  const controlledRoot = assertControlledArtifactPath(root, artifactRoot);
  try {
    if ((await lstat(artifactsRoot)).isSymbolicLink()) {
      throw new Error(`Journey artifact directory must not be a symbolic link: ${artifactsRoot}`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await mkdir(controlledRoot, { recursive: true });
  for (const path of [artifactsRoot, controlledRoot]) {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new Error(`Journey artifact directory must not be a symbolic link: ${path}`);
    }
  }

  await mkdir(dirname(artifactRoot), { recursive: true });
  try {
    await mkdir(artifactRoot, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`Journey artifact directory already exists: ${artifactRoot}`, {
        cause: error,
      });
    }
    throw error;
  }
  return artifactRoot;
}

async function invokeCodex({ root, task, outputPath, model, timeout }) {
  const login = spawnSync('codex', ['login', 'status'], {
    cwd: root,
    env: buildCodexEnvironment(),
    stdio: 'ignore',
  });
  if (login.error?.code === 'ENOENT') throw new Error('Codex CLI is not installed or not on PATH');
  if (login.error) throw login.error;
  if (login.status !== 0) throw new Error('Codex is not authenticated; run `codex login` first');

  const schemaPath = resolve(root, 'e2e/journeys/author-result.schema.json');
  const args = buildCodexExecArgs({ model, root, schemaPath, outputPath });
  const child = spawn('codex', args, {
    cwd: root,
    env: buildCodexEnvironment(),
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  child.stdin.end(`${JSON.stringify(task, null, 2)}\n`);
  await new Promise((resolvePromise, rejectPromise) => {
    let timedOut = false;
    let forceTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    }, timeout);
    child.on('error', (error) => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      rejectPromise(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      if (code === 0) resolvePromise();
      else {
        rejectPromise(
          new Error(
            timedOut
              ? `Codex author exceeded its ${task.claim.budgetMinutes}-minute lease`
              : `Codex author exited with status ${code ?? 'unknown'}`
          )
        );
      }
    });
  });
}

async function validateLocally({ root, task, candidate, artifactRoot, environment, timeout }) {
  const checks = {};
  try {
    const plan = validationCommandPlan(task.candidate.id);
    for (const stage of plan.slice(0, 4)) {
      const result = await runLogged(stage.command, stage.args, {
        cwd: root,
        environment,
        logPath: resolve(artifactRoot, `${stage.name}.log`),
        timeout,
      });
      checks[stage.name] = result.code === 0 && !result.timedOut ? 'passed' : 'failed';
      assertSuccess(result, stage.name);
    }

    await applyAblation({ root, task, candidate });
    let counterfactual;
    try {
      counterfactual = await runLogged(
        'pnpm',
        [
          '--filter',
          '@lody/e2e',
          'exec',
          'cucumber-js',
          '--config',
          'cucumber.mjs',
          '--tags',
          `@${task.candidate.id}`,
        ],
        {
          cwd: root,
          environment: {
            ...environment,
            LODY_ACCEPTANCE_ROUND_ID: `${task.runId}-counterfactual`,
          },
          logPath: resolve(artifactRoot, 'counterfactual.log'),
          timeout,
        }
      );
    } finally {
      await restoreAblation({ root, task, candidate });
    }
    if (
      counterfactual.code === 0 ||
      counterfactual.timedOut ||
      !counterfactual.tail.includes(candidate.ablation.expectedFailure)
    ) {
      checks.counterfactual = 'failed';
      throw new Error('Counterfactual did not fail at the declared checkpoint');
    }
    checks.counterfactual = 'passed';

    for (const stage of plan.slice(4)) {
      const stageEnvironment = stage.round
        ? {
            ...environment,
            LODY_ACCEPTANCE_ROUND_ID: `${task.runId}-${stage.round}`,
          }
        : environment;
      const result = await runLogged(stage.command, stage.args, {
        cwd: root,
        environment: stageEnvironment,
        logPath: resolve(artifactRoot, `${stage.name}.log`),
        timeout,
      });
      checks[stage.name] = result.code === 0 && !result.timedOut ? 'passed' : 'failed';
      assertSuccess(result, stage.name);
    }
    await verifyCandidateFiles(root, candidate);
    checks.hashes = 'passed';
    return checks;
  } catch (error) {
    error.checks = checks;
    throw error;
  }
}

export function parseLocalValidationOptions(argv) {
  const options = { approveReviewed: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') continue;
    if (token === '--help') {
      options.help = true;
      continue;
    }
    if (token === '--approve-reviewed') {
      options.approveReviewed = true;
      continue;
    }
    if (token !== '--artifact-dir' && token !== '--budget-minutes') {
      throw new Error(`Unknown option: ${token}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${token} requires a value`);
    index += 1;
    if (token === '--artifact-dir') options.artifactDir = value;
    else {
      const minutes = Number.parseInt(value, 10);
      if (!Number.isInteger(minutes) || minutes < 15 || minutes > 120) {
        throw new Error('--budget-minutes must be an integer from 15 through 120');
      }
      options.budgetMinutes = minutes;
    }
  }
  return options;
}

function renderWorktreePatch(root, candidate) {
  runCapture('git', ['add', '--intent-to-add', '--', ...candidate.files.map((file) => file.path)], {
    cwd: root,
  });
  return runCapture(
    'git',
    ['diff', '--no-ext-diff', '--binary', '--', ...candidate.files.map((file) => file.path)],
    { cwd: root }
  );
}

async function writeReviewBundle(root, artifactRoot, task, candidate) {
  const reviewRoot = resolve(artifactRoot, 'review');
  for (const file of candidate.files) {
    const path = resolve(reviewRoot, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content, { mode: 0o600 });
  }
  const patch = renderWorktreePatch(root, candidate);
  await writeFile(resolve(artifactRoot, 'candidate.patch'), `${patch}\n`, { mode: 0o600 });
  const review = [
    `# Review ${task.candidate.id}`,
    '',
    task.candidate.title,
    '',
    'Review every file and the declared counterfactual before approving local execution.',
    '',
    ...candidate.files.map((file) => `- \`${file.path}\` (${file.bytes} bytes)`),
    '',
    `Counterfactual file: \`${candidate.ablation.path}\``,
    '',
    'After review:',
    '',
    '```bash',
    `pnpm e2e:journey:validate -- --artifact-dir ${JSON.stringify(artifactRoot)} --approve-reviewed`,
    '```',
    '',
  ].join('\n');
  await writeFile(resolve(artifactRoot, 'REVIEW.md'), review, { mode: 0o600 });
}

function validationUsage() {
  return [
    'Usage: pnpm e2e:journey:validate -- --artifact-dir PATH --approve-reviewed',
    '',
    '  --artifact-dir PATH     Ready author bundle to validate',
    '  --approve-reviewed      Confirm every generated file was reviewed',
    '  --budget-minutes N      Per-command timeout, 15-120 (default: task lease)',
  ].join('\n');
}

function usage() {
  return [
    'Usage: pnpm e2e:journey:author -- [options]',
    '',
    '  --candidate ID          Registry id, or next (default: next)',
    '  --model MODEL           Local Codex model (default: gpt-5.6-sol)',
    '  --budget-minutes N      Author and command timeout, 15-120 (default: 90)',
    '  --prepare-only          Claim and write a task without invoking Codex',
    '  --changed-files PATH    JSON array or newline-delimited ranking signal',
    '  --escaped-defects PATH  JSON array or newline-delimited registry ids',
    '  --scout-journeys PATH   JSON array or newline-delimited Scout journey names',
    '  --excluded PATH         JSON array or newline-delimited claimed registry ids',
    '  --artifact-dir PATH     Override the ignored local evidence directory',
  ].join('\n');
}

export async function main(argv = process.argv.slice(2), root = defaultRepositoryRoot) {
  const options = parseLocalAuthorOptions(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  await assertToolchain(root);
  const status = runCapture('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: root,
  });
  if (status) throw new Error('Local journey author requires a clean worktree');

  const runId = `local-${new Date()
    .toISOString()
    .replaceAll(/[^0-9]/gu, '')
    .slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const artifactRoot = await createArtifactRoot(root, options.artifactDir, runId);
  const releaseLock = await acquireLock(root, runId);
  let temporaryRoot;
  let authorWorktree;
  try {
    const task = await createTask(root, options, runId);
    await writeFile(resolve(artifactRoot, 'task.json'), `${JSON.stringify(task, null, 2)}\n`, {
      mode: 0o600,
    });
    if (task.disposition === 'queue-empty') {
      process.stdout.write(`Journey queue is empty. Task: ${resolve(artifactRoot, 'task.json')}\n`);
      return;
    }
    process.stdout.write(`Claimed ${task.candidate.id}: ${task.candidate.title}\n`);
    if (options.prepareOnly) {
      process.stdout.write(`Prepared task: ${resolve(artifactRoot, 'task.json')}\n`);
      return;
    }

    temporaryRoot = await mkdtemp(join(tmpdir(), 'lody-journey-author-'));
    authorWorktree = resolve(temporaryRoot, 'worktree');
    runCapture('git', ['worktree', 'add', '--detach', authorWorktree, task.baseSha], { cwd: root });
    const finalMessagePath = resolve(artifactRoot, 'author-result.json');
    try {
      await invokeCodex({
        root: authorWorktree,
        task,
        outputPath: finalMessagePath,
        model: options.model,
        timeout: options.budgetMinutes * 60_000,
      });
    } catch (error) {
      await writeFile(resolve(artifactRoot, 'author-error.txt'), `${error.message}\n`, {
        mode: 0o600,
      });
      await writeFile(
        finalMessagePath,
        `${JSON.stringify({
          status: 'blocked',
          failureClass: 'infra',
          summary: error.message,
          ablation: null,
        })}\n`,
        { mode: 0o600 }
      );
    }
    const candidate = await packageCandidate({
      root: authorWorktree,
      task,
      finalMessage: await readFile(finalMessagePath, 'utf8'),
    });
    await writeFile(
      resolve(artifactRoot, 'candidate.json'),
      `${JSON.stringify(candidate, null, 2)}\n`,
      {
        mode: 0o600,
      }
    );
    if (candidate.status !== 'ready') {
      process.exitCode = 2;
      process.stdout.write(
        `Candidate ${task.candidate.id} is blocked (${candidate.classification.code}). Evidence: ${artifactRoot}\n`
      );
      return;
    }

    await writeReviewBundle(authorWorktree, artifactRoot, task, candidate);
    process.stdout.write(
      `Candidate ${task.candidate.id} is ready for human review. No generated code was executed.\nReview: ${resolve(artifactRoot, 'REVIEW.md')}\n`
    );
  } finally {
    if (authorWorktree) {
      spawnSync('git', ['worktree', 'remove', '--force', authorWorktree], {
        cwd: root,
        stdio: 'ignore',
      });
    }
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
    await releaseLock();
  }
}

export async function validateMain(argv = process.argv.slice(2), root = defaultRepositoryRoot) {
  const options = parseLocalValidationOptions(argv);
  if (options.help) {
    process.stdout.write(`${validationUsage()}\n`);
    return;
  }
  if (!options.artifactDir) throw new Error('--artifact-dir is required');
  if (!options.approveReviewed) {
    throw new Error('Review REVIEW.md and candidate.patch, then pass --approve-reviewed');
  }
  await assertToolchain(root);
  if (runCapture('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root })) {
    throw new Error('Local journey validation requires a clean worktree');
  }

  const artifactRoot = resolve(options.artifactDir);
  assertControlledArtifactPath(root, artifactRoot);
  await assertArtifactDirectoriesAreReal(root, artifactRoot);
  const task = JSON.parse(await readFile(resolve(artifactRoot, 'task.json'), 'utf8'));
  const candidate = JSON.parse(await readFile(resolve(artifactRoot, 'candidate.json'), 'utf8'));
  if (runCapture('git', ['rev-parse', 'HEAD'], { cwd: root }) !== task.baseSha) {
    throw new Error(`Candidate base ${task.baseSha} does not match current HEAD`);
  }

  const releaseLock = await acquireLock(root, `${task.runId}-validate`);
  let temporaryRoot;
  let validationRoot;
  const attestation = {
    schemaVersion: 1,
    kind: 'lody-e2e-local-journey-attestation',
    status: 'failed',
    candidateId: task.candidate?.id ?? null,
    baseSha: task.baseSha,
    taskDigest: task.digest,
    candidateDigest: candidate.digest,
    checks: {},
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  let patchPath;
  try {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'lody-journey-validation-'));
    validationRoot = resolve(temporaryRoot, 'worktree');
    const validationHome = resolve(temporaryRoot, 'home');
    await mkdir(resolve(validationHome, 'tmp'), { recursive: true });
    const environment = buildValidationEnvironment(validationHome);
    runCapture('git', ['worktree', 'add', '--detach', validationRoot, task.baseSha], { cwd: root });
    await validateAndApplyCandidate({ root: validationRoot, task, candidate });
    const promoted = await promoteCandidate({ root: validationRoot, task, candidate });
    await writeFile(
      resolve(artifactRoot, 'candidate.promoted.json'),
      `${JSON.stringify(promoted, null, 2)}\n`,
      { mode: 0o600 }
    );
    attestation.candidateDigest = promoted.digest;
    patchPath = resolve(artifactRoot, 'validated.patch');
    await writeFile(patchPath, `${renderWorktreePatch(validationRoot, promoted)}\n`, {
      mode: 0o600,
    });
    try {
      attestation.checks = await validateLocally({
        root: validationRoot,
        task,
        candidate: promoted,
        artifactRoot,
        environment,
        timeout: (options.budgetMinutes ?? task.claim.budgetMinutes) * 60_000,
      });
    } catch (error) {
      attestation.checks = error.checks ?? attestation.checks;
      throw error;
    }

    attestation.checks.patchReady = 'passed';
    attestation.status = 'passed';
  } catch (error) {
    attestation.error = error.message;
    throw error;
  } finally {
    attestation.finishedAt = new Date().toISOString();
    const digest = sha256(JSON.stringify(attestation));
    try {
      await writeFile(
        resolve(artifactRoot, 'attestation.json'),
        `${JSON.stringify({ ...attestation, digest }, null, 2)}\n`,
        { mode: 0o600 }
      );
    } finally {
      if (validationRoot) {
        spawnSync('git', ['worktree', 'remove', '--force', validationRoot], {
          cwd: root,
          stdio: 'ignore',
        });
      }
      if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
      await releaseLock();
    }
  }
  if (runCapture('git', ['rev-parse', 'HEAD'], { cwd: root }) !== task.baseSha) {
    throw new Error('Current HEAD changed during isolated validation');
  }
  if (runCapture('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root })) {
    throw new Error('Current worktree changed during isolated validation');
  }
  runCapture('git', ['apply', '--check', patchPath], { cwd: root });
  runCapture('git', ['apply', patchPath], { cwd: root });
  process.stdout.write(
    `Validated and applied ${task.candidate.id}. Review the local diff, then commit and open a normal PR.\nEvidence: ${artifactRoot}\n`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
