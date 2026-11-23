import { execFile } from 'node:child_process';

/** Keep Git output byte-exact; only no-index diff may accept exit code 1. */
export function git(root, args, { diff = false, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      // Full repository indexes exceed Node's 1 MiB default after native imports.
      { maxBuffer: 32 * 1024 * 1024, ...options, cwd: root, encoding: 'buffer' },
      (error, stdout, stderr) => {
        if (error && !(diff && error.code === 1 && !error.signal && !error.killed)) {
          // Preserve launch errors, exit code, signal, and captured diagnostics.
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
        } else {
          resolve(stdout);
        }
      }
    );
    child.stdin.end();
  });
}
