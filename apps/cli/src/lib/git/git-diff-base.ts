/** PR comparisons prefer the tracking branch even when checkout metadata stored
 * a qualified local ref. Checkout identity and compare freshness are separate.
 *
 * Without a preferred branch the remote's default branch (`origin/HEAD`) comes
 * before the conventional names: a repository whose default is `develop` may keep
 * a long-abandoned `main`, and comparing against it reports years of history as
 * the session's changes. Callers pass `undefined`, never an assumed `main`. */
export function gitDiffBaseRefCandidates(preferredBaseBranch?: string): string[] {
  const preferred = preferredBaseBranch?.trim();
  const refs: string[] = [];
  if (preferred?.startsWith('refs/remotes/')) {
    refs.push(preferred);
  } else if (preferred) {
    const branch = preferred.startsWith('refs/heads/')
      ? preferred.slice('refs/heads/'.length)
      : preferred;
    refs.push(`origin/${branch}`, preferred);
  }
  return [...new Set([...refs, 'origin/HEAD', 'origin/main', 'main', 'origin/master', 'master'])];
}
