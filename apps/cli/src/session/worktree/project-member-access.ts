import { realpathSync, lstatSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { lstat, realpath, stat, symlink, unlink, readdir } from 'node:fs/promises';
import {
  getProjectMemberRootId,
  resolveSessionFilePath,
  SessionFileRootIdSchema,
  MAIN_SESSION_FILE_ROOT_ID,
  type LocalProjectId,
  type SessionFileRoot,
  type SessionProjectRun,
} from '@lody/shared';

export type ProjectLocalRootResolver = (id: LocalProjectId) => Promise<string | null>;

async function readEntry(pathname: string) {
  try {
    return await lstat(pathname);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Resolve authority from the registration, never from a member link or persisted absolute path. */
export async function resolveProjectFileRoots(
  main: string,
  run: SessionProjectRun | undefined,
  machineId: string,
  resolveLocalRoot: ProjectLocalRootResolver,
  onUnavailable?: (memberId: string, error: unknown) => void,
  repairLinks = true
): Promise<SessionFileRoot[]> {
  const roots: SessionFileRoot[] = [
    { id: MAIN_SESSION_FILE_ROOT_ID, absolutePath: await realpath(main) },
  ];
  for (const [id, member] of Object.entries(run?.members ?? {})) {
    if (member.access !== 'additional' && member.access !== 'link') continue;
    try {
      if (
        member.src.kind !== 'local' ||
        member.src.machineId !== machineId ||
        member.placement.kind !== 'root'
      )
        throw new Error('Invalid project group directory member');
      const registered = await resolveLocalRoot(member.src.localProjectId);
      if (!registered) throw new Error('Project group directory member is unavailable');
      const absolutePath = await realpath(registered);
      if (!(await stat(absolutePath)).isDirectory())
        throw new Error('Project group member is not a directory');
      roots.push({ id: getProjectMemberRootId(id), absolutePath });
      if (repairLinks && member.access === 'link')
        await reconcileProjectMemberLink(
          roots[0]!.absolutePath,
          member.placement.dir,
          absolutePath,
          false
        );
    } catch (error) {
      if (!onUnavailable) throw error;
      onUnavailable(id, error);
    }
  }
  return roots;
}

/** Preserve real entries on collision. Never follow or recursively remove a member link. */
export async function reconcileProjectMemberLink(
  main: string,
  name: string,
  target: string,
  additional: boolean
): Promise<void> {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\'))
    throw new Error('Invalid project group member directory');
  const canonicalTarget = await realpath(target);
  if (!(await stat(canonicalTarget)).isDirectory())
    throw new Error('Project group member is not a directory');
  const link = path.join(main, name);
  const current = await readEntry(link);
  if (current && !current.isSymbolicLink()) {
    if (additional) return;
    throw new Error('Project group member directory conflicts with a real entry');
  }
  if (current) {
    let correct = false;
    try {
      correct = (await realpath(link)) === canonicalTarget;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (correct && !additional) return;
    try {
      await unlink(link);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (!additional) {
    try {
      await symlink(canonicalTarget, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
        (await realpath(link)) !== canonicalTarget
      )
        throw error;
    }
  }
}

/** Archive removes only known links; unknown symlinks prevent recursive group cleanup. */
export async function removeProjectMemberLinks(
  main: string,
  run: SessionProjectRun
): Promise<void> {
  for (const member of Object.values(run.members)) {
    if (member.access !== 'additional' && member.access !== 'link') continue;
    if (member.placement.kind !== 'root') throw new Error('Invalid directory member placement');
    const link = path.join(main, member.placement.dir);
    const current = await readEntry(link);
    if (!current) continue;
    if (!current.isSymbolicLink()) {
      if (member.access === 'additional') continue;
      throw new Error('Directory member replaced by a real entry; preserving it');
    }
    await unlink(link);
  }
  const check = async (directory: string): Promise<void> => {
    for (const child of await readdir(directory, { withFileTypes: true })) {
      if (child.isSymbolicLink())
        throw new Error('Project group still contains a symlink; preserving it');
      if (child.isDirectory()) await check(path.join(directory, child.name));
    }
  };
  await check(main);
}

/** Deleted/new files resolve through their nearest existing parent; other IO errors stay visible. */
function realPathOrMissingChild(target: string, links = new Set<string>()): string {
  try {
    return realpathSync.native(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    let link: string | undefined;
    try {
      if (lstatSync(target).isSymbolicLink()) link = readlinkSync(target);
    } catch (entryError) {
      if ((entryError as NodeJS.ErrnoException).code !== 'ENOENT') throw entryError;
    }
    if (link !== undefined) {
      if (links.has(target)) throw new Error('Cyclic session file link', { cause: error });
      links.add(target);
      const destination = path.isAbsolute(link)
        ? link
        : `${path.dirname(target)}${path.sep}${link}`;
      return realPathOrMissingChild(destination, links);
    }
    const parent = path.dirname(target);
    if (parent === target) throw error;
    return path.join(realPathOrMissingChild(parent, links), path.basename(target));
  }
}

export function resolveProjectFileTarget(
  roots: readonly SessionFileRoot[],
  requestedPath: string,
  rootId = MAIN_SESSION_FILE_ROOT_ID
) {
  if (!SessionFileRootIdSchema.safeParse(rootId).success || requestedPath.includes('\0'))
    return undefined;
  const root = roots.find((entry) => entry.id === rootId);
  if (!root) return undefined;
  const candidate = path.isAbsolute(requestedPath)
    ? requestedPath
    : `${root.absolutePath}${path.sep}${requestedPath}`;
  const absolutePath = realPathOrMissingChild(candidate);
  const canonicalRoots = roots.map((entry) => ({
    ...entry,
    absolutePath: realPathOrMissingChild(entry.absolutePath),
  }));
  const parsed = resolveSessionFilePath(canonicalRoots, absolutePath);
  return parsed ? { ...parsed, absolutePath } : undefined;
}
