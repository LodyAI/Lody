import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const labRoot = join(here, '..');

export const REPRO_FORMAT = 'e2ee-lab-repro/v1';
export const REPRO_SCENARIO_COLLAB = 'collab-v1';
export const REPRO_SCENARIO_DEFECT = 'defect-v1';

export interface ImplementationIdentity {
  readonly head: string;
  readonly dirtyTree: string | null;
  readonly node: string;
  readonly platform: string;
  readonly riverrun: string;
  readonly vendorSha256: string;
  readonly lockSha256: string | null;
}

export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

export function captureImplementationIdentity(
  cwd = join(labRoot, '../..')
): ImplementationIdentity {
  const head = git(['rev-parse', 'HEAD'], cwd).trim();
  const porcelain = git(['status', '--porcelain'], cwd);
  const diff = git(['diff'], cwd);
  const cached = git(['diff', '--cached'], cwd);
  const dirty = porcelain.trim().length > 0 || diff.length > 0 || cached.length > 0;
  let lockSha256: string | null = null;
  try {
    lockSha256 = sha256Hex(readFileSync(join(cwd, 'pnpm-lock.yaml')));
  } catch {
    lockSha256 = null;
  }
  let vendorSha256 = '';
  try {
    vendorSha256 = sha256Hex(readFileSync(join(labRoot, 'vendor/streams-crdt.tgz')));
  } catch {
    vendorSha256 = 'missing';
  }
  return {
    head,
    dirtyTree: dirty ? sha256Hex(`${porcelain}\n${diff}\n${cached}`) : null,
    node: process.version,
    platform: process.platform,
    riverrun: '0.3.0',
    vendorSha256,
    lockSha256,
  };
}

export function assertReplayEnvironment(expected: ImplementationIdentity): void {
  if (expected.riverrun !== '0.3.0') {
    throw new Error(`repro-unsupported-riverrun:${expected.riverrun}`);
  }
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isFinite(major) || major < 22) {
    throw new Error(`repro-unsupported-node:${process.version}`);
  }
}
