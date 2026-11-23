export type SessionExec = (
  command: string,
  args: string[],
  workdir: string,
  isAI: boolean
) => Promise<string>;

/**
 * Why this is three states and not `string | null`:
 *
 * `git branch --show-current` prints nothing on a detached HEAD, and it also
 * prints nothing when the command never really ran (killed, spawn failure,
 * output dropped). Collapsing both into `null` made a transient exec failure
 * look like a deliberate detached checkout — which silently skipped PR
 * detection and left the session's recorded branch stale forever.
 *
 * A real detached HEAD still answers `HEAD` to `rev-parse --abbrev-ref`, so
 * "both probes came back empty" is a reliable marker for "git did not answer".
 */
export type GitBranchResolution =
  | { kind: 'branch'; branch: string }
  | { kind: 'detached' }
  | { kind: 'unresolved' };

const tryExecTrimmed = async (
  exec: SessionExec,
  command: string,
  args: string[],
  workdir: string
): Promise<string | null> => {
  try {
    const output = await exec(command, args, workdir, false);
    const trimmed = output.trim();
    return trimmed ? trimmed : null;
  } catch {
    return null;
  }
};

export const resolveGitBranch = async (
  exec: SessionExec,
  workdir: string
): Promise<GitBranchResolution> => {
  const current = await tryExecTrimmed(exec, 'git', ['branch', '--show-current'], workdir);
  if (current) {
    return { kind: 'branch', branch: current };
  }

  const abbrevRef = await tryExecTrimmed(
    exec,
    'git',
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    workdir
  );
  if (!abbrevRef) {
    return { kind: 'unresolved' };
  }
  if (abbrevRef === 'HEAD') {
    return { kind: 'detached' };
  }
  return { kind: 'branch', branch: abbrevRef };
};

/**
 * Branch name, or null when there is none to report (detached or unresolved).
 * Prefer {@link resolveGitBranch} when the two cases must behave differently.
 */
export const resolveGitBranchName = async (
  exec: SessionExec,
  workdir: string
): Promise<string | null> => {
  const resolution = await resolveGitBranch(exec, workdir);
  return resolution.kind === 'branch' ? resolution.branch : null;
};
