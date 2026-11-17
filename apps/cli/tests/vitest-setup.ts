import path from 'node:path';
import { afterEach, vi } from 'vitest';

const hasManagedSessionBinSegment = (entry: string): boolean =>
  entry.split(/[\\/]+/).includes('gh-session-bin');

// When Vitest runs inside a Lody session, the outer session prepends its
// `gh-session-bin/<hash>` Node `git` wrapper to PATH. Unit tests must invoke
// native `git` unless a test explicitly injects its own transport directory.
if (process.env.PATH) {
  process.env.PATH = process.env.PATH.split(path.delimiter)
    .filter((entry) => entry.length > 0 && !hasManagedSessionBinSegment(entry))
    .join(path.delimiter);
}

if (process.env.GIT_EXEC_PATH && hasManagedSessionBinSegment(process.env.GIT_EXEC_PATH)) {
  delete process.env.GIT_EXEC_PATH;
}

// Vitest 5 retains called vi.fn instances until their histories are cleared.
// Release per-test fixture arguments in both shared and isolated workers.
afterEach(() => {
  vi.clearAllMocks();
});
