import type { Stats } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  rename,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { MAGPIE_CODEX_SKILLS, normalizeMagpieGateway } from '@lody/shared';

export function magpieProfileDirectory(root: string, gateway: string, agent: string) {
  const key = createHash('sha256')
    .update(normalizeMagpieGateway(gateway))
    .digest('hex')
    .slice(0, 24);
  return join(root, key, agent);
}

export async function writeMagpieFile(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, typeof value === 'string' ? value : JSON.stringify(value), {
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function ifPresent<T>(operation: Promise<T>): Promise<T | undefined> {
  try {
    return await operation;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}

export async function codexMagpieSkillEntries(profile: string, home: string) {
  const skills = join(profile, 'skills');
  const parent = await ifPresent(lstat(skills));
  return Promise.all(
    MAGPIE_CODEX_SKILLS.map(async (name) => {
      const native = join(home, '.codex', 'skills', name);
      const destination = join(skills, name);
      const existing = await ifPresent(lstat(destination));
      return { name, native, destination, existing, writable: !parent || parent.isDirectory() };
    })
  );
}

// A user can replace a managed link with another link to the very same target.
function linkIdentity(link: Stats): string {
  return [link.dev, link.ino, link.birthtimeMs].join(':');
}

export async function syncCodexMagpieSkills(profile: string, home: string) {
  for (const entry of await codexMagpieSkillEntries(profile, home)) {
    if (!entry.writable) continue;
    const { name, native, destination, existing } = entry;
    const installed = (await ifPresent(stat(join(native, 'SKILL.md'))))?.isFile();
    const marker = join(profile, '.lody-linked-' + name);
    if (existing) {
      if (
        !installed &&
        existing.isSymbolicLink() &&
        (await ifPresent(lstat(marker)))?.isFile() &&
        (await ifPresent(readlink(destination))) === native &&
        (await ifPresent(readFile(marker, 'utf8'))) === linkIdentity(existing)
      ) {
        await rm(destination, { force: true });
        await rm(marker, { force: true });
      }
      continue;
    }
    if (!installed) continue;
    await mkdir(join(profile, 'skills'), { recursive: true });
    try {
      await symlink(native, destination, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    const created = await ifPresent(lstat(destination));
    if (created?.isSymbolicLink()) await writeMagpieFile(marker, linkIdentity(created));
  }
}
