import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCloudMutation, useCloudQuery, usePlatformCapability } from '@lody/platform/react';
import { useStableSession } from '@/hooks/useStableSession';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { useAuthSignOut } from '../../providers/convex-provider';
import {
  WorkspaceJoinRequestPage,
  type WorkspaceJoinPageState,
} from './workspace-join-request-page';

export interface WorkspaceJoinRequestSurfaceProps {
  token: string;
  onSignInRequested: () => void;
  onWorkspaceRequested: (workspaceSlug: string | null) => void;
  onHomeRequested: () => void;
}

/**
 * Route-agnostic join-request flow for lightweight hosted entry points.
 *
 * Navigation stays with the host so this surface never imports the product
 * router, route tree, workspace runtime, or Flock document implementation.
 */
export function WorkspaceJoinRequestSurface({
  token,
  onSignInRequested,
  onWorkspaceRequested,
  onHomeRequested,
}: WorkspaceJoinRequestSurfaceProps) {
  const { t } = useTranslation();
  const signOut = useAuthSignOut();
  const { data: session, isPending: sessionPending } = useStableSession();
  const joinRequestsAvailable = usePlatformCapability('teamSharing');
  const preview = useCloudQuery(cloudOperations.workspaceJoinRequests.getLinkPreview, { token });
  const submitRequest = useCloudMutation(cloudOperations.workspaceJoinRequests.submitRequest);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const available = preview?.status === 'available' ? preview : null;
  let state: WorkspaceJoinPageState = 'loading';
  if (!joinRequestsAvailable || preview?.status === 'unavailable') state = 'unavailable';
  else if (available && !session?.user) state = 'auth_required';
  else if (available?.viewer?.alreadyMember) state = 'already_member';
  else if (available?.viewer && !available.viewer.emailVerified) state = 'verification_required';
  else if (available?.viewer?.request?.status === 'pending') state = 'pending';
  else if (available?.viewer?.request?.status === 'approved') state = 'approved';
  else if (available?.viewer?.request?.status === 'rejected') state = 'rejected';
  else if (available?.viewer) state = 'form';
  if (sessionPending) state = 'loading';
  if (submitting) state = 'submitting';
  if (errorMessage) state = 'error';

  useEffect(() => {
    if (available?.viewer?.request?.status === 'rejected' && !reason) {
      setReason(available.viewer.request.reason);
    }
  }, [available?.viewer?.request, reason]);

  return (
    <WorkspaceJoinRequestPage
      state={state}
      workspaceName={available?.workspaceName}
      currentEmail={session?.user?.email}
      reason={reason}
      errorMessage={errorMessage}
      onReasonChange={setReason}
      onContinue={onSignInRequested}
      onVerifyEmail={() => {
        void (async () => {
          await signOut();
          onSignInRequested();
        })();
      }}
      onSubmit={() => {
        void (async () => {
          setSubmitting(true);
          setErrorMessage(null);
          try {
            await submitRequest({ token, reason });
          } catch (error) {
            console.error('Failed to submit workspace join request:', error);
            setErrorMessage(t('joinRequest.submitFailed'));
          } finally {
            setSubmitting(false);
          }
        })();
      }}
      onOpenWorkspace={() => onWorkspaceRequested(available?.workspaceSlug ?? null)}
      onBackHome={onHomeRequested}
    />
  );
}
