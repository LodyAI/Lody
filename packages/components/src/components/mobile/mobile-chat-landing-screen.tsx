import type { ReactNode } from 'react';
import { PanelLeft } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { cn } from '@/lib/utils';

export type MobileChatLandingScreenProps = {
  title: string;
  contextSwitch?: ReactNode;
  composer: ReactNode;
  noMachineHint?: ReactNode;
  agentConfigHint?: ReactNode;
  onOpenMobileDrawer?: () => void;
};

export function MobileChatLandingScreen({
  title,
  contextSwitch,
  composer,
  noMachineHint,
  agentConfigHint,
  onOpenMobileDrawer,
}: MobileChatLandingScreenProps) {
  return (
    <div
      className={cn(
        'relative flex h-full w-full flex-col overflow-hidden',
        'bg-background text-foreground'
      )}
    >
      <div className="relative flex h-full w-full flex-col">
        <div className="relative flex items-center pb-2 pl-[calc(16px+var(--safe-area-left))] pr-[calc(16px+var(--safe-area-right))] pt-[calc(16px+var(--safe-area-top))]">
          <Button
            variant="ghost"
            size="large"
            icon
            className={cn('md:hidden')}
            onClick={onOpenMobileDrawer}
          >
            <PanelLeft className="size-4" />
            <span className="sr-only">Open sidebar</span>
          </Button>
          <span className="sr-only">{title}</span>
        </div>

        <div className="flex-1 overflow-auto pb-[calc(24px+env(safe-area-inset-bottom,0px))] pl-[calc(16px+env(safe-area-inset-left,0px))] pr-[calc(16px+env(safe-area-inset-right,0px))]">
          <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-4 py-6">
            <h1 className="text-3xl font-semibold text-foreground">{title}</h1>
            {contextSwitch}
            <div className="mt-2 w-full">
              {composer}
              {noMachineHint != null ? <div className="mt-2">{noMachineHint}</div> : null}
            </div>
            {agentConfigHint != null ? <div className="w-full">{agentConfigHint}</div> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
