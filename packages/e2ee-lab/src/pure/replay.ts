/** Recorded inert fixture bytes only; no entropy source or resealing capability. */
export interface EntropyFill {
  readonly label: string;
  readonly bytes: Uint8Array;
}
import { normalizeFrameHex } from './multipart';
import type { ProtocolFrame } from '../platform/runtime';
import type { LabEvent } from './scheduler';

export interface Divergence {
  readonly index: number;
  readonly field: string;
  readonly expected: string;
  readonly actual: string;
}

export interface ReplayMaterial {
  readonly events: readonly LabEvent[];
  readonly frames: readonly ProtocolFrame[];
  readonly entropy: readonly EntropyFill[];
}

export function firstDivergence(
  expected: readonly LabEvent[],
  actual: readonly LabEvent[]
): Divergence | null {
  const length = Math.max(expected.length, actual.length);
  for (let index = 0; index < length; index++) {
    const left = expected[index];
    const right = actual[index];
    if (!left || !right) {
      return {
        index,
        field: 'event',
        expected: left ? left.eventId : 'missing',
        actual: right ? right.eventId : 'missing',
      };
    }
    for (const field of [
      'eventId',
      'step',
      'actor',
      'operation',
      'phase',
      'status',
      'parent',
      'time',
    ] as const) {
      const expectedValue = left[field];
      const actualValue = right[field];
      if (expectedValue !== actualValue) {
        return {
          index,
          field,
          expected: expectedValue === undefined ? 'undefined' : JSON.stringify(expectedValue),
          actual: actualValue === undefined ? 'undefined' : JSON.stringify(actualValue),
        };
      }
    }
  }
  return null;
}

export function firstReplayDivergence(
  expected: ReplayMaterial,
  actual: ReplayMaterial
): Divergence | null {
  const events = firstDivergence(expected.events, actual.events);
  if (events) return events;
  const entropyCount = Math.max(expected.entropy.length, actual.entropy.length);
  for (let index = 0; index < entropyCount; index++) {
    const left = expected.entropy[index];
    const right = actual.entropy[index];
    if (!left || !right) {
      return {
        index,
        field: 'entropy',
        expected: left?.label ?? 'missing',
        actual: right?.label ?? 'missing',
      };
    }
    if (left.label !== right.label) {
      return { index, field: 'entropy.label', expected: left.label, actual: right.label };
    }
    if (left.bytes.byteLength !== right.bytes.byteLength) {
      return {
        index,
        field: 'entropy.length',
        expected: String(left.bytes.byteLength),
        actual: String(right.bytes.byteLength),
      };
    }
    if (!bytesEqual(left.bytes, right.bytes)) {
      return { index, field: 'entropy.bytes', expected: left.label, actual: right.label };
    }
  }
  const frameCount = Math.max(expected.frames.length, actual.frames.length);
  for (let index = 0; index < frameCount; index++) {
    const left = expected.frames[index];
    const right = actual.frames[index];
    if (!left || !right) {
      return {
        index,
        field: 'frame',
        expected: left?.eventId ?? 'missing',
        actual: right?.eventId ?? 'missing',
      };
    }
    for (const field of ['eventId', 'actor', 'operation', 'phase', 'url'] as const) {
      if (left[field] !== right[field])
        return { index, field: `frame.${field}`, expected: left[field], actual: right[field] };
    }
    if (normalizeFrameHex(left.requestHex) !== normalizeFrameHex(right.requestHex)) {
      return { index, field: 'frame.request', expected: left.requestHex, actual: right.requestHex };
    }
    if (normalizeFrameHex(left.responseHex) !== normalizeFrameHex(right.responseHex)) {
      return {
        index,
        field: 'frame.response',
        expected: left.responseHex,
        actual: right.responseHex,
      };
    }
    if (left.responseStatus !== right.responseStatus) {
      return {
        index,
        field: 'frame.status',
        expected: String(left.responseStatus),
        actual: String(right.responseStatus),
      };
    }
  }
  return null;
}

export { normalizeFrameHex } from './multipart';

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let i = 0; i < left.byteLength; i++) if (left[i] !== right[i]) return false;
  return true;
}
