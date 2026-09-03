/**
 * Deterministic synthetic replay generator.
 *
 * Real transcripts must never be committed, so the committed baseline runs on a
 * generated conversation with the same shape as a long agent session: alternating
 * user turns, streamed assistant text/thought chunks, and tool calls that receive
 * a later `tool_call_update` (the update pattern the import applier has to resolve
 * against already-materialized history).
 */

import { parseSessionNotification, type AcpSessionNotification } from '@lody/shared';

export type SyntheticReplayOptions = {
  /** Number of user turns. */
  turns: number;
  /** Tool calls emitted per assistant turn. */
  toolCallsPerTurn: number;
  /** Assistant text chunks per turn. */
  textChunksPerTurn: number;
  /** Approximate characters per streamed chunk. */
  chunkChars: number;
};

export const DEFAULT_SYNTHETIC_REPLAY: SyntheticReplayOptions = {
  turns: 120,
  toolCallsPerTurn: 6,
  textChunksPerTurn: 24,
  chunkChars: 160,
};

/** xorshift32 so a given option set always produces byte-identical fixtures. */
function createRandom(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

const WORDS = [
  'session',
  'history',
  'import',
  'snapshot',
  'mirror',
  'notification',
  'assistant',
  'terminal',
  'diff',
  'render',
  'schema',
  'container',
];

function makeText(random: () => number, chars: number): string {
  let text = '';
  while (text.length < chars) {
    text += `${WORDS[Math.floor(random() * WORDS.length)]} `;
  }
  return text.slice(0, chars);
}

export function buildSyntheticReplay(
  options: SyntheticReplayOptions = DEFAULT_SYNTHETIC_REPLAY
): AcpSessionNotification[] {
  const random = createRandom(0x5eed_1234);
  const raw: unknown[] = [];
  const sessionId = 'synthetic-acp-session';

  for (let turn = 0; turn < options.turns; turn += 1) {
    raw.push({
      sessionId,
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: `Turn ${turn}: ${makeText(random, 120)}` },
      },
    });

    raw.push({
      sessionId,
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: makeText(random, options.chunkChars * 2) },
      },
    });

    for (let call = 0; call < options.toolCallsPerTurn; call += 1) {
      const toolCallId = `tool-${turn}-${call}`;
      raw.push({
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId,
          title: `Read src/module-${turn}-${call}.ts`,
          kind: call % 2 === 0 ? 'read' : 'execute',
          status: 'pending',
          rawInput: { path: `src/module-${turn}-${call}.ts` },
        },
      });
      raw.push({
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'completed',
          content: [
            {
              type: 'content',
              content: { type: 'text', text: makeText(random, options.chunkChars * 4) },
            },
          ],
        },
      });
    }

    for (let chunk = 0; chunk < options.textChunksPerTurn; chunk += 1) {
      raw.push({
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: makeText(random, options.chunkChars) },
        },
      });
    }
  }

  return raw.map((value) => parseSessionNotification(value));
}
