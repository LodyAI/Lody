import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  buildStatusViewLayout,
  planStatusViewCommand,
  type StatusViewCommand,
  type StatusViewLayout,
  type StatusViewLayoutInput,
  type StatusViewState,
  type StatusViewWrite,
} from '../src/status-view';
import { COMMAND_CASES, LAYOUT_CASES, NOW, RANDOM_BYTES } from './status-view-vector-cases';

const LAYOUT_VECTORS = '../src/status-view/vectors/layout.json';
const COMMAND_VECTORS = '../src/status-view/vectors/commands.json';

/** The byte source every consumer builds from `env.randomBytes`. */
const cycling = (bytes: readonly number[]) => {
  let next = 0;
  return () => bytes[next++ % bytes.length]!;
};

const serialize = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const layoutVectors = () => ({
  version: 1,
  description:
    'buildStatusViewLayout golden vectors: for each case, buildStatusViewLayout(input) must deep-equal expected.',
  cases: LAYOUT_CASES.map((entry) => ({
    ...entry,
    expected: buildStatusViewLayout(entry.input),
  })),
});

const commandVectors = () => {
  const env = { nowMs: NOW, randomBytes: RANDOM_BYTES };
  return {
    version: 1,
    description:
      'planStatusViewCommand golden vectors: randomByte returns env.randomBytes in order, repeating, starting fresh for each case.',
    cases: COMMAND_CASES.map((entry) => ({
      ...entry,
      env,
      expected: planStatusViewCommand(entry.state, entry.command, {
        nowMs: env.nowMs,
        randomByte: cycling(env.randomBytes),
      }),
    })),
  };
};

describe('status view golden vectors', () => {
  it('match the committed layout vectors', async () => {
    await expect(serialize(layoutVectors())).toMatchFileSnapshot(LAYOUT_VECTORS);
  });

  it('match the committed command vectors', async () => {
    await expect(serialize(commandVectors())).toMatchFileSnapshot(COMMAND_VECTORS);
  });

  // What every other consumer runs: only the JSON file, no case definitions.
  it('reproduce from the JSON alone', () => {
    const read = <T>(path: string): T =>
      JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as T;
    const layouts = read<{
      cases: { input: StatusViewLayoutInput; expected: StatusViewLayout }[];
    }>(LAYOUT_VECTORS);
    for (const entry of layouts.cases) {
      expect(buildStatusViewLayout(entry.input)).toEqual(entry.expected);
    }
    const commands = read<{
      cases: {
        state: StatusViewState;
        command: StatusViewCommand;
        env: { nowMs: number; randomBytes: number[] };
        expected: StatusViewWrite[];
      }[];
    }>(COMMAND_VECTORS);
    for (const entry of commands.cases) {
      expect(
        planStatusViewCommand(entry.state, entry.command, {
          nowMs: entry.env.nowMs,
          randomByte: cycling(entry.env.randomBytes),
        })
      ).toEqual(entry.expected);
    }
    expect(layouts.cases.length).toBe(LAYOUT_CASES.length);
    expect(commands.cases.length).toBe(COMMAND_CASES.length);
  });
});
