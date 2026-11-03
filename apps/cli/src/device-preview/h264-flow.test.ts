import { expect, it } from 'vitest';
import { DeviceH264Flow } from './h264-flow';

it('resets the dependent chain on a new encoder configuration and only resumes at an IDR', () => {
  const flow = new DeviceH264Flow(false, 0, () => {});
  const config = Buffer.from([1, 66, 0, 30]);
  flow.offer({ type: 'configuration', data: config }, 0);
  flow.offer({ type: 'frame', key: false, data: Buffer.from([1]) }, 1);
  expect(flow.take(1)).toBeUndefined();
  flow.offer({ type: 'frame', key: true, data: Buffer.from([2]) }, 2);
  const first = flow.take(2);
  expect(first?.subarray(11)).toEqual(Buffer.concat([config, Buffer.from([2])]));
  flow.offer({ type: 'configuration', data: Buffer.from([1, 77, 0, 31]) }, 3);
  flow.offer({ type: 'frame', key: false, data: Buffer.from([3]) }, 4);
  expect(flow.take(4)).toBeUndefined();
  flow.offer({ type: 'frame', key: true, data: Buffer.from([4]) }, 5);
  expect(flow.take(5)?.subarray(11)).toEqual(Buffer.from([1, 77, 0, 31, 4]));
});
