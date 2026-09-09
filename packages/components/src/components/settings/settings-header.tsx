import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { useRouter } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import { useAtomValue } from 'jotai';
import { currentWorkspaceSlugAtom } from '@/atoms';

interface SettingsHeaderProps {
  title: string;
  onBack?: () => void;
  actions?: ReactNode;
  className?: string;
}

/**
 * 设置页面专用 Header 组件
 * 在移动端显示返回按钮和标题，支持自定义操作按钮
 * 桌面端时隐藏，由主布局处理
 */
export function SettingsHeader({ title, onBack, actions, className }: SettingsHeaderProps) {
  const router = useRouter();
  const workspaceSlug = useAtomValue(currentWorkspaceSlugAtom);

  const handleBack = () => {
    if (onBack) {
      onBack();
    } else {
      if (!workspaceSlug) return;
      void router.navigate({
        to: '/$workspaceName/settings',
        params: { workspaceName: workspaceSlug },
      });
    }
  };

  return (
    <header
      className={cn(
        'border-b border-border bg-background md:hidden', // 仅在移动端显示
        className
      )}
    >
      <div className="flex h-14 items-center px-4">
        {/* 返回按钮 */}
        <Button variant="ghost" icon className="mr-2" onClick={handleBack}>
          <ArrowLeft className="h-5 w-5" />
        </Button>

        {/* 标题 */}
        <h2 className="text-lg font-semibold truncate flex-1">{title}</h2>

        {/* 操作按钮区域 */}
        {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}
