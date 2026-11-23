import { describe, expect, it } from 'vitest';
import {
  IOS_SIMULATOR_CAPTURE_MAX_BYTES,
  parseIosSimulatorCaptureResult,
  validateIosSimulatorUrl,
} from '../src/lib/ios-simulator/ios-simulator-controls';
import {
  getIosSimulatorControlAvailability,
  getIosSimulatorDeviceGeometry,
  getIosSimulatorHardware,
} from '../src/lib/ios-simulator/ios-simulator-hardware';

const iphone = (deviceType: string, name = '') =>
  getIosSimulatorHardware('iphone', `com.apple.CoreSimulator.SimDeviceType.${deviceType}`, name);

describe('iOS Simulator hardware', () => {
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
});

describe('iOS Simulator input limits', () => {
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
