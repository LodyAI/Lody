import { createFileRoute, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useSetAtom } from 'jotai';
import { SchedulesWorkspace } from '@/components/schedules/schedules-workspace';
import { mobileHomeReturnTabAtom } from '@/atoms/mobile-home-state';
import { useIsMobile } from '@/hooks/use-mobile';

// One mount for the list and an open schedule: opening or closing a schedule
// only changes the param, so the side panel can animate in and out instead of
// the whole page remounting. On a phone the bare list is the home schedules
// tab, so this route only keeps the pushed editor.
export const Route = createFileRoute('/$workspaceName/_auth/schedules')({
  component: SchedulesLayout,
});

function SchedulesLayout() {
  const { workspaceName } = Route.useParams();
  const { scheduleId } = useParams({ strict: false }) as { scheduleId?: string };
  const mobile = useIsMobile();
  const navigate = useNavigate();
  const setReturnTab = useSetAtom(mobileHomeReturnTabAtom);
  const redirectHome = mobile && !scheduleId;

  useEffect(() => {
    if (!redirectHome) return;
    setReturnTab('schedules');
    void navigate({
      to: '/$workspaceName/chat',
      params: { workspaceName },
      replace: true,
    });
  }, [navigate, redirectHome, setReturnTab, workspaceName]);

  if (redirectHome) return null;
  return <SchedulesWorkspace scheduleId={scheduleId} insetSafeArea />;
}
