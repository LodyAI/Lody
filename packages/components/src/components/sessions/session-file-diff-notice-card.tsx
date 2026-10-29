import {
  CollapsibleCard,
  CollapsibleCardContent,
  CollapsibleCardHeader,
} from '@/ui/collapsible-card';
import * as stylex from '@stylexjs/stylex';
import { FileIcon } from '@/components/icons/file-icons';
import { DiffFileHeaderActions } from '@/ui/diff-viewer/diff-file-header-actions';
import { cn } from '@/lib/utils';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeFontSize,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';

const styles = stylex.create({
  noticeHeader: {
    insetInline: 'calc(var(--spacing) * 0)',
    borderRadius: 0,
    borderBottomStyle: 'var(--tw-border-style)',
    borderBottomWidth: '1px',
    borderColor: {
      default: 'hsl(var(--foreground) / 1)',
      '@supports (color: color-mix(in lab, red, red))':
        'color-mix(in oklab, hsl(var(--foreground) / 1) 8%, transparent)',
    },
    backgroundColor: 'hsl(var(--background) / 1)',
    paddingLeft: 'calc(var(--spacing) * 1)',
    paddingRight: 'calc(var(--spacing) * 4)',
  },
  card: {
    width: '100%',
    overflow: 'hidden',
    borderRadius: themeRadius.xl,
    fontSize: '0.8rem',
  },
  fileIcon: {
    width: themeSpace[4],
    height: themeSpace[4],
    flexShrink: 0,
  },
  headerRow: {
    display: 'flex',
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    alignItems: 'center',
    gap: themeSpace[1],
  },
  fileName: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    color: 'color-mix(in oklab, hsl(var(--foreground) / 1) 90%, transparent)',
  },
  message: {
    paddingInline: themeSpace[4],
    paddingBlock: themeSpace[3],
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    color: themeColors.mutedForeground,
  },
});

export type SessionFileDiffNoticeCardProps = {
  filePath: string;
  message: string;
  stickyHeader?: boolean;
  className?: string;
  onOpenFile?: (path: string) => void;
};

export function SessionFileDiffNoticeCard({
  filePath,
  message,
  className,
  onOpenFile,
}: SessionFileDiffNoticeCardProps) {
  // stickyHeader remains on the props type for API compatibility, but sticky is
  // forced off so overflow-hidden can clip the rounded card border.
  return (
    <CollapsibleCard
      className={cn(
        stylex.props(styles.card).className,
        'min-h-8 border border-foreground/[0.12] bg-background shadow-[0_1px_2px_hsl(0_0%_0%/0.04)] dark:border-border',
        className
      )}
      defaultOpen
      allowStickyChildren={false}
    >
      <CollapsibleCardHeader
        sticky={false}
        position="relative"
        className={cn('h-8 dark:border-border', stylex.props(styles.noticeHeader).className)}
      >
        <FileIcon filePath={filePath} className={stylex.props(styles.fileIcon).className} />
        <div {...stylex.props(styles.headerRow)}>
          <span {...stylex.props(styles.fileName)} title={filePath}>
            {filePath}
          </span>
          <DiffFileHeaderActions path={filePath} onOpenFile={onOpenFile} />
        </div>
      </CollapsibleCardHeader>
      <CollapsibleCardContent noInternalScroll className="pb-0">
        <div {...stylex.props(styles.message)}>{message}</div>
      </CollapsibleCardContent>
    </CollapsibleCard>
  );
}
