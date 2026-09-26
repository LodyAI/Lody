import { useRouter } from '@tanstack/react-router';
import { Button } from '@lody/ui/button';
import * as stylex from '@stylexjs/stylex';
import { ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAtomValue } from 'jotai';
import { currentWorkspaceSlugAtom } from '@/atoms';
import { StatusPage, StatusPageActions } from '@/components/status-page';

const styles = stylex.create({
  icon14: { flexShrink: 0, width: '14px', height: '14px' },
});

export interface SessionNotFoundProps {
  /** Optional callback when back button is clicked. If not provided, navigates to session list. */
  onBack?: () => void;
}

/** Displayed in the session pane when the session it was opened for cannot be found. */
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
    <StatusPage
      layout="pane"
      illustration="missing"
      title={t('sessions.notFound.title', "This session isn't here")}
      description={t(
        'sessions.notFound.description',
        'It may have been deleted, or the link that opened it is out of date.'
      )}
    >
      <StatusPageActions>
        <Button variant="secondary" size="small" onClick={handleBack}>
          <ArrowLeft {...stylex.props(styles.icon14)} aria-hidden="true" />
          {t('sessions.notFound.backToList', 'Back to sessions')}
        </Button>
      </StatusPageActions>
    </StatusPage>
  );
}
