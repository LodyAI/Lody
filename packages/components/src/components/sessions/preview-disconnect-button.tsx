import { themeSpace as appSpace } from '../../style/theme-scale.stylex';
import { ChevronDown, OctagonX, Power } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { Tooltip } from '@lody/ui/tooltip';
import { Menu } from '@/ui/menu';

const DARK =
  ':where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))';

const styles = stylex.create({
  group: {
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'stretch',
  },
  iconGlyph: {
    width: '16px',
    height: '16px',
  },
  chevron: {
    width: '14px',
    height: '14px',
  },
  chevronCompact: {
    width: '12px',
    height: '12px',
  },
  menuIcon: {
    width: '14px',
    height: '14px',
  },
  chevronTrigger: {
    flexShrink: 0,
  },
  iconPrimaryJoined: {
    borderTopRightRadius: 0,
    borderBottomRightRadius: 0,
  },
  chevronTriggerJoined: {
    borderTopLeftRadius: 0,
    borderBottomLeftRadius: 0,
    borderLeftWidth: '1px',
    borderLeftStyle: 'solid',
    borderLeftColor: {
      default: 'rgb(0 0 0 / 0.1)',
      [DARK]: 'rgb(255 255 255 / 0.1)',
    },
  },
  chevronTriggerMini: {
    paddingInline: '4px',
  },
  chevronTriggerSmall: {
    paddingInline: '6px',
  },
});

export type PreviewDisconnectButtonProps = {
  /** 'icon' for browser toolbar, 'small' for device toolbar, 'mini' for popovers. */
  size: 'icon' | 'small' | 'mini';
  /** Visible button text (small/mini) or tooltip/accessible label (icon). */
  primaryLabel: string;
  /** Accessible label for the downward-arrow options trigger. */
  menuAriaLabel: string;
  /** Safe dropdown option: closes preview without stopping the server/simulator. */
  disconnectOnlyLabel: string;
  /** Destructive dropdown option: closes preview and terminates server/simulator. */
  disconnectAndTerminateLabel?: string;
  disabled?: boolean;
  /** Primary safe click (also used for the first dropdown option). Never sticky. */
  onDisconnectOnly: () => void;
  /** Optional destructive action. When omitted, renders a single plain button. */
  onDisconnectAndTerminate?: () => void;
  testId?: string;
};

/**
 * Split disconnect button modeled on `PrMergeButton`: primary click always runs
 * the safe preview-only disconnect, while the downward arrow menu exposes both
 * preview-only disconnect and disconnect-with-process/device termination.
 */
export function PreviewDisconnectButton({
  size,
  primaryLabel,
  menuAriaLabel,
  disconnectOnlyLabel,
  disconnectAndTerminateLabel,
  disabled = false,
  onDisconnectOnly,
  onDisconnectAndTerminate,
  testId,
}: PreviewDisconnectButtonProps) {
  const showMenu = Boolean(onDisconnectAndTerminate && disconnectAndTerminateLabel);

  if (size === 'icon') {
    const primaryButton = (
      <Tooltip.Root>
        <Tooltip.Trigger
          render={
            <Button
              type="button"
              variant="ghost"
              icon
              disabled={disabled}
              aria-label={primaryLabel}
              data-testid={testId}
              xstyle={[styles.chevronTrigger, showMenu && styles.iconPrimaryJoined]}
              onClick={onDisconnectOnly}
            >
              <Power {...stylex.props(styles.iconGlyph)} aria-hidden />
            </Button>
          }
        />
        <Tooltip.Content>{primaryLabel}</Tooltip.Content>
      </Tooltip.Root>
    );

    if (!showMenu) {
      return primaryButton;
    }

    return (
      <div {...stylex.props(styles.group)} data-preview-disconnect-control="">
        {primaryButton}
        <Menu.Root>
          <Menu.Trigger
            render={
              <Button
                type="button"
                variant="ghost"
                icon
                disabled={disabled}
                aria-label={menuAriaLabel}
                data-testid={testId ? `${testId}-menu` : undefined}
                xstyle={themeStyles.panel}
              >
                <ChevronDown {...stylex.props(styles.chevronCompact)} aria-hidden />
              </Button>
            }
          />
          <Menu.Content align="end">
            <Menu.Item
              icon={<Power {...stylex.props(styles.menuIcon)} aria-hidden />}
              onClick={onDisconnectOnly}
            >
              {disconnectOnlyLabel}
            </Menu.Item>
            <Menu.Item
              tone="destructive"
              icon={<OctagonX {...stylex.props(styles.menuIcon)} aria-hidden />}
              onClick={onDisconnectAndTerminate}
            >
              {disconnectAndTerminateLabel}
            </Menu.Item>
          </Menu.Content>
        </Menu.Root>
      </div>
    );
  }

  const buttonSize = size === 'mini' ? 'mini' : 'small';

  if (!showMenu) {
    return (
      <Button
        type="button"
        variant="secondary"
        size={buttonSize}
        disabled={disabled}
        data-testid={testId}
        onClick={onDisconnectOnly}
      >
        {primaryLabel}
      </Button>
    );
  }

  return (
    <div {...stylex.props(styles.group)} data-preview-disconnect-control="">
      <Button
        type="button"
        variant="secondary"
        size={buttonSize}
        disabled={disabled}
        data-testid={testId}
        xstyle={themeStyles.panel2}
        onClick={onDisconnectOnly}
      >
        {primaryLabel}
      </Button>
      <Menu.Root>
        <Menu.Trigger
          render={
            <Button
              type="button"
              variant="secondary"
              size={buttonSize}
              disabled={disabled}
              aria-label={menuAriaLabel}
              data-testid={testId ? `${testId}-menu` : undefined}
              xstyle={[
                styles.chevronTriggerJoined,
                size === 'mini' ? styles.chevronTriggerMini : styles.chevronTriggerSmall,
              ]}
            >
              <ChevronDown
                {...stylex.props(size === 'mini' ? styles.chevronCompact : styles.chevron)}
                aria-hidden
              />
            </Button>
          }
        />
        <Menu.Content align="end">
          <Menu.Item
            icon={<Power {...stylex.props(styles.menuIcon)} aria-hidden />}
            onClick={onDisconnectOnly}
          >
            {disconnectOnlyLabel}
          </Menu.Item>
          <Menu.Item
            tone="destructive"
            icon={<OctagonX {...stylex.props(styles.menuIcon)} aria-hidden />}
            onClick={onDisconnectAndTerminate}
          >
            {disconnectAndTerminateLabel}
          </Menu.Item>
        </Menu.Content>
      </Menu.Root>
    </div>
  );
}

const themeStyles = stylex.create({
  panel: { width: appSpace[5], flexShrink: 0, borderTopLeftRadius: 0, borderBottomLeftRadius: 0, paddingInline: 0 },
  panel2: { borderTopRightRadius: 0, borderBottomRightRadius: 0 },
});
