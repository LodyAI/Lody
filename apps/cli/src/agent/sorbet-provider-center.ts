import { spawn } from 'node:child_process';

import {
  SorbetProviderCenterLocalOperationSchema,
  SorbetProviderCenterSnapshotSchema,
  type SorbetProviderCenterLocalOperation,
  type SorbetProviderCenterSnapshot,
} from '@lody/shared';

import { resolveBundledSorbetProviderControlLaunch } from './setting';

const OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
const OPERATION_TIMEOUT_MS = 30_000;

export type SorbetProviderCenterResult = {
  snapshot: SorbetProviderCenterSnapshot;
  affectedProviderId?: string;
};

let operationQueue: Promise<void> = Promise.resolve();

export function runSorbetProviderCenterOperation(
  input: SorbetProviderCenterLocalOperation
): Promise<SorbetProviderCenterResult> {
  const operation = SorbetProviderCenterLocalOperationSchema.parse(input);
  const result = operationQueue.then(() => runControlProcess(operation));
  operationQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

async function runControlProcess(
  operation: SorbetProviderCenterLocalOperation
): Promise<SorbetProviderCenterResult> {
  const launch = resolveBundledSorbetProviderControlLaunch();
  return await new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      env: { ...process.env, ...launch.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error('Sorbet Provider Center timed out')));
    }, OPERATION_TIMEOUT_MS);
    timeout.unref?.();
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes <= OUTPUT_LIMIT_BYTES) stdout.push(chunk);
      else child.kill();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= OUTPUT_LIMIT_BYTES) stderr.push(chunk);
    });
    child.on('error', (error) => finish(() => reject(error)));
    child.on('exit', (code) => {
      finish(() => {
        if (stdoutBytes > OUTPUT_LIMIT_BYTES) {
          reject(new Error('Sorbet Provider Center returned too much data'));
          return;
        }
        if (code !== 0) {
          const message = Buffer.concat(stderr).toString('utf8').trim();
          reject(new Error(message || `Sorbet Provider Center exited with status ${code}`));
          return;
        }
        try {
          const parsed = JSON.parse(Buffer.concat(stdout).toString('utf8')) as {
            snapshot?: unknown;
            affectedProviderId?: unknown;
          };
          const snapshot = SorbetProviderCenterSnapshotSchema.parse(parsed.snapshot);
          const affectedProviderId =
            typeof parsed.affectedProviderId === 'string' && parsed.affectedProviderId.length > 0
              ? parsed.affectedProviderId
              : undefined;
          resolve({ snapshot, ...(affectedProviderId ? { affectedProviderId } : {}) });
        } catch (error) {
          reject(error);
        }
      });
    });
    child.stdin.end(JSON.stringify(operation));
  });
}
