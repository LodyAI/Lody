import type { IosSimulatorDeviceControl } from '@lody/shared';
import type { IosSimulatorDeviceFamily } from './ios-simulator-types';

/**
 * The device's exterior, drawn around the streamed screen. Everything the
 * machine streams — the notch, the Dynamic Island, the home indicator — is
 * already in the pixels, so nothing here is ever drawn over the screen: the
 * exterior is the rim, the side buttons and, on older models, the Home button
 * below the glass.
 *
 * Lengths are in units of the screen's portrait WIDTH, so one profile draws any
 * resolution. Positions along an edge are fractions of that edge of the body.
 */

export type IosSimulatorButtonName = Extract<
  IosSimulatorDeviceControl,
  { kind: 'button' }
>['button'];

export type IosSimulatorHardwareButton = {
  id: 'side' | 'volume-up' | 'volume-down' | 'action' | 'home' | 'crown' | 'top';
  /** What pressing it does, or null for a part that is only drawn. */
  press: IosSimulatorButtonName | null;
  /** Where it sits on the portrait body; `face` is a Home button below the screen. */
  edge: 'left' | 'right' | 'top' | 'face';
  /** Centre along the edge, as a fraction of that edge of the body. */
  at: number;
  /** Length along the edge, as a fraction of that edge of the body. */
  length: number;
};

export type IosSimulatorHardware = {
  family: IosSimulatorDeviceFamily;
  homeButton: boolean;
  actionButton: boolean;
  /** Side rim, and the extra glass above and below the screen on Home-button models. */
  rim: number;
  forehead: number;
  chin: number;
  screenRadius: number;
  bodyRadius: number;
  buttons: IosSimulatorHardwareButton[];
};

const ordinal = (text: string, pattern: RegExp): number | null => {
  const match = pattern.exec(text);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
};

/** `…SimDeviceType.iPhone-16-Pro` and `iPhone 16 Pro` read the same. */
const describe = (deviceType: string, name: string): string =>
  (deviceType.trim() || name)
    .replace(/^com\.apple\.CoreSimulator\.SimDeviceType\./, '')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

function iPhoneHasHomeButton(text: string): boolean {
  // Every iPhone SE, and every numbered iPhone up to 8, has one.
  if (/iphone se/.test(text)) return true;
  const number = ordinal(text, /iphone (\d+)/);
  return number !== null && number <= 8;
}

function iPhoneHasActionButton(text: string): boolean {
  if (/iphone air/.test(text)) return true;
  const number = ordinal(text, /iphone (\d+)/);
  if (number === null) return false;
  return number >= 16 || (number === 15 && /pro/.test(text));
}

function iPadHasHomeButton(text: string): boolean {
  const generation = ordinal(text, /(\d+)(?:st|nd|rd|th) generation/);
  if (/ipad pro/.test(text)) {
    return (
      text === 'ipad pro' ||
      /9[. ]7|10[. ]5/.test(text) ||
      (/12[. ]9/.test(text) && (generation ?? 1) <= 2)
    );
  }
  if (generation === null) return false;
  if (/ipad air/.test(text)) return generation <= 3;
  if (/ipad mini/.test(text)) return generation <= 5;
  return generation <= 9;
}

export function getIosSimulatorHardware(
  family: IosSimulatorDeviceFamily,
  deviceType: string,
  name: string
): IosSimulatorHardware {
  const text = describe(deviceType, name);
  switch (family) {
    case 'iphone': {
      const homeButton = iPhoneHasHomeButton(text);
      const actionButton = !homeButton && iPhoneHasActionButton(text);
      if (homeButton) {
        return {
          family,
          homeButton,
          actionButton: false,
          rim: 0.075,
          forehead: 0.22,
          chin: 0.22,
          screenRadius: 0,
          bodyRadius: 0.18,
          buttons: [
            { id: 'volume-up', press: 'volume-up', edge: 'left', at: 0.26, length: 0.07 },
            { id: 'volume-down', press: 'volume-down', edge: 'left', at: 0.35, length: 0.07 },
            { id: 'side', press: 'lock', edge: 'right', at: 0.26, length: 0.08 },
            { id: 'home', press: 'home', edge: 'face', at: 0.5, length: 0.19 },
          ],
        };
      }
      return {
        family,
        homeButton,
        actionButton,
        rim: 0.045,
        forehead: 0,
        chin: 0,
        screenRadius: 0.135,
        bodyRadius: 0.18,
        buttons: [
          ...(actionButton
            ? [{ id: 'action', press: 'action', edge: 'left', at: 0.2, length: 0.045 } as const]
            : []),
          { id: 'volume-up', press: 'volume-up', edge: 'left', at: 0.28, length: 0.075 },
          { id: 'volume-down', press: 'volume-down', edge: 'left', at: 0.37, length: 0.075 },
          { id: 'side', press: 'lock', edge: 'right', at: 0.31, length: 0.11 },
        ],
      };
    }
    case 'ipad': {
      const homeButton = iPadHasHomeButton(text);
      return {
        family,
        homeButton,
        actionButton: false,
        rim: homeButton ? 0.07 : 0.045,
        forehead: homeButton ? 0.09 : 0,
        chin: homeButton ? 0.09 : 0,
        screenRadius: homeButton ? 0 : 0.028,
        bodyRadius: homeButton ? 0.06 : 0.07,
        buttons: [
          { id: 'top', press: 'lock', edge: 'top', at: 0.82, length: 0.07 },
          { id: 'volume-up', press: 'volume-up', edge: 'right', at: 0.12, length: 0.05 },
          { id: 'volume-down', press: 'volume-down', edge: 'right', at: 0.18, length: 0.05 },
          ...(homeButton
            ? [{ id: 'home', press: 'home', edge: 'face', at: 0.5, length: 0.07 } as const]
            : []),
        ],
      };
    }
    case 'watch': {
      const actionButton = /ultra/.test(text);
      return {
        family,
        homeButton: false,
        actionButton,
        rim: 0.09,
        forehead: 0,
        chin: 0,
        screenRadius: 0.2,
        bodyRadius: 0.3,
        buttons: [
          { id: 'crown', press: 'home', edge: 'right', at: 0.36, length: 0.2 },
          { id: 'side', press: 'lock', edge: 'right', at: 0.66, length: 0.22 },
          ...(actionButton
            ? [{ id: 'action', press: 'action', edge: 'left', at: 0.4, length: 0.2 } as const]
            : []),
        ],
      };
    }
    default:
      // A television or headset has no body worth drawing: a quiet frame.
      return {
        family,
        homeButton: false,
        actionButton: false,
        rim: 0.015,
        forehead: 0,
        chin: 0,
        screenRadius: 0.012,
        bodyRadius: 0.025,
        buttons: [],
      };
  }
}

// ---------------------------------------------------------------------------
// Controls a device family can take. Unavailable ones stay listed, disabled.

export type IosSimulatorControlId =
  | 'home'
  | 'app-switcher'
  | 'lock'
  | 'rotate-left'
  | 'rotate-right'
  | 'shake'
  | 'volume-up'
  | 'volume-down'
  | 'action'
  | 'text'
  | 'appearance'
  | 'open-url';

export function getIosSimulatorControlAvailability(
  hardware: IosSimulatorHardware
): Record<IosSimulatorControlId, boolean> {
  const handheld = hardware.family === 'iphone' || hardware.family === 'ipad';
  return {
    home: hardware.family !== 'vision',
    'app-switcher': handheld,
    lock: handheld || hardware.family === 'watch',
    'rotate-left': handheld,
    'rotate-right': handheld,
    shake: handheld,
    'volume-up': handheld,
    'volume-down': handheld,
    action: hardware.actionButton,
    text: true,
    appearance: true,
    'open-url': true,
  };
}

// ---------------------------------------------------------------------------
// Orientation. The machine's stream turns with the device, so the screen is
// never rotated here — only the exterior is, and the viewer's coordinates stay
// its own.

/** Quarter turns clockwise from portrait: 0 portrait, 1 right, 2 upside down, 3 left. */
export type IosSimulatorQuarterTurns = 0 | 1 | 2 | 3;

export type IosSimulatorDeviceGeometry = {
  /** The body's outer size, in screen-width units, as laid out on screen. */
  width: number;
  height: number;
  /** Where the screen sits inside the body, in the same units. */
  screen: { left: number; top: number; right: number; bottom: number };
  /** The portrait body's size, before it is turned. */
  portrait: { width: number; height: number };
};

/**
 * Lays the body out around a screen of `screenAspect` (width / height of the
 * stream as it is shown) for the given turns. `bezel: false` is the bare screen.
 */
export function getIosSimulatorDeviceGeometry(
  hardware: IosSimulatorHardware,
  screenAspect: number,
  turns: IosSimulatorQuarterTurns,
  bezel = true
): IosSimulatorDeviceGeometry {
  const sideways = turns % 2 === 1;
  // In portrait units the screen is 1 wide; its height follows the aspect.
  const portraitAspect = sideways ? 1 / screenAspect : screenAspect;
  const screenHeight = 1 / portraitAspect;
  const rim = bezel ? hardware.rim : 0;
  const forehead = bezel ? hardware.forehead : 0;
  const chin = bezel ? hardware.chin : 0;
  const portrait = { width: 1 + 2 * rim, height: screenHeight + 2 * rim + forehead + chin };
  const top = rim + forehead;
  const bottom = rim + chin;
  switch (turns) {
    case 0:
      return {
        width: portrait.width,
        height: portrait.height,
        screen: { left: rim, top, right: rim, bottom },
        portrait,
      };
    case 2:
      return {
        width: portrait.width,
        height: portrait.height,
        screen: { left: rim, top: bottom, right: rim, bottom: top },
        portrait,
      };
    case 1:
      // Turned clockwise: the portrait top goes right, the left edge goes up.
      return {
        width: portrait.height,
        height: portrait.width,
        screen: { left: bottom, top: rim, right: top, bottom: rim },
        portrait,
      };
    default:
      // Three quarter turns: turned left, the portrait top goes left.
      return {
        width: portrait.height,
        height: portrait.width,
        screen: { left: top, top: rim, right: bottom, bottom: rim },
        portrait,
      };
  }
}

/** Exact DeviceKit rects, rotated around the original composite centre. */
export function getIosSimulatorExteriorGeometry(
  exterior: import('@lody/shared').IosSimulatorExterior,
  turns: IosSimulatorQuarterTurns
): IosSimulatorDeviceGeometry {
  const { width: w, height: h, screen: s } = exterior;
  const inset = [s.y, w - s.x - s.width, h - s.y - s.height, s.x]; // top/right/bottom/left
  const rotated = (index: number) => inset[(index - turns + 4) % 4] ?? 0;
  return {
    width: turns % 2 ? h : w,
    height: turns % 2 ? w : h,
    screen: { top: rotated(0), right: rotated(1), bottom: rotated(2), left: rotated(3) },
    portrait: { width: w, height: h },
  };
}
