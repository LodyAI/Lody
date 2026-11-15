import { buildReplayPromptFromHistory, type SessionHistoryInput } from '@lody/shared';
import { expect } from 'vitest';
import { toSessionTranscriptEntries } from '../src/commands/session';
import { nativeFixture } from './roost-session-backend-test-helpers';

async function assertOwnerInspection(fixture: Awaited<ReturnType<typeof nativeFixture>>) {
  const full = await fixture.backend.readHistory();
  for (const reverse of [false, true]) {
    const response = await fixture.backend.readHistoryInspection!({
      kind: 'readTranscript',
      limit: 3,
      reverse,
    });
    expect(response.success).toBe(true);
    const result = response.result as {
      total: number;
      positions: number[];
      entries: SessionHistoryInput[];
    };
    const visible = full.flatMap((entry, position) =>
      toSessionTranscriptEntries([entry]).length ? [position] : []
    );
    const selected = visible.slice(-3);
    if (reverse) selected.reverse();
    expect(result.total).toBe(visible.length);
    expect(result.positions).toEqual(selected);
    expect(result.entries).toEqual(selected.map((position) => full[position]));
  }
  const first = await fixture.backend.readHistoryInspection!({
    kind: 'readQuerySnapshot',
    transcriptVisibility: true,
  });
  const second = await fixture.backend.readHistoryInspection!({
    kind: 'readQuerySnapshot',
    transcriptVisibility: true,
  });
  expect(second.result).toEqual(first.result);
  expect(second.historyRevision).toBe(first.historyRevision);
  const replay = await fixture.backend.readHistoryInspection!({ kind: 'readReplayPrompt' });
  expect(replay.result).toEqual(buildReplayPromptFromHistory({ history: full }));
}
export { assertOwnerInspection };
