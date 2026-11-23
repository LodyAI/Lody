#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const MAX_FRAMES = 600;
const FRAME_RATE = 5;

export function selectTraceFrames(names, maximum = MAX_FRAMES) {
  const frames = names
    .map((name) => {
      const match = /^page@.+-(\d+)\.jpeg$/u.exec(name);
      return match ? { name, timestamp: Number(match[1]) } : null;
    })
    .filter((frame) => frame !== null)
    .sort((left, right) => left.timestamp - right.timestamp || left.name.localeCompare(right.name));
  if (frames.length <= maximum) return frames.map((frame) => frame.name);
  return Array.from({ length: maximum }, (_unused, index) => {
    const sourceIndex = Math.round((index * (frames.length - 1)) / (maximum - 1));
    return frames[sourceIndex].name;
  });
}

export function resolvePlaywrightFfmpeg() {
  if (process.env.LODY_E2E_FFMPEG_PATH) return resolve(process.env.LODY_E2E_FFMPEG_PATH);
  const require = createRequire(import.meta.url);
  const testPackage = dirname(require.resolve('@playwright/test/package.json'));
  const playwrightPackage = require.resolve('playwright/package.json', { paths: [testPackage] });
  const corePackage = require.resolve('playwright-core/package.json', {
    paths: [dirname(playwrightPackage)],
  });
  const { registry } = require(join(dirname(corePackage), 'lib/server/registry/index.js'));
  return registry.findExecutable('ffmpeg').executablePathOrDie();
}

async function run(command, args) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const [code, signal] = await once(child, 'close');
  if (code !== 0) {
    throw new Error(
      `${command} exited with ${code ?? signal}: ${Buffer.concat(stderr).toString('utf8').slice(-4000)}`
    );
  }
  return Buffer.concat(stdout).toString('utf8');
}

async function encodeFrames(ffmpegPath, framePaths, outputPath) {
  const temporaryOutput = `${outputPath}.tmp`;
  const child = spawn(
    ffmpegPath,
    [
      '-loglevel',
      'error',
      '-f',
      'image2pipe',
      '-framerate',
      String(FRAME_RATE),
      '-vcodec',
      'mjpeg',
      '-i',
      'pipe:0',
      '-vf',
      'scale=640:-2',
      '-an',
      '-c:v',
      'libvpx',
      '-b:v',
      '350k',
      '-deadline',
      'realtime',
      '-cpu-used',
      '8',
      '-f',
      'webm',
      '-y',
      temporaryOutput,
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] }
  );
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  for (const framePath of framePaths) {
    if (!child.stdin.write(await readFile(framePath))) await once(child.stdin, 'drain');
  }
  child.stdin.end();
  const [code, signal] = await once(child, 'close');
  if (code !== 0) {
    await rm(temporaryOutput, { force: true });
    throw new Error(
      `ffmpeg exited with ${code ?? signal}: ${Buffer.concat(stderr).toString('utf8').slice(-4000)}`
    );
  }
  await rename(temporaryOutput, outputPath);
}

export async function renderFailureVideos({
  artifactRoot,
  ffmpegPath = resolvePlaywrightFfmpeg(),
}) {
  const root = resolve(artifactRoot);
  let failures;
  try {
    failures = JSON.parse(await readFile(join(root, 'failure-index.json'), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  if (!Array.isArray(failures)) throw new Error('failure-index.json must contain an array');

  const rendered = [];
  const seen = new Set();
  for (const failure of failures) {
    const stableId = failure?.stableId;
    const expectedPath =
      typeof stableId === 'string' ? `scenarios/${stableId.toLowerCase()}` : undefined;
    if (
      typeof stableId !== 'string' ||
      !/^LODY-[A-Z0-9-]+-\d{3}$/u.test(stableId) ||
      failure.path !== expectedPath ||
      seen.has(stableId)
    ) {
      continue;
    }
    seen.add(stableId);
    const scenarioDirectory = join(root, failure.path);
    const tracePath = join(scenarioDirectory, 'trace.zip');
    const extractionRoot = await mkdtemp(join(tmpdir(), 'lody-trace-video-'));
    try {
      await run('unzip', ['-q', tracePath, '-d', extractionRoot]);
      const resources = join(extractionRoot, 'resources');
      const frames = selectTraceFrames(await readdir(resources));
      if (frames.length === 0) throw new Error(`${stableId} trace contains no screenshot frames`);
      const outputPath = join(scenarioDirectory, 'failure.webm');
      await encodeFrames(
        ffmpegPath,
        frames.map((frame) => join(resources, frame)),
        outputPath
      );
      rendered.push({ stableId, frameCount: frames.length, outputPath });
      console.log(`[e2e] ${stableId}: rendered ${frames.length} trace frames to failure.webm`);
    } catch (error) {
      console.error(`[e2e] ${stableId}: failure video was not rendered`, error);
    } finally {
      await rm(extractionRoot, { recursive: true, force: true });
    }
  }
  return rendered;
}

async function main() {
  const artifactRoot = process.argv[2] ?? 'artifacts';
  await renderFailureVideos({ artifactRoot });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
