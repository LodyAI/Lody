/** PR comparisons prefer the tracking branch even when checkout metadata stored
 * a qualified local ref. Checkout identity and compare freshness are separate. */
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
  return [...new Set([...refs, 'origin/main', 'main', 'origin/master', 'master', 'origin/HEAD'])];
}
