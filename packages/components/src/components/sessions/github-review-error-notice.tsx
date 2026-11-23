import { useTranslation } from 'react-i18next';
import { Alert } from '@lody/ui/alert';
import { Button } from '@lody/ui/button';

export function GitHubReviewErrorNotice({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Alert.Root tone="warning">
      <Alert.Description>{message}</Alert.Description>
      <Alert.Actions>
        <Button variant="secondary" size="small" onClick={onRetry}>
          {t('sessions.prTab.retry', 'Retry')}
        </Button>
      </Alert.Actions>
    </Alert.Root>
  );
}
