import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { useRouter } from '@tanstack/react-router';
import { withClassName } from '@/lib/stylex';
import { useAtomValue } from 'jotai';
import { currentWorkspaceSlugAtom } from '@/atoms';

const styles = stylex.create({
  /** Mobile only: on desktop the layout owns the title. No rule under it. */
  header: {
    display: { default: 'block', '@media (min-width: 768px)': 'none' },
    backgroundColor: colors.background,
  },
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    height: '56px',
    paddingInline: space[4],
  },
  glyph: { width: '100%', height: '100%' },
  title: {
    flexGrow: 1,
    minWidth: 0,
    margin: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '1.125em',
    fontWeight: 400,
    color: colors.label,
  },
  actions: { display: 'flex', alignItems: 'center', gap: space[2], marginInlineStart: 'auto' },
});

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
    <header {...withClassName(stylex.props(styles.header), className)}>
      <div {...stylex.props(styles.bar)}>
        {/* 返回按钮 */}
        <Button variant="ghost" icon onClick={handleBack}>
          <ArrowLeft {...stylex.props(styles.glyph)} />
        </Button>

        {/* 标题 */}
        <h2 {...stylex.props(styles.title)}>{title}</h2>

        {/* 操作按钮区域 */}
        {actions && <div {...stylex.props(styles.actions)}>{actions}</div>}
      </div>
    </header>
  );
}
