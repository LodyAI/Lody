import { useLayoutEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import {
  Camera,
  CircleDot,
  Download,
  Ellipsis,
  House,
  Keyboard,
  Layers2,
  Link,
  Lock,
  Maximize,
  Minimize,
  Moon,
  Paperclip,
  RotateCcw,
  RotateCw,
  Smartphone,
  Sun,
  SunMoon,
  Vibrate,
  Volume1,
  Volume2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { IosSimulatorDeviceControl } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { Menu } from '@lody/ui/menu';
import { Toggle } from '@lody/ui/toggle';
import { Toolbar } from '@lody/ui/toolbar';
import { Tooltip } from '@lody/ui/tooltip';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import type { IosSimulatorControlId } from '@/lib/ios-simulator/ios-simulator-hardware';

type Icon = ComponentType<{ size?: number | string; 'aria-hidden'?: boolean }>;

export type IosSimulatorScreenshotTarget = 'attach' | 'save';
export type IosSimulatorViewMode = 'device' | 'screen';

export type IosSimulatorControlsProps = {
  /** `toolbar`: a second toolbar row (desktop). `menu`: everything in one More menu (mobile). */
  layout: 'toolbar' | 'menu';
  /** False while the machine cannot take native controls; view controls still work. */
  controlsSupported: boolean;
  /** Why native controls are off, said once instead of on every button. */
  unsupportedHint?: string;
  availability: Record<IosSimulatorControlId, boolean>;
  /** A control is in flight; the same one cannot be pressed twice at once. */
  pendingControl?: IosSimulatorControlId | null;
  capturing?: boolean;
  /** Whether a composer is there to take a screenshot. */
  canAttach: boolean;
  viewMode: IosSimulatorViewMode;
  fullscreen: boolean;
  canFullscreen: boolean;
  onControl: (control: IosSimulatorDeviceControl) => void;
  onTypeText: () => void;
  onOpenUrl: () => void;
  onScreenshot: (target: IosSimulatorScreenshotTarget) => void;
  onViewModeChange: (mode: IosSimulatorViewMode) => void;
  onToggleFullscreen: () => void;
};

type ControlItem = {
  id: string;
  label: string;
  icon: Icon;
  disabled: boolean;
  onSelect: () => void;
};

/** How much of the row fits: every cluster, or only the ones used most. */
type RowDensity = 'wide' | 'medium' | 'narrow';
const DENSITY_RANK: Record<RowDensity, number> = { narrow: 0, medium: 1, wide: 2 };

const densityForWidth = (width: number): RowDensity =>
  width > 520 ? 'wide' : width > 380 ? 'medium' : 'narrow';

type ControlGroup = {
  id: string;
  label: string;
  items: ControlItem[];
  /** The narrowest row that still shows this cluster; below it, it folds into More. */
  keepAt: RowDensity;
};

const styles = stylex.create({
  row: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: space[1],
    minWidth: 0,
    paddingInline: space[1.5],
    paddingBottom: space[1.5],
  },
  /** The bar draws its own gaps; the row only lets it take the width. */
  bar: { flexGrow: 1, minWidth: 0 },
  /** A wrapper that is not a box, so the bar lays its clusters out itself. */
  cluster: { display: 'contents' },
  spacer: { flexGrow: 1 },
  hint: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.footnoteSize,
    color: colors.secondaryLabel,
  },
});

function useControlGroups(props: IosSimulatorControlsProps) {
  const { t } = useTranslation();
  const { controlsSupported, availability, pendingControl, onControl, onTypeText, onOpenUrl } =
    props;
  const item = (
    id: IosSimulatorControlId,
    label: string,
    icon: Icon,
    onSelect: () => void
  ): ControlItem => ({
    id,
    label,
    icon,
    disabled: !controlsSupported || !availability[id] || pendingControl === id,
    onSelect,
  });
  const button = (name: Extract<IosSimulatorDeviceControl, { kind: 'button' }>['button']) => () =>
    onControl({ kind: 'button', button: name });
  const groups: ControlGroup[] = [
    {
      id: 'navigation',
      label: t('sessions.iosSimulator.controls.navigation', 'Navigation'),
      keepAt: 'narrow',
      items: [
        item('home', t('sessions.iosSimulator.controls.home', 'Home'), House, button('home')),
        item(
          'app-switcher',
          t('sessions.iosSimulator.controls.appSwitcher', 'App switcher'),
          Layers2,
          button('app-switcher')
        ),
        item('lock', t('sessions.iosSimulator.controls.lock', 'Lock'), Lock, button('lock')),
      ],
    },
    {
      id: 'orientation',
      label: t('sessions.iosSimulator.controls.orientation', 'Orientation'),
      keepAt: 'medium',
      items: [
        item(
          'rotate-left',
          t('sessions.iosSimulator.controls.rotateLeft', 'Rotate left'),
          RotateCcw,
          () => onControl({ kind: 'rotate', direction: 'left' })
        ),
        item(
          'rotate-right',
          t('sessions.iosSimulator.controls.rotateRight', 'Rotate right'),
          RotateCw,
          () => onControl({ kind: 'rotate', direction: 'right' })
        ),
      ],
    },
    {
      id: 'hardware',
      label: t('sessions.iosSimulator.controls.hardware', 'Hardware'),
      keepAt: 'wide',
      items: [
        item(
          'volume-down',
          t('sessions.iosSimulator.controls.volumeDown', 'Volume down'),
          Volume1,
          button('volume-down')
        ),
        item(
          'volume-up',
          t('sessions.iosSimulator.controls.volumeUp', 'Volume up'),
          Volume2,
          button('volume-up')
        ),
        item(
          'action',
          t('sessions.iosSimulator.controls.action', 'Action button'),
          CircleDot,
          button('action')
        ),
        item('shake', t('sessions.iosSimulator.controls.shake', 'Shake'), Vibrate, () =>
          onControl({ kind: 'shake' })
        ),
      ],
    },
    {
      id: 'input',
      label: t('sessions.iosSimulator.controls.input', 'Input'),
      keepAt: 'wide',
      items: [
        item(
          'text',
          t('sessions.iosSimulator.controls.typeText', 'Type text…'),
          Keyboard,
          onTypeText
        ),
        item(
          'open-url',
          t('sessions.iosSimulator.controls.openUrl', 'Open URL or deep link…'),
          Link,
          onOpenUrl
        ),
      ],
    },
  ];
  return groups;
}

function ToolbarIconButton({
  label,
  icon: IconComponent,
  disabled,
  onClick,
}: {
  label: string;
  icon: Icon;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <Toolbar.Button
            render={
              <Button
                type="button"
                variant="ghost"
                size="small"
                icon
                aria-label={label}
                disabled={disabled}
                onClick={onClick}
              >
                <IconComponent size="100%" aria-hidden />
              </Button>
            }
          />
        }
      />
      <Tooltip.Content>{label}</Tooltip.Content>
    </Tooltip.Root>
  );
}

function MenuTriggerButton({
  label,
  icon: IconComponent,
  disabled,
  children,
}: {
  label: string;
  icon: Icon;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Menu.Root>
      <Tooltip.Root>
        <Tooltip.Trigger
          render={
            <Menu.Trigger
              disabled={disabled}
              render={
                <Toolbar.Button
                  render={
                    <Button type="button" variant="ghost" size="small" icon aria-label={label}>
                      <IconComponent size="100%" aria-hidden />
                    </Button>
                  }
                />
              }
            />
          }
        />
        <Tooltip.Content>{label}</Tooltip.Content>
      </Tooltip.Root>
      <Menu.Content align="end">{children}</Menu.Content>
    </Menu.Root>
  );
}

/** Rows shared by the toolbar's own menus and the mobile More menu. */
function AppearanceRows({ props }: { props: IosSimulatorControlsProps }) {
  const { t } = useTranslation();
  const disabled =
    !props.controlsSupported ||
    !props.availability.appearance ||
    props.pendingControl === 'appearance';
  return (
    <>
      <Menu.Item
        icon={<Sun size="100%" aria-hidden />}
        disabled={disabled}
        onClick={() => props.onControl({ kind: 'appearance', appearance: 'light' })}
      >
        {t('sessions.iosSimulator.controls.light', 'Light appearance')}
      </Menu.Item>
      <Menu.Item
        icon={<Moon size="100%" aria-hidden />}
        disabled={disabled}
        onClick={() => props.onControl({ kind: 'appearance', appearance: 'dark' })}
      >
        {t('sessions.iosSimulator.controls.dark', 'Dark appearance')}
      </Menu.Item>
    </>
  );
}

function ScreenshotRows({ props }: { props: IosSimulatorControlsProps }) {
  const { t } = useTranslation();
  const disabled = !props.controlsSupported || Boolean(props.capturing);
  return (
    <>
      <Menu.Item
        icon={<Paperclip size="100%" aria-hidden />}
        disabled={disabled || !props.canAttach}
        onClick={() => props.onScreenshot('attach')}
      >
        {t('sessions.iosSimulator.controls.screenshotAttach', 'Attach screenshot to message')}
      </Menu.Item>
      <Menu.Item
        icon={<Download size="100%" aria-hidden />}
        disabled={disabled}
        onClick={() => props.onScreenshot('save')}
      >
        {t('sessions.iosSimulator.controls.screenshotSave', 'Save screenshot')}
      </Menu.Item>
    </>
  );
}

function ViewRows({ props }: { props: IosSimulatorControlsProps }) {
  const { t } = useTranslation();
  return (
    <>
      <Menu.CheckboxItem
        checked={props.viewMode === 'device'}
        onCheckedChange={(checked) => props.onViewModeChange(checked ? 'device' : 'screen')}
      >
        {t('sessions.iosSimulator.controls.deviceFrame', 'Device frame')}
      </Menu.CheckboxItem>
      {props.canFullscreen ? (
        <Menu.Item
          icon={
            props.fullscreen ? (
              <Minimize size="100%" aria-hidden />
            ) : (
              <Maximize size="100%" aria-hidden />
            )
          }
          onClick={props.onToggleFullscreen}
        >
          {props.fullscreen
            ? t('sessions.iosSimulator.controls.exitFullscreen', 'Exit full screen')
            : t('sessions.iosSimulator.controls.fullscreen', 'Full screen')}
        </Menu.Item>
      ) : null}
    </>
  );
}

function GroupRows({ group }: { group: ControlGroup }) {
  return (
    <Menu.Group>
      <Menu.GroupLabel>{group.label}</Menu.GroupLabel>
      {group.items.map(({ id, label, icon: IconComponent, disabled, onSelect }) => (
        <Menu.Item
          key={id}
          icon={<IconComponent size="100%" aria-hidden />}
          disabled={disabled}
          onClick={onSelect}
        >
          {label}
        </Menu.Item>
      ))}
    </Menu.Group>
  );
}

/**
 * The simulator's native controls. On desktop they are a second toolbar row —
 * navigation and orientation always, hardware and input folding into an
 * overflow menu when the panel is narrow — and on mobile every one of them is
 * in a single More menu. Nothing here publishes the device: there is no share,
 * public viewer or open-in-browser.
 */
export function IosSimulatorControls(props: IosSimulatorControlsProps) {
  const { t } = useTranslation();
  const groups = useControlGroups(props);
  const moreLabel = t('sessions.iosSimulator.controls.more', 'Simulator controls');
  const rowRef = useRef<HTMLDivElement>(null);
  const [density, setDensity] = useState<RowDensity>('wide');
  // Measured, not a container query: what folds must also appear in the More
  // menu, which is portalled out of the row and cannot see its width.
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setDensity(densityForWidth(entry.contentRect.width));
    });
    observer.observe(row);
    return () => observer.disconnect();
  }, []);

  if (props.layout === 'menu') {
    return (
      <Menu.Root>
        <Menu.Trigger
          render={
            <Button type="button" variant="ghost" size="small" icon aria-label={moreLabel}>
              <Ellipsis size="100%" aria-hidden />
            </Button>
          }
        />
        <Menu.Content align="end">
          {props.controlsSupported ? null : props.unsupportedHint ? (
            <Menu.Group>
              <Menu.GroupLabel>{props.unsupportedHint}</Menu.GroupLabel>
            </Menu.Group>
          ) : null}
          {groups.map((group) => (
            <GroupRows key={group.id} group={group} />
          ))}
          <Menu.Group>
            <Menu.GroupLabel>
              {t('sessions.iosSimulator.controls.appearance', 'Appearance')}
            </Menu.GroupLabel>
            <AppearanceRows props={props} />
          </Menu.Group>
          <Menu.Group>
            <Menu.GroupLabel>
              {t('sessions.iosSimulator.controls.screenshot', 'Screenshot')}
            </Menu.GroupLabel>
            <ScreenshotRows props={props} />
          </Menu.Group>
          <Menu.Group>
            <Menu.GroupLabel>{t('sessions.iosSimulator.controls.view', 'View')}</Menu.GroupLabel>
            <ViewRows props={props} />
          </Menu.Group>
        </Menu.Content>
      </Menu.Root>
    );
  }

  const fits = (group: { keepAt: RowDensity }) =>
    DENSITY_RANK[density] >= DENSITY_RANK[group.keepAt];
  const shown = groups.filter(fits);
  const folded = groups.filter((group) => !fits(group));
  const appearanceFits = density === 'wide';
  return (
    <div ref={rowRef} {...stylex.props(styles.row)} data-testid="ios-simulator-controls">
      <Tooltip.Provider delay={350}>
        <Toolbar.Root
          aria-label={t('sessions.iosSimulator.controls.label', 'Simulator controls')}
          {...stylex.props(styles.bar)}
        >
          {props.controlsSupported ? (
            shown.map((group, index) => (
              <span key={group.id} {...stylex.props(styles.cluster)}>
                {index > 0 ? <Toolbar.Separator /> : null}
                <Toolbar.Group aria-label={group.label}>
                  {group.items.map((control) => (
                    <ToolbarIconButton
                      key={control.id}
                      label={control.label}
                      icon={control.icon}
                      disabled={control.disabled}
                      onClick={control.onSelect}
                    />
                  ))}
                </Toolbar.Group>
              </span>
            ))
          ) : (
            <span {...stylex.props(styles.hint)}>{props.unsupportedHint}</span>
          )}
          {props.controlsSupported && appearanceFits ? (
            <MenuTriggerButton
              label={t('sessions.iosSimulator.controls.appearance', 'Appearance')}
              icon={SunMoon}
            >
              <AppearanceRows props={props} />
            </MenuTriggerButton>
          ) : null}
          {props.controlsSupported && !appearanceFits ? (
            <MenuTriggerButton
              label={t('sessions.iosSimulator.controls.moreControls', 'More controls')}
              icon={Ellipsis}
            >
              {folded.map((group) => (
                <GroupRows key={group.id} group={group} />
              ))}
              <Menu.Group>
                <Menu.GroupLabel>
                  {t('sessions.iosSimulator.controls.appearance', 'Appearance')}
                </Menu.GroupLabel>
                <AppearanceRows props={props} />
              </Menu.Group>
            </MenuTriggerButton>
          ) : null}
          <span {...stylex.props(styles.spacer)} />
          <MenuTriggerButton
            label={t('sessions.iosSimulator.controls.screenshot', 'Screenshot')}
            icon={Camera}
            disabled={!props.controlsSupported || props.capturing}
          >
            <ScreenshotRows props={props} />
          </MenuTriggerButton>
          <Tooltip.Root>
            <Tooltip.Trigger
              render={
                <Toolbar.Button
                  render={
                    <Toggle
                      size="small"
                      icon
                      aria-label={t('sessions.iosSimulator.controls.deviceFrame', 'Device frame')}
                      pressed={props.viewMode === 'device'}
                      onPressedChange={(pressed) =>
                        props.onViewModeChange(pressed ? 'device' : 'screen')
                      }
                    >
                      <Smartphone size="100%" aria-hidden />
                    </Toggle>
                  }
                />
              }
            />
            <Tooltip.Content>
              {t('sessions.iosSimulator.controls.deviceFrame', 'Device frame')}
            </Tooltip.Content>
          </Tooltip.Root>
          {props.canFullscreen ? (
            <ToolbarIconButton
              label={
                props.fullscreen
                  ? t('sessions.iosSimulator.controls.exitFullscreen', 'Exit full screen')
                  : t('sessions.iosSimulator.controls.fullscreen', 'Full screen')
              }
              icon={props.fullscreen ? Minimize : Maximize}
              onClick={props.onToggleFullscreen}
            />
          ) : null}
        </Toolbar.Root>
      </Tooltip.Provider>
    </div>
  );
}
