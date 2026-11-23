import fs from 'node:fs';
import { randomBytes } from 'node:crypto';

/** Publish a complete owner-only credential file, including when replacing legacy permissions. */
export function writePrivateCredentialFile(file: string, contents: string): void {
  if (process.platform === 'win32') {
    fs.writeFileSync(file, contents);
    return;
  }
  const temporary = `${file}.${randomBytes(16).toString('hex')}.tmp`;
  // Exclusive creation avoids following an existing symlink or reusing its permissions.
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(descriptor, contents, 'utf8');
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
