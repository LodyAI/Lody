import { useEffect, useState } from 'react';
import type { SessionHistory, SessionId } from '@lody/shared';
import { useSessionDoc } from '@/hooks/use-session-doc';

export type ScheduleChatRun = {
  /** The user turn the run wrote into the chat. */
  turnId: string;
  timestamp: string;
  state: 'done' | 'running' | 'idle';
};

const runOf = (turn: SessionHistory): string | undefined => {
  const marker = (turn as { scheduleRun?: { scheduleId?: unknown } }).scheduleRun;
  return typeof marker?.scheduleId === 'string' ? marker.scheduleId : undefined;
};

/**
 * Runs of a schedule that posts into one chat, read from that chat.
 *
 * The daemon already stamps every run's user turn with `scheduleRun`, so the
 * chat is the record: nothing new is stored or synced. The chat is opened only
 * while the run history is on screen and read once in full (the authoritative
 * `readAll`), then again whenever its turn list changes.
 */
export function pickScheduleChatRuns(
  history: readonly SessionHistory[],
  scheduleId: string
): ScheduleChatRun[] {
  const replies = new Map<string, SessionHistory>();
  for (const turn of history)
    if (turn.role !== 'user' && turn.userTurnId) replies.set(turn.userTurnId, turn);
  return history
    .filter((turn) => turn.role === 'user' && runOf(turn) === scheduleId)
    .map((turn) => {
      const reply = replies.get(turn.id);
      return {
        turnId: turn.id,
        timestamp: turn.timestamp,
        state: !reply ? 'idle' : reply.endedAt != null ? 'done' : 'running',
      } satisfies ScheduleChatRun;
    })
    .reverse();
}

export function useScheduleChatRuns(
  sessionId: string | undefined,
  scheduleId: string,
  enabled: boolean
): { runs: ScheduleChatRun[]; loading: boolean } {
  const active = enabled && !!sessionId;
  const { history } = useSessionDoc((sessionId ?? '') as SessionId, { enabled: active });
  const [state, setState] = useState<{ runs: ScheduleChatRun[]; loading: boolean }>({
    runs: [],
    loading: active,
  });
  useEffect(() => {
    if (!active || !history) {
      setState({ runs: [], loading: active });
      return undefined;
    }
    let current = true;
    const read = () => {
      void history
        .readAll()
        .then((turns) => {
          if (current) setState({ runs: pickScheduleChatRuns(turns, scheduleId), loading: false });
        })
        .catch(() => {
          if (current) setState((previous) => ({ ...previous, loading: false }));
        });
    };
    read();
    const unsubscribe = history.subscribe((change) => {
      if (change.kind === 'structure') read();
    });
    return () => {
      current = false;
      unsubscribe();
    };
  }, [active, history, scheduleId]);
  return state;
}
