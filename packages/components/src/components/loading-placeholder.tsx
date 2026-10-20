import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { Spinner } from '@lody/ui/spinner';
import { BootLoadingIndicator, BootShell } from '@/components/boot-shell';
import { cn } from '@/lib/utils';

const styles = stylex.create({
  content: {
    position: 'relative',
    display: 'flex',
    height: '100%',
    minHeight: 0,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'hsl(var(--background))',
    color: colors.secondaryLabel,
  },
});

export function LoadingPlaceholder({
  title = 'Loading',
  description = '',
  variant = 'viewport',
}: {
  title?: string;
  description?: string;
  /**
   * `boot` is for the boot/auth gates between the window's first frame and the
   * workspace layout: it continues the boot shell painted by `index.html`, with
   * this copy under the mark. `viewport` fills the viewport where that frame is
   * not continued. `content` fills an already-mounted workspace pane so the
   * sidebar and workspace identity remain stable during scoped synchronization.
   */
  variant?: 'boot' | 'viewport' | 'content';
}) {
  if (variant === 'boot') {
    return (
      <BootShell
        status={
          <>
            <div className="lody-boot-shell__status-title">{title}</div>
            {description ? <div>{description}</div> : null}
          </>
        }
      />
    );
  }

  if (variant === 'content') {
    return (
      <div {...stylex.props(styles.content)} data-loading-placeholder-scope="content">
        <BootLoadingIndicator
          status={
            <>
              <div className="lody-boot-shell__status-title">{title}</div>
              {description ? <div>{description}</div> : null}
            </>
          }
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex w-full items-center justify-center bg-background p-6 text-muted-foreground',
        'min-h-[100dvh]'
      )}
      data-loading-placeholder-scope={variant}
    >
      <div
        className="flex max-w-sm flex-col items-center gap-3 text-center"
        role="status"
        aria-live="polite"
      >
        <Spinner className="h-5 w-5" aria-hidden />
        <div className="space-y-1">
          <div className="text-sm font-medium text-foreground">{title}</div>
          {description ? (
            <div className="mx-auto max-w-[320px] text-xs leading-5">{description}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
