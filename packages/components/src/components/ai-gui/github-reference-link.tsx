import { Children, isValidElement, type ReactNode } from 'react';
import { CircleDot, GitPullRequest } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export type GitHubReference = {
  kind: 'pull' | 'issue';
  owner: string;
  repo: string;
  number: number;
};

const GITHUB_REFERENCE_URL_PATTERN =
  /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)(?:[/?#].*)?$/i;

/** A github.com pull request or issue URL (any sub-page, query or fragment). */
export function parseGitHubReferenceUrl(href: string | undefined): GitHubReference | null {
  const match = href ? GITHUB_REFERENCE_URL_PATTERN.exec(href.trim()) : null;
  if (!match) return null;
  const [, owner, repo, section, number] = match;
  return {
    kind: section!.toLowerCase() === 'pull' ? 'pull' : 'issue',
    owner: owner!,
    repo: repo!,
    number: Number(number),
  };
}

/**
 * Whether a link's text only names the reference, so a chip can replace it
 * without losing words: the URL itself (an autolink), `#123`, `repo#123`,
 * `owner/repo#123`, or `PR #123` / `Issue #123`. A link with descriptive text
 * ("see the fix") stays an ordinary link.
 */
export function isGitHubReferenceLabel(label: string, reference: GitHubReference): boolean {
  const text = label.trim();
  if (!text) return false;
  const bareUrl = text.replace(/^https?:\/\/(?:www\.)?/i, '').replace(/\/$/, '');
  if (/^github\.com\//i.test(bareUrl)) {
    return parseGitHubReferenceUrl(`https://${bareUrl}`)?.number === reference.number;
  }
  const match =
    /^(?:(?:pr|pull request|issue)\s*)?(?:(?:[\w.-]+\/)?[\w.-]+)?#(\d+)$/i.exec(text) ?? null;
  return match !== null && Number(match[1]) === reference.number;
}

/** The plain text of a markdown link's children. */
export function markdownLinkText(children: ReactNode): string {
  let text = '';
  Children.forEach(children, (child) => {
    if (typeof child === 'string' || typeof child === 'number') {
      text += String(child);
    } else if (isValidElement<{ children?: ReactNode }>(child)) {
      text += markdownLinkText(child.props.children);
    }
  });
  return text;
}

/**
 * The inline body of a GitHub pull request / issue link: `[icon] owner/repo #123`.
 * The icon names the kind (pull request or issue); the kind is also spoken to
 * screen readers. The caller keeps the `<a>` (and its in-app PR interception)
 * and styles it as a link-blue chip (`markdown-reference-chip` in
 * `tailwind/index.css`); this only replaces the link text.
 */
export function GitHubReferenceChip({
  reference,
  className,
}: {
  reference: GitHubReference;
  className?: string;
}) {
  const { t } = useTranslation();
  const kindLabel =
    reference.kind === 'pull'
      ? t('sessions.githubReference.pullRequest', 'PR')
      : t('sessions.githubReference.issue', 'Issue');
  const KindIcon = reference.kind === 'pull' ? GitPullRequest : CircleDot;
  return (
    <span
      data-github-reference={reference.kind}
      className={cn('inline-flex max-w-full items-center gap-[0.35em] align-baseline', className)}
    >
      <KindIcon className="h-[0.95em] w-[0.95em] shrink-0 self-center" aria-hidden="true" />
      <span className="sr-only">{kindLabel} </span>
      <span className="min-w-0 truncate">
        {reference.owner}/{reference.repo}
      </span>
      <span className="shrink-0 font-medium tabular-nums">#{reference.number}</span>
    </span>
  );
}
