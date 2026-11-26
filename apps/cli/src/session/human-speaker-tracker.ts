type SpeakerRecord = {
  turnId: string;
  speakerId: string;
  previousSpeakerId: string | undefined;
};

const DEFAULT_MAX_SESSIONS = 1024;

/**
 * Remembers the last human sender of each Session in this process. Rebuilding
 * the same turn's prompt (a retry or a replay fallback) returns the decision
 * that turn first received. After a restart nothing is remembered, so a turn is
 * labelled unless its sender is the machine owner. The oldest Session is
 * forgotten past `maxSessions`.
 */
export class HumanSpeakerTracker {
  private readonly records = new Map<string, SpeakerRecord>();

  constructor(private readonly maxSessions = DEFAULT_MAX_SESSIONS) {}

  changed(sessionId: string, turnId: string, speakerId: string, machineOwnerId: string): boolean {
    const existing = this.records.get(sessionId);
    const record =
      existing?.turnId === turnId
        ? existing
        : { turnId, speakerId, previousSpeakerId: existing?.speakerId };
    this.records.delete(sessionId);
    this.records.set(sessionId, record);
    if (this.records.size > this.maxSessions) {
      const oldest = this.records.keys().next().value;
      if (oldest !== undefined) this.records.delete(oldest);
    }
    return record.previousSpeakerId === undefined
      ? record.speakerId !== machineOwnerId
      : record.previousSpeakerId !== record.speakerId;
  }
}
