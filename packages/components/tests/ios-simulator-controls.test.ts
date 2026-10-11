import { describe, expect, it } from 'vitest';
import {
  IOS_SIMULATOR_CAPTURE_MAX_BYTES,
  getIosSimulatorScreenshotFileName,
  parseIosSimulatorCaptureResult,
  validateIosSimulatorText,
  validateIosSimulatorUrl,
} from '../src/lib/ios-simulator/ios-simulator-controls';
import {
  getIosSimulatorControlAvailability,
  getIosSimulatorDeviceGeometry,
  getIosSimulatorExteriorGeometry,
  getIosSimulatorHardware,
} from '../src/lib/ios-simulator/ios-simulator-hardware';

const iphone = (deviceType: string, name = '') =>
  getIosSimulatorHardware('iphone', `com.apple.CoreSimulator.SimDeviceType.${deviceType}`, name);

describe('iOS Simulator hardware', () => {
  it('gives an Action button only to the models that have one', () => {
    expect(iphone('iPhone-15-Pro').actionButton).toBe(true);
    expect(iphone('iPhone-16').actionButton).toBe(true);
    expect(iphone('iPhone-16e').actionButton).toBe(true);
    expect(iphone('iPhone-15').actionButton).toBe(false);
    expect(iphone('iPhone-14-Pro').actionButton).toBe(false);
    expect(
      getIosSimulatorHardware('watch', 'Apple-Watch-Ultra-2-49mm', 'Apple Watch Ultra 2')
        .actionButton
    ).toBe(true);
    expect(getIosSimulatorHardware('watch', 'Apple-Watch-Series-10-46mm', '').actionButton).toBe(
      false
    );
  });

  it('puts a Home button below the glass on older iPhones and iPads', () => {
    const se = iphone('iPhone-SE-3rd-generation', 'iPhone SE (3rd generation)');
    expect(se.homeButton).toBe(true);
    expect(se.chin).toBeGreaterThan(0);
    expect(se.buttons.find((button) => button.id === 'home')?.press).toBe('home');
    expect(iphone('iPhone-8').homeButton).toBe(true);
    expect(iphone('iPhone-16-Pro').homeButton).toBe(false);
    expect(
      getIosSimulatorHardware('ipad', 'iPad-9th-generation', 'iPad (9th generation)').homeButton
    ).toBe(true);
    expect(
      getIosSimulatorHardware('ipad', 'iPad-Pro-11-inch-M4', 'iPad Pro 11-inch (M4)').homeButton
    ).toBe(false);
  });

  it('uses the actual model rather than a user-editable device name', () => {
    expect(getIosSimulatorHardware('iphone', 'iPhone 16', 'iPhone SE')).toMatchObject({
      homeButton: false,
      actionButton: true,
    });
    expect(getIosSimulatorHardware('iphone', 'iPhone 15', 'Project Pro').actionButton).toBe(false);
    expect(getIosSimulatorHardware('iphone', '', 'iPhone SE').homeButton).toBe(true);
    for (const type of [
      'iPad 9th generation',
      'iPad Pro 12 9 inch 2nd generation',
      'iPad Pro (10.5-inch)',
      'com.apple.CoreSimulator.SimDeviceType.iPad-Pro',
    ]) {
      expect(getIosSimulatorHardware('ipad', type, 'QA').homeButton).toBe(true);
    }
    expect(
      getIosSimulatorHardware('ipad', 'iPad Pro (12.9-inch) (6th generation)', 'QA').homeButton
    ).toBe(false);
    expect(
      getIosSimulatorHardware(
        'ipad',
        'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-12-9-inch-2nd-generation',
        'QA'
      )
    ).toEqual(getIosSimulatorHardware('ipad', 'iPad Pro 12 9 inch 2nd generation', 'Renamed'));
  });

  it('draws no island, notch or home indicator: only rim and buttons outside the screen', () => {
    const pro = iphone('iPhone-16-Pro');
    expect(pro.forehead).toBe(0);
    expect(pro.chin).toBe(0);
    expect(pro.buttons.every((button) => button.edge !== 'face')).toBe(true);
  });

  it('disables what a device lacks and keeps the rest', () => {
    expect(getIosSimulatorControlAvailability(iphone('iPhone-15'))).toMatchObject({
      action: false,
      home: true,
      'rotate-left': true,
      'volume-up': true,
      text: true,
    });
    const watch = getIosSimulatorControlAvailability(
      getIosSimulatorHardware('watch', 'Apple-Watch-Series-10-46mm', '')
    );
    expect(watch).toMatchObject({
      'rotate-left': false,
      shake: false,
      'volume-up': false,
      home: true,
    });
  });
});

describe('iOS Simulator orientation', () => {
  it('keeps the screen at the stream’s aspect and moves the chin with the turn', () => {
    const se = iphone('iPhone-SE-3rd-generation', 'iPhone SE');
    const portrait = getIosSimulatorDeviceGeometry(se, 750 / 1334, 0);
    const screenWidth = portrait.width - portrait.screen.left - portrait.screen.right;
    const screenHeight = portrait.height - portrait.screen.top - portrait.screen.bottom;
    expect(screenWidth / screenHeight).toBeCloseTo(750 / 1334);
    expect(portrait.screen.bottom).toBeCloseTo(se.rim + se.chin);

    // Turned left, the Home button's chin is on the right.
    const left = getIosSimulatorDeviceGeometry(se, 1334 / 750, 3);
    const leftWidth = left.width - left.screen.left - left.screen.right;
    const leftHeight = left.height - left.screen.top - left.screen.bottom;
    expect(leftWidth / leftHeight).toBeCloseTo(1334 / 750);
    expect(left.screen.right).toBeCloseTo(se.rim + se.chin);
    const right = getIosSimulatorDeviceGeometry(se, 1334 / 750, 1);
    expect(right.screen.left).toBeCloseTo(se.rim + se.chin);
  });

  it('lays the bare screen out edge to edge', () => {
    const geometry = getIosSimulatorDeviceGeometry(iphone('iPhone-16-Pro'), 0.46, 0, false);
    expect(geometry.screen).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
  });
});

describe('iOS Simulator input limits', () => {
  it('checks text before it is sent', () => {
    expect(validateIosSimulatorText('')).toBe('empty');
    expect(validateIosSimulatorText('hello')).toBeNull();
    expect(validateIosSimulatorText('x'.repeat(4097))).toBe('too-long');
  });

  it('opens web addresses and app deep links, never executable or local schemes', () => {
    expect(validateIosSimulatorUrl('https://example.com/a?b=c')).toBeNull();
    expect(validateIosSimulatorUrl('  myapp://settings/profile ')).toBeNull();
    expect(validateIosSimulatorUrl('javascript:alert(1)')).toBe('scheme');
    expect(validateIosSimulatorUrl('data:text/html,hi')).toBe('scheme');
    expect(validateIosSimulatorUrl('file:///etc/hosts')).toBe('scheme');
    expect(validateIosSimulatorUrl('example.com')).toBe('invalid');
    expect(validateIosSimulatorUrl('')).toBe('empty');
    expect(validateIosSimulatorUrl(`https://x.test/${'a'.repeat(2048)}`)).toBe('too-long');
  });

  it('names a screenshot after the device and the moment, without path characters', () => {
    expect(
      getIosSimulatorScreenshotFileName('iPhone 16 Pro', new Date(2026, 8, 30, 14, 5, 9))
    ).toBe('iPhone 16 Pro 2026-09-30 14.05.09.png');
    expect(getIosSimulatorScreenshotFileName('a/b:c', new Date(2026, 0, 1, 0, 0, 0))).toBe(
      'a b c 2026-01-01 00.00.00.png'
    );
  });
});

describe('iOS Simulator capture replies', () => {
  const png = () => {
    const bytes = new Uint8Array(16);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return bytes.buffer;
  };
  const reply = (fields: Record<string, unknown>) => ({
    type: 'lody:ios-simulator:capture-result',
    operationId: 'op',
    requestId: 'req',
    ...fields,
  });

  it('accepts only the PNG answer to the exact request', () => {
    const data = png();
    expect(
      parseIosSimulatorCaptureResult(reply({ mimeType: 'image/png', data }), 'op', 'req')
    ).toEqual({
      ok: true,
      bytes: data,
    });
    expect(parseIosSimulatorCaptureResult(reply({ data }), 'op', 'other-req')).toBeNull();
    expect(parseIosSimulatorCaptureResult(reply({ data }), 'other-op', 'req')).toBeNull();
    expect(
      parseIosSimulatorCaptureResult({ ...reply({ data }), type: 'x' }, 'op', 'req')
    ).toBeNull();
  });

  it('treats malformed, oversized or non-PNG success as a failure', () => {
    expect(
      parseIosSimulatorCaptureResult(reply({ mimeType: 'image/jpeg', data: png() }), 'op', 'req')
    ).toEqual({ ok: false, error: 'failed' });
    expect(
      parseIosSimulatorCaptureResult(
        reply({ mimeType: 'image/png', data: new ArrayBuffer(16) }),
        'op',
        'req'
      )
    ).toEqual({ ok: false, error: 'failed' });
    expect(
      parseIosSimulatorCaptureResult(
        reply({
          mimeType: 'image/png',
          data: new ArrayBuffer(IOS_SIMULATOR_CAPTURE_MAX_BYTES + 1),
        }),
        'op',
        'req'
      )
    ).toEqual({ ok: false, error: 'too-large' });
    expect(parseIosSimulatorCaptureResult(reply({ error: 'unavailable' }), 'op', 'req')).toEqual({
      ok: false,
      error: 'unavailable',
    });
    expect(parseIosSimulatorCaptureResult(reply({ error: 'weird' }), 'op', 'req')).toEqual({
      ok: false,
      error: 'failed',
    });
  });
});

it('preserves exact DeviceKit screen insets through every rotation', () => {
  const exterior = {
    width: 450,
    height: 900,
    screen: { x: 30, y: 20, width: 390, height: 850, radius: 50 },
    buttons: [],
  };
  expect(getIosSimulatorExteriorGeometry(exterior, 0)).toMatchObject({
    width: 450,
    height: 900,
    screen: { top: 20, right: 30, bottom: 30, left: 30 },
  });
  expect(getIosSimulatorExteriorGeometry(exterior, 1)).toMatchObject({
    width: 900,
    height: 450,
    screen: { top: 30, right: 20, bottom: 30, left: 30 },
  });
  expect(getIosSimulatorExteriorGeometry(exterior, 2).screen).toEqual({
    top: 30,
    right: 30,
    bottom: 20,
    left: 30,
  });
  expect(getIosSimulatorExteriorGeometry(exterior, 3).screen).toEqual({
    top: 30,
    right: 30,
    bottom: 30,
    left: 20,
  });
});
