import { useTranslation } from 'react-i18next';
import { parseGitHubPullRequestUrl, type SessionPullRequestMeta } from '@lody/shared';
import { Button } from '@lody/ui/button';
import * as stylex from '@stylexjs/stylex';
import { Popover } from '@/ui/armed-overlays';
import { openExternalUrl } from '@/lib/native-browser';
import { PR_STATUS_META } from '@/components/sessions/pull-request-badge';
import { SessionPrIcon } from '@/components/sidebar-row-shared';
import { sidebarSurface } from '@/components/sidebar-surface';

const styles = stylex.create({
  alignment: { display: 'inline-flex', transform: 'translateY(3.5px)' },
});

/** Each URL is an independent PR; the metadata does not describe a stack. */
export function SidebarPullRequests({
  pullRequests,
  alignWithBranch = false,
}: {
  pullRequests: readonly SessionPullRequestMeta[];
  alignWithBranch?: boolean;
}) {
  const { t } = useTranslation();
  if (!pullRequests.length) return null;
  const first = pullRequests[0]!;
  const firstNumber = parseGitHubPullRequestUrl(first.url)?.prNumber;
  if (pullRequests.length === 1) {
    return (
      <span {...stylex.props(alignWithBranch && styles.alignment)}>
        <Button
          variant="link"
          aria-label={
            firstNumber
              ? t('sessions.pr.sidebarOpenNumber', 'Open pull request #{{number}}', {
                  number: firstNumber,
                })
              : t('sessions.pr.sidebarOpen', 'Open pull request')
          }
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void openExternalUrl(first.url);
          }}
        >
          <SessionPrIcon compact prStatus={first.status ?? 'open'} />
          <span {...stylex.props(sidebarSurface.meta)}>{firstNumber ? `#${firstNumber}` : 'PR'}</span>
        </Button>
      </span>
    );
  }
  const label = t('sessions.pr.sidebarCount', '{{count}} pull requests', {
    count: pullRequests.length,
  });
  return (
    <span {...stylex.props(alignWithBranch && styles.alignment)}>
      <Popover.Root>
        <Popover.Trigger
          render={
            <Button variant="link" aria-label={label} onClick={(event) => event.stopPropagation()}>
              <span {...stylex.props(sidebarSurface.meta)}>PR ×{pullRequests.length}</span>
            </Button>
          }
        />
        <Popover.Content side="right" align="start" onClick={(event) => event.stopPropagation()}>
          {pullRequests.map((pr) => {
            const meta = PR_STATUS_META[pr.status ?? 'open'] ?? PR_STATUS_META.open;
            const parsed = parseGitHubPullRequestUrl(pr.url);
            const name = parsed
              ? `${parsed.repoFullName}/#${parsed.prNumber}`
              : t('sessions.pr.sidebarUnknown', 'Pull request');
            return (
              <Button
                key={pr.url}
                size="small"
                variant="ghost"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void openExternalUrl(pr.url);
                }}
              >
                <SessionPrIcon compact prStatus={pr.status ?? 'open'} />
                {name} · {t(meta.labelKey, meta.labelFallback)}
              </Button>
            );
          })}
        </Popover.Content>
      </Popover.Root>
    </span>
  );
}
