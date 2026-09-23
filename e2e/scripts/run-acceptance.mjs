import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';

const SCENARIOS = {
  onboarding: {
    id: 'LODY-ONBOARDING-001',
    question:
      'Does a clean real desktop reach an editable local workspace without cloud access or Agent configuration?',
  },
  session: {
    id: 'LODY-SESSION-001',
    question: 'Does stopping and deleting a real ACP Session release its Agent process?',
  },
  review: {
    id: 'LODY-REVIEW-001',
    question: 'Can a user inspect, switch, hide, restore, and close large local diffs?',
  },
  work: {
    id: 'LODY-WORK-001',
    question:
      'Does deleting a worktree Session release its ACP process, Terminal, and worktree directory?',
  },
};

const SUBJECTS = {
  'desktop-local-bootstrap': {
    tags: '@LODY-ONBOARDING-001',
    requirement:
      'A clean OSS desktop starts its bundled CLI, provisions the local workspace, and enters the product without Agent configuration.',
    scenarios: [SCENARIOS.onboarding],
  },
  'desktop-session-lifecycle': {
    tags: '@LODY-SESSION-001',
    requirement: 'A stopped and deleted Session releases its deterministic ACP runtime.',
    scenarios: [SCENARIOS.session],
  },
  'desktop-review-lifecycle': {
    tags: '@LODY-REVIEW-001',
    requirement: 'Large local diffs remain usable through Review open, switch, hide, and close.',
    scenarios: [SCENARIOS.review],
  },
  'desktop-work-lifecycle': {
    tags: '@LODY-WORK-001',
    requirement:
      'Permanent Work deletion releases the ACP process, Terminal, and generated worktree.',
    scenarios: [SCENARIOS.work],
  },
  'desktop-lifecycle': {
    tags: '@P0 or @P1',
    requirement:
      'The real OSS desktop satisfies bootstrap, Session, Review, and Work lifecycle acceptance checks.',
    scenarios: Object.values(SCENARIOS),
  },
};

function readSingleOption(argv, name) {
  const positions = argv.flatMap((value, index) => (value === name ? [index] : []));
  if (positions.length > 1) throw new Error(`Acceptance ${name} may be provided only once`);
  if (positions.length === 0) return undefined;
  const value = argv[positions[0] + 1];
  if (!value || value.startsWith('--')) throw new Error(`Acceptance ${name} requires a value`);
  return value;
}

function readOptions(argv) {
  const subject = readSingleOption(argv, '--subject') ?? 'desktop-local-bootstrap';
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/u.test(subject) || !(subject in SUBJECTS)) {
    throw new Error(`Acceptance --subject must be one of: ${Object.keys(SUBJECTS).join(', ')}`);
  }
  const before = readSingleOption(argv, '--before');
  const after = readSingleOption(argv, '--after');
  const retainedPath = readSingleOption(argv, '--retained-path');
  if (Boolean(before) !== Boolean(after)) {
    throw new Error('Acceptance --before and --after must be provided together');
  }
  return { subject, before, after, retainedPath };
}

function validateInput(path, kind, maxBytes, parseJson) {
  if (!path) return undefined;
  const absolutePath = resolve(path);
  const stat = statSync(absolutePath);
  if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes) {
    throw new Error(`${kind} must be a non-empty file no larger than ${maxBytes} bytes`);
  }
  if (parseJson) JSON.parse(readFileSync(absolutePath, 'utf8'));
  return absolutePath;
}

function scenarioEvidence(scenario) {
  const directory = `scenarios/${scenario.id.toLowerCase()}`;
  return [
    `${directory}/checkpoint.png`,
    `${directory}/runtime.json`,
    `${directory}/cli-backlog.json`,
    `${directory}/trace.zip`,
  ];
}

function listFiles(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(root, path) : [path];
  });
}

function describeFile(root, path) {
  const stat = statSync(path);
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = openSync(path, 'r');
  try {
    let bytesRead;
    do {
      bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    closeSync(fd);
  }
  return {
    path: relative(root, path),
    bytes: stat.size,
    sha256: hash.digest('hex'),
  };
}

const packageManagerEntry = process.env.npm_execpath;
if (!packageManagerEntry || !/\.(?:cjs|mjs|js)$/iu.test(packageManagerEntry)) {
  throw new Error('Run acceptance through pnpm so the package manager entry is explicit');
}

const options = readOptions(process.argv.slice(2));
const beforeInput = validateInput(options.before, 'Before evidence', 16 * 1024 * 1024, true);
const afterInput = validateInput(options.after, 'After evidence', 16 * 1024 * 1024, true);
const retainedPathInput = validateInput(
  options.retainedPath,
  'Retained-path evidence',
  4 * 1024 * 1024,
  false
);
const subject = SUBJECTS[options.subject];
const startedAt = new Date().toISOString();
const roundId = `${startedAt.replace(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}`;
const acceptanceRoot = join(process.cwd(), 'artifacts', 'acceptance');
mkdirSync(acceptanceRoot, { recursive: true });
const roundDir = join(acceptanceRoot, roundId);
mkdirSync(roundDir, { recursive: false });

const suppliedEvidence = {};
if (beforeInput && afterInput) {
  const evidenceDir = join(roundDir, 'evidence');
  mkdirSync(evidenceDir);
  copyFileSync(beforeInput, join(evidenceDir, 'before.json'));
  copyFileSync(afterInput, join(evidenceDir, 'after.json'));
  suppliedEvidence.before = 'evidence/before.json';
  suppliedEvidence.after = 'evidence/after.json';
}
if (retainedPathInput) {
  const evidenceDir = join(roundDir, 'evidence');
  mkdirSync(evidenceDir, { recursive: true });
  copyFileSync(retainedPathInput, join(evidenceDir, 'retained-path.txt'));
  suppliedEvidence.retainedPath = 'evidence/retained-path.txt';
}

const result = spawnSync(
  process.execPath,
  [packageManagerEntry, 'exec', 'cucumber-js', '--config', 'cucumber.mjs', '--tags', subject.tags],
  {
    cwd: process.cwd(),
    env: { ...process.env, LODY_ACCEPTANCE_ROUND_ID: roundId },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  }
);

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
writeFileSync(
  join(roundDir, 'command.log'),
  `${result.stdout ?? ''}${result.stderr ?? ''}`,
  'utf8'
);

const checks = subject.scenarios.map((scenario) => ({
  id: scenario.id.toLowerCase(),
  question: scenario.question,
  evidence: scenarioEvidence(scenario),
}));
const declaredEvidence = [
  ...checks.flatMap((check) => check.evidence),
  ...Object.values(suppliedEvidence),
];
const missingEvidence = declaredEvidence.filter((path) => {
  const absolutePath = join(roundDir, path);
  return (
    !existsSync(absolutePath) ||
    !statSync(absolutePath).isFile() ||
    statSync(absolutePath).size === 0
  );
});
const status = result.status === 0 && missingEvidence.length === 0 ? 'ready_for_review' : 'failed';
const report = {
  schemaVersion: 2,
  roundId,
  subject: options.subject,
  requirement: subject.requirement,
  status,
  startedAt,
  completedAt: new Date().toISOString(),
  immutable: true,
  tags: subject.tags,
  checks,
  suppliedEvidence,
  missingEvidence,
};
writeFileSync(join(roundDir, 'result.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

const manifestFiles = listFiles(roundDir)
  .filter((path) => relative(roundDir, path) !== 'manifest.json')
  .map((path) => describeFile(roundDir, path))
  .sort((left, right) => left.path.localeCompare(right.path));
writeFileSync(
  join(roundDir, 'manifest.json'),
  `${JSON.stringify({ schemaVersion: 1, roundId, files: manifestFiles }, null, 2)}\n`,
  'utf8'
);

console.log(`Acceptance round: ${roundDir}`);
if (missingEvidence.length > 0) {
  console.error(`Acceptance evidence missing: ${missingEvidence.join(', ')}`);
}
process.exit(result.status === 0 && missingEvidence.length === 0 ? 0 : (result.status ?? 1));
