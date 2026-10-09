import { useTranslation } from 'react-i18next';
import { Alert } from '@lody/ui/alert';
import { Button } from '@lody/ui/button';
import { GITHUB_REPOSITORY_CONNECTION_GUIDANCE } from '@/lib/github-pr-details-state';

export function GitHubReviewErrorNotice({
  message,
  onRetry,
  onOpenGitHubSettings,
}: {
  message: string;
  onRetry: () => void;
  onOpenGitHubSettings?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Alert.Root tone="warning">
      <Alert.Description>
        {onOpenGitHubSettings
          ? t('sessions.prTab.repositoryIdentityUnresolved', GITHUB_REPOSITORY_CONNECTION_GUIDANCE)
          : message}
      </Alert.Description>
      <Alert.Actions>
        {onOpenGitHubSettings && (
          <Button variant="secondary" size="small" onClick={onOpenGitHubSettings}>
            {t('sessions.prTab.openGitHubSettings', 'Open GitHub settings')}
          </Button>
        )}
        <Button variant="secondary" size="small" onClick={onRetry}>
          {t('sessions.prTab.retry', 'Retry')}
        </Button>
      </Alert.Actions>
    </Alert.Root>
  );
}
