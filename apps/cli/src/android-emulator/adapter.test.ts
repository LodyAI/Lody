import { expect, it } from 'vitest';
import { annexBToAvcc, avcConfiguration } from './h264';
import { parseAvdNames, matchAvdSerial } from './devices';

it('converts mixed Annex-B start codes without changing NAL payloads', () => {
  expect(annexBToAvcc(Buffer.from([0, 0, 0, 1, 0x65, 8, 0, 0, 1, 0x61, 9]))).toEqual(
    Buffer.from([0, 0, 0, 2, 0x65, 8, 0, 0, 0, 2, 0x61, 9])
  );
  expect(() => annexBToAvcc(Buffer.from([1, 2, 3]))).toThrow();
});
it('creates an avcC decoder configuration from bounded SPS and PPS', () => {
  expect(avcConfiguration(Buffer.from([0, 0, 1, 0x67, 66, 0, 30, 9, 0, 0, 1, 0x68, 8]))).toEqual(
    Buffer.from([1, 66, 0, 30, 255, 225, 0, 5, 0x67, 66, 0, 30, 9, 1, 0, 2, 0x68, 8])
  );
});
it('binds an AVD only to its exact name and rejects ambiguous running instances', () => {
  expect(parseAvdNames('Pixel_A\nPixel_a\n')).toEqual(['Pixel_A', 'Pixel_a']);
  expect(
    matchAvdSerial('Pixel_A', [
      { name: 'Pixel_a', serial: 'emulator-5554' },
      { name: 'Pixel_A', serial: 'emulator-5556' },
    ])
  ).toBe('emulator-5556');
  expect(() =>
    matchAvdSerial('Pixel_A', [
      { name: 'Pixel_A', serial: 'emulator-5554' },
      { name: 'Pixel_A', serial: 'emulator-5556' },
    ])
  ).toThrow();
});
