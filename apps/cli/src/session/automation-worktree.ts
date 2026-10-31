import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { SessionProjectRunSchema, resolveSessionFilePath, type SessionMeta } from '@lody/shared';
import type { AutomationOrigin } from '@lody/shared/automations';
import type { ISession } from './session-manager';
import { getCurrentCommitHash } from '@/lib/git/git-diff-stats';

/** Verify CI references against the executing checkout, after Session preparation and before prompt. */
export async function verifyAutomationWorktreeHeads(
  origin: AutomationOrigin | undefined,
  meta: SessionMeta | undefined,
  session: Pick<ISession, 'getWorkdir' | 'exec'>
): Promise<void> {
  if (!origin?.expectedHeads?.length) return;
  if (!meta) throw new Error('AUTOMATION_WORKTREE_UNAVAILABLE');
  const run = meta.projectRun ? SessionProjectRunSchema.parse(meta.projectRun) : undefined;
  const root = run ? await realpath(session.getWorkdir()) : session.getWorkdir();
  for (const expected of origin.expectedHeads) {
    let cwd = root;
    if (run) {
      const members = Object.values(run.members).filter(
        (member) =>
          (member.src.kind === 'github'
            ? member.src.repoFullName
            : member.repoFullName
          )?.toLowerCase() === expected.repository
      );
      const member = members[0];
      if (
        members.length !== 1 ||
        !member ||
        member.access === 'additional' ||
        member.access === 'link'
      )
        throw new Error('AUTOMATION_WORKTREE_UNAVAILABLE');
      cwd = await realpath(path.join(root, member.path));
      const resolved = resolveSessionFilePath([{ id: 'main', absolutePath: root }], cwd);
      if (!resolved || resolved.relativePath !== member.path)
        throw new Error('AUTOMATION_WORKTREE_UNAVAILABLE');
    } else if (origin.expectedHeads.length !== 1)
      throw new Error('AUTOMATION_WORKTREE_UNAVAILABLE');
    const head = await getCurrentCommitHash((args) => session.exec('git', args, cwd, false));
    if (head !== expected.headSha) throw new Error('AUTOMATION_WORKTREE_HEAD_CHANGED');
  }
}
