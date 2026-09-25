import { useRouter } from '@tanstack/react-router';
import { Button } from '@lody/ui/button';
import { ArrowLeft, MessageSquareOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAtomValue } from 'jotai';
import { currentWorkspaceSlugAtom } from '@/atoms';

export interface SessionNotFoundProps {
  /** Optional callback when back button is clicked. If not provided, navigates to session list. */
  onBack?: () => void;
}

/**
 * Displayed when a session cannot be found.
 * Provides a friendly message and navigation options.
 */
export function SessionNotFound({ onBack }: SessionNotFoundProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const workspaceSlug = useAtomValue(currentWorkspaceSlugAtom);

  const handleBack = () => {
    if (onBack) {
      onBack();
      return;
    }
    if (workspaceSlug) {
      void router.navigate({
        to: '/$workspaceName/chat',
        params: { workspaceName: workspaceSlug },
      });
    } else {
      void router.navigate({ to: '/' });
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-background">
      <div className="max-w-md px-6 text-center">
        <div className="mb-6 flex justify-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-muted">
            <MessageSquareOff className="h-10 w-10 text-muted-foreground" />
          </div>
        </div>

        <h2 className="mb-3 text-xl font-semibold text-foreground">
          {t('sessions.notFound.title', 'Session Not Found')}
        </h2>

        <p className="mb-6 text-sm text-muted-foreground">
          {t(
            'sessions.notFound.description',
            'The session you are looking for does not exist or may have been deleted.'
          )}
        </p>

        <Button onClick={handleBack} variant="secondary">
          <ArrowLeft className="h-4 w-4" />
          {t('sessions.notFound.backToList', 'Back to Sessions')}
        </Button>
      </div>
    </div>
  );
}
