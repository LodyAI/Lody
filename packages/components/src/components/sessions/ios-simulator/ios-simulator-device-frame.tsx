import { forwardRef, type CSSProperties, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Tooltip } from '@lody/ui/tooltip';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { corner, duration, radius, space } from '@lody/ui/tokens/scales.stylex';
import {
  getIosSimulatorDeviceGeometry,
  type IosSimulatorButtonName,
  type IosSimulatorHardware,
  type IosSimulatorHardwareButton,
  type IosSimulatorQuarterTurns,
} from '@/lib/ios-simulator/ios-simulator-hardware';

/** How far a side button stands off the body, in screen-width units. */
const BUTTON_DEPTH = 0.016;

/**
 * The device's own finish: a silver body in light, graphite in dark. It has no
 * interface role, so it takes the gray ramp; the rim is one step darker than the
 * body so the edge reads, and the buttons one step past that.
 */
const RIM = `inset 0 0 0 1.5px ${colors.gray3}`;
const LIFT = shadow.card;

const styles = stylex.create({
  /** A size container, so the device can fit by whichever axis runs out first. */
  stage: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexGrow: 1,
    minHeight: 0,
    minWidth: 0,
    padding: space[4],
    containerType: 'size',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    WebkitTouchCallout: 'none',
  },
  /** Fullscreen shows the device alone, on the page colour. */
  stageFullscreen: { backgroundColor: colors.background, padding: space[6] },
  device: {
    position: 'relative',
    flexShrink: 0,
    containerType: 'size',
  },
  chassis: {
    position: 'absolute',
    left: '50%',
    top: '50%',
    transitionProperty: 'transform',
    transitionDuration: duration.slow,
    pointerEvents: 'none',
  },
  body: {
    position: 'absolute',
    inset: 0,
    backgroundColor: colors.gray4,
    boxShadow: `${RIM}, ${LIFT}`,
    cornerShape: corner.shape,
  },
  button: {
    position: 'absolute',
    boxSizing: 'border-box',
    padding: 0,
    margin: 0,
    borderWidth: 0,
    borderRadius: radius.full,
    cornerShape: corner.round,
    backgroundColor: { default: colors.gray2, ':hover': colors.gray },
    boxShadow: RIM,
    pointerEvents: 'auto',
    cursor: { default: 'pointer', ':disabled': 'default' },
    opacity: { default: 1, ':disabled': 0.5 },
    transitionProperty: 'background-color, transform',
    transitionDuration: duration.fast,
    outlineStyle: 'none',
  },
  /** A press moves the button into the body, along its own axis. */
  pressLeft: { transform: { default: 'none', ':active:not(:disabled)': 'translateX(30%)' } },
  pressRight: { transform: { default: 'none', ':active:not(:disabled)': 'translateX(-30%)' } },
  pressTop: { transform: { default: 'none', ':active:not(:disabled)': 'translateY(30%)' } },
  /** The Home button is a ring set into the glass, not a bump on the side. */
  homeButton: {
    backgroundColor: { default: 'transparent', ':hover': colors.gray5 },
    boxShadow: `inset 0 0 0 2px ${colors.gray2}`,
    transform: { default: 'none', ':active:not(:disabled)': 'scale(0.94)' },
  },
  screen: {
    position: 'absolute',
    overflow: 'hidden',
    backgroundColor: colors.background,
    cornerShape: corner.round,
  },
  screenAlone: { boxShadow: shadow.card },
});

export type IosSimulatorDeviceFrameProps = {
  hardware: IosSimulatorHardware;
  /** Width / height of the screen as it is shown, after any rotation. */
  screenAspect: number;
  turns: IosSimulatorQuarterTurns;
  /** `false` shows the bare screen, fitted as large as the panel allows. */
  bezel: boolean;
  fullscreen?: boolean;
  /** Presses a hardware button; absent while controls are unavailable. */
  onPress?: (button: IosSimulatorButtonName) => void;
  isPressAvailable?: (button: IosSimulatorButtonName) => boolean;
  buttonLabel: (button: IosSimulatorHardwareButton) => string;
  children: ReactNode;
};

const percent = (value: number) => `${value * 100}%`;

function HardwareButton({
  button,
  portrait,
  hardware,
  label,
  onPress,
  enabled,
}: {
  button: IosSimulatorHardwareButton;
  portrait: { width: number; height: number };
  hardware: IosSimulatorHardware;
  label: string;
  onPress?: (button: IosSimulatorButtonName) => void;
  enabled: boolean;
}) {
  let position: CSSProperties;
  let press: stylex.StyleXStyles;
  if (button.edge === 'face') {
    // A circle centred in the chin, sized in screen-width units.
    const diameter = button.length;
    const centreY = portrait.height - (hardware.rim + hardware.chin) / 2;
    position = {
      left: percent(0.5 - diameter / 2 / portrait.width),
      top: percent((centreY - diameter / 2) / portrait.height),
      width: percent(diameter / portrait.width),
      height: percent(diameter / portrait.height),
    };
    press = styles.homeButton;
  } else if (button.edge === 'top') {
    position = {
      left: percent(button.at - button.length / 2),
      width: percent(button.length),
      top: percent(-BUTTON_DEPTH / portrait.height),
      height: percent((BUTTON_DEPTH * 2) / portrait.height),
    };
    press = styles.pressTop;
  } else {
    const depth = percent(BUTTON_DEPTH / portrait.width);
    position = {
      top: percent(button.at - button.length / 2),
      height: percent(button.length),
      width: percent((BUTTON_DEPTH * 2) / portrait.width),
      ...(button.edge === 'left' ? { left: `-${depth}` } : { right: `-${depth}` }),
    };
    press = button.edge === 'left' ? styles.pressLeft : styles.pressRight;
  }
  const pressable = Boolean(onPress && button.press && enabled);
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <button
            type="button"
            {...stylex.props(styles.button, press)}
            style={position}
            aria-label={label}
            disabled={!pressable}
            data-hardware-button={button.id}
            onClick={() => {
              if (pressable && button.press) onPress?.(button.press);
            }}
          />
        }
      />
      <Tooltip.Content>{label}</Tooltip.Content>
    </Tooltip.Root>
  );
}

/**
 * The simulator inside its device. The screen is laid out upright in the
 * panel's coordinates and is never rotated here — the stream turns with the
 * device — while the exterior turns around it, so the side buttons stay where
 * the hand would find them. Side buttons press the real hardware control.
 */
export const IosSimulatorDeviceFrame = forwardRef<HTMLDivElement, IosSimulatorDeviceFrameProps>(
  function IosSimulatorDeviceFrame(
    {
      hardware,
      screenAspect,
      turns,
      bezel,
      fullscreen = false,
      onPress,
      isPressAvailable = () => true,
      buttonLabel,
      children,
    },
    ref
  ) {
    const geometry = getIosSimulatorDeviceGeometry(hardware, screenAspect, turns, bezel);
    const sideways = turns % 2 === 1;
    const unit = (value: number) => `calc(100cqw * ${value / geometry.width})`;
    const deviceStyle: CSSProperties = {
      width: `min(100cqw, calc(100cqh * ${geometry.width / geometry.height}))`,
      aspectRatio: `${geometry.width} / ${geometry.height}`,
    };
    const chassisStyle: CSSProperties = {
      width: sideways ? '100cqh' : '100cqw',
      height: sideways ? '100cqw' : '100cqh',
      transform: `translate(-50%, -50%) rotate(${turns * 90}deg)`,
    };
    const screenStyle: CSSProperties = {
      left: percent(geometry.screen.left / geometry.width),
      right: percent(geometry.screen.right / geometry.width),
      top: percent(geometry.screen.top / geometry.height),
      bottom: percent(geometry.screen.bottom / geometry.height),
      borderRadius: unit(hardware.screenRadius),
    };
    return (
      <div
        ref={ref}
        {...stylex.props(styles.stage, fullscreen && styles.stageFullscreen)}
        data-testid="ios-simulator-viewer"
      >
        <Tooltip.Provider delay={400}>
          <div
            {...stylex.props(styles.device)}
            style={deviceStyle}
            data-testid="ios-simulator-device"
            data-turns={turns}
            data-bezel={bezel ? 'on' : 'off'}
          >
            {bezel ? (
              <div {...stylex.props(styles.chassis)} style={chassisStyle} aria-hidden={!onPress}>
                <div
                  {...stylex.props(styles.body)}
                  style={{ borderRadius: unit(hardware.bodyRadius) }}
                />
                {hardware.buttons.map((button) => (
                  <HardwareButton
                    key={button.id}
                    button={button}
                    portrait={geometry.portrait}
                    hardware={hardware}
                    label={buttonLabel(button)}
                    onPress={onPress}
                    enabled={button.press ? isPressAvailable(button.press) : false}
                  />
                ))}
              </div>
            ) : null}
            <div {...stylex.props(styles.screen, !bezel && styles.screenAlone)} style={screenStyle}>
              {children}
            </div>
          </div>
        </Tooltip.Provider>
      </div>
    );
  }
);
