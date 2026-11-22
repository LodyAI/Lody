import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Publishes JSON durably: a 0600 temporary file, fsync, rename, then a directory fsync. */
export async function atomicJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, file);
  if (process.platform !== 'win32') {
    const directory = await fs.open(path.dirname(file), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
