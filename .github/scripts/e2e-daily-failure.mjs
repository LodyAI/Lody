#!/usr/bin/env node

import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_FAILURE_INDEX_ENTRIES = 500;
export const MAX_FAILURE_INDEX_BYTES = 1024 * 1024;
export const MAX_VIDEO_BYTES = 10 * 1024 * 1024;

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith('--')) throw new Error(`Unexpected argument: ${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    values.set(name.slice(2), value);
    index += 1;
  }
  for (const required of ['evidence-root', 'output-root', 'run-id', 'run-url', 'head-sha']) {
    if (!values.has(required)) throw new Error(`--${required} is required`);
  }
  return Object.fromEntries(values);
}

function isInside(parent, child) {
  const candidate = relative(parent, child);
  return candidate === '' || (candidate !== '..' && !candidate.startsWith(`..${sep}`));
}

function portablePath(path) {
  return path.split(sep).join('/');
}

function markdownText(value, limit = 240) {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('`', "'")
    .replaceAll('|', '\\|')
    .replaceAll('\r', ' ')
    .replaceAll('\n', ' ')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .slice(0, limit);
}

async function readFailureIndex(evidenceRoot) {
  const indexPath = resolve(evidenceRoot, 'failure-index.json');
  let stat;
  try {
    stat = await lstat(indexPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { entries: [], problem: 'failure-index.json is missing' };
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('failure-index.json must be a regular file');
  }
  if (stat.size > MAX_FAILURE_INDEX_BYTES) {
    throw new Error(`failure-index.json exceeds ${MAX_FAILURE_INDEX_BYTES} bytes`);
  }
  const value = JSON.parse(await readFile(indexPath, 'utf8'));
  if (!Array.isArray(value)) throw new Error('failure-index.json must contain an array');
  if (value.length > MAX_FAILURE_INDEX_ENTRIES) {
    throw new Error(`failure-index.json exceeds ${MAX_FAILURE_INDEX_ENTRIES} entries`);
  }
  return { entries: value, problem: null };
}

function validateFailureEntry(entry, seen) {
  if (!entry || typeof entry !== 'object') throw new Error('Invalid failure-index entry');
  const { stableId, path } = entry;
  if (typeof stableId !== 'string' || !/^LODY-[A-Z0-9-]+-\d{3}$/u.test(stableId)) {
    throw new Error('Invalid failure-index stableId');
  }
  const expectedPath = `scenarios/${stableId.toLowerCase()}`;
  if (path !== expectedPath) throw new Error(`Invalid failure-index path for ${stableId}`);
  if (seen.has(stableId)) return null;
  seen.add(stableId);
  return { stableId, path };
}

async function pathContainsSymlink(root, target) {
  let current = root;
  for (const segment of relative(root, target).split(sep)) {
    current = join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) return true;
  }
  return false;
}

export async function prepareDailyFailureReport({
  evidenceRoot,
  outputRoot,
  runId,
  runUrl,
  headSha,
  workingDirectory = process.cwd(),
  maxVideoBytes = MAX_VIDEO_BYTES,
  channel = 'daily',
  suite = 'full',
}) {
  if (!/^\d+$/u.test(String(runId))) throw new Error('runId must be numeric');
  if (
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d+$/u.test(runUrl)
  ) {
    throw new Error('runUrl must be a GitHub Actions run URL');
  }
  if (!/^[0-9a-f]{40}$/u.test(headSha)) throw new Error('headSha must be a full commit SHA');
  if (channel !== 'daily' && channel !== 'pr') throw new Error('channel must be daily or pr');
  if (channel === 'pr' && suite !== 'smoke' && suite !== 'full' && suite !== 'unknown') {
    throw new Error('PR suite must be smoke, full, or unknown');
  }

  const workspace = resolve(workingDirectory);
  const root = resolve(evidenceRoot);
  const reports = resolve(outputRoot);
  if (!isInside(workspace, root) || !isInside(workspace, reports)) {
    throw new Error('Evidence and report directories must stay inside the workspace');
  }
  await mkdir(root, { recursive: true });
  await mkdir(reports, { recursive: true });
  if ((await lstat(root)).isSymbolicLink() || (await lstat(reports)).isSymbolicLink()) {
    throw new Error('Evidence and report directories must not be symbolic links');
  }
  const canonicalRoot = await realpath(root);
  const { entries, problem } = await readFailureIndex(root);
  const seen = new Set();
  const failures = entries
    .map((entry) => validateFailureEntry(entry, seen))
    .filter((entry) => entry !== null);
  const videos = [];
  const omitted = problem ? [{ stableId: null, reason: problem }] : [];

  for (const failure of failures) {
    const videoPath = resolve(root, failure.path, 'failure.webm');
    if (!isInside(root, videoPath))
      throw new Error(`Video escaped evidence root: ${failure.stableId}`);
    let stat;
    try {
      stat = await lstat(videoPath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        omitted.push({ stableId: failure.stableId, reason: 'failure.webm is missing' });
        continue;
      }
      throw error;
    }
    if (!stat.isFile() || (await pathContainsSymlink(root, videoPath))) {
      omitted.push({ stableId: failure.stableId, reason: 'failure.webm is not a regular file' });
      continue;
    }
    const canonicalVideo = await realpath(videoPath);
    if (!isInside(canonicalRoot, canonicalVideo)) {
      omitted.push({
        stableId: failure.stableId,
        reason: 'failure.webm resolves outside evidence root',
      });
      continue;
    }
    if (stat.size === 0) {
      omitted.push({ stableId: failure.stableId, reason: 'failure.webm is empty' });
      continue;
    }
    if (stat.size > maxVideoBytes) {
      omitted.push({
        stableId: failure.stableId,
        reason: `failure.webm exceeds ${maxVideoBytes} bytes`,
      });
      continue;
    }
    const attachmentPath = portablePath(relative(workspace, videoPath));
    if (isAbsolute(attachmentPath) || attachmentPath.startsWith('../')) {
      throw new Error(`Video path is not workspace-relative: ${failure.stableId}`);
    }
    videos.push({ stableId: failure.stableId, path: attachmentPath, bytes: stat.size });
  }

  const groups = videos.length > 0 ? videos.map((video) => [video]) : [[]];
  const markerScope = channel === 'pr' ? 'desktop-e2e-pr-failure' : 'desktop-e2e-daily-failure';
  const subject =
    channel === 'pr'
      ? suite === 'unknown'
        ? 'Desktop PR regression'
        : `Desktop PR ${suite} regression`
      : 'Desktop Daily regression';
  const batches = [];
  for (let index = 0; index < groups.length; index += 1) {
    const batchNumber = index + 1;
    const bodyPath = resolve(reports, `comment-${String(batchNumber).padStart(3, '0')}.md`);
    const marker = groups[index][0]
      ? `<!-- ${markerScope}-run:${runId}:video:${groups[index][0].stableId} -->`
      : `<!-- ${markerScope}-run:${runId}:summary -->`;
    const lines = [
      marker,
      `${subject} failed on commit \`${markdownText(headSha, 40)}\`.`,
      '',
      `- Workflow run: ${runUrl}`,
      `- Failed scenarios indexed: ${failures.length}`,
      `- Recording: ${batchNumber}/${groups.length}`,
    ];
    for (const video of groups[index]) {
      lines.push('', `### \`${markdownText(video.stableId)}\``, '', `![](${video.path})`);
    }
    if (index === 0 && omitted.length > 0) {
      lines.push('', '### Recordings not attached');
      for (const entry of omitted) {
        const label = entry.stableId ? `\`${markdownText(entry.stableId)}\`` : 'Run evidence';
        lines.push(`- ${label}: ${markdownText(entry.reason)}`);
      }
    }
    lines.push(
      '',
      'The Actions artifact retains the complete trace, screenshots, logs, and runtime evidence.'
    );
    await writeFile(bodyPath, `${lines.join('\n')}\n`, { mode: 0o600 });
    batches.push({
      number: batchNumber,
      marker,
      bodyPath: portablePath(relative(workspace, bodyPath)),
      videos: groups[index].map((video) => video.path),
    });
  }

  const manifest = {
    schemaVersion: 1,
    runId: String(runId),
    runUrl,
    headSha,
    channel,
    suite,
    failures,
    videos,
    omitted,
    batches,
  };
  const manifestPath = resolve(reports, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { ...manifest, manifestPath };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await prepareDailyFailureReport({
    evidenceRoot: options['evidence-root'],
    outputRoot: options['output-root'],
    runId: options['run-id'],
    runUrl: options['run-url'],
    headSha: options['head-sha'],
    channel: options.channel,
    suite: options.suite,
  });
  process.stdout.write(`${report.manifestPath}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
